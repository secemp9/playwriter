/**
 * capture-page-fixture.ts — turns a live web page into a committed, hermetic HTML fixture.
 *
 * WHY THIS EXISTS
 *
 * Two suites used to point a real browser at real websites to exercise the aria snapshot and
 * the aria ref-label overlay:
 *
 *   - src/relay-core.test.ts  "should get accessibility snapshot of <site>"
 *   - src/snapshot-tools.test.ts  "should show aria ref labels on real pages and save screenshots"
 *
 * They were not testing the websites, they were testing what our code does with a DOM that
 * hand-written test HTML does not produce: hundreds of nodes, deep nesting, nested layout
 * tables, dozens of same-named links that force `>> nth=` disambiguation, elements whose
 * accessible name comes from a title/alt rather than text. That is real coverage, and it is
 * why the answer to "the test times out on the live internet" is not "delete the test".
 *
 * So the pages are captured once, here, and committed. The fixture is the POST-LOAD, rendered
 * DOM — not the server's HTML — because that is what the accessibility tree is computed from.
 *
 * WHAT "HERMETIC" MEANS HERE, AND WHY IT IS ENFORCED RATHER THAN INTENDED
 *
 * A fixture that still pulls one stylesheet from a CDN is worse than the live test it replaced:
 * it looks deterministic and is not. So every outbound reference is neutralised at capture time
 * (stylesheets inlined, scripts dropped, images and CSS url() replaced with a 1x1 data URI,
 * <base>/<link>/<iframe>/CSP meta removed), and then the result is REPLAYED from a local server
 * through a route interceptor that aborts anything not local. If a single external request is
 * attempted, the capture fails and writes nothing. The committed file is therefore proven, not
 * asserted.
 *
 * WHAT IS DELIBERATELY PRESERVED
 *
 *   - Every element and every attribute that can contribute to an accessible name or role:
 *     alt, title, aria-*, role, href, placeholder, label association, table structure.
 *   - Image geometry: each <img> gets explicit width/height attributes taken from its rendered
 *     box before its src is neutralised, so replacing the bytes with a 1x1 pixel cannot collapse
 *     a laid-out box to nothing and silently drop nodes from the accessibility tree.
 *   - All CSS, inlined. Layout decides which nodes are ignored by the accessibility tree
 *     (display:none, visibility:hidden, zero-size boxes), so dropping the CSS would not have
 *     produced a smaller fixture, it would have produced a DIFFERENT tree.
 *
 * WHAT IS DELIBERATELY DROPPED
 *
 *   - <script>. The DOM is captured after the page's own scripts have run, so re-running them
 *     against a server that has none of their endpoints could only rewrite the DOM into
 *     something the capture never saw.
 *
 * USAGE
 *
 *   bun scripts/capture-page-fixture.ts                 # recapture every fixture below
 *   bun scripts/capture-page-fixture.ts hacker-news     # recapture one, by name
 *
 * Regenerating a fixture WILL change the aria snapshots the tests pin
 * (src/snapshots/<name>-accessibility-{interactive,full}.md). Delete those files and re-run the
 * suite so vitest writes them fresh — never `pnpm test`, which is `vitest run -u` and would
 * rewrite unrelated inline snapshots at the same time.
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from '@xmorse/playwright-core'
import type { APIRequestContext, Page } from '@xmorse/playwright-core'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 1x1 fully transparent GIF. Stands in for every image byte the fixture must not fetch. */
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

type FixtureSpec = {
  /** Fixture name; the file is written to src/assets/fixture-<name>.html. */
  name: string
  url: string
  /**
   * Selectors that must be present before the DOM is serialised. These are the same waits the
   * tests used to do against the live site: a capture taken before them would freeze a
   * half-rendered page into the fixture and quietly shrink the tree under test.
   */
  waitForSelectors: string[]
}

/**
 * The four fixtures, and what each one is for.
 *
 * "Representative" is not a feeling here: `describeFixtureShape` below is run on the live page
 * and again on the replayed fixture, and the capture prints both. The numbers quoted per spec
 * are those measurements, so a future regeneration that quietly captures a stub instead of the
 * page is visible immediately.
 */
const FIXTURE_SPECS: readonly FixtureSpec[] = [
  {
    // relay-core.test.ts's aria-snapshot case. An item page rather than the front page: it adds
    // a nested comment tree, which is where the deep layouttable nesting and the repeated
    // author/date links that need `>> nth=` disambiguation come from.
    name: 'hacker-news-item',
    url: 'https://news.ycombinator.com/item?id=1',
    waitForSelectors: ['a[href="news"]', 'a.hnuser'],
  },
  {
    // snapshot-tools.test.ts's ref-label case. The front page, for ref DENSITY: ~30 stories,
    // each with an upvote arrow, a title link, a domain link, an author link, a date link and a
    // comments link. Measured: 227 links, and the overlay places 101 label boxes in a 1280x720
    // viewport.
    name: 'hacker-news',
    url: 'https://news.ycombinator.com/',
    waitForSelectors: ['a[href="news"]', 'span.titleline'],
  },
  {
    // relay-core.test.ts's second aria-snapshot case. A modern framework page (Next.js, RSC,
    // Tailwind), a completely different tree shape from Hacker News's table markup. Measured:
    // 1520 elements, 23 deep, 154 interactive, 96 aria-* attributes, and controls (switch,
    // radio, checkbox, combobox) whose accessible name exists only as an aria-label.
    name: 'shadcn-ui',
    url: 'https://ui.shadcn.com/',
    waitForSelectors: ['h1', 'a[href="/blocks"]'],
  },
  {
    // snapshot-tools.test.ts's second ref-label case. This slot used to be
    // https://old.reddit.com/, and it is worth writing down why it is not any more: headless
    // Chromium gets a 17-element bot-check stub from old.reddit.com, not the site. That is not
    // new — the live test was already "passing" on it, with `expect(labelCount)
    // .toBeGreaterThan(0)` reporting success on THREE labels for a page that should produce
    // hundreds. A Wikipedia article serves the same purpose and serves it to everybody.
    // Measured: 4049 elements, 31 deep, 1256 interactive, 775 distinct accessible names with 132
    // of them repeated, 21 tables — denser than old.reddit.com ever was here.
    name: 'wikipedia',
    url: 'https://en.wikipedia.org/wiki/Web_browser',
    waitForSelectors: ['#firstHeading', '#bodyContent a'],
  },
]

function fixturePath(name: string): string {
  return path.join(PACKAGE_ROOT, 'src', 'assets', `fixture-${name}.html`)
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * Replace every `url(...)` in a stylesheet with a 1x1 transparent pixel.
 *
 * Backgrounds and borders never size their box, so this cannot change layout — but a
 * protocol-relative `url(//cdn.example.com/sprite.png)` in an inlined stylesheet absolutely
 * would reach the internet, which is the whole thing this file exists to prevent.
 */
function neutraliseCssUrls(css: string): string {
  return css.replace(/url\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\s*\)/gi, (match) => {
    // `url(#some-svg-filter)` is a same-document reference, not a fetch. Keep it.
    if (/url\(\s*['"]?#/.test(match)) {
      return match
    }
    if (match.includes('data:')) {
      return match
    }
    return `url("${TRANSPARENT_PIXEL}")`
  })
}

/** Resolve `@import` chains by fetching them, so no import survives to be fetched at test time. */
async function inlineCssImports({
  css,
  baseUrl,
  request,
  depth,
}: {
  css: string
  baseUrl: string
  request: APIRequestContext
  depth: number
}): Promise<string> {
  const importPattern = /@import\s+(?:url\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*))\s*\)|'([^']*)'|"([^"]*)")[^;]*;/gi
  const matches = [...css.matchAll(importPattern)]
  if (matches.length === 0) {
    return css
  }

  let result = css
  for (const match of matches) {
    const href = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim()
    let replacement = ''
    if (href && depth > 0) {
      const absolute = new URL(href, baseUrl).toString()
      const imported = await fetchCss({ url: absolute, request, depth: depth - 1 })
      replacement = imported ?? ''
    }
    result = result.replace(match[0], replacement)
  }
  return result
}

async function fetchCss({
  url,
  request,
  depth,
}: {
  url: string
  request: APIRequestContext
  depth: number
}): Promise<string | null> {
  if (url.startsWith('data:')) {
    return null
  }
  try {
    const response = await request.get(url, { timeout: 30000 })
    if (!response.ok()) {
      return null
    }
    const raw = await response.text()
    const withImports = await inlineCssImports({ css: raw, baseUrl: url, request, depth })
    return neutraliseCssUrls(withImports)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// DOM surgery, in the page
// ---------------------------------------------------------------------------

type StylesheetToInline = { href: string; index: number }

/** Tag every stylesheet link so Node can fetch it and hand the text back by index. */
async function collectStylesheetLinks(page: Page): Promise<StylesheetToInline[]> {
  return await page.evaluate(() => {
    const links = [...document.querySelectorAll('link')].filter((link) => {
      const rel = (link.getAttribute('rel') || '').toLowerCase()
      return rel.split(/\s+/).includes('stylesheet') && !!link.getAttribute('href')
    })
    return links.map((link, index) => {
      link.setAttribute('data-fixture-sheet', String(index))
      return { href: (link as HTMLLinkElement).href, index }
    })
  })
}

async function applyInlinedStylesheets(page: Page, sheets: Array<{ index: number; css: string | null }>) {
  await page.evaluate((entries) => {
    for (const { index, css } of entries) {
      const link = document.querySelector(`link[data-fixture-sheet="${index}"]`)
      if (!link) {
        continue
      }
      if (css === null) {
        link.remove()
        continue
      }
      const style = document.createElement('style')
      style.textContent = css
      link.replaceWith(style)
    }
  }, sheets)
}

/**
 * Everything that would otherwise cause a network request at test time, removed in one pass.
 * Runs after the stylesheets have already been inlined.
 */
async function neutraliseDocument(page: Page, transparentPixel: string): Promise<Record<string, number>> {
  return await page.evaluate((pixel) => {
    const counts: Record<string, number> = {
      scriptsRemoved: 0,
      linksRemoved: 0,
      imagesNeutralised: 0,
      iframesBlanked: 0,
      inlineStyleUrlsRewritten: 0,
      mediaNeutralised: 0,
      basesRemoved: 0,
      metasRemoved: 0,
    }

    const rewriteInlineUrls = (value: string): string =>
      value.replace(/url\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\s*\)/gi, (match) => {
        if (/url\(\s*['"]?#/.test(match) || match.includes('data:')) {
          return match
        }
        return `url("${pixel}")`
      })

    for (const script of [...document.querySelectorAll('script')]) {
      script.remove()
      counts.scriptsRemoved += 1
    }
    for (const noscript of [...document.querySelectorAll('noscript')]) {
      // <noscript> content is inert while scripting is enabled but becomes live markup once the
      // scripts are gone — including <img src> and <iframe src> pointing at trackers.
      noscript.remove()
    }
    for (const base of [...document.querySelectorAll('base')]) {
      base.remove()
      counts.basesRemoved += 1
    }
    for (const link of [...document.querySelectorAll('link')]) {
      // Every stylesheet has already become a <style>; whatever is left is preload / prefetch /
      // preconnect / icon / manifest / alternate, all of which fetch.
      link.remove()
      counts.linksRemoved += 1
    }
    for (const meta of [...document.querySelectorAll('meta')]) {
      const equiv = (meta.getAttribute('http-equiv') || '').toLowerCase()
      if (equiv === 'content-security-policy' || equiv === 'refresh') {
        meta.remove()
        counts.metasRemoved += 1
      }
    }

    for (const img of [...document.querySelectorAll('img')]) {
      // Freeze the rendered box BEFORE swapping in a 1x1 pixel. Without this an image sized by
      // its intrinsic dimensions collapses, its box goes to zero, and the accessibility tree
      // silently loses the node — the fixture would still "work" and would test less.
      const rect = img.getBoundingClientRect()
      if (rect.width > 0 && !img.hasAttribute('width')) {
        img.setAttribute('width', String(Math.round(rect.width)))
      }
      if (rect.height > 0 && !img.hasAttribute('height')) {
        img.setAttribute('height', String(Math.round(rect.height)))
      }
      img.removeAttribute('srcset')
      img.removeAttribute('loading')
      img.setAttribute('src', pixel)
      counts.imagesNeutralised += 1
    }
    for (const source of [...document.querySelectorAll('picture source, video source, audio source')]) {
      source.remove()
    }
    for (const media of [...document.querySelectorAll('video, audio')]) {
      media.removeAttribute('src')
      media.removeAttribute('poster')
      media.removeAttribute('autoplay')
      counts.mediaNeutralised += 1
    }
    for (const image of [...document.querySelectorAll('svg image')]) {
      image.remove()
    }
    for (const frame of [...document.querySelectorAll('iframe, frame, embed, object')]) {
      frame.removeAttribute('srcdoc')
      frame.removeAttribute('data')
      frame.setAttribute('src', 'about:blank')
      counts.iframesBlanked += 1
    }
    for (const element of [...document.querySelectorAll('[style*="url("]')]) {
      const style = element.getAttribute('style') || ''
      const rewritten = rewriteInlineUrls(style)
      if (rewritten !== style) {
        element.setAttribute('style', rewritten)
        counts.inlineStyleUrlsRewritten += 1
      }
    }
    for (const element of [...document.querySelectorAll('[background]')]) {
      element.removeAttribute('background')
    }
    for (const style of [...document.querySelectorAll('style')]) {
      const text = style.textContent || ''
      const rewritten = rewriteInlineUrls(text)
      if (rewritten !== text) {
        style.textContent = rewritten
      }
    }

    return counts
  }, transparentPixel)
}

// ---------------------------------------------------------------------------
// Structural description — how we know a fixture still carries the coverage
// ---------------------------------------------------------------------------

type FixtureShape = {
  elements: number
  maxDepth: number
  /** Elements with an ARIA-relevant role source: links, buttons, inputs, [role]. */
  interactiveCandidates: number
  /** Distinct accessible-name-ish strings on those candidates, i.e. how many refs must be unique. */
  distinctInteractiveNames: number
  /** Repeated names are what force `>> nth=` disambiguation in the snapshot. */
  duplicateInteractiveNames: number
  tables: number
  images: number
  headings: number
  ariaAttributes: number
  shadowRoots: number
}

/**
 * Measured on the LIVE page and again on the REPLAYED fixture. Printing both is what makes
 * "is this fixture still representative?" a question with an answer instead of a hope.
 */
async function describeFixtureShape(page: Page): Promise<FixtureShape> {
  return await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')]
    let maxDepth = 0
    for (const element of all) {
      let depth = 0
      let node: Element | null = element
      while (node) {
        depth += 1
        node = node.parentElement
      }
      if (depth > maxDepth) {
        maxDepth = depth
      }
    }

    const candidates = [...document.querySelectorAll('a[href], button, input, select, textarea, [role], summary')]
    const names = candidates.map((element) => {
      const label =
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        (element.textContent || '').trim().slice(0, 80)
      return label
    })
    const seen = new Map<string, number>()
    for (const name of names) {
      seen.set(name, (seen.get(name) ?? 0) + 1)
    }

    let ariaAttributes = 0
    for (const element of all) {
      for (const attribute of element.getAttributeNames()) {
        if (attribute.startsWith('aria-')) {
          ariaAttributes += 1
        }
      }
    }

    return {
      elements: all.length,
      maxDepth,
      interactiveCandidates: candidates.length,
      distinctInteractiveNames: seen.size,
      duplicateInteractiveNames: [...seen.values()].filter((count) => count > 1).length,
      tables: document.querySelectorAll('table').length,
      images: document.querySelectorAll('img').length,
      headings: document.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
      ariaAttributes,
      shadowRoots: all.filter((element) => !!element.shadowRoot).length,
    }
  })
}

// ---------------------------------------------------------------------------
// Local replay server + hermeticity proof
// ---------------------------------------------------------------------------

type ReplayServer = { baseUrl: string; close: () => Promise<void> }

async function startReplayServer(html: string): Promise<ReplayServer> {
  const sockets = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    if ((req.url || '/') === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind replay server')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

/**
 * Same rule as `isLocalOrInertRequestUrl` in src/test-utils.ts, which the two suites apply to
 * every request the fixtures make at test time. Duplicated rather than imported because
 * test-utils pulls in the whole relay server, and this script must not need one.
 */
function isLocalOrInertUrl(url: string, baseUrl: string): boolean {
  return (
    url.startsWith(baseUrl) ||
    url.startsWith('data:') ||
    url.startsWith('about:') ||
    url.startsWith('blob:') ||
    url.startsWith('chrome-extension://')
  )
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Wait until the DOM stops changing.
 *
 * Client-rendered pages server-render placeholders and swap them for real content on hydrate —
 * ui.shadcn.com ships over 300 `[data-slot="skeleton"]` divs that only become components once
 * React runs. Serialising before that produces a fixture full of empty boxes: it would still
 * load, still snapshot, and would have thrown away exactly the complicated subtree the fixture
 * exists to provide. Waiting for a stable element count is page-agnostic, where waiting for a
 * particular selector to disappear would be one more site-specific detail to rot.
 */
async function waitForDomToSettle(
  page: Page,
  { stableSamples = 3, intervalMs = 1000, maxMs = 45000 } = {},
): Promise<number> {
  const deadline = Date.now() + maxMs
  let previous = -1
  let stable = 0
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => document.querySelectorAll('*').length)
    stable = count === previous ? stable + 1 : 0
    previous = count
    if (stable >= stableSamples) {
      return count
    }
    await page.waitForTimeout(intervalMs)
  }
  console.log(`  (DOM never settled within ${maxMs}ms; capturing at ${previous} elements)`)
  return previous
}

async function captureOne(spec: FixtureSpec): Promise<void> {
  console.log(`\n=== ${spec.name} — ${spec.url} ===`)
  const browser = await chromium.launch({ channel: 'chromium', headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(90000)
    page.setDefaultTimeout(60000)

    await page.goto(spec.url, { waitUntil: 'load' })
    for (const selector of spec.waitForSelectors) {
      await page.locator(selector).first().waitFor({ state: 'attached', timeout: 60000 })
    }
    // The fixture is the rendered DOM, so what has not rendered yet is what the fixture would
    // be missing.
    const settledElements = await waitForDomToSettle(page)
    console.log(`settled at:       ${settledElements} elements`)

    const liveShape = await describeFixtureShape(page)
    console.log('live shape:      ', JSON.stringify(liveShape))

    const sheets = await collectStylesheetLinks(page)
    console.log(`stylesheets:      ${sheets.length}`)
    const fetched = await Promise.all(
      sheets.map(async ({ href, index }) => ({
        index,
        css: await fetchCss({ url: href, request: context.request, depth: 3 }),
      })),
    )
    const failed = fetched.filter((entry) => entry.css === null).length
    if (failed > 0) {
      console.log(`  (${failed} stylesheet(s) could not be fetched and were dropped)`)
    }
    await applyInlinedStylesheets(page, fetched)

    const counts = await neutraliseDocument(page, TRANSPARENT_PIXEL)
    console.log('neutralised:     ', JSON.stringify(counts))

    const html = await page.evaluate(() => `<!doctype html>\n${document.documentElement.outerHTML}\n`)
    await context.close()

    // --- proof of hermeticity: replay it and abort anything that is not local -----------
    const replay = await startReplayServer(html)
    const verifyContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const external: string[] = []
    await verifyContext.route('**/*', async (route) => {
      const url = route.request().url()
      if (isLocalOrInertUrl(url, replay.baseUrl)) {
        await route.continue()
        return
      }
      external.push(url)
      await route.abort()
    })
    const verifyPage = await verifyContext.newPage()
    await verifyPage.goto(replay.baseUrl, { waitUntil: 'load' })
    await verifyPage.waitForTimeout(2000)
    const replayShape = await describeFixtureShape(verifyPage)
    console.log('replayed shape:  ', JSON.stringify(replayShape))
    await verifyContext.close()
    await replay.close()

    if (external.length > 0) {
      throw new Error(
        `fixture ${spec.name} is not hermetic — ${external.length} external request(s) attempted:\n` +
          [...new Set(external)]
            .slice(0, 20)
            .map((url) => `  ${url}`)
            .join('\n'),
      )
    }

    const target = fixturePath(spec.name)
    fs.writeFileSync(target, html, 'utf-8')
    console.log(`wrote ${path.relative(PACKAGE_ROOT, target)} (${(html.length / 1024).toFixed(1)} KiB, hermetic)`)
  } finally {
    await browser.close()
  }
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2)
  const specs = requested.length > 0 ? FIXTURE_SPECS.filter((spec) => requested.includes(spec.name)) : FIXTURE_SPECS
  if (specs.length === 0) {
    throw new Error(`no fixture matches ${requested.join(', ')}; known: ${FIXTURE_SPECS.map((s) => s.name).join(', ')}`)
  }
  for (const spec of specs) {
    await captureOne(spec)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
