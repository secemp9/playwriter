/**
 * act.click, act.type, act.scroll and act.spaNavigate in a headless Chrome on pages that tripped
 * them in the Browser Lab and on real sites: buttons inside shadow roots (MDN's Run), a rich text
 * editor's paragraphs, a chat log scroll area, and SPA links carrying a query string.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

/**
 * Serves this suite's pages (`/act-input/…`), the Browser Lab copy (`/…`, `/lab/…`), and the
 * in-app routes of `/act-input/spa.html` (`/shop/…`), which a reload of a route must also answer.
 */
function serveFixture(req: http.IncomingMessage, res: http.ServerResponse): void {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const file = pathname.startsWith('/shop')
    ? path.join(FIXTURES, 'act-input', 'spa.html')
    : pathname.startsWith('/act-input/')
      ? path.join(FIXTURES, pathname)
      : path.join(FIXTURES, 'browser-lab', pathname)
  if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404)
    res.end()
    return
  }
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'
  res.writeHead(200, { 'Content-Type': type })
  res.end(fs.readFileSync(file))
}

beforeAll(async () => {
  server = http.createServer(serveFixture)
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'act-input-'))
})

afterAll(async () => {
  const closing = await Promise.allSettled(executors.map((executor) => executor.closeHeadlessContext()))
  const browser = await Promise.allSettled([PlaywrightExecutor.closeSharedHeadlessBrowser()])
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close((error) => (error ? closed.reject(error) : closed.resolve()))
  const stopped = await Promise.allSettled([closed.promise])
  fs.rmSync(cwd, { recursive: true, force: true })
  const errors = [...closing, ...browser, ...stopped].flatMap((outcome): unknown[] => (outcome.status === 'rejected' ? [outcome.reason] : []))
  if (errors.length > 0) throw new AggregateError(errors, `teardown failed ${errors.length} time(s)`)
})

async function openFixture(page: string, policy: 'human' | 'debug' = 'human'): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}/${page}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

/** The ref printed in front of the first line matching `pattern`, e.g. `[12] button "Run"`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

/** `expression` evaluated in the page's isolated world, as text between markers. */
async function read(executor: PlaywrightExecutor, expression: string): Promise<string> {
  const result = await executor.execute(`return await readPage(() => 'OUT<' + (${expression}) + '>OUT')`, 30000)
  expect(result.isError, result.text).toBe(false)
  return /OUT<([\s\S]*)>OUT/.exec(result.text)?.[1] ?? ''
}

describe('act.click on a button inside a shadow root is not covered by its own host', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-input/shadow.html')
    look = (await executor.execute('await observe({ all: true })', 30000)).text
  })
  const out = (): Promise<string> => read(executor, "document.getElementById('out').textContent")

  it('clicks a button whose label the host slots into it (open shadow root, MDN’s Run)', async () => {
    const result = await executor.execute(`await act.click(${refOf(look, /button "Run"$/)})`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).not.toMatch(/covered by/)
    expect(await out(), result.text).toBe('clicked Run')
  })

  it('clicks it in a closed shadow root', async () => {
    const result = await executor.execute(`await act.click(${refOf(look, /button "Run closed"/)})`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(await out()).toBe('clicked Run closed')
  })

  it('clicks it when the host slots an element (a span) into it', async () => {
    const result = await executor.execute(`await act.click(${refOf(look, /button "Save draft"/)})`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(await out()).toBe('clicked Save draft')
  })

  it('still refuses a button a real overlay covers, naming the overlay', async () => {
    const result = await executor.execute(`await act.click(${refOf(look, /button "Publish"/)})`, 60000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/\[\d+\] button "Publish" is covered by region "Cookie banner"/)
    expect(await out()).toBe('clicked Save draft')
  })

  it('still refuses a button another shadow host is drawn over', async () => {
    const result = await executor.execute(`await act.click(${refOf(look, /button "Delete"/)})`, 60000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/button "Delete" is covered by .*x-banner#promo|button "Delete" is covered by .*Sale! 20% off/)
    expect(await out()).toBe('clicked Save draft')
  })
})

describe('act.spaNavigate clicks the page’s link to a path even when the link carries a query string', () => {
  let executor: PlaywrightExecutor
  beforeAll(async () => {
    executor = await openFixture('shop/?tag=lab')
  })
  const where = (): Promise<string> => read(executor, "location.pathname + location.search + location.hash + ' | ' + document.querySelector('h1').textContent")

  it('follows the link to /shop/products?tag=lab for /shop/products and says which link it used', async () => {
    await executor.execute('await observe()', 30000)
    const result = await executor.execute("await act.spaNavigate('/shop/products')", 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/clicked the page's own link \[\d+\] link "Products" → \/shop\/products\?tag=lab \(matched by its path; \/shop\/products was asked\)/)
    expect(await where()).toBe('/shop/products?tag=lab | Products')
  })

  it('refuses a path two different links lead to, listing both, and follows the one named in full', async () => {
    await executor.execute('await observe()', 30000)
    const ambiguous = await executor.execute("await act.spaNavigate('/shop/cart')", 60000)
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toMatch(/2 links on the page lead to \/shop\/cart with different addresses: \[\d+\] link "Cart" → \/shop\/cart\?tag=lab, \[\d+\] link "Checkout" → \/shop\/cart\?step=checkout&tag=lab/)
    expect(await where()).toBe('/shop/products?tag=lab | Products')
    const result = await executor.execute("await act.spaNavigate('/shop/cart?step=checkout&tag=lab')", 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/clicked the page's own link \[\d+\] link "Checkout" → \/shop\/cart\?step=checkout&tag=lab$/m)
    expect(await where()).toBe('/shop/cart?step=checkout&tag=lab | Cart — checkout')
  })

  it('matches the #fragment when the route has one, and refuses a path whose links differ only there', async () => {
    await executor.execute('await observe()', 30000)
    expect((await executor.execute("await act.spaNavigate('/shop/')", 60000)).isError).toBe(false)
    await executor.execute('await observe()', 30000)
    const ambiguous = await executor.execute("await act.spaNavigate('/shop/help')", 60000)
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toMatch(/link "FAQ" → \/shop\/help#faq, \[\d+\] link "Contact us" → \/shop\/help#contact/)
    const result = await executor.execute("await act.spaNavigate('/shop/help#contact')", 60000)
    expect(result.isError, result.text).toBe(false)
    expect(await where()).toBe('/shop/help#contact | Help')
  })

  it('names the in-app links there are when none leads to the path', async () => {
    await executor.execute('await observe()', 30000)
    const result = await executor.execute("await act.spaNavigate('/shop/orders')", 60000)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('No link to /shop/orders is on the page; its in-app links lead to /shop/?tag=lab, /shop/products?tag=lab, /shop/cart?tag=lab')
  })
})

describe('act.scroll over a scroll area wheels only that area, never the page around it', () => {
  let executor: PlaywrightExecutor
  let log = 0
  beforeAll(async () => {
    executor = await openFixture('scroll.html')
    log = refOf((await executor.execute('await observe({ all: true })', 30000)).text, /log "Team chat"/)
  })
  const positions = async (): Promise<{ page: number; chat: number; chatEnd: number }> =>
    JSON.parse(await read(executor, "JSON.stringify({ page: Math.round(scrollY), chat: Math.round(document.getElementById('chat').scrollTop), chatEnd: document.getElementById('chat').scrollHeight - document.getElementById('chat').clientHeight })"))

  it('brings the off-screen chat log into view, then wheels it up to its top and stops there (lab SCROLL-T2)', async () => {
    const before = await positions()
    expect(before.chat).toBe(before.chatEnd)
    const result = await executor.execute(`await act.scroll('up', { ref: ${log}, screens: 10 })`, 90000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(new RegExp(`brought \\[${log}\\] log "Team chat" into view first`))
    expect(result.text).toContain(`reached the top of [${log}] log "Team chat" after ${before.chatEnd}px`)
    const after = await positions()
    expect(after.chat).toBe(0)
    // The log is on screen: the page moved only to bring it in, not past it.
    const [top, bottom, height] = (await read(executor, "[document.getElementById('chat').getBoundingClientRect().top, document.getElementById('chat').getBoundingClientRect().bottom, innerHeight].join(',')")).split(',').map(Number)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(bottom).toBeLessThanOrEqual(height)
  })

  it('wheels the in-view log 10 screens to its far edge without moving the page by a pixel', async () => {
    // In view first (a no-op after the test above), so this measures the area scroll alone.
    expect((await executor.execute(`await act.scrollTo(${log})`, 60000)).isError).toBe(false)
    const before = await positions()
    // At its bottom on load (lab: page y 1571 → 174 when this chained), at its top after the test above.
    const up = before.chat > 0
    const result = await executor.execute(`await act.scroll('${up ? 'up' : 'down'}', { ref: ${log}, screens: 10 })`, 90000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain(`reached the ${up ? 'top' : 'bottom'} of [${log}] log "Team chat" after ${before.chatEnd}px`)
    const after = await positions()
    expect(after.chat).toBe(up ? 0 : after.chatEnd)
    expect(after.page, result.text).toBe(before.page)
  })

  it('wheels one screen of the log and says how much is left, the page still', async () => {
    const before = await positions()
    const result = await executor.execute(`await act.scroll('up', { ref: ${log} })`, 90000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(new RegExp(`scrolled \\[${log}\\] log "Team chat" \\d+px; [\\d.]+ screens above`))
    const after = await positions()
    expect(after.page).toBe(before.page)
    expect(after.chat).toBeLessThan(before.chat)
    expect(after.chat).toBeGreaterThan(0)
  })
})

describe('act.type in a rich editor types at the end of the block the ref names', () => {
  it('appends " Edited." to paragraph 2 of the lab editor, not to the end of the document (lab KEY-T3)', async () => {
    const executor = await openFixture('keyboard.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const paragraph = refOf(look, /paragraph "Rich text editors keep their state in the DOM\."/)
    const result = await executor.execute(`await act.type(${paragraph}, ' Edited.')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('put the caret at the end of paragraph 2 with a click after its last character')
    expect(result.text).toContain('typed into paragraph 2 "Rich text editors keep their state in the DOM. Edited."')
    expect(result.text).not.toMatch(/Ctrl\+End/)
    expect(await read(executor, "Array.from(document.querySelectorAll('#editor p')).map((p) => p.textContent).join('|')")).toBe(
      'The quick brown fox jumps over the lazy dog.|Rich text editors keep their state in the DOM. Edited.|Press Ctrl+B to toggle bold.',
    )
    expect(await read(executor, "document.getElementById('word-count').textContent")).toBe('Words: 24')
  })

  it('on the editor itself still appends at its end, and names the block that got the text', async () => {
    const executor = await openFixture('keyboard.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const result = await executor.execute(`await act.type(${refOf(look, /textbox "Document"/)}, ' Done.')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/put the caret after the text with (Ctrl\+End|⌘↓)/)
    expect(result.text).toContain('typed into paragraph 3 "Press Ctrl+B to toggle bold. Done."')
  })

  it('types where the caret is with { at: "caret" }, and refuses when the caret is elsewhere', async () => {
    const executor = await openFixture('act-input/editor.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const notes = refOf(look, /textbox "Notes"|"Notes"/)
    const elsewhere = await executor.execute(`await act.type(${notes}, 'x', { at: 'caret' })`, 60000)
    expect(elsewhere.isError).toBe(true)
    expect(elsewhere.text).toMatch(/the caret is not in \[\d+\].*Nothing was typed\./)
    expect((await executor.execute(`await act.click(${refOf(look, /listitem "First item"/)})`, 60000)).isError).toBe(false)
    expect((await executor.execute("await act.press('End')", 60000)).isError).toBe(false)
    const result = await executor.execute(`await act.type(${notes}, ' now', { at: 'caret' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('typed where the caret was')
    expect(result.text).toContain('typed into list item 1 "First item now"')
    const fill = await executor.execute(`await act.fill(${notes}, 'x', { at: 'caret' })`, 60000)
    expect(fill.isError).toBe(true)
    expect(fill.text).toContain("act.fill replaces the whole text; { at: 'caret' } is for act.type. Nothing was typed.")
  })

  it('appends to a list item of a plain contenteditable', async () => {
    const executor = await openFixture('act-input/editor.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const result = await executor.execute(`await act.type(${refOf(look, /listitem "Second item"/)}, ' (done)')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('typed into list item 2 "Second item (done)"')
    expect(await read(executor, "Array.from(document.querySelectorAll('#notes li')).map((li) => li.textContent).join('|')")).toBe('First item|Second item (done)')
  })

  it('appends to a paragraph of an editor that re-renders its blocks on every key (ProseMirror-like)', async () => {
    const executor = await openFixture('act-input/editor.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const result = await executor.execute(`await act.type(${refOf(look, /paragraph "It was a dark night\."/)}, ' Then dawn.')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('typed into paragraph 1 "It was a dark night. Then dawn."')
    expect(await read(executor, "Array.from(document.getElementById('story').children).map((b) => b.textContent).join('|')")).toBe(
      'Chapter one|It was a dark night. Then dawn.|The end.',
    )
  })
})

describe('the same act paths in debug mode (no human-mode guard)', () => {
  it('types at the end of an editor block, scrolls an area to its edge, and clicks a shadow button', async () => {
    const editor = await openFixture('keyboard.html', 'debug')
    const look = (await editor.execute('await observe({ all: true })', 30000)).text
    const typed = await editor.execute(`await act.type(${refOf(look, /paragraph "Press Ctrl\+B to toggle bold\."/)}, ' Now.')`, 60000)
    expect(typed.isError, typed.text).toBe(false)
    expect(typed.text).toContain('typed into paragraph 3 "Press Ctrl+B to toggle bold. Now."')

    const scroll = await openFixture('scroll.html', 'debug')
    const log = refOf((await scroll.execute('await observe({ all: true })', 30000)).text, /log "Team chat"/)
    const scrolled = await scroll.execute(`await act.scroll('up', { ref: ${log}, screens: 10 })`, 90000)
    expect(scrolled.isError, scrolled.text).toBe(false)
    expect(scrolled.text).toMatch(/reached the top of \[\d+\] log "Team chat" after \d+px/)

    const shadow = await openFixture('act-input/shadow.html', 'debug')
    const run = refOf((await shadow.execute('await observe({ all: true })', 30000)).text, /button "Run"$/)
    const clicked = await shadow.execute(`await act.click(${run})`, 60000)
    expect(clicked.isError, clicked.text).toBe(false)
  })
})
