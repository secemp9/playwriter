/**
 * Live-Chromium tests for observePage: what a text-only model is told about a real page.
 *
 * One inline fixture covers every perception claim the observation makes — element
 * states, typed and masked values, in-view vs below vs clipped-in-a-scroll-container,
 * partial cover by a fixed widget, a modal that covers the page, a `<div>` whose only
 * affordance is a click listener, image load state, duplicate controls told apart by
 * their row, ref stability across a DOM insertion, and the diff after a human action.
 * Plain headless Chromium, no extension: the same CDP calls the relay forwards.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Dialog, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import type { ICDPSession } from './cdp-session.js'
import type { IsolatedWorld } from './isolated-world.js'
import { PageFrames } from './page-frames.js'
import { RefRegistry } from './ref-registry.js'
import {
  observePage,
  renderObservation,
  diffObservations,
  renderObservationDiff,
  findInObservation,
  liveContext,
  type Observation,
  type ObservedElement,
} from './page-observe.js'
import { readPageFixture } from './test-utils.js'

const HUMAN_SHOP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'human-shop')

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="teal"/></svg>'

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Observe fixture</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  header { height: 40px; }
  main { padding: 4px; }
  h1 { margin: 4px 0; font-size: 20px; }
  p { margin: 4px 0; }
  .card { width: 220px; height: 30px; background: #ddd; cursor: pointer; }
  table { border-collapse: collapse; }
  #scroller { height: 40px; width: 300px; overflow: auto; border: 1px solid #999; }
  #scroller .spacer { height: 60px; }
  #tall { height: 2000px; }
  #checkout { position: fixed; right: 100px; bottom: 60px; width: 200px; height: 40px; }
  #chat-widget { position: fixed; right: 0; bottom: 0; width: 200px; height: 120px; background: #eef; }
  #backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: none; }
  #dialog { position: fixed; top: 120px; left: 300px; width: 320px; padding: 12px; background: white; display: none; }
  body.modal-open #backdrop, body.modal-open #dialog { display: block; }
  .ring-row { position: relative; display: inline-block; width: 30px; height: 30px; }
  .ring { position: absolute; inset: 0; border: 3px solid #333; border-radius: 50%; box-sizing: border-box; }
  .drawn { position: absolute; inset: 0; margin: 0; width: 30px; height: 30px; opacity: 0; }
</style></head>
<body>
<header><nav aria-label="Main"><a href="/">Home</a> <a href="/cart">Cart</a></nav></header>
<main>
  <h1>Results</h1>
  <p id="intro">Showing 2 results for mice</p>
  <label><input type="checkbox" id="instock" checked> In stock only</label>
  <label><input type="checkbox" id="sale"> On sale</label>
  <button disabled>Disabled action</button>
  <button id="sort" aria-expanded="false">Sort</button>
  <button style="opacity: 0">Ghost</button>
  <span class="ring-row"><span class="ring"></span><input type="checkbox" class="drawn" aria-label="Drawn toggle"></span>
  <br>
  <input aria-label="Search products" id="search">
  <input type="password" aria-label="Password" id="pw">
  <div class="card" id="card">Free shipping over $50</div>
  <img alt="Broken photo" src="/missing.png" width="40" height="40">
  <img alt="Logo" src="/logo.svg">
  <table>
    <tr><td>Alice</td><td><button>Edit</button></td></tr>
    <tr><td>Bob</td><td><button>Edit</button></td></tr>
  </table>
  <div id="scroller"><div class="spacer"></div><button>Deep button</button></div>
  <button id="checkout">Checkout</button>
  <div id="tall"></div>
  <button>Footer action</button>
</main>
<div id="chat-widget">Chat with us</div>
<div id="backdrop"></div>
<div id="dialog" role="dialog" aria-modal="true" aria-label="Cookie consent"><p>We use cookies</p><button>Accept all</button></div>
<script>
  document.getElementById('card').addEventListener('click', function () { this.dataset.clicked = '1' })
</script>
</body></html>`

const LONG_TEXT =
  'The Logitech M185 is a compact wireless mouse with a USB nano receiver and a battery life of about twelve months; ' +
  'it works with Windows, macOS and ChromeOS out of the box. Today it costs $14.99 and ships tomorrow.'

const FIELDS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fields</title>
<style>body { font: 14px sans-serif; } .pin { -webkit-text-security: disc; } label { display: block; margin: 4px; }</style></head>
<body><form>
  <label>Arrival <input type="date" id="arrival" value="2024-05-01" min="2024-01-01" max="2024-12-31"></label>
  <label>Meeting <input type="datetime-local" id="meeting"></label>
  <label>Alarm <input type="time" id="alarm"></label>
  <label>Colour <input type="color" id="colour" value="#336699"></label>
  <label>Card code <input type="tel" class="pin" id="cvc"></label>
  <label>One-time code <input type="text" autocomplete="one-time-code" id="otp"></label>
  <label>Email <input type="email" id="email" aria-invalid="true" aria-errormessage="email-error" placeholder="you@example.com"></label>
  <p id="email-error">Enter a valid email address</p>
  <label>Notes <textarea id="notes"></textarea></label>
  <p>${LONG_TEXT}</p>
</form></body></html>`

const MENUS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Menus</title><style>body { font: 14px sans-serif; }</style></head>
<body>
  <button id="file" aria-expanded="true" aria-controls="file-menu">File</button>
  <ul id="file-menu" role="menu"><li role="menuitem">Rename</li><li role="menuitem">Duplicate</li></ul>
  <button id="row">Row to delete</button>
  <button>Behind the dialog</button>
  <p>Text behind the dialog</p>
  <dialog id="settings"><p>Settings</p><button>Close settings</button></dialog>
</body></html>`

// Wikipedia's appearance menu: unnamed forms of label-named radios under plain-text captions,
// with "Standard" in both; and todo rows whose checkbox label is what tells the rows apart.
const GROUPS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Groups</title><style>body { font: 14px sans-serif; }</style></head>
<body>
  <nav aria-label="Appearance">
    <div>Text</div>
    <ul><li><form>
      <input type="radio" name="size" id="size-small"><label for="size-small">Small</label>
      <input type="radio" name="size" id="size-standard" checked><label for="size-standard">Standard</label>
      <input type="radio" name="size" id="size-large"><label for="size-large">Large</label>
    </form></li></ul>
    <div>Width</div>
    <ul><li><form>
      <input type="radio" name="width" id="width-standard" checked><label for="width-standard">Standard</label>
      <input type="radio" name="width" id="width-wide"><label for="width-wide">Wide</label>
    </form></li></ul>
  </nav>
  <ul aria-label="Todos">
    <li><label><input type="checkbox"> Buy milk</label> <button>Delete</button></li>
    <li><label><input type="checkbox"> Call mum</label> <button>Delete</button></li>
  </ul>
</body></html>`

let browser: Browser
let context: BrowserContext
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/logo.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      res.end(LOGO_SVG)
      return
    }
    if (url.startsWith('/fixture/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(readPageFixture(url.slice('/fixture/'.length)))
      return
    }
    if (url.startsWith('/human-shop/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(path.join(HUMAN_SHOP_DIR, url.slice('/human-shop/'.length)), 'utf-8'))
      return
    }
    if (url === '/fields') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(FIELDS_HTML)
      return
    }
    if (url === '/groups') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(GROUPS_HTML)
      return
    }
    if (url === '/menus') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(MENUS_HTML)
      return
    }
    if (url === '/' || url === '/cart') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(FIXTURE_HTML)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('fixture server has no TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1000, height: 600 } })
}, 120000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
  await new Promise<void>((r) => server?.close(() => r()))
})

interface Observer {
  page: Page
  cdp: ICDPSession
  frames: PageFrames
  world: IsolatedWorld
  registry: RefRegistry
  targetId: string
  /** An observation shown to the model (as observe() is), classifying what vanished since `previous`. */
  observe: (previous?: Observation | null) => Promise<Observation>
}

async function openObserver(path: string): Promise<Observer> {
  const page = await context.newPage()
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'load' })
  const cdp = await getCDPSessionForPage({ page })
  const frames = new PageFrames({ page, cdp })
  const world = frames.main.world
  const registry = new RefRegistry()
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  const targetId = targetInfo.targetId
  return {
    page,
    cdp,
    frames,
    world,
    registry,
    targetId,
    observe: (previous) => observePage({ page, frames, registry, targetId, shown: true, previous: previous ?? null }),
  }
}

function only(obs: Observation, role: string, name: string): ObservedElement {
  const found = obs.elements.filter((e) => e.role === role && e.name === name)
  expect(found, `${role} "${name}" in ${obs.elements.map((e) => `${e.role} "${e.name}"`).join(', ')}`).toHaveLength(1)
  return found[0]
}

describe('observePage on a live page', () => {
  let observer: Observer

  beforeAll(async () => {
    observer = await openObserver('/')
    await observer.page.locator('#search').fill('wireless mouse')
    await observer.page.locator('#pw').fill('hunter2')
    await observer.page.locator('#search').focus()
  }, 60000)

  afterAll(async () => {
    observer?.world.dispose()
    await observer?.page.close()
  })

  it('reports states, values, visibility, clickables, images and duplicates', async () => {
    const obs = await observer.observe()
    const text = renderObservation(obs)

    expect(only(obs, 'checkbox', 'In stock only').states?.checked).toBe(true)
    expect(only(obs, 'checkbox', 'On sale').states?.checked).toBe(false)
    expect(only(obs, 'button', 'Disabled action').states?.disabled).toBe(true)
    expect(only(obs, 'button', 'Sort').states?.expanded).toBe(false)
    const search = only(obs, 'textbox', 'Search products')
    expect(search.states?.focused).toBe(true)
    expect(search.value).toBe('wireless mouse')
    expect(obs.focused).toBe(search.ref)
    expect(only(obs, 'textbox', 'Password').value).toBe('••••')
    expect(JSON.stringify(obs)).not.toContain('hunter2')

    expect(only(obs, 'button', 'Sort').visibility).toBe('in-view')
    expect(only(obs, 'button', 'Footer action').visibility).toBe('below')
    expect(only(obs, 'button', 'Deep button').visibility).toBe('clipped')
    expect(only(obs, 'button', 'Ghost').visibility).toBe('hidden')
    // Both are opacity 0; only the one with a look drawn where it sits is something a person sees.
    const drawn = only(obs, 'checkbox', 'Drawn toggle')
    expect(drawn.visibility).toBe('in-view')
    expect(drawn.transparent).toBe(true)

    const checkout = only(obs, 'button', 'Checkout')
    expect(checkout.visibility).toBe('partly-covered')
    expect(checkout.coveredBy).toBe('div#chat-widget')
    expect(checkout.coveredFraction).toBeCloseTo(0.5, 1)

    const card = only(obs, 'clickable', 'Free shipping over $50')
    expect(card.cssLabel).toBe('div#card.card')
    expect(card.visibility).toBe('in-view')

    const broken = obs.elements.find((e) => e.name === 'Broken photo')!
    expect(broken.image).toMatchObject({ loaded: false, broken: true, naturalWidth: 0 })
    const logo = obs.elements.find((e) => e.name === 'Logo')!
    expect(logo.image).toMatchObject({ loaded: true, broken: false, naturalWidth: 30, naturalHeight: 20 })

    const edits = obs.elements.filter((e) => e.role === 'button' && e.name === 'Edit')
    expect(edits.map((e) => e.context)).toEqual(['in row "Alice"', 'in row "Bob"'])
    expect(only(obs, 'link', 'Home').region).toBe('navigation "Main"')
    expect(only(obs, 'button', 'Sort').region).toBe('main')
    expect(obs.text.find((t) => t.role === 'heading')).toMatchObject({ text: 'Results', level: 1, visibility: 'in-view' })
    expect(obs.text.some((t) => t.text === 'Showing 2 results for mice')).toBe(true)
    expect(obs.counts.below).toBeGreaterThanOrEqual(1)
    expect(obs.scroll?.screensBelow).toBeGreaterThan(2)
    // The 40px box with taller content is a scroll area of its own, with a ref.
    const deep = only(obs, 'button', 'Deep button')
    const scroller = obs.scrollers.find((candidate) => candidate.ref === deep.scroller)
    expect(scroller).toMatchObject({ role: 'scroll area', name: 'div#scroller', scrollTop: 0 })

    expect(text).toContain(`FOCUS [${search.ref}] textbox "Search products" [focused] = "wireless mouse"`)
    expect(text).toContain(`[${checkout.ref}] button "Checkout" partly covered by div#chat-widget (50%)`)
    expect(text).toContain(`[${card.ref}] clickable div#card.card "Free shipping over $50"`)
    expect(text).toContain('"Broken photo" BROKEN (did not load)')
    expect(text).toContain('[checked]')
    expect(text).toContain('[unchecked]')
    expect(text).toContain('[collapsed]')
    expect(text).toContain('(in row "Alice")')
    expect(text).toMatch(/BELOW {2}\d+ more controls?/)
    expect(text).toMatch(/INSIDE \[\d+\] scroll area "div#scroller" — top, [\d.]+ screens below: 1 more control and 0 text blocks out of sight/)
    expect(text).not.toContain('Footer action')
    expect(text.length).toBeLessThanOrEqual(6000)

    const found = findInObservation(obs, 'footer')
    expect(found).toContain('button "Footer action"')
    expect(found).toContain('below,')
    expect(found).toContain('(scroll down)')
  }, 60000)

  it('keeps refs stable across an insertion above, and diffs a human action', async () => {
    const first = await observer.observe()
    const sortRef = only(first, 'button', 'Sort').ref
    const checkoutRef = only(first, 'button', 'Checkout').ref

    await observer.page.evaluate(() => {
      const promo = document.createElement('button')
      promo.textContent = 'New promo'
      document.querySelector('main')!.prepend(promo)
    })
    const second = await observer.observe(first)
    expect(only(second, 'button', 'Sort').ref).toBe(sortRef)
    expect(only(second, 'button', 'Checkout').ref).toBe(checkoutRef)
    const promo = only(second, 'button', 'New promo')
    expect(promo.isNew).toBe(true)
    expect(Math.max(...first.elements.map((e) => e.ref))).toBeLessThan(promo.ref)
    expect(only(second, 'button', 'Sort').isNew).toBeUndefined()

    await observer.page.locator('#sale').click()
    // What the app does when its menu opens: flip aria-expanded and add a line of text.
    await observer.page.evaluate(() => {
      document.getElementById('sort')!.setAttribute('aria-expanded', 'true')
      const p = document.createElement('p')
      p.textContent = 'Order confirmed: 2 items'
      document.getElementById('intro')!.after(p)
    })
    const third = await observer.observe(second)
    const diff = diffObservations(second, third)
    expect(diff.newDocument).toBe(false)
    expect(diff.changed.map((c) => [c.element.name, c.changes])).toContainEqual([
      'On sale',
      [{ kind: 'states', from: '[unchecked]', to: '[checked]' }],
    ])
    expect(diff.textAdded.map((t) => t.text)).toContain('Order confirmed: 2 items')
    const rendered = renderObservationDiff(diff)
    expect(rendered).toContain('checkbox "On sale": [unchecked] → [checked]')
    expect(rendered).toContain('button "Sort": [collapsed] → [expanded]')
    expect(rendered).toContain('+ text: "Order confirmed: 2 items"')
    expect(rendered).toMatch(/FOCUS \[\d+\] textbox "Search products" → \[\d+\] checkbox "On sale"/)

    await observer.page.evaluate(() => document.getElementById('sort')!.setAttribute('aria-expanded', 'false'))
    const fourth = await observer.observe(third)
    expect(renderObservationDiff(diffObservations(third, fourth))).toContain('button "Sort": [expanded] → [collapsed]')
    expect(renderObservationDiff(diffObservations(fourth, await observer.observe(fourth)))).toBe('')
  }, 60000)

  it('reports a modal, the controls it covers, and the controls inside it', async () => {
    await observer.page.evaluate(() => document.body.classList.add('modal-open'))
    try {
      const obs = await observer.observe()
      expect(obs.modal).toMatchObject({ role: 'dialog', name: 'Cookie consent' })
      expect(obs.modal?.ref).toBeTypeOf('number')
      const accept = only(obs, 'button', 'Accept all')
      expect(accept.inModal).toBe(true)
      expect(accept.region).toBe('dialog "Cookie consent"')
      const sort = only(obs, 'button', 'Sort')
      expect(sort.inModal).toBeUndefined()
      expect(sort.visibility).toBe('covered')
      expect(only(obs, 'link', 'Home').visibility).toBe('covered')
      // The modal's own backdrop is listed with a ref, and what it covers names it.
      const backdrop = obs.elements.find((element) => element.role === 'backdrop')!
      expect(backdrop).toMatchObject({ backdropOf: 'dialog "Cookie consent"', cssLabel: 'div#backdrop' })
      expect(only(obs, 'link', 'Home').coveredBy).toBe(`the backdrop [${backdrop.ref}] of dialog "Cookie consent"`)

      const text = renderObservation(obs)
      expect(text).toContain(`MODAL dialog "Cookie consent" [${obs.modal?.ref}] — only its controls work right now:`)
      // Its controls were display:none in the last observation the model read: new to it now.
      expect(text).toContain(`  *[${accept.ref}] button "Accept all"`)
      expect(text).toContain(`[${sort.ref}] button "Sort" [collapsed] (behind the modal)`)
      expect(text.indexOf('Accept all')).toBeLessThan(text.indexOf('IN VIEW'))

      const scoped = renderObservation(obs, { scope: obs.modal!.ref })
      expect(scoped).toContain('Accept all')
      expect(scoped).toContain('We use cookies')
      expect(scoped).not.toContain('"Sort"')
    } finally {
      await observer.page.evaluate(() => document.body.classList.remove('modal-open'))
    }
  }, 60000)

  it('does not probe the page while a native dialog is open', async () => {
    const opened = observer.page.waitForEvent('dialog')
    // In-page timer, not a test wait: `confirm()` blocks the renderer, so it must run
    // after this evaluate has returned or the evaluate itself would never resolve.
    await observer.page.evaluate("setTimeout(() => confirm('Delete everything?'), 0)")
    const dialog: Dialog = await opened
    try {
      const startedAt = Date.now()
      const obs = await observePage({
        page: observer.page,
        frames: observer.frames,
        registry: observer.registry,
        targetId: observer.targetId,
        shown: true,
        jsDialog: { type: 'confirm', message: 'Delete everything?', openedAt: Date.now(), handling: 'agent' },
      })
      expect(Date.now() - startedAt).toBeLessThan(500)
      expect(obs.elements).toEqual([])
      expect(obs.documentId).toBe(observer.registry.documentId(observer.targetId))
      // Nothing it could not read is made up.
      expect(obs.title).toBeUndefined()
      expect(obs.viewport).toBeUndefined()
      expect(obs.scroll).toBeUndefined()
      const text = renderObservation(obs)
      expect(text).toContain('DIALOG native confirm "Delete everything?"')
      expect(text).toContain('act.dialog.accept()')
    } finally {
      await dialog.dismiss()
    }
  }, 60000)

  it('retires refs as navigated after a new document', async () => {
    const before = await observer.observe()
    const sortRef = only(before, 'button', 'Sort').ref
    await observer.page.goto(`${baseUrl}/cart`, { waitUntil: 'load' })
    const after = await observer.observe(before)
    expect(after.documentId).not.toBe(before.documentId)
    const resolution = observer.registry.resolve(sortRef)
    expect(resolution).toMatchObject({ ok: false, reason: 'navigated' })
    expect(only(after, 'button', 'Sort').ref).not.toBe(sortRef)
    expect(renderObservationDiff(diffObservations(before, after))).toMatch(/^NEW DOCUMENT "Observe fixture" · http:\/\/127\.0\.0\.1:\d+\/cart/)
  }, 60000)
})

describe('observePage: live regions, long text, scroll areas, fields, hidden and inert controls', () => {
  const opened: Observer[] = []
  const open = async (path: string): Promise<Observer> => {
    const observer = await openObserver(path)
    opened.push(observer)
    return observer
  }
  afterAll(async () => {
    for (const observer of opened) {
      observer.world.dispose()
      await observer.page.close()
    }
  })

  it('keeps a chat log as body text and reports the new reply in the diff', async () => {
    const chat = await open('/human-shop/chat.html')
    const before = await chat.observe()
    expect(before.text.map((block) => block.text)).toContain('Assistant: Let me check the warehouse for you.')
    expect(before.live).toMatchObject([{ role: 'log', name: 'Conversation', latest: 'Assistant: Let me check the warehouse for you.' }])

    await chat.page.locator('#message').fill('Thanks!')
    await chat.page.locator('button').click()
    await chat.page.waitForFunction(() => document.getElementById('log')!.textContent!.includes('ships tomorrow'))
    const after = await chat.observe(before)
    const reply = 'Assistant: Yes — the M185 ships tomorrow from the Lyon warehouse.'
    expect(after.text.find((block) => block.text === reply)).toMatchObject({ live: 'log "Conversation"', isNew: true })
    expect(renderObservation(after)).toContain(`LIVE  log "Conversation" — latest: "${reply}"`)
    const diff = renderObservationDiff(diffObservations(before, after))
    expect(diff).toContain(`+ text: "You: Thanks!" — in live region log "Conversation"`)
    expect(diff).toContain(`+ text: "${reply}" — in live region log "Conversation"`)
  }, 60000)

  it('finds text past what is printed, and prints it cut with how much is left', async () => {
    const fields = await open('/fields')
    const obs = await fields.observe()
    const block = obs.text.find((candidate) => candidate.text.startsWith('The Logitech M185'))!
    expect(block.text).toBe(LONG_TEXT)
    expect(renderObservation(obs)).toContain(`text: "${LONG_TEXT.slice(0, 159)}…" (+${LONG_TEXT.length - 159} chars)`)
    expect(findInObservation(obs, '$14.99')).toMatch(/^1 match for "\$14\.99":\n {2}text: \(\d+ chars before\) "….*costs \$14\.99 and ships tomorrow\." — in view/)
  }, 60000)

  it('lists date, time and colour inputs with what they take, and masks secrets drawn as bullets', async () => {
    const fields = await open('/fields')
    await fields.page.locator('#cvc').fill('123')
    await fields.page.locator('#otp').fill('481516')
    const obs = await fields.observe()
    const arrival = only(obs, 'date', 'Arrival')
    expect(arrival.widget).toMatchObject({ type: 'date', min: '2024-01-01', max: '2024-12-31' })
    expect(only(obs, 'datetime', 'Meeting').widget?.type).toBe('datetime-local')
    expect(only(obs, 'inputtime', 'Alarm').widget?.type).toBe('time')
    expect(only(obs, 'colorwell', 'Colour').widget?.type).toBe('color')
    expect(only(obs, 'textbox', 'Card code').value).toBe('••••')
    expect(only(obs, 'textbox', 'One-time code').value).toBe('••••')
    expect(JSON.stringify(obs)).not.toContain('481516')
    expect(JSON.stringify(obs)).not.toMatch(/"value":"123"/)
    const email = only(obs, 'textbox', 'Email')
    expect(email.errorText).toBe('Enter a valid email address')
    expect(only(obs, 'textbox', 'Notes').states?.multiline).toBe(true)
    const text = renderObservation(obs)
    expect(text).toContain(`[${arrival.ref}] date "Arrival"`)
    expect(text).toContain(`(takes YYYY-MM-DD: act.fill(${arrival.ref}, "YYYY-MM-DD"))`)
    expect(text).toContain('error "Enter a valid email address"')
    expect(text).toContain('placeholder "you@example.com"')
  }, 60000)

  it("tells repeated controls apart by the caption above their group, not a sibling option's label", async () => {
    const groups = await open('/groups')
    const obs = await groups.observe()
    const standards = obs.elements.filter((element) => element.role === 'radio' && element.name === 'Standard')
    expect(standards.map((element) => element.context)).toEqual(['after "Text"', 'after "Width"'])
    // Act compares the context the model was shown with the live one of the same kind.
    expect(liveContext(obs, standards[0].ref, 'after "Text"')).toBe('after "Text"')
    const deletes = obs.elements.filter((element) => element.role === 'button' && element.name === 'Delete')
    expect(deletes.map((element) => element.context)).toEqual(['in listitem "Buy milk"', 'in listitem "Call mum"'])
    // A label's words are its control's name, printed on the control's line, not again as prose;
    // the list's own name ("Todos") is listed as the list's line.
    expect(obs.text.map((block) => `${block.role} ${block.text}`)).toEqual(['text Text', 'text Width', 'list Todos'])
    const text = renderObservation(obs)
    expect(text).toContain(`[${standards[1].ref}] radio "Standard" [checked] (after "Width")`)
    expect(text).toContain(`[${only(obs, 'checkbox', 'Buy milk').ref}] checkbox "Buy milk" [unchecked]`)
  }, 60000)

  it('lists an app-shell scroller with its own position, and reports when it scrolls', async () => {
    const shell = await open('/human-shop/app-shell.html')
    const before = await shell.observe()
    expect(before.scroll?.maxY).toBe(0)
    expect(before.scrollers).toHaveLength(1)
    const inbox = before.scrollers[0]
    expect(inbox).toMatchObject({ role: 'main', name: 'Messages', scrollTop: 0 })
    expect(inbox.screensBelow).toBeGreaterThan(2)
    const mail40 = only(before, 'link', 'Mail 40 — weekly report')
    expect(mail40.scroller).toBe(inbox.ref)
    const text = renderObservation(before)
    expect(text).toContain('· the page itself does not scroll')
    expect(text).toContain(`SCROLL [${inbox.ref}] main "Messages" — top,`)
    expect(text).toMatch(new RegExp(`INSIDE \\[${inbox.ref}\\] main "Messages" — top, [\\d.]+ screens below: \\d+ more controls and \\d+ text blocks? out of sight — act\\.scroll\\('down', \\{ ref: ${inbox.ref} \\}\\)`))
    expect(text).not.toContain('BELOW')
    expect(text).not.toContain('whole page fits')

    await shell.page.mouse.move(600, 300)
    await shell.page.mouse.wheel(0, 900)
    await shell.page.waitForFunction(() => document.getElementById('inbox')!.scrollTop >= 900)
    const after = await shell.observe(before)
    expect(after.scrollers[0].scrollTop).toBeGreaterThanOrEqual(900)
    expect(renderObservationDiff(diffObservations(before, after))).toMatch(new RegExp(`^SCROLL \\[${inbox.ref}\\] main "Messages" 0 → \\d+px \\(now [\\d.]+ screens above, [\\d.]+ below\\)`))
  }, 60000)

  it('tells hidden and inert controls from removed ones, and names the fix', async () => {
    const menus = await open('/menus')
    const first = await menus.observe()
    const file = only(first, 'button', 'File')
    const rename = only(first, 'menuitem', 'Rename')
    const behind = only(first, 'button', 'Behind the dialog')
    const row = only(first, 'button', 'Row to delete')

    await menus.page.evaluate(() => {
      document.getElementById('file-menu')!.hidden = true
      document.getElementById('file')!.setAttribute('aria-expanded', 'false')
    })
    const collapsed = await menus.observe(first)
    expect(menus.registry.resolve(rename.ref)).toMatchObject({
      ok: false,
      reason: 'hidden',
      error: `Ref [${rename.ref}] (menuitem "Rename") is still on the page but hidden right now: its button [${file.ref}] "File" is collapsed — open it first (act.click(${file.ref}))`,
    })
    expect(renderObservationDiff(diffObservations(first, collapsed))).toContain(
      `~ [${rename.ref}] menuitem "Rename": now hidden: its button [${file.ref}] "File" is collapsed — open it first (act.click(${file.ref}))`,
    )

    // One action removes a row and opens a modal dialog: the row is gone, the rest is inert.
    await menus.page.evaluate("document.getElementById('row').remove(); document.getElementById('settings').showModal()")
    const modal = await menus.observe(collapsed)
    expect(modal.modal).toMatchObject({ role: 'dialog' })
    const opened = diffObservations(collapsed, modal)
    expect(opened.removed.map((element) => element.ref)).toEqual([row.ref])
    expect(opened.behindModal).toBeGreaterThanOrEqual(3)
    expect(menus.registry.resolve(behind.ref)).toMatchObject({ ok: false, reason: 'inert' })
    expect(menus.registry.resolve(row.ref)).toMatchObject({ ok: false, reason: 'gone' })
    expect(renderObservationDiff(opened)).toContain(`- [${row.ref}] button "Row to delete" (gone)`)

    // Closing it brings the rest back (counted) and lists what is genuinely new.
    await menus.page.evaluate(
      "document.getElementById('settings').close(); const added = document.createElement('button'); added.textContent = 'Restored row'; document.body.append(added)",
    )
    const closed = await menus.observe(modal)
    const back = diffObservations(modal, closed)
    expect(back.backFromModal).toBeGreaterThanOrEqual(3)
    expect(back.added.map((element) => element.name)).toEqual(['Restored row'])
    expect(menus.registry.resolve(behind.ref)).toMatchObject({ ok: true })
  }, 60000)
})

describe('observePage cost on the committed page fixtures', () => {
  for (const fixture of ['hacker-news-item', 'shadcn-ui']) {
    it(`observes ${fixture} and renders within budget`, async () => {
      const observer = await openObserver(`/fixture/${fixture}`)
      try {
        await observer.observe()
        const timings: number[] = []
        let obs: Observation | undefined
        for (let i = 0; i < 3; i++) {
          const startedAt = performance.now()
          obs = await observer.observe(obs)
          timings.push(Math.round(performance.now() - startedAt))
        }
        const text = renderObservation(obs!)
        console.log(
          `[observe timing] ${fixture}: ${timings.join(' / ')} ms (warm) · ${obs!.elements.length} elements, ` +
            `${obs!.text.length} text blocks · render ${text.length} chars`,
        )
        expect(obs!.elements.length).toBeGreaterThan(20)
        expect(text.length).toBeLessThanOrEqual(6000)
        expect(text.split('\n').at(-1)).not.toBe('')
      } finally {
        observer.world.dispose()
        await observer.page.close()
      }
    }, 120000)
  }
})
