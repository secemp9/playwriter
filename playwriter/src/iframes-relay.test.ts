/**
 * Iframes through the relay — the extension mode a user's own Chrome runs in. The page is served
 * from `localhost` and its "card payment" iframe from `127.0.0.1`: another site, so Chrome runs it
 * in its own renderer process (an out-of-process iframe), and the relay must hand Playwright a
 * session for it. The iframe is loaded BEFORE the tab is attached, as on a page the user already
 * has open.
 *
 * Asserted on what the model reads (observe, act reports, the network journal) and on the facts
 * underneath: Playwright's frame for the iframe has the URL of its document and its own session.
 */

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, Page } from '@xmorse/playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getCdpUrl } from './utils.js'
import { getCDPSessionForFrame, getCDPSessionForPage } from './cdp-session.js'
import { PageFrames } from './page-frames.js'
import { PlaywrightExecutor } from './executor.js'
import { setupTestContext, cleanupTestContext, getExtensionServiceWorker, TEST_WORKSPACE, testRelayPort, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)

const SHOP = (crossOrigin: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title>
<style>body { margin: 0; font: 16px sans-serif } iframe { display: block; margin: 12px; border: 2px solid #888 }</style></head>
<body><main><h1>Checkout</h1>
<iframe id="pay" title="Secure card payment" src="${crossOrigin}/pay" style="width: 420px; height: 150px"></iframe>
</main></body></html>`

const PAY = `<!doctype html><html><head><meta charset="utf-8"><title>Pay</title></head>
<body><p>Pay securely with your card.</p><label>Card number <input id="card" inputmode="numeric"></label> <button id="paybutton">Pay $12.00</button><p id="out"></p>
<script>document.getElementById('paybutton').addEventListener('click', () => {
  fetch('/api/pay', { method: 'POST', body: document.getElementById('card').value }).then(() => {
    document.getElementById('out').textContent = 'Payment accepted'
  })
})</script></body></html>`

let server: http.Server
let port = 0
let cwd = ''
const posts: string[] = []

/** The ref printed in front of the first line matching `pattern`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

describe('iframes through the relay', () => {
  let testCtx: TestContext | null = null
  let userPage: Page | null = null
  let client: Browser | null = null
  let executor: PlaywrightExecutor | null = null
  let payUrl = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture')
      if (url.pathname === '/api/pay' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk: Buffer) => (body += chunk.toString()))
        req.on('end', () => {
          posts.push(body)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        })
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(url.pathname === '/pay' ? PAY : SHOP(`http://127.0.0.1:${port}`))
    })
    // Every interface: the page is loaded as `localhost`, its payment iframe as `127.0.0.1`.
    const listening = Promise.withResolvers<void>()
    server.listen(0, () => listening.resolve())
    await listening.promise
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture server has no port')
    port = address.port
    payUrl = `http://127.0.0.1:${port}/pay`
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iframes-relay-'))

    testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-iframes-relay-' })
    const serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)
    userPage = await testCtx.browserContext.newPage()
    await userPage.goto(`http://localhost:${port}/`, { waitUntil: 'load' })
    // The iframe is there and loaded before the tab is attached, as on a page the user has open.
    await userPage.frameLocator('#pay').locator('#card').waitFor({ timeout: 10000 })
    await userPage.bringToFront()
    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    executor = new PlaywrightExecutor({ cdpConfig: { port: TEST_PORT, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  }, 600000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    await userPage?.close().catch(() => {})
    await cleanupTestContext(testCtx)
    testCtx = null
    server?.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server?.close(() => closed.resolve())
    await closed.promise
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('gives a relay client the iframe as a frame with its own session, whose document is the payment page', async () => {
    client = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    const page = client
      .contexts()[0]
      .pages()
      .find((candidate) => candidate.url().startsWith(`http://localhost:${port}`))
    expect(page, 'the toggled tab must be visible to the relay client').toBeDefined()
    const child = page!.frames().find((frame) => frame !== page!.mainFrame())
    expect(child, 'the relay client must see the iframe as a frame of the page').toBeDefined()
    const session = await getCDPSessionForFrame({ frame: child! })
    expect(session, 'Playwright must hold a session for the out-of-process iframe').not.toBeNull()
    const frames = new PageFrames({ page: page!, cdp: await getCDPSessionForPage({ page: page! }) })
    try {
      expect(await frames.documentUrl(child!.frameId())).toBe(payUrl)
      // MEASURED, not asserted: Playwright names this frame '' (it learns a frame's URL from
      // Page.frameNavigated, which fired before the tab was attached). Nothing here reads that.
      console.log(`[iframes-relay] Playwright frame urls: ${JSON.stringify(page!.frames().map((frame) => frame.url()))}`)
    } finally {
      frames.dispose()
    }
    await client!.close()
    client = null
  })

  let look = ''
  it('observe() lists the card fields with refs under the iframe line', async () => {
    const result = await executor!.execute('await observe()', 30000)
    expect(result.isError, result.text).toBe(false)
    look = result.text
    expect(look).toMatch(/\[\d+\] iframe "Secure card payment" — 2 controls\n\s+text: "Pay securely with your card\."\n\s+\[\d+\] textbox "Card number"\n\s+\[\d+\] button "Pay \$12\.00"/)
    expect(look).not.toMatch(/not read/)
  })

  it('types into the card field', async () => {
    const card = refOf(look, /textbox "Card number"/)
    const filled = await executor!.execute(`await act.fill(${card}, '4242424242424242')`, 60000)
    expect(filled.isError, filled.text).toBe(false)
    expect(filled.text).toMatch(/value read back: "4242424242424242"/)
    expect(await userPage!.frameLocator('#pay').locator('#card').inputValue()).toBe('4242424242424242')
  })

  it("journals the iframe's POST and refuses to send it twice", async () => {
    const pay = refOf(look, /button "Pay \$12\.00"/)
    const paid = await executor!.execute(`await act.click(${pay})`, 30000)
    expect(paid.isError, paid.text).toBe(false)
    expect(paid.text).toMatch(/Payment accepted/)
    const journal = await executor!.execute('return JSON.stringify(await net.requests())', 30000)
    expect(journal.isError, journal.text).toBe(false)
    expect(journal.text).toMatch(new RegExp(`POST[^\\n]*http://127\\.0\\.0\\.1:${port}/api/pay|http://127\\.0\\.0\\.1:${port}/api/pay[^\\n]*POST`))
    expect(posts).toEqual(['4242424242424242'])
    const again = await executor!.execute(`await act.click(${pay})`, 30000)
    expect(again.isError).toBe(true)
    expect(again.text).toMatch(/sent POST \/api\/pay — requests that change data/)
    expect(posts).toHaveLength(1)
  })
})
