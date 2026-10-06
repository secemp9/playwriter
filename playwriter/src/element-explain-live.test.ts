/**
 * Live-Chromium tests for explainElement: what an element is and what using it will do,
 * answered from the page's own code without changing the page.
 *
 *  (a) plain HTML: a native `addEventListener('click', function handleSave…)` is found,
 *      located at its line in the served document, and summarised (POST + pushState);
 *  (b) a REAL React 19.2.7 dev app (test/fixtures/element-explain-react, bundled here with
 *      bun and a linked sourcemap): component chain, onClick → handleSend located in the
 *      ORIGINAL .tsx through the sourcemap, its fetch/state setters, the form's onSubmit
 *      reaching handleSend's request through the live closure;
 *  (c) a minified PRODUCTION build of the same app: names and locations restored from the
 *      original source through the sourcemap, with an honest note that the build is minified;
 *  (d) explain leaves no trace: main-world globals, element count, DOM and URL are
 *      unchanged, and the page issues no request while being explained;
 *  (e) with a native dialog open the page cannot answer: explain fails fast and says why;
 *  (f) beyond React and beyond the element: a click handler delegated to `#app` is found on the
 *      event path; a helper imported from another ES module is followed through the handler's
 *      live closure; a minified bundle over 250 KB is parsed whole; a sourcemap that 404s is a
 *      note naming its URL; a framework-style dispatcher (Preact's `this.l[e.type + false]`
 *      proxy, Vue's `invoker.value`) in an ignore-listed library resolves to the page handler.
 *
 * A plain Chromium is enough; no extension, no relay.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, Dialog, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import type { ICDPSession } from './cdp-session.js'
import { explainElement, renderExplanation } from './element-explain.js'
import { PageUnresponsiveError } from './isolated-world.js'
import { PageFrames } from './page-frames.js'

const PLAIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>explain plain</title></head>
<body>
<form id="profile"><button id="save" type="button">Save</button></form>
<a id="pricing" href="/pricing">Pricing</a>
<script>
  window.savedCount = 0
  document.getElementById('save').addEventListener('click', function handleSave() {
    window.savedCount++
    fetch('/api/save', { method: 'POST' })
    history.pushState({}, '', '/saved')
  })
</script>
</body></html>`

function reactHtml(bundle: 'dev' | 'prod'): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>explain react ${bundle}</title></head>
<body><div id="root"></div><script type="module" src="/${bundle}/app.js"></script></body></html>`
}

/** Built at run time: written literally at a line start, Vite would try to load the map for this test file. */
const SOURCE_MAP_COMMENT = ['//', '# sourceMappingURL='].join('')

/** Base64 VLQ of one sourcemap field. */
function vlq(value: number): string {
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let rest = value < 0 ? (-value << 1) | 1 : value << 1
  let out = ''
  do {
    let digit = rest & 31
    rest >>>= 5
    if (rest > 0) digit |= 32
    out += digits[digit]
  } while (rest > 0)
  return out
}

/**
 * A sourcemap whose one source is the served code itself (a segment at every non-blank
 * character), marked ignore-listed as Vite/Rollup/Angular CLI do for node_modules.
 */
function ignoreListedIdentityMap(source: string, code: string): string {
  let previousLine = 0
  let previousColumn = 0
  const mappings = code.split('\n').map((line, lineIndex) => {
    const segments: string[] = []
    let previousGenerated = 0
    for (let column = 0; column < line.length; column++) {
      if (/\s/.test(line[column])) continue
      segments.push(vlq(column - previousGenerated) + vlq(0) + vlq(lineIndex - previousLine) + vlq(column - previousColumn))
      previousGenerated = column
      previousLine = lineIndex
      previousColumn = column
    }
    return segments.join(',')
  })
  return JSON.stringify({ version: 3, sources: [source], sourcesContent: [code], names: [], mappings: mappings.join(';'), x_google_ignoreList: [0] })
}

/** A tiny framework written like Preact's and Vue's event layers: user handlers are stored on the node / the listener and called by a proxy. */
const MINI_FRAMEWORK_JS = `(function () {
  var options = {}
  function eventProxy(e) {
    return this.l[e.type + false](options.event ? options.event(e) : e)
  }
  function setPreactListener(dom, name, value) {
    var type = name.slice(2).toLowerCase()
    if (!dom.l) dom.l = {}
    dom.l[type + false] = value
    dom.addEventListener(type, eventProxy, false)
  }
  function callWithErrorHandling(fn, args) {
    try {
      return args ? fn.apply(null, args) : fn()
    } catch (err) {
      console.error(err)
    }
  }
  function setVueListener(el, name, value) {
    var invoker = function (e) {
      callWithErrorHandling(invoker.value, [e])
    }
    invoker.value = value
    el.addEventListener(name.slice(2).toLowerCase(), invoker)
  }
  function h(flavour, tag, props, text) {
    var dom = document.createElement(tag)
    for (var key in props) {
      if (key.slice(0, 2) !== 'on') dom.setAttribute(key, props[key])
      else if (flavour === 'preact') setPreactListener(dom, key, props[key])
      else setVueListener(dom, key, props[key])
    }
    dom.textContent = text
    return dom
  }
  function request(url, method) {
    return fetch(url, { method: method })
  }
  window.miniFramework = { h: h, request: request }
})()
${SOURCE_MAP_COMMENT}mini-framework.js.map
`

const MINI_FRAMEWORK_APP_JS = `function onArchive(event) {
  fetch('/api/archive', { method: 'POST' })
}
function onStar() {
  fetch('/api/star', { method: 'PUT' })
}
var root = document.getElementById('root')
root.appendChild(miniFramework.h('preact', 'button', { id: 'archive', onClick: onArchive }, 'Archive'))
root.appendChild(miniFramework.h('vue', 'button', { id: 'star', onClick: onStar }, 'Star'))
function onSync() {
  miniFramework.request('/api/sync', 'PATCH')
}
root.appendChild(miniFramework.h('preact', 'button', { id: 'sync', onClick: onSync }, 'Sync'))
`

/** Static pages and scripts beyond the React fixture, by URL path. */
const EXTRA_ROUTES: Record<string, { type: string; body: string }> = {
  '/shadow': {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>shadow</title></head><body>
<section id="panel"><fancy-toolbar id="toolbar"><button id="pin">Pin <svg id="pin-icon"></svg></button></fancy-toolbar></section>
<script>
  customElements.define('fancy-toolbar', class extends HTMLElement {
    constructor() {
      super()
      const root = this.attachShadow({ mode: 'closed' })
      root.innerHTML = '<div id="bar"><slot></slot></div>'
      root.getElementById('bar').addEventListener('click', function onToolbarClick() { fetch('/api/toolbar', { method: 'POST' }) })
    }
  })
  document.getElementById('pin-icon').addEventListener('pointerdown', function onIconDown() { history.replaceState({}, '', '#pinned') })
  document.getElementById('panel').addEventListener('keydown', function onPanelKey(event) { if (event.key === 'p') location.assign('/pins') })
</script>
</body></html>`,
  },
  '/delegated': {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>delegated</title></head><body>
<div id="app"><ul><li>Report.pdf <button class="del">Delete</button></li></ul></div>
<script>
  document.getElementById('app').addEventListener('click', e => { if (e.target.closest('.del')) fetch('/api/del', { method: 'POST' }) })
</script>
</body></html>`,
  },
  '/modules': {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>modules</title></head><body>
<button id="remove">Remove</button><button id="archive-all">Archive all</button>
<script type="module" src="/mod/main.js"></script>
</body></html>`,
  },
  '/mod/main.js': {
    type: 'text/javascript',
    body: `import { deleteItem } from './api.js'
import * as api from './api.js'
const itemId = 7
document.getElementById('remove').addEventListener('click', () => deleteItem(itemId))
document.getElementById('archive-all').addEventListener('click', () => api.archiveAll())
document.body.dataset.ready = '1'
`,
  },
  '/mod/api.js': {
    type: 'text/javascript',
    body: `export function deleteItem(id) {
  return fetch('/api/items/' + id, { method: 'DELETE' })
}
export function archiveAll() {
  return fetch('/api/archive-all', { method: 'POST' })
}
`,
  },
  '/missing-map': {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>missing map</title></head><body>
<button id="unmapped">Send</button><script src="/js/missing-map.js"></script>
</body></html>`,
  },
  '/js/missing-map.js': {
    type: 'text/javascript',
    body: `document.getElementById('unmapped').addEventListener('click', function onUnmapped() {
  fetch('/api/unmapped', { method: 'POST' })
})
${SOURCE_MAP_COMMENT}missing-map.js.map
`,
  },
  '/big': {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>big bundle</title></head><body>
<button id="big">Save all</button><script src="/js/big.js"></script>
</body></html>`,
  },
  '/mini-framework': {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>mini framework</title></head><body>
<div id="root"></div><script src="/js/mini-framework.js"></script><script src="/js/mini-framework-app.js"></script>
</body></html>`,
  },
  '/js/mini-framework.js': { type: 'text/javascript', body: MINI_FRAMEWORK_JS },
  '/js/mini-framework.js.map': {
    type: 'application/json',
    body: ignoreListedIdentityMap('node_modules/mini-framework/src/events.js', MINI_FRAMEWORK_JS),
  },
  '/js/mini-framework-app.js': { type: 'text/javascript', body: MINI_FRAMEWORK_APP_JS },
}

/**
 * Entry of the >250 KB minified bundle: a large string table the handler reads, and a helper
 * the handler calls (used twice so the minifier keeps it a function).
 */
function bigBundleEntry(): string {
  const rows = Array.from({ length: 24_000 }, (_, i) => JSON.stringify(`row-${i}-${((i * 2654435761) >>> 0).toString(36)}`))
  return `const table = [${rows.join(',')}]
function lookup(i) { return table[i] }
function saveAll(reason) { return fetch('/api/big/save', { method: 'PUT', body: reason }) }
document.getElementById('big').addEventListener('click', function onBigClick() { if (lookup(0)) saveAll('click') })
document.getElementById('big').addEventListener('keydown', function onBigKey(event) { if (event.key === 'Enter') saveAll('key') })
`
}

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/element-explain-react')
const fixtureSource = fs.readFileSync(path.join(fixtureDir, 'ChatComposer.tsx'), 'utf8')

/** 1-based line of the first line containing `needle` in `text`. */
function lineOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle))
  if (index < 0) throw new Error(`fixture has no line containing ${needle}`)
  return index + 1
}

let browser: Browser
let server: http.Server
let baseUrl: string
let bundleDir: string

beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-react-'))
  execFileSync('bun', [path.join(fixtureDir, 'build.ts'), path.join(bundleDir, 'dev')], { stdio: 'pipe' })
  execFileSync('bun', [path.join(fixtureDir, 'build.ts'), path.join(bundleDir, 'prod'), '--production'], { stdio: 'pipe' })
  fs.writeFileSync(path.join(bundleDir, 'big-entry.js'), bigBundleEntry())
  execFileSync('bun', ['build', path.join(bundleDir, 'big-entry.js'), '--minify', '--format=iife', '--outfile', path.join(bundleDir, 'big.js')], { stdio: 'pipe' })
  server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const asset = /^\/(dev|prod)\/app\.js(\.map)?$/.exec(url)
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset[2] ? 'application/json' : 'text/javascript' })
      res.end(fs.readFileSync(path.join(bundleDir, url.slice(1))))
      return
    }
    if (url === '/js/big.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(fs.readFileSync(path.join(bundleDir, 'big.js')))
      return
    }
    const extra = EXTRA_ROUTES[url]
    if (extra) {
      res.writeHead(200, { 'Content-Type': extra.type })
      res.end(extra.body)
      return
    }
    if (url.startsWith('/js/') || url.startsWith('/mod/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(url.startsWith('/react-prod') ? reactHtml('prod') : url.startsWith('/react') ? reactHtml('dev') : PLAIN_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
}, 120000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (bundleDir) fs.rmSync(bundleDir, { recursive: true, force: true })
})

async function backendNodeIdOf(cdp: ICDPSession, selector: string): Promise<number> {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  if (!nodeId) throw new Error(`no element matches ${selector}`)
  return (await cdp.send('DOM.describeNode', { nodeId })).node.backendNodeId
}

/**
 * The browser globals these page callbacks read. The package compiles without the DOM lib, so
 * callbacks view `globalThis` through this shape; they only ever run inside the page.
 */
interface BrowserGlobals {
  location: { href: string }
  history: { length: number }
  document: { getElementsByTagName(name: string): { length: number }; documentElement: { outerHTML: string } }
  alert(message: string): void
}

/** Everything a page script could observe about our presence. */
async function pageFingerprint(page: Page): Promise<{ globals: string[]; elements: number; html: string; url: string; historyLength: number }> {
  return await page.evaluate(() => {
    // Runs in the page, where globalThis is the window.
    const w = globalThis as unknown as BrowserGlobals
    return {
      globals: Object.keys(globalThis),
      elements: w.document.getElementsByTagName('*').length,
      html: w.document.documentElement.outerHTML,
      url: w.location.href,
      historyLength: w.history.length,
    }
  })
}

async function openPage(url: string, readySelector: string): Promise<{ page: Page; cdp: ICDPSession; frames: PageFrames }> {
  const page = await browser.newPage()
  await page.goto(url)
  await page.waitForSelector(readySelector)
  const cdp = await getCDPSessionForPage({ page })
  const frames = new PageFrames({ page, cdp })
  page.once('close', () => frames.dispose())
  return { page, cdp, frames }
}

describe('explainElement on a plain HTML page', () => {
  it('reports the native click handler, its location in the document and what it does', async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/plain`, '#save')
    try {
      const startedAt = Date.now()
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#save') })
      const tookMs = Date.now() - startedAt

      expect(explanation.tag).toBe('button')
      expect(explanation.attributes).toEqual({ id: 'save', type: 'button' })
      expect(explanation.name).toBe('Save')
      expect(explanation.react).toBeUndefined()
      // Only page code: Playwright's own window listeners (installed by waitForSelector) are excluded.
      expect(explanation.handlers).toHaveLength(1)
      const [handler] = explanation.handlers
      expect(handler.origin).toBe('dom')
      expect(handler.event).toBe('click')
      expect(handler.functionName).toBe('handleSave')
      expect(handler.source).toMatch(new RegExp(`^${baseUrl}/plain:${lineOf(PLAIN_HTML, 'function handleSave')}:\\d+$`))
      expect(handler.frame).toContain('function handleSave()')
      expect(handler.summary).toEqual({
        calls: ['fetch', 'history.pushState'],
        network: ['POST /api/save'],
        navigation: ['history.pushState → /saved'],
        stateSetters: [],
        preventsDefault: false,
      })
      expect(explanation.notes.some((n) => n.includes("Playwright's injected script"))).toBe(true)

      const text = renderExplanation(explanation)
      expect(text).toContain('button "Save" (button#save)')
      expect(text).toContain('click → handleSave')
      expect(text).toContain('POST /api/save · history.pushState → /saved')
      console.log(`[explain plain] ${tookMs}ms\n${text}`)
    } finally {
      await page.close()
    }
  })

  it("names a link's default action", async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/plain`, '#pricing')
    try {
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#pricing') })
      expect(explanation.defaultAction).toBe('follows link → /pricing')
      expect(explanation.handlers).toEqual([])
      expect(renderExplanation(explanation)).toContain('default: follows link → /pricing')
    } finally {
      await page.close()
    }
  })
})

describe('explainElement on a real React 19 app with a sourcemap', () => {
  it('reports the component chain, the onClick handler in the original file and what it does', async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/react`, 'button.send')
    try {
      const startedAt = Date.now()
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, 'button.send') })
      const tookMs = Date.now() - startedAt
      const original = /\/test\/fixtures\/element-explain-react\/ChatComposer\.tsx/

      expect(explanation.name).toBe('Send')
      expect(explanation.react?.components.map((c) => c.name)).toEqual(['SendButton', 'ChatComposer', 'ChatPanel', 'App'])
      const [sendButton, chatComposer] = explanation.react!.components
      expect(sendButton.source).toMatch(original)
      expect(sendButton.source?.endsWith(`ChatComposer.tsx:${lineOf(fixtureSource, 'function SendButton(')}`)).toBe(true)
      expect(chatComposer.source?.endsWith(`ChatComposer.tsx:${lineOf(fixtureSource, 'function ChatComposer(')}`)).toBe(true)
      // React 19: the element's JSX site comes from the host fiber's _debugStack.
      expect(explanation.react?.renderedAt?.endsWith(`ChatComposer.tsx:${lineOf(fixtureSource, '<button className="send"')}`)).toBe(true)
      expect(explanation.defaultAction).toBe('submits form.composer → GET (this page URL)')

      const onClick = explanation.handlers[0]
      expect(onClick).toMatchObject({ event: 'onClick', origin: 'react-prop', component: 'SendButton', functionName: 'handleSend' })
      expect(onClick.source).toMatch(original)
      expect(onClick.source?.endsWith(`ChatComposer.tsx:${lineOf(fixtureSource, 'async function handleSend()')}`)).toBe(true)
      expect(onClick.frame).toContain('async function handleSend()')
      expect(onClick.summary?.network).toEqual(['POST /api/messages'])
      expect(onClick.summary?.stateSetters).toEqual(['setSending(true)', "setDraft('')", 'setSending(false)'])
      expect(onClick.summary?.preventsDefault).toBe(false)
      // SendButton's onSend prop is the same function: reported once, not twice.
      expect(explanation.handlers.filter((h) => h.functionName === 'handleSend')).toHaveLength(1)

      const onSubmit = explanation.handlers.find((h) => h.event === 'onSubmit')
      expect(onSubmit).toMatchObject({ origin: 'react-prop', target: 'form.composer', component: 'ChatComposer' })
      expect(onSubmit?.source?.endsWith(`ChatComposer.tsx:${lineOf(fixtureSource, 'onSubmit={(event) =>')}`)).toBe(true)
      expect(onSubmit?.summary?.preventsDefault).toBe(true)
      expect(onSubmit?.summary?.network).toEqual(['POST /api/messages (via handleSend)'])

      // React's root dispatcher and its iOS no-op are explained, never listed as the handler.
      expect(explanation.handlers.every((h) => h.origin === 'react-prop')).toBe(true)
      expect(explanation.notes.some((n) => n.includes('root container div#root'))).toBe(true)

      const text = renderExplanation(explanation)
      expect(text).toMatch(/^button "Send" \(button\.send\) — React: SendButton \(\/.*ChatComposer\.tsx:\d+\) › ChatComposer \(ChatComposer\.tsx:\d+\) › ChatPanel/)
      expect(text).toContain('onClick → handleSend (ChatComposer.tsx:')
      expect(text).toContain("POST /api/messages · setSending(true) · setDraft('') · setSending(false)")
      expect(text).toContain('onSubmit on form.composer → inline function (ChatComposer.tsx:')
      console.log(`[explain react] ${tookMs}ms\n${text}`)
    } finally {
      await page.close()
    }
  })

  it('explains an input whose onChange is an inline arrow', async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/react`, 'button.send')
    try {
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, 'input') })
      expect(explanation.name).toBe('Message')
      expect(explanation.react?.components.map((c) => c.name)).toEqual(['ChatComposer', 'ChatPanel', 'App'])
      const onChange = explanation.handlers[0]
      expect(onChange).toMatchObject({ event: 'onChange', origin: 'react-prop', component: 'ChatComposer' })
      expect(onChange.summary?.stateSetters).toEqual(['setDraft(event.target.value)'])
      expect(explanation.notes.some((n) => n.includes('directly on this element'))).toBe(true)
    } finally {
      await page.close()
    }
  })
})

describe('explainElement on a minified production React build with a sourcemap', () => {
  it('restores component and handler names from the original source and says the build is minified', async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/react-prod`, 'button.send')
    try {
      const startedAt = Date.now()
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, 'button.send') })
      const tookMs = Date.now() - startedAt

      expect(explanation.react?.components.map((c) => c.name)).toEqual(['SendButton', 'ChatComposer', 'ChatPanel', 'App'])
      expect(explanation.react?.components[0].source?.endsWith(`ChatComposer.tsx:${lineOf(fixtureSource, 'function SendButton(')}`)).toBe(true)
      // Production React keeps no _debugSource/_debugStack: the render site is honestly absent.
      expect(explanation.react?.renderedAt).toBeUndefined()
      const onClick = explanation.handlers[0]
      expect(onClick).toMatchObject({ event: 'onClick', origin: 'react-prop', functionName: 'handleSend' })
      expect(onClick.source?.endsWith(`ChatComposer.tsx:${lineOf(fixtureSource, 'async function handleSend()')}`)).toBe(true)
      expect(onClick.summary?.network).toEqual(['POST /api/messages'])
      expect(onClick.summary?.stateSetters).toEqual(['setSending(true)', "setDraft('')", 'setSending(false)'])
      expect(explanation.handlers.filter((h) => h.functionName === 'handleSend')).toHaveLength(1)
      // React's minified iOS no-op click listener is recognised without its dev name.
      expect(explanation.handlers.every((h) => h.origin === 'react-prop')).toBe(true)
      expect(explanation.notes.some((n) => n.startsWith('Production React build'))).toBe(true)
      expect(explanation.notes.some((n) => n.startsWith('Names are minified in this build'))).toBe(true)
      console.log(`[explain react production] ${tookMs}ms\n${renderExplanation(explanation)}`)
    } finally {
      await page.close()
    }
  })

  it("keeps React's own element listeners out of an input's handlers", async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/react-prod`, 'button.send')
    try {
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, 'input') })
      expect(explanation.handlers.map((h) => `${h.event} ${h.origin}`)).toEqual(['onChange react-prop', 'onSubmit react-prop'])
      expect(explanation.handlers[0].summary?.stateSetters).toEqual(['setDraft(event.target.value)'])
    } finally {
      await page.close()
    }
  })
})

describe('explainElement leaves the page untouched', () => {
  for (const [label, route, selector] of [
    ['plain HTML', '/plain', '#save'],
    ['React', '/react', 'button.send'],
    ['React production', '/react-prod', 'button.send'],
  ] as const) {
    it(`${label}: no new globals, elements, DOM changes, navigations or requests`, async () => {
      const { page, cdp, frames } = await openPage(`${baseUrl}${route}`, selector)
      try {
        const backendNodeId = await backendNodeIdOf(cdp, selector)
        const before = await pageFingerprint(page)
        const requests: string[] = []
        page.on('request', (request) => requests.push(request.url()))
        await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId })
        await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId })
        const after = await pageFingerprint(page)
        expect(after.globals).toEqual(before.globals)
        expect(after.elements).toBe(before.elements)
        expect(after.html).toBe(before.html)
        expect(after.url).toBe(before.url)
        expect(after.historyLength).toBe(before.historyLength)
        expect(requests).toEqual([])
        // The handler was read, never run.
        if (route === '/plain') expect(await page.evaluate(() => Reflect.get(globalThis, 'savedCount'))).toBe(0)
      } finally {
        await page.close()
      }
    })
  }
})

describe('explainElement while a native dialog is open', () => {
  it('fails fast with an error that names the dialog instead of hanging', async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/plain`, '#save')
    try {
      const backendNodeId = await backendNodeIdOf(cdp, '#save')
      // A dialog listener stops Playwright from auto-dismissing, so the alert stays open.
      const { promise: opened, resolve } = Promise.withResolvers<Dialog>()
      page.once('dialog', resolve)
      // In-page scheduling, not a test wait: a direct alert() would block this evaluate itself.
      await page.evaluate(() => {
        // Runs in the page, where globalThis is the window.
        const w = globalThis as unknown as BrowserGlobals
        setTimeout(() => w.alert('Saved!'), 0)
      })
      const dialog = await opened

      const told = explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId, jsDialog: { type: 'alert', message: 'Saved!', openedAt: Date.now(), handling: 'agent' } })
      await expect(told).rejects.toThrow('native alert dialog is open ("Saved!")')

      const startedAt = Date.now()
      const blind = explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId })
      await expect(blind).rejects.toBeInstanceOf(PageUnresponsiveError)
      await expect(blind).rejects.toThrow('A native JS dialog')
      expect(Date.now() - startedAt).toBeLessThan(8000)

      await dialog.accept()
      const after = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId })
      expect(after.handlers[0]?.functionName).toBe('handleSave')
    } finally {
      await page.close()
    }
  })
})

describe('explainElement beyond React and beyond the element', () => {
  it('finds a click handler delegated to a container and summarises its request', async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/delegated`, 'button.del')
    try {
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, 'button.del') })
      expect(explanation.handlers).toHaveLength(1)
      const [handler] = explanation.handlers
      expect(handler).toMatchObject({ event: 'click', origin: 'dom', target: 'div#app', delegated: true })
      expect(handler.source).toMatch(new RegExp(`^${baseUrl}/delegated:\\d+:\\d+$`))
      expect(handler.summary?.network).toEqual(['POST /api/del'])
      const text = renderExplanation(explanation)
      expect(text).toContain('click (delegated: listens on div#app) → (anonymous)')
      expect(text).toContain('POST /api/del')
      console.log(`[explain delegated]\n${text}`)
    } finally {
      await page.close()
    }
  })

  it('follows a helper imported from another ES module through the live closure', async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/modules`, 'body[data-ready]')
    try {
      const remove = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#remove') })
      expect(remove.handlers).toHaveLength(1)
      expect(remove.handlers[0].source).toMatch(/\/mod\/main\.js:\d+:\d+$/)
      expect(remove.handlers[0].summary?.calls).toEqual(['deleteItem'])
      expect(remove.handlers[0].summary?.network).toEqual(['DELETE /api/items/${id} (via deleteItem)'])

      // A namespace import: the member is read from the live module namespace object.
      const archiveAll = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#archive-all') })
      expect(archiveAll.handlers[0].summary?.network).toEqual(['POST /api/archive-all (via archiveAll)'])
      console.log(`[explain modules]\n${renderExplanation(remove)}\n${renderExplanation(archiveAll)}`)
    } finally {
      await page.close()
    }
  })

  it('parses a minified bundle over 250 KB whole and follows its helpers', async () => {
    expect(fs.statSync(path.join(bundleDir, 'big.js')).size).toBeGreaterThan(250_000)
    const { page, cdp, frames } = await openPage(`${baseUrl}/big`, '#big')
    try {
      const startedAt = Date.now()
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#big') })
      const tookMs = Date.now() - startedAt
      expect(explanation.handlers.map((h) => h.event)).toEqual(['click', 'keydown'])
      for (const handler of explanation.handlers) {
        expect(handler.source).toMatch(new RegExp(`^${baseUrl}/js/big\\.js:1:\\d+$`))
        // The helper is minified to a short name; it is followed by its runtime identity, not its name.
        expect(handler.summary?.network).toEqual([expect.stringMatching(/^PUT \/api\/big\/save \(via [\w$]+\)$/)])
      }
      expect(explanation.notes.some((n) => /bytes|not parsed|could not parse/i.test(n))).toBe(false)
      console.log(`[explain big bundle] ${tookMs}ms\n${renderExplanation(explanation)}`)
    } finally {
      await page.close()
    }
  })

  it('names a sourcemap that 404s and still explains from the served code', async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/missing-map`, '#unmapped')
    try {
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#unmapped') })
      const mapNote = explanation.notes.find((n) => n.includes(`${baseUrl}/js/missing-map.js.map`))
      expect(mapNote).toBeDefined()
      expect(mapNote).toContain('HTTP 404')
      expect(mapNote).not.toContain('dialog')
      expect(explanation.handlers).toHaveLength(1)
      expect(explanation.handlers[0]).toMatchObject({ event: 'click', functionName: 'onUnmapped' })
      expect(explanation.handlers[0].source).toMatch(new RegExp(`^${baseUrl}/js/missing-map\\.js:1:\\d+$`))
      expect(explanation.handlers[0].summary?.network).toEqual(['POST /api/unmapped'])
      console.log(`[explain missing sourcemap]\n${renderExplanation(explanation)}`)
    } finally {
      await page.close()
    }
  })

  it("follows an ignore-listed framework dispatcher (Preact's event proxy, Vue's invoker) to the page handler", async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/mini-framework`, '#star')
    try {
      const preact = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#archive') })
      expect(preact.handlers).toHaveLength(1)
      expect(preact.handlers[0]).toMatchObject({ event: 'click', origin: 'dom', functionName: 'onArchive' })
      expect(preact.handlers[0].source).toMatch(new RegExp(`^${baseUrl}/js/mini-framework-app\\.js:1:\\d+$`))
      expect(preact.handlers[0].dispatchedBy).toMatch(/^eventProxy \(.*node_modules\/mini-framework\/src\/events\.js:3\)$/)
      expect(preact.handlers[0].summary?.network).toEqual(['POST /api/archive'])

      const vue = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#star') })
      expect(vue.handlers).toHaveLength(1)
      expect(vue.handlers[0]).toMatchObject({ event: 'click', origin: 'dom', functionName: 'onStar' })
      expect(vue.handlers[0].dispatchedBy).toMatch(/^invoker \(.*events\.js:\d+\)$/)
      expect(vue.handlers[0].summary?.network).toEqual(['PUT /api/star'])
      const text = renderExplanation(preact)
      expect(text).toContain('click → onArchive')
      expect(text).toContain('dispatched by eventProxy')
      console.log(`[explain mini framework]\n${text}\n${renderExplanation(vue)}`)

      // Page code calling into the ignore-listed library: the request is reported where the page calls it.
      const sync = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#sync') })
      expect(sync.handlers[0]).toMatchObject({ functionName: 'onSync' })
      expect(sync.handlers[0].summary?.network).toEqual(["miniFramework.request('/api/sync', 'PATCH') → fetch"])
    } finally {
      await page.close()
    }
  })

  it('reads listeners through a closed shadow root slot and on nodes inside the element', async () => {
    const { page, cdp, frames } = await openPage(`${baseUrl}/shadow`, '#pin')
    try {
      const explanation = await explainElement({ page, frames, frameId: frames.mainFrameId(), backendNodeId: await backendNodeIdOf(cdp, '#pin') })
      const byName = new Map(explanation.handlers.map((h) => [h.functionName, h]))
      // The slotted button's path runs through the closed shadow root's <slot> and div#bar.
      expect(byName.get('onToolbarClick')).toMatchObject({ event: 'click', target: 'div#bar', delegated: true })
      expect(byName.get('onToolbarClick')?.summary?.network).toEqual(['POST /api/toolbar'])
      expect(byName.get('onIconDown')).toMatchObject({ event: 'pointerdown', target: 'svg#pin-icon', descendant: true })
      expect(byName.get('onIconDown')?.summary?.navigation).toEqual(['history.replaceState → #pinned'])
      expect(byName.get('onPanelKey')).toMatchObject({ event: 'keydown', target: 'section#panel', delegated: true })
      expect(byName.get('onPanelKey')?.summary?.navigation).toEqual(['location.assign → /pins'])
      const text = renderExplanation(explanation)
      expect(text).toContain('pointerdown on svg#pin-icon (inside the element) → onIconDown')
      console.log(`[explain shadow]\n${text}`)
    } finally {
      await page.close()
    }
  })
})
