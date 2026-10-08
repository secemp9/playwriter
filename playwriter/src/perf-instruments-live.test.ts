/**
 * Read-only performance instruments in a real headless Chrome, driven through the executor the way a
 * model drives it: `perf.vitals()` (never reloading), `perf.metrics()`, `perf.trace.*`,
 * `perf.profile.*`, `pdf()`, the SHIFT line of an action report, and raw CDP reads in human mode.
 * Pages: the lab's vitals.html (hero image, a banner inserted 600 ms after load, a 300 ms click
 * handler) and perf-shift.html (a banner the server's late answer inserts, an afterprint handler).
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

/**
 * A 600×250 PNG of random pixels. Chrome leaves low-entropy images (a flat gradient) out of LCP, so
 * the hero must carry real image data; random bytes do not compress, which makes it ≈450 KB.
 */
function noisePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(2, 9)
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let index = 0; index < rows.length; index++) rows[index] = index % (width * 3 + 1) === 0 ? 0 : Math.floor(Math.random() * 256)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  const hero = noisePng(600, 250)
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/lab/hero.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(hero)
      return
    }
    if (url.pathname === '/slow-offers') {
      // The page's own late answer; real time on purpose: the browser waits for it on its own clock.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"offers":1}')
      }, 900)
      return
    }
    const file = path.join(LAB, path.normalize(url.pathname).replace(/^\/+/, ''))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'
    res.writeHead(200, { 'Content-Type': type })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-instruments-'))
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

async function open(policy: 'human' | 'debug', at: string): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}${at}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

async function run(executor: PlaywrightExecutor, code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
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

/** Polls the page (read-only) until `condition` is true: the page's own timers decide when that is. */
async function untilPage(executor: PlaywrightExecutor, condition: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await run(executor, `return await readPage(() => ${condition})`)).includes('true')) return
  }
  throw new Error(`the page never satisfied ${condition}`)
}

describe('perf.* and pdf() in human mode', () => {
  let human: PlaywrightExecutor
  beforeAll(async () => {
    human = await open('human', '/vitals.html')
    // The banner the page inserts 600 ms after load is the layout shift CLS must report.
    await untilPage(human, "!!document.getElementById('promo')")
  }, 60000)

  it('perf.vitals() reads LCP with its element, CLS with the shifted nodes, and never reloads', async () => {
    const before = await run(human, 'return await readPage(() => performance.timeOrigin)')
    const text = await run(human, 'await perf.vitals()')
    expect(text).toContain('nothing reloaded')
    expect(text).toMatch(/TTFB {2}\d+ ms \(good\)/)
    expect(text).toMatch(/FCP {3}\d+ ms \(good\)/)
    expect(text).toMatch(/LCP {3}\d+ ms \(good\) — \[\d+\] image "Gradient hero banner" · resource http:\/\/127\.0\.0\.1:\d+\/lab\/hero\.png/)
    expect(text).toMatch(/CLS {3}0\.\d{3} \(\w[\w ]*\) — its largest burst: 1 shift of 1 without recent input/)
    expect(text).toMatch(/at \d+ ms: moved down \d+px: .*image "Gradient hero banner"/)
    expect(text).toMatch(/INP {3}unknown: no interaction/)
    const after = await run(human, 'return await readPage(() => performance.timeOrigin)')
    expect(after).toBe(before)
    // Nothing of playwriter's in the page's own realm.
    const globals = await run(human, "return await readPage(() => Object.getOwnPropertyNames(window).filter((name) => /playwriter/i.test(name)).join(',') || 'none')")
    expect(globals).toContain('none')
    // Reading the timeline is no user gesture: the page still counts as never clicked.
    expect(await run(human, 'return await readPage(() => navigator.userActivation.hasBeenActive)')).toContain('[return value] false')
  }, 60000)

  it('after a click, INP names the interaction and its target, and the long animation frame its script', async () => {
    // The page's own metrics card is still updating after load: a person waits for it to settle.
    await run(human, 'await act.waitForIdle()')
    const found = await run(human, "await find('Run heavy task')")
    const heavy = refOf(found, /Run heavy task/)
    await run(human, `await act.click(${heavy})`)
    const text = await run(human, 'await perf.vitals()')
    // The handler busy-waits 300 ms, so each duration is at least that; a loaded machine makes it longer
    // (419 ms measured in a full-suite run), and another long task may then be the longest.
    const atLeast300 = '(?:[3-9]\\d\\d|\\d{4,})'
    expect(text).toMatch(new RegExp(`INP {3}${atLeast300} ms \\((needs improvement|poor)\\) over 1 measured interaction — [\\w/]*click[\\w/]* on \\[${heavy}\\] button "Run heavy task \\(300 ms\\)"`))
    // web-vitals' attribution over all the interaction's events: the 300 ms handler is processing, not presentation.
    expect(text).toMatch(new RegExp(`input delay \\d+ ms, processing ${atLeast300} ms \\(click ${atLeast300} ms\\), presentation \\d+ ms`))
    expect(text).toMatch(/LONG TASKS {2}[1-9]\d*, longest \d+ ms/)
    expect(text).toMatch(new RegExp(`${atLeast300} ms at \\d+ ms \\(blocking \\d+ ms\\) — script BUTTON#heavy\\.onclick`))
  }, 60000)

  it('perf.metrics() prints Chrome\'s counters', async () => {
    const text = await run(human, 'const m = await perf.metrics()\nreturn [m.Nodes > 0, m.JSHeapUsedSize > 0]')
    expect(text).toMatch(/METRICS [^\n]*a first call reads about 0 for them[^\n]*\n {2}.*Nodes \d+/)
    expect(text).toMatch(/JSHeapUsedSize \d+\.\d MB/)
    expect(text).toContain('[ true, true ]')
  }, 60000)

  it('perf.trace records a Chrome trace and summarises the long task with its trigger', async () => {
    const started = await run(human, 'await perf.trace.start()')
    expect(started).toContain('TRACE   recording')
    const found = await run(human, "await find('Run heavy task')")
    await run(human, `await act.click(${refOf(found, /Run heavy task/)})`)
    const text = await run(human, "await perf.trace.stop({ path: 'heavy-trace.json' })")
    expect(text).toMatch(/TRACE {3}saved .*heavy-trace\.json — \d+\.\d MB, \d+ events/)
    expect(text).toContain("the page's renderer main thread")
    expect(text).toMatch(/LONG TASKS {2}[1-9]\d* of 50 ms or more/)
    expect(text).toMatch(/3\d\d ms at \+\d+ ms — EventDispatch click/)
    const saved = JSON.parse(fs.readFileSync(path.join(cwd, 'heavy-trace.json'), 'utf8'))
    expect(Array.isArray(saved.traceEvents)).toBe(true)
    const again = await human.execute("await perf.trace.stop({ path: 'x.json' })", 30000)
    expect(again.isError).toBe(true)
    expect(again.text).toContain('no trace is running in this tab')
  }, 60000)

  it('perf.profile records a CPU profile and lists the busy function by self time', async () => {
    await run(human, 'await perf.profile.start()')
    const found = await run(human, "await find('Run heavy task')")
    await run(human, `await act.click(${refOf(found, /Run heavy task/)})`)
    const text = await run(human, "await perf.profile.stop({ path: 'heavy.cpuprofile' })")
    expect(text).toMatch(/PROFILE saved .*heavy\.cpuprofile — \d+ samples over \d+ ms/)
    expect(text).toMatch(/TOP SELF TIME/)
    // The busy loop's self time is in the page's handler, or in the wrapper V8 inlined it into.
    expect(text).toMatch(/\d+(\.\d)? ms \(\d+(\.\d)?%\) .* — http:\/\/127\.0\.0\.1:\d+\/(vitals\.html|lab\/witness\.js):\d+:\d+/)
    const saved = JSON.parse(fs.readFileSync(path.join(cwd, 'heavy.cpuprofile'), 'utf8'))
    expect(Array.isArray(saved.nodes)).toBe(true)
  }, 60000)

  it('raw CDP: the Performance, Profiler and Tracing reads pass the human-mode session; *.disable does not', async () => {
    const reads = await run(
      human,
      "const cdp = await getCDPSession({ page })\nawait cdp.send('Performance.enable')\nconst { metrics } = await cdp.send('Performance.getMetrics')\n" +
        "await cdp.send('Profiler.enable')\nreturn metrics.length > 0",
    )
    expect(reads).toContain('true')
    const disable = await human.execute("const cdp = await getCDPSession({ page })\nawait cdp.send('Performance.disable')", 30000)
    expect(disable.isError).toBe(true)
    expect(disable.text).toContain("Refused (human mode): getCDPSession().send('Performance.disable') is not a read")
  }, 60000)
})

describe('the SHIFT line and pdf()', () => {
  let human: PlaywrightExecutor
  beforeAll(async () => {
    human = await open('human', '/perf-shift.html')
  }, 60000)

  it('an action report names content that moved by itself, with refs', async () => {
    const observed = await run(human, 'await observe()')
    const load = refOf(observed, /button "Load offers"/)
    const report = await run(human, `await act.click(${load})`)
    expect(report).toMatch(
      new RegExp(`SHIFT {3}0\\.\\d{3} — moved down 1\\d\\dpx: [^\\n]*\\[${load}\\] button "Load offers"[^\\n]* — content moved by itself \\d\\.\\ds after the action began`),
    )
  }, 60000)

  it('pdf() saves the page and says the page saw a print and what its handlers changed', async () => {
    const text = await run(human, "await pdf({ path: 'offers.pdf', format: 'A4' })")
    expect(text).toMatch(/PDF {5}saved .*offers\.pdf — \d+ KB, 1 page, 8\.27×11\.7 in/)
    expect(text).toContain('The page saw a print, as when a person presses Ctrl+P')
    expect(text).toMatch(/its print handlers changed its content \(\d+ content mutations\)/)
    expect(fs.readFileSync(path.join(cwd, 'offers.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const observed = await run(human, 'await observe()')
    expect(observed).toContain('This page was printed')
  }, 60000)

  it('pdf() refuses what it cannot do, before printing', async () => {
    const format = await human.execute("await pdf({ path: 'x.pdf', format: 'B5' })", 30000)
    expect(format.isError).toBe(true)
    expect(format.text).toContain("pdf: `format` must be one of 'Letter', 'Legal', 'Tabloid', 'Ledger', 'A0'")
    const outside = await human.execute("await pdf({ path: '/etc/x.pdf' })", 30000)
    expect(outside.isError).toBe(true)
    expect(outside.text).toContain('is outside the folders this session may write to')
    const typo = await human.execute("await pdf({ path: 'x.pdf', landscap: true })", 30000)
    expect(typo.isError).toBe(true)
    expect(typo.text).toContain('pdf does not take `landscap`')
  }, 60000)

  it('pdf() on a page without print handlers says its content did not change, and is no user gesture', async () => {
    const fresh = await open('human', '/landing.html')
    const text = await run(fresh, "await pdf({ path: 'landing.pdf', landscape: true, printBackground: true, pageRanges: '1' })")
    expect(text).toMatch(/PDF {5}saved .*landing\.pdf — \d+ KB, 1 page, Chrome's default paper, 8\.5×11 in \(Letter\), landscape, with backgrounds, pages 1/)
    expect(text).toContain('its content did not change')
    expect(await run(fresh, 'return await readPage(() => navigator.userActivation.hasBeenActive)')).toContain('[return value] false')
  }, 60000)
})

describe('debug mode', () => {
  it('runs the same instruments and lets raw CDP read them', async () => {
    const debug = await open('debug', '/vitals.html')
    const text = await run(debug, 'await perf.vitals()\nconst cdp = await getCDPSession({ page })\nawait cdp.send("Performance.enable")\nreturn (await cdp.send("Performance.getMetrics")).metrics.length > 0')
    expect(text).toMatch(/LCP {3}\d+ ms/)
    expect(text).toContain('true')
  }, 60000)
})
