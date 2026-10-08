/**
 * The extension's connection to the relay waits on states, not on a clock (extension/src/background.ts,
 * ConnectionManager). Through a real relay and the real extension:
 *
 * - a closed connection wakes the reconnect loop at once (it used to look every 1 s);
 * - while the relay is down the loop tries again every RELAY_RETRY_MS (250 ms): an extension cannot
 *   observe a local port starting to listen, so this is the one wait kept on a timer;
 * - an extension another one replaced waits for the relay's slot with `/extension/status?until=free`,
 *   answered the moment the slot frees (it used to ask every 3 s), and keeps the 3 s backoff against a
 *   relay from before that parameter, which answers at once;
 * - a toggle waits on the store for its tab to leave 'connecting' (it used to look every 100 ms), with
 *   a 30 s cap that names why the tab is still connecting.
 *
 * The extension's requests to the relay are timed by a wrapper around the worker's fetch, on the clock
 * this process shares with the browser (Date.now()).
 */

import http from 'node:http'
import { chromium, type Worker } from '@xmorse/playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { startPlayWriterCDPRelayServer } from './cdp-relay.js'
import { cleanupTestContext, getExtensionServiceWorker, safeCloseCDPBrowser, setupTestContext, TEST_WORKSPACE, testRelayPort, type TestContext } from './test-utils.js'
import { EXTENSION_IDS, getCdpUrl, VERSION } from './utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)

/** The worker's requests to the relay, recorded by the test's fetch wrapper. */
type RelayRequests = {
  /** connect()'s HEAD probes: when each was sent, and whether the relay answered. */
  probes: Array<{ sentAt: number; ok: boolean }>
  /** Resolved by the next probe the relay refuses. */
  refused: PromiseWithResolvers<void> | null
  /** The `/extension/status` requests: their query, when asked and when answered. */
  statuses: Array<{ query: string; askedAt: number; answeredAt: number | null }>
  /** Resolved by the next `/extension/status` request. */
  asked: PromiseWithResolvers<void> | null
  /** Strips the query of `/extension/status`, which makes the relay answer at once, as one from before `?until=free`. */
  asOldRelay: boolean
}

declare global {
  var relayRequests: RelayRequests | undefined
}

const ExtensionsStatus = z.object({ extensions: z.array(z.object({ stableKey: z.string().nullable().optional() })) })

let testCtx: TestContext | null = null
let worker: Worker
let server: http.Server
let baseUrl = ''

function context(): TestContext {
  if (!testCtx) throw new Error('no test context')
  return testCtx
}

/**
 * The relay's extensions once at least one is connected: the relay's own long-poll, answered on its state
 * change. On a connection of its own (agent: false), never a pooled one: this suite closes and restarts
 * the relay in this process, and fetch reused its pooled connection to the closed relay before the end of
 * that connection was read (traced: closed at once by the relay, its end read here 8 ms later, after the
 * next request had been written on it).
 */
async function untilListed(): Promise<Array<{ stableKey?: string | null }>> {
  const answered = Promise.withResolvers<string>()
  const request = http.get(
    `http://127.0.0.1:${TEST_PORT}/extensions/status?until=connected&waitMs=15000`,
    { agent: false, signal: AbortSignal.timeout(17_000) },
    (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () => answered.resolve(body))
      response.on('error', (error) => answered.reject(error))
    },
  )
  request.on('error', (error) => answered.reject(error))
  const { extensions } = ExtensionsStatus.parse(JSON.parse(await answered.promise))
  if (extensions.length === 0) throw new Error('the extension did not connect to the relay within 15 s')
  return extensions
}

/**
 * Date.now() when the extension's connection state first reads `state`: at once when it does already,
 * else at the store change that makes it so (the worker's subscribeExtensionState). The 15 s cap names
 * the state it is in instead.
 */
async function untilConnectionState(state: 'connected' | 'extension-replaced'): Promise<number> {
  return await worker.evaluate(async (wanted) => {
    if (globalThis.getExtensionState().connectionState === wanted) return Date.now()
    const reached = Promise.withResolvers<number>()
    const unsubscribe = globalThis.subscribeExtensionState((now) => {
      if (now.connectionState === wanted) reached.resolve(Date.now())
    })
    // The cap, a real timer on purpose: a state never reached must fail the test, naming the state it is in.
    const cap = setTimeout(
      () => reached.reject(new Error(`the extension is '${globalThis.getExtensionState().connectionState}', not '${wanted}', after 15 s`)),
      15_000,
    )
    try {
      return await reached.promise
    } finally {
      clearTimeout(cap)
      unsubscribe()
    }
  }, state)
}

async function startRelay(): Promise<void> {
  const ctx = context()
  ctx.relayServer = await startPlayWriterCDPRelayServer({ port: TEST_PORT, logger: ctx.logger, cdpLogger: ctx.cdpLogger })
}

/**
 * Connects a stand-in for another worker of the same extension (same browser and install id), which makes
 * the relay close the real one with 4001; resolves once the real one is in 'extension-replaced'.
 */
async function replaceExtension(): Promise<WebSocket> {
  const [listed] = await untilListed()
  const key = /^install:(.+):([^:]+)$/.exec(listed.stableKey ?? '')
  if (!key) throw new Error(`the extension's stable key is not an install key: ${listed.stableKey}`)
  const [, browser, installId] = key
  const stranger = new WebSocket(
    `ws://127.0.0.1:${TEST_PORT}/extension?browser=${encodeURIComponent(browser)}&installId=${encodeURIComponent(installId)}&v=${VERSION}`,
    { headers: { Origin: `chrome-extension://${EXTENSION_IDS[1]}` } },
  )
  const opened = Promise.withResolvers<void>()
  stranger.once('open', () => opened.resolve())
  stranger.once('error', (error) => opened.reject(error))
  await opened.promise
  await untilConnectionState('extension-replaced')
  return stranger
}

/** Resolves once the worker has made `count` `/extension/status` requests since they were last cleared. */
async function untilStatusRequests(count: number): Promise<void> {
  await worker.evaluate(async (wanted) => {
    const requests = globalThis.relayRequests!
    while (requests.statuses.length < wanted) {
      requests.asked = Promise.withResolvers()
      await requests.asked.promise
    }
  }, count)
}

async function leave(stranger: WebSocket): Promise<void> {
  const closed = Promise.withResolvers<void>()
  stranger.once('close', () => closed.resolve())
  stranger.close()
  await closed.promise
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>reconnect ${req.url}</title><p>reconnect</p>`)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`

  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-reconnect-' })
  worker = await getExtensionServiceWorker(testCtx.browserContext)
  await untilListed()
  await worker.evaluate(() => {
    const requests: RelayRequests = { probes: [], refused: null, statuses: [], asked: null, asOldRelay: false }
    globalThis.relayRequests = requests
    const realFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? new URL(input) : null
      if (url && init?.method === 'HEAD') {
        const probe = { sentAt: Date.now(), ok: false }
        requests.probes.push(probe)
        try {
          const response = await realFetch(input, init)
          probe.ok = true
          return response
        } catch (error) {
          requests.refused?.resolve()
          throw error
        }
      }
      if (url && url.pathname === '/extension/status') {
        if (requests.asOldRelay) url.search = ''
        const status: RelayRequests['statuses'][number] = { query: url.search, askedAt: Date.now(), answeredAt: null }
        requests.statuses.push(status)
        requests.asked?.resolve()
        const response = await realFetch(url.toString(), init)
        status.answeredAt = Date.now()
        return response
      }
      return await realFetch(input, init)
    }
  })
}, 600_000)

afterAll(async () => {
  await cleanupTestContext(testCtx)
  testCtx = null
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
})

describe('the extension reconnects on states, not on a clock', () => {
  it('tries the relay again the moment its connection closes, 5 restarts in a row', async () => {
    const rounds: Array<{ round: number; firstProbeAfterMs: number; backAfterMs: number }> = []
    for (let round = 1; round <= 5; round++) {
      await worker.evaluate(() => {
        globalThis.relayRequests!.probes.length = 0
      })
      const closingAt = Date.now()
      await context().relayServer.close()
      await startRelay()
      await untilListed()
      const backAfterMs = Date.now() - closingAt
      const [first] = await worker.evaluate(() => globalThis.relayRequests!.probes)
      if (!first) throw new Error(`round ${round}: the extension reconnected without probing the relay`)
      rounds.push({ round, firstProbeAfterMs: first.sentAt - closingAt, backAfterMs })
    }
    console.log(`relay restarts: ${JSON.stringify(rounds)}`)
    // Before: the loop looked at the socket every 1 s, and slept 3 s after each reconnect.
    for (const { round, firstProbeAfterMs } of rounds) {
      expect({ round, firstProbeAfterMs: firstProbeAfterMs < 300 }).toEqual({ round, firstProbeAfterMs: true })
    }
  }, 120_000)

  it('while the relay is down it tries every 250 ms, and is back within that of the relay listening', async () => {
    await worker.evaluate(() => {
      globalThis.relayRequests!.probes.length = 0
    })
    await context().relayServer.close()
    for (let refused = 0; refused < 4; refused++) {
      await worker.evaluate(async () => {
        const requests = globalThis.relayRequests!
        requests.refused = Promise.withResolvers()
        await requests.refused.promise
      })
    }
    // Right after a refused try: the next one comes RELAY_RETRY_MS later (it used to be 1 s or 3 s).
    await startRelay()
    const listeningAt = Date.now()
    await untilListed()
    const backAfterMs = Date.now() - listeningAt
    const probes = await worker.evaluate(() => globalThis.relayRequests!.probes)
    const refused = probes.filter((probe) => !probe.ok)
    const gaps = refused.slice(1).map((probe, i) => probe.sentAt - refused[i].sentAt)
    console.log(`relay down: gaps between tries ${JSON.stringify(gaps)} ms, back ${backAfterMs} ms after the relay listened`)
    expect(gaps.length).toBeGreaterThanOrEqual(3)
    // RELAY_RETRY_MS apart: not a tight loop, and not the old 1 s / 3 s.
    for (const gap of gaps) {
      expect({ gap, inRange: gap >= 240 && gap < 900 }).toEqual({ gap, inRange: true })
    }
    expect(backAfterMs).toBeLessThan(900)
  }, 120_000)

  it('a replaced extension takes the relay back as soon as the other one leaves, with one long-poll', async () => {
    await worker.evaluate(() => {
      globalThis.relayRequests!.statuses.length = 0
    })
    const stranger = await replaceExtension()
    await untilStatusRequests(1)
    // The status request is out. Before, the relay answered it at once and the extension asked again 3 s later.
    const leftAt = Date.now()
    await leave(stranger)
    const backAfterMs = (await untilConnectionState('connected')) - leftAt
    const statuses = await worker.evaluate(() => globalThis.relayRequests!.statuses)
    console.log(`replaced: back ${backAfterMs} ms after the other extension left; status requests ${JSON.stringify(statuses)}`)
    expect(backAfterMs).toBeLessThan(1500)
    expect(statuses.map((status) => status.query)).toEqual(['?until=free&waitMs=20000'])
    expect(await untilListed()).toHaveLength(1)
  }, 60_000)

  it('against a relay that answers the slot at once (one from before ?until=free) it asks every 3 s', async () => {
    await worker.evaluate(() => {
      const requests = globalThis.relayRequests!
      requests.asOldRelay = true
      requests.statuses.length = 0
    })
    try {
      const stranger = await replaceExtension()
      await untilStatusRequests(2)
      const leftAt = Date.now()
      await leave(stranger)
      const backAfterMs = (await untilConnectionState('connected')) - leftAt
      const statuses = await worker.evaluate(() => globalThis.relayRequests!.statuses)
      const gaps = statuses.slice(1).map((status, i) => status.askedAt - statuses[i].askedAt)
      console.log(`old relay: gaps between status requests ${JSON.stringify(gaps)} ms, back ${backAfterMs} ms after the other extension left`)
      // Each answered at once with the slot taken: the extension backs off SLOT_POLL_BACKOFF_MS (3 s).
      expect(statuses.every((status) => status.query === '' && status.answeredAt !== null && status.answeredAt - status.askedAt < 1000)).toBe(true)
      for (const gap of gaps) {
        expect({ gap, inRange: gap >= 3000 && gap < 4500 }).toEqual({ gap, inRange: true })
      }
      expect(backAfterMs).toBeLessThan(4500)
    } finally {
      await worker.evaluate(() => {
        globalThis.relayRequests!.asOldRelay = false
      })
    }
  }, 60_000)

  it('a toggle while the relay is down fails after 30 s naming why, and the tab is attached once the relay is back', async () => {
    const page = await context().browserContext.newPage()
    const url = `${baseUrl}/toggle-while-down`
    await page.goto(url)
    await page.bringToFront()
    await context().relayServer.close()
    const outcome = await worker.evaluate(
      async ([key, label]) => {
        const startedAt = Date.now()
        try {
          const { isConnected } = await globalThis.toggleExtensionForActiveTab(key, label)
          return { settled: `resolved isConnected=${isConnected}`, ms: Date.now() - startedAt, tabId: globalThis.getExtensionState().currentTabId }
        } catch (error) {
          return { settled: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt, tabId: globalThis.getExtensionState().currentTabId }
        }
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    expect(outcome.settled).toBe(
      `Tab ${outcome.tabId} is still connecting 30000 ms after the toggle: the extension is not connected to the relay on 127.0.0.1:${TEST_PORT} (connection 'idle'); it attaches the tab once the relay accepts it`,
    )
    expect(outcome.ms).toBeGreaterThanOrEqual(30_000)

    await startRelay()
    await untilListed()
    // The reconnect loop re-attaches the tab the toggle left 'connecting': listed at the client's connect, or announced after it.
    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    try {
      const pages = browser.contexts()[0]
      const attached =
        pages.pages().find((candidate) => candidate.url() === url) ??
        (await pages.waitForEvent('page', { predicate: (candidate) => candidate.url() === url, timeout: 15_000 }))
      expect(await attached.evaluate(() => document.title)).toBe('reconnect /toggle-while-down')
    } finally {
      await safeCloseCDPBrowser(browser)
    }
    expect(await worker.evaluate((tabId) => globalThis.getExtensionState().tabs.get(tabId ?? -1)?.state, outcome.tabId)).toBe('connected')
    await page.close()
  }, 120_000)
})
