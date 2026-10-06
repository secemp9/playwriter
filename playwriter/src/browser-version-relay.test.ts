/**
 * The relay answers Playwright's Browser.getVersion with the browser its client is bound to, as that
 * browser's extension identified itself on connect. Playwright takes browser.version() from the
 * product and its platform from the user agent ('Macintosh' means mac), and only on mac does its
 * keyboard attach the editing commands Chrome on macOS runs for Meta+A and similar shortcuts.
 *
 * Fake extensions (a Mac and a Linux browser, one relay) answer the relay over its real WebSocket
 * protocol; a real Playwright client connects over CDP on an ephemeral port.
 */

import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Browser } from '@xmorse/playwright-core'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import { getChromium } from './playwright-import.js'

const EXT_ORIGIN = 'chrome-extension://jfeammnjpkecdekppnclgkkffahnhfhe' // an allowlisted EXTENSION_ID
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

type Forwarded = { method: string; sessionId?: string; params?: Record<string, unknown> }
type FakeBrowser = { name: string; ws: WebSocket; forwarded: Forwarded[]; workspace: string }

let port = 0
let server: RelayServer
const relayLog: string[] = []
const fakes: FakeBrowser[] = []
const browsers: Browser[] = []

function freePort(): Promise<number> {
  const found = Promise.withResolvers<number>()
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => (address && typeof address !== 'string' ? found.resolve(address.port) : found.reject(new Error('no port'))))
  })
  return found.promise
}

function opened(socket: WebSocket): Promise<void> {
  const open = Promise.withResolvers<void>()
  socket.once('open', () => open.resolve())
  socket.once('error', (error) => open.reject(error))
  return open.promise
}

/** A fake extension for one browser, with one page tab owned by `workspace`. */
async function connectFakeBrowser({ name, query, workspace }: { name: string; query: Record<string, string>; workspace: string }): Promise<FakeBrowser> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?${new URLSearchParams(query).toString()}`, { headers: { origin: EXT_ORIGIN } })
  const fake: FakeBrowser = { name, ws, forwarded: [], workspace }
  const event = (method: string, params: unknown, sessionId?: string) => {
    ws.send(JSON.stringify({ method: 'forwardCDPEvent', params: { method, params, sessionId, workspaceKey: workspace } }))
  }
  ws.on('message', (raw: WebSocket.RawData) => {
    const message: { id?: number; method?: string; params?: Forwarded } = JSON.parse(raw.toString())
    if (message.id === undefined || !message.method) return
    const command = message.method === 'forwardCDPCommand' ? message.params : undefined
    if (command) fake.forwarded.push(command)
    let result: unknown = {}
    if (command?.method === 'Page.getFrameTree') {
      result = {
        frameTree: {
          frame: {
            id: `${name}-target`,
            loaderId: 'loader',
            url: 'about:blank',
            domainAndRegistry: '',
            securityOrigin: '://',
            mimeType: 'text/html',
            secureContextType: 'InsecureScheme',
            crossOriginIsolatedContextType: 'NotIsolated',
            gatedAPIFeatures: [],
          },
        },
      }
    }
    ws.send(JSON.stringify({ id: message.id, result }))
    if (command?.method === 'Runtime.enable' && command.sessionId) {
      event(
        'Runtime.executionContextCreated',
        { context: { id: 1, origin: '', name: '', uniqueId: `${name}-ctx`, auxData: { isDefault: true, type: 'default', frameId: `${name}-target` } } },
        command.sessionId,
      )
    }
  })
  await opened(ws)
  event('Target.attachedToTarget', {
    sessionId: `${name}-tab`,
    targetInfo: { targetId: `${name}-target`, type: 'page', title: name, url: 'about:blank', attached: true, canAccessOpener: false, browserContextId: 'ctx' },
    waitingForDebugger: false,
  })
  fakes.push(fake)
  return fake
}

async function connectPlaywright(fake: FakeBrowser, installId: string, clientId = fake.name): Promise<Browser> {
  const chromium = await getChromium()
  const query = new URLSearchParams({ workspace: fake.workspace, workspaceLabel: fake.name, extensionId: `install:Chrome:${installId}` })
  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/cdp/${clientId}?${query.toString()}`)
  browsers.push(browser)
  return browser
}

let mac: FakeBrowser
let linux: FakeBrowser
let macBrowser: Browser
let linuxBrowser: Browser

beforeAll(async () => {
  port = await freePort()
  server = await startPlayWriterCDPRelayServer({
    port,
    host: '127.0.0.1',
    logger: { log: (...args: unknown[]) => relayLog.push(args.map(String).join(' ')), error: () => {} },
  })
  mac = await connectFakeBrowser({
    name: 'mac',
    workspace: 'wt:mac',
    query: { browser: 'Chrome', installId: 'mac-install', userAgent: MAC_UA, browserVersion: '141.0.7390.54' },
  })
  linux = await connectFakeBrowser({
    name: 'linux',
    workspace: 'wt:linux',
    query: { browser: 'Chrome', installId: 'linux-install', userAgent: LINUX_UA, browserVersion: '139.0.7258.5' },
  })
  macBrowser = await connectPlaywright(mac, 'mac-install')
  linuxBrowser = await connectPlaywright(linux, 'linux-install')
}, 60_000)

afterAll(async () => {
  // Close everything, then report what failed to close.
  const failures: unknown[] = []
  for (const browser of browsers) await browser.close().catch((error: unknown) => failures.push(error))
  for (const fake of fakes) fake.ws.close()
  await server?.close()
  if (failures.length > 0) throw new AggregateError(failures, 'a Playwright client did not close cleanly')
})

describe("Browser.getVersion answers with the client's own browser", () => {
  it("reports each connected browser's real version", () => {
    expect(macBrowser.version()).toBe('141.0.7390.54')
    expect(linuxBrowser.version()).toBe('139.0.7258.5')
  })

  it('makes Meta+A carry the selectAll editing command to a Mac, and not to Linux', async () => {
    const macPage = macBrowser.contexts()[0].pages()[0]
    const linuxPage = linuxBrowser.contexts()[0].pages()[0]
    await macPage.keyboard.press('Meta+A')
    await linuxPage.keyboard.press('Meta+A')
    const keyDownsOfA = [mac, linux].map((fake) =>
      fake.forwarded.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params?.code === 'KeyA' && c.params?.type !== 'keyUp'),
    )
    expect(keyDownsOfA.map((commands) => commands.map((command) => command.params?.commands))).toEqual([[['selectAll']], [[]]])
  })

  it('answers an extension that sent no user agent with the former values, and the relay says what that breaks', async () => {
    const old = await connectFakeBrowser({ name: 'old', workspace: 'wt:old', query: { browser: 'Chrome', installId: 'old-install' } })
    const oldBrowser = await connectPlaywright(old, 'old-install')
    expect(oldBrowser.version()).toBe('Extension-Bridge')
    await oldBrowser.contexts()[0].pages()[0].keyboard.press('Meta+A')
    const oldKeyDownsOfA = old.forwarded.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params?.code === 'KeyA' && c.params?.type !== 'keyUp')
    expect(oldKeyDownsOfA.map((command) => command.params?.commands)).toEqual([[]])
    const warning = relayLog.find((line) => line.includes('did not send its user agent'))
    expect(warning).toContain('macOS keyboard shortcuts')
    expect(warning).toContain('browser.version()')
    expect(relayLog.filter((line) => line.includes('did not send')).length).toBe(1)
  })

  it("never changes a headless browser's fonts: Playwright's font override for a headless page is not forwarded", async () => {
    // Playwright reads "headless" from the user agent and then sets default font families on every
    // page it initializes; through the relay that would change the user's tab, and a second client
    // would fail because Chrome takes it only once per page.
    const headless = await connectFakeBrowser({
      name: 'headless',
      workspace: 'wt:headless',
      query: {
        browser: 'Chrome',
        installId: 'headless-install',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/139.0.0.0 Safari/537.36',
        browserVersion: '139.0.7258.5',
      },
    })
    const first = await connectPlaywright(headless, 'headless-install')
    const second = await connectPlaywright(headless, 'headless-install', 'headless-second')
    expect(first.contexts()[0].pages()).toHaveLength(1)
    expect(second.contexts()[0].pages()).toHaveLength(1)
    expect(headless.forwarded.filter((command) => command.method === 'Page.setFontFamilies')).toEqual([])
    expect(relayLog.filter((line) => line.includes('Page.setFontFamilies') && line.includes('not forwarded')).length).toBe(1)
  })
})
