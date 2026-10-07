/**
 * cookies() / storage() / saveState() / loadState() / setCookies() / clearCookies() / clipboard.read()
 * through the real extension and relay — the way Nourdine's Chrome is driven. Playwright's own
 * `context.cookies()` / `storageState()` send `Storage.getCookies` on the browser session, which the
 * relay cannot route; these go through the tab's session, and the clipboard is read by the
 * extension's offscreen document.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { cleanupTestContext, setupTestContext, testRelayPort, TEST_WORKSPACE, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)
const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

let testCtx: TestContext | null = null
let server: http.Server
let port = 0
let cwd = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const file = path.join(LAB, path.normalize(url.pathname).replace(/^\/+/, ''))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8',
    }
    if (url.pathname === '/storage.html') headers['Set-Cookie'] = ['sid=relay-session-id; Path=/; HttpOnly; SameSite=Lax', 'adminpref=wide; Path=/admin']
    res.writeHead(200, headers)
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'page-storage-relay-'))
  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-storage-relay-', toggleExtension: true })
}, 600000)

afterAll(async () => {
  await cleanupTestContext(testCtx, null)
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

function relayExecutor(policy: 'human' | 'debug'): PlaywrightExecutor {
  return new PlaywrightExecutor({ cdpConfig: { port: TEST_PORT, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy })
}

async function run(executor: PlaywrightExecutor, code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

describe('through the extension relay', () => {
  it('human mode: cookies() and storage() read the tab over the relay, where context.cookies() cannot', async () => {
    const human = relayExecutor('human')
    await run(human, `await page.goto('http://127.0.0.1:${port}/storage.html', { waitUntil: 'load' })`)
    const seen = await run(human, 'console.log(await observe())')
    await run(human, `await act.click(${refOf(seen, /button "Set cookie"/)})`)
    await run(human, `await act.click(${refOf(seen, /button "Set localStorage"/)})`)
    const listed = await run(human, 'return await cookies()')
    expect(listed).toContain("name: 'sid'")
    expect(listed).toContain('httpOnly: true')
    expect(listed).toContain("value: '<16 chars>'")
    expect(listed).toContain("name: 'theme'")
    const both = await run(human, 'return await storage()')
    expect(both).toContain("local: { 'lab-pref': 'compact' }")
    const file = path.join(cwd, 'relay-state.json')
    const saved = await run(human, `return await saveState({ path: '${file}' })`)
    expect(saved).toContain('adminpref (127.0.0.1 path /admin)')
    expect(saved).toContain(`http://127.0.0.1:${port}: 1 localStorage key(s)`)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      cookies: expect.arrayContaining([expect.objectContaining({ name: 'sid', value: 'relay-session-id', httpOnly: true })]),
      origins: [{ origin: `http://127.0.0.1:${port}`, localStorage: [{ name: 'lab-pref', value: 'compact' }] }],
    })
  }, 120000)

  it('debug mode: Playwright’s context.cookies() fails over the relay; setCookies, clearCookies and loadState work', async () => {
    const debug = relayExecutor('debug')
    await run(debug, `await page.goto('http://127.0.0.1:${port}/storage.html', { waitUntil: 'load' })`)
    const playwright = await debug.execute('return await context.cookies()', 30000)
    expect(playwright.isError).toBe(true)
    expect(playwright.text).toContain('Storage.getCookies')
    const set = await run(debug, "return await setCookies('relay=yes')")
    expect(set).toContain('relay (http://127.0.0.1')
    expect(await run(debug, 'return await cookies({ values: true })')).toMatch(/name: 'relay',\s+value: 'yes'/)
    const file = path.join(cwd, 'relay-roundtrip.json')
    await run(debug, `await saveState('${file}')`)
    const cleared = await run(debug, 'return await clearCookies()')
    expect(cleared).toContain('relay (127.0.0.1 path /)')
    expect(await run(debug, 'return await cookies()')).not.toContain("name: 'relay'")
    const loaded = await run(debug, `return await loadState('${file}')`)
    expect(loaded).toContain('relay (127.0.0.1 path /)')
    expect(await run(debug, 'return await cookies({ values: true })')).toMatch(/name: 'relay',\s+value: 'yes'/)
  }, 120000)

  it('human mode: clipboard.read() returns what the page’s Copy button wrote, read by the extension', async () => {
    const human = relayExecutor('human')
    await run(human, `await act.open('http://127.0.0.1:${port}/clipboard-watch.html', { reason: 'the clipboard test page' })`)
    const seen = await run(human, 'console.log(await observe())')
    const copied = await run(human, `await act.click(${refOf(seen, /button "Copy command"/)})`)
    expect(copied).toContain('Copied')
    const read = await run(human, 'return await clipboard.read()')
    expect(read).toContain('git clone https://example.com/lab.git')
    const log = await run(human, 'console.log(await observe())')
    expect(log).toContain('permission prompt')
    expect(log).not.toContain('permission changed')
  }, 120000)
})
