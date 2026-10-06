/**
 * page-markdown: the outline/filter views on markdown samples, and getPageMarkdown on a
 * real headless Chromium — the source line, article rendered with its headings, the views,
 * the diff baseline, hidden content left out, shadow content read, iframes (same-origin and
 * out-of-process) read in place, and every document left untouched (everything runs in the
 * frames' isolated worlds, built here the way PageProbes builds them).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import { PageFrames } from './page-frames.js'
import {
  extractMarkdownOutline,
  filterMarkdownSections,
  getPageMarkdown,
  type MarkdownDiffStore,
  type PageMarkdownRequest,
} from './page-markdown.js'

const SAMPLE = [
  '# Shop',
  '',
  'Intro text.',
  '',
  '## Reviews',
  '',
  'Great mouse.',
  '',
  '### Verified reviews',
  '',
  'Five stars.',
  '',
  '## Shipping',
  '',
  '```sh',
  '# not a heading, a shell comment',
  '```',
  '',
  'Ships in 2 days.',
].join('\n')

describe('extractMarkdownOutline', () => {
  it('keeps heading lines with their levels and skips fenced code', () => {
    expect(extractMarkdownOutline(SAMPLE)).toBe('# Shop\n## Reviews\n### Verified reviews\n## Shipping')
  })

  it('is empty when there are no headings', () => {
    expect(extractMarkdownOutline('just text\nmore text')).toBe('')
  })
})

describe('filterMarkdownSections', () => {
  it('keeps a matching section with its sub-sections, up to the next same-level heading', () => {
    expect(filterMarkdownSections(SAMPLE, 'reviews')).toBe('## Reviews\n\nGreat mouse.\n\n### Verified reviews\n\nFive stars.')
  })

  it('matches case-insensitively on the heading only, not on body text', () => {
    expect(filterMarkdownSections(SAMPLE, 'VERIFIED')).toBe('### Verified reviews\n\nFive stars.')
    expect(filterMarkdownSections(SAMPLE, 'stars')).toBe('')
  })

  it('does not end a section at a `#` line inside a code fence', () => {
    expect(filterMarkdownSections(SAMPLE, 'shipping')).toBe(
      '## Shipping\n\n```sh\n# not a heading, a shell comment\n```\n\nShips in 2 days.',
    )
  })

  it('returns the input unchanged for a blank filter', () => {
    expect(filterMarkdownSections(SAMPLE, '  ')).toBe(SAMPLE)
  })
})

const PARAGRAPH =
  'The Logitech M185 is a compact wireless mouse that pairs through a tiny USB receiver and runs for a full year on a single AA battery, which is why it keeps showing up on office desks everywhere.'

function articleHtml(extraSection: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mouse review</title>
  <style>.hidden { display: none }</style></head>
<body>
  <nav><a href="/">Home</a> <a href="/shop">Shop</a></nav>
  <article>
    <h1>Mouse review</h1>
    <p>${PARAGRAPH}</p>
    <p>${PARAGRAPH}</p>
    <h2>Design</h2>
    <p>${PARAGRAPH}</p>
    <ul><li>Ambidextrous shape</li><li>Three buttons</li></ul>
    <h2>Battery life</h2>
    <p>${PARAGRAPH}</p>
    <h3>Measured runtime</h3>
    <p>${PARAGRAPH}</p>
    <pre># a comment inside code
print("hi")</pre>
    ${extraSection}
  </article>
</body></html>`
}

/** Pages that embed frames need the server's port: `localhost` is a different origin from `127.0.0.1`. */
function pages(port: number): Record<string, string> {
  return {
    '/article': articleHtml(''),
    '/article-updated': articleHtml(`<h2>Verdict</h2><p>${PARAGRAPH} Buy it.</p>`),
    // Readability's own visibility test sees only inline style and the hidden attribute; these are hidden by layout.
    '/article-hidden': articleHtml(`
      <div role="tablist"><button role="tab" aria-selected="true">Specs</button><button role="tab">Warranty</button></div>
      <div role="tabpanel"><p>${PARAGRAPH} Specs panel.</p></div>
      <div role="tabpanel" hidden><p>${PARAGRAPH} Warranty panel secret.</p></div>
      <div class="hidden error"><p>Payment failed: your card was declined. ${PARAGRAPH}</p></div>`),
    '/plain': `<!doctype html><html><head><title>Status</title><style>.hidden { display: none }</style></head><body>
    <h1>Order status</h1>
    <p>Shipped</p>
    <div style="display:none">secret hidden note</div>
    <p style="visibility:hidden">invisible text <span style="visibility:visible">but this span shows</span></p>
    <ol><li>Packed</li><li>Sent</li></ol>
    <div role="tabpanel">Tracking panel</div>
    <div role="tabpanel" hidden>Returns panel secret</div>
    <div class="hidden" role="alert">Error template secret</div>
    <template><p>Template secret</p></template>
    <details><summary>Delivery notes</summary>Loose details secret<p>Details paragraph secret</p></details>
    <order-card><span slot="carrier">Carrier: DHL</span><span>Unslotted light secret</span></order-card>
    <iframe title="Secure card payment" src="http://localhost:${port}/frame"></iframe>
    <iframe title="Shipping map" src="/frame"></iframe>
    <iframe title="Hidden tracker" src="/frame" style="display:none"></iframe>
    <script>
      customElements.define('order-card', class extends HTMLElement {
        constructor() {
          super()
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<h2>Shadow heading</h2><p>Shadow paragraph</p><p hidden>Shadow hidden secret</p>' +
            '<p><slot name="carrier">Carrier fallback</slot></p><p><slot name="eta">ETA: tomorrow</slot></p>'
        }
      })
    </script>
  </body></html>`,
    '/frame': '<!doctype html><html><body><p>Frame body secret</p></body></html>',
    '/many': `<!doctype html><html><head><title>Rows</title></head><body>${Array.from({ length: 30 }, (_, index) => `<p>Row ${index + 1} match</p>`).join('')}</body></html>`,
    // Closed roots: script cannot reach them; their text must still come out at the host's place.
    '/closed': `<!doctype html><html><head><title>Closed roots</title></head><body>
    <h1>Shadow page</h1>
    <p>Before the hosts</p>
    <open-card></open-card>
    <closed-card><span slot="note">Slotted into closed</span><span>Unslotted closed secret</span></closed-card>
    <p>Between the hosts</p>
    <input value="Input value secret">
    <iframe title="Same origin closed" src="/closed-frame"></iframe>
    <p>After the frame</p>
    <script>
      customElements.define('open-card', class extends HTMLElement {
        constructor() {
          super()
          this.attachShadow({ mode: 'open' }).innerHTML = '<p>Open root text</p>'
        }
      })
      customElements.define('closed-card', class extends HTMLElement {
        constructor() {
          super()
          this.attachShadow({ mode: 'closed' }).innerHTML =
            '<article><h2>Closed heading</h2><p>Closed article paragraph</p><p hidden>Closed hidden secret</p>' +
            '<p><slot name="note">Closed slot fallback secret</slot></p><nested-card></nested-card>' +
            '<iframe title="Frame in closed root" src="/frame"></iframe></article>'
        }
      })
      customElements.define('nested-card', class extends HTMLElement {
        constructor() {
          super()
          this.attachShadow({ mode: 'closed' }).innerHTML = '<p>Nested closed text</p>'
        }
      })
    </script>
  </body></html>`,
    '/closed-frame': `<!doctype html><html><body><p>Frame light text</p><frame-card></frame-card>
    <script>
      customElements.define('frame-card', class extends HTMLElement {
        constructor() {
          super()
          this.attachShadow({ mode: 'closed' }).innerHTML = '<p>Frame closed text</p>'
        }
      })
    </script></body></html>`,
    '/closed-article': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mouse review</title></head><body>
    <news-story></news-story>
    <script>
      customElements.define('news-story', class extends HTMLElement {
        constructor() {
          super()
          this.attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(
            `<article><h1>Mouse review</h1><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p><h2>Design</h2><p>${PARAGRAPH}</p>` +
              `<h2>Battery life</h2><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p></article>`,
          )}
        }
      })
    </script></body></html>`,
  }
}

let browser: Browser
let server: http.Server
let port: number
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const html = pages(port)[req.url ?? '']
    res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html ?? 'not found')
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(`the test server has no TCP address: ${address}`)
  port = address.port
  baseUrl = `http://127.0.0.1:${port}`
  browser = await chromium.launch({ headless: true })
}, 120000)

afterAll(async () => {
  await browser?.close()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
})

interface OpenedPage {
  page: Page
  /** getPageMarkdown on this page, through frames built like PageProbes builds them. */
  read(request?: PageMarkdownRequest): Promise<string>
}

async function openPage(path: string, diffStore: MarkdownDiffStore = new WeakMap()): Promise<OpenedPage> {
  const page = await browser.newPage()
  await page.goto(`${baseUrl}${path}`)
  const cdp = await getCDPSessionForPage({ page })
  const frames = new PageFrames({ page, cdp })
  page.once('close', () => frames.dispose())
  return { page, read: (request = {}) => getPageMarkdown({ ...request, page, frames, diffStore }) }
}

const SOURCE_ARTICLE = /^source: article — (\d+) words \(visible page: (\d+) words\)\n\n/

describe('getPageMarkdown (live Chromium)', () => {
  it('renders the article with headings, lists and code under its source line, without touching the page', async () => {
    const { page, read } = await openPage('/article')
    const before = await page.evaluate(() => document.documentElement.outerHTML)
    const markdown = await read()
    const source = SOURCE_ARTICLE.exec(markdown)
    expect(source).not.toBeNull()
    // On screen but outside the article: the nav ("Home Shop") and the <h1> Readability lifts out as the title.
    expect(Number(source?.[2])).toBe(Number(source?.[1]) + 4)
    const content = markdown.slice(source?.[0].length)
    expect(content.startsWith('# Mouse review')).toBe(true)
    expect(content).toContain('## Design')
    expect(content).toContain('## Battery life')
    expect(content).toContain('### Measured runtime')
    expect(content).toContain('- Ambidextrous shape\n- Three buttons')
    expect(content).toContain('```\n# a comment inside code\nprint("hi")\n```')
    expect(content).not.toContain('Home')
    // Readability ran in an isolated world: the page's own realm has no trace of it, and its DOM is as it was.
    expect(await page.evaluate(() => '__readability' in globalThis)).toBe(false)
    expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before)
    await page.close()
  })

  it('leaves a hidden tab panel and a display:none error template out of the article', async () => {
    const { page, read } = await openPage('/article-hidden')
    const markdown = await read()
    expect(markdown).toMatch(SOURCE_ARTICLE)
    expect(markdown).toContain('Specs panel.')
    expect(markdown).not.toContain('Warranty panel secret')
    expect(markdown).not.toContain('Payment failed')
    await page.close()
  })

  it('outline and filter are views of the same content', async () => {
    const { page, read } = await openPage('/article')
    const outline = await read({ outline: true })
    expect(outline).toMatch(SOURCE_ARTICLE)
    expect(outline.replace(SOURCE_ARTICLE, '')).toBe('# Mouse review\n## Design\n## Battery life\n### Measured runtime')
    const battery = (await read({ filter: 'battery' })).replace(SOURCE_ARTICLE, '')
    expect(battery.startsWith('## Battery life')).toBe(true)
    expect(battery).toContain('### Measured runtime')
    expect(battery).toContain('# a comment inside code')
    expect(battery).not.toContain('## Design')
    const none = (await read({ filter: 'warranty' })).replace(SOURCE_ARTICLE, '')
    expect(none).toBe('No section heading contains "warranty". Use outline: true to list the headings.')
    await page.close()
  })

  it('keeps the diff baseline when asked for diffs: unchanged → no changes, changed → a diff with the new section', async () => {
    const { page, read } = await openPage('/article')
    const noChanges = 'No changes since last call. Use showDiffSinceLastCall: false to see full content.'
    expect(await read()).toContain('## Battery life')
    // Full content by default: a second call is the whole article again, not a diff.
    expect(await read()).toContain('## Battery life')
    expect((await read({ showDiffSinceLastCall: true })).replace(SOURCE_ARTICLE, '')).toBe(noChanges)
    await page.goto(`${baseUrl}/article-updated`)
    expect(await read({ showDiffSinceLastCall: true })).toContain('+## Verdict')
    // A view request does not diff by default, and diffs the view when asked to.
    expect(await read({ outline: true })).toContain('## Verdict')
    expect((await read({ outline: true, showDiffSinceLastCall: true })).replace(SOURCE_ARTICLE, '')).toBe(noChanges)
    await page.close()
  })

  it('renders the visible page when there is no article: hidden content out, shadow content in, iframes read in place', async () => {
    const { page, read } = await openPage('/plain')
    // The page and its three frames: the out-of-process localhost one, the same-origin one and the hidden one.
    expect(page.frames()).toHaveLength(4)
    const before = await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.documentElement.outerHTML)))
    const markdown = await read()
    expect(markdown.split('\n')[0]).toMatch(
      /^source: visible page — \d+ words \(no article: Readability does not judge the visible page to be an article\)$/,
    )
    expect(markdown).toContain('# Order status')
    expect(markdown).toContain('Shipped')
    expect(markdown).toContain('1. Packed\n2. Sent')
    expect(markdown).toContain('Tracking panel')
    expect(markdown).toContain('but this span shows')
    expect(markdown).toContain('Delivery notes')
    // Open shadow root, slotted light content and slot fallback, in flat-tree order.
    expect(markdown).toContain('## Shadow heading\n\nShadow paragraph\n\nCarrier: DHL\n\nETA: tomorrow')
    // Each frame read by its own world, inline at its <iframe>, in page order; the hidden one left out.
    expect(markdown).toContain(
      '[iframe "Secure card payment"]\n\nFrame body secret\n\n[end of iframe "Secure card payment"]\n\n' +
        '[iframe "Shipping map"]\n\nFrame body secret\n\n[end of iframe "Shipping map"]',
    )
    for (const hidden of [
      'secret hidden note',
      'invisible text',
      'Returns panel secret',
      'Error template secret',
      'Template secret',
      'Loose details secret',
      'Details paragraph secret',
      'Unslotted light secret',
      'Carrier fallback',
      'Shadow hidden secret',
      'Hidden tracker',
    ]) {
      expect(markdown).not.toContain(hidden)
    }
    const search = await read({ search: /packed/i })
    expect(search).toContain('1. Packed')
    expect(await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.documentElement.outerHTML)))).toEqual(before)
    expect(await Promise.all(page.frames().map((frame) => frame.evaluate(() => '__readability' in globalThis)))).toEqual([false, false, false, false])
    await page.close()
  })

  it('search says how many matching lines it did not show', async () => {
    const { page, read } = await openPage('/many')
    // A /g regex too: its lastIndex must not make every other line miss.
    const search = await read({ search: /match/g })
    expect(search).toContain('Row 10 match')
    // Rows 11 and 12 are on screen as context lines of row 10.
    expect(search).toContain('Row 12 match')
    expect(search).not.toContain('Row 13 match')
    expect(search.endsWith('---\n18 more matching lines not shown (30 in all); narrow the search or use filter.')).toBe(true)
    await page.close()
  })

  it('reads closed shadow roots, nested ones and those in iframes, at their hosts, without touching any document', async () => {
    const { page, read } = await openPage('/closed')
    // The page, its iframe, and the iframe inside the closed root.
    expect(page.frames()).toHaveLength(3)
    const before = await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.documentElement.outerHTML)))
    const markdown = await read()
    // Each root's text at its host, in document order: the open root, the closed one with its
    // slotted light node, its nested closed root and its iframe, then the frame's closed root.
    expect(markdown).toContain(
      [
        '# Shadow page',
        'Before the hosts',
        'Open root text',
        '## Closed heading',
        'Closed article paragraph',
        'Slotted into closed',
        'Nested closed text',
        '[iframe "Frame in closed root"]',
        'Frame body secret',
        '[end of iframe "Frame in closed root"]',
        'Between the hosts',
        '[iframe "Same origin closed"]',
        'Frame light text',
        'Frame closed text',
        '[end of iframe "Same origin closed"]',
        'After the frame',
      ].join('\n\n'),
    )
    // Hidden and unslotted content stays out of a closed root as of an open one; a user-agent root
    // (the inside of the <input>) is not page content.
    for (const hidden of ['Closed hidden secret', 'Unslotted closed secret', 'Closed slot fallback secret', 'Input value secret']) {
      expect(markdown).not.toContain(hidden)
    }
    expect(await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.documentElement.outerHTML)))).toEqual(before)
    await page.close()
  })

  it('finds the article when the page renders it inside a closed shadow root', async () => {
    const { page, read } = await openPage('/closed-article')
    const markdown = await read()
    expect(markdown).toMatch(SOURCE_ARTICLE)
    expect(markdown).toContain('## Battery life')
    expect(markdown).toContain(PARAGRAPH)
    await page.close()
  })
})
