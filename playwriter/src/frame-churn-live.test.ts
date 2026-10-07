/**
 * Frames that come and go, and frames no debugger may enter, against live headless Chromium.
 *
 * A password manager (Bitwarden) injects an inline menu — a custom element holding a
 * `chrome-extension://` iframe — when an email or password field gets focus, and removes it ~26 ms
 * later. Every reader that walks a page's frames lists them first and borrows each frame's CDP
 * session after: a frame removed in between is gone, not an error. The file-chooser gate re-arms on
 * every frame event, from a page event listener with no caller to hand a failure to; a borrow that
 * failed there was an unhandled rejection, which ended the MCP server.
 *
 * The page is served from `localhost`; its cross-site iframes come from `127.0.0.1` (another site:
 * out of process under Chromium's site isolation, with their own CDP session). The extension frame
 * is a real one: a minimal unpacked extension whose page is web-accessible, loaded into Chromium
 * (extensions need full Chromium, not the headless shell), embedded the way a password manager
 * embeds its inline menu.
 */

import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { getAriaSnapshot } from './aria-snapshot.js'
import { getCDPSessionForPage } from './cdp-session.js'
import { DialogController } from './dialog-controller.js'
import { FileChooserGate } from './file-chooser-gate.js'
import { PageFrames } from './page-frames.js'
import { writeFakePasswordManager } from './fake-password-manager.js'
import { getPageMarkdown } from './page-markdown.js'
import { observePage, renderObservation } from './page-observe.js'
import { RefRegistry } from './ref-registry.js'

const CHILD = (name: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body><p>Inside ${name}.</p><button>Button of ${name}</button></body></html>`

/** No iframe of its own: the inline menus it opens are all the frames it has. */
const MENUS = (cross: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Menus</title></head>
<body><h1>Sign up</h1><label>Email <input type="email" id="email"></label>
<script>
  // \`count\` inline menus in one task, every tenth one cross-site (the first one included).
  window.openMenus = (count) => {
    for (let i = 0; i < count; i++) {
      const frame = document.createElement('iframe')
      frame.name = 'menu-' + i
      frame.src = (i % 10 === 0 ? ${JSON.stringify(cross)} : '') + '/child?name=menu-' + i
      document.body.append(frame)
    }
  }
</script></body></html>`

/**
 * Caps how many objects of each kind Playwright's server keeps per connection (`null`: its own caps,
 * 10 000 frames). Past the cap it disposes the oldest — a frame its client still lists among the
 * page's frames, which a borrow then names: `frame: no object with guid frame@…`, Playwright's answer
 * for a frame it no longer has, as in the crash. The server runs in this process (`chromium.launch`),
 * so its module is this one; the package does not export it, hence the path.
 */
function capServerObjects(cap: number | null): void {
  const require = createRequire(import.meta.url)
  const dispatchers: unknown = require(path.join(path.dirname(require.resolve('@xmorse/playwright-core')), 'lib/server/dispatchers/dispatcher.js'))
  const setMax: unknown = typeof dispatchers === 'object' && dispatchers !== null ? Reflect.get(dispatchers, 'setMaxDispatchersForTest') : undefined
  if (typeof setMax !== 'function') throw new Error("Playwright's server has no setMaxDispatchersForTest: frames cannot be made to outlive their server objects.")
  Reflect.apply(setMax, undefined, [cap])
}

const CHURN = (cross: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Churn</title>
<style>iframe { width: 300px; height: 80px; display: block }</style></head>
<body><h1>Sign up</h1>
<iframe title="Stable same-site" src="/child?name=stable-same"></iframe>
<iframe title="Stable cross-site" src="${cross}/child?name=stable-cross"></iframe>
<div id="menus"></div>
<script>
  // An inline menu every few ms, alternately same-site and cross-site, each removed 0-20 ms later.
  let churning = false
  let made = 0
  window.startChurn = () => {
    churning = true
    const tick = () => {
      if (!churning) return
      const frame = document.createElement('iframe')
      frame.title = 'Inline menu'
      frame.src = (made++ % 2 === 0 ? '' : ${JSON.stringify(cross)}) + '/child?name=menu-' + made
      document.getElementById('menus').append(frame)
      setTimeout(() => frame.remove(), Math.floor(Math.random() * 20))
      setTimeout(tick, 4)
    }
    tick()
  }
  window.stopChurn = () => { churning = false; document.getElementById('menus').replaceChildren(); return made }
</script></body></html>`

const SEALED = (menuUrl: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Login</title>
<style>iframe { width: 300px; height: 80px; display: block }</style></head>
<body><h1>Log in</h1><label>Email <input type="email" id="email"></label>
<iframe title="Password manager menu" src="${menuUrl}"></iframe>
<iframe title="Help widget" src="/child?name=help"></iframe>
</body></html>`

let server: http.Server
let port = 0
let browser: Browser
let context: BrowserContext
/** The extension frame's address, once the extension is loaded. */
let menuUrl = ''
/**
 * While set, `/child` answers wait for it: no iframe can commit a navigation before the test lets it.
 * Without it a cross-site menu, committed in a spare renderer, can report its navigation before the
 * page's renderer has reported the last menus attached — before Playwright's server disposes it.
 */
let childrenHeld: Promise<void> | null = null
const rejections: unknown[] = []
const onRejection = (reason: unknown): void => {
  rejections.push(reason)
}
const rejectionMessages = (): string[] => rejections.map((reason) => (reason instanceof Error ? reason.message : String(reason)))

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    const html = (body: string): void => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
    }
    if (url.pathname === '/menus') return html(MENUS(`http://127.0.0.1:${port}`))
    if (url.pathname === '/churn') return html(CHURN(`http://127.0.0.1:${port}`))
    if (url.pathname === '/sealed') return html(SEALED(menuUrl))
    if (url.pathname === '/child') {
      const body = CHILD(url.searchParams.get('name') ?? 'child')
      if (!childrenHeld) return html(body)
      void childrenHeld.then(() => html(body))
      return
    }
    res.writeHead(404)
    res.end()
  })
  // Every interface: the page is loaded as `localhost`, its cross-site iframes as `127.0.0.1`.
  const listening = Promise.withResolvers<void>()
  server.listen(0, () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  // Site isolation on, as in a desktop Chrome: a cross-site iframe is out of process, with its own session.
  browser = await chromium.launch({ headless: true, args: ['--site-per-process'] })
  context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
  // Before vitest.setup.ts's listener, which rethrows: the test records what it saw, vitest still fails the run.
  process.prependListener('unhandledRejection', onRejection)
}, 120_000)

afterAll(async () => {
  process.off('unhandledRejection', onRejection)
  await context?.close()
  await browser?.close()
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
})

interface Tab {
  page: Page
  frames: PageFrames
  gate: FileChooserGate
  observe: () => Promise<string>
  close: () => Promise<void>
}

async function openTab(on: BrowserContext, address: string): Promise<Tab> {
  const page = await on.newPage()
  await page.goto(`http://localhost:${port}${address}`, { waitUntil: 'load' })
  const cdp = await getCDPSessionForPage({ page })
  const frames = new PageFrames({ page, cdp })
  const dialogs = new DialogController({ page })
  dialogs.attach()
  dialogs.bindSession(cdp)
  const gate = new FileChooserGate({ page, frames, dialogs })
  const registry = new RefRegistry()
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  const observe = async (): Promise<string> =>
    renderObservation(await observePage({ page, frames, registry, targetId: targetInfo.targetId, shown: true, previous: null }), { all: true })
  const close = async (): Promise<void> => {
    gate.dispose()
    frames.dispose()
    await page.close()
  }
  return { page, frames, gate, observe, close }
}

/**
 * Real timers: what is waited for comes from outside this process's clock — the browser's answers
 * to calls already sent, then Node's report of a rejection nobody handled, which it makes only once
 * the microtask queue has drained after that answer.
 */
async function settle(ms: number): Promise<void> {
  const waited = Promise.withResolvers<void>()
  setTimeout(() => waited.resolve(), ms)
  await waited.promise
}

describe('frames that leave the page while they are being walked', () => {
  it("the file-chooser re-arm on a frame event skips a frame Playwright's server no longer has", async () => {
    rejections.length = 0
    const tab = await openTab(context, '/menus')
    const { page, frames, gate } = tab
    // An input of ours may still open a file dialog: every frame event re-arms interception.
    const window = await gate.open()
    // 21 menus against a cap of 20: the server disposes the two oldest frames (one cross-site, one
    // same-site) while the client still lists them, and the re-arm the next frame events start
    // borrows a session for each frame the page lists.
    capServerObjects(20)
    const held = Promise.withResolvers<void>()
    childrenHeld = held.promise
    try {
      await page.evaluate(() => Reflect.apply(Reflect.get(globalThis, 'openMenus'), globalThis, [21]))
      // The client lists all 21 menus only once the server has made all 21, and so disposed the two
      // oldest: neither had loaded, as no menu can load before this.
      await expect.poll(() => page.frames().length).toBe(22)
      held.resolve()
      // The two disposed menus never report their navigation to the client; the other 19 load. Under
      // the full suite's load only 13 of 19 had loaded by expect.poll's 1 s default, so the wait gets a
      // deadline that fits a loaded machine; the count it waits for is unchanged.
      const loaded = (): number => page.frames().filter((frame) => frame.name().startsWith('menu-') && frame.url().endsWith(`name=${frame.name()}`)).length
      await expect.poll(loaded, { timeout: 15_000 }).toBe(19)
      await settle(500)
      expect(rejectionMessages()).toEqual([])
      expect(gate.drain().failures).toEqual([])
      // The menus that remain keep their sessions: the page's own first, then the cross-site menus'
      // in tree order. The first cross-site menu has none: its process came only after the server
      // disposed it, and no borrow can name a frame the server no longer has.
      const idOf = (name: string): string => {
        const frame = page.frames().find((candidate) => candidate.name() === name)
        if (!frame) throw new Error(`no frame named ${name}`)
        return frame.frameId()
      }
      const sessions = (await frames.sessions()).map((session) => session.rootId)
      const crossMenus = [idOf('menu-10'), idOf('menu-20')]
      expect(sessions).toEqual([frames.mainFrameId(), ...crossMenus])
      const listing = await frames.list()
      expect(listing.frames.map((entry) => entry.name)).toEqual(expect.arrayContaining(['menu-2', 'menu-10', 'menu-15', 'menu-20']))
      // Each disposed menu the client still lists (nameless: its name came with the navigation it
      // never heard of) is named as gone; nothing else is unreadable.
      expect(listing.unreadable.length).toBe(2)
      for (const entry of listing.unreadable) {
        expect(entry).toEqual(expect.objectContaining({ name: '', url: '', reason: 'it was removed from the page while being read' }))
      }
    } finally {
      held.resolve()
      childrenHeld = null
      capServerObjects(null)
      window.close()
      await tab.close()
    }
  }, 60_000)

  it('sessions(), list(), observe and the gate re-arm keep answering for the frames that remain while iframes churn', async () => {
    rejections.length = 0
    const tab = await openTab(context, '/churn')
    const { page, frames, gate, observe } = tab
    const stableCross = page.frames().find((frame) => frame.url().includes('stable-cross'))
    const stableSame = page.frames().find((frame) => frame.url().includes('stable-same'))
    if (!stableCross || !stableSame) throw new Error(`the stable iframes did not load: ${page.frames().map((frame) => frame.url()).join(', ')}`)
    const crossId = stableCross.frameId()
    const sameId = stableSame.frameId()
    const counts = { sessions: 0, lists: 0, observes: 0, windows: 0 }
    let made = 0
    await page.evaluate(() => Reflect.apply(Reflect.get(globalThis, 'startChurn'), globalThis, []))
    // Each walk repeats for 3 s of the page churning: as many interleavings as the browser produces.
    const until = Date.now() + 3000
    try {
      await Promise.all([
        (async () => {
          while (Date.now() < until) {
            const sessions = await frames.sessions()
            expect(sessions[0].rootId).toBe(frames.mainFrameId())
            expect(sessions.map((session) => session.rootId)).toContain(crossId)
            counts.sessions++
          }
        })(),
        (async () => {
          while (Date.now() < until) {
            const { frames: listed } = await frames.list()
            expect(listed.map((entry) => entry.frameId)).toEqual(expect.arrayContaining([frames.mainFrameId(), sameId, crossId]))
            counts.lists++
          }
        })(),
        (async () => {
          while (Date.now() < until) {
            const text = await observe()
            expect(text).toContain('Button of stable-same')
            expect(text).toContain('Button of stable-cross')
            counts.observes++
          }
        })(),
        (async () => {
          // Windows open and close while frames come and go: each frame event re-arms the gate. A
          // painted frame of the page holds each window open while the page churns.
          while (Date.now() < until) {
            const window = await gate.open()
            await page.evaluate('(() => { const painted = Promise.withResolvers(); requestAnimationFrame(() => painted.resolve()); return painted.promise })()')
            window.close()
            counts.windows++
          }
        })(),
      ])
    } finally {
      made = await page.evaluate(() => Reflect.apply(Reflect.get(globalThis, 'stopChurn'), globalThis, []))
    }
    await settle(300)
    try {
      expect(rejectionMessages()).toEqual([])
      expect(gate.drain().failures).toEqual([])
      expect(made).toBeGreaterThan(50)
      expect(counts.sessions).toBeGreaterThan(5)
      expect(counts.lists).toBeGreaterThan(5)
      expect(counts.observes).toBeGreaterThan(0)
      expect(counts.windows).toBeGreaterThan(5)
    } finally {
      await tab.close()
    }
  }, 60_000)
})

describe('a frame no debugger may enter', () => {
  let extensionDir = ''
  let extensionContext: BrowserContext

  beforeAll(async () => {
    extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-churn-extension-'))
    writeFakePasswordManager({ dir: extensionDir, inlineMenu: false })
    extensionContext = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1000, height: 700 },
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    })
    const worker = extensionContext.serviceWorkers()[0] ?? (await extensionContext.waitForEvent('serviceworker'))
    menuUrl = `chrome-extension://${new URL(worker.url()).host}/menu.html`
  }, 120_000)

  afterAll(async () => {
    await extensionContext?.close()
    fs.rmSync(extensionDir, { recursive: true, force: true })
  })

  it("is not borrowed a session for, and is named for the model as an extension's frame", async () => {
    rejections.length = 0
    const tab = await openTab(extensionContext, '/sealed')
    const { page, frames, gate, observe } = tab
    const sealed = page.frames().find((frame) => frame.url() === menuUrl)
    if (!sealed) throw new Error(`no frame shows ${menuUrl}: ${page.frames().map((frame) => frame.url()).join(', ')}`)
    const borrows = vi.spyOn(extensionContext, 'getExistingCDPSession')
    try {
      const sessions = await frames.sessions()
      expect(sessions.map((session) => session.rootId)).not.toContain(sealed.frameId())

      const reason = `it is a browser extension's frame (${menuUrl}), whose content cannot be read`
      const listing = await frames.list()
      expect(listing.unreadable).toContainEqual(expect.objectContaining({ frameId: sealed.frameId(), sealed: true, reason }))
      expect(listing.frames.map((entry) => entry.url)).toContain(`http://localhost:${port}/child?name=help`)

      const window = await gate.open()
      window.close()

      const text = await observe()
      expect(text).toContain(`iframe "Password manager menu" — not read: ${reason}`)
      expect(text).toContain('Button of help')
      expect(text).not.toContain('Fill password')

      const markdown = await getPageMarkdown({ page, frames, diffStore: new WeakMap() })
      expect(markdown).toContain(`[iframe "Password manager menu"] not read: ${reason}`)

      await expect(getAriaSnapshot({ page, frame: sealed })).rejects.toThrow(`The iframe cannot be read: ${reason}.`)

      expect(borrows.mock.calls.filter(([target]) => target === sealed)).toEqual([])
      await settle(300)
      expect(rejectionMessages()).toEqual([])
    } finally {
      borrows.mockRestore()
      await tab.close()
    }
  }, 60_000)
})
