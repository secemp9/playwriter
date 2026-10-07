/**
 * A tab whose renderer crashed, end to end through the real executor: the crash is named in the
 * report (PAGE CRASHED), every other call is refused with the same line instead of waiting on a
 * renderer that is gone, and `act.reload()` / `act.open(url)` bring the session back in a new tab
 * without `reset`.
 *
 * The renderer is crashed with CDP `Page.crash` (a `chrome://crash` navigation is blocked for
 * pages): in debug mode from the sandbox, and for human mode from the test's own CDP connection to
 * a Chrome the session reaches over direct CDP, the way a renderer dies under a person.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnDebuggableChrome, type SpawnedChrome } from './test-utils.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import { PlaywrightExecutor } from './executor.js'
import { resolveBrowserExecutablePath } from './browser-config.js'
import { analyzeCode, checkPolicy } from './code-policy.js'

const PAGE = (title: string) => `<!doctype html><html><head><title>${title}</title></head>
<body><main><h1>${title}</h1><button>Save</button></main></body></html>`

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []
const chromes: SpawnedChrome[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE(req.url === '/other' ? 'Other page' : 'Invoice 42'))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'page-crash-'))
})

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  await Promise.all(chromes.map((chrome) => chrome.stop()))
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  server.closeAllConnections()
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

/** A headless Chrome of its own, reachable over direct CDP: its WebSocket URL. */
async function startChrome(): Promise<string> {
  const chrome = await spawnDebuggableChrome({ executable: resolveBrowserExecutablePath(), profileDir: fs.mkdtempSync(path.join(cwd, 'profile-')) })
  chromes.push(chrome)
  return chrome.wsEndpoint
}

describe('a crashed renderer (debug mode, headless)', () => {
  it('names the crash, refuses other calls with it, and act.open(url) continues in a new tab', async () => {
    const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'debug' })
    executors.push(executor)
    const loaded = await executor.execute(`await act.open('${baseUrl}/')`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    expect(loaded.text).toContain('Invoice 42')

    // Test-only path: Page.crash kills this tab's renderer, as an out-of-memory or a renderer bug would.
    const crashed = await executor.execute(
      [
        'const crashed = Promise.withResolvers()',
        "page.once('crash', crashed.resolve)",
        'const cdp = await context.newCDPSession(page)',
        "cdp.send('Page.crash').catch(() => {})",
        'await crashed.promise',
      ].join('\n'),
      30000,
    )
    expect(crashed.text).toMatch(new RegExp(`PAGE CRASHED — the tab's renderer crashed \\(it showed ${baseUrl}/, (just now|\\d+ s ago)\\)`))
    expect(crashed.text).toContain('act.open(url) or act.reload() reloads it')

    const startedAt = Date.now()
    const looked = await executor.execute('await observe()', 30000)
    expect(looked.isError).toBe(true)
    expect(looked.text).toMatch(/^PAGE CRASHED — the tab's renderer crashed .*act\.open\(url\) or act\.reload\(\) reloads it\. Nothing from this call was run\.$/)
    // Refused up front, not after waiting on the dead renderer (it took 5 s and blamed a native dialog).
    expect(Date.now() - startedAt).toBeLessThan(2000)

    const opened = await executor.execute(`await act.open('${baseUrl}/other')`, 30000)
    expect(opened.isError, opened.text).toBe(false)
    expect(opened.text).toContain(`PAGE RECOVERED — the crashed tab (it showed ${baseUrl}/) was replaced by a new tab in the same browser context`)
    expect(opened.text).toContain('The crashed tab was closed.')
    expect(opened.text).toContain('Other page')
    expect(opened.text).not.toContain('PAGE CRASHED')
    // The replacement is controlled before the crashed tab closes: no "controlled tab closed" move.
    expect(opened.text).not.toContain('TAB CLOSED')

    const after = await executor.execute('await observe()', 30000)
    expect(after.isError, after.text).toBe(false)
    expect(after.text).toContain('Other page')
    expect(after.text).not.toContain('Invoice 42')
  }, 120_000)
})

describe('a crashed renderer (human mode, direct CDP)', () => {
  it('refuses every call with PAGE CRASHED until act.reload() loads the crashed page in a new tab, no reason needed', async () => {
    const endpoint = await startChrome()
    const executor = new PlaywrightExecutor({ cdpConfig: { directCdpUrl: endpoint }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
    executors.push(executor)
    const loaded = await executor.execute(`await act.open('${baseUrl}/')`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)

    // The renderer dies from outside the session: the test's own CDP connection to the same Chrome.
    const outside = await chromium.connectOverCDP(endpoint)
    try {
      const tab = outside.contexts()[0]?.pages().find((candidate) => candidate.url() === `${baseUrl}/`)
      if (!tab) throw new Error(`no tab on ${baseUrl}/ in ${outside.contexts()[0]?.pages().map((candidate) => candidate.url())}`)
      const died = Promise.withResolvers<void>()
      tab.once('crash', () => died.resolve())
      const cdp = await tab.context().newCDPSession(tab)
      cdp.send('Page.crash').catch(() => {})
      await died.promise
    } finally {
      await outside.close()
    }

    // The session hears of the crash over its own connection a moment after the test does.
    // Real time on purpose: that event's delivery, polled for at most 5 s.
    let refused = await executor.execute('return 1', 30000)
    for (const deadline = Date.now() + 5000; !refused.isError && Date.now() < deadline; ) {
      const tick = Promise.withResolvers<void>()
      setTimeout(tick.resolve, 100)
      await tick.promise
      refused = await executor.execute('return 1', 30000)
    }
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/^PAGE CRASHED — the tab's renderer crashed .*Nothing from this call was run\.$/)

    const reloaded = await executor.execute('await act.reload()', 30000)
    expect(reloaded.isError, reloaded.text).toBe(false)
    expect(reloaded.text).toContain(`PAGE RECOVERED — the crashed tab (it showed ${baseUrl}/) was replaced by a new tab in the same browser context`)
    expect(reloaded.text).toContain(`reload ${baseUrl}/ (the page that crashed)`)
    expect(reloaded.text).not.toContain('TAB CLOSED')

    const after = await executor.execute('await observe()', 30000)
    expect(after.isError, after.text).toBe(false)
    expect(after.text).toContain('Invoice 42')
    expect(after.text).toMatch(/button "Save"/)
    // The crashed tab was closed: the replacement is the only tab.
    expect(after.text).not.toMatch(/^TABS/m)

    // On a healthy, loaded page a reload is a full load like act.open: refused without a reason, run with one.
    const bare = await executor.execute('await act.reload()', 30000)
    expect(bare.isError).toBe(true)
    expect(bare.text).toContain('Refused (human mode): act.reload on line 1 has no reason')
    const reasoned = await executor.execute("await act.reload({ reason: 'the total is recomputed on load' })", 30000)
    expect(reasoned.isError, reasoned.text).toBe(false)
    expect(reasoned.text).toContain(`reload ${baseUrl}/ (reason: the total is recomputed on load)`)
    expect(reasoned.text).toContain('NEW DOCUMENT')
  }, 120_000)
})

describe('act.reload in the human-mode policy', () => {
  it('is a document navigation: refused on a loaded page without a reason, allowed with one or on a blank tab', () => {
    const bare = checkPolicy(analyzeCode('await act.reload()'), { mode: 'human', pageIsBlank: false })
    expect(bare.allowed).toBe(false)
    expect(bare.refusal).toContain("Refused (human mode): act.reload on line 1 has no reason")
    expect(bare.refusal).toContain('Nothing from this call was run.')
    const reasoned = checkPolicy(analyzeCode("await act.reload({ reason: 'the bug only shows after a reload' })"), { mode: 'human', pageIsBlank: false })
    expect(reasoned.allowed).toBe(true)
    expect(reasoned.notes.join('\n')).toContain('act.reload on line 1 loads a new document (reason: "the bug only shows after a reload")')
    expect(checkPolicy(analyzeCode('await act.reload()'), { mode: 'human', pageIsBlank: true }).allowed).toBe(true)
    // One input action per call: a reload counts as one.
    expect(checkPolicy(analyzeCode("await act.reload({ reason: 'x' })\nawait act.click(3)"), { mode: 'human', pageIsBlank: false }).allowed).toBe(false)
    expect(checkPolicy(analyzeCode('await act.reload()'), { mode: 'debug', pageIsBlank: false }).allowed).toBe(true)
  })
})
