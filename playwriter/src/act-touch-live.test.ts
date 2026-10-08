/**
 * act on a touch device (`browser({ action: 'new', device: 'Pixel 7' })`): a person taps, double-taps,
 * drags with a finger and swipes. The fixture page records every input event it receives (type,
 * pointerType, trusted) and, per click, the mouse moves and mouseover targets since the previous one,
 * the way the lab witness counts them. Driven through the executor in human mode, headless.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

interface SeenEvent {
  type: string
  pointerType: string | null
  trusted: boolean
  target: string | null
  count: number
}

interface Seen {
  /** Events recorded from index `from` on (a mouse path is hundreds of them: only the new ones are read). */
  events: SeenEvent[]
  /** How many the page has recorded in all. */
  total: number
  lastClick: { target: string | null; pointerType: string | null; moves: number; entered: number; trusted: boolean } | null
}

let server: http.Server
let baseUrl = ''
let cwd = ''
let executor: PlaywrightExecutor

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(LAB, path.normalize(new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, ''))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'act-touch-'))
}, 60_000)

afterAll(async () => {
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

async function run(code: string): Promise<string> {
  const result = await executor.execute(code, 30_000)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

async function refused(code: string): Promise<string> {
  const result = await executor.execute(code, 30_000)
  expect(result.text).toMatch(/Not done/)
  return result.text
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

/** What the page saw from its `from`th event on (read from its own record; nothing clears it). */
async function seen(from: number): Promise<Seen> {
  const text = await run(
    "return await readPage(() => { const s = JSON.parse(document.getElementById('seen').textContent); " +
      `return JSON.stringify({ events: s.events.slice(${from}), total: s.events.length, lastClick: s.clicks.at(-1) ?? null }) })`,
  )
  const start = text.indexOf('[return value] ')
  expect(start, text).toBeGreaterThanOrEqual(0)
  return JSON.parse(text.slice(start + '[return value] '.length).trim())
}

/** How many events the page has recorded so far. */
async function recorded(): Promise<number> {
  return (await seen(Number.MAX_SAFE_INTEGER)).total
}

/** Events as `type:pointerType` tokens (a run of moves with its count). */
function tokens(events: SeenEvent[]): string[] {
  return events.map((event) => `${event.type}${event.pointerType ? `:${event.pointerType}` : ''}${event.count > 1 ? `×${event.count}` : ''}`)
}

describe.each(['human', 'fast'] as const)('act on a touch device (Pixel 7), %s mode', (policy) => {
  beforeAll(async () => {
    executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
    await executor.planNewBrowser({ device: 'Pixel 7' })
    await run(`await act.open('${baseUrl}/touch.html')`)
  }, 60_000)

  afterAll(async () => {
    await executor.disconnect()
  })

  it('act.click is a tap: touch events and pointerType touch, no pointer travelling before it', async () => {
    const page = await run('await observe()')
    const before = await recorded()
    const report = await run(`await act.click(${refOf(page, /button "Tap target"/)})`)
    expect(report).toContain('tapped with a finger')
    expect(report).not.toContain('pointer travelled')
    expect(report).toContain('Tapped 1')
    const after = await seen(before)
    const events = after.events
    // The sequence a real tap gives (measured with Chrome's touch emulation and Playwright's touchscreen.tap alike).
    expect(tokens(events)).toEqual([
      'pointerover:touch',
      'pointerdown:touch',
      'touchstart',
      'pointerup:touch',
      'pointerout:touch',
      'touchend',
      'mouseover',
      'mousemove',
      'mousedown',
      'mouseup',
      'click:touch',
    ])
    expect(events.every((event) => event.trusted)).toBe(true)
    expect(after.lastClick).toEqual({ target: 'tap', pointerType: 'touch', moves: 1, entered: 1, trusted: true })
  }, 60_000)

  it('act.dblclick is a double tap: two taps, then dblclick', async () => {
    const page = await run('await observe()')
    const before = await recorded()
    const report = await run(`await act.dblclick(${refOf(page, /button "Double tap target"/)})`)
    expect(report).toContain('double-tapped with a finger')
    expect(report).toContain('Double tapped')
    const events = tokens((await seen(before)).events)
    expect(events.filter((token) => token === 'touchstart')).toHaveLength(2)
    expect(events.filter((token) => token === 'click:touch')).toHaveLength(2)
    expect(events.at(-1)).toBe('dblclick')
    expect(events.some((token) => token.includes(':mouse') || token === 'wheel')).toBe(false)
  }, 60_000)

  it('act.hover and a right or middle click are refused, with the reason; nothing reaches the page', async () => {
    const page = await run('await observe()')
    const tapRef = refOf(page, /button "Tap target"/)
    const before = await recorded()
    expect(await refused(`await act.hover(${tapRef})`)).toContain('a finger does not hover')
    expect(await refused(`await act.click(${tapRef}, { button: 'right' })`)).toContain('long press')
    expect(await refused(`await act.click(${tapRef}, { button: 'middle' })`)).toContain('no middle button')
    expect(await recorded()).toBe(before)
  }, 60_000)

  it('act.drag is a finger drag: the slider follows pointermove events of pointerType touch', async () => {
    const page = await run('await observe({ all: true })')
    const slider = refOf(page, /slider "Volume"/)
    const before = await recorded()
    // From the thumb (the slider's left end) to 232 px of its 300 px width: value 80.
    const report = await run(`await act.drag({ ref: ${slider}, x: 15, y: 20 }, { ref: ${slider}, x: 232, y: 20 })`)
    expect(report).toContain('finger (touch screen) path')
    expect(report).toMatch(/slider "Volume": value "0" → "(7\d|8\d)"/)
    const events = tokens((await seen(before)).events)
    expect(events[0]).toBe('pointerover:touch')
    expect(events).toContain('touchstart')
    expect(events.some((token) => /^pointermove:touch/.test(token))).toBe(true)
    expect(events.some((token) => token.startsWith('mousemove') || token.includes(':mouse'))).toBe(false)
  }, 60_000)

  it('act.scroll swipes and a tap below the fold swipes to it first: no wheel, no mouse pointer', async () => {
    const before = await recorded()
    const scrolled = await run("await act.scroll('down')")
    console.log(`[act-touch-live] ${policy} mode, act.scroll('down'): ${scrolled.split('\n').find((line) => /scrolled the page/.test(line))?.trim()}`)
    expect(scrolled).toMatch(/scrolled the page \d+px/)
    const page = await run('await observe({ all: true })')
    const report = await run(`await act.click(${refOf(page, /button "Far target"/)})`)
    expect(report).toContain('scrolled with finger swipes to reach it')
    expect(report).toContain('Far target tapped')
    const events = tokens((await seen(before)).events)
    expect(events.some((token) => /^touchmove/.test(token))).toBe(true)
    expect(events).not.toContain('wheel')
    expect(events.some((token) => token.includes(':mouse'))).toBe(false)
    // The only mousemove is the one Chrome adds after the tap's touchend.
    const moves = events.filter((token) => token.startsWith('mousemove'))
    expect(moves).toEqual(['mousemove'])
    expect(events.indexOf('mousemove')).toBeGreaterThan(events.lastIndexOf('touchend'))
  }, 60_000)
})
