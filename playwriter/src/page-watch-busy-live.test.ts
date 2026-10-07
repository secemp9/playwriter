/**
 * What counts as "still working", against a real renderer, read through Playwright's own page
 * session like the executor does:
 *  - a determinate progressbar standing still (GitHub's language bar, measured on
 *    github.com/secemp9/playwriter: four `role=progressbar` spans with a fixed aria-valuenow) is no
 *    busy signal; one whose value keeps moving is;
 *  - skeleton placeholders (content-less elements running the same shimmer, inside an aria-busy
 *    grid or side by side) are ONE signal per container, not six spinners, and the aria-busy grid
 *    reads `area "Products" [aria-busy]`;
 *  - an endless animation on something that shows text or is a control (a pulsing "LIVE" badge, a
 *    glowing button) is not a loading indicator; a turning ring still is a spinner;
 *  - settle names the loading indicators it waited through once they are gone, and waitForIdle
 *    waits for skeletons like for spinners.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { once } from 'node:events'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import { DialogController } from './dialog-controller.js'
import { PageFrames } from './page-frames.js'
import { PageWatch } from './page-watch.js'

const STYLE = `<style>
  @keyframes spin { to { transform: rotate(360deg) } }
  @keyframes shimmer { to { background-position: -200% 0 } }
  @keyframes pulse { 50% { opacity: 0.4 } }
  @keyframes glow { 50% { box-shadow: 0 0 12px #f80 } }
  .spinner { width: 24px; height: 24px; border: 3px solid #ccc; border-top-color: #333; border-radius: 50%; animation: spin 0.8s linear infinite; }
  .grid { display: grid; grid-template-columns: repeat(3, 200px); gap: 12px; }
  .skeleton { height: 120px; border-radius: 6px; background: linear-gradient(90deg, #e6e9f0 25%, #f3f5f9 50%, #e6e9f0 75%); background-size: 200% 100%; animation: shimmer 1.2s infinite; }
  .badge { display: inline-block; padding: 2px 6px; background: #c00; color: #fff; animation: pulse 1s infinite; }
  .cta { animation: glow 1.5s infinite; }
</style>`

function html(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${STYLE}</head><body>${body}</body></html>`
}

const SKELETONS = '<div class="skeleton" aria-hidden="true"></div>'.repeat(6)

/**
 * Fixture pages. Their scripts use real timers on purpose: what is under test is how the watcher
 * reads a real renderer's animations, attributes and clock; fake timers cannot exist inside Chromium.
 */
const PAGES: Record<string, string> = {
  // GitHub's language bar as measured (Primer ProgressBar items, values never change).
  '/bars': html(
    'bars',
    `<h2>Languages</h2><span style="display: flex; width: 300px; height: 8px">
<span role="progressbar" aria-label="TypeScript: 58.3%" aria-valuenow="58" aria-valuemin="0" aria-valuemax="100" style="width: 58.3%; background: #3178c6"></span>
<span role="progressbar" aria-label="HTML: 40.1%" aria-valuenow="40" aria-valuemin="0" aria-valuemax="100" style="width: 40.1%; background: #e34c26"></span>
<span role="progressbar" aria-label="MDX: 1.5%" aria-valuenow="2" aria-valuemin="0" aria-valuemax="100" style="width: 1.5%; background: #fcb32c"></span>
<span role="progressbar" aria-label="Other: 0.1%" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" style="width: 0.1%; background: #ededed"></span>
</span>`,
  ),
  '/moving': html(
    'moving',
    `<div role="progressbar" aria-label="Upload" aria-valuenow="10" aria-valuemin="0" aria-valuemax="100" style="width: 200px; height: 8px; background: #8bd"></div>
<script>
  var bar = document.querySelector('[role=progressbar]'), v = 10
  setInterval(function () { v = v >= 90 ? 10 : v + 5; bar.setAttribute('aria-valuenow', String(v)) }, 150)
</script>`,
  ),
  '/skeletons': html('skeletons', `<h1>Products</h1><div class="grid" id="products" aria-busy="true" aria-label="Products">${SKELETONS}</div>`),
  // Placeholders side by side with no aria-busy around them, and one lone shimmering bar.
  '/placeholder-list': html(
    'placeholder list',
    `<ul aria-label="Comments" class="grid">${'<li class="skeleton"></li>'.repeat(3)}</ul><div class="skeleton" style="width: 300px; height: 20px; margin-top: 20px"></div>`,
  ),
  '/ordinary': html('ordinary', `<p>Stream <span class="badge">LIVE</span></p><button class="cta">Buy now</button>`),
  '/load': html(
    'load',
    `<h1>Store</h1><button id="products-link">Products</button><main id="view"></main>
<script>
  document.getElementById('products-link').addEventListener('click', function () {
    var view = document.getElementById('view')
    view.innerHTML = '<div class="grid" id="products" aria-busy="true" aria-label="Products">${SKELETONS}</div>'
    fetch('/api/products').then(function (r) { return r.json() }).then(function (d) {
      var grid = document.getElementById('products')
      grid.replaceChildren.apply(grid, d.products.map(function (name) { var a = document.createElement('article'); a.textContent = name; return a }))
      grid.setAttribute('aria-busy', 'false')
    })
  })
</script>`,
  ),
  '/timed': html(
    'timed',
    `<button id="go">Show</button><main id="view"></main>
<script>
  document.getElementById('go').addEventListener('click', function () {
    var view = document.getElementById('view')
    view.innerHTML = '<div class="grid" id="products" aria-busy="true" aria-label="Products">${SKELETONS}</div>'
    setTimeout(function () { view.innerHTML = '<p>Six products</p>' }, 1500)
  })
</script>`,
  ),
  // The page counts every event and DOM mutation it can see, to measure what reading busy state costs it.
  '/witness': html(
    'witness',
    `<h1>Products</h1><div class="grid" aria-busy="true" aria-label="Products">${SKELETONS}</div><button class="cta">Buy now</button>
<script>
  window.seen = { events: [], mutations: 0 }
  ;['pointerover', 'pointerenter', 'pointermove', 'mouseover', 'mouseenter', 'mousemove', 'focusin', 'scroll', 'animationstart', 'animationiteration', 'transitionrun']
    .forEach(function (type) { addEventListener(type, function () { window.seen.events.push(type) }, true) })
  new MutationObserver(function (records) { window.seen.mutations += records.length }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
</script>`,
  ),
}

/** What the /witness page counted. */
interface PageSeen {
  events: string[]
  mutations: number
}

let browser: Browser
let context: BrowserContext
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/api/products') {
      // A real delay on purpose: the settle step must wait through the skeletons against a real clock.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ products: ['Mechanical Keyboard', 'Wireless Mouse', 'USB-C Hub'] }))
      }, 800)
      return
    }
    const page = PAGES[path]
    res.writeHead(page ? 200 : 404, { 'Content-Type': page ? 'text/html; charset=utf-8' : 'text/plain' })
    res.end(page ?? 'not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the fixture server has no TCP port')
  baseUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
}, 120000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
  if (server) {
    server.close()
    await once(server, 'close')
  }
})

async function openWatched(path: string): Promise<{ page: Page; watch: PageWatch }> {
  const page = await context.newPage()
  const cdp = await getCDPSessionForPage({ page })
  const dialogs = new DialogController({ page })
  dialogs.attach()
  dialogs.bindSession(cdp)
  await page.goto(baseUrl + path)
  const watch = new PageWatch({ frames: new PageFrames({ page, cdp }), dialogs, isClosed: () => page.isClosed(), logger: { error: () => {} } })
  watch.start()
  // The journal is installed asynchronously by start(); one probe makes sure it is in place.
  await watch.busySignals()
  return { page, watch }
}

describe('progressbars', () => {
  it("a determinate bar standing still (GitHub's language bar) is no busy signal", async () => {
    const { page, watch } = await openWatched('/bars')
    expect(await watch.busySignals()).toEqual([])
    expect(await watch.busySignals({ since: watch.checkpoint() })).toEqual([])
    await page.close()
  })

  it('a bar whose value keeps moving is busy without an action to measure from', async () => {
    const { page, watch } = await openWatched('/moving')
    // The journal sees a move only once one happens after it was installed (every 150ms here).
    await expect.poll(async () => (await watch.busySignals()).find((s) => s.kind === 'progressbar')?.strength).toBe('strong')
    const bar = (await watch.busySignals()).find((s) => s.kind === 'progressbar')
    expect(bar?.label).toMatch(/^progressbar "Upload" \d+% \(moving\)$/)
    await page.close()
  })
})

describe('skeletons and spinners', () => {
  it('six placeholders in an aria-busy grid are one skeleton signal, and the grid reads [aria-busy]', async () => {
    const { page, watch } = await openWatched('/skeletons')
    expect(await watch.busySignals()).toEqual([
      { strength: 'strong', kind: 'aria-busy', label: 'area "Products" [aria-busy]' },
      { strength: 'strong', kind: 'skeleton', label: '6 skeleton placeholders (animation shimmer) in area "Products"' },
    ])
    // Already shown before the action: reported, not that action's work.
    expect((await watch.busySignals({ since: watch.checkpoint() })).find((s) => s.kind === 'skeleton')).toEqual({
      strength: 'weak',
      kind: 'skeleton',
      label: '6 skeleton placeholders (animation shimmer) in area "Products" (already shown before the action)',
    })
    await page.close()
  })

  it('placeholders side by side are skeletons without aria-busy; a lone content-less shimmer stays a spinner', async () => {
    const { page, watch } = await openWatched('/placeholder-list')
    expect(await watch.busySignals()).toEqual([
      { strength: 'strong', kind: 'spinner', label: 'div.skeleton (animation shimmer) repeating endlessly' },
      { strength: 'strong', kind: 'skeleton', label: '3 skeleton placeholders (animation shimmer) in list "Comments"' },
    ])
    await page.close()
  })

  it('an endless animation on text or a control is not a loading indicator', async () => {
    const { page, watch } = await openWatched('/ordinary')
    expect(await watch.busySignals()).toEqual([])
    await page.close()
  })
})

describe('settle and idle', () => {
  it('settle names the aria-busy grid and the skeletons it waited through once they are gone', async () => {
    const { page, watch } = await openWatched('/load')
    const cp = watch.checkpoint()
    await page.click('#products-link')
    const result = await watch.settle({ since: cp })
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    // settle does not read busy signals (the after-picture does): none is claimed.
    expect(result.busy).toBeUndefined()
    expect(await watch.busySignals({ since: cp })).toEqual([])
    const seen = result.busyWhileSettling ?? []
    expect(seen.map((s) => s.label)).toEqual(['area "Products" [aria-busy]', '6 skeleton placeholders (animation shimmer) in area "Products"'])
    for (const s of seen) expect(s.seenMs).toBeGreaterThanOrEqual(500)
    await page.close()
  })

  it('waitForIdle waits for skeletons the action brought up; settle reports them as strong busy', async () => {
    const { page, watch } = await openWatched('/timed')
    const cp = watch.checkpoint()
    await page.click('#go')
    const settled = await watch.settle({ since: cp })
    expect(settled.busy).toBeUndefined()
    expect((await watch.busySignals({ since: cp })).filter((s) => s.strength === 'strong').map((s) => s.kind)).toEqual(['aria-busy', 'skeleton'])
    const idle = await watch.waitForIdle({ since: cp, quietMs: 300, networkQuietMs: 300, timeoutMs: 8000 })
    expect(idle).toMatchObject({ settled: true, reason: 'quiet', busy: [] })
    expect(await page.textContent('#view')).toBe('Six products')
    await page.close()
  })

  it('reading busy state and settling fire no event and change nothing on the page', async () => {
    const { page, watch } = await openWatched('/witness')
    // The page's own animation events before the reads are not the reads' doing.
    await page.evaluate('window.seen.events.length = 0')
    for (let i = 0; i < 3; i++) await watch.busySignals()
    await watch.settle({ timeoutMs: 1500, domQuietMs: 200, networkQuietMs: 200 })
    const seen = await page.evaluate<PageSeen>('window.seen')
    // Only the page's own shimmer iterations (1.2s period) may have fired meanwhile.
    expect(seen.events.filter((type) => type !== 'animationiteration')).toEqual([])
    expect(seen.mutations).toBe(0)
    await page.close()
  })
})
