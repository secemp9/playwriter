/**
 * Live-Chromium proofs that playwriter does not perturb Playwright's own page session or
 * the page behind the caller's back:
 *
 *  - `getCDPSessionForPage` borrows Playwright's session ONCE per page (every borrow used
 *    to chain another permanent event forwarder in the fork), and releases the listeners
 *    registered through it when the page closes;
 *  - Debugger and Editor never send `*.disable` on that shared session, enable each domain
 *    once, and keep page pauses skipped unless a caller armed something meant to pause —
 *    so a page's own `debugger;` statement does not freeze it;
 *  - an Editor dry run writes nothing;
 *  - the human mouse's first start point comes from `Page.getLayoutMetrics`, not from the
 *    page's realm;
 *  - none of the above changes what the page can observe about itself.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'
import { getCDPSessionForPage, type ICDPSession } from './cdp-session.js'
import { debuggerDomainFor } from './cdp-domains.js'
import { Debugger } from './debugger.js'
import { Editor } from './editor.js'
import { createHumanMouseApi } from './human-mouse-driver.js'
import { withDeadline } from './isolated-world.js'

const APP_JS = `function stopHere() {
  debugger;
  return 'ran past the debugger statement';
}
function breakable(n) {
  var doubled = n * 2;
  return doubled;
}
`

const STYLES_CSS = '#x { color: rgb(255, 0, 0); }\n'

/** The page counts its own DOM mutations, so anything we change is visible to it. */
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>hygiene</title>
<link rel="stylesheet" href="/s.css"></head>
<body><h1 id="x">Hygiene</h1><script src="/app.js"></script>
<script>window.mutationRecords = 0; new MutationObserver((records) => { window.mutationRecords += records.length })
  .observe(document, { subtree: true, childList: true, attributes: true, characterData: true })</script></body></html>`

let browser: Browser
let context: BrowserContext
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(APP_JS)
      return
    }
    if (req.url === '/s.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      res.end(STYLES_CSS)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(`the fixture server has no TCP address: ${address}`)
  baseUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext()
}, 120000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
  await new Promise<void>((r) => server?.close(() => r()))
})

/** Forwards to a real session and records every command sent through it. */
class RecordingSession implements ICDPSession {
  readonly sent: Array<{ method: string; params: unknown }> = []

  constructor(private readonly inner: ICDPSession) {}

  async send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
  ): Promise<ProtocolMapping.Commands[K]['returnType']> {
    this.sent.push({ method, params })
    return await this.inner.send(method, params)
  }

  on<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this.inner.on(event, callback)
    return this
  }

  off<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this.inner.off(event, callback)
    return this
  }

  async detach(): Promise<void> {
    await this.inner.detach()
  }

  methods(): string[] {
    return this.sent.map((entry) => entry.method)
  }

  skipFlags(): unknown[] {
    return this.sent.filter((entry) => entry.method === 'Debugger.setSkipAllPauses').map((entry) => entry.params)
  }
}

async function freshPage(): Promise<Page> {
  const page = await context.newPage()
  await page.goto(baseUrl)
  return page
}

/** What the page's own realm can observe about itself (`mutationRecords` is the fixture's own counter). */
async function footprint(page: Page): Promise<{ elements: number; globals: string[]; mutationRecords: number }> {
  return await page.evaluate<{ elements: number; globals: string[]; mutationRecords: number }>(
    `({ elements: document.querySelectorAll('*').length, globals: Object.getOwnPropertyNames(globalThis).sort(), mutationRecords: window.mutationRecords })`,
  )
}

/** Runs the page's `debugger;` function; bounded, because a paused page never answers. */
async function runDebuggerStatement(page: Page): Promise<string> {
  return await withDeadline(page.evaluate<string>('stopHere()'), 5000, "running the page's debugger; statement")
}

describe('getCDPSessionForPage borrows once per page', () => {
  it('N calls share one adapter, an event reaches a handler once, and closing the page releases it', async () => {
    const page = await freshPage()
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => getCDPSessionForPage({ page })))
    const cdp = await getCDPSessionForPage({ page })
    for (const each of concurrent) expect(each).toBe(cdp)

    let calls = 0
    const onConsole = () => {
      calls++
    }
    cdp.on('Runtime.consoleAPICalled', onConsole)
    await page.evaluate(() => {
      console.log('one')
      console.log('two')
      console.log('three')
    })
    await expect.poll(() => calls).toBe(3)

    for (let i = 0; i < 20; i++) expect(await getCDPSessionForPage({ page })).toBe(cdp)
    await page.evaluate(() => console.log('four'))
    await expect.poll(() => calls).toBe(4)
    expect(cdp.listenerCount()).toBe(1)

    await page.close()
    expect(cdp.listenerCount(), 'closing the page removes every listener registered through the adapter').toBe(0)
    expect(() => cdp.on('Runtime.consoleAPICalled', onConsole)).toThrow(/released because its page was closed/)
    await expect(getCDPSessionForPage({ page })).rejects.toThrow(/the page is closed/)
  })
})

describe('Debugger and Editor share one owner per domain and never disable', () => {
  it('enables Debugger and CSS once, sends no *.disable, and skips pauses before enabling', async () => {
    const page = await freshPage()
    const cdp = new RecordingSession(await getCDPSessionForPage({ page }))
    const first = new Debugger({ cdp })
    const second = new Debugger({ cdp })
    const editor = new Editor({ cdp })

    await first.enable()
    await second.enable()
    const urls = await editor.list()
    expect(urls).toContain(`${baseUrl}/app.js`)
    expect(urls).toContain(`${baseUrl}/s.css`)
    expect((await first.listScripts({ search: 'app.js' })).map((s) => s.url)).toEqual([`${baseUrl}/app.js`])
    expect(await second.getScriptSourceByUrl({ url: 'app.js' })).toMatchObject({ source: APP_JS })

    const methods = cdp.methods()
    expect(methods.filter((m) => m.endsWith('.disable')), 'nothing may be disabled on the shared session').toEqual([])
    expect(methods.filter((m) => m === 'Debugger.enable')).toHaveLength(1)
    expect(methods.filter((m) => m === 'CSS.enable')).toHaveLength(1)
    expect(
      methods.indexOf('Debugger.setSkipAllPauses'),
      'pauses are skipped before the domain is on, so there is no window in which debugger; pauses the page',
    ).toBeLessThan(methods.indexOf('Debugger.enable'))
    expect(cdp.skipFlags()).toEqual([{ skip: true }])
    await page.close()
  })

  it("a page's debugger; statement does not pause it unless a caller armed a pausing breakpoint", async () => {
    const page = await freshPage()
    const cdp = new RecordingSession(await getCDPSessionForPage({ page }))
    const dbg = new Debugger({ cdp })
    const domain = debuggerDomainFor(cdp)
    await dbg.enable()

    expect(await runDebuggerStatement(page)).toBe('ran past the debugger statement')
    expect(dbg.isPaused()).toBe(false)

    // A logpoint never pauses, so it does not lift the skip.
    const logpoint = await dbg.setLogpoint({ file: `${baseUrl}/app.js`, line: 6, expr: 'n', tag: 'n' })
    expect(domain.pausesAllowed).toBe(false)
    await dbg.deleteBreakpoint({ breakpointId: logpoint })

    // An unconditional breakpoint is a request to pause: the skip is lifted while it exists.
    const breakpoint = await dbg.setBreakpoint({ file: `${baseUrl}/app.js`, line: 6 })
    expect(domain.pausesAllowed).toBe(true)
    const run = page.evaluate<number>('breakable(21)')
    await expect.poll(() => dbg.isPaused()).toBe(true)
    expect((await dbg.getLocation()).lineNumber).toBe(6)
    await dbg.resume()
    expect(await run).toBe(42)

    // Removing it restores the skip, so the page's own debugger; is harmless again.
    await dbg.deleteBreakpoint({ breakpointId: breakpoint })
    expect(domain.pausesAllowed).toBe(false)
    expect(await runDebuggerStatement(page)).toBe('ran past the debugger statement')
    expect(cdp.skipFlags()).toEqual([{ skip: true }, { skip: false }, { skip: true }])

    // Pause on exceptions holds the same kind of lease.
    await dbg.setPauseOnExceptions({ state: 'uncaught' })
    expect(domain.pausesAllowed).toBe(true)
    await dbg.setPauseOnExceptions({ state: 'none' })
    expect(domain.pausesAllowed).toBe(false)
    expect(cdp.methods().filter((m) => m.endsWith('.disable'))).toEqual([])
    await page.close()
  })
})

describe('Editor', () => {
  it('a dry run writes nothing; a real edit applies', async () => {
    const page = await freshPage()
    const cdp = new RecordingSession(await getCDPSessionForPage({ page }))
    const editor = new Editor({ cdp })
    const color = () => page.evaluate<string>(`getComputedStyle(document.getElementById('x')).color`)
    const edit = { url: `${baseUrl}/s.css`, oldString: 'rgb(255, 0, 0)', newString: 'rgb(0, 0, 255)' }

    expect(await editor.edit({ ...edit, dryRun: true })).toEqual({ success: true })
    expect(cdp.methods()).not.toContain('CSS.setStyleSheetText')
    expect(await color()).toBe('rgb(255, 0, 0)')
    expect((await editor.read({ url: edit.url })).content).toContain('rgb(255, 0, 0)')

    await editor.edit(edit)
    expect(cdp.methods()).toContain('CSS.setStyleSheetText')
    expect(await color()).toBe('rgb(0, 0, 255)')

    // After a reload the editor addresses the NEW document's stylesheet. Chromium reports
    // it (CSS.styleSheetAdded) once the style engine picks it up, which can be after `load`.
    await page.reload()
    await expect.poll(async () => (await editor.list()).filter((url) => url === edit.url).length).toBe(1)
    expect((await editor.read({ url: edit.url })).content).toContain('rgb(255, 0, 0)')
    expect(cdp.methods().filter((m) => m.endsWith('.disable'))).toEqual([])
    await page.close()
  })
})

describe('human mouse start point', () => {
  it('with no emulated viewport, the first start point comes from Page.getLayoutMetrics', async () => {
    const unemulated = await browser.newContext({ viewport: null })
    const page = await unemulated.newPage()
    await page.goto(baseUrl)
    expect(page.viewportSize()).toBeNull()
    const cdp = new RecordingSession(await getCDPSessionForPage({ page }))
    const mouse = createHumanMouseApi({ defaultPage: page, getCdpSession: async () => cdp })

    const at = await mouse.position()
    expect(cdp.methods()).toEqual(['Page.getLayoutMetrics'])
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }))
    expect(at).toEqual({ x: Math.round(size.width / 2), y: Math.round(size.height / 2) })
    await unemulated.close()
  })
})

describe('page purity', () => {
  it('session borrowing, Debugger/Editor reads, the pause policy and the mouse start point leave the page as it was', async () => {
    const page = await freshPage()
    const before = await footprint(page)

    const cdp = await getCDPSessionForPage({ page })
    const dbg = new Debugger({ cdp })
    await dbg.enable()
    await dbg.listScripts()
    const logpoint = await dbg.setLogpoint({ file: `${baseUrl}/app.js`, line: 6, expr: 'n', tag: 'purity' })
    await dbg.deleteBreakpoint({ breakpointId: logpoint })
    const editor = new Editor({ cdp })
    await editor.read({ url: `${baseUrl}/app.js` })
    await editor.edit({ url: `${baseUrl}/s.css`, oldString: 'rgb(255, 0, 0)', newString: 'rgb(0, 0, 255)', dryRun: true })
    await createHumanMouseApi({ defaultPage: page, getCdpSession: getCDPSessionForPage }).position()

    expect(await footprint(page)).toEqual(before)
    await page.close()
  })
})
