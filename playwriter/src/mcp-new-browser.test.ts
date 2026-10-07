/**
 * `browser({ action: 'new', … })` options through the real MCP server (stdio), and the startup prelaunch
 * with PLAYWRITER_BROWSER=new. An in-process relay on a free port (the server checks it at startup and
 * `list` reads it), the browser-new fixture server (new-browser-fixture.ts) on another; every browser is
 * a Chrome the MCP server launches itself.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import { freePort } from './fake-extension.js'
import { createMCPClient } from './mcp-client.js'
import { reportFor, startFixtureServer, type FixtureServer } from './new-browser-fixture.js'

let relayPort = 0
let relay: RelayServer
let fixture: FixtureServer
const running = new Set<() => Promise<void>>()
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-new-browser-'))

async function startMcp(env: Record<string, string> = {}): Promise<{ client: Client; stop: () => Promise<void>; pid: number }> {
  const { client, cleanup, pid } = await createMCPClient({
    port: relayPort,
    env: { PLAYWRITER_BROWSER: '', PLAYWRITER_DIRECT: '', PLAYWRITER_HOST: '', PLAYWRITER_BROWSER_PATH: '', ...env },
  })
  running.add(cleanup)
  return {
    client,
    pid,
    stop: async () => {
      running.delete(cleanup)
      await cleanup()
    },
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }))
  const text = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
  return { text, isError: result.isError === true }
}

async function openIdentity(client: Client, tag: string, query = ''): Promise<string> {
  const opened = await call(client, 'execute', { code: `await act.open('${fixture.url}/identity.html?tag=${tag}${query}')` })
  expect(opened.isError, opened.text).toBe(false)
  return opened.text
}

/** The Chrome browser processes (not their helpers) that descend from `serverPid`. */
function sessionBrowsers(serverPid: number): number[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : []
    })
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
  return rows.filter((row) => descendants.has(row.pid) && row.command.includes('--remote-debugging-pipe') && !row.command.includes('--type=')).map((row) => row.pid)
}

/** Polls `condition`. Real timers: it watches other processes (Chrome, the MCP server). */
async function waitFor<T>(what: string, condition: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = condition()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    const tick = Promise.withResolvers<void>()
    setTimeout(tick.resolve, 100)
    await tick.promise
  }
}

beforeAll(async () => {
  relayPort = await freePort()
  relay = await startPlayWriterCDPRelayServer({ port: relayPort, host: '127.0.0.1', logger: { log: () => {}, error: () => {} } })
  fixture = await startFixtureServer()
}, 60_000)

afterAll(async () => {
  for (const cleanup of running) await cleanup()
  await fixture?.close()
  await relay?.close()
})

describe('browser new options', () => {
  let client: Client
  beforeAll(async () => {
    ;({ client } = await startMcp())
  }, 60_000)

  it('viewport, locale, timezone and colorScheme reach the page and every worker, and list shows them', async () => {
    const launched = await call(client, 'browser', { action: 'new', viewport: { width: 900, height: 650 }, locale: 'fr-FR', timezone: 'America/New_York', colorScheme: 'dark' })
    expect(launched.isError, launched.text).toBe(false)
    expect(launched.text).toContain('viewport: 900×650')
    expect(launched.text).toContain('locale: fr-FR · timezone: America/New_York · color scheme: dark')

    await openIdentity(client, 'options')
    const report = await reportFor(fixture, 'options')
    expect(report.window).toMatchObject({ innerWidth: 900, innerHeight: 650 })
    expect(report.media.dark).toBe(true)
    for (const scope of ['page', 'dedicated', 'shared', 'service'] as const) {
      expect({ scope, language: report[scope].scope.language, timeZone: report[scope].scope.timeZone }).toEqual({ scope, language: 'fr-FR', timeZone: 'America/New_York' })
    }
    expect(fixture.requests.find((request) => request.path === '/identity.html')?.acceptLanguage).toMatch(/^fr-FR,fr/)

    const listed = await call(client, 'browser', { action: 'list' })
    expect(listed.isError, listed.text).toBe(false)
    expect(listed.text).toContain('This session drives: a new Chrome launched for this session')
    expect(listed.text).toContain('viewport: 900×650')
    expect(listed.text).toContain('locale: fr-FR')
  }, 120_000)

  it('userAgent reaches the page, every worker and every request; what still shows the computer is said', async () => {
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
    const launched = await call(client, 'browser', { action: 'new', userAgent: windows })
    expect(launched.isError, launched.text).toBe(false)
    expect(launched.text).toContain(`user agent: ${windows}`)
    expect(launched.text).toContain('navigator.platform in workers still says')

    const requestsBefore = fixture.requests.length
    await openIdentity(client, 'custom-ua')
    const report = await reportFor(fixture, 'custom-ua')
    for (const scope of ['page', 'dedicated', 'shared', 'service'] as const) {
      expect({ scope, userAgent: report[scope].scope.userAgent, platform: report[scope].scope.highEntropy?.platform }).toEqual({ scope, userAgent: windows, platform: 'Windows' })
    }
    const scriptRequests = fixture.requests.slice(requestsBefore).filter((request) => request.path === '/scope.js' || request.path === '/identity.html')
    expect(scriptRequests.length).toBeGreaterThan(0)
    for (const request of scriptRequests) expect(request.userAgent).toBe(windows)
  }, 120_000)

  it('device presents Chrome on that phone: screen, pixel ratio, touch, Android user agent and client hints', async () => {
    const launched = await call(client, 'browser', { action: 'new', device: 'Pixel 7' })
    expect(launched.isError, launched.text).toBe(false)
    expect(launched.text).toContain('device: Pixel 7 — 412×839 page, pixel ratio 2.625, touch')

    await openIdentity(client, 'pixel')
    const report = await reportFor(fixture, 'pixel')
    expect(report.window).toMatchObject({ innerWidth: 412, devicePixelRatio: 2.625 })
    expect(report.touchPoints).toBeGreaterThan(0)
    expect(report.media.coarse).toBe(true)
    for (const scope of ['page', 'dedicated', 'service'] as const) {
      const presented = report[scope].scope
      expect({ scope, userAgent: presented.userAgent }).toEqual({ scope, userAgent: expect.stringMatching(/^Mozilla\/5\.0 \(Linux; Android 10; K\) .* Chrome\/\d+\.0\.0\.0 Mobile Safari\/537\.36$/) })
      expect({ scope, platform: presented.highEntropy?.platform, mobile: presented.highEntropy?.mobile, model: presented.highEntropy?.model }).toEqual({ scope, platform: 'Android', mobile: true, model: 'Pixel 7' })
    }
  }, 120_000)

  it('refuses a device that imitates another browser, and an unknown one, naming the Chrome presets', async () => {
    const safari = await call(client, 'browser', { action: 'new', device: 'iPhone 13' })
    expect(safari.isError).toBe(true)
    expect(safari.text).toContain('"iPhone 13" imitates Safari')
    expect(safari.text).toContain('Pixel 7')
    const unknown = await call(client, 'browser', { action: 'new', device: 'Nokia 3310' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('"Nokia 3310" is not a device preset. The Chrome presets are:')
  }, 60_000)

  it('refuses options it cannot apply, before releasing the current browser', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'new', device: 'Pixel 7', viewport: { width: 800, height: 600 } }, 'pass device or viewport, not both'],
      [{ action: 'new', locale: 'not a locale!' }, 'is not a language tag'],
      [{ action: 'new', timezone: 'Mars/Olympus' }, 'is not an IANA time zone'],
      [{ action: 'new', downloads: '/etc/playwriter-downloads' }, 'is outside the folders this session may write to'],
      [{ action: 'new', allowedDomains: ['https://example.com/path'] }, 'is not a host name'],
      [{ action: 'list', viewport: { width: 800, height: 600 } }, 'viewport is only read by new; list takes none'],
    ]
    for (const [args, expected] of cases) {
      const refused = await call(client, 'browser', args)
      expect({ args, isError: refused.isError, matches: refused.text.includes(expected) }, refused.text).toEqual({ args, isError: true, matches: true })
    }
    // The Pixel 7 browser from the test before is still the one driven.
    const still = await call(client, 'execute', { code: 'return page.viewportSize()' })
    expect(still.text).toContain('412')
  }, 60_000)

  it('allowedDomains blocks every other host, in the page and in workers, and the report says why', async () => {
    const launched = await call(client, 'browser', { action: 'new', allowedDomains: ['127.0.0.1'] })
    expect(launched.isError, launched.text).toBe(false)
    expect(launched.text).toContain('allowed hosts: 127.0.0.1 (requests elsewhere are blocked and reported)')

    const pingsBefore = fixture.requests.filter((request) => request.path === '/ping').length
    const opened = await openIdentity(client, 'allowlist', `&fetch=${encodeURIComponent(`${fixture.otherHostUrl}/ping`)}`)
    const report = await reportFor(fixture, 'allowlist')
    for (const scope of ['page', 'dedicated', 'shared', 'service'] as const) {
      expect({ scope, fetched: report[scope].fetched }).toEqual({ scope, fetched: expect.stringMatching(/^failed:/) })
    }
    expect(fixture.requests.filter((request) => request.path === '/ping').length).toBe(pingsBefore)
    const failed = await call(client, 'execute', { code: `return await net.requests({ urlIncludes: '/ping', failedOnly: true })` })
    expect(`${opened}\n${failed.text}`).toContain('blocked: localhost is not in allowedDomains (127.0.0.1)')
  }, 120_000)

  it('downloads: every finished download is also saved into the folder under its own name', async () => {
    const folder = path.join(sessionDir, 'downloads')
    const launched = await call(client, 'browser', { action: 'new', downloads: folder })
    expect(launched.isError, launched.text).toBe(false)
    await openIdentity(client, 'downloads')
    const observed = await call(client, 'execute', { code: 'await observe()' })
    const ref = /\[(\d+)\] link "Download report"/.exec(observed.text)?.[1]
    expect(ref, observed.text).toBeDefined()
    const clicked = await call(client, 'execute', { code: `await act.click(${ref})` })
    expect(clicked.isError, clicked.text).toBe(false)
    const saved = await waitFor('report.csv in the downloads folder', () => (fs.existsSync(path.join(folder, 'report.csv')) ? true : undefined))
    expect(saved).toBe(true)
    expect(fs.readFileSync(path.join(folder, 'report.csv'), 'utf8')).toBe('id,name\n1,Ada\n')
  }, 120_000)
})

describe('headed', () => {
  it('is refused on a server without a display', async () => {
    const { client, stop } = await startMcp({ DISPLAY: '', WAYLAND_DISPLAY: '' })
    try {
      const refused = await call(client, 'browser', { action: 'new', headed: true })
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('headed: this MCP server has no display')
    } finally {
      await stop()
    }
  }, 60_000)

  it.skipIf(!fs.existsSync('/usr/bin/Xvfb'))('shows a window on a display, and presents the same Chrome', async () => {
    const xvfb: ChildProcess = spawn('/usr/bin/Xvfb', ['-displayfd', '1', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const display = Promise.withResolvers<string>()
      xvfb.stdout?.once('data', (chunk: Buffer) => display.resolve(`:${chunk.toString().trim()}`))
      xvfb.once('exit', (code) => display.reject(new Error(`Xvfb exited with ${code}`)))
      const { client, stop } = await startMcp({ DISPLAY: await display.promise, WAYLAND_DISPLAY: '' })
      try {
        const launched = await call(client, 'browser', { action: 'new', headed: true })
        expect(launched.isError, launched.text).toBe(false)
        expect(launched.text).toContain('Now driving a new headed Chrome')
        await openIdentity(client, 'headed')
        const report = await reportFor(fixture, 'headed')
        expect(report.page.scope.userAgent).not.toContain('Headless')
        expect(report.service.scope.userAgent).toBe(report.page.scope.userAgent)
        expect(report.page.scope.webdriver).toBe(false)
        expect(report.window).toMatchObject({ innerWidth: 1280, innerHeight: 720 })
      } finally {
        await stop()
      }
    } finally {
      xvfb.kill()
    }
  }, 120_000)
})

describe('PLAYWRITER_BROWSER=new', () => {
  it('launches the browser at startup, before any call, and the first execute takes it', async () => {
    const { client, stop, pid } = await startMcp({ PLAYWRITER_BROWSER: 'new' })
    let prelaunched: number[] = []
    try {
      prelaunched = await waitFor('the prelaunched Chrome', () => {
        const browsers = sessionBrowsers(pid)
        return browsers.length > 0 ? browsers : undefined
      })
      expect(prelaunched).toHaveLength(1)
      await openIdentity(client, 'prelaunch')
      await reportFor(fixture, 'prelaunch')
      expect(sessionBrowsers(pid)).toEqual(prelaunched)
    } finally {
      await stop()
    }
    // Closing the client ends the server (stdin EOF) and its Chrome: those very processes, wherever they were reparented.
    await waitFor('the prelaunched Chrome to exit', () => {
      const alive = execFileSync('ps', ['-A', '-o', 'pid=,stat='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([processId, stat]) => prelaunched.includes(Number(processId)) && !stat?.startsWith('Z'))
      return alive.length === 0 ? true : undefined
    })
  }, 120_000)
})
