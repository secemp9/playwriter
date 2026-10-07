/**
 * Network and console detail through the real executor in human mode, in a headless Chromium, on the
 * Browser Lab's errors and network pages (test/fixtures/browser-lab, TRUTH §3.10 and §3.15):
 *
 *  - a script that answered 404 is an HTTP 404 on the ERRORS line, not `canceled` (Chrome reports the
 *    404 response, then cancels reading its body: `loadingFailed` net::ERR_ABORTED, canceled);
 *  - a request Chrome blocked for CORS names Chrome's reason, the origin and the address;
 *  - `net.request(id)` gives request and response headers (as sent and received on the wire), status
 *    text, sizes, duration, failure and CORS reason; credential headers are redacted unless asked;
 *  - `net.requests()` rows carry status text, duration and size;
 *  - `net.har({ path })` writes the journal as HAR 1.2 without sending anything;
 *  - a Web Worker's error and exception are on the ERRORS line, and the click settles;
 *  - `getLatestLogs()` keeps each console entry's source location and each exception's stack;
 *  - the DOWNLOAD line names where the browser keeps its own copy.
 *
 * Every assertion is on what the model reads.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { LAB_REPORT_CSV, startNetworkLab, type NetworkLab } from './network-lab-fixture.js'

let lab: NetworkLab
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  lab = await startNetworkLab()
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'network-detail-live-'))
})

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  await lab.close()
  fs.rmSync(cwd, { recursive: true, force: true })
})

function newExecutor(policy: 'human' | 'debug' = 'human'): PlaywrightExecutor {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  return executor
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

function returned(text: string): unknown {
  const match = /\[return value\] ([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`no return value in:\n${text}`)
  return JSON.parse(match[1]!.trim())
}

async function run(executor: PlaywrightExecutor, code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

async function open(executor: PlaywrightExecutor, page: string): Promise<{ loaded: string; look: string }> {
  const loaded = await run(executor, `await page.goto('${lab.origin}/${page}', { waitUntil: 'load' })`)
  const look = await run(executor, 'await observe()')
  return { loaded, look }
}

describe('errors.html (TRUTH §3.15)', () => {
  it('reports the script that answered 404 as HTTP 404, not as canceled', async () => {
    const executor = newExecutor()
    const { loaded } = await open(executor, 'errors.html')
    expect(loaded).toMatch(/HTTP 404 GET \/lab\/missing-script\.js \(r\d+\)/)
    expect(loaded).not.toMatch(/missing-script\.js: canceled/)
    const rows = returned(await run(executor, "return JSON.stringify(await net.requests({ urlIncludes: 'missing-script' }))"))
    expect(rows).toEqual([expect.objectContaining({ status: 404, statusText: 'Not Found', resourceType: 'Script' })])
    expect(rows).toEqual([expect.not.objectContaining({ failed: expect.anything() })])
  })

  it('ERR-T4: settles after the lab worker error — its script request ended — and shows what the page showed', async () => {
    // The lab page terminates its worker inside the worker's error handler; Chrome then reports the error
    // nowhere (measured over raw CDP, Chrome 149: no Runtime.exceptionThrown on the worker's session, no
    // Log.entryAdded on the page's, before the worker detaches). The page's own text is the evidence.
    const executor = newExecutor()
    const { look } = await open(executor, 'errors.html')
    const clicked = await run(executor, `await act.click(${refOf(look, /button "Error in Web Worker"/)})`)
    expect(clicked).toMatch(/SETTLED \d+ms/)
    expect(clicked).not.toMatch(/NOT SETTLED/)
    expect(clicked).toContain('Worker error: Uncaught Error: Lab worker error')
    const rows = returned(await run(executor, "return JSON.stringify(await net.requests({ urlIncludes: 'error-worker.js' }))"))
    expect(rows).toEqual([expect.objectContaining({ status: 200, endedAt: expect.any(Number) })])
  })

  it("reports a Web Worker's console error and uncaught exception on the ERRORS line, at the worker's script", async () => {
    const executor = newExecutor()
    const { look } = await open(executor, 'worker-errors.html')
    const clicked = await run(executor, `await act.click(${refOf(look, /button "Import rows"/)})`)
    const worker = `${lab.origin}/lab/import-worker.js`
    expect(clicked).toContain(`console.error: import worker: bad row 7 in rows.csv (${worker}:3:11)`)
    expect(clicked).toMatch(new RegExp(`uncaught: Uncaught Error: import worker crashed on row 7 \\(${worker.replace(/[.]/g, '\\.')}:5:\\d+\\)`))
    expect(clicked).not.toMatch(/NOT SETTLED/)
  })

  it('getLatestLogs keeps where each console message came from and the stack of an uncaught exception', async () => {
    const executor = newExecutor()
    const { look } = await open(executor, 'errors.html')
    await run(executor, `await act.click(${refOf(look, /button "Throw uncaught error"/)})`)
    const logs = returned(await run(executor, 'return JSON.stringify(await getLatestLogs())'))
    expect(logs).toEqual(
      expect.arrayContaining([
        `[warning] [errors] deprecated API used: legacyInit()\n    at ${lab.origin}/errors.html:33:9`,
        `[error] [errors] failed to load user preferences\n    at ${lab.origin}/errors.html:34:9`,
      ]),
    )
    const uncaught = (logs as string[]).find((entry) => entry.startsWith('[pageerror] Lab uncaught error: button handler'))
    expect(uncaught, JSON.stringify(logs)).toMatch(new RegExp(`\\n    at .*${lab.origin.replace(/[.]/g, '\\.')}/errors\\.html:40:\\d+`))
  })
})

describe('network.html (TRUTH §3.10)', () => {
  it("names Chrome's CORS reason, the origin and the address of a blocked request", async () => {
    const executor = newExecutor()
    const { look } = await open(executor, 'network.html')
    const clicked = await run(executor, `await act.click(${refOf(look, /button "Cross-origin request \(CORS\)"/)})`)
    expect(clicked).toContain(
      `request failed GET /api/cors-fail: CORS: no Access-Control-Allow-Origin header (fetch from ${lab.origin} to ${lab.otherOrigin}/api/cors-fail)`,
    )
    expect(clicked).not.toMatch(/net::ERR_FAILED/)
  })

  it('net.request gives headers on the wire, status text, sizes, duration and failure; credentials are redacted unless asked', async () => {
    const executor = newExecutor()
    const { look } = await open(executor, 'network.html')
    await run(executor, `await act.click(${refOf(look, /button "Fetch JSON \(200\)"/)})`)
    await run(executor, `await act.click(${refOf(look, /button "POST JSON \(echo\)"/)})`)
    await run(executor, `await act.click(${refOf(look, /button "Cross-origin request \(CORS\)"/)})`)

    const rows = returned(await run(executor, "return JSON.stringify(await net.requests({ urlIncludes: '/api/' }))")) as Array<{ id: string; url: string }>
    expect(rows.map((row) => row)).toEqual([
      expect.objectContaining({ url: `${lab.origin}/api/user`, status: 200, statusText: 'OK', durationMs: expect.any(Number), bytes: expect.any(Number) }),
      expect.objectContaining({ url: `${lab.origin}/api/echo`, method: 'POST', status: 200, statusText: 'OK', durationMs: expect.any(Number), bytes: expect.any(Number) }),
      expect.objectContaining({ url: `${lab.otherOrigin}/api/cors-fail`, failed: expect.stringMatching(/^CORS: no Access-Control-Allow-Origin header/) }),
    ])
    const [user, echo, cors] = rows

    const userDetail = returned(await run(executor, `return JSON.stringify(await net.request('${user!.id}'))`))
    expect(userDetail).toMatchObject({
      status: 200,
      statusText: 'OK',
      responseHeadersAre: 'as received on the wire',
      responseHeaders: expect.objectContaining({ 'Set-Cookie': '<redacted, 36 chars>', 'Content-Type': 'application/json; charset=utf-8' }),
      sizes: { transferredBytes: expect.any(Number), bodyBytes: 45 },
      durationMs: expect.any(Number),
      body: '{"id":7,"name":"Ada Lovelace","role":"admin"}',
      redacted: expect.stringContaining("net.request('" + user!.id + "', { secrets: true })"),
    })

    const echoDetail = returned(await run(executor, `return JSON.stringify(await net.request('${echo!.id}'))`))
    expect(echoDetail).toMatchObject({
      requestHeadersAre: 'as sent on the wire',
      requestHeaders: expect.objectContaining({ 'X-Lab-Client': 'network-page', 'Content-Type': 'application/json', Cookie: '<redacted, 18 chars>' }),
      requestBody: '{"message":"hello from the lab","n":42}',
    })
    const echoSecret = returned(await run(executor, `return JSON.stringify(await net.request('${echo!.id}', { secrets: true }))`))
    expect(echoSecret).toMatchObject({ requestHeaders: expect.objectContaining({ Cookie: 'lab-session=abc123' }) })
    expect(echoSecret).not.toHaveProperty('redacted')

    const corsDetail = returned(await run(executor, `return JSON.stringify(await net.request('${cors!.id}'))`))
    expect(corsDetail).toMatchObject({
      failed: `CORS: no Access-Control-Allow-Origin header (fetch from ${lab.origin} to ${lab.otherOrigin}/api/cors-fail)`,
      failureText: 'net::ERR_FAILED',
      cors: { corsError: 'MissingAllowOriginHeader', failedParameter: '' },
      noBody: expect.stringContaining('CORS'),
    })
  })

  it('net.har writes the journal as HAR 1.2 with headers, timings and bodies, and sends nothing', async () => {
    const executor = newExecutor()
    const { look } = await open(executor, 'network.html')
    await run(executor, `await act.click(${refOf(look, /button "POST JSON \(echo\)"/)})`)
    await run(executor, `await act.click(${refOf(look, /button "Fetch missing \(404\)"/)})`)
    const servedBefore = lab.served.length
    const result = returned(await run(executor, "return JSON.stringify(await net.har({ path: 'lab.har' }))")) as { path: string; entries: number }
    expect(lab.served.length).toBe(servedBefore)
    expect(result.path).toBe(path.join(cwd, 'lab.har'))
    const har = JSON.parse(fs.readFileSync(result.path, 'utf8'))
    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBe('playwriter')
    expect(har.log.entries).toHaveLength(result.entries)
    const echo = har.log.entries.find((entry: { request: { url: string } }) => entry.request.url === `${lab.origin}/api/echo`)
    expect(echo).toMatchObject({
      request: {
        method: 'POST',
        headers: expect.arrayContaining([{ name: 'X-Lab-Client', value: 'network-page' }]),
        postData: { mimeType: 'application/json', text: '{"message":"hello from the lab","n":42}' },
      },
      response: { status: 200, statusText: 'OK', content: { mimeType: 'application/json', text: expect.stringContaining('"hello from the lab"') } },
      timings: { send: expect.any(Number), wait: expect.any(Number), receive: expect.any(Number) },
    })
    expect(echo.time).toBeGreaterThanOrEqual(0)
    const missing = har.log.entries.find((entry: { request: { url: string } }) => entry.request.url === `${lab.origin}/api/status/404`)
    expect(missing.response).toMatchObject({ status: 404, statusText: 'Not Found', content: { text: '{"error":"Not Found","status":404}' } })
  })

  it("names the browser's own copy of a download on the DOWNLOAD line", async () => {
    const executor = newExecutor()
    const { look } = await open(executor, 'network.html')
    const clicked = await run(executor, `await act.click(${refOf(look, /link "Download report \(CSV\)"/)})`)
    const own = /the browser's own copy is (\S+) \(Playwright's temporary downloads folder, deleted when this browser closes\)/.exec(clicked)
    expect(own, clicked).not.toBeNull()
    expect(fs.readFileSync(own![1]!, 'utf8')).toBe(LAB_REPORT_CSV)
  })
})
