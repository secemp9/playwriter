/**
 * Live-Chromium tests for getReactSource / getReactComponentInfo on a REAL React 19.2.7 dev app
 * (test/fixtures/element-explain-react, bundled here with bun and a linked sourcemap):
 *
 *  (a) the component name, the JSX site mapped to the ORIGINAL .tsx through the sourcemap, the
 *      component chain and the props — from a locator and from a backendNodeId;
 *  (b) the page is left exactly as it was: same own global names, same element count, and the
 *      page issues no request (the sourcemap is fetched by DevTools' loader, not the page);
 *  (c) a non-React element is `null`; a sourcemap that exists but cannot be loaded is an error
 *      that says so, never a silent `null`.
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
import type { Browser, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import type { ICDPSession } from './cdp-session.js'
import { getReactComponentInfo, getReactSource } from './react-source.js'

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/element-explain-react')
const fixtureSource = fs.readFileSync(path.join(fixtureDir, 'ChatComposer.tsx'), 'utf8')

function reactHtml(script: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>react source</title></head>
<body><div id="root"></div><script type="module" src="${script}"></script></body></html>`
}

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
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-source-'))
  execFileSync('bun', [path.join(fixtureDir, 'build.ts'), path.join(bundleDir, 'dev')], { stdio: 'pipe' })
  const devScript = fs.readFileSync(path.join(bundleDir, 'dev', 'app.js'), 'utf8')
  // The same bundle, linking a source map that does not exist.
  const brokenScript = devScript.replace(/\/\/# sourceMappingURL=\S+\s*$/, '//# sourceMappingURL=missing.js.map\n')
  if (brokenScript === devScript) throw new Error('the dev bundle has no sourceMappingURL comment to break')
  server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/dev/app.js' || url === '/dev/app.js.map') {
      res.writeHead(200, { 'Content-Type': url.endsWith('.map') ? 'application/json' : 'text/javascript' })
      res.end(fs.readFileSync(path.join(bundleDir, url.slice(1))))
      return
    }
    if (url === '/broken/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(brokenScript)
      return
    }
    if (url.startsWith('/broken/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(reactHtml(url.startsWith('/react-broken') ? '/broken/app.js' : '/dev/app.js'))
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

/**
 * The browser globals the footprint reads. The package compiles without the DOM lib, so the
 * callback views `globalThis` through this shape; it only ever runs inside the page.
 */
interface BrowserGlobals {
  document: { getElementsByTagName(name: string): { length: number } }
}

/** What the page's own realm can observe about itself. */
async function footprint(page: Page): Promise<{ globals: string[]; elements: number }> {
  return await page.evaluate(() => ({
    globals: Object.getOwnPropertyNames(globalThis).sort(),
    // Runs in the page, where globalThis is the window.
    elements: (globalThis as unknown as BrowserGlobals).document.getElementsByTagName('*').length,
  }))
}

async function backendNodeIdOf(cdp: ICDPSession, selector: string): Promise<number> {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  if (!nodeId) throw new Error(`no element matches ${selector}`)
  return (await cdp.send('DOM.describeNode', { nodeId })).node.backendNodeId
}

async function openPage(route: string): Promise<{ page: Page; cdp: ICDPSession }> {
  const page = await browser.newPage()
  await page.goto(`${baseUrl}${route}`)
  await page.waitForSelector('button.send')
  return { page, cdp: await getCDPSessionForPage({ page }) }
}

describe('getReactSource / getReactComponentInfo on a React 19 dev build', () => {
  it('report the component, its JSX site in the original file and its props, and leave the page untouched', async () => {
    const { page, cdp } = await openPage('/react')
    try {
      const before = await footprint(page)
      const requests: string[] = []
      page.on('request', (request) => requests.push(request.url()))
      const button = page.locator('button.send')
      const original = /test\/fixtures\/element-explain-react\/ChatComposer\.tsx$/

      // The element's own JSX site: the <button> written inside SendButton.
      const source = await getReactSource({ locator: button, cdp })
      expect(source?.componentName).toBe('SendButton')
      expect(source?.fileName).toMatch(original)
      expect(source?.lineNumber).toBe(lineOf(fixtureSource, '<button className="send"'))

      const info = await getReactComponentInfo({ locator: button, cdp })
      expect(info?.componentName).toBe('SendButton')
      expect(info?.hierarchy.map((item) => item.componentName)).toEqual(['SendButton', 'ChatComposer', 'ChatPanel', 'App'])
      // Each component's source is the JSX that created it, in its parent's render.
      expect(info?.source?.fileName).toMatch(original)
      expect(info?.source?.lineNumber).toBe(lineOf(fixtureSource, '<SendButton onSend'))
      expect(info?.hierarchy[1].source?.lineNumber).toBe(lineOf(fixtureSource, '<ChatComposer />'))
      expect(info?.hierarchy[2].source?.lineNumber).toBe(lineOf(fixtureSource, '<ChatPanel />'))
      expect(info?.props).toEqual({ onSend: '[function]', disabled: false })
      expect(info?.hierarchy[1].props).toEqual({})

      // The node the caller already knows by id reads the same.
      const backendNodeId = await backendNodeIdOf(cdp, 'button.send')
      expect(await getReactComponentInfo({ backendNodeId, cdp })).toEqual(info)
      expect(await getReactSource({ backendNodeId, cdp })).toEqual(source)

      // The input's own JSX site and its props, read through the same reader.
      const input = await getReactComponentInfo({ locator: page.locator('input'), cdp })
      expect(input?.componentName).toBe('ChatComposer')
      expect(input?.props).toEqual({})
      expect((await getReactSource({ locator: page.locator('input'), cdp }))?.lineNumber).toBe(lineOf(fixtureSource, '<input aria-label="Message"'))

      // React's container has no fiber of its own.
      expect(await getReactComponentInfo({ locator: page.locator('#root'), cdp })).toBeNull()
      expect(await getReactSource({ locator: page.locator('#root'), cdp })).toBeNull()

      const after = await footprint(page)
      expect(after.globals).toEqual(before.globals)
      expect(after.elements).toBe(before.elements)
      expect(requests).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('says why when the source map exists but cannot be loaded, instead of returning null', async () => {
    const { page, cdp } = await openPage('/react-broken')
    try {
      const button = page.locator('button.send')
      await expect(getReactSource({ locator: button, cdp })).rejects.toThrow(/Could not map React's JSX site .*could not load the source map/)
      await expect(getReactComponentInfo({ locator: button, cdp })).rejects.toThrow(/missing\.js\.map|HTTP 404/)
    } finally {
      await page.close()
    }
  })
})
