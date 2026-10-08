/**
 * A same-process iframe that Chrome moves into a process of its own while settle reads it.
 *
 * The page (served as `localhost`) holds an iframe of its own site, in its own process: the page's
 * CDP session answers for it. When that iframe navigates to another site (`127.0.0.1`), Chrome
 * moves it into a new renderer process: the page session gets `Page.frameDetached` with reason
 * 'swap' and from then on answers every read of that frame with an error — "No frame for given id
 * found", "Cannot find context with specified id", "Frame with the given frameId is not found"
 * (measured on Chromium 145) — while Playwright keeps the same Frame and follows it on a new session.
 * A settle pass that listed the frames just before the swap read the iframe through the page session,
 * and Chrome's error became its verdict:
 * `NOT SETTLED — cdpSession.send: Protocol error (Page.createIsolatedWorld): No frame for given id found`.
 *
 * Here the swap lands between a pass's listing and its reads every time: the listing is wrapped to
 * navigate the iframe and wait for the swap before it returns. Full Chromium (`channel: 'chromium'`):
 * the headless shell keeps the iframe in the page's process when it navigates to the other site
 * (measured: no `swap`, the same session afterwards), so it never moves.
 */

import { once } from 'node:events'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser } from '@xmorse/playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getCDPSessionForPage } from './cdp-session.js'
import { DialogController } from './dialog-controller.js'
import { PageFrames } from './page-frames.js'
import { PageWatch } from './page-watch.js'

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Help</title></head>
<body><main><h1>Help center</h1><iframe title="Support chat" src="/chat" style="width: 400px; height: 120px"></iframe></main></body></html>`

const CHAT = `<!doctype html><html><head><meta charset="utf-8"><title>Chat</title></head><body><p>Chat ready</p></body></html>`

let browser: Browser
let server: http.Server
let port = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname
    const body = path === '/' ? PAGE : path === '/chat' ? CHAT : null
    if (body === null) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
  })
  // Every interface: the page is loaded as `localhost`, the iframe's second document as `127.0.0.1`.
  server.listen(0)
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the fixture server has no TCP port')
  port = address.port
  browser = await chromium.launch({ channel: 'chromium', headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  server?.closeAllConnections()
  server?.close()
})

describe('an iframe Chrome moves into its own process while settle reads it', () => {
  it('settles: the pass that listed it on the page session leaves it out, the next one reads it on its own session', async () => {
    const page = await browser.newPage()
    const cdp = await getCDPSessionForPage({ page })
    const dialogs = new DialogController({ page })
    dialogs.attach()
    dialogs.bindSession(cdp)
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' })
    const frames = new PageFrames({ page, cdp })
    const watch = new PageWatch({ frames, dialogs, isClosed: () => page.isClosed(), logger: { error: () => {} } })
    watch.start()
    // The journal is installed asynchronously by start(); one probe makes sure it is in place.
    await watch.busySignals()

    const chat = page.frames().find((frame) => frame !== page.mainFrame())
    if (!chat) throw new Error('the page has no iframe')
    const before = (await frames.list()).frames.find((entry) => entry.frame === chat)
    expect(before).toMatchObject({ outOfProcess: false, url: `http://localhost:${port}/chat` })
    expect(before?.cdp).toBe(cdp)

    // The next listing, whoever asks for it during settle, returns the frames as they were, after the
    // iframe has moved into its own process.
    const list = frames.list.bind(frames)
    let armed = true
    let swapped = false
    frames.list = async () => {
      const listed = await list()
      if (armed) {
        armed = false
        const detached = Promise.withResolvers<void>()
        const onDetached = (event: { frameId: string; reason: string }): void => {
          if (event.frameId === chat.frameId() && event.reason === 'swap') detached.resolve()
        }
        cdp.on('Page.frameDetached', onDetached)
        // A real timer: the swap is Chrome's own (measured: 51 ms into a 64 ms navigation); 5 s without
        // it means this browser kept the iframe in the page's process, and the test proves nothing.
        const timer = setTimeout(() => detached.reject(new Error('Chrome did not move the iframe into its own process (no Page.frameDetached reason swap)')), 5000)
        await chat.goto(`http://127.0.0.1:${port}/chat`)
        await detached.promise.finally(() => {
          clearTimeout(timer)
          cdp.off('Page.frameDetached', onDetached)
        })
        swapped = true
      }
      return listed
    }

    const result = await watch.settle({ since: watch.checkpoint() })
    expect(swapped).toBe(true)
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    const after = (await list()).frames.find((entry) => entry.frame === chat)
    expect(after).toMatchObject({ outOfProcess: true, url: `http://127.0.0.1:${port}/chat` })
    expect(after?.cdp).not.toBe(cdp)
    watch.dispose()
    await page.close()
  }, 60_000)
})
