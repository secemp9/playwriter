/**
 * start-relay-server.ts is the relay daemon relay-client spawns, the process every playwriter client
 * and the extension connect to. Run here as that child process (this Node with tsx's loader, as
 * relay-client runs it from source), each on a port of its own and with its logs in a temporary folder:
 * the daemon's logger truncates its file on start, so the default ~/.playwriter logs are never touched.
 *
 * PLAYWRITER_PORT is the port the clients look for (relay-client's RELAY_PORT), so the daemon must
 * listen there. What the daemon logs before it exits must reach its log file: the logger writes on a
 * 500 ms timer, which process.exit skips. The daemon tells the process that spawned it, over the
 * spawn's 'ipc' channel, that it listens (or that another relay already does): relay-client's
 * ensureRelayServer waits for that message, not for time.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freePort } from './fake-extension.js'
import { getListeningPidsForPort } from './kill-port.js'
import { VERSION } from './utils.js'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'start-relay-server.ts')
const children: ChildProcess[] = []
/** Ports a test had relay-client start a detached daemon on: afterEach stops what listens there. */
const daemonPorts: number[] = []
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
  for (const port of daemonPorts.splice(0)) {
    await stopListener(port)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * SIGTERMs whatever listens on `port` and returns once it is gone: a connection opened to it first is
 * closed by the kernel when the process exits.
 */
async function stopListener(port: number): Promise<void> {
  const pids = await getListeningPidsForPort({ port })
  if (pids.length === 0) return
  const socket = net.connect(port, '127.0.0.1')
  const closed = Promise.withResolvers<void>()
  socket.on('error', () => {})
  socket.once('close', () => closed.resolve())
  const connected = Promise.withResolvers<void>()
  socket.once('connect', () => connected.resolve())
  await connected.promise
  for (const pid of pids) process.kill(pid, 'SIGTERM')
  await closed.promise
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
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.push(child)
  return child
}

function exited(child: ChildProcess): Promise<number | null> {
  const done = Promise.withResolvers<number | null>()
  child.once('exit', (code) => done.resolve(code))
  return done.promise
}

/** The first message the daemon sends its spawner, or null when it closes without one. */
function firstMessage(child: ChildProcess): Promise<unknown> {
  const got = Promise.withResolvers<unknown>()
  child.once('message', (message) => got.resolve(message))
  child.once('close', () => got.resolve(null))
  return got.promise
}

async function versionOn(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/version`)
  const body: unknown = await response.json()
  if (typeof body === 'object' && body !== null && 'version' in body && typeof body.version === 'string') return body.version
  throw new Error(`/version on ${port} answered ${JSON.stringify(body)}`)
}

describe('the relay daemon', () => {
  it('listens on PLAYWRITER_PORT, the port its clients look for, and tells its spawner so', async () => {
    const port = await freePort()
    const relay = startRelay({ port, name: 'relay' })
    expect(await firstMessage(relay)).toEqual({ listening: port })
    // Told it listens: /version answers on the first request.
    expect(await versionOn(port)).toBe(VERSION)
  }, 30_000)

  it('a second daemon on a taken port tells its spawner which relay answers there, exits cleanly and writes why to its log', async () => {
    const port = await freePort()
    const first = startRelay({ port, name: 'first' })
    expect(await firstMessage(first)).toEqual({ listening: port })

    const second = startRelay({ port, name: 'second' })
    const gone = exited(second)
    expect(await firstMessage(second)).toEqual({ otherRelay: VERSION })
    expect(await gone).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'second.log'), 'utf8')).toContain(`Another relay (v${VERSION}) already bound to port ${port}, exiting gracefully`)
  }, 40_000)
})

describe('ensureRelayServer', () => {
  /** relay-client reads RELAY_PORT from PLAYWRITER_PORT when it loads: a fresh copy per port. */
  async function relayClientOn(port: number) {
    vi.resetModules()
    vi.stubEnv('PLAYWRITER_PORT', String(port))
    return import('./relay-client.js')
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const logEnv = (name: string) => ({
    PLAYWRITER_LOG_FILE_PATH: path.join(dir, `${name}.log`),
    PLAYWRITER_CDP_LOG_FILE_PATH: path.join(dir, `${name}.jsonl`),
  })

  it('starts the daemon and returns once it listens', async () => {
    const port = await freePort()
    const client = await relayClientOn(port)
    daemonPorts.push(port)
    const startedAt = performance.now()
    expect(await client.ensureRelayServer({ env: logEnv('relay') })).toBe(true)
    console.log(`ensureRelayServer started the relay in ${(performance.now() - startedAt).toFixed(0)} ms`)
    expect(await versionOn(port)).toBe(VERSION)
  }, 30_000)

  it('fails at once, naming the exit code and the log, when the daemon exits before it listens', async () => {
    const port = await freePort()
    const client = await relayClientOn(port)
    // The log's folder is a file: the daemon's logger cannot create its log, and the daemon dies while it
    // loads (ENOTDIR). (A folder under /proc is no such case: Node 22's recursive mkdir never returns there.)
    fs.writeFileSync(path.join(dir, 'not-a-folder'), '')
    const logFilePath = path.join(dir, 'not-a-folder', 'relay.log')
    const startedAt = performance.now()
    await expect(client.ensureRelayServer({ env: { PLAYWRITER_LOG_FILE_PATH: logFilePath } })).rejects.toThrow(
      `The CDP relay server exited with code 1 before it listened on port ${port}. Check logs at: ${logFilePath}`,
    )
    const reportedMs = performance.now() - startedAt
    console.log(`a daemon that died while loading was reported in ${reportedMs.toFixed(0)} ms`)
    // Its exit, not the 5 s cap: the daemon dies about 0.6 s after spawn (measured 586–711 ms).
    expect(reportedMs).toBeLessThan(4000)
  }, 30_000)

  it('names the signal that killed the daemon before it listened', async () => {
    const port = await freePort()
    const client = await relayClientOn(port)
    // 9 is SIGKILL. A quoted signal name cannot be used: NODE_OPTIONS takes the double quotes as quoting.
    const env = { ...logEnv('killed'), NODE_OPTIONS: '--import=data:text/javascript,process.kill(process.pid,9)' }
    await expect(client.ensureRelayServer({ env })).rejects.toThrow(
      `The CDP relay server was killed by SIGKILL before it listened on port ${port}. Check logs at: ${env.PLAYWRITER_LOG_FILE_PATH}`,
    )
  }, 30_000)

  it('kills an older relay on the port and starts this version in its place', async () => {
    const port = await freePort()
    // An "older relay": answers /version with 0.0.1, and says when it listens.
    const old = spawn(
      process.execPath,
      [
        '-e',
        `require('node:http').createServer((q, s) => s.end(JSON.stringify({ version: '0.0.1' }))).listen(${port}, '127.0.0.1', () => process.send('listening'))`,
      ],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    )
    children.push(old)
    expect(await firstMessage(old)).toBe('listening')
    const oldGone = Promise.withResolvers<NodeJS.Signals | null>()
    old.once('exit', (_code, signal) => oldGone.resolve(signal))

    const client = await relayClientOn(port)
    daemonPorts.push(port)
    expect(await client.ensureRelayServer({ env: logEnv('replacing') })).toBe(true)
    expect(await oldGone.promise).toBe('SIGKILL')
    expect(await versionOn(port)).toBe(VERSION)
  }, 30_000)
})
