import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')
// The browser-lab pages load /lab/*.js and /lab/*.css from the site root; act-buttons.html is this file's own page.
const ROOTS: Record<string, string> = { '/act-buttons.html': path.join(FIXTURES, 'act-pointer', 'act-buttons.html') }

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const file = ROOTS[pathname] ?? path.join(FIXTURES, 'browser-lab', path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'act-pointer-points-'))
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

async function openFixture(page: string): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  executors.push(executor)
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

describe('act.click / act.hover take a point of an element: { ref, x, y }', () => {
  it('clicks exactly a point of a custom slider track and reports the point and what was under it', async () => {
    const executor = await openFixture('pointer.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const slider = refOf(look, /div#slider|slider" \(clickable|clickable.*#slider/)
    const result = await executor.execute(`await act.click({ ref: ${slider}, x: 225, y: 14 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain(`click [${slider}]`)
    expect(result.text).toContain('at (225, 14)')
    expect(result.text).toMatch(new RegExp(`pointer at \\(225, 14\\) of \\[${slider}\\] = \\([\\d.]+, [\\d.]+\\) in the viewport, over `))
    expect(await textOf(executor, '#slider-value')).toBe('Brightness: 75')
  })

  it('refuses a point outside the element or a malformed target and clicks nothing', async () => {
    const executor = await openFixture('pointer.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const slider = refOf(look, /div#slider|slider" \(clickable|clickable.*#slider/)
    const outside = await executor.execute(`await act.click({ ref: ${slider}, x: 300, y: 14 })`, 60000)
    expect(outside.isError).toBe(true)
    expect(outside.text).toMatch(/is 300×28 px: x must be from 0 up to, not including, 300, .*Nothing was clicked\./)
    const bad = await executor.execute(`await act.click({ ref: ${slider}, x: '5', y: 1 })`, 60000)
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/act\.click: the target .*x and y must be finite numbers/)
    const button = await executor.execute(`await act.click(${slider}, { button: 'Right' })`, 60000)
    expect(button.isError).toBe(true)
    expect(button.text).toMatch(/button must be 'left', 'right' or 'middle' \(got "Right"\)/)
    expect(await textOf(executor, '#slider-value')).toBe('Brightness: 20')
  })

  it("OVER-T3: a point covered by a modal's backdrop is refused naming the backdrop, with the same spot as a point of the backdrop; that click hits the backdrop", async () => {
    const executor = await openFixture('overlay.html')
    // The newsletter modal opens ≈1 s after load (TRUTH §3.3).
    const waited = await executor.execute('await act.wait(1500)', 30000)
    expect(waited.isError, waited.text).toBe(false)
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const proceed = refOf(look, /button "Continue"/)
    const covered = await executor.execute(`await act.click({ ref: ${proceed}, x: 50, y: 20 })`, 60000)
    expect(covered.isError).toBe(true)
    expect(covered.text).toMatch(/at \(50, 20\) \[\d+\] button "Continue" is covered by div#newsletter-backdrop/)
    const spot = /To press that spot anyway \(it lands on what is on top\): (\{ ref: \d+, x: [\d.]+, y: [\d.]+ \})/.exec(covered.text)
    expect(spot, covered.text).not.toBeNull()
    expect(await textOf(executor, '#activity')).not.toContain('Backdrop clicked')
    const pressed = await executor.execute(`await act.click(${spot?.[1]})`, 60000)
    expect(pressed.isError, pressed.text).toBe(false)
    expect(await textOf(executor, '#activity')).toContain('Backdrop clicked (modal still open)')
    expect(await textOf(executor, '#step')).toContain('Step 1 of 3')
  })

  it('hovers exactly a point of an element', async () => {
    const executor = await openFixture('pointer.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const products = refOf(look, /button "Products/)
    const result = await executor.execute(`await act.hover({ ref: ${products}, x: 5, y: 5 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain(`pointer at (5, 5) of [${products}]`)
    const expanded = await executor.execute("return await readPage(() => 'EXP<' + document.querySelector('#menu-products > button').getAttribute('aria-expanded') + '>')", 30000)
    expect(expanded.text).toContain('EXP<true>')
  })
})

describe('act.click with the right and middle buttons', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-buttons.html')
    look = (await executor.execute('await observe({ all: true })', 30000)).text
  })

  it("right-click fires a trusted contextmenu at the element, the page's own menu opens and is in the report", async () => {
    const file = refOf(look, /button "Report\.pdf"/)
    const result = await executor.execute(`await act.click(${file}, { button: 'right' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain(`click [${file}] button "Report.pdf" with the right button`)
    expect(result.text).toMatch(/menuitem "Rename"/)
    const log = await textOf(executor, '#log')
    expect(log).toMatch(/mousedown b2 trusted/)
    expect(log).toMatch(/contextmenu b2 trusted/)
    expect(log).toMatch(/mouseup b2 trusted/)
    expect(log).not.toMatch(/(^|; )click /)
  })

  it('right-click at a point: contextmenu fires exactly there', async () => {
    const file = refOf(look, /button "Report\.pdf"/)
    const result = await executor.execute(`await act.click({ ref: ${file}, x: 7, y: 9 }, { button: 'right' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    const at = /mousedown b2 trusted ([\d.-]+),([\d.-]+); contextmenu b2 trusted \1,\2; mouseup b2 trusted on menu$/.exec(await textOf(executor, '#log'))
    expect(at).not.toBeNull()
    // MouseEvent.clientX/Y are whole CSS px in Chrome: the offset from a fractional box edge is within 1 px.
    expect(Math.abs(Number(at?.[1]) - 7)).toBeLessThan(1)
    expect(Math.abs(Number(at?.[2]) - 9)).toBeLessThan(1)
  })

  it('middle-click fires a trusted auxclick with button 1 and no click', async () => {
    const docs = refOf(look, /link "Docs"/)
    const result = await executor.execute(`await act.click(${docs}, { button: 'middle' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('with the middle button')
    const log = await textOf(executor, '#log')
    expect(log).toMatch(/docs auxclick b1 trusted/)
    expect(log).not.toMatch(/docs click/)
  })
})

describe("act.drag(from, to, { path: 'straight' }) and the human path's geometry", () => {
  it("PTR-T4: draws exactly a 200 px line with { path: 'straight' }", async () => {
    const executor = await openFixture('pointer.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const sketch = refOf(look, /image "Sketch pad"/)
    const result = await executor.execute(`await act.drag({ ref: ${sketch}, x: 100, y: 100 }, { ref: ${sketch}, x: 300, y: 100 }, { path: 'straight' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('along a straight line')
    expect(result.text).toContain('held-button path: a straight line of 200 px')
    expect(await textOf(executor, '#sketch-stats')).toBe('Strokes: 1 · Length: 200 px')
  })

  it("the human path starts and ends at the points; its stroke is the reported path length, longer than the line", async () => {
    const executor = await openFixture('pointer.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const sketch = refOf(look, /image "Sketch pad"/)
    const result = await executor.execute(`await act.drag({ ref: ${sketch}, x: 100, y: 100 }, { ref: ${sketch}, x: 300, y: 100 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    const travelled = /held-button path: (\d+) px of a person's curved path for 200 px between the two points/.exec(result.text)
    expect(travelled, result.text).not.toBeNull()
    const drawn = Number(/Length: (\d+) px/.exec(await textOf(executor, '#sketch-stats'))?.[1])
    // Chrome may coalesce moves into one pointermove (a chord of the curve): the stroke is at most the path, never less than the line.
    expect(drawn).toBeGreaterThanOrEqual(200)
    expect(drawn).toBeLessThanOrEqual(Number(travelled?.[1]) + 1)
  })

  it('refuses an unknown path and drags nothing', async () => {
    const executor = await openFixture('pointer.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const sketch = refOf(look, /image "Sketch pad"/)
    const result = await executor.execute(`await act.drag({ ref: ${sketch}, x: 10, y: 10 }, { ref: ${sketch}, x: 30, y: 10 }, { path: 'line' })`, 60000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/act\.drag: path must be 'human' or 'straight' \(got "line"\)\. Nothing was dragged\./)
    expect(await textOf(executor, '#sketch-stats')).toBe('Strokes: 0 · Length: 0 px')
  })
})
