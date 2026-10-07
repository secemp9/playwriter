/**
 * The whole-page reads one action makes, through the real extension (chrome.debugger behind the
 * relay), where every CDP round trip also crosses the relay and the extension: each picture reads
 * the accessibility tree and the DOM once, and settling reads neither. Counted at the CDP adapter
 * every read goes through, as speed-live.test.ts does in a launched browser.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightCDPSessionAdapter } from './cdp-session.js'
import { PlaywrightExecutor } from './executor.js'
import type { CDPEventBase } from './cdp-types.js'
import { cleanupTestContext, getExtensionServiceWorker, setupTestContext, TEST_WORKSPACE, testRelayPort, type TestContext } from './test-utils.js'

const TEST_PORT = testRelayPort(import.meta.url)
const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

let server: http.Server
let baseUrl = ''
let cwd = ''
let testCtx: TestContext | null = null
let executor: PlaywrightExecutor

/** The CDP methods sent through any page's adapter while recording. */
let sends: string[] | null = null
const originalSend = PlaywrightCDPSessionAdapter.prototype.send

beforeAll(async () => {
  PlaywrightCDPSessionAdapter.prototype.send = function (this: PlaywrightCDPSessionAdapter, ...args: Parameters<PlaywrightCDPSessionAdapter['send']>) {
    sends?.push(args[0])
    return originalSend.apply(this, args)
  } as PlaywrightCDPSessionAdapter['send']
  server = http.createServer((req, res) => {
    const file = path.join(LAB, path.normalize(new URL(req.url ?? '/', 'http://localhost').pathname))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}/form.html`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-relay-'))

  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-speed-relay-' })
  const serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)
  const userPage = await testCtx.browserContext.newPage()
  await userPage.goto(baseUrl, { waitUntil: 'load' })
  await userPage.bringToFront()
  // The executor must find this tab in its workspace when it connects: wait until the relay registered it.
  const relay = testCtx.relayServer
  const attached = Promise.withResolvers<void>()
  const attachedUrls: string[] = []
  const onEvent = ({ event }: { event: CDPEventBase }): void => {
    if (event.method !== 'Target.attachedToTarget' || typeof event.params !== 'object' || event.params === null) return
    const targetInfo: unknown = Reflect.get(event.params, 'targetInfo')
    const url: unknown = typeof targetInfo === 'object' && targetInfo !== null ? Reflect.get(targetInfo, 'url') : undefined
    attachedUrls.push(typeof url === 'string' ? url : String(url))
    if (url === baseUrl) attached.resolve()
  }
  relay.on('cdp:event', onEvent)
  // Real timer: the extension attaches a real tab in a real browser; fail naming what it attached instead.
  const deadline = setTimeout(() => attached.reject(new Error(`the extension did not attach ${baseUrl} within 60 s; it attached: ${JSON.stringify(attachedUrls)}`)), 60_000)
  try {
    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    await attached.promise
  } finally {
    clearTimeout(deadline)
    relay.off('cdp:event', onEvent)
  }
  executor = new PlaywrightExecutor({ cdpConfig: { port: TEST_PORT, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
}, 600_000)

afterAll(async () => {
  PlaywrightCDPSessionAdapter.prototype.send = originalSend
  await cleanupTestContext(testCtx)
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('an action through the extension reads each whole-page tree once per picture', () => {
  it('act.click: two accessibility trees and two DOM reads (before and after), none in settle', async () => {
    const look = await executor.execute('await observe({ all: true })', 30000)
    expect(look.isError, look.text).toBe(false)
    const ref = /\[(\d+)\] radio "Pro/.exec(look.text)?.[1]
    expect(ref, look.text).toBeDefined()
    sends = []
    const result = await executor.execute(`await act.click(${ref})`, 30000)
    const recorded = sends
    sends = null
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/\[unchecked\] → \[checked\]/)
    const count = (...methods: string[]): number => recorded.filter((method) => methods.includes(method)).length
    expect({ axTrees: count('Accessibility.getFullAXTree'), domReads: count('DOM.getDocument', 'DOM.getFlattenedDocument') }).toEqual({ axTrees: 2, domReads: 2 })
  }, 90000)
})
