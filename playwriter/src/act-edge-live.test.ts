/**
 * Edges of bringing a target into view, and reads made after an action in the same call (headless).
 * - A plain-ref click on an element only partly in view where nothing can scroll it further (a fixed
 *   menu by the window's bottom edge, an element cut by the end of the page) clicks the part in view;
 *   one in a fixed scrollable list is scrolled into view inside that list. Only a target with no part
 *   in view is refused, saying why.
 * - `act.open(url)` then `observe()` in one call: the observation is of the settled page the report
 *   describes, not of the skeletons it showed while loading.
 * - A colour chooser that did not open is reported with what is known and what brings it, not
 *   blamed on the page.
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

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname === '/api/products') {
      // act-settle/skeletons.html shows skeletons until this answers. The delay is real on purpose: the
      // browser's own request has to be in flight while the page loads, which a fake clock cannot stand in for.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(Array.from({ length: 10 }, (_, index) => `product ${index + 1}`)))
      }, 800)
      return
    }
    const file = path.join(FIXTURES, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'act-edge-'))
})

afterAll(async () => {
  // Every step runs even when one fails; the failures are reported together afterwards.
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

function newExecutor(): PlaywrightExecutor {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  executors.push(executor)
  return executor
}

async function openFixture(page: string): Promise<PlaywrightExecutor> {
  const executor = newExecutor()
  const loaded = await executor.execute(`await page.goto('${baseUrl}/${page}', { waitUntil: 'domcontentloaded' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

/** The ref printed in front of the first line matching `pattern`, e.g. `[12] button "Send"`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

async function textOf(executor: PlaywrightExecutor, selector: string): Promise<string> {
  const result = await executor.execute(`return await readPage(() => 'TEXT<' + document.querySelector(${JSON.stringify(selector)}).textContent + '>')`, 30000)
  expect(result.isError, result.text).toBe(false)
  return /TEXT<([\s\S]*?)>/.exec(result.text)?.[1] ?? ''
}

describe('act.click on a target only partly in view', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-pointer/partly-visible.html')
    look = (await executor.execute('await observe({ all: true })', 30000)).text
  })

  it('H9a: clicks the visible part of an item of a fixed menu that sticks out below the window', async () => {
    const archive = refOf(look, /menuitem "Archive"/)
    const result = await executor.execute(`await act.click(${archive})`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(await textOf(executor, '#status')).toBe('Clicked: Archive')
  })

  it('H9a: clicks the visible part of an element cut by the end of the page, after scrolling to that end', async () => {
    const cut = refOf(look, /button "Half at the end"/)
    const result = await executor.execute(`await act.click(${cut})`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/scrolled with the mouse wheel to reach it: \d+px in page/)
    expect(await textOf(executor, '#status')).toBe('Clicked: Half at the end')
  })

  it('H9a: scrolls a fixed list whose lower part is below the window until the item is in view inside it', async () => {
    const item = refOf(look, /menuitem "Item 7"/)
    const result = await executor.execute(`await act.click(${item})`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/scrolled with the mouse wheel to reach it: \d+px in menu#scroll-menu/)
    expect(await textOf(executor, '#status')).toBe('Clicked: Item 7')
  })

  it('H9a: refuses, saying why, only a target with no part in view that no scrolling can bring in', async () => {
    const unreachable = refOf(look, /menuitem "Unreachable"/)
    const pinned = await executor.execute(`await act.click(${unreachable})`, 60000)
    expect(pinned.isError).toBe(true)
    expect(pinned.text).toMatch(
      /\[\d+\] menuitem "Unreachable" is below the visible part of the page, and no scrolling brings it in: it is inside menu#hidden-menu\.menu "Out of reach", a layer fixed to the window \(position: fixed\)/,
    )
    const gone = refOf(look, /button "Past the end"/)
    const atEnd = await executor.execute(`await act.click(${gone})`, 60000)
    expect(atEnd.isError).toBe(true)
    expect(atEnd.text).toMatch(/\[\d+\] button "Past the end" is below the visible part of page, and page is already scrolled as far as it goes that way/)
    expect(await textOf(executor, '#status')).not.toMatch(/Unreachable|Past the end/)
  })
})

describe('a read after an action in the same call', () => {
  it('H4: act.open(url) then observe() shows the settled page the report describes, not its loading skeletons', async () => {
    const executor = newExecutor()
    const result = await executor.execute(`await act.open('${baseUrl}/act-settle/skeletons.html'); await observe()`, 60000)
    expect(result.isError, result.text).toBe(false)
    // The report comes first; observe()'s output starts at its page line.
    const cut = result.text.lastIndexOf('\nPAGE')
    const report = result.text.slice(0, cut)
    const observed = result.text.slice(cut)
    expect(report).toMatch(/SETTLED \d+ms/)
    expect(report).toMatch(/busy while it settled, gone now: .*skeleton placeholders/)
    expect(report).toMatch(/NEW DOCUMENT .* 10 controls/)
    expect(observed).toContain('button "Add product 10"')
    expect(observed).not.toMatch(/BUSY|skeleton placeholders|aria-busy/)
  })
})

describe("Chrome's colour chooser that does not open", () => {
  it('H9e: says what is known — still closed, the value it reads — and what brings it, without blaming the page', async () => {
    const executor = await openFixture('act-input/colour-cancelled.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const colour = refOf(look, /colorwell "Favourite colour"/)
    const result = await executor.execute(`await act.fill(${colour}, '#ff0000')`, 60000)
    expect(result.isError).toBe(true)
    expect(result.text).toContain(
      `Clicked [${colour}] colorwell "Favourite colour", but Chrome's colour chooser did not open: 1 s later it is still closed, and the input reads #000000. ` +
        'Chrome does not open it in a tab behind another one: if this tab is not in front, page.bringToFront() brings it there, then call act.fill again. ' +
        `explain(${colour}) shows whether the page itself listens for clicks on it.`,
    )
    expect(result.text).not.toContain('the page may handle the click itself')
  })
})
