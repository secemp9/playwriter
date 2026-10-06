/**
 * readPage against a real browser, through the executor: what the model reads, what it gets back
 * (data, refs it can act on, errors that point at its own code), and that reading changes nothing —
 * no DOM mutation the page's own MutationObserver sees, no storage or app-state write, no user
 * activation — even when the function tries to write.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const FRAME = `<!doctype html><html><head><title>Inner frame</title></head><body><p class="note">inside the frame</p><button>Frame button</button></body></html>`

const PAGE = `<!doctype html><html><head><title>Read me</title>
<style>h1 { color: rgb(200, 0, 0); --accent: teal; margin-top: 7px }</style></head>
<body><h1 data-x="7" data-y="8">Hello</h1>
<table><tr id="row"><td><a id="link" href="/a?x=1#h">Alpha</a></td><td><button id="buy" class="primary big">Buy</button></td></tr></table>
<p id="bought">bought: 0</p>
<div id="host"></div>
<iframe id="fr" src="/frame"></iframe>
<script>
  localStorage.setItem('cart', '3 items')
  window.appState = { cart: [1, 2] }
  // App code Chrome's check refuses to run: a getter reading arguments (like MediaWiki's mw.config.get), a counting getter.
  window.siteConfig = { values: { title: 'Read me' }, get(key) { return arguments.length > 1 ? arguments[1] : this.values[key] } }
  window.counter = { seen: 0, get next() { return ++this.seen } }
  window.__mutations = 0
  new MutationObserver((records) => { window.__mutations += records.length }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<span id="in" class="in-shadow">shadow text</span>'
  let bought = 0
  document.getElementById('buy').addEventListener('click', () => { document.getElementById('bought').textContent = 'bought: ' + ++bought })
</script></body></html>`

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(req.url === '/frame' ? FRAME : PAGE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}/`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'read-page-'))
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

async function open(policy: 'human' | 'debug'): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

/** What the page itself saw, read without the side-effect check and without a gesture (debug mode, raw CDP). */
async function pageState(executor: PlaywrightExecutor): Promise<string> {
  const read = await executor.execute(
    `const cdp = await getCDPSession({ page })
     const { result } = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({ mutations: window.__mutations, cart: localStorage.getItem("cart"), app: window.appState.cart.length, h1: !!document.querySelector("h1"), active: navigator.userActivation.hasBeenActive })', returnByValue: true })
     return result.value`,
    30000,
  )
  expect(read.isError, read.text).toBe(false)
  return read.text
}

describe('readPage', () => {
  let human: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    human = await open('human')
    look = (await human.execute('await observe()', 30000)).text
  })

  it("reads the page's document without a ref, the element of a ref with an arg, and a frame's own document", async () => {
    const buy = refOf(look, /button "Buy"/)
    const frameButton = refOf(look, /button "Frame button"/)
    const result = await human.execute(
      `return JSON.stringify([
        await readPage(() => document.title),
        await readPage((el, suffix) => el.textContent + suffix, { ref: ${buy}, arg: '!' }),
        await readPage((el) => [document.title, el.textContent, document.querySelector('.note').textContent], { ref: ${frameButton} }),
      ])`,
      30000,
    )
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('["Read me","Buy!",["Inner frame","Frame button","inside the frame"]]')
  })

  it("answers the reads Chrome does not mark read-only exactly as the native calls do", async () => {
    const buy = refOf(look, /button "Buy"/)
    const read = `(el) => ({
      row: el.closest('tr').id,
      chain: el.closest('tr')?.closest('table')?.localName,
      matches: [el.matches('button#buy'), el.matches('a')],
      root: el.getRootNode().nodeName,
      shadow: document.getElementById('host').shadowRoot.getElementById('in').getRootNode({ composed: true }).nodeName,
      byId: document.getElementById('buy').textContent,
      same: el.isSameNode(document.getElementById('buy')),
      href: location.toString(),
      cart: [localStorage.getItem('cart'), localStorage.getItem('nope'), localStorage.key(0)],
      rect: Object.keys(el.getBoundingClientRect().toJSON()),
      style: [getComputedStyle(document.querySelector('h1')).getPropertyValue('color'), getComputedStyle(document.querySelector('h1')).getPropertyValue('margin-top')],
      data: { ...document.querySelector('h1').dataset, z: Object.fromEntries([['k', 1]]), merged: Object.assign({}, { a: 1 }) },
    })`
    const shimmed = await human.execute(`return JSON.stringify(await readPage(${read}, { ref: ${buy} }))`, 30000)
    expect(shimmed.isError, shimmed.text).toBe(false)
    const debug = await open('debug')
    const native = await debug.execute(`return JSON.stringify(await page.evaluate(() => (${read})(document.getElementById('buy'))))`, 30000)
    expect(native.isError, native.text).toBe(false)
    expect(shimmed.text.replace(/:\d+\//g, ':PORT/')).toBe(native.text.replace(/:\d+\//g, ':PORT/'))
  })

  it('gives elements back as refs the model can act on', async () => {
    const result = await human.execute("return await readPage(() => document.querySelectorAll('a, button, p'))", 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/ref: \d+, text: '\[\d+\] link "Alpha"'/)
    expect(result.text).toContain("p \"bought: 0\" — page content, not a control")
    const buyRef = refOf(result.text.replace(/ref: (\d+), text: '\[\d+\] button "Buy"'/, '[$1] button "Buy"'), /button "Buy"/)
    const clicked = await human.execute(`await act.click(${buyRef})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    const after = await human.execute("return await readPage(() => document.getElementById('bought').textContent)", 30000)
    expect(after.text).toContain('bought: 1')
  })

  it("points at the model's own line when the function throws, and explains closures", async () => {
    const thrown = await human.execute("return await readPage(() => {\n  const missing = document.querySelector('.nope')\n  return missing.textContent\n})", 30000)
    expect(thrown.isError).toBe(true)
    expect(thrown.text).toContain("readPage: the function threw: TypeError: Cannot read properties of null (reading 'textContent').")
    expect(thrown.text).toMatch(/> 3 \|\s+return missing\.textContent/)
    const closure = await human.execute("const sel = '#buy'\nreturn await readPage(() => document.querySelector(sel).textContent)", 30000)
    expect(closure.text).toContain('cannot see the variables of your code: pass values with { arg: … }')
  })

  it('names a read Chrome refuses, where it is, and what to read instead', async () => {
    const buy = refOf(look, /button "Buy"/)
    const result = await human.execute(`return await readPage((el) => el.getClientRects().length, { ref: ${buy} })`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toContain("Chrome's side-effect check stopped the function before anything on the page changed")
    expect(result.text).toContain('It stopped in `el.getClientRects()` (line 1):')
    expect(result.text).toMatch(/> 1 \| \(el\) => el\.getClientRects\(\)\.length\n\s+\|\s+\^+/)
    expect(result.text).toContain('getClientRects() is a read Chrome has not marked read-only — use getBoundingClientRect() instead.')
  })

  it("finds the page's own function the check stopped, and the data is readable without it", async () => {
    const refused = await human.execute("return await readPage(() => {\n  const heading = document.querySelector('h1').textContent\n  return [heading, window.siteConfig.get('title')]\n})", 30000)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("It stopped in `window.siteConfig.get('title')` (line 3):")
    expect(refused.text).toMatch(/> 3 \|\s+return \[heading, window\.siteConfig\.get\('title'\)\]/)
    expect(refused.text).toContain('Object.keys(window.siteConfig) lists what window.siteConfig holds.')
    const keys = await human.execute('return await readPage(() => Object.keys(window.siteConfig))', 30000)
    expect(keys.text).toContain("[ 'values', 'get' ]")
    const title = await human.execute('return await readPage(() => window.siteConfig.values.title)', 30000)
    expect(title.text).toContain('Read me')
  })

  it('tells a refused call from what runs between calls and from turning the result into data', async () => {
    const inArguments = await human.execute("return await readPage(() => window.siteConfig.get(document.querySelector('h1').id))", 30000)
    expect(inArguments.text).toContain(
      "It stopped in `window.siteConfig.get(document.querySelector('h1').id)` (line 1), after `document.querySelector('h1')` returned — in the rest of its arguments, or the call itself:",
    )
    const getter = await human.execute("return await readPage(() => {\n  const cells = document.querySelectorAll('td').length\n  return cells + window.counter.next\n})", 30000)
    expect(getter.text).toContain("It stopped right after `document.querySelectorAll('td')` (line 2) returned, before its next call:")
    expect(getter.text).toContain('A property read there runs a getter of the page')
    const result = await human.execute('return await readPage(() => window.counter)', 30000)
    expect(result.text).toContain('It stopped while your result was turned into data: a toJSON method or a getter of a page object in it may change something.')
    // Every run that located these was stopped by the check too: the counting getter never counted.
    const untouched = await human.execute('return await readPage(() => window.counter.seen)', 30000)
    expect(untouched.text).toContain('[return value] 0')
  })

  it('stops a function that never returns, and the page goes on', async () => {
    // Real time on purpose: the budget runs on the page's own clock (performance.now() in the page).
    const started = Date.now()
    const stuck = await human.execute("return await readPage(() => { while (!document.querySelector('.never')) {} })", 40000)
    expect(stuck.isError).toBe(true)
    expect(stuck.text).toContain('the function was still running after 5000ms and was stopped')
    expect(Date.now() - started).toBeLessThan(15000)
    const after = await human.execute('return await readPage(() => document.readyState)', 30000)
    expect(after.text).toContain('complete')
  })

  it('left the page untouched: no mutation, no storage or app-state change, no user activation', async () => {
    const debug = await open('debug')
    const writes = [
      "() => { document.querySelector('h1').remove() }",
      "() => { document.title = 'changed' }",
      "() => localStorage.setItem('cart', 'emptied')",
      '() => { window.appState.cart.push(3) }',
      "() => document.getElementById('buy').click()",
      "() => document.getElementById('buy').focus()",
    ]
    for (const write of writes) {
      const result = await debug.execute(`return await readPage(${write})`, 30000)
      expect(result.isError, write).toBe(true)
      expect(result.text, write).toContain("Chrome's side-effect check stopped the function before anything on the page changed")
    }
    await debug.execute("return await readPage(() => [document.title, ...document.querySelectorAll('td')].length)", 30000)
    expect(await pageState(debug)).toContain('{"mutations":0,"cart":"3 items","app":2,"h1":true,"active":false}')
  })
})
