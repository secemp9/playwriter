/**
 * Iframes, end to end through the real executor in human mode. The page is served from `localhost`
 * and holds a same-origin iframe form and a "card payment" iframe from `127.0.0.1` — another site,
 * so under Chromium's site isolation (on by default in headless Chromium, measured) it runs in its
 * own renderer process with its own CDP session (an out-of-process iframe). A second page is
 * covered by a cross-site cookie-consent iframe.
 *
 * Every assertion is on what the model reads: observations, action reports, refusals, markdown,
 * explain() — plus the page's own view of itself in every frame (purity).
 */

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

/** Each fixture document counts the mutation records of its own DOM, so a test can see that reading it changed nothing. */
const COUNT_MUTATIONS = `<script>
  window.__mutations = 0
  const counter = new MutationObserver((records) => { window.__mutations += records.length })
  counter.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  window.__takeMutations = () => window.__mutations + counter.takeRecords().length
</script>`

const SHOP = (crossOrigin: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title>
<style>body { margin: 0; font: 16px sans-serif } iframe { display: block; margin: 12px; border: 2px solid #888 }</style></head>
<body><main><h1>Checkout</h1>
<iframe id="news" title="Newsletter signup" src="/form" style="width: 420px; height: 150px"></iframe>
<iframe id="pay" title="Secure card payment" src="${crossOrigin}/pay" style="width: 420px; height: 150px"></iframe>
</main>${COUNT_MUTATIONS}</body></html>`

const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Newsletter</title></head>
<body><p>Get our weekly deals.</p><label>Email <input id="email" type="email"></label> <button id="subscribe">Subscribe</button><p id="status"></p>
<script>document.getElementById('subscribe').addEventListener('click', () => {
  document.getElementById('status').textContent = 'Subscribed: ' + document.getElementById('email').value
})</script>${COUNT_MUTATIONS}</body></html>`

const PAY = `<!doctype html><html><head><meta charset="utf-8"><title>Pay</title></head>
<body><p>Pay securely with your card.</p><label>Card number <input id="card" inputmode="numeric"></label> <button id="paybutton">Pay $12.00</button><p id="out"></p>
<script>document.getElementById('paybutton').addEventListener('click', function payNow() {
  fetch('/api/pay', { method: 'POST', body: document.getElementById('card').value }).then(() => {
    document.getElementById('out').textContent = 'Payment accepted'
  })
})</script>${COUNT_MUTATIONS}</body></html>`

const WALL = (crossOrigin: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>News</title>
<style>body { margin: 0; font: 16px sans-serif } #wall { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: rgba(0,0,0,0.4) }</style></head>
<body><h1>Today's news</h1><button id="read">Read more</button>
<iframe id="wall" title="Cookie consent" src="${crossOrigin}/consent"></iframe>
<script>addEventListener('message', (event) => { if (event.data === 'accepted') document.getElementById('wall').remove() })</script></body></html>`

const CONSENT = `<!doctype html><html><head><meta charset="utf-8"><title>Consent</title>
<style>body { margin: 0; height: 100vh; display: grid; place-items: center } div { background: white; padding: 24px }</style></head>
<body><div role="dialog" aria-label="We use cookies"><p>We use cookies to improve the site.</p><button id="accept">Accept all</button></div>
<script>document.getElementById('accept').addEventListener('click', () => parent.postMessage('accepted', '*'))</script></body></html>`

let server: http.Server
let port = 0
let cwd = ''
const posts: string[] = []
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    const cross = `http://127.0.0.1:${port}`
    const html = (body: string): void => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
    }
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
    if (url.pathname === '/') return html(SHOP(cross))
    if (url.pathname === '/form') return html(FORM)
    if (url.pathname === '/pay') return html(PAY)
    if (url.pathname === '/news') return html(WALL(cross))
    if (url.pathname === '/consent') return html(CONSENT)
    res.writeHead(404)
    res.end()
  })
  // Every interface: the page is loaded as `localhost`, its payment iframe as `127.0.0.1`.
  const listening = Promise.withResolvers<void>()
  server.listen(0, () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iframes-'))
})

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

function newExecutor(): PlaywrightExecutor {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  executors.push(executor)
  return executor
}

/** The ref printed in front of the first line matching `pattern`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

/** Every frame's own view of itself: its global names, its element count, its mutation records. */
const FOOTPRINT = `return await Promise.all(page.frames().map((frame) => frame.evaluate(() => ({
  url: location.href,
  globals: Object.getOwnPropertyNames(window).length,
  elements: document.getElementsByTagName('*').length,
  mutations: window.__takeMutations ? window.__takeMutations() : -1,
}))))`

describe('iframes in human mode', () => {
  const executor = newExecutor()
  let look = ''

  it('loads a page whose payment iframe is another site (out of process)', async () => {
    const result = await executor.execute(`await page.goto('http://localhost:${port}/', { waitUntil: 'load' })`, 30000)
    expect(result.isError, result.text).toBe(false)
    const frames = await executor.execute(`return page.frames().map((frame) => frame.url())`, 30000)
    expect(frames.text).toContain(`http://127.0.0.1:${port}/pay`)
  })

  it('observe() lists each iframe with its controls under it', async () => {
    const result = await executor.execute('await observe()', 30000)
    expect(result.isError, result.text).toBe(false)
    look = result.text
    expect(look).toMatch(/\[\d+\] iframe "Newsletter signup" — 2 controls/)
    expect(look).toMatch(/\[\d+\] iframe "Secure card payment" — 2 controls/)
    // The iframe's content is nested under its line; a label's words are its field's name, not repeated as text.
    expect(look).toMatch(/\n {2}\[\d+\] iframe "Newsletter signup" — 2 controls\n {4}text: "Get our weekly deals\."\n {4}\[\d+\] textbox "Email" type=email\n {4}\[\d+\] button "Subscribe"/)
    expect(look).toMatch(/\n {2}\[\d+\] iframe "Secure card payment" — 2 controls\n {4}text: "Pay securely with your card\."\n {4}\[\d+\] textbox "Card number"\n {4}\[\d+\] button "Pay \$12\.00"/)
    expect(look).not.toMatch(/not read/)
  })

  it('fills and clicks inside the same-origin iframe, and the report shows the change', async () => {
    const email = refOf(look, /textbox "Email"/)
    const filled = await executor.execute(`await act.fill(${email}, 'ana@example.com')`, 60000)
    expect(filled.isError, filled.text).toBe(false)
    expect(filled.text).toMatch(/value read back: "ana@example\.com"/)
    const subscribe = refOf(look, /button "Subscribe"/)
    const clicked = await executor.execute(`await act.click(${subscribe})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/✓ click \[\d+\] button "Subscribe"/)
    expect(clicked.text).toMatch(/Subscribed: ana@example\.com/)
  })

  it('types into the out-of-process card field and reads the value back', async () => {
    const card = refOf(look, /textbox "Card number"/)
    const filled = await executor.execute(`await act.fill(${card}, '4242424242424242')`, 60000)
    expect(filled.isError, filled.text).toBe(false)
    expect(filled.text).toMatch(/value read back: "4242424242424242"/)
    const value = await executor.execute(`return await page.frames().find((frame) => frame.url().includes('/pay')).evaluate(() => document.getElementById('card').value)`, 30000)
    expect(value.text).toContain('4242424242424242')
  })

  it("reports the iframe's POST and refuses to send it twice", async () => {
    const pay = refOf(look, /button "Pay \$12\.00"/)
    const paid = await executor.execute(`await act.click(${pay})`, 30000)
    expect(paid.isError, paid.text).toBe(false)
    expect(paid.text).toMatch(/Payment accepted/)
    // The out-of-process iframe's request is in the page's network journal.
    const journal = await executor.execute('return JSON.stringify(await net.requests())', 30000)
    expect(journal.isError, journal.text).toBe(false)
    expect(journal.text).toMatch(new RegExp(`POST[^\\n]*http://127\\.0\\.0\\.1:${port}/api/pay|http://127\\.0\\.0\\.1:${port}/api/pay[^\\n]*POST`))
    expect(posts).toEqual(['4242424242424242'])
    const again = await executor.execute(`await act.click(${pay})`, 30000)
    expect(again.isError).toBe(true)
    expect(again.text).toMatch(/sent POST \/api\/pay — requests that change data/)
    expect(posts).toHaveLength(1)
  })

  it("reads both iframes' text inline in the markdown", async () => {
    const result = await executor.execute('return await getPageMarkdown({})', 30000)
    expect(result.isError, result.text).toBe(false)
    const markdown = result.text
    const news = markdown.indexOf('[iframe "Newsletter signup"]')
    const pay = markdown.indexOf('[iframe "Secure card payment"]')
    expect(news).toBeGreaterThan(-1)
    expect(pay).toBeGreaterThan(news)
    expect(markdown.indexOf('Get our weekly deals')).toBeGreaterThan(news)
    expect(markdown.indexOf('Pay securely with your card')).toBeGreaterThan(pay)
    expect(markdown).not.toMatch(/not read/)
  })

  it('explains a button inside the out-of-process iframe', async () => {
    const pay = refOf(look, /button "Pay \$12\.00"/)
    const result = await executor.execute(`await explain(${pay})`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/click/)
    expect(result.text).toMatch(/payNow|fetch|\/api\/pay/)
  })

  it('reads every frame without changing any of them', async () => {
    const before = await executor.execute(FOOTPRINT, 30000)
    expect(before.isError, before.text).toBe(false)
    const observed = await executor.execute('await observe(); await getPageMarkdown({}); return "read"', 60000)
    expect(observed.isError, observed.text).toBe(false)
    const after = await executor.execute(FOOTPRINT, 30000)
    expect(after.text).toBe(before.text)
    expect(before.text).toMatch(/mutations: 0/)
    expect(before.text).not.toMatch(/mutations: -1/)
  })
})

describe('a cookie wall in an iframe', () => {
  const executor = newExecutor()
  let look = ''

  it('lists the wall as an iframe over the page, with its Accept button, and the button behind it as covered', async () => {
    const loaded = await executor.execute(`await page.goto('http://localhost:${port}/news', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const result = await executor.execute('await observe()', 30000)
    expect(result.isError, result.text).toBe(false)
    look = result.text
    expect(look).toMatch(/\[\d+\] iframe "Cookie consent"/)
    expect(look).toMatch(/\[\d+\] button "Accept all"/)
    expect(look).toMatch(/button "Read more".*covered by iframe "Cookie consent" \[\d+\]/)
  })

  it('refuses to click through the wall, naming it', async () => {
    const read = refOf(look, /button "Read more"/)
    const result = await executor.execute(`await act.click(${read})`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/covered by .*in iframe http:\/\/127\.0\.0\.1/)
  })

  it('accepts the wall like a person, and the report says it went away', async () => {
    const accept = refOf(look, /button "Accept all"/)
    const result = await executor.execute(`await act.click(${accept})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/✓ click \[\d+\] button "Accept all"/)
    expect(result.text).toMatch(/- \[\d+\] iframe "Cookie consent"/)
    const after = await executor.execute('await observe()', 30000)
    expect(after.text).toMatch(/\[\d+\] button "Read more"$/m)
    expect(after.text).not.toMatch(/Cookie consent/)
  })
})
