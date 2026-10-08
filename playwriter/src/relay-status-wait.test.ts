/**
 * The relay's status long-polls (`?until=…&waitMs=N` on /extensions/status and /extension/status) and
 * what they stand on: untilRelayState, a wait woken by the relay store's own subscription. A client
 * asks once and is answered the moment the condition holds, at once when it already does, or at the
 * cap; relay-client's waitForConnectedExtensions is that one request.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import { createCdpLogger } from './cdp-log.js'
import { connectFakeExtension, freePort, type FakeExtension } from './fake-extension.js'
import { waitForConnectedExtensions } from './relay-client.js'
import * as relayState from './relay-state.js'

describe('untilRelayState', () => {
  const connect = (store: StoreApi<relayState.RelayState>) =>
    store.setState((s) => relayState.addExtension(s, { id: 'ext-1', info: {}, stableKey: 'k1', ws: null }))
  const anyExtension = (state: relayState.RelayState) => state.extensions.size > 0

  test('answers at once when the condition already holds', async () => {
    const store = relayState.createRelayStore()
    connect(store)
    const startedAt = performance.now()
    expect(await relayState.untilRelayState(store, anyExtension, { waitMs: 60_000, signal: new AbortController().signal })).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(50)
  })

  test('answers on the state change that makes it hold, not at the cap', async () => {
    const store = relayState.createRelayStore()
    const waiting = relayState.untilRelayState(store, anyExtension, { waitMs: 60_000, signal: new AbortController().signal })
    const startedAt = performance.now()
    connect(store)
    expect(await waiting).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(50)
  })

  test('answers false at the cap, and when its signal aborts', async () => {
    const store = relayState.createRelayStore()
    const startedAt = performance.now()
    expect(await relayState.untilRelayState(store, anyExtension, { waitMs: 100, signal: new AbortController().signal })).toBe(false)
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(99)

    const stop = new AbortController()
    const waiting = relayState.untilRelayState(store, anyExtension, { waitMs: 60_000, signal: stop.signal })
    stop.abort()
    expect(await waiting).toBe(false)
  })
})

type ExtensionsBody = { extensions: Array<{ extensionId: string }> }
type ExtensionBody = { connected: boolean }

/**
 * A real 300 ms, on purpose: nothing tells the test that the relay is holding a request it sent, and
 * these tests are about what happens to a held one; 300 ms is ample for a loopback request to arrive.
 */
function untilRequestHeld(): Promise<void> {
  const held = Promise.withResolvers<void>()
  setTimeout(held.resolve, 300)
  return held.promise
}

describe('status long-polls', () => {
  let port = 0
  let relay: RelayServer | null = null
  let dir = ''
  const fakes: FakeExtension[] = []

  const startRelay = async (relayPort: number) =>
    startPlayWriterCDPRelayServer({
      port: relayPort,
      logger: { log: () => {}, error: () => {} },
      // Never the shared ~/.playwriter CDP log: a relay's CDP logger truncates its file on start.
      cdpLogger: createCdpLogger({ logFilePath: path.join(dir, `cdp-${relayPort}.jsonl`) }),
    })

  const connectExtension = async (name: string) => {
    const fake = await connectFakeExtension({ port, name, query: { browser: 'Chrome', installId: name }, workspace: 'wt:status' })
    fakes.push(fake)
    return fake
  }

  /** Waits until every fake extension is gone from the relay, with the free long-poll itself. */
  const untilNoExtension = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/extension/status?until=free&waitMs=5000`)
    const body = (await response.json()) as ExtensionBody
    expect(body.connected).toBe(false)
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-status-wait-'))
    port = await freePort()
    relay = await startRelay(port)
  })

  afterEach(async () => {
    for (const fake of fakes.splice(0)) {
      fake.ws.close()
    }
    await untilNoExtension()
  })

  afterAll(async () => {
    await relay?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('/extensions/status?until=connected answers as soon as an extension connects', async () => {
    const asked = performance.now()
    const answer = fetch(`http://127.0.0.1:${port}/extensions/status?until=connected&waitMs=10000`)
    await untilRequestHeld()
    await connectExtension('late')
    const connectedAt = performance.now()
    const response = await answer
    const answeredAt = performance.now()
    const body = (await response.json()) as ExtensionsBody
    expect(response.status).toBe(200)
    expect(body.extensions).toHaveLength(1)
    expect(answeredAt - asked).toBeGreaterThanOrEqual(300)
    console.log(`until=connected answered ${(answeredAt - connectedAt).toFixed(1)} ms after the extension's socket opened`)
    expect(answeredAt - connectedAt).toBeLessThan(1000)
  })

  test('/extensions/status?until=connected answers at once when one is connected already', async () => {
    await connectExtension('early')
    const asked = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/extensions/status?until=connected&waitMs=10000`)
    const body = (await response.json()) as ExtensionsBody
    expect(body.extensions).toHaveLength(1)
    expect(performance.now() - asked).toBeLessThan(1000)
  })

  test('/extensions/status?until=connected answers at the cap with none connected', async () => {
    const asked = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/extensions/status?until=connected&waitMs=400`)
    const elapsed = performance.now() - asked
    const body = (await response.json()) as ExtensionsBody
    expect(response.status).toBe(200)
    expect(body.extensions).toEqual([])
    expect(elapsed).toBeGreaterThanOrEqual(399)
    expect(elapsed).toBeLessThan(2000)
  })

  test('/extension/status?until=free answers as soon as the last extension disconnects', async () => {
    const fake = await connectExtension('leaving')
    const asked = performance.now()
    const answer = fetch(`http://127.0.0.1:${port}/extension/status?until=free&waitMs=10000`)
    await untilRequestHeld()
    fake.ws.close()
    const response = await answer
    const body = (await response.json()) as ExtensionBody
    expect(response.status).toBe(200)
    expect(body.connected).toBe(false)
    expect(performance.now() - asked).toBeGreaterThanOrEqual(300)
    expect(performance.now() - asked).toBeLessThan(5000)
  })

  test('/extension/status?until=free answers at the cap, connected, while an extension stays', async () => {
    await connectExtension('staying')
    const asked = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/extension/status?until=free&waitMs=400`)
    const body = (await response.json()) as ExtensionBody
    expect(body.connected).toBe(true)
    expect(performance.now() - asked).toBeGreaterThanOrEqual(399)
  })

  test('a malformed long-poll is a 400 that says why', async () => {
    const cases: Array<[string, string]> = [
      ['/extensions/status?until=connected&waitMs=abc', 'waitMs must be a whole number of milliseconds from 0 to 60000, got abc'],
      ['/extensions/status?until=connected&waitMs=60001', 'waitMs must be a whole number of milliseconds from 0 to 60000, got 60001'],
      ['/extensions/status?until=connected', 'waitMs must be a whole number of milliseconds from 0 to 60000, got none'],
      ['/extensions/status?until=free&waitMs=10', 'until must be "connected" on this route, got "free"'],
      ['/extension/status?until=connected&waitMs=10', 'until must be "free" on this route, got "connected"'],
      ['/extension/status?waitMs=10', 'waitMs needs until=free'],
    ]
    for (const [route, error] of cases) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`)
      expect(response.status, route).toBe(400)
      expect(await response.json(), route).toEqual({ error })
    }
  })

  test('closing the relay answers a long-poll still waiting', async () => {
    const otherPort = await freePort()
    const other = await startRelay(otherPort)
    const asked = performance.now()
    const answer = fetch(`http://127.0.0.1:${otherPort}/extensions/status?until=connected&waitMs=60000`)
    await untilRequestHeld()
    await other.close()
    const body = (await (await answer).json()) as ExtensionsBody
    expect(body.extensions).toEqual([])
    expect(performance.now() - asked).toBeLessThan(5000)
  })

  test('waitForConnectedExtensions is one request answered when an extension connects', async () => {
    const asked = performance.now()
    const waiting = waitForConnectedExtensions({ port, timeoutMs: 10_000 })
    await untilRequestHeld()
    await connectExtension('cli')
    const connectedAt = performance.now()
    const extensions = await waiting
    expect(extensions).toHaveLength(1)
    expect(performance.now() - asked).toBeGreaterThanOrEqual(300)
    console.log(`waitForConnectedExtensions returned ${(performance.now() - connectedAt).toFixed(1)} ms after the extension's socket opened`)
  })

  test('waitForConnectedExtensions refuses a wait the relay would not hold', async () => {
    await expect(waitForConnectedExtensions({ port, timeoutMs: 60_001 })).rejects.toThrow(
      "waitForConnectedExtensions: timeoutMs must be a whole number of milliseconds from 0 to 60000, the relay's longest wait; got 60001",
    )
  })
})
