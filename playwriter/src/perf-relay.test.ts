/**
 * The read-only instruments through the real extension and relay (chrome.debugger — the way
 * Nourdine's Chrome is driven), in human mode, through the MCP server: Web Vitals from the isolated
 * world, Performance metrics, a Chrome trace streamed with IO.read, a CPU profile, a PDF, the SHIFT
 * line, and the raw CDP reads human mode now allows. Every assertion is on what the MODEL reads.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMCPClient } from './mcp-client.js'
import { cleanupTestContext, setupTestContext, testRelayPort, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)
const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

let testCtx: TestContext | null = null
let client: Client
let cleanup: (() => Promise<void>) | null = null
let server: http.Server
let baseUrl = ''
let outDir = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/slow-offers') {
      // The page's own late answer: the browser waits for it on its own clock.
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
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'
    res.writeHead(200, { 'Content-Type': type })
    res.end(fs.readFileSync(file))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-relay-'))
  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-perf-relay-', toggleExtension: true })
  const mcp = await createMCPClient({ port: TEST_PORT, policy: 'human' })
  client = mcp.client
  cleanup = mcp.cleanup
}, 600000)

afterAll(async () => {
  await cleanupTestContext(testCtx, cleanup)
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(outDir, { recursive: true, force: true })
})

async function execute(code: string): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name: 'execute', arguments: { code, timeout: 30000 } })
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('\n')
  return { text, isError: result.isError === true }
}

async function run(code: string): Promise<string> {
  const result = await execute(code)
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

describe('perf.* and pdf() through the extension relay', () => {
  it('perf.vitals() reads the page through chrome.debugger without reloading it', async () => {
    await run(`await page.goto('${baseUrl}/vitals.html', { waitUntil: 'load' })`)
    // The banner the page inserts 600 ms after load is the layout shift CLS must report.
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await run("return await readPage(() => !!document.getElementById('promo'))")).includes('true')) break
    }
    const origin = await run('return await readPage(() => performance.timeOrigin)')
    const text = await run('await perf.vitals()')
    expect(text).toContain('nothing reloaded')
    expect(text).toMatch(/FCP {3}\d+ ms/)
    expect(text).toMatch(/CLS {3}0\.\d{3} \(\w[\w ]*\) — its largest burst: 1 shift/)
    expect(await run('return await readPage(() => performance.timeOrigin)')).toBe(origin)
  }, 120000)

  it('records metrics, a Chrome trace and a CPU profile through chrome.debugger', async () => {
    expect(await run('await perf.metrics()')).toMatch(/METRICS [^\n]*\n {2}.*Nodes \d+/)
    await run('await perf.trace.start()')
    await run('await perf.profile.start()')
    await run('await act.waitForIdle()')
    const heavy = refOf(await run("await find('Run heavy task')"), /Run heavy task/)
    await run(`await act.click(${heavy})`)
    const trace = await run(`await perf.trace.stop({ path: '${outDir}/relay-trace.json' })`)
    expect(trace).toMatch(/TRACE {3}saved .*relay-trace\.json — \d+\.\d MB, \d+ events/)
    expect(trace).toMatch(/LONG TASKS {2}[1-9]\d* of 50 ms or more/)
    // The handler busy-waits 300 ms: at least that, longer on a loaded machine.
    expect(trace).toMatch(/(?:[3-9]\d\d|\d{4,}) ms at \+\d+ ms — EventDispatch click/)
    const profile = await run(`await perf.profile.stop({ path: '${outDir}/relay.cpuprofile' })`)
    expect(profile).toMatch(/PROFILE saved .*relay\.cpuprofile — \d+ samples/)
    expect(profile).toMatch(/TOP SELF TIME/)
    const vitals = await run('await perf.vitals()')
    expect(vitals).toMatch(new RegExp(`INP {3}(?:[3-9]\\d\\d|\\d{4,}) ms .* on \\[${heavy}\\] button "Run heavy task \\(300 ms\\)"`))
  }, 120000)

  it('raw CDP reads of Performance and Profiler pass in human mode', async () => {
    const text = await run("const cdp = await getCDPSession({ page })\nawait cdp.send('Performance.enable')\nreturn (await cdp.send('Performance.getMetrics')).metrics.length > 0")
    expect(text).toContain('true')
  }, 60000)

  it('prints a PDF and names the content that moved by itself', async () => {
    await run(`await act.open('${baseUrl}/perf-shift.html', { reason: 'the shift and print fixture' })`)
    const load = refOf(await run('await observe()'), /button "Load offers"/)
    const report = await run(`await act.click(${load})`)
    expect(report).toMatch(new RegExp(`SHIFT {3}0\\.\\d{3} — moved down 1\\d\\dpx: [^\\n]*\\[${load}\\] button "Load offers"`))
    const pdf = await run(`await pdf({ path: '${outDir}/relay.pdf' })`)
    expect(pdf).toMatch(/PDF {5}saved .*relay\.pdf — \d+ KB, 1 page/)
    expect(pdf).toMatch(/its print handlers changed its content/)
    expect(fs.readFileSync(path.join(outDir, 'relay.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 120000)
})
