import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import WebSocket from 'ws'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import { testRelayPort } from './test-utils.js'

// ─────────────────────────────────────────────────────────────────────────────────────────
// CDP per-session ordering: a session's execution-context events may not overtake the
// responses to commands the same client sent EARLIER on that session.
//
// This is the invariant behind "a second connected target hangs". Measured in a real run
// (three connected page targets, two Playwright clients): for the third session the relay
// delivered
//     Runtime.executionContextCreated id=5 isDefault=false
//     Runtime.executionContextCreated id=4 isDefault=false
//     Runtime.executionContextCreated id=3 isDefault=TRUE
//     …and only then the response to that client's Page.getFrameTree for the same session.
// The two sessions whose frame-tree response won the race worked; the inverted one did not.
//
// Playwright cannot survive that. FrameSession._initialize registers its
// Runtime.executionContextCreated listener INSIDE the Page.getFrameTree().then() callback
// (crPage.ts:457-461 in the pinned playwright-core 1.59.10), and _onExecutionContextCreated
// (crPage.ts:654) additionally drops any context whose auxData.frameId is not yet a known
// frame. Chrome emits executionContextCreated exactly once per Runtime.enable, so a dropped
// main-world context never comes back: frame._context('main') never resolves and
// page.evaluate against that target waits forever — Playwright's dispatcher runs evaluate
// under ProgressController.run(task, params?.timeout) (dispatcher.ts:107) and
// frame.evaluateExpression sends no timeout, so there is no deadline at all.
//
// Real CDP cannot produce that ordering: one session is one ordered pipe. This bridge is not
// one pipe — a command goes relay → extension → chrome.debugger.sendCommand and returns as a
// promise resolution, while an event arrives through chrome.debugger.onEvent as an
// independent push — so the relay has to restore the ordering itself. That is the
// Runtime.enable fence in cdp-relay.ts, and this is its test.
//
// WHY A FAKE EXTENSION rather than real Chrome. The inversion is a race: against real Chrome
// on a fast machine it shows up only under specific load (it was reproduced through the full
// snapshot-tools suite, where a second long-lived client is mid-initialization of a freshly
// attached tab). A test that has to win a race is a test that mostly proves nothing. The fake
// extension here does not simulate the bug, it *causes the exact condition* — it answers
// Page.getFrameTree late and emits the execution contexts early — so the assertion is
// deterministic on every run. Deleting the fence makes it fail every time.
// ─────────────────────────────────────────────────────────────────────────────────────────

const TEST_PORT = testRelayPort(import.meta.url)
const EXT_ORIGIN = 'chrome-extension://jfeammnjpkecdekppnclgkkffahnhfhe' // an allowlisted EXTENSION_ID
const WORKSPACE_KEY = 'wt:two-targets'
const WORKSPACE_LABEL = 'two-targets'

/** How long the fake extension sits on a Page.getFrameTree before answering it. */
const FRAME_TREE_DELAY_MS = 400

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const quietLogger = { log: () => {}, error: () => {} }

function pageTarget(targetId: string, url: string) {
  return {
    targetId,
    type: 'page',
    title: url,
    url,
    attached: true,
    canAccessOpener: false,
    browserContextId: 'ctx1',
  }
}

type Inbound = { id?: number; method?: string; sessionId?: string; params?: any; result?: any; error?: any }

/**
 * A raw CDP client that records the ARRIVAL ORDER of everything the relay sends it. Order is
 * the whole subject here, so nothing may be collapsed into a set or a map.
 */
class RecordingClient {
  readonly ws: WebSocket
  readonly received: Inbound[] = []
  private nextId = 1

  constructor(clientId: string) {
    const query = new URLSearchParams({ workspace: WORKSPACE_KEY, workspaceLabel: WORKSPACE_LABEL }).toString()
    this.ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/cdp/${clientId}?${query}`)
    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.received.push(JSON.parse(raw.toString()) as Inbound)
      } catch {
        /* non-JSON frames are not part of the protocol under test */
      }
    })
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve())
      this.ws.on('error', reject)
      this.ws.on('close', (code, reason) => reject(new Error(`client closed ${code} ${reason}`)))
    })
  }

  /** Fire a command without waiting, the way Playwright pipelines its init batch. */
  fire(msg: { method: string; sessionId?: string; params?: unknown }): number {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, ...msg }))
    return id
  }

  async waitForResponse(id: number, timeoutMs = 10000): Promise<Inbound> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.received.find((m) => m.id === id)
      if (found) return found
      await sleep(10)
    }
    throw new Error(`No response for command id ${id} within ${timeoutMs}ms`)
  }

  indexOfResponse(id: number): number {
    return this.received.findIndex((m) => m.id === id)
  }

  indexOfFirstEvent(method: string, sessionId: string): number {
    return this.received.findIndex((m) => m.method === method && m.sessionId === sessionId)
  }

  contextIdsFor(sessionId: string): number[] {
    return this.received
      .filter((m) => m.method === 'Runtime.executionContextCreated' && m.sessionId === sessionId)
      .map((m) => m.params?.context?.id as number)
  }

  close(): void {
    this.ws.close()
  }
}

describe('CDP per-session ordering around Runtime.enable', () => {
  let server: RelayServer
  let ext: WebSocket
  /** Sessions whose Page.getFrameTree the fake extension should stall before answering. */
  const stalledFrameTreeSessions = new Set<string>()

  const sendFromExtension = (payload: unknown) => {
    ext.send(JSON.stringify(payload))
  }

  /**
   * Push the three contexts Chrome reports for a freshly enabled page session: two isolated
   * worlds and the default (main) world. The isDefault one is the one whose loss wedges
   * page.evaluate, so it is emitted here exactly as Chrome does — once, and only on enable.
   */
  const emitContextsFor = (sessionId: string, frameId: string) => {
    const contexts = [
      { id: 5, name: '__some_other_client_world__', auxData: { frameId, isDefault: false, type: 'isolated' } },
      { id: 4, name: '__playwright_utility_world__', auxData: { frameId, isDefault: false, type: 'isolated' } },
      { id: 3, name: '', auxData: { frameId, isDefault: true, type: 'default' } },
    ]
    for (const context of contexts) {
      sendFromExtension({
        method: 'forwardCDPEvent',
        params: {
          sessionId,
          method: 'Runtime.executionContextCreated',
          params: { context: { ...context, origin: 'http://fixture.test' } },
          workspaceKey: WORKSPACE_KEY,
        },
      })
    }
  }

  beforeAll(async () => {
    server = await startPlayWriterCDPRelayServer({ port: TEST_PORT, host: '127.0.0.1', logger: quietLogger })

    ext = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/extension`, { headers: { origin: EXT_ORIGIN } })
    ext.on('message', (raw: WebSocket.RawData) => {
      let msg: { id?: number; method?: string; params?: any }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.id === undefined || !msg.method) return

      const forwarded = msg.method === 'forwardCDPCommand' ? msg.params : undefined
      const forwardedMethod: string | undefined = forwarded?.method
      const forwardedSessionId: string | undefined = forwarded?.sessionId

      // Runtime.enable is where Chrome emits the contexts: BEFORE it answers the command.
      // Reproduced faithfully, because it is what makes the ordering matter at all.
      if (forwardedMethod === 'Runtime.enable' && forwardedSessionId) {
        emitContextsFor(forwardedSessionId, `frame-${forwardedSessionId}`)
        sendFromExtension({ id: msg.id, result: {} })
        return
      }

      // The condition under test: this session's frame tree comes back LATE, after the
      // contexts have already been pushed. Against real Chrome this is a race the relay
      // sometimes loses; here it is forced, so the assertion is deterministic.
      if (forwardedMethod === 'Page.getFrameTree' && forwardedSessionId && stalledFrameTreeSessions.has(forwardedSessionId)) {
        setTimeout(() => {
          sendFromExtension({
            id: msg.id,
            result: { frameTree: { frame: { id: `frame-${forwardedSessionId}`, url: 'http://fixture.test/' } } },
          })
        }, FRAME_TREE_DELAY_MS)
        return
      }

      if (forwardedMethod === 'Page.getFrameTree' && forwardedSessionId) {
        sendFromExtension({
          id: msg.id,
          result: { frameTree: { frame: { id: `frame-${forwardedSessionId}`, url: 'http://fixture.test/' } } },
        })
        return
      }

      sendFromExtension({ id: msg.id, result: {} })
    })

    await new Promise<void>((resolve, reject) => {
      ext.on('open', () => resolve())
      ext.on('error', reject)
    })
    await sleep(150)

    // Two page targets owned by this workspace, both registered BEFORE any client connects —
    // the "several targets already attached when the client arrives" shape the bug needed.
    for (const [sessionId, targetId] of [
      ['sess-one', 'target-one'],
      ['sess-two', 'target-two'],
    ] as const) {
      sendFromExtension({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          workspaceKey: WORKSPACE_KEY,
          params: {
            sessionId,
            targetInfo: pageTarget(targetId, `http://fixture.test/${targetId}`),
            waitingForDebugger: false,
          },
        },
      })
    }
    await sleep(150)
  }, 60000)

  afterAll(async () => {
    ext?.close()
    server?.close()
    await sleep(100)
  })

  it('holds a session execution-context events behind the Page.getFrameTree response the client sent first', async () => {
    stalledFrameTreeSessions.add('sess-two')
    const client = new RecordingClient('ordering-stalled')
    await client.open()
    try {
      await client.waitForResponse(
        client.fire({ method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }),
      )

      // Playwright's page-init batch, pipelined on one session exactly as crPage sends it:
      // Page.enable, Page.getFrameTree, then Runtime.enable, with no awaits in between.
      const pageEnableId = client.fire({ method: 'Page.enable', sessionId: 'sess-two' })
      const frameTreeId = client.fire({ method: 'Page.getFrameTree', sessionId: 'sess-two' })
      const runtimeEnableId = client.fire({ method: 'Runtime.enable', sessionId: 'sess-two' })

      await client.waitForResponse(pageEnableId)
      await client.waitForResponse(frameTreeId)
      await client.waitForResponse(runtimeEnableId)
      await sleep(200) // let the deferred flush land

      const frameTreeAt = client.indexOfResponse(frameTreeId)
      const firstContextAt = client.indexOfFirstEvent('Runtime.executionContextCreated', 'sess-two')

      expect(firstContextAt, 'the execution-context events must still be delivered, not swallowed').toBeGreaterThan(-1)
      expect(
        frameTreeAt < firstContextAt,
        `Page.getFrameTree response arrived at index ${frameTreeAt} and the first ` +
          `Runtime.executionContextCreated at ${firstContextAt}. Playwright registers its context listener ` +
          `inside the getFrameTree callback, so a context delivered first is dropped and page.evaluate on ` +
          `this target never returns.`,
      ).toBe(true)

      // Held events must arrive intact and in the order Chrome produced them.
      expect(client.contextIdsFor('sess-two')).toEqual([5, 4, 3])
    } finally {
      client.close()
      stalledFrameTreeSessions.delete('sess-two')
      await sleep(100)
    }
  }, 60000)

  it('does not delay execution-context events when nothing was outstanding on the session', async () => {
    const client = new RecordingClient('ordering-unstalled')
    await client.open()
    try {
      await client.waitForResponse(
        client.fire({ method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }),
      )

      // No earlier command on this session, so there is nothing to order against and the
      // fence must not open. The contexts go straight through, ahead of the enable response
      // exactly as Chrome sends them.
      const runtimeEnableId = client.fire({ method: 'Runtime.enable', sessionId: 'sess-one' })
      await client.waitForResponse(runtimeEnableId)

      const enableAt = client.indexOfResponse(runtimeEnableId)
      const firstContextAt = client.indexOfFirstEvent('Runtime.executionContextCreated', 'sess-one')
      expect(firstContextAt).toBeGreaterThan(-1)
      expect(
        firstContextAt < enableAt,
        `contexts should precede the Runtime.enable response (Chrome's own order); got context at ` +
          `${firstContextAt} and response at ${enableAt}`,
      ).toBe(true)
      expect(client.contextIdsFor('sess-one')).toEqual([5, 4, 3])
    } finally {
      client.close()
      await sleep(100)
    }
  }, 60000)

  it('keeps each client ordered independently when two clients drive the same session', async () => {
    // The shape the bug was found in: one client is already mid-initialization of a session
    // when a second client attaches to the same one. Each client's fence must key off its own
    // outstanding commands — a fence for one must not hold or release for the other.
    stalledFrameTreeSessions.add('sess-two')
    const first = new RecordingClient('ordering-pair-a')
    const second = new RecordingClient('ordering-pair-b')
    await first.open()
    await second.open()
    try {
      await first.waitForResponse(
        first.fire({ method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }),
      )
      await second.waitForResponse(
        second.fire({ method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }),
      )

      const firstFrameTreeId = first.fire({ method: 'Page.getFrameTree', sessionId: 'sess-two' })
      const firstEnableId = first.fire({ method: 'Runtime.enable', sessionId: 'sess-two' })
      const secondFrameTreeId = second.fire({ method: 'Page.getFrameTree', sessionId: 'sess-two' })
      const secondEnableId = second.fire({ method: 'Runtime.enable', sessionId: 'sess-two' })

      await first.waitForResponse(firstFrameTreeId)
      await second.waitForResponse(secondFrameTreeId)
      await first.waitForResponse(firstEnableId)
      await second.waitForResponse(secondEnableId)
      await sleep(200) // let the deferred flushes land

      for (const [label, client, frameTreeId] of [
        ['first', first, firstFrameTreeId],
        ['second', second, secondFrameTreeId],
      ] as const) {
        const frameTreeAt = client.indexOfResponse(frameTreeId)
        const firstContextAt = client.indexOfFirstEvent('Runtime.executionContextCreated', 'sess-two')
        expect(firstContextAt, `${label} client received no execution-context events`).toBeGreaterThan(-1)
        expect(
          frameTreeAt < firstContextAt,
          `${label} client: Page.getFrameTree response at ${frameTreeAt}, first context at ${firstContextAt}`,
        ).toBe(true)
      }
    } finally {
      first.close()
      second.close()
      stalledFrameTreeSessions.delete('sess-two')
      await sleep(100)
    }
  }, 60000)
})
