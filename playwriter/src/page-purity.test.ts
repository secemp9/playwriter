/**
 * The page under test is never modified by Playwriter — proved through the real extension.
 *
 * Attaching used to inject three things into every controlled tab's main world (a
 * contextmenu listener writing `window.__playwriter_lastRightClicked`, the ghost-cursor
 * bundle, and a shadow-DOM toolbar with `playwriterPinnedElemN` globals). These tests compare
 * an attached tab with an identical tab Playwriter never touched, before and after a
 * Playwright click and across a reload, and prove the element-pinning that replaced the
 * toolbar runs on Chrome's own picker (`Overlay.setInspectMode`) — reaching the Node side
 * through the relay — without leaving anything in the page.
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, Page } from '@xmorse/playwright-core'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getCdpUrl } from './utils.js'
import { getCDPSessionForPage, type ICDPSession } from './cdp-session.js'
import { GhostCursorController } from './ghost-cursor-controller.js'
import { PinTracker, PickTimeoutError } from './element-pins.js'
import {
  setupTestContext,
  cleanupTestContext,
  getExtensionServiceWorker,
  TEST_WORKSPACE,
  type TestContext,
  safeCloseCDPBrowser,
  testRelayPort,
} from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>purity fixture</title></head>
<body style="margin:0"><h1 style="margin:0;height:60px">Purity</h1>
<button id="b" style="position:absolute;left:100px;top:100px;width:120px;height:40px"
  onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Click</button>
</body></html>`

const BUTTON_CENTRE = { x: 160, y: 120 }

/** The React 19 dev-build fixture shared with element-explain-live.test.ts. */
const REACT_FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/element-explain-react')
const REACT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>react purity</title></head>
<body><div id="root"></div><script type="module" src="/dev/app.js"></script></body></html>`

/** What the page's own realm can observe about itself. */
async function footprint(page: Page): Promise<{ elements: number; globals: string[] }> {
  return page.evaluate(() => ({
    elements: document.querySelectorAll('*').length,
    globals: Object.getOwnPropertyNames(globalThis).sort(),
  }))
}

async function clicksOn(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.getElementById('b').dataset.clicks || 0))
}

async function humanClick(cdp: ICDPSession, at: { x: number; y: number }): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)
}

describe('page purity through the extension', () => {
  let testCtx: TestContext | null = null
  let server: http.Server
  let bundleDir: string
  let url: string
  let control: Page
  let attached: Page
  let direct: Browser
  let relayPage: Page

  beforeAll(async () => {
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-purity-react-'))
    execFileSync('bun', [path.join(REACT_FIXTURE_DIR, 'build.ts'), path.join(bundleDir, 'dev')], { stdio: 'pipe' })
    server = http.createServer((req, res) => {
      const asset = /^\/dev\/app\.js(\.map)?$/.exec(req.url ?? '/')
      if (asset) {
        res.writeHead(200, { 'Content-Type': asset[1] ? 'application/json' : 'text/javascript' })
        res.end(fs.readFileSync(path.join(bundleDir, req.url!.slice(1))))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(req.url === '/react' ? REACT_HTML : FIXTURE_HTML)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`

    testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-page-purity-' })
    const browserContext = testCtx.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    control = await browserContext.newPage()
    await control.goto(url)
    attached = await browserContext.newPage()
    await attached.goto(url)
    await attached.bringToFront()
    const toggled = await serviceWorker.evaluate(
      async ([k, l]) => (await globalThis.toggleExtensionForActiveTab(k, l)).isConnected,
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    expect(toggled).toBe(true)

    direct = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    const found = direct.contexts()[0].pages().find((p) => p.url() === url)
    if (!found) throw new Error(`The attached tab ${url} is not visible through the relay`)
    relayPage = found
  }, 600000)

  afterAll(async () => {
    if (direct) await safeCloseCDPBrowser(direct)
    await cleanupTestContext(testCtx)
    testCtx = null
    await new Promise<void>((r) => server?.close(() => r()))
    if (bundleDir) fs.rmSync(bundleDir, { recursive: true, force: true })
  })

  it('attaching, a Playwright click and a reload leave the main world identical to an untouched tab', async () => {
    const reference = await footprint(control)
    expect(await footprint(attached)).toEqual(reference)

    // What the executor wires on every page: the pointer track hook. It must record the
    // click on the Node side and put nothing in the page.
    const controller = new GhostCursorController({ logger: { error: () => {} } })
    controller.attachToPage({ page: relayPage })
    await relayPage.locator('#b').click()
    expect(await clicksOn(attached)).toBe(1)
    expect(controller.pointerTrack({ page: relayPage }).latest()).toMatchObject({ kind: 'up', x: BUTTON_CENTRE.x, y: BUTTON_CENTRE.y })

    const afterClick = await footprint(attached)
    expect(afterClick).toEqual(reference)
    expect(afterClick.globals.filter((k) => /playwriter/i.test(k))).toEqual([])

    // No init script either: a fresh document of the attached tab is still pristine.
    await attached.reload()
    await relayPage.waitForLoadState('load')
    expect(await footprint(attached)).toEqual(await footprint(control))
    controller.detachFromPage({ page: relayPage })
  }, 60000)

  it("pickElement resolves to the node the human clicked in Chrome's picker, then turns the picker off", async () => {
    const cdp = await getCDPSessionForPage({ page: relayPage })
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#b' })
    const { node } = await cdp.send('DOM.describeNode', { nodeId })

    // Know when the picker is really on, so the simulated human click lands inside it.
    const { promise: pickerIsOn, resolve: pickerOn } = Promise.withResolvers<void>()
    const watched: ICDPSession = {
      send: async (method, params) => {
        const result = await cdp.send(method, params)
        if (method === 'Overlay.setInspectMode' && (params as { mode?: string } | undefined)?.mode === 'searchForNode') {
          pickerOn()
        }
        return result
      },
      on: (event, callback) => cdp.on(event, callback),
      off: (event, callback) => cdp.off(event, callback),
      detach: () => cdp.detach(),
    }
    const tracker = new PinTracker({ cdp: watched, getUrl: () => relayPage.url() })

    const clicksBefore = await clicksOn(attached)
    const picking = tracker.pickElement({ timeoutMs: 15000 })
    await pickerIsOn
    await humanClick(cdp, BUTTON_CENTRE)
    expect(await picking).toEqual({ backendNodeId: node.backendNodeId })
    // The picker swallowed the human's click; the page never saw it.
    expect(await clicksOn(attached)).toBe(clicksBefore)
    // An agent pick is an answer, not a standing pin.
    expect(tracker.pins()).toEqual([])

    // Inspect mode is off again: the same click now reaches the page.
    await humanClick(cdp, BUTTON_CENTRE)
    expect(await clicksOn(attached)).toBe(clicksBefore + 1)

    // A pick nobody answers times out with a named error and still turns the picker off.
    await expect(tracker.pickElement({ timeoutMs: 400 })).rejects.toBeInstanceOf(PickTimeoutError)
    await humanClick(cdp, BUTTON_CENTRE)
    expect(await clicksOn(attached)).toBe(clicksBefore + 2)

    tracker.dispose()
    expect(await footprint(attached)).toEqual(await footprint(control))
  }, 60000)

  it('a pin started from the extension reaches the PinTracker through the relay', async () => {
    const serviceWorker = await getExtensionServiceWorker(testCtx!.browserContext)
    const cdp = await getCDPSessionForPage({ page: relayPage })
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'h1' })
    const { node } = await cdp.send('DOM.describeNode', { nodeId })

    const tracker = new PinTracker({ cdp, getUrl: () => relayPage.url() })
    tracker.start()

    const tabId = await serviceWorker.evaluate(() => {
      const connected = Array.from(globalThis.getExtensionState().tabs.entries()).filter(([, t]) => t.state === 'connected')
      return connected.length === 1 ? connected[0][0] : null
    })
    expect(tabId).not.toBeNull()
    // What the "Pin an element for Playwriter" context-menu item runs.
    await serviceWorker.evaluate(([id]) => globalThis.startElementPick(id, 'pin'), [tabId!] as [number])

    await humanClick(cdp, { x: 300, y: 30 })
    await until(async () => tracker.pins().length === 1, 'the pin to arrive through the relay')
    expect(tracker.pins()[0]).toMatchObject({ backendNodeId: node.backendNodeId, url })

    // The extension turned its picker off: clicks reach the page again.
    const clicksBefore = await clicksOn(attached)
    await until(async () => {
      await humanClick(cdp, BUTTON_CENTRE)
      return (await clicksOn(attached)) > clicksBefore
    }, 'the extension to turn its picker off')

    // The reference the human pastes to the agent went to the clipboard (written by the
    // extension's offscreen document, not by the page).
    const reader = await testCtx!.browserContext.newPage()
    await reader.goto(url)
    await testCtx!.browserContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin })
    await reader.bringToFront()
    const expectedCommand = `playwriter -e 'inspectPinnedElement(${JSON.stringify({ url, backendNodeId: node.backendNodeId })})'`
    await until(
      async () => (await reader.evaluate(() => window.navigator.clipboard.readText())) === expectedCommand,
      'the pinned-element command on the clipboard',
    )
    await reader.close()

    tracker.dispose()
    expect(await footprint(attached)).toEqual(await footprint(control))
  }, 60000)

  it("copying a React component's source reads the fiber and the source map without touching the page", async () => {
    const browserContext = testCtx!.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const reactUrl = new URL('/react', url).href

    const reactControl = await browserContext.newPage()
    await reactControl.goto(reactUrl)
    await reactControl.waitForSelector('button.send')
    const reactPage = await browserContext.newPage()
    await reactPage.goto(reactUrl)
    await reactPage.waitForSelector('button.send')
    await reactPage.bringToFront()
    await serviceWorker.evaluate(
      async ([k, l]) => (await globalThis.toggleExtensionForActiveTab(k, l)).isConnected,
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    const before = await footprint(reactPage)
    expect(before).toEqual(await footprint(reactControl))

    const tabId = await serviceWorker.evaluate(async (target) => {
      const connected = Array.from(globalThis.getExtensionState().tabs.entries()).filter(([, t]) => t.state === 'connected')
      for (const [id] of connected) if ((await chrome.tabs.get(id)).url === target) return id
      return null
    }, reactUrl)
    expect(tabId).not.toBeNull()
    await until(async () => direct.contexts()[0].pages().some((p) => p.url() === reactUrl), 'the React tab through the relay')
    const relayReact = direct.contexts()[0].pages().find((p) => p.url() === reactUrl)!
    const cdp = await getCDPSessionForPage({ page: relayReact })
    const box = await reactPage.locator('button.send').boundingBox()

    // What the "Copy React component source" context-menu item runs.
    await serviceWorker.evaluate(([id]) => globalThis.startElementPick(id, 'react-source'), [tabId!] as [number])
    await humanClick(cdp, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })

    // The JSX site of the <button> inside SendButton, mapped back to ChatComposer.tsx.
    const fixtureSource = fs.readFileSync(path.join(REACT_FIXTURE_DIR, 'ChatComposer.tsx'), 'utf8')
    const buttonLine = fixtureSource.split('\n').findIndex((line) => line.includes('<button className="send"')) + 1
    expect(buttonLine).toBeGreaterThan(0)
    const reader = await browserContext.newPage()
    await reader.goto(url)
    await reader.bringToFront()
    let copied = ''
    await until(async () => {
      copied = await reader.evaluate(() => window.navigator.clipboard.readText())
      return copied.endsWith(`ChatComposer.tsx:${buttonLine}`)
    }, `ChatComposer.tsx:${buttonLine} on the clipboard`)
    expect(copied).not.toMatch(/^https?:/)
    await reader.close()

    // Reading the fiber left nothing behind: no bippy, no globals, no elements.
    expect(await footprint(reactPage)).toEqual(before)
  }, 120000)
})
