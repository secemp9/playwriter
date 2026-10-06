/**
 * Getting the files the page produced, end to end through the real executor on headless Chromium:
 * a download a click started (in a popup, failed, still running) saved with `downloads.save(id, path)`,
 * and the whole body of a response the page loaded saved with `net.save(id, path)` — both inside the
 * sandbox fs jail, in human mode and in debug mode.
 *
 * Every assertion is on what the MODEL reads, or on the file it was told it got.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const PAGE = `<!doctype html>
<html><head><title>Exports</title></head>
<body>
  <main>
    <h1>Exports</h1>
    <p><a href="/export" target="_blank">Export CSV</a></p>
    <p><a href="/broken-export">Broken export</a></p>
    <p><a href="/slow-export">Slow export</a></p>
  </main>
</body></html>`

const GALLERY = `<!doctype html>
<html><head><title>Gallery</title></head>
<body>
  <main>
    <h1>Gallery</h1>
    <img src="/old.png" alt="Chart" width="40" height="40">
  </main>
</body></html>`

const CSV = 'id,total\n1,42\n'

/** A PNG chunk: length, type, data, CRC of type and data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/**
 * A real 256×128 RGB PNG of random pixels (~98KB): it decodes, so Chrome keeps its body, and it is
 * far past net.request's 64K-character cap — only a byte-exact save reproduces it.
 */
const BIG = (() => {
  const width = 256
  const height = 128
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), crypto.randomBytes(width * 3)]))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
})()

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []
/** The slow export's response, held open until a test ends it. */
let slowExport: http.ServerResponse | null = null

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/export') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' })
      res.end(CSV)
      return
    }
    if (url.pathname === '/broken-export') {
      // Promises far more than it sends, then drops the connection: Chrome fails the download.
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="broken.csv"', 'Content-Length': '100000' })
      res.write('id,total\n', () => res.socket?.destroy())
      return
    }
    if (url.pathname === '/slow-export') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="slow.csv"' })
      res.write('id,total\n')
      slowExport = res
      return
    }
    if (url.pathname === '/old.png') {
      res.writeHead(302, { Location: '/big.png' })
      res.end()
      return
    }
    if (url.pathname === '/big.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(BIG.length) })
      res.end(BIG)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(url.pathname === '/gallery' ? GALLERY : PAGE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-downloads-'))
})

afterAll(async () => {
  slowExport?.end()
  for (const executor of executors) {
    await executor.closeHeadlessContext().catch(() => {})
  }
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  server.closeAllConnections()
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

/** A fresh session on `pathname` of the fixture, with what the model saw on it. */
async function openFixture(policy: 'human' | 'debug', pathname = '/'): Promise<{ executor: PlaywrightExecutor; observation: string }> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const load = await executor.execute(`await page.goto('${baseUrl}${pathname}', { waitUntil: 'load' })`, 30000)
  expect(load.isError, load.text).toBe(false)
  const look = await executor.execute('await observe()', 30000)
  expect(look.isError, look.text).toBe(false)
  return { executor, observation: look.text }
}

/** The ref printed in front of the first line matching `pattern`, e.g. `[12] link "Export CSV"`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

/** What the code returned, as the model reads it after `[return value]`. */
function returned(text: string): string {
  const match = /\[return value\] ([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`no return value in:\n${text}`)
  return match[1]!.trim()
}

describe.each(['human', 'debug'] as const)('downloads.save in %s mode', (policy) => {
  it('saves a download made in a popup into the session folder, and the code reads it back', async () => {
    const { executor, observation } = await openFixture(policy)
    const exportLink = refOf(observation, /link "Export CSV"/)
    const clicked = await executor.execute(`await act.click(${exportLink})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/DOWNLOAD \[d1\] report\.csv from .*\/export — completed → downloads\.save\('d1', 'report\.csv'\) saves it into the session folder/)

    const target = `${policy}/report.csv`
    const saved = await executor.execute(
      `const saved = await downloads.save('d1', '${target}')\nreturn JSON.stringify({ saved, text: require('node:fs').readFileSync(saved.path, 'utf8'), list: downloads.list() })`,
      30000,
    )
    expect(saved.isError, saved.text).toBe(false)
    const { saved: info, text, list } = JSON.parse(returned(saved.text))
    expect(info).toEqual({ id: 'd1', file: 'report.csv', path: path.join(cwd, target), bytes: CSV.length })
    expect(text).toBe(CSV)
    expect(fs.readFileSync(path.join(cwd, target), 'utf8')).toBe(CSV)
    expect(list).toEqual([{ id: 'd1', file: 'report.csv', url: `${baseUrl}/export`, state: 'completed' }])
  })

  it('refuses to save outside the sandbox fs jail, and says where it may go', async () => {
    const { executor, observation } = await openFixture(policy)
    const clicked = await executor.execute(`await act.click(${refOf(observation, /link "Export CSV"/)})`, 30000)
    expect(clicked.text).toMatch(/DOWNLOAD \[d1\] report\.csv .* — completed/)
    const outside = path.join(path.parse(cwd).root, 'etc', 'playwriter-download-probe.csv')
    const refused = await executor.execute(`await downloads.save('d1', ${JSON.stringify(outside)})`, 30000)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain(
      `downloads.save('d1', path): ${outside} is outside the folders this session may write to (${[...new Set([cwd, '/tmp', os.tmpdir()])].join(', ')})`,
    )
    expect(refused.text).toContain("like downloads.save('d1', 'report.csv'). Nothing was saved.")
    expect(refused.text).not.toMatch(/HINT|at .*\.ts:\d+/)
    expect(fs.existsSync(outside)).toBe(false)
  })

  it('reports a failed download as failed and refuses to save it', async () => {
    const { executor, observation } = await openFixture(policy)
    const clicked = await executor.execute(`await act.click(${refOf(observation, /link "Broken export"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/DOWNLOAD \[d1\] broken\.csv from .*\/broken-export — FAILED: .+ \(no file to save\)/)
    const refused = await executor.execute(`await downloads.save('d1', '${policy}/broken.csv')`, 30000)
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/Download d1 \(broken\.csv\) failed \(.+\), so there is no file to save\. Nothing was saved\./)
    expect(fs.existsSync(path.join(cwd, policy, 'broken.csv'))).toBe(false)
  })
})

describe('downloads.save on a download still running', () => {
  it('waits within the call, says it is still downloading, and saves it once it finished', async () => {
    const { executor, observation } = await openFixture('human')
    const clicked = await executor.execute(`await act.click(${refOf(observation, /link "Slow export"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(
      /DOWNLOAD \[d1\] slow\.csv from .*\/slow-export — still downloading when this report was written \(\d+ms later\) → downloads\.save\('d1', 'slow\.csv'\) waits for it/,
    )

    // A real 3s call deadline on purpose: /slow-export is held open until slowExport.end() below, so
    // save() has to wait out this call's own time and then answer "still downloading" within it.
    const early = await executor.execute("await downloads.save('d1', 'slow.csv')", 3000)
    expect(early.isError).toBe(true)
    expect(early.text).toMatch(/Download d1 \(slow\.csv\) is still downloading: it did not finish in the \d+ms left in this call\. Nothing was saved\./)
    expect(fs.existsSync(path.join(cwd, 'slow.csv'))).toBe(false)

    slowExport?.end('1,42\n')
    const saved = await executor.execute("const saved = await downloads.save('d1', 'slow.csv')\nreturn saved.bytes", 30000)
    expect(saved.isError, saved.text).toBe(false)
    expect(fs.readFileSync(path.join(cwd, 'slow.csv'), 'utf8')).toBe(CSV)
  })

  it('names the downloads it has when the id is unknown', async () => {
    const { executor } = await openFixture('human')
    const none = await executor.execute("await downloads.save('d1', 'x.csv')", 30000)
    expect(none.isError).toBe(true)
    expect(none.text).toContain('No download d1: no download has been seen in this session yet.')
  })
})

describe.each(['human', 'debug'] as const)('net.save in %s mode', (policy) => {
  it('saves the whole body of an image the page loaded, byte for byte, where net.request is capped', async () => {
    const { executor } = await openFixture(policy, '/gallery')
    const listed = await executor.execute(
      "const [image] = await net.requests({ urlIncludes: '/big.png' })\nconst capped = await net.request(image.id)\nreturn JSON.stringify({ id: image.id, truncated: capped.truncated })",
      30000,
    )
    expect(listed.isError, listed.text).toBe(false)
    const { id, truncated } = JSON.parse(returned(listed.text))
    expect(truncated, listed.text).toBe(true)

    const saved = await executor.execute(`return JSON.stringify(await net.save('${id}', '${policy}/chart.png'))`, 30000)
    expect(saved.isError, saved.text).toBe(false)
    expect(JSON.parse(returned(saved.text))).toEqual({ id, path: path.join(cwd, policy, 'chart.png'), bytes: BIG.length, status: 200, mimeType: 'image/png' })
    expect(fs.readFileSync(path.join(cwd, policy, 'chart.png')).equals(BIG)).toBe(true)

    // A folder that cannot be made (chart.png is a file): the model reads which path and why, not a stack and a reset hint.
    const inner = path.join(cwd, policy, 'chart.png', 'inner.png')
    const unwritable = await executor.execute(`await net.save('${id}', '${policy}/chart.png/inner.png')`, 30000)
    expect(unwritable.isError).toBe(true)
    expect(unwritable.text).toMatch(new RegExp(`net\\.save\\('${id}', path\\): writing ${inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed: E[A-Z]+: .*\\. Nothing was saved\\.`))
    expect(unwritable.text).not.toMatch(/HINT|\n\s+at /)
  })

  it("refuses outside the jail, and a request with no body with the journal's reason", async () => {
    const { executor } = await openFixture(policy, '/gallery')
    const listed = await executor.execute("const [redirect] = await net.requests({ urlIncludes: '/old.png' })\nreturn redirect.id", 30000)
    expect(listed.isError, listed.text).toBe(false)
    const redirect = returned(listed.text)

    const outside = path.join(path.parse(cwd).root, 'etc', 'playwriter-net-probe.png')
    const jailed = await executor.execute(`await net.save('${redirect}', ${JSON.stringify(outside)})`, 30000)
    expect(jailed.isError).toBe(true)
    expect(jailed.text).toContain(`net.save('${redirect}', path): ${outside} is outside the folders this session may write to`)
    expect(fs.existsSync(outside)).toBe(false)

    const noBody = await executor.execute(`await net.save('${redirect}', '${policy}/old.png')`, 30000)
    expect(noBody.isError).toBe(true)
    expect(noBody.text).toMatch(
      new RegExp(`Request ${redirect} \\(GET ${baseUrl}/old\\.png\\) was answered with a redirect \\(HTTP 302\\) to \\S+; a redirect has no body\\. Read \\S+\\. Nothing was saved\\.`),
    )
    expect(noBody.text).not.toMatch(/HINT/)
    expect(fs.existsSync(path.join(cwd, policy, 'old.png'))).toBe(false)
  })
})
