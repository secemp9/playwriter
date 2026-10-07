/**
 * act.select on native <select> elements in a headless Chrome, driven only through trusted input:
 * a click opens the list, type-ahead and arrow keys move its highlight, Enter chooses. Long lists
 * (the Browser Lab's 200-country select), option groups, disabled options, duplicate labels, list
 * boxes (`multiple`), options out of sight in the list, and a page that puts its own value back.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

/** Serves the Browser Lab copy (`/form.html`, `/lab/…`) and this suite's own pages (`/act-input/…`). */
function serveFixture(req: http.IncomingMessage, res: http.ServerResponse): void {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const file = pathname.startsWith('/act-input/') ? path.join(FIXTURES, pathname) : path.join(FIXTURES, 'browser-lab', pathname)
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
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'act-select-'))
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

/** The ref printed in front of the first line matching `pattern`, e.g. `[12] combobox "Country"`. */
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

describe('act.select on the lab form’s 200-country select', () => {
  // Each test opens its own tab; closing it afterwards keeps the shared browser to the tabs in use.
  afterEach(async () => {
    await Promise.all(executors.splice(0).map((executor) => executor.closeHeadlessContext()))
  })

  it('chooses "United Kingdom" in a few seconds with type-ahead in the open list, and reads it back', async () => {
    const executor = await openFixture('form.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const country = refOf(look, /combobox "Country"/)
    const started = Date.now()
    const result = await executor.execute(`await act.select(${country}, 'United Kingdom')`, 60000)
    const took = Date.now() - started
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('selected "United Kingdom" (was "Select a country")')
    expect(result.text).toMatch(/typed "United K" in its open list, then Enter/)
    expect(result.text).not.toMatch(/rejected or reset/)
    expect(await read(executor, "document.getElementById('country').value")).toBe('United Kingdom')
    // A person picks a country in a few seconds; arrowing through ~190 options took 28–31 s.
    expect(took, result.text).toBeLessThan(10_000)
  })

  it('chooses a country before the current one ("France" after "United Kingdom")', async () => {
    const executor = await openFixture('form.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const country = refOf(look, /combobox "Country"/)
    expect((await executor.execute(`await act.select(${country}, 'United Kingdom')`, 60000)).isError).toBe(false)
    const result = await executor.execute(`await act.select(${country}, 'France')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('selected "France" (was "United Kingdom")')
    expect(await read(executor, "document.getElementById('country').value")).toBe('France')
  })

  it('types into a list the model opened already (act.click first) instead of clicking it shut', async () => {
    const executor = await openFixture('form.html')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const country = refOf(look, /combobox "Country"/)
    const opened = await executor.execute(`await act.click(${country})`, 60000)
    expect(opened.isError, opened.text).toBe(false)
    const result = await executor.execute(`await act.select(${country}, 'United States')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('its list was open already')
    expect(result.text).toMatch(/typed "United S" in its open list, then Enter/)
    expect(await read(executor, "document.getElementById('country').value")).toBe('United States')
  })

  it('chooses the same way in debug mode', async () => {
    const executor = await openFixture('form.html', 'debug')
    const look = (await executor.execute('await observe({ all: true })', 30000)).text
    const result = await executor.execute(`await act.select(${refOf(look, /combobox "Country"/)}, 'United Kingdom')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/typed "United K" in its open list, then Enter/)
    expect(await read(executor, "document.getElementById('country').value")).toBe('United Kingdom')
  })
})

describe('act.select: option groups, disabled options, duplicate labels, list boxes, a page that resets', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-input/select.html')
    look = (await executor.execute('await observe({ all: true })', 30000)).text
  })

  const out = (): Promise<string> => read(executor, "document.getElementById('out').textContent")

  it('chooses an option of a later group, skipping a disabled option and a disabled group', async () => {
    const region = refOf(look, /combobox "Region"/)
    const result = await executor.execute(`await act.select(${region}, 'Korea')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('selected "Korea" (was "Choose a region")')
    expect(await out()).toContain('region=Korea')
  })

  it('refuses a disabled option and an option of a disabled group, choosing nothing', async () => {
    const region = refOf(look, /combobox "Region"/)
    const spain = await executor.execute(`await act.select(${region}, 'Spain')`, 60000)
    expect(spain.isError).toBe(true)
    expect(spain.text).toMatch(/"Spain" in \[\d+\] combobox "Region" is disabled/)
    const yugoslavia = await executor.execute(`await act.select(${region}, 'Yugoslavia')`, 60000)
    expect(yugoslavia.isError).toBe(true)
    expect(yugoslavia.text).toMatch(/"Yugoslavia" .* is disabled/)
    expect(await read(executor, "document.getElementById('region').value")).toBe('Korea')
  })

  it('refuses a label two options share, and chooses the right one by its value', async () => {
    const size = refOf(look, /combobox "Size"/)
    const ambiguous = await executor.execute(`await act.select(${size}, 'Medium')`, 60000)
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toContain('"Medium" (value m-regular), "Medium" (value m-tall)')
    const result = await executor.execute(`await act.select(${size}, 'm-tall')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(await read(executor, "document.getElementById('size').value")).toBe('m-tall')
    expect(result.text).toContain('selected "Medium" (was "Small")')
    expect(result.text).toMatch(/typed "M", then 2 × ↓ in its open list, then Enter/)
  })

  it('in a list box, clicks an option scrolled out of sight inside it, then adds another one to the choice', async () => {
    const toppings = refOf(look, /listbox "Toppings"/)
    const tomato = await executor.execute(`await act.select(${toppings}, 'Tomato')`, 60000)
    expect(tomato.isError, tomato.text).toBe(false)
    expect(await out(), tomato.text).toContain('toppings=Tomato')
    const basil = await executor.execute(`await act.select(${toppings}, 'Basil')`, 60000)
    expect(basil.isError, basil.text).toBe(false)
    expect(basil.text).toContain('now selected: "Basil", "Tomato"')
    expect(await out()).toContain('toppings=Basil+Tomato')
  })

  it('says the page put its own value back only when it saw the choice taken and then undone', async () => {
    const delivery = refOf(look, /combobox "Delivery"/)
    const result = await executor.execute(`await act.select(${delivery}, 'Overnight')`, 60000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/showed "Overnight", then the page changed it back to "Standard"/)
    expect(await read(executor, "document.getElementById('locked').value")).toBe('Standard')
  })

  it('when the click leaves the list closed with focus on the select, chooses with keys on the closed select', async () => {
    const speed = refOf(look, /combobox "Speed"/)
    const result = await executor.execute(`await act.select(${speed}, 'Faster')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('its list was closed, so the keys chose on the select itself: typed "Faste"')
    expect(result.text).toContain('selected "Faster" (was "Slow")')
    expect(await out()).toContain('speed=Faster')
  })
})
