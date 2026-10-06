import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'human-shop')

interface Point {
  x: number
  y: number
}

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const fixture = /^\/(act-(?:newline|drag)\.html)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (!fixture) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(path.join(FIXTURES, fixture[1]), 'utf-8'))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'act-newline-drag-'))
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

async function openFixture(fixture: string): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}/${fixture}', { waitUntil: 'domcontentloaded' })`, 30000)
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

describe('act.type / act.fill never guess the key for a line break in a multi-line field', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-newline.html')
    look = (await executor.execute('await observe({ all: true })', 30000)).text
  })

  /** What the fields hold and what the composers sent, as the page has them. */
  async function fields(): Promise<{ composer: string; notes: string; rich: string; sent: string[] }> {
    const result = await executor.execute(
      "return await readPage(() => JSON.stringify({ composer: document.getElementById('composer').value, notes: document.getElementById('notes').value, " +
        "rich: document.getElementById('rich').innerText, sent: [...document.querySelectorAll('#sent li')].map((li) => li.textContent) }))",
      30000,
    )
    expect(result.isError, result.text).toBe(false)
    const json = result.text.slice(result.text.indexOf('{'), result.text.lastIndexOf('}') + 1)
    return JSON.parse(json)
  }

  it('refuses text with a line break in a chat composer without newline, and types and sends nothing', async () => {
    const composer = refOf(look, /textbox "Message"/)
    const result = await executor.execute(`await act.type(${composer}, 'Line 1\\nLine 2')`, 60000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/1 line break\b/)
    expect(result.text).toMatch(/chat composer Enter sends .*Shift\+Enter starts a new line/)
    expect(result.text).toContain(`act.type(${composer}, text, { newline: 'Shift+Enter' })`)
    expect(result.text).toContain("{ newline: 'Enter' }")
    expect(result.text).toContain('{ paste: true }')
    expect(result.text).toMatch(/Nothing was typed\./)
    expect(await fields()).toEqual({ composer: '', notes: '', rich: '', sent: [] })
  })

  it("types the line break as Shift+Enter in the chat composer: both lines stay, nothing is sent", async () => {
    const composer = refOf(look, /textbox "Message"/)
    const result = await executor.execute(`await act.type(${composer}, 'Line 1\\nLine 2', { newline: 'Shift+Enter' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/typed 1 line break as Shift\+Enter/)
    expect(result.text).toMatch(/value read back: "Line 1\nLine 2"/)
    expect(result.text).not.toMatch(/differs from what was typed/)
    const now = await fields()
    expect(now.composer).toBe('Line 1\nLine 2')
    expect(now.sent).toEqual([])
  })

  it('inserts text with a line break with { paste: true }: no key events, nothing sent', async () => {
    const composer = refOf(look, /textbox "Message"/)
    const result = await executor.execute(`await act.fill(${composer}, 'Line A\\nLine B', { paste: true })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).not.toMatch(/differs from what was typed/)
    const now = await fields()
    expect(now.composer).toBe('Line A\nLine B')
    expect(now.sent).toEqual([])
  })

  it('types the line break as Enter in a plain text area', async () => {
    const notes = refOf(look, /textbox "Notes"/)
    const result = await executor.execute(`await act.type(${notes}, 'Line 1\\nLine 2', { newline: 'Enter' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/typed 1 line break as Enter/)
    expect(result.text).not.toMatch(/differs from what was typed/)
    expect((await fields()).notes).toBe('Line 1\nLine 2')
  })

  it('counts \\r\\n and \\r as one line break each and reads the value back against \\n', async () => {
    const notes = refOf(look, /textbox "Notes"/)
    const result = await executor.execute(`await act.fill(${notes}, 'x\\r\\ny\\rz', { newline: 'Enter' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/typed 2 line breaks as Enter/)
    expect(result.text).not.toMatch(/differs from what was typed/)
    expect((await fields()).notes).toBe('x\ny\nz')
  })

  it('refuses a newline key other than Enter / Shift+Enter, and newline with paste, before any input', async () => {
    const notes = refOf(look, /textbox "Notes"/)
    const tab = await executor.execute(`await act.type(${notes}, 'a\\nb', { newline: 'Tab' })`, 60000)
    expect(tab.isError).toBe(true)
    expect(tab.text).toMatch(/newline must be 'Enter' or 'Shift\+Enter' \(got "Tab"\)/)
    const both = await executor.execute(`await act.type(${notes}, 'a\\nb', { newline: 'Enter', paste: true })`, 60000)
    expect(both.isError).toBe(true)
    expect(both.text).toMatch(/paste types no keys/)
    expect((await fields()).notes).toBe('x\ny\nz')
  })

  it('types the line break as Shift+Enter in a contenteditable composer: both lines stay unsent', async () => {
    const rich = refOf(look, /textbox "Rich message"/)
    const result = await executor.execute(`await act.type(${rich}, 'Line 1\\nLine 2', { newline: 'Shift+Enter' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/typed 1 line break as Shift\+Enter/)
    expect(result.text).not.toMatch(/differs from what was typed/)
    const now = await fields()
    expect(now.rich).toBe('Line 1\nLine 2')
    expect(now.sent).toEqual([])
  })

  it('reads a paragraph editor back line by line: a <p> per line and a blank line read as typed', async () => {
    const doc = refOf(look, /textbox "Document"/)
    const result = await executor.execute(`await act.type(${doc}, 'Line 1\\nLine 2\\n\\nLine 4', { newline: 'Enter' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/typed 3 line breaks as Enter/)
    expect(result.text).toMatch(/value read back: "Line 1\nLine 2\n\nLine 4"/)
    expect(result.text).not.toMatch(/differs from what was typed/)
    const html = await executor.execute("return await readPage(() => document.getElementById('doc').innerHTML)", 30000)
    expect(html.text).toContain('<p>Line 1</p><p>Line 2</p><p><br></p><p>Line 4</p>')
  })

  /** A field's value as the page has it: `value` for a textarea, the lines of a contenteditable's blocks otherwise. */
  async function valueOf(id: string): Promise<string> {
    const result = await executor.execute(
      `return await readPage(() => { const el = document.getElementById('${id}'); return JSON.stringify(el.localName === 'textarea' ? el.value : [...el.children].map((block) => block.textContent).join('\\n')) })`,
      30000,
    )
    expect(result.isError, result.text).toBe(false)
    return JSON.parse(result.text.slice(result.text.indexOf('"'), result.text.lastIndexOf('"') + 1))
  }

  it('appends after the whole text of a text area clicked on its middle line, not after that line', async () => {
    const draft = refOf(look, /textbox "Draft"/)
    const result = await executor.execute(`await act.type(${draft}, ' four')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/put the caret after the text with Ctrl\+End/)
    expect(result.text).not.toMatch(/differs from what was typed/)
    expect(await valueOf('draft')).toBe('one\ntwo\nthree four')
  })

  it('appends after the whole text of a contenteditable clicked on its middle line', async () => {
    const memo = refOf(look, /textbox "Memo"/)
    const result = await executor.execute(`await act.type(${memo}, ' four')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).not.toMatch(/differs from what was typed/)
    expect(await valueOf('memo')).toBe('one\ntwo\nthree four')
  })

  it('fill replaces every block of a multi-paragraph contenteditable', async () => {
    const letter = refOf(look, /textbox "Letter"/)
    const result = await executor.execute(`await act.fill(${letter}, 'Hi Ann\\nBye', { newline: 'Enter' })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/replaced the previous value "Dear Ann,\nSee you\.\nBob"/)
    expect(result.text).toMatch(/value read back: "Hi Ann\nBye"/)
    expect(await valueOf('letter')).toBe('Hi Ann\nBye')
  })

  it('refuses to append or replace when the app swallows the caret and select-all chords, and types nothing', async () => {
    const snippet = refOf(look, /textbox "Snippet"/)
    const append = await executor.execute(`await act.type(${snippet}, ' four')`, 60000)
    expect(append.isError).toBe(true)
    expect(append.text).toMatch(new RegExp(`pressed Ctrl\\+End in \\[${snippet}\\] textbox "Snippet" to put the caret after its text, but the caret is not at the end`))
    expect(append.text).toMatch(/Nothing was typed\./)
    const replace = await executor.execute(`await act.fill(${snippet}, 'five')`, 60000)
    expect(replace.isError).toBe(true)
    expect(replace.text).toMatch(new RegExp(`pressed Ctrl\\+A in \\[${snippet}\\] textbox "Snippet" to select its text for replacing, but not all of it is selected`))
    expect(await valueOf('shortcuts')).toBe('one\ntwo\nthree')
  })

  /** A contenteditable's text as the page renders it (innerText, trimmed). */
  async function textOf(id: string): Promise<string> {
    const result = await executor.execute(`return await readPage(() => JSON.stringify(document.getElementById('${id}').innerText.trim()))`, 30000)
    expect(result.isError, result.text).toBe(false)
    return JSON.parse(result.text.slice(result.text.indexOf('"'), result.text.lastIndexOf('"') + 1))
  }

  it('replaces the text of a ProseMirror-like editor whose select-all ends after its last block', async () => {
    const prose = refOf(look, /textbox "Prose"/)
    const result = await executor.execute(`await act.fill(${prose}, 'Hi Ann')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/replaced the previous value "Dear Ann,\nBob"/)
    expect(await textOf('pm')).toBe('Hi Ann')
  })

  it('appends to and replaces content that ends in an <hr>, where Chrome’s Ctrl+End and Ctrl+A end at the editor', async () => {
    const ruled = refOf(look, /textbox "Ruled"/)
    const append = await executor.execute(`await act.type(${ruled}, 'more')`, 60000)
    expect(append.isError, append.text).toBe(false)
    expect(append.text).toMatch(/put the caret after the text with Ctrl\+End/)
    expect(await textOf('rule')).toMatch(/^Hello\n+more$/)
    const replace = await executor.execute(`await act.fill(${ruled}, 'Bye')`, 60000)
    expect(replace.isError, replace.text).toBe(false)
    expect(await textOf('rule')).toBe('Bye')
  })

  it('reads indented markup without its unshown trailing space: appends after it and replaces it', async () => {
    const indented = refOf(look, /textbox "Indented"/)
    const append = await executor.execute(`await act.type(${indented}, ' again')`, 60000)
    expect(append.isError, append.text).toBe(false)
    expect(append.text).toMatch(/value read back: "Hello world again"/)
    const card = refOf(look, /textbox "Card"/)
    const replace = await executor.execute(`await act.fill(${card}, 'Hi')`, 60000)
    expect(replace.isError, replace.text).toBe(false)
    expect(replace.text).toMatch(/replaced the previous value "Dear Ann,\nHello there"/)
    expect(await textOf('card')).toBe('Hi')
  })
})

describe('act.drag between points of an element', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-drag.html')
    look = (await executor.execute('await observe({ all: true })', 30000)).text
  })

  async function logOf(id: string): Promise<string> {
    const result = await executor.execute(`return await readPage(() => 'LOG<' + document.getElementById('${id}').textContent + '>')`, 30000)
    expect(result.isError, result.text).toBe(false)
    return /LOG<([^>]*)>/.exec(result.text)?.[1] ?? ''
  }

  function near(actual: number, expected: number): void {
    expect(Math.abs(actual - expected), `${actual} is not within 1px of ${expected}`).toBeLessThanOrEqual(1)
  }

  /** The `down x y` and `up x y` the pad `id` logged, last of each. */
  async function padEvents(id: string): Promise<{ down: Point; up: Point }> {
    const log = await logOf('pads-log')
    const last = (type: string): Point => {
      const all = [...log.matchAll(new RegExp(`${id} ${type} ([\\d.]+) ([\\d.]+)`, 'g'))]
      const match = all.at(-1)
      expect(match, `${id} logged no ${type}: ${log}`).toBeDefined()
      return { x: Number(match?.[1]), y: Number(match?.[2]) }
    }
    return { down: last('down'), up: last('up') }
  }

  it('draws a stroke on a canvas: down at the first point, held-button moves, up at the second', async () => {
    const sketch = refOf(look, /image "Sketch"/)
    const result = await executor.execute(`await act.drag({ ref: ${sketch}, x: 20, y: 30 }, { ref: ${sketch}, x: 260, y: 140 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain(`from (20, 30) in [${sketch}] image "Sketch" to (260, 140) in [${sketch}] image "Sketch"`)
    const events = (await logOf('log')).split('; ').map((line) => {
      const [type, x, y, buttons] = line.split(' ')
      return { type, x: Number(x), y: Number(y), buttons: Number(buttons) }
    })
    const down = events.findIndex((event) => event.type === 'down')
    const up = events.findIndex((event) => event.type === 'up')
    expect(down, JSON.stringify(events)).toBeGreaterThanOrEqual(0)
    expect(up).toBeGreaterThan(down)
    near(events[down].x, 20)
    near(events[down].y, 30)
    near(events[up].x, 260)
    near(events[up].y, 140)
    const held = events.slice(down + 1, up)
    expect(held.length).toBeGreaterThan(3)
    expect(held.every((event) => event.type === 'move' && event.buttons === 1), JSON.stringify(held)).toBe(true)
  })

  it('drags between points by the page’s top-left edge, where the page cannot scroll any further', async () => {
    const edge = refOf(look, /image "Edge pad"/)
    const result = await executor.execute(`await act.drag({ ref: ${edge}, x: 3, y: 3 }, { ref: ${edge}, x: 290, y: 27 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).not.toMatch(/scrolled with the mouse wheel/)
    const { down, up } = await padEvents('edge')
    near(down.x, 3)
    near(down.y, 3)
    near(up.x, 290)
    near(up.y, 27)
  })

  it('sets a custom slider by dragging its thumb to a point on the track', async () => {
    const volume = refOf(look, /slider "Volume"/)
    const track = refOf(look, /image "Volume track"/)
    const result = await executor.execute(`await act.drag(${volume}, { ref: ${track}, x: 300, y: 12 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    const value = await executor.execute("return await readPage(() => 'V=' + document.getElementById('thumb').getAttribute('aria-valuenow'))", 30000)
    const now = Number(/V=(\d+)/.exec(value.text)?.[1])
    expect(Math.abs(now - 75), value.text).toBeLessThanOrEqual(1)
  })

  it('still drags from a ref onto a ref (the centre of each)', async () => {
    const volume = refOf(look, /slider "Volume"/)
    const track = refOf(look, /image "Volume track"/)
    const result = await executor.execute(`await act.drag(${volume}, ${track})`, 60000)
    expect(result.isError, result.text).toBe(false)
    const value = await executor.execute("return await readPage(() => 'V=' + document.getElementById('thumb').getAttribute('aria-valuenow'))", 30000)
    const now = Number(/V=(\d+)/.exec(value.text)?.[1])
    expect(Math.abs(now - 50), value.text).toBeLessThanOrEqual(4)
  })

  it('refuses a point outside the box, naming its size, and a malformed point, before any input', async () => {
    const sketch = refOf(look, /image "Sketch"/)
    const before = await logOf('log')
    const outside = await executor.execute(`await act.drag({ ref: ${sketch}, x: 300, y: 10 }, { ref: ${sketch}, x: 20, y: 20 })`, 60000)
    expect(outside.isError).toBe(true)
    expect(outside.text).toContain(`[${sketch}] image "Sketch" is 300×150 px: x must be from 0 up to, not including, 300, and y from 0 up to, not including, 150 (got 300, 10)`)
    const notFinite = await executor.execute(`await act.drag({ ref: ${sketch}, x: NaN, y: 10 }, { ref: ${sketch}, x: 20, y: 20 })`, 60000)
    expect(notFinite.isError).toBe(true)
    expect(notFinite.text).toMatch(/x and y must be finite numbers/)
    const noRef = await executor.execute(`await act.drag({ x: 10, y: 10 }, { ref: ${sketch}, x: 20, y: 20 })`, 60000)
    expect(noRef.isError).toBe(true)
    expect(noRef.text).toMatch(/act\.drag: from must be a ref .* or \{ ref, x, y \}/)
    expect(await logOf('log')).toBe(before)
  })

  it('refuses a from-point something else covers, naming the cover, and presses nothing', async () => {
    const sketch = refOf(look, /image "Sketch"/)
    const before = await logOf('log')
    const covered = await executor.execute(`await act.drag({ ref: ${sketch}, x: 280, y: 10 }, { ref: ${sketch}, x: 20, y: 20 })`, 60000)
    expect(covered.isError).toBe(true)
    expect(covered.text).toContain(`at (280, 10) [${sketch}] image "Sketch" is covered by div#sticker`)
    expect((await logOf('log')).slice(before.length)).not.toMatch(/down/)
  })

  it('maps points through a CSS rotation: the page sees them in the element’s own box', async () => {
    const dial = refOf(look, /image "Dial"/)
    const result = await executor.execute(`await act.drag({ ref: ${dial}, x: 20, y: 30 }, { ref: ${dial}, x: 180, y: 80 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    const match = /down ([\d.]+) ([\d.]+); up ([\d.]+) ([\d.]+)/.exec(await logOf('dial-log'))
    expect(match).not.toBeNull()
    const [, downX, downY, upX, upY] = (match ?? []).map(Number)
    near(downX, 20)
    near(downY, 30)
    near(upX, 180)
    near(upY, 80)
  })

  it('maps points through a perspective tilt: the page sees them in the element’s own box', async () => {
    const tilted = refOf(look, /image "Tilted pad"/)
    const result = await executor.execute(`await act.drag({ ref: ${tilted}, x: 75, y: 50 }, { ref: ${tilted}, x: 225, y: 80 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    const { down, up } = await padEvents('tilt')
    near(down.x, 75)
    near(down.y, 50)
    near(up.x, 225)
    near(up.y, 80)
  })

  it('drags from the bottom of the last row of a list scrolled to its end', async () => {
    const row = refOf(look, /image "Last row"/)
    const result = await executor.execute(`await act.drag({ ref: ${row}, x: 150, y: 27 }, { ref: ${row}, x: 20, y: 3 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    const { down, up } = await padEvents('last-row')
    near(down.x, 150)
    near(down.y, 27)
    near(up.x, 20)
    near(up.y, 3)
  })

  it('wheels the requested point into view when it is off screen, though the element’s top is in view', async () => {
    const tall = refOf(look, /image "Tall pad"/)
    const result = await executor.execute(`await act.drag({ ref: ${tall}, x: 150, y: 1300 }, { ref: ${tall}, x: 200, y: 1320 })`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/scrolled with the mouse wheel to reach it/)
    const match = /down ([\d.]+) ([\d.]+)/.exec(await logOf('tall-log'))
    expect(match).not.toBeNull()
    near(Number(match?.[1]), 150)
    near(Number(match?.[2]), 1300)
  })

  it('clicks on a scrolled page: the hit test is at the point the pointer is', async () => {
    // The page is scrolled down by the drag above; the pad is under the pointer's point only in viewport coordinates.
    const tall = refOf(look, /image "Tall pad"/)
    const result = await executor.execute(`await act.click(${tall})`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/text: "down [\d.]+ [\d.]+"/)
  })
})
