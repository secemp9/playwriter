/**
 * The MCP server's end of life: when the client closes its stdin (how an MCP stdio client ends a
 * session), the server releases the headless Chrome it launched and exits on its own — no SIGTERM.
 *
 * The real MCP server process, spawned the way `mcp-client.ts` spawns it (`pnpm vite-node cli.ts`),
 * against an in-process relay on a free port; the session's Chrome is Playwright's own Chromium,
 * launched through the MCP `browser` tool. Chrome processes are identified by ancestry (descendants
 * of the server process started from that binary), so other test files' Chromes are never counted.
 */

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import url from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import { freePort } from './fake-extension.js'

const SRC_DIR = path.dirname(url.fileURLToPath(import.meta.url))
const CHROMIUM_PATH = chromium.executablePath()

let port = 0
let relay: RelayServer
const spawned: ChildProcessWithoutNullStreams[] = []

beforeAll(async () => {
  port = await freePort()
  relay = await startPlayWriterCDPRelayServer({ port, host: '127.0.0.1', logger: { log: () => {}, error: () => {} } })
}, 60_000)

afterAll(async () => {
  // The server runs in its own process group (detached): pnpm and the node server under it go together,
  // also when the test failed because the server did not exit.
  for (const child of spawned) {
    if (child.pid === undefined) continue
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
  }
  await relay?.close()
})

/** The MCP client side of a stdio transport over a child process we own, so the test decides when stdin ends. */
class ChildStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly buffer = new ReadBuffer()

  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  async start(): Promise<void> {
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk)
      for (let message = this.buffer.readMessage(); message !== null; message = this.buffer.readMessage()) this.onmessage?.(message)
    })
    this.child.on('exit', () => this.onclose?.())
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.child.stdin.write(serializeMessage(message))
  }

  async close(): Promise<void> {
    this.child.stdin.end()
  }
}

interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

function processTable(): ProcessRow[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
    })
}

/** The Chrome processes descending from `rootPid` that run CHROMIUM_PATH. */
function chromeDescendants(rootPid: number): number[] {
  const rows = processTable()
  const descendants = new Set([rootPid])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid)
        grew = true
      }
    }
  }
  return rows.filter((row) => row.pid !== rootPid && descendants.has(row.pid) && row.command.startsWith(CHROMIUM_PATH)).map((row) => row.pid)
}

/** Which of `pids` still run that Chromium (a zombie's command is no longer the binary path). */
function stillRunningChrome(pids: number[]): number[] {
  return processTable()
    .filter((row) => pids.includes(row.pid) && row.command.startsWith(CHROMIUM_PATH))
    .map((row) => row.pid)
}

it('exits on stdin EOF, closing the headless Chrome it launched', async () => {
  const child = spawn('pnpm', ['vite-node', path.join(SRC_DIR, 'cli.ts')], {
    cwd: path.join(SRC_DIR, '..'),
    env: {
      ...process.env,
      PLAYWRITER_PORT: String(port),
      PLAYWRITER_BROWSER: '',
      PLAYWRITER_DIRECT: '',
      PLAYWRITER_HOST: '',
      PLAYWRITER_BROWSER_PATH: CHROMIUM_PATH,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  spawned.push(child)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = Promise.withResolvers<number>()
  child.once('exit', () => exited.resolve(Date.now()))

  const client = new Client({ name: 'stdin-eof-test', version: '1.0.0' })
  await client.connect(new ChildStdioTransport(child))
  const launched = CallToolResultSchema.parse(await client.callTool({ name: 'browser', arguments: { action: 'new' } }))
  expect(launched.isError, JSON.stringify(launched.content)).not.toBe(true)
  const opened = CallToolResultSchema.parse(
    await client.callTool({ name: 'execute', arguments: { code: "await act.open('data:text/html,<title>EOF test</title><h1>Hello</h1>')" } }),
  )
  expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true)
  const chromes = chromeDescendants(child.pid ?? -1)
  expect(chromes.length).toBeGreaterThan(0)

  const endedAt = Date.now()
  child.stdin.end()
  // Real time on purpose: an operating-system process deciding to exit; 15 s bounds the failure case.
  const gaveUp = Promise.withResolvers<null>()
  const timer = setTimeout(() => gaveUp.resolve(null), 15_000)
  const exitedAt = await Promise.race([exited.promise, gaveUp.promise])
  clearTimeout(timer)
  expect(exitedAt, `the MCP server was still running 15 s after its stdin ended. stderr:\n${stderr.slice(-2000)}`).not.toBeNull()
  expect((exitedAt ?? Infinity) - endedAt).toBeLessThan(8000)
  console.log(`the MCP server exited ${(exitedAt ?? Infinity) - endedAt} ms after its stdin ended`)
  expect(stderr).toContain('stdin ended: the MCP client is gone; releasing the browser and exiting')

  // Real time on purpose: Chrome's own processes finishing their exit, polled for at most 5 s.
  const deadline = Date.now() + 5000
  let left = stillRunningChrome(chromes)
  while (left.length > 0 && Date.now() < deadline) {
    const tick = Promise.withResolvers<void>()
    setTimeout(tick.resolve, 100)
    await tick.promise
    left = stillRunningChrome(chromes)
  }
  expect(left).toEqual([])
}, 120_000)
