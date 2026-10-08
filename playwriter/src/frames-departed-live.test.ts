/**
 * Iframes whose document departs while playwriter works on them, against live headless Chromium.
 *
 *  - observe() reads each document's pointer listeners after its layout snapshot. MDN's live examples
 *    commit their documents seconds after the page loaded (one after the other), and an action whose
 *    before-picture read a frame's document just before the frame committed the next one failed with
 *    `DOM.resolveNode: Node with given id does not belong to the document` (measured through the
 *    extension on MDN; a retry worked). The frame is read again, on its new document.
 *  - The file-chooser gate holds interception per renderer session. An iframe whose document moved to
 *    another process (or left the page) takes its session with it: releasing or holding on that session
 *    fails, and that failure was printed as a `FILE DIALOG watch` line although nothing was left to hold
 *    (measured through the extension: `Page.setInterceptFileChooserDialog: No tab found`). Such a session
 *    is skipped without a line; a failure on a session that still carries a frame is still reported.
 *
 * The page is served from `localhost`; its cross-site iframe from `127.0.0.1` (out of process under site
 * isolation). What moves a document is the page's own script (`window.go…`), as on the sites measured.
 */

import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Frame, Page } from '@xmorse/playwright-core'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'
import { getCDPSessionForFrame, getCDPSessionForPage } from './cdp-session.js'
import type { ICDPSession } from './cdp-session.js'
import { DialogController } from './dialog-controller.js'
import { FileChooserGate } from './file-chooser-gate.js'
import { PageFrames } from './page-frames.js'
import { observePage, renderObservation } from './page-observe.js'
import { RefRegistry } from './ref-registry.js'

const CHILD = (name: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body><p>Inside ${name}.</p><button>Button of ${name}</button></body></html>`

/** One iframe, cross-site when `?cross` is set; `goSameSite(name)` / `goCrossSite(name)` navigate it. */
const PAGE = (cross: string, crossFirst: boolean): string => `<!doctype html><html><head><meta charset="utf-8"><title>Examples</title>
<style>iframe { width: 400px; height: 90px; display: block }</style></head>
<body><h1>Examples</h1><button>Run</button>
<iframe id="example" title="Example" src="${crossFirst ? cross : ''}/child?name=first"></iframe>
<script>
  const frame = document.getElementById('example')
  window.goSameSite = (name) => { frame.src = '/child?name=' + name }
  window.goCrossSite = (name) => { frame.src = ${JSON.stringify(cross)} + '/child?name=' + name }
</script></body></html>`

let server: http.Server
let port = 0
let browser: Browser
let context: BrowserContext

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (url.pathname === '/child') return res.end(CHILD(url.searchParams.get('name') ?? 'child'))
    res.end(PAGE(`http://127.0.0.1:${port}`, url.searchParams.has('cross')))
  })
  // Every interface: the page is loaded as `localhost`, its cross-site iframe as `127.0.0.1`.
  const listening = Promise.withResolvers<void>()
  server.listen(0, () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  browser = await chromium.launch({ headless: true, args: ['--site-per-process'] })
  context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
}, 120_000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
})

async function openPage(crossFirst: boolean): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`http://localhost:${port}/${crossFirst ? '?cross' : ''}`, { waitUntil: 'load' })
  await expect.poll(() => page.frames().some((frame) => frame.url().endsWith('name=first'))).toBe(true)
  return page
}

/** The page's iframe once it shows the document `name`. */
async function navigated(page: Page, name: string): Promise<Frame> {
  const done = Promise.withResolvers<Frame>()
  const onNavigated = (frame: Frame): void => {
    if (frame.url().endsWith(`name=${name}`)) done.resolve(frame)
  }
  page.on('framenavigated', onNavigated)
  try {
    return await done.promise
  } finally {
    page.off('framenavigated', onNavigated)
  }
}

/** Run the page's own `window[fn](name)` (its script moves its iframe), and wait until the iframe shows `name`. */
async function pageMovesFrame(page: Page, fn: 'goSameSite' | 'goCrossSite', name: string): Promise<Frame> {
  const shown = navigated(page, name)
  await page.evaluate(([f, n]) => Reflect.apply(Reflect.get(globalThis, f), globalThis, [n]), [fn, name] as const)
  return await shown
}

describe("observe() while an iframe's document departs", () => {
  it('reads the iframe again on its new document when it commits one while its pointer listeners are read', async () => {
    const page = await openPage(false)
    const cdp = await getCDPSessionForPage({ page })
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    // The page commits the iframe's next document exactly while observe() reads the listeners of the
    // one it took a snapshot of: the read goes out once the frame showing `second` is there.
    let moves = 0
    const racing: ICDPSession = {
      send: async <K extends keyof ProtocolMapping.Commands>(method: K, params?: ProtocolMapping.Commands[K]['paramsType'][0]): Promise<ProtocolMapping.Commands[K]['returnType']> => {
        const listenerRead = method === 'DOM.resolveNode' && typeof params === 'object' && params !== null && String(Reflect.get(params, 'objectGroup')).startsWith('playwriter-listeners-')
        if (listenerRead && Reflect.get(params, 'backendNodeId') !== root.backendNodeId && moves === 0) {
          moves++
          await pageMovesFrame(page, 'goSameSite', 'second')
        }
        return await cdp.send(method, params)
      },
      on: (event, callback) => cdp.on(event, callback),
      off: (event, callback) => cdp.off(event, callback),
      detach: () => cdp.detach(),
    }
    const frames = new PageFrames({ page, cdp: racing })
    try {
      const { targetInfo } = await cdp.send('Target.getTargetInfo')
      const observation = await observePage({ page, frames, registry: new RefRegistry(), targetId: targetInfo.targetId, shown: true, previous: null })
      expect(moves).toBe(1)
      const text = renderObservation(observation, { all: true })
      expect(text).toContain('button "Button of second"')
      expect(text).not.toContain('Button of first')
    } finally {
      frames.dispose()
      await page.close()
    }
  }, 60_000)
})

describe('the file-chooser gate and sessions whose document departed', () => {
  async function gateOf(page: Page): Promise<{ gate: FileChooserGate; frames: PageFrames }> {
    const cdp = await getCDPSessionForPage({ page })
    const frames = new PageFrames({ page, cdp })
    const dialogs = new DialogController({ page })
    dialogs.attach()
    dialogs.bindSession(cdp)
    return { gate: new FileChooserGate({ page, frames, dialogs }), frames }
  }

  it('says nothing about the session of an iframe whose document moved into the page’s process', async () => {
    const page = await openPage(true)
    const { gate, frames } = await gateOf(page)
    try {
      const cross = page.frames().find((frame) => frame.url().startsWith(`http://127.0.0.1:${port}/`))
      const own = cross ? await getCDPSessionForFrame({ frame: cross }) : null
      if (!own) throw new Error('the cross-site iframe has no session of its own')
      // An input of ours may open a file dialog: the page's and the iframe's sessions hold dialogs back.
      const window = await gate.open()
      // The page's script moves its iframe to a same-site document: the frame stays, its session goes.
      await pageMovesFrame(page, 'goSameSite', 'second')
      await expect.poll(async () => await own.send('Page.getFrameTree').then(() => 'live', () => 'gone')).toBe('gone')
      // The input's window ends: interception is released on every session it was set on.
      window.close()
      // The release went out on that session before this, and is answered before it.
      await own.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
      // Whatever a re-arm sent on the page's session is answered before this.
      await (await getCDPSessionForPage({ page })).send('Page.getFrameTree')
      expect(gate.drain().failures).toEqual([])
    } finally {
      gate.dispose()
      frames.dispose()
      await page.close()
    }
  }, 60_000)

  it('still reports a failure on a session that carries a frame', async () => {
    const page = await openPage(true)
    const { gate, frames } = await gateOf(page)
    try {
      const cross = page.frames().find((frame) => frame.url().startsWith(`http://127.0.0.1:${port}/`))
      const own = cross ? await getCDPSessionForFrame({ frame: cross }) : null
      if (!own) throw new Error('the cross-site iframe has no session of its own')
      // That session refuses the toggle (as a browser could), while its frame stays on the page.
      const send = own.send.bind(own)
      Reflect.set(own, 'send', async (method: string, params?: unknown) => {
        if (method === 'Page.setInterceptFileChooserDialog') throw new Error('Protocol error (Page.setInterceptFileChooserDialog): refused for this test')
        return await Reflect.apply(send, own, [method, params])
      })
      const window = await gate.open()
      window.close()
      await expect.poll(() => gate.drain().failures.join('\n')).toContain('refused for this test')
    } finally {
      gate.dispose()
      frames.dispose()
      await page.close()
    }
  }, 60_000)
})
