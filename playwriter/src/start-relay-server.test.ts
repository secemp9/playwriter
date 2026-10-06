/**
 * start-relay-server.ts is the relay daemon relay-client spawns, the process every playwriter client
 * and the extension connect to. Run here as that child process (through tsx, as relay-client runs it
 * from source), each on a port of its own and with its logs in a temporary folder: the daemon's logger
 * truncates its file on start, so the default ~/.playwriter logs are never touched.
 *
 * PLAYWRITER_PORT is the port the clients look for (relay-client's RELAY_PORT), so the daemon must
 * listen there. What the daemon logs before it exits must reach its log file: the logger writes on a
 * 500 ms timer, which process.exit skips.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VERSION } from './utils.js'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'start-relay-server.ts')
const children: ChildProcess[] = []
let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-relay-server-'))
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const gone = exited(child)
    child.kill('SIGTERM')
    await gone
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function freePort(): Promise<number> {
  const found = Promise.withResolvers<number>()
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => (address && typeof address !== 'string' ? found.resolve(address.port) : found.reject(new Error('no port'))))
  })
  return found.promise
}

function startRelay({ port, name }: { port: number; name: string }): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT], {
    cwd: path.dirname(SCRIPT),
    env: {
      ...process.env,
      PLAYWRITER_PORT: String(port),
      PLAYWRITER_LOG_FILE_PATH: path.join(dir, `${name}.log`),
      PLAYWRITER_CDP_LOG_FILE_PATH: path.join(dir, `${name}.jsonl`),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  children.push(child)
  return child
}

function exited(child: ChildProcess): Promise<number | null> {
  const done = Promise.withResolvers<number | null>()
  child.once('exit', (code) => done.resolve(code))
  return done.promise
}

/** The version a relay on `port` reports, once it answers; null if none answers in time. */
async function versionOn(port: number, timeoutMs: number): Promise<string | null> {
  // Real timers: this polls a real server process while it starts.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`)
      const body: unknown = await response.json()
      if (typeof body === 'object' && body !== null && 'version' in body && typeof body.version === 'string') return body.version
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined
      if (!(typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ECONNREFUSED')) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

describe('the relay daemon', () => {
  it('listens on PLAYWRITER_PORT, the port its clients look for', async () => {
    const port = await freePort()
    startRelay({ port, name: 'relay' })
    expect(await versionOn(port, 20_000)).toBe(VERSION)
  }, 30_000)

  it('a second daemon on a taken port exits cleanly and writes why to its log', async () => {
    const port = await freePort()
    startRelay({ port, name: 'first' })
    expect(await versionOn(port, 20_000)).toBe(VERSION)

    const second = startRelay({ port, name: 'second' })
    expect(await exited(second)).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'second.log'), 'utf8')).toContain(`Another relay (v${VERSION}) already bound to port ${port}, exiting gracefully`)
  }, 40_000)
})
