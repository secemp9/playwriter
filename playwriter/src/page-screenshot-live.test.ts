/**
 * screenshot() and diffScreenshot() (page-screenshot.ts) against headless Chromium, through the
 * executor in human and debug mode: what they save and return, that the window and element captures
 * leave the page's own resize / scroll / visualViewport / matchMedia / ResizeObserver /
 * IntersectionObserver / MutationObserver listeners silent, and that what does fire events
 * (captureBeyondViewport) is refused in human mode and reported in debug mode.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'screenshot', 'watched.html'),
)

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}/`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'page-screenshot-'))
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
  // The fixture sets __ready once the page has rendered (ResizeObserver's first callback, which it
  // drops: the initial size) and its loading notes are dropped; only events after that count.
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await executor.execute('return await readPage(() => window.__ready === true)', 30000)).text.includes('[return value] true')) return executor
  }
  throw new Error('the fixture never became ready')
}

/** The JSON a call returned with `return JSON.stringify(…)`. */
async function json<T>(executor: PlaywrightExecutor, code: string): Promise<T> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
  const start = result.text.indexOf('[return value] ')
  expect(start, result.text).toBeGreaterThanOrEqual(0)
  return JSON.parse(result.text.slice(start + '[return value] '.length).trim())
}

/** Everything the page's own listeners noted since it became ready (readPage reads it; nothing clears it). */
async function seen(executor: PlaywrightExecutor): Promise<string[]> {
  return await json<string[]>(executor, 'return await readPage(() => JSON.stringify(window.__seen))')
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

interface Shot {
  changed: boolean
  path?: string
  previousPath?: string
  bytes?: number
  width: number
  height: number
  format: string
  cssPixelRatio: number
  scope: string
  revision: number
  pixelChangeRatio?: number | null
  changedBox?: { x: number; y: number; width: number; height: number } | null
  note?: string
}

describe('screenshot() in human mode', () => {
  let human: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    human = await open('human')
    look = (await human.execute('return await observe({ all: true })', 30000)).text
  }, 60000)

  it('saves the window in the session folder, shows it inline, and the page notices nothing', async () => {
    const noted = (await seen(human)).length
    const result = await human.execute('return JSON.stringify(await screenshot())', 30000)
    expect(result.isError, result.text).toBe(false)
    const shot: Shot = JSON.parse(result.text.slice(result.text.indexOf('{')))
    expect(shot.changed).toBe(true)
    expect(shot.scope).toBe('window')
    expect(shot.path?.startsWith(path.join(cwd, 'tmp') + path.sep)).toBe(true)
    expect(fs.statSync(shot.path!).size).toBe(shot.bytes)
    expect([shot.width, shot.height]).toEqual([1280, 720])
    expect(result.images).toHaveLength(1)
    expect(result.images[0].mimeType).toBe('image/png')
    expect((await seen(human)).slice(noted)).toEqual([])
    const activation = await human.execute('return await readPage(() => navigator.userActivation.hasBeenActive)', 30000)
    expect(activation.text).toContain('[return value] false')
  })

  it('ifChanged saves and shows nothing when the window did not change, and reports the change after a scroll', async () => {
    const files = fs.readdirSync(path.join(cwd, 'tmp')).length
    const same = await human.execute('return JSON.stringify(await screenshot({ ifChanged: true }))', 30000)
    expect(same.isError, same.text).toBe(false)
    const unchanged: Shot = JSON.parse(same.text.slice(same.text.indexOf('{')))
    expect(unchanged).toMatchObject({ changed: false, pixelChangeRatio: 0, changedBox: null })
    expect(unchanged.path).toBeUndefined()
    expect(unchanged.previousPath).toBeTruthy()
    expect(same.images).toHaveLength(0)
    expect(fs.readdirSync(path.join(cwd, 'tmp')).length).toBe(files)

    const scrolled = await human.execute("await act.scroll('down')", 30000)
    expect(scrolled.isError, scrolled.text).toBe(false)
    const after = await json<Shot>(human, 'return JSON.stringify(await screenshot({ ifChanged: true, threshold: 0.05 }))')
    expect(after.changed).toBe(true)
    expect(after.pixelChangeRatio).toBeGreaterThan(0.05)
    expect(after.revision).toBe(unchanged.revision + 1)
    expect(fs.existsSync(after.path!)).toBe(true)
  })

  it('crops a ref out of one window capture, at its CSS size', async () => {
    const field = refOf(look, /Caret field/)
    const before = await human.execute('return await readPage(() => window.scrollY)', 30000)
    expect(before.isError, before.text).toBe(false)
    // The field is in the header; bring it back if the scroll test moved it out.
    if (!before.text.includes('[return value] 0')) {
      const top = await human.execute(`await act.scrollTo(${field})`, 30000)
      expect(top.isError, top.text).toBe(false)
    }
    const box = await json<{ width: number; height: number }>(
      human,
      `return JSON.stringify(await readPage((el) => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height } }, { ref: ${field} }))`,
    )
    const noted = (await seen(human)).length
    const crop = await json<Shot>(human, `return JSON.stringify(await screenshot({ ref: ${field}, path: 'shots/field.png' }))`)
    expect(crop.scope).toMatch(new RegExp(`^\\[${field}\\] textbox "Caret field"`))
    expect(crop.path).toBe(path.join(cwd, 'shots', 'field.png'))
    expect(Math.abs(crop.width - box.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(crop.height - box.height)).toBeLessThanOrEqual(1)
    expect((await seen(human)).slice(noted)).toEqual([])
  })

  it('says how to bring an off-screen ref into view instead of shooting beyond the window', async () => {
    const far = refOf(look, /Far button/)
    const result = await human.execute(`return await screenshot({ ref: ${far} })`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(new RegExp(`\\[${far}\\] button "Far button" is outside the window \\(\\d+px below the window\\)`))
    expect(result.text).toContain(`act.scrollTo(${far}), then screenshot({ ref: ${far} }) again. Nothing was captured.`)
  })

  it('refuses fullPage before running, and at run time when the code hides it', async () => {
    const noted = (await seen(human)).length
    const literal = await human.execute('return await screenshot({ fullPage: true })', 30000)
    expect(literal.isError).toBe(true)
    expect(literal.text).toContain('screenshot({ fullPage: true }) on line 1')
    expect(literal.text).toContain('resizes the window to 1×1 and back while it shoots')
    const hidden = await human.execute('const options = JSON.parse(\'{"fullPage":true}\')\nreturn await screenshot(options)', 30000)
    expect(hidden.isError).toBe(true)
    expect(hidden.text).toContain('Refused (human mode): screenshot({ fullPage: true })')
    expect(hidden.text).toContain('It was not run.')
    expect((await seen(human)).slice(noted)).toEqual([])
  })

  it('refuses raw captures beyond the window or with a clip, and allows the plain one', async () => {
    const noted = (await seen(human)).length
    const beyond = await human.execute("const cdp = await getCDPSession({ page })\nreturn await cdp.send('Page.captureScreenshot', { captureBeyondViewport: true })", 30000)
    expect(beyond.isError).toBe(true)
    expect(beyond.text).toContain('Refused (human mode): Page.captureScreenshot with captureBeyondViewport changes the page while it shoots')
    const clip = await human.execute("const cdp = await getCDPSession({ page })\nreturn await cdp.send('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 } })", 30000)
    expect(clip.text).toContain('Page.captureScreenshot with clip')
    const plain = await human.execute("const cdp = await getCDPSession({ page })\nreturn (await cdp.send('Page.captureScreenshot', { format: 'png' })).data.length > 0", 30000)
    expect(plain.text).toContain('[return value] true')
    expect((await seen(human)).slice(noted)).toEqual([])
  })

  it('writes JPEG when the path or format asks, and refuses options that disagree', async () => {
    const jpeg = await json<Shot & { quality: number }>(human, "return JSON.stringify(await screenshot({ path: 'shots/w.jpg', quality: 60 }))")
    expect(jpeg).toMatchObject({ format: 'jpeg', quality: 60 })
    expect([...fs.readFileSync(jpeg.path!).subarray(0, 2)]).toEqual([0xff, 0xd8])
    const clash = await human.execute("return await screenshot({ path: 'a.png', format: 'jpeg' })", 30000)
    expect(clash.text).toContain("screenshot: path ends in .png but format is 'jpeg'; make them agree. Nothing was captured.")
    const unknown = await human.execute('return await screenshot({ selector: "#x" })', 30000)
    expect(unknown.text).toContain('screenshot: unknown option selector')
    const outside = await human.execute("return await screenshot({ path: '/etc/shot.png' })", 30000)
    expect(outside.text).toContain('/etc/shot.png is outside the folders this session may write to')
  })
})

describe('diffScreenshot()', () => {
  let human: PlaywrightExecutor
  beforeAll(async () => {
    human = await open('human')
  }, 60000)

  it('finds no change against a baseline of the same window, then the change after a scroll, with a diff image', async () => {
    await json<Shot>(human, "return JSON.stringify(await screenshot({ path: 'base.png' }))")
    const same = await json<{ changed: boolean; pixelChangeRatio: number; changedBox: null; diffPath: string }>(human, "return JSON.stringify(await diffScreenshot('base.png'))")
    expect(same).toMatchObject({ changed: false, pixelChangeRatio: 0, changedBox: null })
    expect(fs.existsSync(same.diffPath)).toBe(true)

    const scrolled = await human.execute("await act.scroll('down')", 30000)
    expect(scrolled.isError, scrolled.text).toBe(false)
    const result = await human.execute("return JSON.stringify(await diffScreenshot('base.png', { output: 'diff.png', threshold: 0.01 }))", 30000)
    expect(result.isError, result.text).toBe(false)
    const diff = JSON.parse(result.text.slice(result.text.indexOf('{')))
    expect(diff.changed).toBe(true)
    expect(diff.pixelChangeRatio).toBeGreaterThan(0.01)
    expect(diff.changedBox.width).toBeGreaterThan(0)
    expect(diff.diffPath).toBe(path.join(cwd, 'diff.png'))
    expect(result.images).toHaveLength(1)
  })

  it('refuses images of different sizes with both sizes and what to do', async () => {
    const far = refOf((await human.execute('return await observe({ all: true })', 30000)).text, /Far button/)
    const scrolled = await human.execute(`await act.scrollTo(${far})`, 30000)
    expect(scrolled.isError, scrolled.text).toBe(false)
    await json<Shot>(human, `return JSON.stringify(await screenshot({ ref: ${far}, path: 'part.png' }))`)
    const result = await human.execute("return await diffScreenshot('base.png', { against: 'part.png' })", 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/diffScreenshot: the baseline is 1280×720 px and part\.png is \d+×\d+ px; a pixel diff needs the same size/)
  })

  it('says how to make a baseline when the file is missing', async () => {
    const result = await human.execute("return await diffScreenshot('nope.png')", 30000)
    expect(result.text).toContain("there is no file")
    expect(result.text).toContain("screenshot({ path: 'before.png' })")
  })
})

describe('screenshot() in debug mode', () => {
  it('captures the full page beyond the window, and reports the resize events the page received', async () => {
    const debug = await open('debug')
    const height = await json<number>(debug, 'return JSON.stringify(await readPage(() => document.documentElement.scrollHeight))')
    const shot = await json<Shot>(debug, 'return JSON.stringify(await screenshot({ fullPage: true }))')
    expect(shot.scope).toBe('full page')
    expect(shot.height).toBe(height)
    expect(shot.note).toContain('the page receives resize, visualViewport resize, ResizeObserver and matchMedia change events up to twice')
    // Measured: Chrome resizes the window to 1×1 and back while it shoots beyond it. When both resizes
    // fall between two of the page's frames (a loaded computer, Chromium 133 and Chrome 149 alike), the
    // page gets one resize at its own size, one visualViewport resize and one matchMedia change.
    const events = await seen(debug)
    expect(events).toContain('visualViewport.resize')
    expect(events.some((event) => /^resize \d+x\d+$/.test(event)), events.join(', ')).toBe(true)
  })
})
