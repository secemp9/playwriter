/**
 * Speed properties of observe() and an act call that are deterministic: how many whole-page reads
 * (the DOM tree, the accessibility tree) one observation and one action make. Each of those reads
 * is the renderer serializing the whole page (Wikipedia: ~1.6 MB of DOM, ~2 MB of AX tree, 130-250 ms
 * each), so a repeated one is pure latency. Counted at the CDP adapter every read goes through.
 *
 * Also: the cheaper path gives the same picture as reading everything afresh.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from '@xmorse/playwright-core'
import { PlaywrightCDPSessionAdapter, getCDPSessionForPage } from './cdp-session.js'
import { PlaywrightExecutor } from './executor.js'
import { PageProbes } from './page-probe.js'
import { flattenedDomNodes, renderObservation } from './page-observe.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

/** Every kind of node container DOM.getFlattenedDocument treats specially: nested shadow roots (open and closed), a same-process iframe with its own template and shadow root, templates (nested), pseudo-elements, a list marker. */
const CONTAINERS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Containers</title>
<style>p::before{content:'x'} li::marker{color:red} .after::after{content:'y'}</style></head><body>
<div id="host"></div>
<iframe title="Inner" srcdoc="<p>in frame<template><i>x</i></template></p><div id=h2></div><script>document.getElementById('h2').attachShadow({mode:'open'}).innerHTML='<a href=#>deep</a>'</script>"></iframe>
<template><b>t</b><template><u>n</u></template></template>
<p class="after">para</p><ul><li>one</li></ul>
<button>Plain</button>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'closed' })
root.innerHTML = '<button>Inside</button><div id="in"></div>'
root.getElementById('in').attachShadow({ mode: 'open' }).innerHTML = '<slot></slot><input aria-label="Nested field">'
</script>
</body></html>`

let server: http.Server
let baseUrl = ''
let browser: Browser
let context: BrowserContext
let cwd = ''
const executors: PlaywrightExecutor[] = []

/** The CDP commands sent through any page's adapter while `sends` is being recorded. */
let sends: Array<{ method: string; params: unknown }> | null = null
const originalSend = PlaywrightCDPSessionAdapter.prototype.send

beforeAll(async () => {
  PlaywrightCDPSessionAdapter.prototype.send = function (this: PlaywrightCDPSessionAdapter, ...args: Parameters<PlaywrightCDPSessionAdapter['send']>) {
    sends?.push({ method: args[0], params: args[1] })
    return originalSend.apply(this, args)
  } as PlaywrightCDPSessionAdapter['send']
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname === '/containers.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(CONTAINERS_HTML)
      return
    }
    const file = path.join(LAB, path.normalize(pathname))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-'))
}, 120000)

afterAll(async () => {
  PlaywrightCDPSessionAdapter.prototype.send = originalSend
  const closing = [
    ...(await Promise.allSettled(executors.map((executor) => executor.closeHeadlessContext()))),
    ...(await Promise.allSettled([context?.close()])),
    ...(await Promise.allSettled([browser?.close()])),
  ]
  const shared = await Promise.allSettled([PlaywrightExecutor.closeSharedHeadlessBrowser()])
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close((error) => (error ? closed.reject(error) : closed.resolve()))
  const stopped = await Promise.allSettled([closed.promise])
  fs.rmSync(cwd, { recursive: true, force: true })
  const errors = [...closing, ...shared, ...stopped].flatMap((outcome): unknown[] => (outcome.status === 'rejected' ? [outcome.reason] : []))
  if (errors.length > 0) throw new AggregateError(errors, `teardown failed ${errors.length} time(s): ${errors.map(String).join('; ')}`)
})

/** Record the CDP commands `work` sends; whole-page reads counted by kind. */
async function counted<T>(work: () => Promise<T>): Promise<{ value: T; axTrees: number; domReads: number; methods: string[] }> {
  sends = []
  try {
    const value = await work()
    const methods = sends.map((send) => send.method)
    return {
      value,
      axTrees: methods.filter((method) => method === 'Accessibility.getFullAXTree').length,
      domReads: methods.filter((method) => method === 'DOM.getDocument' || method === 'DOM.getFlattenedDocument').length,
      methods,
    }
  } finally {
    sends = null
  }
}

async function openPage(file: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${baseUrl}/${file}`, { waitUntil: 'load' })
  return page
}

describe('one DOM read serves the page model and the accessibility snapshot', () => {
  it('flattenedDomNodes lists exactly the nodes DOM.getFlattenedDocument does, attributes included', async () => {
    const page = await openPage('containers.html')
    const cdp = await getCDPSessionForPage({ page })
    await cdp.send('DOM.enable')
    const flat = await cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true })
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const key = (node: { backendNodeId: number; nodeName: string; attributes?: string[] }): string => `${node.backendNodeId}|${node.nodeName}|${JSON.stringify(node.attributes ?? [])}`
    const mine = flattenedDomNodes(root).map(key).sort()
    expect(mine).toEqual(flat.nodes.map(key).sort())
    // The fixture really has every container: the comparison above is not vacuous.
    const names = mine.join('\n')
    expect(names).toMatch(/\|BUTTON\|/)
    expect(names).toMatch(/\|INPUT\|.*Nested field/)
    expect(names).toMatch(/\|A\|/)
    expect(names).toMatch(/\|TEMPLATE\|/)
    await page.close()
  }, 60000)

  it('observe() reads the DOM once per renderer session and each frame’s accessibility tree once', async () => {
    const page = await openPage('containers.html')
    const probes = new PageProbes({ logger: { error: () => {} }, busyPace: () => 'human' })
    await probes.get(page)
    const { value: observation, axTrees, domReads } = await counted(() => probes.observe(page, context, {}, false))
    // Main document + the same-process srcdoc iframe: one session, two frames.
    expect(observation.frames).toEqual({ total: 2, observed: 2 })
    // Before: getFlattenedDocument + one getDocument per frame (3), and two AX trees per frame (busy + snapshot).
    expect(domReads).toBe(1)
    expect(axTrees).toBe(2)
    await page.close()
  }, 60000)

  it('an observation built from a busy read’s trees is the observation read afresh', async () => {
    const page = await openPage('form.html')
    const probes = new PageProbes({ logger: { error: () => {} }, busyPace: () => 'human' })
    const probe = await probes.get(page)
    const known = await probe.watch.readBusy({})
    const reused = await counted(() => probes.observe(page, context, { all: true }, false, known))
    expect(reused.axTrees).toBe(0)
    const fresh = await probes.observe(page, context, { all: true }, false)
    expect(renderObservation(reused.value, { all: true })).toBe(renderObservation(fresh, { all: true }))
    expect(reused.value.elements.length).toBeGreaterThanOrEqual(15)
    await page.close()
  }, 60000)

  it('observe() measures images from the layout it already read: no DOM.getBoxModel per image, the same images listed', async () => {
    const page = await openPage('spacer.html')
    const probes = new PageProbes({ logger: { error: () => {} }, busyPace: () => 'human' })
    await probes.get(page)
    const { value: observation, methods } = await counted(() => probes.observe(page, context, {}, false))
    // Before: one DOM.getBoxModel per image the accessibility tree lists (spacer.html: the chart, the icon, the spacers and pixels).
    expect(methods.filter((method) => method === 'DOM.getBoxModel')).toEqual([])
    // The spacers and tracking pixels stay out (observe-lab-live's F9 case).
    expect(observation.elements.filter((e) => e.role === 'image' || e.role === 'img').map((e) => e.noAlt?.src ?? e.name)).toEqual(['/lab/chart.svg', 'Status OK'])
    await page.close()
  }, 60000)
})

describe('an action reads each whole-page tree once per picture', () => {
  it('act.click in human mode: two accessibility trees and two DOM reads (before and after), none in settle', async () => {
    const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
    executors.push(executor)
    const opened = await executor.execute(`await page.goto('${baseUrl}/form.html', { waitUntil: 'load' })`, 30000)
    expect(opened.isError, opened.text).toBe(false)
    const look = await executor.execute('await observe({ all: true })', 30000)
    const ref = /\[(\d+)\] radio "Pro/.exec(look.text)?.[1]
    expect(ref, look.text).toBeDefined()
    const { value: result, axTrees, domReads } = await counted(() => executor.execute(`await act.click(${ref})`, 30000))
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/\[unchecked\] → \[checked\]/)
    // Before: six AX trees (busy guard, before-picture busy + snapshot, settle's busy, after-picture
    // busy + snapshot) and four DOM reads (two per picture).
    expect({ axTrees, domReads }).toEqual({ axTrees: 2, domReads: 2 })
  }, 90000)
})
