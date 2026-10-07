/**
 * Two attaches of one tab, forced together.
 *
 * When the relay connection opens, two paths resume on the same connect: a toggle's connectTab,
 * which marked its tab 'connecting' and waited on that connect, and the reconnect loop's re-attach
 * of every 'connecting' tab, which includes that same tab. Each used to call chrome.debugger.attach.
 * MEASURED in a perf-relay run: 'Attaching debugger to tab' twice right after 'Connection
 * established (up 0s)'; the second attach failed with 'Another debugger is already attached', its
 * error path deleted the tab's TabInfo, the first then threw 'has no TabInfo to inherit ownership
 * from', and the relay auto-created a background about:blank tab that the whole test file then ran in.
 *
 * Each round here makes that collision certain rather than lucky: it holds the extension's next
 * relay probe (connect()'s HEAD request), restarts the relay so the reconnect loop starts a connect
 * and stops at that probe, toggles the active tab so its connect joins the held one, and only then
 * lets the probe go.
 */

import http from 'node:http'
import { chromium, type Worker } from '@xmorse/playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExtensionState } from 'mcp-extension/src/types.js'
import { startPlayWriterCDPRelayServer } from './cdp-relay.js'
import { getCdpUrl } from './utils.js'
import {
  cleanupTestContext,
  getExtensionServiceWorker,
  safeCloseCDPBrowser,
  setupTestContext,
  TEST_WORKSPACE,
  testRelayPort,
  type TestContext,
} from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)
const ROUNDS = 10

/** The extension's next relay probe, held until the test lets it go. */
type ProbeHold = {
  taken: boolean
  asked: PromiseWithResolvers<void>
  release: PromiseWithResolvers<void>
}

/** Test instrumentation installed in the extension's service worker. */
type AttachRace = {
  /** chrome.debugger.attach calls per tab. */
  attachCalls: Map<number, number>
  hold: ProbeHold | null
}

/** The part of chrome.debugger this test wraps: the promise form the extension calls. */
type DebuggerAttach = { attach: (target: chrome.debugger.Debuggee, requiredVersion: string) => Promise<void> }

declare global {
  var attachRace: AttachRace | undefined
}

type RoundResult = {
  tabId: number
  isConnected: boolean
  attachCalls: number
  tabState: string
  connectionState: ExtensionState['connectionState']
}

let testCtx: TestContext | null = null
let serviceWorker: Worker
let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>attach race ${req.url}</title><p>attach race</p>`)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`

  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-attach-race-' })
  serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)

  await serviceWorker.evaluate(async () => {
    // The extension connects to the relay on its own; start from that settled state. Polled in real
    // time: the worker exposes its store only as a getter, with no event a test can await.
    const deadline = Date.now() + 20000
    while (globalThis.getExtensionState().connectionState !== 'connected') {
      if (Date.now() > deadline) throw new Error('the extension never connected to the relay')
      const tick = Promise.withResolvers<void>()
      setTimeout(tick.resolve, 50)
      await tick.promise
    }
    const race: AttachRace = { attachCalls: new Map(), hold: null }
    globalThis.attachRace = race
    const debuggerApi: DebuggerAttach = chrome.debugger
    const realAttach = debuggerApi.attach.bind(chrome.debugger)
    debuggerApi.attach = (target, requiredVersion) => {
      if (target.tabId !== undefined) race.attachCalls.set(target.tabId, (race.attachCalls.get(target.tabId) ?? 0) + 1)
      return realAttach(target, requiredVersion)
    }
    const realFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = async (input, init) => {
      const hold = race.hold
      if (hold && !hold.taken && init?.method === 'HEAD') {
        hold.taken = true
        hold.asked.resolve()
        await hold.release.promise
      }
      return await realFetch(input, init)
    }
  })
}, 600000)

afterAll(async () => {
  await cleanupTestContext(testCtx)
  testCtx = null
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
})

describe('a toggle racing the re-attach of connecting tabs', () => {
  it(`attaches the tab once and connects it, ${ROUNDS} rounds`, async () => {
    const ctx = testCtx
    if (!ctx) throw new Error('no test context')
    for (let round = 1; round <= ROUNDS; round++) {
      const url = `${baseUrl}/round-${round}`
      const page = await ctx.browserContext.newPage()
      await page.goto(url)
      await page.bringToFront()

      // Hold the extension's next relay probe, then drop the relay: the extension marks its tabs
      // 'connecting' and its reconnect loop starts a connect that stops at the probe.
      await serviceWorker.evaluate(() => {
        const race = globalThis.attachRace
        if (!race) throw new Error('attach race instrumentation is not installed')
        race.hold = { taken: false, asked: Promise.withResolvers(), release: Promise.withResolvers() }
      })
      await ctx.relayServer.close()
      await serviceWorker.evaluate(async () => {
        const hold = globalThis.attachRace?.hold
        if (!hold) throw new Error('no probe hold')
        const timedOut = Promise.withResolvers<never>()
        const timer = setTimeout(() => timedOut.reject(new Error('the reconnect loop never probed the relay')), 15000)
        await Promise.race([hold.asked.promise, timedOut.promise]).finally(() => clearTimeout(timer))
      })
      ctx.relayServer = await startPlayWriterCDPRelayServer({ port: TEST_PORT, logger: ctx.logger, cdpLogger: ctx.cdpLogger })

      // Toggle the active tab: its connect marks it 'connecting' and joins the held connect. Then
      // let the probe go, so both the toggle and the re-attach resume on the same open.
      const result: RoundResult = await serviceWorker.evaluate(
        async ([key, label]) => {
          const race = globalThis.attachRace
          const hold = race?.hold
          if (!race || !hold) throw new Error('no probe hold')
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
          if (active?.id === undefined) throw new Error('no active tab')
          const tabId = active.id
          race.attachCalls.delete(tabId)
          const toggle = globalThis.toggleExtensionForActiveTab(key, label)
          const deadline = Date.now() + 10000
          while (globalThis.getExtensionState().tabs.get(tabId)?.state !== 'connecting') {
            if (Date.now() > deadline) throw new Error(`tab ${tabId} never became 'connecting'`)
            const tick = Promise.withResolvers<void>()
            setTimeout(tick.resolve, 5)
            await tick.promise
          }
          hold.release.resolve()
          const { isConnected, state } = await toggle
          return {
            tabId,
            isConnected,
            attachCalls: race.attachCalls.get(tabId) ?? 0,
            tabState: state.tabs.get(tabId)?.state ?? 'untracked',
            connectionState: state.connectionState,
          }
        },
        [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
      )
      expect({ round, ...result }).toMatchObject({ round, isConnected: true, attachCalls: 1, tabState: 'connected', connectionState: 'connected' })

      // The workspace's client sees that tab and nothing else: no auto-created about:blank tab.
      const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
      try {
        expect({ round, pages: browser.contexts()[0].pages().map((p) => p.url()) }).toEqual({ round, pages: [url] })
      } finally {
        await safeCloseCDPBrowser(browser)
      }

      // Close the tab so the next round's re-attach has exactly one 'connecting' tab: its own.
      await page.close()
      await serviceWorker.evaluate(async (tabId) => {
        const deadline = Date.now() + 10000
        while (globalThis.getExtensionState().tabs.has(tabId)) {
          if (Date.now() > deadline) throw new Error(`tab ${tabId} is still tracked after it closed`)
          const tick = Promise.withResolvers<void>()
          setTimeout(tick.resolve, 20)
          await tick.promise
        }
      }, result.tabId)
    }
  }, 300000)
})
