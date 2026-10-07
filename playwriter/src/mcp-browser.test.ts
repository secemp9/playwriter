/**
 * The MCP `browser` tool: which browser an MCP session drives.
 *
 * An in-process relay on a free port, two fake extensions (two Chrome profiles with different
 * emails) speaking the relay's real extension protocol, and the real MCP server over stdio. The
 * `new` case launches a real headless Chrome from Playwright's own Chromium build, so the binary is
 * the same on every machine that ran `playwright install`.
 */

import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import { connectFakeExtension, freePort, type FakeExtension } from './fake-extension.js'
import { createMCPClient } from './mcp-client.js'
import { TEST_WORKSPACE } from './test-utils.js'
import { VERSION } from './utils.js'

const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
const CHROMIUM_PATH = chromium.executablePath()

const ALPHA = { name: 'alpha', email: 'alice@example.com', key: 'install:Chrome:alpha-install', url: 'https://alpha.example/' }
const BETA = { name: 'beta', email: 'bob@example.com', key: 'install:Chrome:beta-install', url: 'https://beta.example/' }

let port = 0
let relay: RelayServer
let alpha: FakeExtension
let beta: FakeExtension
const running = new Set<() => Promise<void>>()

async function connectProfile(profile: typeof ALPHA, id: string): Promise<FakeExtension> {
  return connectFakeExtension({
    port,
    name: profile.name,
    workspace: TEST_WORKSPACE.key,
    url: profile.url,
    query: {
      browser: 'Chrome',
      installId: `${profile.name}-install`,
      email: profile.email,
      id,
      v: VERSION,
      userAgent: LINUX_UA,
      browserVersion: '139.0.7258.5',
    },
  })
}

/**
 * A fresh MCP server bound to the test relay. Unset variables are passed empty so the developer's
 * own environment cannot choose for the test. `stop` closes it, so a session bound to one fake
 * cannot send it anything while a later test watches that fake.
 */
async function startMcp(env: Record<string, string> = {}): Promise<{ client: Client; stop: () => Promise<void>; pid: number }> {
  const { client, cleanup, pid } = await createMCPClient({
    port,
    env: { PLAYWRITER_BROWSER: '', PLAYWRITER_DIRECT: '', PLAYWRITER_HOST: '', ...env },
  })
  running.add(cleanup)
  const stop = async () => {
    running.delete(cleanup)
    await cleanup()
  }
  return { client, stop, pid }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }))
  const text = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
  return { text, isError: result.isError === true }
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

/**
 * The headless Chrome processes the MCP server `serverPid` launched: its descendants started from
 * CHROMIUM_PATH with Playwright's pipe. Ancestry, not "new since a snapshot": other test files launch
 * the same Chromium at the same time.
 */
function sessionChromePids(serverPid: number): number[] {
  const rows = processTable()
  const descendants = new Set([serverPid])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid)
        grew = true
      }
    }
  }
  return rows
    .filter((row) => row.pid !== serverPid && descendants.has(row.pid) && row.command.startsWith(CHROMIUM_PATH) && row.command.includes('--remote-debugging-pipe'))
    .map((row) => row.pid)
}

/** Which of `pids` still run that Chromium (a zombie's command is no longer the binary path). */
function stillRunningChrome(pids: number[]): number[] {
  return processTable()
    .filter((row) => pids.includes(row.pid) && row.command.startsWith(CHROMIUM_PATH))
    .map((row) => row.pid)
}

beforeAll(async () => {
  port = await freePort()
  relay = await startPlayWriterCDPRelayServer({ port, host: '127.0.0.1', logger: { log: () => {}, error: () => {} } })
  alpha = await connectProfile(ALPHA, '1001')
  beta = await connectProfile(BETA, '1002')
}, 60_000)

afterAll(async () => {
  const failures: unknown[] = []
  for (const cleanup of running) await cleanup().catch((error: unknown) => failures.push(error))
  alpha?.ws.close()
  beta?.ws.close()
  await relay?.close()
  if (failures.length > 0) throw new AggregateError(failures, 'an MCP client did not close cleanly')
})

describe('choosing a connected browser', () => {
  let client: Client
  let stop: () => Promise<void>

  beforeAll(async () => {
    ;({ client, stop } = await startMcp())
  }, 120_000)

  afterAll(async () => {
    await stop()
  })

  it('lists both connected profiles and a new browser, with the calls that choose them', async () => {
    const { text, isError } = await call(client, 'browser', { action: 'list' })
    expect(isError).toBe(false)
    for (const profile of [ALPHA, BETA]) {
      expect(text).toContain(profile.email)
      expect(text).toContain(profile.key)
      expect(text).toContain(`browser({ action: "use", browser: "${profile.email}" })`)
    }
    expect(text).toContain(`built with playwriter ${VERSION}`)
    expect(text).toContain('a fresh headless Chrome for this session: no logins, no extensions, nothing shared with the browsers above')
    expect(text).toContain('browser({ action: "new" })')
    expect(text).toContain('none chosen yet')
  }, 60_000)

  it('refuses to execute before a choice when two browsers are connected, naming both and the call', async () => {
    const { text, isError } = await call(client, 'execute', { code: 'return page.url()' })
    expect(isError).toBe(true)
    expect(text).toContain(ALPHA.email)
    expect(text).toContain(BETA.email)
    expect(text).toContain(`browser({ action: "use", browser: "${ALPHA.email}" })`)
    expect(alpha.forwarded).toEqual([])
    expect(beta.forwarded).toEqual([])
  }, 60_000)

  it('refuses an unknown choice, naming the valid ones', async () => {
    const { text, isError } = await call(client, 'browser', { action: 'use', browser: 'carol@example.com' })
    expect(isError).toBe(true)
    expect(text).toContain('carol@example.com')
    for (const profile of [ALPHA, BETA]) {
      expect(text).toContain(profile.email)
      expect(text).toContain(profile.key)
    }
    expect(text).toContain('browser({ action: "new" })')
  }, 60_000)

  it('use <email> drives that profile only', async () => {
    const betaBefore = beta.forwarded.length
    const chosen = await call(client, 'browser', { action: 'use', browser: ALPHA.email.toUpperCase() })
    expect(chosen.isError, chosen.text).toBe(false)
    expect(chosen.text).toContain(ALPHA.email)
    expect(chosen.text).toContain(ALPHA.key)
    expect(chosen.text).toContain(ALPHA.url)
    expect(chosen.text).toContain('reset')

    const executed = await call(client, 'execute', { code: 'return page.url()' })
    expect(executed.isError, executed.text).toBe(false)
    expect(executed.text).toContain(ALPHA.url)
    expect(executed.text).not.toContain(BETA.url)
    expect(alpha.forwarded.length).toBeGreaterThan(0)
    expect(beta.forwarded.slice(betaBefore).map((command) => command.method)).toEqual([])

    const listed = await call(client, 'browser', { action: 'list' })
    expect(listed.text).toContain(`This session drives: ${ALPHA.email}`)
  }, 60_000)
})

describe('PLAYWRITER_BROWSER', () => {
  it('binds the configured profile without a browser call', async () => {
    const alphaBefore = alpha.forwarded.length
    const betaBefore = beta.forwarded.length
    const { client, stop } = await startMcp({ PLAYWRITER_BROWSER: BETA.email })
    try {
      const executed = await call(client, 'execute', { code: 'return page.url()' })
      expect(executed.isError, executed.text).toBe(false)
      expect(executed.text).toContain(BETA.url)
      expect(beta.forwarded.length).toBeGreaterThan(betaBefore)
      expect(alpha.forwarded.slice(alphaBefore).map((command) => command.method)).toEqual([])
    } finally {
      await stop()
    }
  }, 120_000)
})

describe('a new browser', () => {
  it('launches a headless Chrome for the session, and switching to a profile releases it', async () => {
    const { client, stop, pid } = await startMcp({ PLAYWRITER_BROWSER_PATH: CHROMIUM_PATH })
    try {
      expect(sessionChromePids(pid)).toEqual([])

      const launched = await call(client, 'browser', { action: 'new' })
      expect(launched.isError, launched.text).toBe(false)
      expect(launched.text).toContain(CHROMIUM_PATH)
      expect(launched.text).toContain('reset')
      const ours = sessionChromePids(pid)
      expect(ours.length).toBeGreaterThan(0)

      // base64, so the title can only reach the report from the loaded page, not from the URL.
      const html = Buffer.from('<title>Fresh headless page</title><h1>Hello from a new browser</h1>').toString('base64')
      const opened = await call(client, 'execute', { code: `await act.open('data:text/html;base64,${html}')` })
      expect(opened.isError, opened.text).toBe(false)
      expect(opened.text).toContain('Fresh headless page')

      const switched = await call(client, 'browser', { action: 'use', browser: ALPHA.key })
      expect(switched.isError, switched.text).toBe(false)
      expect(switched.text).toContain(ALPHA.email)
      expect(switched.text).toContain('Released the headless Chrome')
      // Real timers: these are operating-system processes finishing their exit, polled for at most 5 s.
      const deadline = Date.now() + 5000
      let left = stillRunningChrome(ours)
      while (left.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        left = stillRunningChrome(ours)
      }
      expect(left).toEqual([])
    } finally {
      await stop()
    }
  }, 120_000)
})
