/**
 * Live-Chromium tests for PageWatch's fast settle (`settle({ pace: 'fast' })`, fast mode), through
 * Playwright's own page session as the executor uses it.
 *
 * What they prove, in consumer terms:
 *  - on a page with nothing to do it answers after one pass, in milliseconds, not after quiet windows;
 *  - it waits for the fetch the action caused and for the text that fetch renders, and for a POST
 *    while a long-poll the page opened before the action is listed, never waited on;
 *  - it waits for a cross-document navigation and reads the new document;
 *  - a confirm the agent must answer ends it at once with js-dialog, as at human pace; one the
 *    policy answers is waited out, and what the page did after it is waited for;
 *  - a response whose server sent its headers and holds the body open (a long-poll, a stream) is
 *    not waited for and is listed; a request the server never answers ends it at the cap, named.
 *
 * Real delays in the fixture server on purpose: fast settle is measured against a real renderer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { once } from 'node:events'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import { DialogController } from './dialog-controller.js'
import { PageFrames } from './page-frames.js'
import { PageWatch } from './page-watch.js'
import type { SettleResult } from './probe-types.js'

function html(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

const PAGES: Record<string, string> = {
  '/static': html('static', '<main><h1>Static page</h1><p>Nothing moves here.</p></main>'),
  '/slow-fetch': html(
    'slow fetch',
    `<button id="load">Find mice</button><div id="out"></div>
<script>
  document.getElementById('load').addEventListener('click', function () {
    fetch('/api/slow').then(function (r) { return r.json() }).then(function (d) {
      document.getElementById('out').textContent = d.message
    })
  })
</script>`,
  ),
  '/poll': html(
    'long-poll',
    `<button id="save">Save</button><p id="out"></p>
<script>
  fetch('/api/hold').catch(function () {})
  document.getElementById('save').addEventListener('click', function () {
    fetch('/api/save', { method: 'POST', body: 'draft' }).then(function (r) { return r.json() }).then(function (d) {
      document.getElementById('out').textContent = d.message
    })
  })
</script>`,
  ),
  '/nav': html('nav one', `<a id="next" href="/other">Next</a><button id="later">Later</button>
<script>document.getElementById('later').addEventListener('click', function () { setTimeout(function () { location.href = '/other' }, 0) })</script>`),
  '/other': html('nav two', '<h1>Second page</h1>'),
  '/confirm': html(
    'confirm',
    `<button id="delete">Delete</button><p id="out"></p>
<script>
  document.getElementById('delete').addEventListener('click', function () {
    setTimeout(function () {
      var yes = confirm('Delete this thread?')
      fetch('/api/slow').then(function (r) { return r.json() }).then(function (d) {
        document.getElementById('out').textContent = (yes ? 'deleted: ' : 'kept: ') + d.message
      })
    }, 0)
  })
</script>`,
  ),
  '/stream': html(
    'open stream',
    `<button id="listen">Listen</button><p id="out"></p>
<script>
  document.getElementById('listen').addEventListener('click', function () {
    fetch('/api/stream').then(function (r) {
      document.getElementById('out').textContent = 'connected'
      var reader = r.body.getReader()
      reader.read().then(function (chunk) { document.getElementById('out').textContent = 'first chunk' })
    })
  })
</script>`,
  ),
  '/hold': html(
    'held request',
    `<button id="hold">Start</button>
<script>document.getElementById('hold').addEventListener('click', function () { fetch('/api/hold').catch(function () {}) })</script>`,
  ),
}

let browser: Browser
let context: BrowserContext
let server: http.Server
let baseUrl: string
const heldResponses: http.ServerResponse[] = []

beforeAll(async () => {
  // Real delays on purpose: fast settle is measured against a real renderer's clock.
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/api/slow' || path === '/api/save') {
      setTimeout(
        () => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: path === '/api/slow' ? 'Three mice found' : 'Saved' }))
        },
        path === '/api/slow' ? 800 : 600,
      )
      return
    }
    if (path === '/api/hold') {
      heldResponses.push(res)
      return
    }
    if (path === '/api/stream') {
      // Headers and a first chunk, then the body stays open: a stream or a long-poll that answered.
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('hello\n')
      heldResponses.push(res)
      return
    }
    const page = PAGES[path]
    res.writeHead(page ? 200 : 404, { 'Content-Type': page ? 'text/html; charset=utf-8' : 'text/plain' })
    res.end(page ?? 'not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the fixture server has no TCP port')
  baseUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
}, 120000)

afterAll(async () => {
  for (const res of heldResponses) res.destroy()
  await context?.close()
  await browser?.close()
  if (server) {
    server.close()
    await once(server, 'close')
  }
})

async function openWatched(path: string): Promise<{ page: Page; watch: PageWatch; dialogs: DialogController }> {
  const page = await context.newPage()
  const cdp = await getCDPSessionForPage({ page })
  const dialogs = new DialogController({ page })
  dialogs.attach()
  dialogs.bindSession(cdp)
  await page.goto(baseUrl + path)
  const watch = new PageWatch({ frames: new PageFrames({ page, cdp }), dialogs, isClosed: () => page.isClosed() })
  watch.start()
  // The journal is installed asynchronously by start(); one probe makes sure it is in place.
  await watch.busySignals()
  return { page, watch, dialogs }
}

function fastEvidence(result: SettleResult): Extract<SettleResult, { pace: 'fast' }>['fast'] {
  if (result.pace !== 'fast') throw new Error(`expected a fast settle, got pace ${result.pace}`)
  return result.fast
}

describe('fast settle', () => {
  it('on a static page answers after one pass, in milliseconds', async () => {
    const { page, watch } = await openWatched('/static')
    const timings: number[] = []
    for (let i = 0; i < 5; i++) {
      const result = await watch.settle({ pace: 'fast' })
      expect(result).toMatchObject({ pace: 'fast', settled: true, reason: 'quiet', pendingRequests: [], fast: { passes: 1, roundTrips: 3 } })
      timings.push(result.waitedMs)
    }
    console.log(`[fast-settle-live] fast settle on a static page: ${timings.join(', ')} ms`)
    for (const ms of timings) expect(ms).toBeLessThan(100)
    await page.close()
  })

  it('waits for the fetch the action caused (800 ms) and the text it renders', async () => {
    const { page, watch } = await openWatched('/slow-fetch')
    const cp = watch.checkpoint()
    await page.click('#load')
    const result = await watch.settle({ pace: 'fast', since: cp, origin: Date.now() })
    const text = await page.textContent('#out')
    console.log(`[fast-settle-live] fast settle, 800 ms fetch: waited ${result.waitedMs} ms, ${fastEvidence(result).passes} passes`)
    expect(result).toMatchObject({ pace: 'fast', settled: true, reason: 'quiet', pendingRequests: [] })
    expect(result.waitedMs).toBeGreaterThanOrEqual(700)
    expect(text).toBe('Three mice found')
    await page.close()
  })

  it('waits for the POST the action caused; a long-poll opened at load is listed, never waited on', async () => {
    const { page, watch } = await openWatched('/static')
    // Loaded while watched, so the journal sees the long-poll the page opens at load.
    await page.goto(baseUrl + '/poll')
    await watch.settle({ pace: 'fast' })
    const cp = watch.checkpoint()
    await page.click('#save')
    const result = await watch.settle({ pace: 'fast', since: cp, origin: Date.now() })
    expect(result).toMatchObject({ pace: 'fast', settled: true, reason: 'quiet', pendingRequests: [] })
    expect(result.waitedMs).toBeGreaterThanOrEqual(500)
    expect(await page.textContent('#out')).toBe('Saved')
    expect(result.uncaused?.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /api/hold'])
    await page.close()
  })

  for (const [how, selector] of [
    ['a link', '#next'],
    ['a handler’s setTimeout(0)', '#later'],
  ] as const) {
    it(`waits for a cross-document navigation started by ${how} and reads the new document`, async () => {
      const { page, watch } = await openWatched('/nav')
      const firstDocument = watch.documentId()
      const cp = watch.checkpoint()
      await page.click(selector, { noWaitAfter: true })
      const result = await watch.settle({ pace: 'fast', since: cp, origin: Date.now() })
      expect(result).toMatchObject({ pace: 'fast', settled: true, reason: 'quiet' })
      expect(watch.documentId()).not.toBe(firstDocument)
      expect(await page.evaluate('document.title')).toBe('nav two')
      expect((await watch.since(cp)).navigations.map(({ kind, url }) => [kind, new URL(url).pathname])).toEqual([['cross-document', '/other']])
      await page.close()
    })
  }

  it('a confirm the agent must answer ends it at once with js-dialog, as at human pace', async () => {
    const { page, watch, dialogs } = await openWatched('/confirm')
    const cp = watch.checkpoint()
    await page.click('#delete')
    const fast = await watch.settle({ pace: 'fast', since: cp, origin: Date.now() })
    const human = await watch.settle({ since: cp })
    expect(fast).toMatchObject({ pace: 'fast', settled: false, reason: 'js-dialog', dialog: { type: 'confirm', message: 'Delete this thread?' } })
    expect(human).toMatchObject({ pace: 'human', settled: false, reason: 'js-dialog', dialog: { type: 'confirm', message: 'Delete this thread?' } })
    expect(fast.waitedMs).toBeLessThan(100)
    await dialogs.accept()
    const after = await watch.settle({ pace: 'fast', since: cp, origin: Date.now() })
    expect(after).toMatchObject({ pace: 'fast', settled: true, reason: 'quiet' })
    expect(await page.textContent('#out')).toBe('deleted: Three mice found')
    await page.close()
  })

  it('a confirm the policy answers is waited out, and the fetch the page made after it is waited for', async () => {
    const { page, watch, dialogs } = await openWatched('/confirm')
    dialogs.setPolicy('dismiss')
    const cp = watch.checkpoint()
    await page.click('#delete')
    const result = await watch.settle({ pace: 'fast', since: cp, origin: Date.now() })
    expect(result).toMatchObject({ pace: 'fast', settled: true, reason: 'quiet' })
    expect(await page.textContent('#out')).toBe('kept: Three mice found')
    expect((await watch.since(cp)).dialogs).toEqual([expect.objectContaining({ type: 'confirm', outcome: 'dismissed' })])
    await page.close()
  })

  it('does not wait for a response whose server sent its headers and holds the body open; it is listed', async () => {
    const { page, watch } = await openWatched('/stream')
    const cp = watch.checkpoint()
    await page.click('#listen')
    const result = await watch.settle({ pace: 'fast', since: cp, origin: Date.now() })
    console.log(`[fast-settle-live] fast settle, answered stream held open: waited ${result.waitedMs} ms`)
    expect(result).toMatchObject({ pace: 'fast', settled: true, reason: 'quiet', pendingRequests: [] })
    expect(fastEvidence(result).openStreams?.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /api/stream'])
    expect(result.waitedMs).toBeLessThan(1000)
    expect(await page.textContent('#out')).toBe('first chunk')
    await page.close()
  })

  it('a request the server never answers ends it at the cap, NOT SETTLED, naming the request', async () => {
    const { page, watch } = await openWatched('/hold')
    const cp = watch.checkpoint()
    await page.click('#hold')
    const result = await watch.settle({ pace: 'fast', since: cp, origin: Date.now(), timeoutMs: 1500 })
    console.log(`[fast-settle-live] fast settle, unanswered request, cap 1500 ms: waited ${result.waitedMs} ms`)
    expect(result).toMatchObject({ pace: 'fast', settled: false, reason: 'timeout' })
    expect(result.pendingRequests.map((r) => `${r.method} ${new URL(r.url).pathname} ${r.resourceType}`)).toEqual(['GET /api/hold Fetch'])
    expect(result.waitedMs).toBeGreaterThanOrEqual(1500)
    expect(result.waitedMs).toBeLessThan(1600)
    await page.close()
  })
})
