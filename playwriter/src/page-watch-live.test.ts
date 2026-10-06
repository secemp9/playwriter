/**
 * Live-Chromium tests for PageWatch: the journal and the settle step against a real
 * renderer, through Playwright's OWN page session (the one the executor uses).
 *
 * What they prove, in consumer terms:
 *  - settle waits for what the action caused (a slow fetch, a POST, a debounced search that
 *    starts 300ms after the last key) and, when it cannot, names the request still open; a
 *    long-poll the page opened before the action is reported, never waited on;
 *  - waitForIdle does not return while a reply is still streaming in, also inside open and
 *    closed shadow roots;
 *  - busy comes from what the page states, not from words or class names: a nav link
 *    "Working Groups" and a progressbar standing at 45% never block, an aria-busy region,
 *    an indeterminate progressbar and an on-screen spinner do; a covered or off-screen
 *    spinner is not seen;
 *  - a clock or a timer ticking on the page does not keep an action from settling;
 *  - a toast (a newly inserted fixed overlay) shown for 250ms is reported as transient;
 *  - a POST→303→GET form submit is two records, the first a POST; a WebSocket send is
 *    journaled;
 *  - an alert the policy accepts does not stop settle, which resumes after it closed;
 *  - SPA route changes, full document loads and back/forward-cache restores are told apart,
 *    and the journal keeps working in the new document;
 *  - console errors and exceptions of the page (not of isolated worlds), HTTP 404s and
 *    network failures are attributed to the step that caused them;
 *  - the page under test gains no globals and no elements.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { once } from 'node:events'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import { DialogController } from './dialog-controller.js'
import type { IsolatedWorld } from './isolated-world.js'
import { PageFrames } from './page-frames.js'
import { PageWatch } from './page-watch.js'

function html(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  @keyframes spin { to { transform: rotate(360deg) } }
  .spinner { width: 24px; height: 24px; border: 3px solid #ccc; border-top-color: #333; border-radius: 50%; animation: spin 0.8s linear infinite; }
  .toast { position: fixed; bottom: 12px; right: 12px; padding: 8px; background: #222; color: #fff; }
</style></head><body>${body}</body></html>`
}

/** A custom element that streams 14 chunks into its shadow root, 150ms apart, once `start()` is called. */
function streamingElement(mode: 'open' | 'closed'): string {
  return `<script>
  customElements.define('chat-reply', class extends HTMLElement {
    constructor() { super(); this.root = this.attachShadow({ mode: '${mode}' }); this.root.innerHTML = '<div id="reply"></div>' }
    start() {
      var reply = this.root.getElementById('reply'), n = 0, self = this
      var timer = setInterval(function () {
        n++
        var p = document.createElement('p')
        p.textContent = 'chunk ' + n
        reply.appendChild(p)
        if (n * 150 >= 2000) { clearInterval(timer); self.setAttribute('data-done', '') }
      }, 150)
    }
  })
</script>`
}

/**
 * Fixture pages. Their scripts use real timers on purpose: what is under test is how the
 * watcher behaves against a real renderer's clock (a fetch answered after 800ms, chunks
 * every 150ms, a toast removed after 250ms); fake timers cannot exist inside Chromium.
 */
const PAGES: Record<string, string> = {
  '/static': html('static', '<main><h1>Static page</h1><p>Nothing moves here.</p><button id="noop">Noop</button></main>'),
  '/slow-fetch': html(
    'slow fetch',
    `<button id="load">Find mice</button><div id="out"></div>
<script>
  document.getElementById('load').addEventListener('click', function () {
    fetch('/api/slow').then(function (r) { return r.json() }).then(function (d) {
      document.getElementById('out').textContent = d.message
    })
  })
</script>`,
  ),
  '/hold': html(
    'held request',
    `<button id="hold">Start</button>
<script>
  document.getElementById('hold').addEventListener('click', function () { fetch('/api/hold').catch(function () {}) })
</script>`,
  ),
  '/poll': html(
    'long-poll',
    `<button id="save">Save</button><p id="out"></p>
<script>
  fetch('/api/hold').catch(function () {})
  document.getElementById('save').addEventListener('click', function () {
    fetch('/api/save', { method: 'POST', body: 'draft' }).then(function (r) { return r.json() }).then(function (d) {
      document.getElementById('out').textContent = d.message
    })
  })
</script>`,
  ),
  '/search': html(
    'debounced search',
    `<input id="q" aria-label="Search"><p id="out"></p>
<script>
  var timer
  document.getElementById('q').addEventListener('input', function (event) {
    clearTimeout(timer)
    var q = event.target.value
    timer = setTimeout(function () {
      fetch('/api/search?q=' + encodeURIComponent(q)).then(function (r) { return r.json() }).then(function (d) {
        document.getElementById('out').textContent = d.message
      })
    }, 300)
  })
</script>`,
  ),
  '/form': html('form', '<form method="post" action="/submit"><input name="title" value="Gaming mice"><button id="send">Send</button></form>'),
  '/done': html('done', '<h1>Thread created</h1>'),
  '/socket': html(
    'socket',
    `<button id="connect">Connect</button><button id="send">Send</button><p id="state"></p>
<script>
  var socket
  document.getElementById('connect').addEventListener('click', function () {
    socket = new WebSocket(location.origin.replace('http', 'ws') + '/ws')
    socket.onopen = function () { document.getElementById('state').textContent = 'connected' }
    socket.onmessage = function (event) { document.getElementById('state').textContent = 'got ' + event.data }
  })
  document.getElementById('send').addEventListener('click', function () { socket.send('hello') })
</script>`,
  ),
  '/stream': html(
    'stream',
    `<button id="ask">Ask</button><div id="reply"></div>
<script>
  document.getElementById('ask').addEventListener('click', function () {
    var reply = document.getElementById('reply'), n = 0
    var timer = setInterval(function () {
      n++
      var p = document.createElement('p')
      p.textContent = 'chunk ' + n
      reply.appendChild(p)
      if (n * 150 >= 2000) {
        clearInterval(timer)
        var done = document.createElement('p')
        done.id = 'done'
        done.textContent = 'Reply complete.'
        reply.appendChild(done)
      }
    }, 150)
  })
</script>`,
  ),
  // The element (and its open root) is created by the click, after the journal was installed.
  '/shadow-open': html(
    'open shadow',
    `<button id="ask">Ask</button><div id="slot"></div>${streamingElement('open')}
<script>
  document.getElementById('ask').addEventListener('click', function () {
    var el = document.createElement('chat-reply')
    document.getElementById('slot').appendChild(el)
    el.start()
  })
</script>`,
  ),
  // A closed root, invisible to script, attached before the watch started.
  '/shadow-closed': html(
    'closed shadow',
    `<button id="ask">Ask</button><chat-reply id="answer"></chat-reply>${streamingElement('closed')}
<script>
  document.getElementById('ask').addEventListener('click', function () { document.getElementById('answer').start() })
</script>`,
  ),
  '/calm': html(
    'calm',
    `<nav aria-label="Main"><a href="/groups">Working Groups</a> <a href="/tips">Searching tips</a></nav>
<p>Processing time: 2 days. Loading dock opens at 9.</p>
<div role="progressbar" aria-label="Course" aria-valuenow="45" aria-valuemin="0" aria-valuemax="100" style="width: 200px; height: 8px; background: #8bd"></div>
<progress value="45" max="100"></progress>
<div class="loading-spinner">Results appear here</div>`,
  ),
  '/busy': html(
    'busy',
    `<section id="results" aria-label="Search results" aria-busy="true"><p>Looking…</p></section>
<div role="progressbar" aria-label="Upload" style="width: 200px; height: 8px; background: #8bd"></div>
<div class="spinner" aria-label="Loading results"></div>
<div style="position: relative; width: 60px; height: 60px"><div class="spinner" aria-label="Covered spinner"></div><div style="position: absolute; inset: 0; background: #fff"></div></div>
<div class="spinner" aria-label="Far below" style="margin-top: 3000px"></div>`,
  ),
  '/advance': html(
    'advance',
    `<div role="progressbar" aria-label="Upload" aria-valuenow="10" aria-valuemin="0" aria-valuemax="100" style="width: 200px; height: 8px; background: #8bd"></div>
<button id="upload">Upload</button>
<script>
  document.getElementById('upload').addEventListener('click', function () {
    var bar = document.querySelector('[role=progressbar]'), v = 10
    var timer = setInterval(function () {
      v += 10
      bar.setAttribute('aria-valuenow', String(v))
      if (v >= 80) clearInterval(timer)
    }, 100)
  })
</script>`,
  ),
  '/ticker': html(
    'ticker',
    `<span id="clock"></span> <div role="timer" aria-label="Offer ends"></div>
<button id="load">Find mice</button><div id="out"></div>
<script>
  var t = 0
  setInterval(function () { t++; document.getElementById('clock').textContent = 'tick ' + t }, 200)
  setInterval(function () { document.querySelector('[role=timer]').textContent = String(Date.now()) }, 100)
  document.getElementById('load').addEventListener('click', function () {
    fetch('/api/slow').then(function (r) { return r.json() }).then(function (d) {
      document.getElementById('out').textContent = d.message
    })
  })
</script>`,
  ),
  '/toast': html(
    'toast',
    `<button id="save">Save</button>
<script>
  document.getElementById('save').addEventListener('click', function () {
    var t = document.createElement('div')
    t.className = 'toast'
    t.textContent = 'Saved!'
    document.body.appendChild(t)
    setTimeout(function () { t.remove() }, 250)
  })
</script>`,
  ),
  '/alert': html(
    'alert',
    `<button id="save">Save</button><p id="out"></p>
<script>
  document.getElementById('save').addEventListener('click', function () {
    setTimeout(function () {
      alert('Saved')
      fetch('/api/slow').then(function (r) { return r.json() }).then(function (d) {
        document.getElementById('out').textContent = 'after alert: ' + d.message
      })
    }, 100)
  })
</script>`,
  ),
  '/nav': html(
    'nav one',
    `<div id="status" role="status"></div><a id="next" href="/other">Next</a>
<script>
  window.showStatus = function (text) { document.getElementById('status').textContent = text }
</script>`,
  ),
  '/other': html(
    'nav two',
    `<h1>Second page</h1><div id="status" role="status"></div>
<script>
  window.showStatus = function (text) { document.getElementById('status').textContent = text }
</script>`,
  ),
  '/errors': html(
    'errors',
    `<button id="break">Break things</button>
<script>
  function earlyNoise() { console.error('before the checkpoint') }
  document.getElementById('break').addEventListener('click', function () {
    console.error('Save failed', { code: 500 })
    console.warn('Deprecated API')
    setTimeout(function () { throw new Error('kaboom') }, 0)
    fetch('/missing').catch(function () {})
    fetch('http://127.0.0.1:__CLOSED_PORT__/unreachable').catch(function () {})
  })
</script>`,
  ),
}

let browser: Browser
let context: BrowserContext
let server: http.Server
let sockets: WebSocketServer
let baseUrl: string
const heldResponses: http.ServerResponse[] = []
/** A port nothing listens on (bound then released), so a fetch to it is refused by the OS. */
let closedPort = 0

async function listenOnLoopback(target: http.Server): Promise<number> {
  target.listen(0, '127.0.0.1')
  await once(target, 'listening')
  const address = target.address()
  if (!address || typeof address === 'string') throw new Error('the fixture server has no TCP port')
  return address.port
}

beforeAll(async () => {
  // Real delays on purpose: settle is measured against a real renderer's clock.
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if (path === '/api/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'Three mice found' }))
      }, 800)
      return
    }
    if (path === '/api/save') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'Saved' }))
      }, 600)
      return
    }
    if (path === '/api/search') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: `Results for ${url.searchParams.get('q')}` }))
      }, 100)
      return
    }
    if (path === '/api/hold') {
      heldResponses.push(res)
      return
    }
    if (path === '/submit') {
      req.resume()
      req.on('end', () => {
        res.writeHead(303, { Location: '/done' })
        res.end()
      })
      return
    }
    const page = PAGES[path]
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page.replace('__CLOSED_PORT__', String(closedPort)))
  })
  sockets = new WebSocketServer({ server, path: '/ws' })
  sockets.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo ${String(data)}`)))
  baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`
  const probe = http.createServer()
  closedPort = await listenOnLoopback(probe)
  probe.close()
  await once(probe, 'close')
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
}, 120000)

afterAll(async () => {
  for (const res of heldResponses) res.destroy()
  await context?.close()
  await browser?.close()
  for (const client of sockets?.clients ?? []) client.terminate()
  sockets?.close()
  if (server) {
    server.close()
    await once(server, 'close')
  }
})

async function openWatched(
  path: string,
  on: BrowserContext = context,
): Promise<{ page: Page; watch: PageWatch; world: IsolatedWorld; dialogs: DialogController; errors: unknown[][] }> {
  const page = await on.newPage()
  const cdp = await getCDPSessionForPage({ page })
  const dialogs = new DialogController({ page })
  dialogs.attach()
  dialogs.bindSession(cdp)
  await page.goto(baseUrl + path)
  const frames = new PageFrames({ page, cdp })
  const errors: unknown[][] = []
  const watch = new PageWatch({
    frames,
    dialogs,
    isClosed: () => page.isClosed(),
    logger: { error: (...args: unknown[]) => errors.push(args) },
  })
  watch.start()
  // The journal is installed asynchronously by start(); one probe makes sure it is in place.
  await watch.busySignals()
  return { page, watch, world: frames.main.world, dialogs, errors }
}

describe('settle', () => {
  it('on a static page returns quiet after the quiet windows (timing reported)', async () => {
    const { page, watch } = await openWatched('/static')
    const timings: number[] = []
    for (let i = 0; i < 3; i++) {
      const result = await watch.settle()
      expect(result).toMatchObject({ settled: true, reason: 'quiet', pendingRequests: [] })
      timings.push(result.waitedMs)
    }
    console.log(`[page-watch-live] settle() on a static page (domQuiet 300 / netQuiet 500): ${timings.join(', ')} ms`)
    for (const ms of timings) {
      expect(ms).toBeGreaterThanOrEqual(500)
      expect(ms).toBeLessThan(1000)
    }
    await page.close()
  })

  it('waits for a fetch that resolves after 800ms and the text it renders', async () => {
    const { page, watch } = await openWatched('/slow-fetch')
    const cp = watch.checkpoint()
    await page.click('#load')
    const result = await watch.settle({ since: cp })
    const text = await page.textContent('#out')
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    expect(result.waitedMs).toBeGreaterThanOrEqual(700)
    expect(text).toBe('Three mice found')
    const events = await watch.since(cp)
    expect(events.network.map((r) => [new URL(r.url).pathname, r.status])).toEqual([['/api/slow', 200]])
    expect(events.mutations.content).toBeGreaterThan(0)
    const body = await watch.responseBody(events.network[0]!.id)
    expect(body).toMatchObject({ status: 200, mimeType: 'application/json', truncated: false, base64Encoded: false })
    expect(JSON.parse(body.body)).toEqual({ message: 'Three mice found' })
    await page.close()
  })

  it('times out naming the request the action started and the server holds open', async () => {
    const { page, watch } = await openWatched('/hold')
    const cp = watch.checkpoint()
    await page.click('#hold')
    const result = await watch.settle({ since: cp, timeoutMs: 1500 })
    expect(result.settled).toBe(false)
    expect(result.reason).toBe('timeout')
    expect(result.waitedMs).toBeGreaterThanOrEqual(1500)
    const held = result.pendingRequests.find((r) => r.url.endsWith('/api/hold'))
    expect(held).toMatchObject({ method: 'GET', resourceType: 'Fetch' })
    expect(held!.ageMs).toBeGreaterThan(1000)
    await page.close()
  })

  it('a long-poll opened at load does not hold a later action; the POST the action started does', async () => {
    const { page, watch } = await openWatched('/static')
    // Loaded while watched, so the journal sees the long-poll the page opens at load.
    await page.goto(baseUrl + '/poll')
    const loaded = await watch.settle()
    expect(loaded).toMatchObject({ settled: true, reason: 'quiet' })
    const cp = watch.checkpoint()
    await page.click('#save')
    const result = await watch.settle({ since: cp })
    expect(result).toMatchObject({ settled: true, reason: 'quiet', pendingRequests: [] })
    expect(result.waitedMs).toBeGreaterThanOrEqual(500)
    expect(await page.textContent('#out')).toBe('Saved')
    expect(result.uncaused?.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /api/hold'])
    const events = await watch.since(cp)
    expect(events.network.map((r) => `${r.method} ${new URL(r.url).pathname} ${r.status}`)).toEqual(['POST /api/save 200'])
    await page.close()
  })

  it('measured from the end of the last key, settle catches a search the page debounces by 300ms', async () => {
    const { page, watch } = await openWatched('/search')
    await page.focus('#q')
    const cp = watch.checkpoint()
    // Typing takes longer than the quiet windows; a settle measured from before it would return at once.
    await page.keyboard.type('mice', { delay: 200 })
    const origin = Date.now()
    const result = await watch.settle({ since: cp, origin })
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    expect(await page.textContent('#out')).toBe('Results for mice')
    const events = await watch.since(cp)
    expect(events.network.map((r) => new URL(r.url).search)).toEqual(['?q=mice'])
    await page.close()
  })

  it('a clock and a timer ticking on the page do not hold the action; they are listed as ambient', async () => {
    const { page, watch } = await openWatched('/ticker')
    // Without an action to measure against, the clock (every 200ms) never leaves 300ms of quiet.
    const unanchored = await watch.settle({ timeoutMs: 1200 })
    expect(unanchored.reason).toBe('timeout')
    expect(unanchored.domChangingIn).toMatch(/span#clock/)
    const cp = watch.checkpoint()
    await page.click('#load')
    const result = await watch.settle({ since: cp })
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    expect(await page.textContent('#out')).toBe('Three mice found')
    expect(result.ambient).toEqual(expect.arrayContaining([expect.stringMatching(/^span#clock/), expect.stringMatching(/^timer "Offer ends"/)]))
    await page.close()
  })

  it('waitForIdle returns only after streamed text stops arriving', async () => {
    const { page, watch } = await openWatched('/stream')
    await page.click('#ask')
    const result = await watch.waitForIdle({ timeoutMs: 15000 })
    const finalText = await page.textContent('#done')
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    expect(finalText).toBe('Reply complete.')
    // 2s of streaming + 1.5s of quiet.
    expect(result.waitedMs).toBeGreaterThanOrEqual(3300)
    expect(result.busy.filter((s) => s.strength === 'strong')).toEqual([])
    await page.close()
  })

  it('a settle that times out mid-stream names where content is still changing', async () => {
    const { page, watch } = await openWatched('/stream')
    await page.click('#ask')
    const result = await watch.settle({ timeoutMs: 800, domQuietMs: 1000 })
    expect(result.reason).toBe('timeout')
    expect(result.domChangingIn).toMatch(/chunk \d+/)
    expect(result.msSinceLastContentMutation).toBeLessThan(400)
    expect(result.busy.some((s) => s.kind === 'dom-streaming' && s.strength === 'strong')).toBe(true)
    await page.close()
  })

  for (const path of ['/shadow-open', '/shadow-closed']) {
    it(`content streaming inside a ${path === '/shadow-open' ? 'new open' : 'closed'} shadow root keeps settle not quiet`, async () => {
      const { page, watch } = await openWatched(path)
      const cp = watch.checkpoint()
      await page.click('#ask')
      const busy = await watch.settle({ since: cp, timeoutMs: 1000, domQuietMs: 1000 })
      expect(busy.reason).toBe('timeout')
      expect(busy.msSinceLastContentMutation).toBeLessThan(400)
      expect(busy.busy.some((s) => s.kind === 'dom-streaming' && s.strength === 'strong')).toBe(true)
      const idle = await watch.waitForIdle({ since: cp, timeoutMs: 15000 })
      expect(idle).toMatchObject({ settled: true, reason: 'quiet' })
      expect(await page.getAttribute('chat-reply', 'data-done')).toBe('')
      await page.close()
    })
  }
})

describe('busy signals', () => {
  it('words and a progressbar standing at 45% are not "busy"', async () => {
    const { page, watch } = await openWatched('/calm')
    const signals = await watch.busySignals()
    expect(signals.filter((s) => s.strength === 'strong')).toEqual([])
    expect(signals).toEqual([
      { strength: 'weak', kind: 'progressbar', label: 'progressbar "Course" 45%' },
      { strength: 'weak', kind: 'progressbar', label: 'progressbar 45%' },
    ])
    const idle = await watch.waitForIdle({ timeoutMs: 5000, quietMs: 300, networkQuietMs: 300 })
    expect(idle).toMatchObject({ settled: true, reason: 'quiet' })
    await page.close()
  })

  it('aria-busy, an indeterminate progressbar and an on-screen spinner are; covered and off-screen spinners are not seen', async () => {
    const { page, watch } = await openWatched('/busy')
    const strong = (await watch.busySignals()).filter((s) => s.strength === 'strong')
    expect(strong).toEqual([
      { strength: 'strong', kind: 'aria-busy', label: 'region "Search results" is marked busy' },
      { strength: 'strong', kind: 'progressbar', label: 'progressbar "Upload" (indeterminate)' },
      { strength: 'strong', kind: 'spinner', label: 'div.spinner "Loading results" (animation spin) repeating endlessly' },
    ])
    // A spinner that was already turning before the last action is not that action's work.
    const cp = watch.checkpoint()
    const sinceAction = await watch.busySignals({ since: cp })
    expect(sinceAction.find((s) => s.kind === 'spinner')).toEqual({
      strength: 'weak',
      kind: 'spinner',
      label: 'div.spinner "Loading results" (animation spin) repeating endlessly (already running before the action)',
    })
    const idle = await watch.waitForIdle({ timeoutMs: 1200, quietMs: 200, networkQuietMs: 200 })
    expect(idle.reason).toBe('timeout')
    expect(idle.busy.some((s) => s.kind === 'aria-busy' && s.strength === 'strong')).toBe(true)
    await page.close()
  })

  it('a determinate progressbar that advanced since the action is strong', async () => {
    const { page, watch } = await openWatched('/advance')
    const cp = watch.checkpoint()
    await page.click('#upload')
    await expect
      .poll(async () => (await watch.busySignals({ since: cp })).find((s) => s.kind === 'progressbar'))
      .toEqual({ strength: 'strong', kind: 'progressbar', label: 'progressbar "Upload" 80% (advanced since the action)' })
    expect((await watch.busySignals()).find((s) => s.kind === 'progressbar')).toEqual({ strength: 'weak', kind: 'progressbar', label: 'progressbar "Upload" 80%' })
    await page.close()
  })
})

describe('journal', () => {
  it('a toast shown for 250ms is reported as a transient overlay', async () => {
    const { page, watch } = await openWatched('/toast')
    const cp = watch.checkpoint()
    await page.click('#save')
    await watch.settle({ since: cp })
    const events = await watch.since(cp)
    expect(events.live).toHaveLength(1)
    expect(events.live[0]).toMatchObject({ role: 'overlay', text: 'Saved!', transient: true })
    expect(events.mutations.content).toBeGreaterThanOrEqual(2)
    await page.close()
  })

  it('a POST answered with 303 is journaled as a POST, and the GET it leads to as its own request', async () => {
    const { page, watch } = await openWatched('/form')
    const cp = watch.checkpoint()
    await page.click('#send')
    const settled = await watch.settle({ since: cp })
    expect(settled).toMatchObject({ settled: true, reason: 'quiet' })
    expect(await page.title()).toBe('done')
    const documents = (await watch.since(cp)).network.filter((r) => r.resourceType === 'Document')
    expect(documents.map((r) => ({ method: r.method, path: new URL(r.url).pathname, status: r.status, from: r.redirectedFrom }))).toEqual([
      { method: 'POST', path: '/submit', status: 303, from: undefined },
      { method: 'GET', path: '/done', status: 200, from: documents[0]!.id },
    ])
    expect((await watch.since(cp)).navigations.map(({ kind, url }) => [kind, new URL(url).pathname])).toEqual([['cross-document', '/done']])
    await page.close()
  })

  it('journals a WebSocket send and the reply, with the socket URL', async () => {
    const { page, watch } = await openWatched('/socket')
    await page.click('#connect')
    await expect.poll(() => page.textContent('#state')).toBe('connected')
    const cp = watch.checkpoint()
    await page.click('#send')
    await expect.poll(() => page.textContent('#state')).toBe('got echo hello')
    const frames = (await watch.since(cp)).webSockets
    expect(frames.map(({ url, direction, opcode, bytes }) => ({ url, direction, opcode, bytes }))).toEqual([
      { url: `${baseUrl.replace('http', 'ws')}/ws`, direction: 'sent', opcode: 1, bytes: 5 },
      { url: `${baseUrl.replace('http', 'ws')}/ws`, direction: 'received', opcode: 1, bytes: 10 },
    ])
    await page.close()
  })

  it('an alert the policy accepts does not stop settle; it resumes and waits for what came after', async () => {
    const { page, watch } = await openWatched('/alert')
    const cp = watch.checkpoint()
    await page.click('#save')
    const result = await watch.settle({ since: cp })
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    expect(await page.textContent('#out')).toBe('after alert: Three mice found')
    expect((await watch.since(cp)).dialogs).toEqual([expect.objectContaining({ type: 'alert', message: 'Saved', handling: 'auto', outcome: 'auto-accepted' })])
    await page.close()
  })

  it('tells pushState from a document load, and keeps journaling in the new document', async () => {
    const { page, watch } = await openWatched('/nav')
    const firstDocument = watch.documentId()
    expect(firstDocument).toEqual(expect.any(String))

    const cp0 = watch.checkpoint()
    await page.evaluate("history.pushState({}, '', '/nav/step-2'); showStatus('Draft saved')")
    await watch.settle({ since: cp0 })
    const spa = await watch.since(cp0)
    expect(spa.navigations.map(({ kind, url, navigationType }) => [kind, new URL(url).pathname, navigationType])).toEqual([
      ['same-document', '/nav/step-2', 'historyApi'],
    ])
    expect(spa.live).toEqual([expect.objectContaining({ role: 'status', text: 'Draft saved' })])
    expect(spa.live[0]!.transient).toBeUndefined()
    expect(watch.documentId()).toBe(firstDocument)

    const cp1 = watch.checkpoint()
    await page.evaluate("setTimeout(function () { location.href = '/other' }, 0)")
    const settled = await watch.settle({ since: cp1 })
    expect(settled).toMatchObject({ settled: true, reason: 'quiet' })
    expect(await page.title()).toBe('nav two')
    const full = await watch.since(cp1)
    expect(full.navigations.map(({ kind, url, navigationType }) => [kind, new URL(url).pathname, navigationType])).toEqual([
      ['cross-document', '/other', 'differentDocument'],
    ])
    expect(watch.documentId()).not.toBe(firstDocument)

    const cp2 = watch.checkpoint()
    await page.evaluate("showStatus('Welcome back')")
    await watch.settle({ since: cp2 })
    const after = await watch.since(cp2)
    expect(after.live).toEqual([expect.objectContaining({ role: 'status', text: 'Welcome back' })])
    expect(after.mutations.content).toBeGreaterThan(0)

    // The old document's status is still in the journal, and it is gone from the screen now.
    const whole = await watch.since(cp0)
    const draft = whole.live.find((r) => r.text === 'Draft saved')
    expect(draft).toMatchObject({ role: 'status', transient: true })
    await page.close()
  })

  it('attributes the page’s console errors, exceptions, a 404 and a failed request to the step that caused them', async () => {
    const { page, watch, world } = await openWatched('/errors')
    await page.evaluate('earlyNoise()')
    await watch.settle()
    const cp = watch.checkpoint()
    await page.click('#break')
    // Not the page's code: an isolated world's console is never the app's error.
    await world.evaluate("console.error('isolated world noise')")
    await watch.settle({ since: cp })
    const events = await watch.since(cp)

    const texts = events.console.map((c) => `${c.level}: ${c.text}`)
    expect(texts).not.toContain('error: before the checkpoint')
    expect(texts).not.toContain('error: isolated world noise')
    expect(texts).toContain('error: Save failed {code: 500}')
    expect(texts).toContain('warning: Deprecated API')
    expect(texts).toContain('exception: Uncaught Error: kaboom')
    const saveFailed = events.console.find((c) => c.text.startsWith('Save failed'))!
    expect(saveFailed.location).toMatch(new RegExp(`^${baseUrl}/errors:\\d+:\\d+$`))

    const failed = events.failedRequests.map((r) => ({ path: new URL(r.url).pathname, status: r.status, failed: r.failed }))
    expect(failed).toContainEqual({ path: '/missing', status: 404, failed: undefined })
    expect(failed).toContainEqual({ path: '/unreachable', status: undefined, failed: 'net::ERR_CONNECTION_REFUSED' })
    await page.close()
  })
})

describe('back/forward cache', () => {
  // Playwright launches Chromium with the cache off and its headless shell cannot use it; the
  // full Chromium build in headless mode with the default switch removed restores pages from it.
  let cachingBrowser: Browser
  let cachingContext: BrowserContext
  beforeAll(async () => {
    cachingBrowser = await chromium.launch({ headless: true, channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] })
    cachingContext = await cachingBrowser.newContext()
  }, 120000)
  afterAll(async () => {
    await cachingContext?.close()
    await cachingBrowser?.close()
  })

  it('a back navigation served from the cache is reported as restored, and the journal keeps working', async () => {
    const { page, watch } = await openWatched('/nav', cachingContext)
    const cp = watch.checkpoint()
    await page.click('#next')
    await watch.settle({ since: cp })
    expect(await page.title()).toBe('nav two')
    const back = watch.checkpoint()
    // A restore fires no load event; commit is all there is.
    await page.goBack({ waitUntil: 'commit' })
    const settled = await watch.settle({ since: back })
    expect(settled).toMatchObject({ settled: true, reason: 'quiet' })
    expect((await watch.since(back)).navigations.map(({ kind, url }) => [kind, new URL(url).pathname])).toEqual([['restored', '/nav']])
    const cp2 = watch.checkpoint()
    await page.evaluate("showStatus('Back again')")
    await watch.settle({ since: cp2 })
    expect((await watch.since(cp2)).live).toEqual([expect.objectContaining({ role: 'status', text: 'Back again' })])
    await page.close()
  })
})

describe('the page under test is not modified', () => {
  it('adds no main-world globals and no elements', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl + '/toast')
    const read = () =>
      page.evaluate<{ globals: string[]; elements: number }>(
        "({ globals: Object.getOwnPropertyNames(window).sort(), elements: document.querySelectorAll('*').length })",
      )
    const before = await read()

    const cdp = await getCDPSessionForPage({ page })
    const dialogs = new DialogController({ page })
    dialogs.attach()
    dialogs.bindSession(cdp)
    const frames = new PageFrames({ page, cdp })
    const watch = new PageWatch({ frames, dialogs, isClosed: () => page.isClosed() })
    watch.start()
    const cp = watch.checkpoint()
    await watch.settle()
    await watch.busySignals({ since: cp })
    await watch.since(cp)

    const after = await read()
    expect(after.globals).toEqual(before.globals)
    expect(after.elements).toBe(before.elements)
    // The reader exists, but only in the isolated world.
    expect(await frames.main.world.evaluate<string>('typeof globalThis.__playwriterWatch')).toBe('object')
    expect(await page.evaluate('typeof globalThis.__playwriterWatch')).toBe('undefined')
    watch.dispose()
    frames.dispose()
    await page.close()
  })
})
