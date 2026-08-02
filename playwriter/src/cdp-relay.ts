import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAdaptorServer } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { createNodeWebSocket } from '@hono/node-ws'
import type { WSContext } from 'hono/ws'
import type { Protocol } from './cdp-types.js'
import type { CDPCommand, CDPResponseBase, CDPEventBase, CDPEventFor, RelayServerEvents } from './cdp-types.js'
import type {
  ExtensionMessage,
  ExtensionEventMessage,
  RecordingDataMessage,
  RecordingCancelledMessage,
  StartRecordingBody,
  StopRecordingParams,
  CancelRecordingParams,
  IsRecordingParams,
} from './protocol.js'
import pc from 'picocolors'
import util from 'node:util'

// Prevent Buffers from dumping hex bytes in util.inspect output.
Buffer.prototype[util.inspect.custom] = function () {
  return `<Buffer ${this.length} bytes>`
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { VERSION, EXTENSION_IDS } from './utils.js'
import { createCdpLogger, type CdpLogEntry, type CdpLogger } from './cdp-log.js'
import { RecordingRelay } from './recording-relay.js'
import { appendSessionToWsUrl } from './chrome-discovery.js'
import * as relayState from './relay-state.js'
import { deriveWorkspace, type Workspace } from './workspace-key.js'

/**
 * Checks if a target should be filtered out (not exposed to Playwright).
 * Filters extension pages, service workers, and other restricted targets,
 * but allows our own extension pages for debugging purposes.
 */
function isRestrictedTarget(targetInfo: Protocol.Target.TargetInfo): boolean {
  const { url, type } = targetInfo

  // Filter by type - allow pages and iframe targets (OOPIFs)
  if (type !== 'page' && type !== 'iframe') {
    return true
  }

  // Filter by URL - block extension and chrome internal pages
  if (!url) {
    return false
  }

  // Allow our own extension pages
  if (url.startsWith('chrome-extension://')) {
    const extensionId = url.replace('chrome-extension://', '').split('/')[0]
    if (EXTENSION_IDS.includes(extensionId)) {
      return false
    }
    return true
  }

  // Block other restricted URLs
  const blockedPrefixes = ['chrome://', 'devtools://', 'edge://']
  return blockedPrefixes.some((prefix) => url.startsWith(prefix))
}

// CDP events dropped entirely (not forwarded to Playwright clients, not logged).
// Only events that no Playwright API depends on. See: https://github.com/remorses/playwriter/issues/96
// NOTE: *ExtraInfo events feed Playwright's ResponseExtraInfoTracker for request/response.allHeaders().
// webSocketFrame* events feed page.on('websocket') frame events. Both must be forwarded.
//
// VERIFIED against the pinned playwright-core 1.59.10 source rather than assumed, because dropping an
// event a Playwright API depends on produces a silently incomplete result, not an error:
//   - Network.requestWillBeSentExtraInfo / responseReceivedExtraInfo — subscribed at
//     crNetworkManager.ts:68 and :71, both feeding `ResponseExtraInfoTracker` (declared :737), which is
//     what patches the real headers onto a response before `requestfinished`. Dropping them would make
//     allHeaders() return the pre-flight header set with nothing to say headers were missing.
//   - Network.webSocketFrameSent / webSocketFrameReceived / webSocketFrameError — subscribed at
//     crNetworkManager.ts:80, :81 and :83, feeding frameManager.onWebSocketFrameSent /
//     webSocketFrameReceived / webSocketError. Dropping them makes page.on('websocket') report a socket
//     that never carries a frame.
//   - Network.dataReceived and Network.resourceChangedPriority — searched the whole of
//     playwright-core/src: the ONLY occurrences are type declarations in the generated protocol.d.ts.
//     No listener anywhere, so nothing observable is lost by dropping them. That is why these two, and
//     only these two, are in the set below.
const DROPPED_CDP_EVENTS = new Set([
  'Network.dataReceived',
  'Network.resourceChangedPriority',
])

// Events filtered from human-readable logs and cdp.jsonl (superset of dropped events).
// These are still forwarded to Playwright but excluded from disk logs to reduce I/O.
const NOISY_LOG_EVENTS = new Set([
  ...DROPPED_CDP_EVENTS,
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceivedExtraInfo',
  'Network.requestServedFromCache',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
  'Network.webSocketFrameError',
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFinished',
])

export type RelayServer = {
  close(): void
  on<K extends keyof RelayServerEvents>(event: K, listener: RelayServerEvents[K]): void
  off<K extends keyof RelayServerEvents>(event: K, listener: RelayServerEvents[K]): void
}

export async function startPlayWriterCDPRelayServer({
  port = 19988,
  host = '127.0.0.1',
  token,
  logger,
  cdpLogger,
}: {
  port?: number
  host?: string
  token?: string
  logger?: { log(...args: any[]): void; error(...args: any[]): void }
  cdpLogger?: CdpLogger
} = {}): Promise<RelayServer> {
  const emitter = new EventEmitter()
  const store = relayState.createRelayStore()
  const extensionDownloadBehavior = new Map<string, Protocol.Browser.SetDownloadBehaviorRequest>()

  const resolvedCdpLogger = cdpLogger || createCdpLogger()
  const logCdpJson = (entry: CdpLogEntry) => {
    resolvedCdpLogger.log(entry)
  }

  const getDefaultExtensionId = (): string | null => {
    return store.getState().extensions.keys().next().value || null
  }

  /**
   * Resolve an extension by ID, stableKey, or fallback.
   * Returns the unified ExtensionEntry which includes both state and I/O.
   */
  const getExtensionConnection = (
    extensionId?: string | null,
    options: { allowFallback?: boolean } = {},
  ): relayState.ExtensionEntry | null => {
    const currentRelayState = store.getState()
    const { extensions } = currentRelayState

    if (extensionId) {
      const direct = extensions.get(extensionId)
      if (direct?.ws) {
        return direct
      }
      // Try stableKey lookup.
      const byKey = relayState.findExtensionByStableKey(currentRelayState, extensionId)
      if (byKey) {
        const candidates = Array.from(extensions.values())
          .filter((ext) => ext.stableKey === byKey.stableKey)
          .reverse()
        for (const candidate of candidates) {
          if (candidate.ws) {
            return candidate
          }
        }
      }
      return null
    }

    if (!options.allowFallback) {
      return null
    }

    // Single extension — use it directly
    if (extensions.size === 1) {
      const fallbackId = getDefaultExtensionId()
      if (fallbackId) {
        const ext = extensions.get(fallbackId)
        if (ext?.ws) {
          return ext
        }
      }
    }

    // Multiple extensions — auto-select if exactly one has active targets.
    // This handles the common case of multiple Chrome profiles with the extension
    // installed, where only one profile has playwriter-enabled tabs. (#52)
    if (extensions.size > 1) {
      const activeExtensions = Array.from(extensions.values()).filter((ext) => {
        return ext.connectedTargets.size > 0
      })
      if (activeExtensions.length === 1 && activeExtensions[0].ws) {
        return activeExtensions[0]
      }
    }

    return null
  }

  /**
   * Z6: a target is visible to a client only when their workspace keys are strictly equal.
   * target.workspaceKey === null means FREESTYLE (a human clicked the extension icon).
   * Freestyle targets are visible to NO workspace, ever. There is no claiming and no fallback.
   */
  function visibleToWorkspace(target: relayState.ConnectedTarget, clientWorkspaceKey: string): boolean {
    return target.workspaceKey === clientWorkspaceKey
  }
  /**
   * The requesting client's workspace key, or null when there is no such client
   * (a disconnect race) — or, during migration, when the client was recorded with a
   * null key (Todo 12 makes that impossible by rejecting unkeyed clients before they
   * are stored). Callers MUST treat null as "send nothing", NEVER "send everything".
   * This is enforced by type: visibleToWorkspace's clientWorkspaceKey param is a
   * non-null string, so a null returned here cannot be handed to it — a keyless client
   * can therefore match no target, which is precisely the intended behaviour.
   */
  function getClientWorkspaceKey(clientId: string): string | null {
    return store.getState().playwrightClients.get(clientId)?.workspaceKey ?? null
  }

  const normalizeSessionId = (value: string | number | null | undefined): string | null => {
    if (value === undefined || value === null) {
      return null
    }
    const normalized = String(value)
    return normalized ? normalized : null
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // CDP per-session ordering: the Runtime.enable fence
  // ═══════════════════════════════════════════════════════════════════════════════════
  //
  // Real CDP puts everything for one session on ONE ordered pipe, so a command's response
  // always reaches the client before any event the NEXT command produces. This bridge
  // cannot inherit that guarantee. A command travels
  //   Playwright -> relay -> extension WS -> chrome.debugger.sendCommand -> Chrome
  // and comes back as a promise resolution, while an event travels
  //   Chrome -> chrome.debugger.onEvent -> extension WS -> relay -> Playwright
  // as an independent push. Chrome gives an extension service worker no ordering
  // guarantee between those two dispatch paths, and the relay hands every Playwright
  // command to its own async task, so responses and events race.
  //
  // MEASURED, not assumed. In the run this was found in (tmp/cdp-19991.jsonl, a suite with
  // three connected page targets), for the third session the relay delivered the three
  // Runtime.executionContextCreated events — including the isDefault:true main world —
  // and only AFTER them the Page.getFrameTree response for the same session:
  //
  //   1945 to-playwright Runtime.executionContextCreated pw-tab-…-11 id=5 isDefault=false
  //   1947 to-playwright Runtime.executionContextCreated pw-tab-…-11 id=4 isDefault=false
  //   1949 to-playwright Runtime.executionContextCreated pw-tab-…-11 id=3 isDefault=TRUE
  //   1957 to-playwright RESPONSE id=27  (Page.getFrameTree on pw-tab-…-11)
  //
  // The two sessions whose getFrameTree response won the race (responses at 1899 and 1931,
  // contexts at 1978+ and 1999+) worked; only the inverted one broke.
  //
  // The inversion is fatal because of two things in the pinned playwright-core 1.59.10:
  //   - FrameSession._initialize registers its Runtime.executionContextCreated listener
  //     INSIDE the Page.getFrameTree().then() callback (crPage.ts:457-461, via
  //     _addRendererListeners), so a context event that arrives first has no listener; and
  //   - _onExecutionContextCreated (crPage.ts:654) returns early when
  //     auxData.frameId is not yet a known frame, which is also only true after the frame
  //     tree has been handled.
  // Chrome emits executionContextCreated exactly once per Runtime.enable, so a dropped one
  // never comes back. frame._context('main') then never resolves, and page.evaluate on that
  // target waits forever: Playwright's dispatcher calls ProgressController.run with
  // `params?.timeout` (dispatcher.ts:107) and frame.evaluateExpression sends no timeout, so
  // the deadline is 0 = none. That is the whole "a second connected target hangs" symptom.
  //
  // THE FIX restores exactly the violated half of the CDP guarantee and nothing wider:
  // while a client has commands in flight on a session that it sent BEFORE a Runtime.enable
  // on that same session, the execution-context events that Runtime.enable produces are
  // held for that client and flushed, in arrival order, once those earlier commands have
  // been answered.
  //
  // Deliberately NOT a general "hold every event while any command is in flight" gate:
  // that deadlocks. Runtime.evaluate with awaitPromise on a page awaiting an exposed
  // binding needs Runtime.bindingCalled delivered WHILE the evaluate is outstanding.
  // Deliberately NOT full per-session command serialization either, for the same reason in
  // the other direction: Chrome does not block a session's other commands behind a
  // long-running Runtime.evaluate, so serializing would wedge
  // `Promise.all([page.evaluate(slow), page.click(...)])`. The fence exists only inside a
  // Runtime.enable window, only holds Runtime.executionContext* events, and only waits on
  // commands that were ALREADY outstanding when the Runtime.enable arrived — every one of
  // which is independently bounded by sendToExtension's own timeout.

  /**
   * Ceiling on how long a fence may hold execution-context events. Every command it waits
   * on is already bounded (sendToExtension rejects after 30s, the extension's own
   * per-command timeouts are shorter), so this only fires when something upstream is
   * already broken. It then flushes rather than swallowing, and says so loudly.
   */
  const ORDERING_FENCE_TIMEOUT_MS = 35000

  /**
   * The events whose ordering against earlier responses Playwright's page initialization
   * depends on. Kept to exactly these three: they are the once-only, state-critical ones
   * (crPage.ts:416-418), and holding anything else risks the deadlocks described above.
   */
  const CONTEXT_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
    'Runtime.executionContextCreated',
    'Runtime.executionContextDestroyed',
    'Runtime.executionContextsCleared',
  ])

  type OrderingFence = {
    /** Command ids this client had outstanding on the session when Runtime.enable arrived. */
    waitingFor: Set<number>
    /** Already-serialized messages held back, in arrival order. */
    queued: string[]
    timer: ReturnType<typeof setTimeout>
  }

  type ClientOrdering = {
    /** sessionId -> ids of this client's commands that have not been answered yet. */
    inFlight: Map<string, Set<number>>
    /** sessionId -> the open fence for that session, if any. */
    fences: Map<string, OrderingFence>
  }

  const clientOrdering = new Map<string, ClientOrdering>()

  const getClientOrdering = (clientId: string): ClientOrdering => {
    const existing = clientOrdering.get(clientId)
    if (existing) {
      return existing
    }
    const created: ClientOrdering = { inFlight: new Map(), fences: new Map() }
    clientOrdering.set(clientId, created)
    return created
  }

  /** Names a target the way a human debugging a stall needs it named: which tab, which URL. */
  const describeCdpSession = (sessionId: string): string => {
    const extensionId = findExtensionIdByCdpSession(sessionId)
    const target = extensionId
      ? store.getState().extensions.get(extensionId)?.connectedTargets.get(sessionId)
      : undefined
    if (!target) {
      return `sessionId=${sessionId} (no connected target)`
    }
    return `sessionId=${sessionId} targetId=${target.targetId} url=${target.targetInfo.url || '<empty>'}`
  }

  /**
   * Write out everything a fence held and forget the fence.
   *
   * The flush is deferred one event-loop turn on purpose. The response that released the
   * fence was written in THIS turn; writing the held events in the same turn lets them
   * coalesce into one TCP segment, and the client's `ws` receiver emits a batched segment's
   * frames synchronously (allowSynchronousEvents defaults to true in the bundled ws 8.17.1),
   * which means no microtask runs between them — and Playwright registers the listener a few
   * microtasks after processing the response (crConnection dispatches events through
   * Promise.resolve().then, while CRSession.send's promise adoption costs extra ticks). One
   * turn of separation is what keeps the ordering we just paid for from being undone by
   * batching. Deferring is safe: nothing waits on the flush, and the fence is already gone
   * from the map so no later event can jump ahead of the queue.
   */
  const flushOrderingFence = ({
    clientId,
    sessionId,
    fence,
  }: {
    clientId: string
    sessionId: string
    fence: OrderingFence
  }): void => {
    clearTimeout(fence.timer)
    const ordering = clientOrdering.get(clientId)
    if (ordering?.fences.get(sessionId) === fence) {
      ordering.fences.delete(sessionId)
    }
    if (fence.queued.length === 0) {
      return
    }
    const held = fence.queued.splice(0, fence.queued.length)
    setImmediate(() => {
      const client = store.getState().playwrightClients.get(clientId)
      if (!client) {
        return
      }
      for (const message of held) {
        try {
          client.ws.send(message)
        } catch (e) {
          logger?.log(
            pc.gray(`[Relay] Skipped flushing held event to closing client ${clientId}: ${(e as Error).message}`),
          )
        }
      }
    })
  }

  /** Record that a client sent a command on a session and is waiting for its response. */
  const noteCommandStarted = ({
    clientId,
    sessionId,
    id,
  }: {
    clientId: string
    sessionId: string
    id: number
  }): void => {
    const ordering = getClientOrdering(clientId)
    const inFlight = ordering.inFlight.get(sessionId)
    if (inFlight) {
      inFlight.add(id)
      return
    }
    ordering.inFlight.set(sessionId, new Set([id]))
  }

  /**
   * Record that a command's response has been WRITTEN to the client (callers must do this
   * after sendToPlaywright, never before), and release any fence that was waiting on it.
   */
  const noteCommandFinished = ({
    clientId,
    sessionId,
    id,
  }: {
    clientId: string
    sessionId: string
    id: number
  }): void => {
    const ordering = clientOrdering.get(clientId)
    if (!ordering) {
      return
    }
    const inFlight = ordering.inFlight.get(sessionId)
    inFlight?.delete(id)
    const fence = ordering.fences.get(sessionId)
    if (fence) {
      fence.waitingFor.delete(id)
      if (fence.waitingFor.size === 0) {
        flushOrderingFence({ clientId, sessionId, fence })
      }
    }
    // Forget a quiet session so a long-lived client that cycles through many tabs does not
    // accumulate one empty Set per session it ever touched.
    if (inFlight && inFlight.size === 0 && !ordering.fences.has(sessionId)) {
      ordering.inFlight.delete(sessionId)
    }
  }

  /**
   * Open a fence for a Runtime.enable, capturing the commands this client already had
   * outstanding on the same session. No fence is opened when there is nothing to wait for —
   * the common case, and the one that must stay free.
   */
  const openOrderingFence = ({
    clientId,
    sessionId,
    runtimeEnableId,
  }: {
    clientId: string
    sessionId: string
    runtimeEnableId: number
  }): void => {
    const ordering = getClientOrdering(clientId)
    const outstanding = ordering.inFlight.get(sessionId)
    const waitingFor = new Set(
      Array.from(outstanding ?? []).filter((pendingId) => {
        return pendingId !== runtimeEnableId
      }),
    )
    if (waitingFor.size === 0) {
      return
    }
    // A second Runtime.enable on the same session supersedes the first; release the old
    // fence's queue rather than stranding it behind ids that may already be answered.
    const previous = ordering.fences.get(sessionId)
    if (previous) {
      flushOrderingFence({ clientId, sessionId, fence: previous })
    }
    const fence: OrderingFence = {
      waitingFor,
      queued: [],
      timer: setTimeout(() => {
        logger?.log(
          pc.yellow(
            `IMPORTANT: CDP ordering fence timed out after ${ORDERING_FENCE_TIMEOUT_MS}ms waiting for ` +
              `${waitingFor.size} earlier command(s) (ids ${Array.from(waitingFor).join(', ')}) to be answered ` +
              `before releasing ${fence.queued.length} held execution-context event(s) for client ${clientId} on ` +
              `${describeCdpSession(sessionId)}. Releasing them anyway — if Playwright had not yet handled ` +
              `Page.getFrameTree for this session, page.evaluate against it will never return.`,
          ),
        )
        flushOrderingFence({ clientId, sessionId, fence })
      }, ORDERING_FENCE_TIMEOUT_MS),
    }
    ordering.fences.set(sessionId, fence)
  }

  /** Drop all ordering bookkeeping for a client that has gone away. */
  const dropClientOrdering = (clientId: string): void => {
    const ordering = clientOrdering.get(clientId)
    if (!ordering) {
      return
    }
    for (const fence of ordering.fences.values()) {
      clearTimeout(fence.timer)
    }
    clientOrdering.delete(clientId)
  }

  const getPageTargetForFrameId = ({
    extensionState,
    frameId,
  }: {
    extensionState: relayState.ExtensionEntry
    frameId: string
  }): relayState.ConnectedTarget | undefined => {
    return Array.from(extensionState.connectedTargets.values()).find((target) => {
      return target.targetInfo.type === 'page' && target.frameIds.has(frameId)
    })
  }

  const startExtensionPing = (extensionId: string): void => {
    const ext = store.getState().extensions.get(extensionId)
    if (!ext) {
      return
    }
    if (ext.pingInterval) {
      clearInterval(ext.pingInterval)
    }

    const pingInterval = setInterval(() => {
      const latestExt = store.getState().extensions.get(extensionId)
      latestExt?.ws?.send(JSON.stringify({ method: 'ping' }))
    }, 5000)

    store.setState((s) => relayState.updateExtensionIO(s, { extensionId, pingInterval }))
  }

  const stopExtensionPing = (extensionId: string): void => {
    const ext = store.getState().extensions.get(extensionId)
    if (!ext || !ext.pingInterval) {
      return
    }
    clearInterval(ext.pingInterval)
    store.setState((s) => relayState.updateExtensionIO(s, { extensionId, pingInterval: null }))
  }

  function logCdpMessage({
    direction,
    clientId,
    method,
    sessionId,
    params,
    id,
    source,
  }: {
    direction: 'to-playwright' | 'from-playwright' | 'from-extension'
    clientId?: string
    method: string
    sessionId?: string
    params?: any
    id?: number
    source?: 'extension' | 'server'
  }) {
    if (NOISY_LOG_EVENTS.has(method)) {
      return
    }

    const details: string[] = []

    if (id !== undefined) {
      details.push(`id=${id}`)
    }

    if (sessionId) {
      details.push(`sessionId=${sessionId}`)
    }

    if (params) {
      if (params.targetId) {
        details.push(`targetId=${params.targetId}`)
      }
      if (params.targetInfo?.targetId) {
        details.push(`targetId=${params.targetInfo.targetId}`)
      }
      if (params.sessionId && params.sessionId !== sessionId) {
        details.push(`sessionId=${params.sessionId}`)
      }
    }

    const detailsStr = details.length > 0 ? ` ${pc.gray(details.join(', '))}` : ''

    if (direction === 'from-playwright') {
      const clientLabel = clientId ? pc.blue(`[${clientId}]`) : ''
      logger?.log(pc.cyan('← Playwright'), clientLabel + ':', method + detailsStr)
    } else if (direction === 'from-extension') {
      logger?.log(pc.yellow('← Extension:'), method + detailsStr)
    } else if (direction === 'to-playwright') {
      const color = source === 'server' ? pc.magenta : pc.green
      const sourceLabel = source === 'server' ? pc.gray(' (server-generated)') : ''
      const clientLabel = clientId ? pc.blue(`[${clientId}]`) : pc.blue('[ALL]')
      logger?.log(color('→ Playwright'), clientLabel + ':', method + detailsStr + sourceLabel)
    }
  }

  function sendToPlaywright({
    message,
    clientId,
    source = 'extension',
    extensionId,
  }: {
    message: CDPResponseBase | CDPEventBase
    clientId?: string
    source?: 'extension' | 'server'
    extensionId?: string | null
  }) {
    const messageToSend = source === 'server' && 'method' in message ? { ...message, __serverGenerated: true } : message

    logCdpJson({
      timestamp: new Date().toISOString(),
      direction: 'to-playwright',
      clientId,
      source,
      message: messageToSend,
    })

    if ('method' in message) {
      logCdpMessage({
        direction: 'to-playwright',
        clientId,
        method: message.method,
        sessionId: 'sessionId' in message ? message.sessionId : undefined,
        params: 'params' in message ? message.params : undefined,
        source,
      })
    }

    const messageStr = JSON.stringify(messageToSend)

    // Helper to safely send to a WebSocket, catching errors from closing connections.
    // When a Playwright client closes its WebSocket, there's a race window where:
    // 1. Playwright's _onClose runs (clears callbacks map)
    // 2. We might still have messages in flight or try to send
    // This can cause "Assertion error" in Playwright's crConnection.js if a response
    // arrives after callbacks were cleared. We wrap in try-catch to handle this gracefully.
    const safeSend = (client: relayState.PlaywrightClient) => {
      // CDP ordering (see the Runtime.enable fence above): a client whose page session is
      // mid-initialization must not see this session's execution-context events before the
      // responses to the commands it sent earlier on that session. When such a fence is
      // open, queue instead of sending; the queue is flushed in arrival order the moment
      // the last of those responses has been written.
      const fencedMethod = 'method' in message ? message.method : null
      const fencedSessionId = typeof message.sessionId === 'string' ? message.sessionId : null
      if (fencedMethod && fencedSessionId && CONTEXT_LIFECYCLE_EVENTS.has(fencedMethod)) {
        const fence = clientOrdering.get(client.id)?.fences.get(fencedSessionId)
        if (fence) {
          fence.queued.push(messageStr)
          return
        }
      }
      try {
        client.ws.send(messageStr)
      } catch (e) {
        // WebSocket might be closing/closed - this is expected during disconnect
        logger?.log(pc.gray(`[Relay] Skipped sending to closing client ${client.id}: ${(e as Error).message}`))
      }
    }

    if (clientId) {
      const client = store.getState().playwrightClients.get(clientId)
      if (client) {
        safeSend(client)
      }
    } else {
      const { playwrightClients } = store.getState()

      // Todo 17: workspace-scope the LIVE broadcast (the push counterpart of the
      // replay filtering in Todos 13/15/16). A message that belongs to a specific
      // target — identified by its top-level CDP `sessionId`, the key under which
      // connectedTargets is stored — must reach ONLY the client whose workspace owns
      // that target. We resolve the owning target ONCE here, then compare per client
      // with visibleToWorkspace (strict `target.workspaceKey === client.workspaceKey`,
      // no prefix stripping, no claiming, no fallback).
      //
      // A message with NO resolvable target is BROWSER-LEVEL: it has no owning
      // workspace and MUST still reach every client of the extension. The canonical
      // case is Browser.downloadWillBegin / Browser.downloadProgress synthesized by
      // maybeEmitBrowserDownloadCompatEvent — those carry no sessionId, so they
      // resolve to no target and broadcast unchanged. Dropping them because they
      // "match no workspace" would silently break downloads for EVERY client. This
      // is the ONE place where the absence of a target legitimately means "not
      // target-scoped, broadcast it" — it is NOT the forbidden "if we can't tell,
      // show everything" fallback: any message that DOES resolve to a target is
      // strictly filtered to that target's owner below.
      const messageSessionId = typeof message.sessionId === 'string' ? message.sessionId : null
      const owningExtensionId =
        extensionId ?? (messageSessionId ? findExtensionIdByCdpSession(messageSessionId) : null)
      const owningTarget =
        messageSessionId && owningExtensionId
          ? store.getState().extensions.get(owningExtensionId)?.connectedTargets.get(messageSessionId) ?? null
          : null

      for (const client of playwrightClients.values()) {
        if (extensionId && client.extensionId !== extensionId) {
          continue
        }
        // Target-scoped message → deliver only to the owning workspace's client(s).
        // Browser-level message (owningTarget === null) → falls through to every
        // client selected by the extensionId filter above, unfiltered.
        if (owningTarget && !visibleToWorkspace(owningTarget, client.workspaceKey)) {
          continue
        }
        safeSend(client)
      }
    }
  }

  type ForwardCdpParams = {
    method: string
    sessionId?: string
    params?: unknown
  }

  function getForwardCdpParams(value: unknown): ForwardCdpParams | undefined {
    if (!value || typeof value !== 'object') {
      return undefined
    }
    const record = value as { method?: unknown; sessionId?: unknown; params?: unknown }
    if (typeof record.method !== 'string') {
      return undefined
    }
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined
    return { method: record.method, sessionId, params: record.params }
  }

  async function sendToExtension({
    extensionId,
    method,
    params,
    timeout = 30000,
  }: {
    extensionId?: string | null
    method: string
    params?: unknown
    timeout?: number
  }): Promise<unknown> {
    const conn = getExtensionConnection(extensionId)
    if (!conn) {
      throw new Error('Extension not connected')
    }
    const resolvedExtensionId = conn.id

    let id = 0
    store.setState((s) => {
      const ext = s.extensions.get(resolvedExtensionId)
      if (!ext) {
        return s
      }
      id = ext.messageId + 1
      const newExtensions = new Map(s.extensions)
      newExtensions.set(resolvedExtensionId, { ...ext, messageId: id })
      return { ...s, extensions: newExtensions }
    })

    if (!id) {
      throw new Error('Extension not connected')
    }

    const message = { id, method, params }

    const forwardCdpParams = method === 'forwardCDPCommand' ? getForwardCdpParams(params) : undefined
    if (forwardCdpParams) {
      logCdpJson({
        timestamp: new Date().toISOString(),
        direction: 'to-extension',
        message: {
          method: forwardCdpParams.method,
          sessionId: forwardCdpParams.sessionId,
          params: forwardCdpParams.params,
        },
      })
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        store.setState((s) =>
          relayState.removeExtensionPendingRequest(s, {
            extensionId: resolvedExtensionId,
            requestId: id,
          }),
        )
        reject(new Error(`Extension request timeout after ${timeout}ms: ${method}`))
      }, timeout)

      const pendingRequest = {
        resolve: (result) => {
          clearTimeout(timeoutId)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeoutId)
          reject(error)
        },
      }

      store.setState((s) =>
        relayState.addExtensionPendingRequest(s, {
          extensionId: resolvedExtensionId,
          requestId: id,
          pendingRequest,
        }),
      )

      const latestExt = store.getState().extensions.get(resolvedExtensionId)
      if (!latestExt?.ws) {
        clearTimeout(timeoutId)
        store.setState((s) =>
          relayState.removeExtensionPendingRequest(s, {
            extensionId: resolvedExtensionId,
            requestId: id,
          }),
        )
        reject(new Error('Extension not connected'))
        return
      }

      try {
        latestExt.ws.send(JSON.stringify(message))
      } catch (error) {
        clearTimeout(timeoutId)
        store.setState((s) =>
          relayState.removeExtensionPendingRequest(s, {
            extensionId: resolvedExtensionId,
            requestId: id,
          }),
        )
        const sendError = error instanceof Error ? error : new Error(String(error))
        reject(new Error(`Extension send failed: ${method}`, { cause: sendError }))
      }
    })
  }

  const recordingRelays = new Map<string, RecordingRelay>()

  // Find which extension connection owns a CDP tab session ID (pw-tab-*).
  // Used by recording routes where sessionId identifies the target tab.
  // Delegates to the pure derivation function from relay-state.ts.
  const findExtensionIdByCdpSession = (cdpSessionId: string): string | null => {
    return relayState.findExtensionIdByCdpSession(store.getState(), cdpSessionId)
  }

  // Resolve recording route session ID (CDP tab session) to extension connection.
  const resolveRecordingRoute = async ({
    sessionId,
  }: {
    sessionId: string | null
  }): Promise<{
    extensionId: string | null
    sessionId: string | null
  }> => {
    if (!sessionId) {
      return { extensionId: null, sessionId: null }
    }

    const extensionId = findExtensionIdByCdpSession(sessionId)
    return { extensionId, sessionId }
  }

  const getRecordingRelay = (extensionId?: string | null): RecordingRelay | null => {
    const allowDefault = !extensionId && store.getState().extensions.size === 1
    const conn = getExtensionConnection(extensionId, { allowFallback: allowDefault })
    if (!conn) {
      return null
    }
    const connId = conn.id
    if (!recordingRelays.has(connId)) {
      recordingRelays.set(
        connId,
        new RecordingRelay(
          (params) => sendToExtension({ extensionId: connId, ...params }),
          () => store.getState().extensions.has(connId),
          logger,
        ),
      )
    }
    return recordingRelays.get(connId) || null
  }

  // Auto-create an initial blank tab when the requesting client's workspace has no
  // tab yet. workspaceKey/workspaceLabel are the CREATING client's own workspace (I1:
  // a connected client always has a non-empty key — Todo 12's 4005 rejection), so the
  // tab this creates belongs to that workspace.
  async function maybeAutoCreateInitialTab({
    extensionId,
    workspaceKey,
    workspaceLabel,
  }: {
    extensionId: string
    workspaceKey: string
    workspaceLabel: string
  }): Promise<void> {
    const conn = getExtensionConnection(extensionId)
    if (!conn) {
      return
    }
    // Z6/per-workspace guard (THE zero-click fix): skip auto-create only when THIS
    // client's own workspace already owns a tab. Count only targets whose workspaceKey
    // === this client's key (visibleToWorkspace); tabs owned by OTHER workspaces, and
    // freestyle tabs (workspaceKey === null), do NOT count. So a fresh workspace always
    // gets its own tab even when the extension already holds other workspaces' tabs —
    // no human click required. This replaces the old `connectedTargets.size > 0` guard,
    // which suppressed creation whenever ANY tab existed and forced session B to silently
    // drive session A's tab. No prefix stripping, no claiming, no fallback.
    const mine = Array.from(conn.connectedTargets.values()).filter((t) => visibleToWorkspace(t, workspaceKey))
    if (mine.length > 0) {
      return
    }

    // Tab REUSE (user directive): before creating a blank tab, adopt an already-attached
    // usable tab if one exists. This is what lets a session operate on the user's own
    // already-open page (e.g. the molab tab, attached freestyle via a human icon-click)
    // instead of spawning a redundant about:blank — whose attach has also proven fatal to
    // the extension worker. Only freestyle tabs (workspaceKey === null) or tabs already
    // ours are adoptable; a tab owned by a DIFFERENT real workspace is never stolen (that
    // would break that session). "Usable" = a page target on a real (non-blank) URL. When
    // several qualify, the first non-blank one is reused. Only when zero usable tabs exist
    // do we fall through and create a fresh one.
    const isBlankUrl = (url: string | undefined): boolean =>
      !url || url === 'about:blank' || url === ':' || url === 'chrome://newtab/'
    const adoptable = Array.from(conn.connectedTargets.values()).filter(
      (t) =>
        t.targetInfo.type === 'page' &&
        !isBlankUrl(t.targetInfo.url) &&
        (t.workspaceKey === null || t.workspaceKey === workspaceKey),
    )
    if (adoptable.length > 0) {
      const reused = adoptable[0]
      store.setState((s) =>
        relayState.setTargetWorkspaceKey(s, {
          extensionId: conn.id,
          sessionId: reused.sessionId,
          workspaceKey,
        }),
      )
      logger?.log(
        pc.green(
          `Reusing existing tab for workspace ${workspaceKey} instead of creating a blank one ` +
            `(sessionId: ${reused.sessionId}, url: ${reused.targetInfo.url})`,
        ),
      )
      return
    }

    try {
      logger?.log(pc.blue('Auto-creating initial tab for Playwright client'))
      const result = (await sendToExtension({
        extensionId,
        method: 'createInitialTab',
        // Carry the creating client's workspace so the extension (Todo 20) can stamp the
        // new tab's ownership and place it in the right tab group.
        params: { workspaceKey, workspaceLabel },
        timeout: 10000,
      })) as {
        success: boolean
        tabId: number
        sessionId: string
        targetInfo: Protocol.Target.TargetInfo
      }
      if (result.success && result.sessionId && result.targetInfo) {
        store.setState((s) =>
          relayState.addTarget(s, {
            extensionId,
            sessionId: result.sessionId,
            targetId: result.targetInfo.targetId,
            targetInfo: result.targetInfo,
            // Todo 14: stamp the auto-created target with the CREATING client's workspace
            // key so it belongs to that workspace (first of Todo 9's two seams, now filled;
            // the extension-echo seam remains Todo 20's).
            workspaceKey,
          }),
        )
        const updatedTargets = store.getState().extensions.get(extensionId)?.connectedTargets.size || 0
        logger?.log(
          pc.blue(`Auto-created tab, now have ${updatedTargets} targets, url: ${result.targetInfo.url}`),
        )
      }
    } catch (e) {
      logger?.error('Failed to auto-create initial tab:', e)
    }
  }

  function getPageTargetSessionIds({ extensionId }: { extensionId: string }): string[] {
    const extensionState = store.getState().extensions.get(extensionId)
    if (!extensionState) {
      return []
    }
    return Array.from(extensionState.connectedTargets.values())
      .filter((target) => {
        return target.targetInfo.type === 'page'
      })
      .map((target) => {
        return target.sessionId
      })
  }

  function maybeEmitBrowserDownloadCompatEvent({
    method,
    params,
    extensionId,
  }: {
    method: string
    params: unknown
    extensionId: string
  }): void {
    const browserEventMethod =
      method === 'Page.downloadWillBegin'
        ? 'Browser.downloadWillBegin'
        : method === 'Page.downloadProgress'
          ? 'Browser.downloadProgress'
          : null
    if (!browserEventMethod) {
      return
    }
    sendToPlaywright({
      message: {
        method: browserEventMethod,
        params,
      } as CDPEventBase,
      source: 'server',
      extensionId,
    })
  }

  async function applyDownloadBehaviorToTargets({
    extensionId,
    behavior,
    source,
    targetSessionIds,
  }: {
    extensionId: string
    behavior: Protocol.Browser.SetDownloadBehaviorRequest
    source?: CDPCommand['source']
    targetSessionIds?: string[]
  }): Promise<void> {
    const pageBehavior: Protocol.Page.SetDownloadBehaviorRequest['behavior'] =
      behavior.behavior === 'allowAndName' ? 'allow' : behavior.behavior
    const pageParams: Protocol.Page.SetDownloadBehaviorRequest = (() => {
      if (pageBehavior === 'allow' && behavior.downloadPath) {
        return { behavior: pageBehavior, downloadPath: behavior.downloadPath }
      }
      return { behavior: pageBehavior }
    })()
    const sessions = targetSessionIds || getPageTargetSessionIds({ extensionId })
    if (sessions.length === 0) {
      return
    }
    await Promise.all(
      sessions.map(async (targetSessionId) => {
        try {
          await sendToExtension({
            extensionId,
            method: 'forwardCDPCommand',
            params: {
              sessionId: targetSessionId,
              method: 'Page.setDownloadBehavior',
              params: pageParams,
              source,
            },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger?.log(pc.yellow(`[Server] Failed to apply Page.setDownloadBehavior to ${targetSessionId}: ${message}`))
        }
      }),
    )
  }

  async function routeCdpCommand({
    extensionId,
    method,
    params,
    sessionId,
    source,
    workspaceKey,
    workspaceLabel,
  }: {
    extensionId: string | null
    method: CDPCommand['method'] | (string & {})
    params: CDPCommand['params']
    sessionId?: CDPCommand['sessionId']
    source?: CDPCommand['source']
    // The requesting client's workspace (from getCdpUrl's ?workspace= param, read at the
    // /cdp handler). null only in a disconnect race (I1). Used by the Target.setAutoAttach
    // case to auto-create a tab for THIS workspace. Todo 16 consumes these further for
    // its own per-workspace filtering of getTargets/attachToTarget/getTargetInfo.
    workspaceKey: string | null
    workspaceLabel: string | null
  }) {
    const conn = getExtensionConnection(extensionId)
    const connectedTargets = conn?.connectedTargets || new Map<string, relayState.ConnectedTarget>()
    const resolvedExtensionId = conn?.id || extensionId
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          revision: '1.0.0',
          userAgent: 'CDP-Bridge-Server/1.0.0',
          jsVersion: 'V8',
        } satisfies Protocol.Browser.GetVersionResponse
      }

      case 'Browser.setDownloadBehavior': {
        const downloadBehaviorParams = params as Protocol.Browser.SetDownloadBehaviorRequest | undefined
        if (!downloadBehaviorParams?.behavior) {
          throw new Error('behavior is required for Browser.setDownloadBehavior')
        }
        if (resolvedExtensionId) {
          extensionDownloadBehavior.set(resolvedExtensionId, downloadBehaviorParams)
          await applyDownloadBehaviorToTargets({
            extensionId: resolvedExtensionId,
            behavior: downloadBehaviorParams,
            source,
          })
        }
        return {}
      }

      // Target.setAutoAttach is a CDP command Playwright sends on first connection.
      // We use it as the hook to auto-create an initial tab. If Playwright changes
      // its initialization sequence in the future, this could be moved to a different command.
      //
      // VERIFIED against the pinned playwright-core 1.59.10 source: `Target.setAutoAttach` is sent from
      // crBrowser.ts:82 and :87 during browser connect (the sessionless call this branch handles), and
      // again per-page from crPage.ts:500 and per-worker from crPage.ts:734 — those carry a sessionId
      // and are filtered out by the `if (sessionId) break` above. So the sessionless one really is the
      // connect-time signal, and there is exactly one of it per client.
      //
      // The fragility is real and worth keeping stated: this is a behavioural coupling to Playwright's
      // startup order, not a contract Playwright offers. If it ever stops sending a sessionless
      // setAutoAttach, auto-create silently stops happening and a client connects to no tab.
      case 'Target.setAutoAttach': {
        if (sessionId) {
          break
        }
        // Auto-create a tab for the requesting client's workspace. workspaceKey/Label are
        // null ONLY in a disconnect race (I1: a live connected client always has a
        // non-null key via Todo 12's 4005 rejection). With no live client there is no
        // recipient, so skipping auto-create is correct — this is NOT a fallback.
        if (conn && workspaceKey && workspaceLabel) {
          await maybeAutoCreateInitialTab({ extensionId: conn.id, workspaceKey, workspaceLabel })
        }
        // Forward auto-attach so Chrome emits iframe Target.attachedToTarget events.
        // Playwright relies on these (with parentFrameId) when reconnecting over CDP.
        await sendToExtension({
          extensionId: resolvedExtensionId,
          method: 'forwardCDPCommand',
          params: { method, params, source },
        })
        return {}
      }

      case 'Target.setDiscoverTargets': {
        return {}
      }

      case 'Target.attachToTarget': {
        const attachParams = params as Protocol.Target.AttachToTargetRequest
        if (!attachParams?.targetId) {
          throw new Error('targetId is required for Target.attachToTarget')
        }

        for (const target of connectedTargets.values()) {
          if (target.targetId === attachParams.targetId) {
            // Todo 16: refuse to attach a client to a target its workspace doesn't own.
            // workspaceKey is null only in a disconnect race (I1). A non-visible match is
            // treated as absent — break out and fall through to the SAME "not found" error
            // as a genuinely missing target, so a foreign target's existence is never leaked
            // (Z6/I3). No prefix stripping, no claiming, no fallback.
            if (workspaceKey !== null && visibleToWorkspace(target, workspaceKey)) {
              return { sessionId: target.sessionId } satisfies Protocol.Target.AttachToTargetResponse
            }
            break
          }
        }

        throw new Error(`Target ${attachParams.targetId} not found in connected targets`)
      }

      case 'Target.getTargetInfo': {
        const infoReqParams = params as Protocol.Target.GetTargetInfoRequest | undefined
        const targetId = infoReqParams?.targetId

        // Todo 16: a client may only see targets its own workspace owns. workspaceKey is
        // null only in a disconnect race (I1). EVERY lookup below is gated on visibility so a
        // foreign target's info is never revealed (Z6/I3). No prefix stripping, no claiming.
        if (targetId) {
          for (const target of connectedTargets.values()) {
            if (target.targetId === targetId && workspaceKey !== null && visibleToWorkspace(target, workspaceKey)) {
              return { targetInfo: target.targetInfo }
            }
          }
        }

        if (sessionId) {
          const target = connectedTargets.get(sessionId)
          if (target && workspaceKey !== null && visibleToWorkspace(target, workspaceKey)) {
            return { targetInfo: target.targetInfo }
          }
        }

        // The old fallback returned Array.from(connectedTargets.values())[0] — an ARBITRARY
        // target that could belong to ANOTHER workspace, silently handing the client a
        // foreign tab on a lookup miss (the sneakiest leak in the file). Scope the fallback
        // to targets THIS workspace owns; if none is visible, return no targetInfo rather
        // than a foreign one. This is NOT a fallback to a foreign target (Z6/I3).
        const firstVisibleTarget = Array.from(connectedTargets.values()).find(
          (t) => workspaceKey !== null && visibleToWorkspace(t, workspaceKey),
        )
        return { targetInfo: firstVisibleTarget?.targetInfo }
      }

      case 'Target.getTargets': {
        // Todo 16: expose ONLY targets the requesting client's own workspace owns.
        // workspaceKey is null only in a disconnect race (I1) — then nothing is visible.
        // A freestyle target (workspaceKey === null) matches no keyed client. Strict
        // equality, full string, no prefix stripping, no "unowned = visible to all"
        // fallback (Z6/I3).
        return {
          targetInfos: Array.from(connectedTargets.values())
            .filter((t) => !isRestrictedTarget(t.targetInfo))
            .filter((t) => workspaceKey !== null && visibleToWorkspace(t, workspaceKey))
            .map((t) => ({
              ...t.targetInfo,
              attached: true,
            })),
        }
      }

      case 'Target.createTarget': {
        // Todo 20 (Job B): context.newPage() reaches the extension as Target.createTarget,
        // but the extension cannot know which client asked for the page — only the relay
        // does. Inject the requesting client's workspace so the extension stamps the new
        // tab's ownership (I2) and its creator can see it. workspaceKey/Label are null only
        // in a disconnect race (I1); the extension then treats the tab as freestyle. This
        // mirrors how createInitialTab carries the workspace (Todo 14). NOT defaulting to
        // null here is the whole point: a null-owned newPage() would be invisible to its
        // own keyed creator.
        return await sendToExtension({
          extensionId: resolvedExtensionId,
          method: 'forwardCDPCommand',
          params: { method, params, source, workspaceKey, workspaceLabel },
        })
      }

      case 'Target.closeTarget': {
        return await sendToExtension({
          extensionId: resolvedExtensionId,
          method: 'forwardCDPCommand',
          params: { method, params, source },
        })
      }

      // Ghost Browser API - forward to extension for chrome.ghostPublicAPI/ghostProxies/projects
      case 'ghost-browser': {
        return await sendToExtension({
          extensionId: resolvedExtensionId,
          method: 'ghost-browser',
          params,
        })
      }

      case 'Runtime.enable': {
        if (!sessionId) {
          break
        }

        const contextCreatedPromise = new Promise<void>((resolve) => {
          const handler = ({ event }: { event: CDPEventBase }) => {
            if (event.method === 'Runtime.executionContextCreated' && event.sessionId === sessionId) {
              const params = event.params as Protocol.Runtime.ExecutionContextCreatedEvent | undefined
              if (params?.context?.auxData?.isDefault === true) {
                clearTimeout(timeout)
                emitter.off('cdp:event', handler)
                resolve()
              }
            }
          }
          const timeout = setTimeout(() => {
            emitter.off('cdp:event', handler)
            logger?.log(
              pc.yellow(
                `IMPORTANT: Runtime.enable timed out after 3000ms waiting for the main-frame ` +
                  `Runtime.executionContextCreated (auxData.isDefault) on ${describeCdpSession(sessionId)}. ` +
                  `Answering Runtime.enable anyway. If the event never arrives at all, page.evaluate against ` +
                  `this target will never return — Playwright waits for a frame's execution context with no deadline.`,
              ),
            )
            resolve()
          }, 3000)
          emitter.on('cdp:event', handler)
        })

        const result = await sendToExtension({
          extensionId: resolvedExtensionId,
          method: 'forwardCDPCommand',
          params: { sessionId, method, params, source },
        })

        await contextCreatedPromise

        return result
      }
    }

    return await sendToExtension({
      extensionId: resolvedExtensionId,
      method: 'forwardCDPCommand',
      params: { sessionId, method, params, source },
    })
  }

  const app = new Hono()

  // Global error handler — ensures server errors are logged, not silently swallowed
  app.onError((err, c) => {
    logger?.error('Unhandled route error:', err)
    return c.json({ error: err.message }, 500)
  })

  // CORS middleware for HTTP endpoints - only allows our specific extension IDs.
  // This prevents other extensions from reading responses via fetch/XHR.
  // WebSocket connections have their own separate origin validation.
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin.startsWith('chrome-extension://')) {
          return null
        }
        const extensionId = origin.replace('chrome-extension://', '')
        if (!EXTENSION_IDS.includes(extensionId)) {
          return null
        }
        return origin
      },
      allowMethods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
    }),
  )
  // Host header validation to prevent DNS rebinding attacks.
  // DNS rebinding is worse than a simple cross-origin request: the attacker
  // serves a page from http://evil.com:19988, then rebinds the DNS to
  // 127.0.0.1. The browser now considers requests to our relay as same-origin,
  // so Sec-Fetch-Site is "same-origin", CORS doesn't apply, and JSON POSTs
  // don't need preflight. This bypasses all our other defenses.
  // By rejecting any Host that isn't a known localhost value we kill DNS
  // rebinding at the root. When a valid token is provided (remote access), we
  // allow through regardless of Host since remote clients use real hostnames.
  const ALLOWED_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    '::1',
  ])

  // Parse the Host header into just the hostname, handling IPv6 brackets and
  // port suffixes. Returns null for missing or malformed values.
  function parseHostname(hostHeader: string | undefined): string | null {
    const value = hostHeader?.trim().toLowerCase()
    if (!value) {
      return null
    }
    // IPv6 in brackets: [::1] or [::1]:19988
    if (value.startsWith('[')) {
      const closingBracket = value.indexOf(']')
      if (closingBracket === -1) {
        return null
      }
      const host = value.slice(0, closingBracket + 1)
      const rest = value.slice(closingBracket + 1)
      if (rest && !/^:\d+$/.test(rest)) {
        return null
      }
      return host
    }
    // Bare ::1 without brackets (uncommon but possible)
    if (value === '::1') {
      return '::1'
    }
    // hostname or hostname:port
    const colonIndex = value.indexOf(':')
    if (colonIndex === -1) {
      return value
    }
    const host = value.slice(0, colonIndex)
    const portPart = value.slice(colonIndex + 1)
    if (!/^\d+$/.test(portPart)) {
      return null
    }
    return host || null
  }

  function hasValidToken(c: { req: { header: (name: string) => string | undefined; url: string } }): boolean {
    if (!token) {
      return false
    }
    const authHeader = c.req.header('authorization') || ''
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    const queryToken = new URL(c.req.url, 'http://localhost').searchParams.get('token')
    return bearerToken === token || queryToken === token
  }

  app.use('*', async (c, next) => {
    const hostname = parseHostname(c.req.header('host'))
    if (hostname && ALLOWED_HOSTS.has(hostname)) {
      return next()
    }
    // Remote clients with a valid token are allowed regardless of Host
    if (hasValidToken(c)) {
      return next()
    }
    // Missing Host header from non-browser clients (curl without Host) is fine
    // in local mode since they're not browser-based DNS rebinding attacks
    if (!hostname && !token) {
      return next()
    }
    logger?.log(pc.red(`Rejecting request with unexpected Host header: ${c.req.header('host')} (DNS rebinding protection)`))
    return c.text('Forbidden - Invalid Host header', 403)
  })

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  const getCdpWsUrl = (c: { req: { header: (name: string) => string | undefined } }) => {
    const hostHeader = c.req.header('host') || `${host}:${port}`
    return `ws://${hostHeader}/cdp`
  }

  app.get('/', (c) => {
    return c.text('OK')
  })

  app.get('/version', (c) => {
    return c.json({ version: VERSION })
  })

  app.get('/extension/status', (c) => {
    const defaultExtension = getExtensionConnection(null, { allowFallback: true })
    const connected = store.getState().extensions.size > 0
    const activeTargets = defaultExtension?.connectedTargets.size || 0
    const info = defaultExtension?.info

    return c.json({
      connected,
      activeTargets,
      browser: info?.browser || null,
      profile: info ? { email: info.email || '', id: info.id || '' } : null,
      playwriterVersion: info?.version || null,
    })
  })

  app.get('/extensions/status', (c) => {
    const extensions = Array.from(store.getState().extensions.values()).map((ext) => {
      return {
        extensionId: ext.id,
        stableKey: ext.stableKey,
        browser: ext.info.browser || null,
        profile: ext.info ? { email: ext.info.email || '', id: ext.info.id || '' } : null,
        activeTargets: ext.connectedTargets.size,
        playwriterVersion: ext.info?.version || null,
      }
    })
    return c.json({ extensions })
  })

  // CDP Discovery Endpoints - Standard Chrome DevTools Protocol HTTP API
  // Allows tools like Playwright to discover the WebSocket URL via http://host:port
  // Spec: https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_http_handler.cc

  app
    .on(['GET', 'PUT'], '/json/version', (c) => {
      return c.json({
        Browser: `Playwriter/${VERSION}`,
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: getCdpWsUrl(c),
      })
    })
    .on(['GET', 'PUT'], '/json/version/', (c) => {
      return c.json({
        Browser: `Playwriter/${VERSION}`,
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: getCdpWsUrl(c),
      })
    })
    .on(['GET', 'PUT'], '/json/list', (c) => {
      const wsUrl = getCdpWsUrl(c)
      const defaultTargets = getExtensionConnection(null, { allowFallback: true })?.connectedTargets || new Map()
      return c.json(
        Array.from(defaultTargets.values()).map((t) => ({
          id: t.targetId,
          type: t.targetInfo.type,
          title: t.targetInfo.title,
          description: t.targetInfo.title,
          url: t.targetInfo.url,
          webSocketDebuggerUrl: wsUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${wsUrl.replace('ws://', '')}`,
        })),
      )
    })
    .on(['GET', 'PUT'], '/json/list/', (c) => {
      const wsUrl = getCdpWsUrl(c)
      const defaultTargets = getExtensionConnection(null, { allowFallback: true })?.connectedTargets || new Map()
      return c.json(
        Array.from(defaultTargets.values()).map((t) => ({
          id: t.targetId,
          type: t.targetInfo.type,
          title: t.targetInfo.title,
          description: t.targetInfo.title,
          url: t.targetInfo.url,
          webSocketDebuggerUrl: wsUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${wsUrl.replace('ws://', '')}`,
        })),
      )
    })
    .on(['GET', 'PUT'], '/json', (c) => {
      const wsUrl = getCdpWsUrl(c)
      const defaultTargets = getExtensionConnection(null, { allowFallback: true })?.connectedTargets || new Map()
      return c.json(
        Array.from(defaultTargets.values()).map((t) => ({
          id: t.targetId,
          type: t.targetInfo.type,
          title: t.targetInfo.title,
          description: t.targetInfo.title,
          url: t.targetInfo.url,
          webSocketDebuggerUrl: wsUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${wsUrl.replace('ws://', '')}`,
        })),
      )
    })
    .on(['GET', 'PUT'], '/json/', (c) => {
      const wsUrl = getCdpWsUrl(c)
      const defaultTargets = getExtensionConnection(null, { allowFallback: true })?.connectedTargets || new Map()
      return c.json(
        Array.from(defaultTargets.values()).map((t) => ({
          id: t.targetId,
          type: t.targetInfo.type,
          title: t.targetInfo.title,
          description: t.targetInfo.title,
          url: t.targetInfo.url,
          webSocketDebuggerUrl: wsUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${wsUrl.replace('ws://', '')}`,
        })),
      )
    })

  app.post('/mcp-log', async (c) => {
    try {
      const { level, args } = await c.req.json()
      const logFn = (logger as any)?.[level] || logger?.log
      const prefix = pc.red(`[MCP] [${level.toUpperCase()}]`)
      logFn?.(prefix, ...args)
      return c.json({ ok: true })
    } catch {
      return c.json({ ok: false }, 400)
    }
  })

  // Validate Origin header for WebSocket connections to prevent cross-origin attacks.
  // Browsers always send Origin header for WebSocket connections, but Node.js clients don't.
  // We only allow our specific extension IDs to prevent malicious websites or extensions
  // from connecting to the local WebSocket server.
  app.get(
    '/cdp/:clientId?',
    (c, next) => {
      const origin = c.req.header('origin')

      // Validate Origin header if present (Node.js clients don't send it)
      if (origin) {
        if (origin.startsWith('chrome-extension://')) {
          const extensionId = origin.replace('chrome-extension://', '')
          if (!EXTENSION_IDS.includes(extensionId)) {
            logger?.log(pc.red(`Rejecting /cdp WebSocket from unknown extension: ${extensionId}`))
            return c.text('Forbidden', 403)
          }
        } else {
          logger?.log(pc.red(`Rejecting /cdp WebSocket from origin: ${origin}`))
          return c.text('Forbidden', 403)
        }
      }

      if (token) {
        const url = new URL(c.req.url, 'http://localhost')
        const providedToken = url.searchParams.get('token')
        if (providedToken !== token) {
          return c.text('Unauthorized', 401)
        }
      }
      return next()
    },
    upgradeWebSocket((c) => {
      const clientId = c.req.param('clientId') || 'default'
      const url = new URL(c.req.url, 'http://localhost')
      const requestedExtensionId = url.searchParams.get('extensionId')
      // When extensionId is explicit, resolve directly. Otherwise use fallback which
      // handles single-extension and uniquely-active-extension cases (#52).
      const resolvedExtension = requestedExtensionId
        ? getExtensionConnection(requestedExtensionId)
        : getExtensionConnection(null, { allowFallback: true })
      const clientExtensionId = resolvedExtension?.id || null

      const getBoundExtensionIdForClient = (): string | null => {
        const client = store.getState().playwrightClients.get(clientId)
        return client?.extensionId || null
      }

      return {
        async onOpen(_event, ws) {
          if (store.getState().playwrightClients.has(clientId)) {
            logger?.log(pc.yellow(`Rejecting duplicate Playwright clientId: ${clientId}`))
            ws.close(4004, 'Duplicate Playwright clientId')
            return
          }

          if (!clientExtensionId) {
            const reason = requestedExtensionId
              ? `Unknown extensionId: ${requestedExtensionId}`
              : 'Multiple extensions connected. Specify extensionId.'
            logger?.log(pc.yellow(`Rejecting Playwright client ${clientId}: ${reason}`))
            ws.close(4003, reason)
            return
          }

          // Read the client's owning-workspace identity off the connection URL.
          // getCdpUrl (Todo 5) sets `workspace` (= workspace.key) and `workspaceLabel`
          // (= workspace.label) together. URLSearchParams percent-decodes the `:` in
          // the key back from `%3A`, so `wt:`/`cwd:`/`x:` prefixes arrive intact — do
          // NOT hand-parse the query string (that would keep the literal `%3A` and
          // break every === comparison downstream).
          const workspaceKey = url.searchParams.get('workspace')
          const workspaceLabel = url.searchParams.get('workspaceLabel')
          // I1: every real client (MCP Todo 7, CLI Todo 8, tests Todo 26) supplies a
          // key. A missing/empty key is a bug, not a case to default — reject it loudly
          // so it can never silently recreate the shared-tabs leak. Mirrors the
          // 4003/4004 rejection style above and runs BEFORE addPlaywrightClient (no
          // zombie client is registered). Requiring both non-empty also narrows them
          // from `string | null` to `string` for the non-nullable field below (I1).
          if (!workspaceKey || !workspaceLabel) {
            const reason = 'Missing workspace'
            logger?.log(pc.yellow(`Rejecting Playwright client ${clientId}: ${reason}`))
            ws.close(4005, reason)
            return
          }

          // Add client first so it can receive Target.attachedToTarget events.
          // workspaceKey/workspaceLabel are the owning-workspace identity read above,
          // guaranteed non-empty by the 4005 rejection.
          store.setState((s) => {
            return relayState.addPlaywrightClient(s, {
              id: clientId,
              extensionId: clientExtensionId,
              ws,
              workspaceKey,
              workspaceLabel,
            })
          })
          const extensionConnection = getExtensionConnection(clientExtensionId)
          const targetCount = extensionConnection?.connectedTargets.size || 0
          logger?.log(
            pc.green(
              `Playwright client connected: ${clientId} (${store.getState().playwrightClients.size} total) (extension? ${!!extensionConnection}) (${targetCount} pages)`,
            ),
          )
        },

        async onMessage(event, ws) {
          let message: CDPCommand

          try {
            message = JSON.parse(event.data.toString())
          } catch {
            return
          }

          const { id, sessionId, method, params, source } = message

          logCdpJson({
            timestamp: new Date().toISOString(),
            direction: 'from-playwright',
            clientId,
            message,
          })

          logCdpMessage({
            direction: 'from-playwright',
            clientId,
            method,
            sessionId,
            id,
          })

          emitter.emit('cdp:command', { clientId, command: message })

          // CDP ordering bookkeeping (see the Runtime.enable fence near the top of this
          // file). Only session-scoped, id-bearing commands take part: a browser-level
          // command has no session whose event stream it could be ordered against.
          const orderingSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null
          const orderingId = typeof id === 'number' ? id : null
          if (orderingSessionId !== null && orderingId !== null) {
            noteCommandStarted({ clientId, sessionId: orderingSessionId, id: orderingId })
            if (method === 'Runtime.enable') {
              openOrderingFence({ clientId, sessionId: orderingSessionId, runtimeEnableId: orderingId })
            }
          }

          const boundExtensionId = getBoundExtensionIdForClient()
          const extensionConn = getExtensionConnection(boundExtensionId)
          if (!extensionConn) {
            sendToPlaywright({
              message: {
                id,
                sessionId,
                error: { message: 'Extension not connected' },
              },
              clientId,
            })
            if (orderingSessionId !== null && orderingId !== null) {
              noteCommandFinished({ clientId, sessionId: orderingSessionId, id: orderingId })
            }
            return
          }

          try {
            // Read the requesting client's own workspace (key + label) from one snapshot so
            // routeCdpCommand's Target.setAutoAttach case can auto-create a tab for THIS
            // workspace. Both are non-null for any live client (I1: Todo 12's 4005 rejection);
            // undefined only if the client vanished mid-flight, in which case auto-create is
            // correctly skipped downstream (no recipient) — never defaulted.
            const requestingClient = store.getState().playwrightClients.get(clientId)
            const result = await routeCdpCommand({
              extensionId: extensionConn.id,
              method,
              params,
              sessionId,
              source,
              workspaceKey: requestingClient?.workspaceKey ?? null,
              workspaceLabel: requestingClient?.workspaceLabel ?? null,
            })

            if (method === 'Target.setAutoAttach' && !sessionId) {
              // Z6/I3: this loop is how a client learns which pages exist on connect.
              // Replay ONLY targets owned by the requesting client's own workspace.
              // getClientWorkspaceKey returns null only when the client vanished
              // mid-flight (disconnect race); a keyless client gets nothing (I1 means a
              // connected client always has a non-null key — Todo 12's 4005 rejection).
              const clientWorkspaceKey = getClientWorkspaceKey(clientId)
              if (!clientWorkspaceKey) {
                return
              }
              // Re-read state after async routeCdpCommand — targets may have changed
              const freshExt = store.getState().extensions.get(extensionConn.id)
              const freshTargets = freshExt?.connectedTargets || new Map()
              for (const target of freshTargets.values()) {
                // Skip restricted targets (extensions, chrome:// URLs, non-page types)
                if (isRestrictedTarget(target.targetInfo)) {
                  continue
                }
                // Z6/I3: strict-equality workspace filter. A freestyle target
                // (workspaceKey === null) matches no keyed client, so it is never
                // replayed here. No claiming, no fallback, no prefix stripping.
                if (!visibleToWorkspace(target, clientWorkspaceKey)) {
                  continue
                }
                const attachedPayload = {
                  method: 'Target.attachedToTarget',
                  params: {
                    sessionId: target.sessionId,
                    targetInfo: {
                      ...target.targetInfo,
                      attached: true,
                    },
                    waitingForDebugger: false,
                  },
                } satisfies CDPEventFor<'Target.attachedToTarget'>
                if (!target.targetInfo.url) {
                  logger?.error(
                    pc.red('[Server] WARNING: Target.attachedToTarget sent with empty URL!'),
                    JSON.stringify(attachedPayload),
                  )
                }
                logger?.log(
                  pc.magenta('[Server] Target.attachedToTarget full payload:'),
                  JSON.stringify(attachedPayload),
                )
                sendToPlaywright({
                  message: attachedPayload,
                  clientId,
                  source: 'server',
                })
              }
            }

            if (method === 'Target.setDiscoverTargets' && (params as Protocol.Target.SetDiscoverTargetsRequest)?.discover) {
              // Z6/I3: the discovery channel is a SECOND way a client learns which
              // pages exist. Replay ONLY targets owned by the requesting client's own
              // workspace, identically to the Target.setAutoAttach filter above —
              // otherwise a client would learn of foreign targets here even though the
              // attach channel is filtered (a partial leak showing up as ghost pages).
              // getClientWorkspaceKey returns null only when the client vanished
              // mid-flight (disconnect race); a keyless client gets nothing (I1 means a
              // connected client always has a non-null key — Todo 12's 4005 rejection).
              const clientWorkspaceKey = getClientWorkspaceKey(clientId)
              if (!clientWorkspaceKey) {
                return
              }
              const freshExt2 = store.getState().extensions.get(extensionConn.id)
              const freshTargets2 = freshExt2?.connectedTargets || new Map()
              for (const target of freshTargets2.values()) {
                // Skip restricted targets (extensions, chrome:// URLs, non-page types)
                if (isRestrictedTarget(target.targetInfo)) {
                  continue
                }
                // Z6/I3: strict-equality workspace filter. A freestyle target
                // (workspaceKey === null) matches no keyed client, so it is never
                // replayed here. No claiming, no fallback, no prefix stripping.
                if (!visibleToWorkspace(target, clientWorkspaceKey)) {
                  continue
                }
                const targetCreatedPayload = {
                  method: 'Target.targetCreated',
                  params: {
                    targetInfo: {
                      ...target.targetInfo,
                      attached: true,
                    },
                  },
                } satisfies CDPEventFor<'Target.targetCreated'>
                if (!target.targetInfo.url) {
                  logger?.error(
                    pc.red('[Server] WARNING: Target.targetCreated sent with empty URL!'),
                    JSON.stringify(targetCreatedPayload),
                  )
                }
                logger?.log(
                  pc.magenta('[Server] Target.targetCreated full payload:'),
                  JSON.stringify(targetCreatedPayload),
                )
                sendToPlaywright({
                  message: targetCreatedPayload,
                  clientId,
                  source: 'server',
                })
              }
            }

            if (method === 'Target.attachToTarget') {
              const attachResponse = result as Protocol.Target.AttachToTargetResponse | undefined
              const attachRequestParams = params as Protocol.Target.AttachToTargetRequest | undefined
              if (attachResponse?.sessionId) {
                // Z6/I3: replay the attach event ONLY for a target the requesting client's
                // own workspace owns. routeCdpCommand's Target.attachToTarget case already
                // refuses to return a sessionId for a foreign/absent target, so this applies
                // the SAME predicate to the event push (defense-in-depth). getClientWorkspaceKey
                // returns null only when the client vanished mid-flight (disconnect race); a
                // keyless client gets nothing (I1: a connected client always has a non-null key
                // via Todo 12's 4005 rejection).
                const clientWorkspaceKey = getClientWorkspaceKey(clientId)
                if (!clientWorkspaceKey) {
                  return
                }
                const freshExt3 = store.getState().extensions.get(extensionConn.id)
                const freshTargets3 = freshExt3?.connectedTargets || new Map()
                const target = Array.from(freshTargets3.values()).find((t) => {
                  return t.targetId === attachRequestParams?.targetId
                })
                // Z6/I3: strict-equality workspace filter. A freestyle target
                // (workspaceKey === null) matches no keyed client, so it is never replayed
                // here. No claiming, no fallback, no prefix stripping.
                if (target && visibleToWorkspace(target, clientWorkspaceKey)) {
                  const attachedPayload = {
                    method: 'Target.attachedToTarget',
                    params: {
                      sessionId: attachResponse.sessionId,
                      targetInfo: {
                        ...target.targetInfo,
                        attached: true,
                      },
                      waitingForDebugger: false,
                    },
                  } satisfies CDPEventFor<'Target.attachedToTarget'>
                  if (!target.targetInfo.url) {
                    logger?.error(
                      pc.red('[Server] WARNING: Target.attachedToTarget (from attachToTarget) sent with empty URL!'),
                      JSON.stringify(attachedPayload),
                    )
                  }
                  logger?.log(
                    pc.magenta('[Server] Target.attachedToTarget (from attachToTarget) payload:'),
                    JSON.stringify(attachedPayload),
                  )
                  sendToPlaywright({
                    message: attachedPayload,
                    clientId,
                    source: 'server',
                  })
                }
              }
            }

            const response: CDPResponseBase = { id, sessionId, result }
            sendToPlaywright({ message: response, clientId })
            emitter.emit('cdp:response', { clientId, response, command: message })
          } catch (e) {
            logger?.error('Error handling CDP command:', method, params, e)
            const errorResponse: CDPResponseBase = {
              id,
              sessionId,
              error: { message: (e as Error).message },
            }
            sendToPlaywright({ message: errorResponse, clientId })
            emitter.emit('cdp:response', { clientId, response: errorResponse, command: message })
          } finally {
            // AFTER the response has been written, never before: releasing a fence is what
            // lets the held execution-context events go out, and they must follow the
            // response they were ordered behind. The finally also covers the early returns
            // inside the try (the disconnect-race paths), so a vanished client cannot strand
            // a fence.
            if (orderingSessionId !== null && orderingId !== null) {
              noteCommandFinished({ clientId, sessionId: orderingSessionId, id: orderingId })
            }
          }
        },

        onClose() {
          store.setState((s) => relayState.removePlaywrightClient(s, { clientId }))
          dropClientOrdering(clientId)
          logger?.log(pc.yellow(`Playwright client disconnected: ${clientId} (${store.getState().playwrightClients.size} remaining)`))
        },

        onError(event) {
          logger?.error(`Playwright WebSocket error [${clientId}]:`, event)
        },
      }
    }),
  )

  const getExtensionInfoFromRequest = (c: {
    req: { query: (name: string) => string | undefined }
  }): relayState.ExtensionInfo => {
    const browser = c.req.query('browser')
    const email = c.req.query('email')
    const id = c.req.query('id')
    const installId = c.req.query('installId')
    const version = c.req.query('v')
    return {
      browser: browser || undefined,
      email: email || undefined,
      id: id || undefined,
      installId: installId || undefined,
      version: version || undefined,
    }
  }

  app.get(
    '/extension',
    (c, next) => {
      // 1. Host Validation: The extension endpoint must ONLY be accessed from localhost.
      // This prevents attackers on the network from hijacking the browser session
      // even if the server is exposed via 0.0.0.0.
      const info = getConnInfo(c)
      const remoteAddress = info.remote.address
      const isLocalhost = remoteAddress === '127.0.0.1' || remoteAddress === '::1'

      if (!isLocalhost) {
        logger?.log(pc.red(`Rejecting /extension WebSocket from remote IP: ${remoteAddress}`))
        return c.text('Forbidden - Extension must be local', 403)
      }

      // 2. Origin Validation: Prevent browser-based attacks (CSRF).
      // Browsers cannot spoof the Origin header, so this ensures the connection
      // is coming from our specific Chrome Extension, not a malicious website.
      const origin = c.req.header('origin')
      if (!origin || !origin.startsWith('chrome-extension://')) {
        logger?.log(
          pc.red(`Rejecting /extension WebSocket: origin must be chrome-extension://, got: ${origin || 'none'}`),
        )
        return c.text('Forbidden', 403)
      }

      const extensionId = origin.replace('chrome-extension://', '')
      if (!EXTENSION_IDS.includes(extensionId)) {
        logger?.log(pc.red(`Rejecting /extension WebSocket from unknown extension: ${extensionId}`))
        return c.text('Forbidden', 403)
      }

      return next()
    },
    upgradeWebSocket((c) => {
      const incomingExtensionInfo = getExtensionInfoFromRequest(c)
      const connectionId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      return {
        onOpen(_event, ws) {
          const stableKey = relayState.buildStableExtensionKey(incomingExtensionInfo, connectionId)

          // Check for existing connection with same stableKey and close it
          const existingExt = relayState.findExtensionByStableKey(store.getState(), stableKey)
          if (existingExt && existingExt.id !== connectionId) {
            logger?.log(pc.yellow(`Replacing extension connection for ${stableKey} (${existingExt.id} -> ${connectionId})`))
            if (existingExt.ws) {
              existingExt.ws.close(4001, 'Extension Replaced')
            }
          }

          // State transition: add extension with ws handle included.
          // Existing same-stableKey entry stays until old socket onClose.
          store.setState((s) => {
            return relayState.addExtension(s, { id: connectionId, info: incomingExtensionInfo, stableKey, ws })
          })

          startExtensionPing(connectionId)
          logger?.log(`Extension connected (${connectionId})`)
        },

        async onMessage(event, ws) {
          const ext = store.getState().extensions.get(connectionId)
          if (!ext) {
            ws.close(1000, 'Extension not registered')
            return
          }
          // Handle binary data (recording chunks)
          if (event.data instanceof ArrayBuffer || Buffer.isBuffer(event.data)) {
            const buffer = Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data)
            const relay = getRecordingRelay(connectionId)
            if (relay) {
              relay.handleBinaryData(buffer)
            }
            return
          }

          let message: ExtensionMessage

          try {
            message = JSON.parse(event.data.toString())
          } catch {
            ws.close(1000, 'Invalid JSON')
            return
          }

          if (message.id !== undefined) {
            const pending = (() => {
              let pendingRequest: relayState.ExtensionPendingRequest | null = null

              store.setState((s) => {
                const extensionEntry = s.extensions.get(connectionId)
                if (!extensionEntry) {
                  return s
                }

                const nextPendingRequest = extensionEntry.pendingRequests.get(message.id)
                if (!nextPendingRequest) {
                  return s
                }

                pendingRequest = nextPendingRequest
                return relayState.removeExtensionPendingRequest(s, {
                  extensionId: connectionId,
                  requestId: message.id,
                })
              })

              return pendingRequest
            })() as relayState.ExtensionPendingRequest | null

            if (!pending) {
              logger?.log('Unexpected response with id:', message.id)
              return
            }

            if (message.error) {
              pending.reject(new Error(message.error))
            } else {
              pending.resolve(message.result)
            }
          } else if (message.method === 'pong') {
            // Keep-alive response, nothing to do
          } else if (message.method === 'log') {
            const { level, args } = message.params
            const logFn = (logger as Record<string, unknown>)?.[level] as ((...args: unknown[]) => void) | undefined
            const logFunc = logFn || logger?.log
            const prefix = pc.yellow(`[Extension] [${level.toUpperCase()}]`)
            logFunc?.(prefix, ...args)
          } else if (message.method === 'recordingData') {
            const relay = getRecordingRelay(connectionId)
            if (relay) {
              relay.handleRecordingData(message as RecordingDataMessage)
            }
          } else if (message.method === 'recordingCancelled') {
            const relay = getRecordingRelay(connectionId)
            if (relay) {
              relay.handleRecordingCancelled(message as RecordingCancelledMessage)
            }
          } else {
            const extensionEvent = message as ExtensionEventMessage

            if (extensionEvent.method !== 'forwardCDPEvent') {
              return
            }

            const { method, params, sessionId } = extensionEvent.params

            // Drop high-frequency noise events before logging or forwarding.
            // Old extensions may still send these; the relay filters them here.
            if (DROPPED_CDP_EVENTS.has(method)) {
              return
            }

            if (!NOISY_LOG_EVENTS.has(method)) {
              logCdpJson({
                timestamp: new Date().toISOString(),
                direction: 'from-extension',
                message: { method, params, sessionId },
              })
            }

            logCdpMessage({
              direction: 'from-extension',
              method,
              sessionId,
              params,
            })

            const cdpEvent: CDPEventBase = { method, sessionId, params }
            emitter.emit('cdp:event', { event: cdpEvent, sessionId })

            maybeEmitBrowserDownloadCompatEvent({ method, params, extensionId: connectionId })

            if (method === 'Target.attachedToTarget') {
              const targetParams = params as Protocol.Target.AttachedToTargetEvent
              const incomingSessionId = sessionId
              const iframeParentFrameId = targetParams.targetInfo.parentFrameId
              // Read current extension state for iframe parent lookup
              const currentExtState = store.getState().extensions.get(connectionId)
              const iframeOwnerSessionId =
                targetParams.targetInfo.type === 'iframe' && iframeParentFrameId && currentExtState
                  ? getPageTargetForFrameId({ extensionState: currentExtState, frameId: iframeParentFrameId })?.sessionId
                  : undefined

              // Filter out restricted targets (unsupported types, extension pages, chrome:// URLs, etc.)
              if (isRestrictedTarget(targetParams.targetInfo)) {
                if (targetParams.waitingForDebugger && targetParams.sessionId) {
                  void sendToExtension({
                    extensionId: connectionId,
                    method: 'forwardCDPCommand',
                    params: {
                      sessionId: targetParams.sessionId,
                      method: 'Runtime.runIfWaitingForDebugger',
                      params: {},
                      source: 'server',
                    },
                  }).catch((error) => {
                    const msg = error instanceof Error ? error.message : String(error)
                    logger?.log(pc.yellow('[Server] Failed to resume restricted target:'), msg)
                  })
                }
                logger?.log(
                  pc.gray(
                    `[Server] Ignoring restricted target: ${targetParams.targetInfo.type} (${targetParams.targetInfo.url})`,
                  ),
                )
                return
              }

              if (!targetParams.targetInfo.url) {
                logger?.error(
                  pc.red('[Extension] WARNING: Target.attachedToTarget received with empty URL!'),
                  JSON.stringify({ method, params: targetParams, sessionId }),
                )
              }
              logger?.log(
                pc.yellow('[Extension] Target.attachedToTarget full payload:'),
                JSON.stringify({ method, params: targetParams, sessionId }),
              )

              // Check if we already sent this target to clients (e.g., from Target.setAutoAttach response)
              const alreadyConnected = currentExtState?.connectedTargets.has(targetParams.sessionId) ?? false

              // State transition: add/update target
              store.setState((s) =>
                relayState.addTarget(s, {
                  extensionId: connectionId,
                  sessionId: targetParams.sessionId,
                  targetId: targetParams.targetInfo.targetId,
                  targetInfo: targetParams.targetInfo,
                  // Todo 20 (Job A): stamp the owning workspace from the key the extension
                  // echoes on Target.attachedToTarget (the tab's own key for a page target,
                  // the parent tab's key for a child/OOPIF target). null = freestyle (human
                  // icon-click), visible to no workspace. `undefined` (an older extension
                  // that does not echo) is treated as freestyle — its pre-Todo-20 behaviour;
                  // Todo 33 owns the loud version-skew warning. This is what finally gives
                  // extension-attached targets a real non-null owner so Todo 17's live
                  // broadcast reaches the right client.
                  workspaceKey: extensionEvent.params.workspaceKey ?? null,
                }),
              )

              const cachedDownloadBehavior = extensionDownloadBehavior.get(connectionId)
              if (cachedDownloadBehavior && targetParams.targetInfo.type === 'page') {
                void applyDownloadBehaviorToTargets({
                  extensionId: connectionId,
                  behavior: cachedDownloadBehavior,
                  targetSessionIds: [targetParams.sessionId],
                })
              }

              // Only forward to Playwright if this is a new target to avoid duplicates
              if (!alreadyConnected) {
                sendToPlaywright({
                  message: {
                    // Iframe targets must be routed to the parent page sessionId so Playwright attaches them under the right page.
                    // - iframeOwnerSessionId: derived parent session via parentFrameId -> page sessionId (frameId tracking).
                    // - incomingSessionId: extension event sessionId for the parent tab.
                    // The frameId mapping is racy: Target.attachedToTarget can arrive before Page.frameAttached/Page.frameNavigated populate frameIds.
                    // When iframeOwnerSessionId is missing we must fall back to incomingSessionId, otherwise Playwright receives the attach on the root
                    // session, detaches it, and the iframe stays paused (waitingForDebugger) which can hang navigations.
                    //
                    // The CONSEQUENCE half of that is VERIFIED against the pinned playwright-core 1.59.10 source,
                    // not inferred. Two different handlers read Target.attachedToTarget:
                    //   - crBrowser.ts `_onAttachedToTarget` (the ROOT/browser session). `type: 'iframe'` matches
                    //     none of its branches — browser, devtools 'other', page, service_worker — so it reaches
                    //     the final `session.detach().catch(() => {})` at crBrowser.ts:209. The attach is dropped.
                    //   - crPage.ts `_onAttachedToTarget` (the PAGE session). Its `type === 'iframe'` branch at
                    //     crPage.ts:691 builds a FrameSession and calls `_initialize`, which is what sends
                    //     `Runtime.runIfWaitingForDebugger` (crPage.ts:534) and unpauses the iframe.
                    // So delivering the attach on the root session really does mean detached-and-still-paused,
                    // and the fallback is what keeps it on the page session.
                    //
                    // The RACE half — that the extension can emit Target.attachedToTarget before
                    // Page.frameAttached/Page.frameNavigated have populated `frameIds` — is NOT MEASURED and has
                    // no test. It needs the packed extension driving a real Chrome, which this repo's test
                    // environment cannot do. Treat it as an assumption about extension event ordering. What would
                    // settle it: log the arrival order of these three events for an OOPIF across many loads and
                    // check whether `getPageTargetForFrameId` ever misses.
                    sessionId: iframeOwnerSessionId ?? incomingSessionId,
                    method: 'Target.attachedToTarget',
                    params: targetParams,
                  } as CDPEventBase,
                  source: 'extension',
                  extensionId: connectionId,
                })
              }
            } else if (method === 'Target.detachedFromTarget') {
              const detachParams = params as Protocol.Target.DetachedFromTargetEvent
              store.setState((s) =>
                relayState.removeTarget(s, { extensionId: connectionId, sessionId: detachParams.sessionId }),
              )

              sendToPlaywright({
                message: {
                  method: 'Target.detachedFromTarget',
                  params: detachParams,
                } as CDPEventBase,
                source: 'extension',
                extensionId: connectionId,
              })
            } else if (method === 'Target.targetCrashed') {
              const crashParams = params as Protocol.Target.TargetCrashedEvent
              store.setState((s) =>
                relayState.removeTargetByCrash(s, { extensionId: connectionId, targetId: crashParams.targetId }),
              )
              logger?.log(pc.red('[Server] Target crashed, removing:'), crashParams.targetId)

              sendToPlaywright({
                message: {
                  method: 'Target.targetCrashed',
                  params: crashParams,
                } as CDPEventBase,
                source: 'extension',
                extensionId: connectionId,
              })
            } else if (method === 'Target.targetInfoChanged') {
              const infoParams = params as Protocol.Target.TargetInfoChangedEvent
              store.setState((s) =>
                relayState.updateTargetInfo(s, { extensionId: connectionId, targetInfo: infoParams.targetInfo }),
              )

              sendToPlaywright({
                message: {
                  method: 'Target.targetInfoChanged',
                  params: infoParams,
                } as CDPEventBase,
                source: 'extension',
                extensionId: connectionId,
              })
            } else if (method === 'Page.frameAttached') {
              const frameParams = params as Protocol.Page.FrameAttachedEvent
              if (sessionId) {
                store.setState((s) =>
                  relayState.addFrameId(s, { extensionId: connectionId, sessionId, frameId: frameParams.frameId }),
                )
              }

              sendToPlaywright({
                message: {
                  sessionId,
                  method,
                  params,
                } as CDPEventBase,
                source: 'extension',
                extensionId: connectionId,
              })
            } else if (method === 'Page.frameDetached') {
              const frameParams = params as Protocol.Page.FrameDetachedEvent
              store.setState((s) =>
                relayState.removeFrameId(s, { extensionId: connectionId, frameId: frameParams.frameId }),
              )

              sendToPlaywright({
                message: {
                  sessionId,
                  method,
                  params,
                } as CDPEventBase,
                source: 'extension',
                extensionId: connectionId,
              })
            } else if (method === 'Page.frameNavigated') {
              const frameParams = params as Protocol.Page.FrameNavigatedEvent
              if (sessionId) {
                store.setState((s) =>
                  relayState.addFrameId(s, { extensionId: connectionId, sessionId, frameId: frameParams.frame.id }),
                )
              }
              if (!frameParams.frame.parentId && sessionId) {
                store.setState((s) =>
                  relayState.updateTargetUrl(s, {
                    extensionId: connectionId,
                    sessionId,
                    url: frameParams.frame.url,
                    title: frameParams.frame.name || undefined,
                  }),
                )
                logger?.log(
                  pc.magenta('[Server] Updated target URL from Page.frameNavigated:'),
                  frameParams.frame.url,
                )
              }

              sendToPlaywright({
                message: {
                  sessionId,
                  method,
                  params,
                } as CDPEventBase,
                source: 'extension',
                extensionId: connectionId,
              })
            } else if (method === 'Page.navigatedWithinDocument') {
              const navParams = params as Protocol.Page.NavigatedWithinDocumentEvent
              if (sessionId) {
                store.setState((s) =>
                  relayState.updateTargetUrl(s, { extensionId: connectionId, sessionId, url: navParams.url }),
                )
                logger?.log(
                  pc.magenta('[Server] Updated target URL from Page.navigatedWithinDocument:'),
                  navParams.url,
                )
              }

              sendToPlaywright({
                message: {
                  sessionId,
                  method,
                  params,
                } as CDPEventBase,
                source: 'extension',
                extensionId: connectionId,
              })
            } else {
              sendToPlaywright({
                message: {
                  sessionId,
                  method,
                  params,
                } as CDPEventBase,
                source: 'extension',
                extensionId: connectionId,
              })
            }
          }
        },

        onClose(event) {
          logger?.log(`Extension disconnected: code=${event.code} reason=${event.reason || 'none'} (${connectionId})`)

          // Cancel recordings BEFORE removing extension state (cancelRecording checks isExtensionConnected)
          const recordingRelay = recordingRelays.get(connectionId)
          if (recordingRelay) {
            recordingRelay.cancelRecording({}).catch(() => {
              // Ignore errors during cleanup
            })
          }
          recordingRelays.delete(connectionId)

          // Reject all pending I/O requests (state cleanup happens in removeExtension below)
          const closingExt = store.getState().extensions.get(connectionId)
          if (closingExt) {
            stopExtensionPing(connectionId)
            for (const pending of closingExt.pendingRequests.values()) {
              pending.reject(new Error('Extension connection closed'))
            }
          }

          const currentRelayState = store.getState()
          const closingExtension = currentRelayState.extensions.get(connectionId)
          const successorCandidates = closingExtension
            ? Array.from(currentRelayState.extensions.values())
                .reverse()
                .filter((ext) => {
                  return ext.id !== connectionId && ext.stableKey === closingExtension.stableKey && Boolean(ext.ws)
                })
            : []
          const successorExtension = closingExtension
            ? successorCandidates[0]
            : undefined

          if (successorExtension) {
            logger?.log(
              pc.yellow(
                `Rebinding clients from ${connectionId} to ${successorExtension.id} (stableKey: ${successorExtension.stableKey})`,
              ),
            )
            store.setState((s) => {
              return relayState.rebindClientsToExtension(s, {
                fromExtensionId: connectionId,
                toExtensionId: successorExtension.id,
              })
            })
          }

          // Close playwright clients bound to this extension when no successor exists.
          if (!successorExtension) {
            const { playwrightClients } = store.getState()
            for (const client of playwrightClients.values()) {
              if (client.extensionId === connectionId) {
                client.ws.close(1000, 'Extension disconnected')
              }
            }
          }

          // State transition: remove extension + its bound clients atomically
          store.setState((s) => relayState.removeExtension(s, { extensionId: connectionId }))
        },

        onError(event) {
          logger?.error('Extension WebSocket error:', event)
        },
      }
    }),
  )

  // ============================================================================
  // CLI Execute Endpoints - For stateful code execution via CLI
  // ============================================================================

  // Session counter for suggesting next session number
  let nextSessionNumber = 1

  // Lazy-load ExecutorManager to avoid circular imports and only when needed
  let executorManager: import('./executor.js').ExecutorManager | null = null

  const getExecutorManager = async () => {
    if (!executorManager) {
      const { ExecutorManager } = await import('./executor.js')
      // Pass config instead of URL so executor can generate unique client IDs for each connection
      executorManager = new ExecutorManager({
        cdpConfig: { host: '127.0.0.1', port, token },
        logger: logger || { log: console.error, error: console.error },
      })
    }
    return executorManager
  }

  // ============================================================================
  // Security middleware for privileged HTTP routes (/cli/*, /recording/*, /mcp-log)
  //
  // CORS alone does NOT prevent cross-origin POST attacks. Browsers skip the
  // preflight for "simple" requests (POST + Content-Type: text/plain), so a
  // malicious website can fire-and-forget a POST to localhost:19988/cli/execute
  // and the code executes before CORS even enters the picture.
  //
  // Three layers of defense:
  // 1. Sec-Fetch-Site: browsers set this forbidden header on every request.
  //    If present and not "same-origin"/"none", it's a cross-origin browser
  //    request → reject. Node.js clients don't send it → unaffected.
  // 2. Content-Type must be application/json on POST. This forces a CORS
  //    preflight as a fallback, which our CORS policy already blocks.
  // 3. When token mode is enabled (remote access), require the token on EVERY
  //    request, including loopback. Tunnel agents (traforo, ngrok, cloudflared)
  //    forward public traffic from 127.0.0.1, so a loopback bypass would be
  //    a full auth bypass. In-process callers attach the token themselves
  //    via PLAYWRITER_TOKEN env (set by the `serve` command at startup).
  // ============================================================================
  const privilegedRouteMiddleware = async (
    c: Parameters<Parameters<typeof app.use>[1]>[0],
    next: () => Promise<void>,
  ) => {
    // Block cross-origin browser requests via Sec-Fetch-Site header.
    // Browsers always set this forbidden header; it cannot be spoofed.
    // Non-browser clients (Node.js, curl, MCP) don't send it.
    const secFetchSite = c.req.header('sec-fetch-site')
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      logger?.log(pc.red(`Rejecting ${c.req.path}: cross-origin browser request (Sec-Fetch-Site: ${secFetchSite})`))
      return c.text('Forbidden - Cross-origin requests not allowed', 403)
    }

    // Require application/json on POST to force CORS preflight as backup defense.
    // A text/plain POST is a "simple request" that skips preflight entirely.
    if (c.req.method === 'POST') {
      const contentType = c.req.header('content-type') || ''
      if (!contentType.includes('application/json')) {
        logger?.log(pc.red(`Rejecting ${c.req.path}: Content-Type must be application/json, got: ${contentType}`))
        return c.text('Content-Type must be application/json', 415)
      }
    }

    // When token mode is enabled (remote/serve mode), require authentication
    // on EVERY request, including loopback. Earlier versions bypassed the
    // check for 127.0.0.1/::1 to spare in-process callers, but that's unsafe:
    // when the relay is fronted by a tunnel agent (traforo, ngrok, cloudflared,
    // etc.) running as a local process, every public request reaches the relay
    // from 127.0.0.1 and would skip auth. In-process callers must instead
    // attach the token themselves — they read PLAYWRITER_TOKEN from env, which
    // the `serve` command sets at startup.
    if (token) {
      const authHeader = c.req.header('authorization') || ''
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
      const url = new URL(c.req.url, 'http://localhost')
      const queryToken = url.searchParams.get('token')
      if (bearerToken !== token && queryToken !== token) {
        logger?.log(pc.red(`Rejecting ${c.req.path}: invalid or missing token`))
        return c.text('Unauthorized', 401)
      }
    }

    return next()
  }

  app.use('/cli/*', privilegedRouteMiddleware)
  app.use('/recording/*', privilegedRouteMiddleware)
  app.use('/mcp-log', privilegedRouteMiddleware)

  app.post('/cli/execute', async (c) => {
    try {
      const body = (await c.req.json()) as { sessionId: string | number; code: string; timeout?: number }
      const sessionId = normalizeSessionId(body.sessionId)
      const { code, timeout = 10000 } = body

      if (!sessionId || !code) {
        return c.json({ error: 'sessionId and code are required' }, 400)
      }

      const manager = await getExecutorManager()
      const existingExecutor = manager.getSession(sessionId)
      if (!existingExecutor) {
        return c.json(
          { text: `Session ${sessionId} not found. Run 'playwriter session new' first.`, images: [], screenshots: [], isError: true },
          404,
        )
      }
      // Touch cloud session activity tracking if this session is cloud-backed
      const cloudTracking = cloudSessionTracking.get(sessionId)
      if (cloudTracking) {
        cloudTracking.lastActivityAt = Date.now()
        cloudTracking.activeExecutions++
      }

      let result: Awaited<ReturnType<typeof existingExecutor.execute>>
      try {
        result = await existingExecutor.execute(code, timeout)
      } finally {
        if (cloudTracking) {
          cloudTracking.activeExecutions--
          cloudTracking.lastActivityAt = Date.now()
        }
      }

      // Use the cloudTracking snapshot captured before execute (not a fresh
      // map lookup) so long-running executes that outlive idle cleanup still
      // report isCloud correctly.
      return c.json({ ...result, isCloud: Boolean(cloudTracking) })
    } catch (error: any) {
      logger?.error('Execute endpoint error:', error)
      return c.json({ text: `Server error: ${error.message}`, images: [], screenshots: [], isError: true }, 500)
    }
  })

  app.post('/cli/reset', async (c) => {
    try {
      const body = (await c.req.json()) as { sessionId: string | number }
      const sessionId = normalizeSessionId(body.sessionId)

      if (!sessionId) {
        return c.json({ error: 'sessionId is required' }, 400)
      }

      const manager = await getExecutorManager()
      const existingExecutor = manager.getSession(sessionId)
      if (!existingExecutor) {
        return c.json({ error: `Session ${sessionId} not found. Run 'playwriter session new' first.` }, 404)
      }
      const { page, context } = await existingExecutor.reset()

      return c.json({
        success: true,
        pageUrl: page.url(),
        pagesCount: context.pages().length,
      })
    } catch (error: any) {
      logger?.error('Reset endpoint error:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.get('/cli/sessions', async (c) => {
    const manager = await getExecutorManager()
    return c.json({ sessions: manager.listSessions() })
  })

  app.get('/cli/session/suggest', (c) => {
    return c.json({ next: nextSessionNumber })
  })

  app.post('/cli/session/new', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      extensionId?: string | null
      cwd?: string
      /** Direct CDP WebSocket URL — bypasses extension, connects straight to Chrome */
      cdpEndpoint?: string
      /** Launch a headless Chrome via chromium.launch() — no extension or relay CDP routing */
      headless?: boolean
      /** Browser name from discovery (e.g. "Chrome", "Brave") */
      browser?: string
      /** Profile info from discovery */
      profiles?: Array<{ name: string; email: string }>
      /** Cloud session tracking metadata (set by CLI when connecting to a cloud browser) */
      cloud?: {
        cloudSessionId: string
        cloudBaseUrl: string
        cloudToken: string
        /** BU VM hard timeout (ISO string or epoch ms) */
        timeoutAt?: string | number
        /** Block images/video/fonts to save proxy bandwidth */
        blockProxyResources?: boolean
      }
    }
    const sessionId = String(nextSessionNumber++)
    const cwd = body.cwd

    // Headless mode: launch Chrome via chromium.launch(), no extension needed.
    // Force connection immediately so missing Chrome errors surface at creation time,
    // not on first execute call.
    if (body.headless) {
      const manager = await getExecutorManager()
      const executor = manager.getExecutor({
        sessionId,
        cwd,
        cdpConfig: { headless: true },
        sessionMetadata: {
          extensionId: null,
          browser: 'Chrome (Headless)',
          profile: null,
          // Headless launches its own browser and gives this executor its own context.
          // It is isolated by construction and never reaches the relay, so it is never keyed.
          workspace: null,
        },
      })
      try {
        await executor.reset()
      } catch (error) {
        manager.deleteExecutor(sessionId)
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
      }
      const metadata = executor.getSessionMetadata()
      return c.json({
        id: sessionId,
        mode: 'headless' as const,
        extensionId: metadata.extensionId,
        browser: metadata.browser,
        profile: metadata.profile,
      })
    }

    // Direct CDP mode: skip extension lookup, pass direct WebSocket URL to executor
    if (body.cdpEndpoint) {
      if (!body.cdpEndpoint.startsWith('ws://') && !body.cdpEndpoint.startsWith('wss://')) {
        return c.json({ error: `Invalid cdpEndpoint: must start with ws:// or wss:// (got: ${body.cdpEndpoint})` }, 400)
      }
      // Use first profile from discovery for session metadata (if available)
      const firstProfile = body.profiles?.[0]
      const cloudTimeoutAt = body.cloud?.timeoutAt
        ? (typeof body.cloud.timeoutAt === 'string' ? new Date(body.cloud.timeoutAt).getTime() : body.cloud.timeoutAt)
        : undefined
      const manager = await getExecutorManager()
      const executor = manager.getExecutor({
        sessionId,
        cwd,
        cdpConfig: { directCdpUrl: appendSessionToWsUrl(body.cdpEndpoint, sessionId) },
        sessionMetadata: {
          extensionId: null,
          browser: body.browser || null,
          profile: firstProfile ? { email: firstProfile.email, id: firstProfile.name } : null,
          // Direct-CDP and cloud sessions connect straight to a browser they own outright,
          // bypassing relay and extension. There is no client to key.
          workspace: null,
        },
        cloudSession: body.cloud ? { timeoutAt: cloudTimeoutAt, blockProxyResources: body.cloud.blockProxyResources } : undefined,
      })
      const metadata = executor.getSessionMetadata()

      // Register cloud session tracking if cloud metadata was provided
      if (body.cloud) {
        cloudSessionTracking.set(sessionId, {
          cloudSessionId: body.cloud.cloudSessionId,
          cloudBaseUrl: body.cloud.cloudBaseUrl,
          cloudToken: body.cloud.cloudToken,
          lastActivityAt: Date.now(),
          activeExecutions: 0,
          timeoutAt: cloudTimeoutAt,
        })
        persistCloudSessions()
      }

      return c.json({
        id: sessionId,
        mode: 'direct' as const,
        extensionId: metadata.extensionId,
        browser: metadata.browser,
        profile: metadata.profile,
      })
    }

    // Extension mode (existing behavior)
    const extensionId = body.extensionId || null
    const allowDefault = !extensionId && store.getState().extensions.size === 1
    const conn = getExtensionConnection(extensionId, { allowFallback: allowDefault })
    if (!conn) {
      const error = extensionId
        ? `Extension not connected: ${extensionId}`
        : 'Multiple extensions connected. Specify extensionId.'
      return c.json({ error }, 404)
    }
    // I4: the workspace key for a CLI session MUST be derived from the request body's own
    // cwd, NEVER from the daemon's process.cwd()/env. The daemon is a singleton that keeps
    // the cwd and env of whichever session first spawned it while serving all the others, so
    // a daemon-side derivation would brand every session with that first session's identity —
    // the exact bug this feature exists to kill. deriveWorkspace() called with no argument
    // falls back to the daemon's own CLAUDE_PROJECT_DIR/process.cwd(), and an empty string
    // resolves to process.cwd() as well, so a missing/empty cwd is a hard, loud error here
    // rather than a silent daemon-side default.
    if (!cwd) {
      return c.json({ error: 'Missing cwd: a CLI extension session must send its working directory so the relay can derive the workspace key.' }, 400)
    }
    let workspace: Workspace
    try {
      workspace = deriveWorkspace(cwd)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
    const manager = await getExecutorManager()
    const executor = manager.getExecutor({
      sessionId,
      cwd,
      sessionMetadata: {
        extensionId: conn.stableKey,
        browser: conn.info.browser || null,
        profile: conn.info ? { email: conn.info.email || '', id: conn.info.id || '' } : null,
        // Keyed from the CLI session's own cwd (body.cwd), derived above. This is the one
        // relay/extension topology that needs keying; headless/direct/cloud stay null.
        workspace,
      },
    })
    const metadata = executor.getSessionMetadata()
    return c.json({
      id: sessionId,
      mode: 'extension' as const,
      extensionId: metadata.extensionId,
      browser: metadata.browser,
      profile: metadata.profile,
    })
  })

  app.get('/cli/session/:id', async (c) => {
    const sessionId = c.req.param('id')
    const manager = await getExecutorManager()
    const executor = manager.getSession(sessionId)
    if (!executor) {
      return c.json({ error: 'not found' }, 404)
    }
    return c.json(executor.getSessionInfo({ id: sessionId }))
  })

  app.post('/cli/session/delete', async (c) => {
    try {
      const body = (await c.req.json()) as { sessionId: string | number }
      const sessionId = normalizeSessionId(body.sessionId)

      if (!sessionId) {
        return c.json({ error: 'sessionId is required' }, 400)
      }

      const manager = await getExecutorManager()
      const executor = manager.getSession(sessionId)

      // Close headless context before deleting to prevent context/page leaks
      // on the shared headless browser. Only affects headless sessions.
      if (executor) {
        await executor.closeHeadlessContext()
      }

      const deleted = manager.deleteExecutor(sessionId)

      if (!deleted) {
        return c.json({ error: `Session ${sessionId} not found` }, 404)
      }

      // If this was a cloud-backed session, stop the VM only if no other
      // relay session is still using the same cloud VM (reference counting).
      const cloudTracking = cloudSessionTracking.get(sessionId)
      if (cloudTracking) {
        const shouldStopVm = !hasOtherCloudReferences(sessionId, cloudTracking.cloudSessionId)
        cloudSessionTracking.delete(sessionId)
        persistCloudSessions()
        if (shouldStopVm) {
          disconnectCloudVm(cloudTracking)
        }
      }

      return c.json({ success: true })
    } catch (error: any) {
      logger?.error('Delete session endpoint error:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  // ============================================================================
  // Recording Endpoints - For screen recording via chrome.tabCapture
  // ============================================================================

  app.post('/recording/start', async (c) => {
    const body = (await c.req.json()) as {
      outputPath?: string
      sessionId?: string | number
      frameRate?: number
      audio?: boolean
      videoBitsPerSecond?: number
      audioBitsPerSecond?: number
    }
    const sessionId = normalizeSessionId(body.sessionId)
    const { sessionId: _sessionId, ...recordingOptions } = body
    const { extensionId, sessionId: resolvedSessionId } = await resolveRecordingRoute({ sessionId })
    const relay = getRecordingRelay(extensionId)
    if (!relay) {
      return c.json({ success: false, error: 'Extension not connected' }, 500)
    }
    const recordingParams = (resolvedSessionId
      ? { ...recordingOptions, sessionId: resolvedSessionId }
      : recordingOptions) as StartRecordingBody
    const result = await relay.startRecording(recordingParams)
    const status = result.success ? 200 : result.error?.includes('required') ? 400 : 500
    return c.json(result, status)
  })

  app.post('/recording/stop', async (c) => {
    const body = (await c.req.json()) as { sessionId?: string | number }
    const sessionId = normalizeSessionId(body.sessionId)
    const { extensionId, sessionId: resolvedSessionId } = await resolveRecordingRoute({ sessionId })
    const relay = getRecordingRelay(extensionId)
    if (!relay) {
      return c.json({ success: false, error: 'Extension not connected' }, 500)
    }
    const stopParams: StopRecordingParams = resolvedSessionId ? { sessionId: resolvedSessionId } : {}
    const result = await relay.stopRecording(stopParams)
    const status = result.success ? 200 : result.error?.includes('not found') ? 404 : 500
    return c.json(result, status)
  })

  app.get('/recording/status', async (c) => {
    const sessionId = normalizeSessionId(c.req.query('sessionId'))
    const { extensionId, sessionId: resolvedSessionId } = await resolveRecordingRoute({ sessionId })
    const relay = getRecordingRelay(extensionId)
    if (!relay) {
      return c.json({ isRecording: false })
    }
    const isRecordingParams: IsRecordingParams = resolvedSessionId ? { sessionId: resolvedSessionId } : {}
    const result = await relay.isRecording(isRecordingParams)
    return c.json(result)
  })

  app.post('/recording/cancel', async (c) => {
    const body = (await c.req.json()) as { sessionId?: string | number }
    const sessionId = normalizeSessionId(body.sessionId)
    const { extensionId, sessionId: resolvedSessionId } = await resolveRecordingRoute({ sessionId })
    const relay = getRecordingRelay(extensionId)
    if (!relay) {
      return c.json({ success: false, error: 'Extension not connected' }, 500)
    }
    const cancelParams: CancelRecordingParams = resolvedSessionId ? { sessionId: resolvedSessionId } : {}
    const result = await relay.cancelRecording(cancelParams)
    return c.json(result)
  })

  // ============================================================================
  // Cloud session idle tracking
  //
  // Tracks lastActivityAt for cloud-backed sessions (those created via
  // cdpEndpoint pointing to Browser Use VMs). A background interval checks
  // every 60s and disconnects sessions idle > 10 minutes by calling the
  // website's /api/cloud/disconnect endpoint.
  // ============================================================================

  interface CloudSessionTracking {
    cloudSessionId: string
    /** Website base URL for disconnect calls */
    cloudBaseUrl: string
    /** Bearer token for website API */
    cloudToken: string
    lastActivityAt: number
    /** Number of currently running execute calls — skip idle timeout while > 0 */
    activeExecutions: number
    /** BU VM hard timeout (epoch ms) — used to warn users before expiration */
    timeoutAt?: number
  }

  const cloudSessionTracking = new Map<string, CloudSessionTracking>()
  const CLOUD_IDLE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

  /** Check if any OTHER relay session references the same cloud VM.
   *  Used to prevent stopping a VM that's still used by another relay session
   *  (e.g. user attached twice via `session new --browser cloud-1`). */
  function hasOtherCloudReferences(relaySessionId: string, cloudSessionId: string): boolean {
    for (const [otherId, tracking] of cloudSessionTracking) {
      if (otherId !== relaySessionId && tracking.cloudSessionId === cloudSessionId) {
        return true
      }
    }
    return false
  }

  /** Disconnect a cloud VM via the website API (best-effort, non-blocking). */
  function disconnectCloudVm(tracking: CloudSessionTracking): void {
    fetch(new URL('/api/cloud/disconnect', tracking.cloudBaseUrl).toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tracking.cloudToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cloudSessionId: tracking.cloudSessionId }),
    }).catch((err) => {
      logger?.error('[Cloud] Failed to disconnect cloud session:', err)
    })
  }

  // ── Cloud session crash recovery ──────────────────────────────────
  // Persist cloud session IDs to disk so orphaned VMs can be cleaned up
  // if the relay process crashes. On startup, read the file and disconnect
  // any leftover VMs (best-effort).

  const CLOUD_SESSIONS_FILE = path.join(os.homedir(), '.playwriter', 'cloud-sessions.json')

  interface PersistedCloudSession {
    cloudSessionId: string
    cloudBaseUrl: string
    cloudToken: string
  }

  function persistCloudSessions(): void {
    // Dedupe by cloudSessionId — multiple relay sessions can reference the same VM
    const seen = new Set<string>()
    const entries: PersistedCloudSession[] = []
    for (const t of cloudSessionTracking.values()) {
      if (seen.has(t.cloudSessionId)) continue
      seen.add(t.cloudSessionId)
      entries.push({
        cloudSessionId: t.cloudSessionId,
        cloudBaseUrl: t.cloudBaseUrl,
        cloudToken: t.cloudToken,
      })
    }
    try {
      const dir = path.dirname(CLOUD_SESSIONS_FILE)
      fs.mkdirSync(dir, { recursive: true })
      if (entries.length > 0) {
        // Atomic write: write to temp file then rename, so a crash mid-write
        // doesn't leave corrupt JSON that blocks future cleanup.
        const tmpFile = CLOUD_SESSIONS_FILE + '.tmp'
        fs.writeFileSync(tmpFile, JSON.stringify(entries), { encoding: 'utf-8', mode: 0o600 })
        fs.renameSync(tmpFile, CLOUD_SESSIONS_FILE)
      } else {
        // No active sessions — remove file to avoid stale data
        try { fs.unlinkSync(CLOUD_SESSIONS_FILE) } catch { /* already gone */ }
      }
    } catch {
      // Best-effort: don't crash relay if disk write fails
    }
  }

  function cleanupOrphanedCloudSessions(): void {
    let raw: string
    try {
      raw = fs.readFileSync(CLOUD_SESSIONS_FILE, 'utf-8')
    } catch {
      return // No file — nothing to clean up
    }

    let entries: PersistedCloudSession[]
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      // Validate shape: each entry must have cloudSessionId and cloudBaseUrl
      entries = parsed.filter((e): e is PersistedCloudSession => {
        return e && typeof e.cloudSessionId === 'string' && typeof e.cloudBaseUrl === 'string' && typeof e.cloudToken === 'string'
      })
    } catch {
      // Corrupt JSON (e.g. crash during non-atomic write) — just remove it
      try { fs.unlinkSync(CLOUD_SESSIONS_FILE) } catch { /* ignore */ }
      return
    }
    if (!entries.length) {
      try { fs.unlinkSync(CLOUD_SESSIONS_FILE) } catch { /* ignore */ }
      return
    }

    logger?.log(pc.yellow(`[Cloud] Found ${entries.length} orphaned cloud session(s) from previous relay. Cleaning up...`))
    // Remove file after we've read it — disconnect calls are best-effort async.
    // If they fail, the BU VM will eventually hit its own timeout anyway.
    try { fs.unlinkSync(CLOUD_SESSIONS_FILE) } catch { /* ignore */ }

    for (const entry of entries) {
      disconnectCloudVm({
        cloudSessionId: entry.cloudSessionId,
        cloudBaseUrl: entry.cloudBaseUrl,
        cloudToken: entry.cloudToken,
        lastActivityAt: 0,
        activeExecutions: 0,
      })
    }
  }

  const cloudIdleInterval = setInterval(async () => {
    const now = Date.now()
    // Collect idle sessions first, then process — avoid mutating map during iteration
    const idleSessions: Array<[string, CloudSessionTracking]> = []
    for (const [sessionId, tracking] of cloudSessionTracking) {
      // VM already past BU hard timeout — schedule for cleanup regardless of activity
      if (tracking.timeoutAt && tracking.timeoutAt <= now) {
        idleSessions.push([sessionId, tracking])
        continue
      }
      // Timeout warnings are handled by the executor on each execute() call
      // (deduped by minute bucket) — no need to enqueue from the relay interval.

      if (tracking.activeExecutions > 0) continue
      if (now - tracking.lastActivityAt > CLOUD_IDLE_TIMEOUT_MS) {
        idleSessions.push([sessionId, tracking])
      }
    }

    if (idleSessions.length > 0) {
      for (const [sessionId, tracking] of idleSessions) {
        logger?.log(
          pc.yellow(`[Cloud] Stopping idle relay session ${sessionId} (idle > 10 min)`),
        )
        // Check if other relay sessions reference the same cloud VM.
        // Only stop the VM when this is the last relay session for it.
        const shouldStopVm = !hasOtherCloudReferences(sessionId, tracking.cloudSessionId)
        cloudSessionTracking.delete(sessionId)
        executorManager?.deleteExecutor(sessionId)
        if (shouldStopVm) {
          disconnectCloudVm(tracking)
        }
      }
      persistCloudSessions()
    }
  }, 60_000)

  // Use createAdaptorServer instead of serve() so we control the listen()
  // timing. This lets us inject WebSocket upgrade handlers before binding and
  // await the bind to surface EADDRINUSE as a catchable error (issue #75).
  const server = createAdaptorServer({ fetch: app.fetch, hostname: host })
  injectWebSocket(server)

  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(port, host)
  })

  // Clean up orphaned cloud sessions from a previous relay crash.
  // Must run AFTER successful listen — if another relay is already running,
  // we'd fail with EADDRINUSE but only after killing its live VMs.
  cleanupOrphanedCloudSessions()

  const wsHost = `ws://${host}:${port}`
  const cdpEndpoint = `${wsHost}/cdp`
  const extensionEndpoint = `${wsHost}/extension`

  logger?.log('CDP relay server started')
  logger?.log('Host:', host)
  logger?.log('Port:', port)
  logger?.log('Extension endpoint:', extensionEndpoint)
  logger?.log('CDP endpoint:', cdpEndpoint)

  return {
    close() {
      const { extensions, playwrightClients } = store.getState()

      for (const client of playwrightClients.values()) {
        client.ws.close(1000, 'Server stopped')
        dropClientOrdering(client.id)
      }

      for (const ext of extensions.values()) {
        if (ext.pingInterval) {
          clearInterval(ext.pingInterval)
        }
        ext.ws?.close(1000, 'Server stopped')
      }

      // Close shared headless browser if any headless sessions were created (fire-and-forget)
      void import('./executor.js').then(({ PlaywrightExecutor }) => {
        return PlaywrightExecutor.closeSharedHeadlessBrowser()
      })

      // Reset store state
      store.setState({
        extensions: new Map(),
        playwrightClients: new Map(),
      })
      clearInterval(cloudIdleInterval)
      cloudSessionTracking.clear()
      persistCloudSessions() // Remove the file on graceful shutdown
      server.close()
      emitter.removeAllListeners()
    },
    on<K extends keyof RelayServerEvents>(event: K, listener: RelayServerEvents[K]) {
      emitter.on(event, listener as (...args: unknown[]) => void)
    },
    off<K extends keyof RelayServerEvents>(event: K, listener: RelayServerEvents[K]) {
      emitter.off(event, listener as (...args: unknown[]) => void)
    },
  }
}
