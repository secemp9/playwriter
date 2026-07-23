declare const process: { env: { PLAYWRITER_PORT: string } }
// Injected by vite at build time from playwriter/package.json version.
// CLI/MCP compare this against their own version to warn when the extension is outdated.
declare const __PLAYWRITER_VERSION__: string
// Bundled automation builds should not burn a tab on the welcome page, especially
// in headless/VPS flows where the extension is installed only to attach to the relay.
declare const __PLAYWRITER_OPEN_WELCOME_PAGE__: boolean

import dedent from 'string-dedent'
const js = dedent
import { createStore } from 'zustand/vanilla'
import type { ExtensionState, ConnectionState, TabState, TabInfo } from './types'
import {
  setTabOwner,
  deleteTabOwner,
  rehydrateTabOwners,
  getGroupIds,
  setGroupId,
  deleteGroupId,
  FREESTYLE_GROUP_KEY,
} from './workspace-groups'
import { initPlaywriterToolbar } from './toolbar/toolbar'
import type { CDPEvent, Protocol } from 'playwriter/src/cdp-types'
import type { ExtensionCommandMessage, ExtensionResponseMessage } from 'playwriter/src/protocol'
import { handleGhostBrowserCommand, type GhostBrowserCommandParams } from 'playwriter/src/ghost-browser'
// Inlined at build time via vite ?raw. Source: playwriter/src/ghost-cursor-client.ts
import ghostCursorBundleCode from '../../playwriter/dist/ghost-cursor-client.js?raw'
// Bippy: React fiber introspection library, used for "Copy React Source Path" context menu.
// Built by playwriter/scripts/build-client-bundles.ts, exposes globalThis.__bippy
import bippyBundleCode from '../../playwriter/dist/bippy.js?raw'
import {
  getActiveRecordings,
  handleStartRecording,
  handleStopRecording,
  handleIsRecording,
  handleCancelRecording,
  cleanupRecordingForTab,
} from './recording'

const RELAY_HOST = '127.0.0.1'
const RELAY_PORT = Number(process.env.PLAYWRITER_PORT) || 19988

// CDP commands that should return near-instantly on a healthy tab. If a tab is
// frozen/hibernated (e.g. Ghost Browser suspended tabs), chrome.debugger.sendCommand
// hangs forever. These commands get a 10s timeout so frozen tabs fail fast instead of
// blocking the entire Playwright connection setup for 30s per command.
// CDP commands that should return near-instantly on a healthy tab. If a tab is
// frozen/hibernated (e.g. Ghost Browser suspended tabs), chrome.debugger.sendCommand
// hangs forever. These commands get a 10s timeout so frozen tabs fail fast instead of
// blocking the entire Playwright connection setup for 30s per command.
// Note: Page.addScriptToEvaluateOnNewDocument is NOT included because user-provided
// scripts with runImmediately:true can legitimately take longer than 10s.
// Timeout for attachTab's own post-attach setup commands (Page.enable, our injected
// scripts, Target.getTargetInfo). All should be near-instant on a healthy renderer.
const ATTACH_SETUP_TIMEOUT_MS = 10000

const FAST_CDP_COMMAND_TIMEOUT_MS = new Map<string, number>([
  ['Browser.getWindowForTarget', 10000],
  ['Page.enable', 10000],
  ['Page.getFrameTree', 10000],
  ['Page.setLifecycleEventsEnabled', 10000],
  ['Page.createIsolatedWorld', 10000],
  ['Page.setDownloadBehavior', 10000],
  ['Log.enable', 10000],
  ['Network.enable', 10000],
  ['Emulation.setFocusEmulationEnabled', 10000],
  ['Emulation.setEmulatedMedia', 10000],
  ['Runtime.runIfWaitingForDebugger', 10000],
  ['Target.setAutoAttach', 10000],
])

async function sendCommandWithTimeout(
  debuggee: chrome.debugger.DebuggerSession,
  method: string,
  params: object | undefined,
  timeout: number,
): Promise<unknown> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      chrome.debugger.sendCommand(debuggee, method, params),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`CDP command timed out after ${timeout}ms: ${method} (tab may be frozen/hibernated)`))
        }, timeout)
      }),
    ])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

type NavigatorWithUaData = Navigator & {
  userAgentData?: {
    brands: Array<{ brand: string; version: string }>
    getHighEntropyValues?: (hints: string[]) => Promise<{
      fullVersionList?: Array<{ brand: string; version: string }>
    }>
  }
}

type ExtensionIdentity = {
  browser: string
  email: string
  id: string
  installId: string
  // 'storage' when installId is the persisted one; 'fallback' when storage did not answer
  // in time and the worker-lifetime scope was used. Sent as `idSrc` on the relay URL so
  // the relay log shows which path fired — observability for wedged chrome.* APIs.
  idSource: 'storage' | 'fallback'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createInstallId(): string {
  const values = new Uint32Array(2)
  crypto.getRandomValues(values)
  return Array.from(values)
    .map((value) => {
      return value.toString(36)
    })
    .join('')
}

function browserNameFromBrands(brands: Array<{ brand: string; version: string }>): string | null {
  const brandNames = brands.map((brand) => {
    return brand.brand.trim().toLowerCase()
  })

  if (brandNames.some((brand) => brand === 'brave')) return 'Brave'
  if (brandNames.some((brand) => brand === 'microsoft edge')) return 'Edge'
  if (brandNames.some((brand) => brand === 'opera')) return 'Opera'
  if (brandNames.some((brand) => brand === 'vivaldi')) return 'Vivaldi'
  if (brandNames.some((brand) => brand === 'google chrome canary')) return 'Chrome Canary'
  if (brandNames.some((brand) => brand === 'google chrome')) return 'Chrome'
  if (brandNames.some((brand) => brand === 'chromium')) return 'Chromium'
  return null
}

// Synchronous browser-name detection: property check plus UA sniff, no awaits. Used
// directly on the connect path; the async high-entropy refinement below only improves
// the label for later connects.
function browserNameSync(): string {
  if ((chrome as unknown as { ghostPublicAPI?: unknown }).ghostPublicAPI) {
    return 'Ghost'
  }
  const brands = (navigator as NavigatorWithUaData).userAgentData?.brands
  if (brands && brands.length > 0) {
    const lowEntropyName = browserNameFromBrands(brands)
    if (lowEntropyName) {
      return lowEntropyName
    }
  }
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('edg/')) return 'Edge'
  if (ua.includes('opr/')) return 'Opera'
  if (ua.includes('vivaldi')) return 'Vivaldi'
  if (ua.includes('brave')) return 'Brave'
  if (ua.includes('chrome')) return 'Chrome'
  return 'Chromium'
}

let cachedBrowserName: string | null = null
let browserNameRefineStarted = false

// Fire-and-forget refinement via the async high-entropy UA API (distinguishes e.g.
// Chrome Canary). Never awaited on the connect path.
function refineBrowserNameInBackground(): void {
  if (cachedBrowserName || browserNameRefineStarted) return
  browserNameRefineStarted = true
  const navigatorWithUaData = navigator as NavigatorWithUaData
  Promise.resolve(navigatorWithUaData.userAgentData?.getHighEntropyValues?.(['fullVersionList']))
    .then((highEntropyValues) => {
      const name = browserNameFromBrands(highEntropyValues?.fullVersionList || [])
      if (name) {
        cachedBrowserName = name
      }
    })
    .catch(() => {
      browserNameRefineStarted = false
    })
}

const tabSessionScope = (() => {
  const values = new Uint32Array(2)
  crypto.getRandomValues(values)
  return Array.from(values)
    .map((value) => {
      return value.toString(36)
    })
    .join('')
})()

let cachedInstallId: string | null = null

// Bounded installId lookup. chrome.storage.local has been observed to never settle in a
// wedged worker (Default profile, Chrome 149), so the storage read is raced against a
// short timeout. On timeout the worker-lifetime scope keeps us connectable (stable key
// for this worker, retried against storage on the next attempt); only a RESOLVED storage
// value is cached.
const INSTALL_ID_STORAGE_TIMEOUT_MS = 1500

async function getInstallId(): Promise<{ installId: string; idSource: 'storage' | 'fallback' }> {
  if (cachedInstallId) {
    return { installId: cachedInstallId, idSource: 'storage' }
  }
  try {
    const existing = await Promise.race([
      chrome.storage.local.get('playwriterInstallId'),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('storage.local.get timed out'))
        }, INSTALL_ID_STORAGE_TIMEOUT_MS)
      }),
    ])
    const storedInstallId = typeof existing.playwriterInstallId === 'string' ? existing.playwriterInstallId : ''
    if (storedInstallId) {
      cachedInstallId = storedInstallId
      return { installId: storedInstallId, idSource: 'storage' }
    }
    const installId = createInstallId()
    cachedInstallId = installId
    // Fire-and-forget persist: if this write hangs or fails, the id is still stable for
    // this worker's lifetime and the next worker will mint a new one — churn, not outage.
    void chrome.storage.local.set({ playwriterInstallId: installId }).catch(() => {})
    return { installId, idSource: 'storage' }
  } catch {
    return { installId: tabSessionScope, idSource: 'fallback' }
  }
}

// Profile info (email/id) is cosmetic metadata for the relay's browser list — it is NOT
// part of the stable connection key (that is installId). chrome.identity.getProfileUserInfo
// can hang indefinitely in some profiles, so it must never sit on the connect critical
// path: it is fetched in the background, only a RESOLVED value is cached, and each connect
// attempt uses whatever has resolved so far. A hung or failed fetch costs an empty profile
// label in `playwriter browser list`, never the connection itself.
let cachedProfile: { email: string; id: string } | null = null
let profileFetchInFlight = false

function fetchProfileInBackground(): void {
  if (cachedProfile || profileFetchInFlight) return
  profileFetchInFlight = true
  chrome.identity
    .getProfileUserInfo({ accountStatus: 'ANY' })
    .then((info) => {
      cachedProfile = { email: info.email || '', id: info.id || '' }
    })
    .catch(() => {
      // Allow a later connect attempt to retry. A HANG (never settles) intentionally does
      // not retry within this worker: one stuck call per worker lifetime, blocking nothing.
      profileFetchInFlight = false
    })
}

// The connect critical path may not perform any unbounded await on a chrome.* API: in
// the failing profile getProfileUserInfo hung forever, and after moving that call off
// the path, chrome.storage.local.get hung too. Everything here is synchronous, cached,
// or explicitly bounded; background refiners improve later connects.
async function getExtensionIdentity(): Promise<ExtensionIdentity> {
  fetchProfileInBackground()
  refineBrowserNameInBackground()
  const { installId, idSource } = await getInstallId()
  return {
    browser: cachedBrowserName ?? browserNameSync(),
    email: cachedProfile?.email || '',
    id: cachedProfile?.id || '',
    installId,
    idSource,
  }
}

// The single SHARED freestyle group (D3): every human-clicked / freestyle tab
// (workspaceKey === null) shares ONE grey group titled 'playwriter'. Grey is RESERVED
// for freestyle and is never assigned to a worktree group (invariant I6).
const FREESTYLE_GROUP_TITLE = 'playwriter'
const FREESTYLE_GROUP_COLOR: chrome.tabGroups.ColorEnum = 'grey'
// Chrome's eight non-grey tab-group colours. Each worktree group is given a deterministic,
// distinct colour chosen from this list by pickColor(); grey is deliberately excluded so a
// worktree can never look like a freestyle group (I6).
const WORKTREE_COLORS: readonly chrome.tabGroups.ColorEnum[] = [
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]

/**
 * Deterministic FNV-1a 32-bit hash of the FULL workspace key (no prefix stripping — the
 * bytes hashed are the same bytes used for identity, invariant D of Todo 22). Used only to
 * SEED the colour probe order; identity comparisons never use this.
 */
function hashKey(key: string): number {
  let h = 0x811c9dc5 // FNV offset basis
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) // FNV prime
  }
  return h >>> 0
}

/**
 * Choose a tab-group colour for a worktree key. The key's hash seeds the START of a probe
 * that walks WORKTREE_COLORS in a fixed rotated order, returning the first colour NOT already
 * used by another live worktree group (`takenColors`). Properties this guarantees:
 *   (a) determinism — for a given key and takenColors set the result is identical every call
 *       (pure function, no randomness);
 *   (b) grey is never returned — grey is not in WORKTREE_COLORS (I6);
 *   (c) N distinct concurrent keys get N distinct colours while N ≤ 8, because each newly
 *       assigned colour is added to takenColors before the next key is coloured;
 *   (d) the full key is hashed (no prefix stripping).
 * With more than 8 concurrent worktrees the eight-colour palette is exhausted and, by the
 * pigeonhole principle, a repeat is unavoidable — the key's deterministic first choice is
 * returned. That is palette exhaustion, not a fallback for a missing input.
 */
function pickColor(key: string, takenColors: Set<chrome.tabGroups.ColorEnum>): chrome.tabGroups.ColorEnum {
  const start = hashKey(key) % WORKTREE_COLORS.length
  for (let i = 0; i < WORKTREE_COLORS.length; i++) {
    const color = WORKTREE_COLORS[(start + i) % WORKTREE_COLORS.length]
    if (!takenColors.has(color)) {
      return color
    }
  }
  return WORKTREE_COLORS[start]
}

let childSessions: Map<string, { tabId: number; targetId?: string }> = new Map()
let nextSessionId = 1
let tabGroupQueue: Promise<void> = Promise.resolve()
// Cache Target.setAutoAttach params so existing and future tabs enable OOPIF target events.
// This ensures Playwright can build the iframe frame tree when connecting over CDP.
let autoAttachParams: Protocol.Target.SetAutoAttachRequest | null = null

// Buffer for recording chunks when WebSocket isn't ready.
// Chunks are keyed by tabId and flushed when WebSocket opens.
interface BufferedChunk {
  tabId: number
  data?: number[]
  final?: boolean
}
const recordingChunkBuffer: BufferedChunk[] = []

/**
 * Flush buffered recording chunks to the WebSocket.
 * Called when WebSocket becomes ready.
 */
function flushRecordingChunkBuffer(ws: WebSocket): void {
  if (recordingChunkBuffer.length === 0) {
    return
  }

  logger.debug(`Flushing ${recordingChunkBuffer.length} buffered recording chunks`)

  while (recordingChunkBuffer.length > 0) {
    const chunk = recordingChunkBuffer.shift()!
    const { tabId, data, final } = chunk

    // Send metadata message first
    ws.send(
      JSON.stringify({
        method: 'recordingData',
        params: { tabId, final },
      }),
    )

    // Then send binary data if not final
    if (data && !final) {
      const buffer = new Uint8Array(data)
      ws.send(buffer)
    }
  }
}

class ConnectionManager {
  ws: WebSocket | null = null
  private connectionPromise: Promise<void> | null = null
  // Monotonic id for connect attempts. Every await inside connect() is a suspension point
  // where the attempt may have been superseded (the global timeout fired and the maintain
  // loop started a fresh attempt while the old one was stuck). Post-await checkpoints
  // abort any attempt whose generation is no longer current, which makes "two live
  // sockets from one worker" unrepresentable — the race that made the relay replace our
  // own connection (close 4001) and strand the worker in 'extension-replaced'.
  private generation = 0
  preserveTabsOnDetach = false

  async ensureConnection(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    if (store.getState().connectionState === 'extension-replaced') {
      throw new Error('Another Playwriter extension is already connected')
    }

    // Reuse in-progress connection attempt - prevents races between user clicks and maintain loop
    if (this.connectionPromise) {
      return this.connectionPromise
    }

    // Wrap connect() with a global timeout to ensure it never hangs forever.
    // This protects against edge cases where individual timeouts don't fire
    // (e.g., DNS resolution hangs, AbortSignal doesn't work, etc.)
    const GLOBAL_TIMEOUT_MS = 15000
    const attempt = this.connect()
    // The race below may settle via the timeout while `attempt` is still pending; give the
    // abandoned promise a handler so its eventual rejection is not an unhandled rejection.
    attempt.catch(() => {})
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    this.connectionPromise = Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          // Invalidate the timed-out attempt: if its continuation ever resumes, the
          // generation checkpoints in connect() abort it before it can open a socket
          // that would replace whatever a newer attempt establishes.
          this.generation++
          reject(new Error('Connection timeout (global)'))
        }, GLOBAL_TIMEOUT_MS)
      }),
    ])

    try {
      await this.connectionPromise
    } finally {
      clearTimeout(timeoutId)
      this.connectionPromise = null
    }
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation
    const isCurrent = () => gen === this.generation
    logger.debug(`Waiting for server at http://${RELAY_HOST}:${RELAY_PORT}...`)

    // Retry for up to 5 seconds with 1s intervals, then give up (maintain loop will retry later)
    // Using fewer attempts since maintainLoop retries every 3 seconds anyway
    const maxAttempts = 5
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await fetch(`http://${RELAY_HOST}:${RELAY_PORT}`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
        logger.debug('Server is available')
        break
      } catch {
        if (attempt === maxAttempts - 1) {
          throw new Error('Server not available')
        }
        logger.debug(`Server not available, retrying... (attempt ${attempt + 1}/${maxAttempts})`)
        await sleep(1000)
      }
    }

    const identity = await getExtensionIdentity()
    if (!isCurrent()) {
      throw new Error('Connection attempt superseded')
    }
    const relayUrl = new URL(`ws://${RELAY_HOST}:${RELAY_PORT}/extension`)
    if (identity.browser) {
      relayUrl.searchParams.set('browser', identity.browser)
    }
    if (identity.email) {
      relayUrl.searchParams.set('email', identity.email)
    }
    if (identity.id) {
      relayUrl.searchParams.set('id', identity.id)
    }
    if (identity.installId) {
      relayUrl.searchParams.set('installId', identity.installId)
    }
    relayUrl.searchParams.set('idSrc', identity.idSource)
    if (typeof __PLAYWRITER_VERSION__ !== 'undefined') {
      relayUrl.searchParams.set('v', __PLAYWRITER_VERSION__)
    }
    logger.debug('Creating WebSocket connection to:', relayUrl)
    const socket = new WebSocket(relayUrl.toString())

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        logger.debug('WebSocket connection TIMEOUT after 5 seconds')
        try {
          socket.close()
        } catch {}
        reject(new Error('Connection timeout'))
      }, 5000)

      socket.onopen = () => {
        if (settled) return
        settled = true
        logger.debug('WebSocket connected')
        clearTimeout(timeout)

        // Flush any buffered recording chunks now that WebSocket is ready
        flushRecordingChunkBuffer(socket)

        resolve()
      }

      socket.onerror = (error) => {
        logger.debug('WebSocket error during connection:', error)
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error('WebSocket connection failed'))
      }

      socket.onclose = (event) => {
        logger.debug('WebSocket closed during connection:', { code: event.code, reason: event.reason })
        if (settled) return
        settled = true
        clearTimeout(timeout)
        // Normalize 4002 rejection to consistent error message for callers to detect
        if (event.code === 4002 || event.reason === 'Extension Already In Use') {
          reject(new Error('Extension Already In Use'))
        } else {
          reject(new Error(`WebSocket closed: ${event.reason || event.code}`))
        }
      }
    })

    if (!isCurrent()) {
      // A newer attempt won while we were waiting for the socket to open. Close this
      // socket before the relay treats it as a replacement for the winner's connection.
      try {
        socket.close()
      } catch {}
      throw new Error('Connection attempt superseded')
    }

    this.ws = socket

    this.ws.onmessage = async (event: MessageEvent) => {
      let message: any
      try {
        message = JSON.parse(event.data)
      } catch (error: any) {
        logger.debug('Error parsing message:', error)
        sendMessage({ error: { code: -32700, message: `Error parsing message: ${error.message}` } })
        return
      }

      // Handle ping from server - respond with pong to keep service worker alive
      if (message.method === 'ping') {
        sendMessage({ method: 'pong' })
        return
      }

      // Handle createInitialTab - create a new tab when Playwright connects and no tabs exist
      // We use skipAttachedEvent: true because the relay's Target.setAutoAttach handler will send
      // Target.attachedToTarget for all targets in connectedTargets. If we also sent it here,
      // Playwright would receive a duplicate.
      //
      // This differs from the normal flow (user clicks extension icon) where:
      // 1. Extension attaches and sends Target.attachedToTarget to existing Playwright clients
      // 2. New Playwright clients that connect later get targets via Target.setAutoAttach
      //
      // But with createInitialTab, the SAME client that triggered the create is waiting for
      // Target.setAutoAttach - so we'd send the event twice to the same client.
      if (message.method === 'createInitialTab') {
        try {
          logger.debug('Creating initial tab for Playwright client')
          const tab = await createTabInPreferredWindow({ url: 'about:blank', active: false })
          if (tab.id) {
            // The auto-created tab belongs to the workspace of the client that triggered
            // the create. The relay (Todo 14) sends that identity on the createInitialTab
            // message params; stamp it here so the tab is owned by — and visible to — that
            // workspace. (Todo 20 makes attachTab preserve this ownership onto the
            // 'connected' TabInfo and echo it back to the relay.)
            setTabConnecting(tab.id, {
              workspaceKey: message.params.workspaceKey,
              workspaceLabel: message.params.workspaceLabel,
            })
            const { targetInfo, sessionId } = await attachTab(tab.id, { skipAttachedEvent: true })
            logger.debug('Initial tab created and connected:', tab.id, 'sessionId:', sessionId)
            sendMessage({
              id: message.id,
              result: {
                success: true,
                tabId: tab.id,
                sessionId,
                targetInfo,
              },
            })
          } else {
            throw new Error('Failed to create tab - no tab ID returned')
          }
        } catch (error: any) {
          logger.debug('Failed to create initial tab:', error)
          sendMessage({ id: message.id, error: error.message })
        }
        return
      }

      // Handle recording commands
      if (message.method === 'startRecording') {
        try {
          const result = await handleStartRecording(message.params)
          sendMessage({ id: message.id, result })
        } catch (error: any) {
          logger.error('Failed to start recording:', error)
          sendMessage({ id: message.id, result: { success: false, error: error.message } })
        }
        return
      }

      if (message.method === 'stopRecording') {
        try {
          const result = await handleStopRecording(message.params)
          sendMessage({ id: message.id, result })
        } catch (error: any) {
          logger.error('Failed to stop recording:', error)
          sendMessage({ id: message.id, result: { success: false, error: error.message } })
        }
        return
      }

      if (message.method === 'isRecording') {
        try {
          const result = await handleIsRecording(message.params)
          sendMessage({ id: message.id, result })
        } catch (error: any) {
          logger.error('Failed to check recording status:', error)
          sendMessage({ id: message.id, result: { isRecording: false } })
        }
        return
      }

      if (message.method === 'cancelRecording') {
        try {
          const result = await handleCancelRecording(message.params)
          sendMessage({ id: message.id, result })
        } catch (error: any) {
          logger.error('Failed to cancel recording:', error)
          sendMessage({ id: message.id, result: { success: false, error: error.message } })
        }
        return
      }

      // Handle Ghost Browser API commands
      // This allows calling chrome.ghostPublicAPI, chrome.ghostProxies, chrome.projects
      // from the playwriter executor sandbox when running in Ghost Browser
      if (message.method === 'ghost-browser') {
        const params = message.params as GhostBrowserCommandParams
        const result = await handleGhostBrowserCommand(params, chrome)
        if (!result.success) {
          logger.error('Ghost Browser API error:', result.error)
        }
        // Auto-connect tabs created via ghostPublicAPI.openTab so they appear in context.pages()
        if (result.success && params.namespace === 'ghostPublicAPI' && params.method === 'openTab') {
          const tabId = result.result as number
          if (tabId) {
            logger.debug('Auto-connecting Ghost Browser tab:', tabId)
            // FREESTYLE (null): a tab opened via chrome.ghostPublicAPI.openTab carries no
            // agent-workspace identity — the Ghost Browser command does not thread a
            // workspace key, so there is genuinely none to stamp. Per Z6 that makes it a
            // freestyle tab (visible to no keyed workspace). This is a positive decision,
            // not a placeholder. NOTE: no todo in the plan covers ghost-browser ownership;
            // if such tabs must be visible to their requesting client, the workspace key
            // has to be threaded from the relay onto the ghost-browser command first.
            setTabConnecting(tabId, { workspaceKey: null, workspaceLabel: null })
            await sleep(100)
            await attachTab(tabId)
          }
        }
        sendMessage({ id: message.id, result })
        return
      }

      const response: ExtensionResponseMessage = { id: message.id }
      try {
        response.result = await handleCommand(message as ExtensionCommandMessage)
      } catch (error: any) {
        logger.debug('Error handling command:', error)
        response.error = error.message
      }
      // logger.debug('Sending response:', response)
      sendMessage(response)
    }

    this.ws.onclose = (event: CloseEvent) => {
      // Stale-socket guard: only the socket the manager currently owns may drive state
      // transitions. A superseded socket closing late (e.g. the relay's 4001 after a
      // same-key replacement) must not tear down or poison the live connection's state.
      if (this.ws !== socket) {
        return
      }
      this.handleClose(event.reason, event.code)
    }

    this.ws.onerror = (event: Event) => {
      logger.debug('WebSocket error:', event)
    }

    chrome.debugger.onEvent.addListener(onDebuggerEvent)
    chrome.debugger.onDetach.addListener(onDebuggerDetach)

    logger.debug('Connection established')
  }

  private handleClose(reason: string, code: number): void {
    // Log memory at disconnect time to help diagnose memory-related terminations
    try {
      // @ts-ignore - performance.memory is Chrome-specific
      const mem = performance.memory
      if (mem) {
        const formatMB = (b: number) => (b / 1024 / 1024).toFixed(2) + 'MB'
        logger.warn(
          `DISCONNECT MEMORY: used=${formatMB(mem.usedJSHeapSize)} total=${formatMB(mem.totalJSHeapSize)} limit=${formatMB(mem.jsHeapSizeLimit)}`,
        )
      }
    } catch {}
    logger.warn(`DISCONNECT: WS closed code=${code} reason=${reason || 'none'} stack=${getCallStack()}`)

    chrome.debugger.onEvent.removeListener(onDebuggerEvent)
    chrome.debugger.onDetach.removeListener(onDebuggerDetach)

    const isExtensionReplaced = reason === 'Extension Replaced' || code === 4001
    const isExtensionInUse = reason === 'Extension Already In Use' || code === 4002
    this.preserveTabsOnDetach = !(isExtensionReplaced || isExtensionInUse)

    const { tabs } = store.getState()

    for (const [tabId] of tabs) {
      chrome.debugger.detach({ tabId }).catch((err) => {
        logger.debug('Error detaching from tab:', tabId, err.message)
      })
    }

    childSessions.clear()
    this.ws = null

    // Only one extension can connect to the relay server at a time.
    // Code 4001: Another extension replaced this one (this extension was idle)
    // Code 4002: This extension tried to connect but another is actively in use
    if (isExtensionReplaced) {
      logger.debug('Disconnected: another Playwriter extension connected (this one was idle)')
      store.setState({
        tabs: new Map(),
        connectionState: 'extension-replaced',
        errorText: 'Another Playwriter extension took over the connection',
      })
      return
    }

    if (isExtensionInUse) {
      logger.debug('Rejected: another Playwriter extension is actively in use')
      store.setState({
        tabs: new Map(),
        connectionState: 'extension-replaced',
        errorText: 'Another Playwriter extension is actively in use',
      })
      return
    }

    // For normal disconnects, set tabs to 'connecting' state and let maintain loop handle reconnect
    store.setState((state) => {
      const newTabs = new Map(state.tabs)
      for (const [tabId, tab] of newTabs) {
        newTabs.set(tabId, { ...tab, state: 'connecting' })
      }
      return { tabs: newTabs, connectionState: 'idle', errorText: undefined }
    })
  }

  async maintainLoop(): Promise<void> {
    while (true) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        await sleep(1000)
        continue
      }

      // When another Playwriter extension took over, poll until no same-key replacement is
      // connected anymore. Reclaiming while another worker is merely idle is racy: a fresh
      // replacement reports activeTargets=0 before it re-attaches tabs, so the old worker can
      // steal the slot back and disconnect the live browser instance.
      if (store.getState().connectionState === 'extension-replaced') {
        try {
          const response = await fetch(`http://${RELAY_HOST}:${RELAY_PORT}/extension/status`, {
            method: 'GET',
            signal: AbortSignal.timeout(2000),
          })
          const data = (await response.json()) as { connected: boolean; activeTargets: number }
          const slotAvailable = !data.connected
          if (slotAvailable) {
            store.setState({ connectionState: 'idle', errorText: undefined })
            logger.debug(
              'Extension slot is free (connected:',
              data.connected,
              'activeTargets:',
              data.activeTargets,
              '), cleared error state',
            )
          } else {
            logger.debug('Extension slot still taken (activeTargets:', data.activeTargets, '), will retry...')
          }
        } catch {
          logger.debug('Server not available, will retry...')
        }
        await sleep(3000)
        continue
      }

      // Ensure tabs are in 'connecting' state when WS is not connected
      // This handles edge cases where handleClose wasn't called or state got out of sync
      const currentTabs = store.getState().tabs
      const hasConnectedTabs = Array.from(currentTabs.values()).some((t) => t.state === 'connected')
      if (hasConnectedTabs) {
        store.setState((state) => {
          const newTabs = new Map(state.tabs)
          for (const [tabId, tab] of newTabs) {
            if (tab.state === 'connected') {
              newTabs.set(tabId, { ...tab, state: 'connecting' })
            }
          }
          return { tabs: newTabs }
        })
      }

      // Try to connect silently in background - don't show 'connecting' badge
      // Individual tab states will show 'connecting' when user explicitly clicks
      try {
        await this.ensureConnection()
        store.setState({ connectionState: 'connected' })

        // Re-attach any tabs that were in 'connecting' state (from a previous disconnect)
        const tabsToReattach = Array.from(store.getState().tabs.entries())
          .filter(([_, tab]) => tab.state === 'connecting')
          .map(([tabId]) => tabId)

        for (const tabId of tabsToReattach) {
          // Re-check state before attaching - might have been attached by user click
          const currentTab = store.getState().tabs.get(tabId)
          if (!currentTab || currentTab.state !== 'connecting') {
            logger.debug('Skipping reattach, tab state changed:', tabId, currentTab?.state)
            continue
          }

          try {
            await chrome.tabs.get(tabId)
            await attachTab(tabId)
            logger.debug('Successfully re-attached tab:', tabId)
          } catch (error: any) {
            logger.debug('Failed to re-attach tab:', tabId, error.message)
            store.setState((state) => {
              const newTabs = new Map(state.tabs)
              newTabs.delete(tabId)
              return { tabs: newTabs }
            })
          }
        }
        this.preserveTabsOnDetach = false
      } catch (error: any) {
        logger.debug('Connection attempt failed:', error.message)
        // Check if rejected because another extension is actively in use
        if (error.message === 'Extension Already In Use') {
          store.setState({
            connectionState: 'extension-replaced',
            errorText: 'Another Playwriter extension is actively in use',
          })
        } else {
          store.setState({ connectionState: 'idle' })
        }
      }

      await sleep(3000)
    }
  }
}

export const connectionManager = new ConnectionManager()

export const store = createStore<ExtensionState>(() => ({
  tabs: new Map(),
  connectionState: 'idle',
  currentTabId: undefined,
  preferredWindowId: undefined,
  errorText: undefined,
}))

// @ts-ignore
globalThis.toggleExtensionForActiveTab = toggleExtensionForActiveTab
// @ts-ignore
globalThis.disconnectEverything = disconnectEverything
// @ts-ignore
globalThis.getExtensionState = () => store.getState()

declare global {
  var toggleExtensionForActiveTab: (
    workspaceKey: string | null,
    workspaceLabel: string | null,
  ) => Promise<{ isConnected: boolean; state: ExtensionState }>
  var getExtensionState: () => ExtensionState
  var disconnectEverything: () => Promise<void>
}

const MAX_LOG_STRING_LENGTH = 2000

function truncateLogString(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) {
    return value
  }
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}…[truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`
}

function safeSerialize(arg: any): string {
  if (arg === undefined) return 'undefined'
  if (arg === null) return 'null'
  if (typeof arg === 'function') return `[Function: ${arg.name || 'anonymous'}]`
  if (typeof arg === 'symbol') return String(arg)
  if (typeof arg === 'string') return truncateLogString(arg)
  if (arg instanceof Error) return truncateLogString(arg.stack || arg.message || String(arg))
  if (typeof arg === 'object') {
    try {
      const seen = new WeakSet()
      const serialized = JSON.stringify(arg, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]'
          seen.add(value)
          if (value instanceof Map) return { dataType: 'Map', value: Array.from(value.entries()) }
          if (value instanceof Set) return { dataType: 'Set', value: Array.from(value.values()) }
        }
        return value
      })
      return truncateLogString(serialized)
    } catch {
      return truncateLogString(String(arg))
    }
  }
  return truncateLogString(String(arg))
}

function sendLog(level: string, args: any[]) {
  sendMessage({
    method: 'log',
    params: { level, args: args.map(safeSerialize) },
  })
}

export const logger = {
  log: (...args: any[]) => {
    console.log(...args)
    sendLog('log', args)
  },
  debug: (...args: any[]) => {
    console.debug(...args)
    sendLog('debug', args)
  },
  info: (...args: any[]) => {
    console.info(...args)
    sendLog('info', args)
  },
  warn: (...args: any[]) => {
    console.warn(...args)
    sendLog('warn', args)
  },
  error: (...args: any[]) => {
    console.error(...args)
    sendLog('error', args)
  },
}

function getCallStack(): string {
  const stack = new Error().stack || ''
  return stack.split('\n').slice(2, 6).join(' <- ').replace(/\s+/g, ' ')
}

self.addEventListener('error', (event) => {
  const error = event.error
  const stack = error?.stack || `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`
  logger.error('Uncaught error:', stack)
})

self.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const stack = reason?.stack || String(reason)
  logger.error('Unhandled promise rejection:', stack)
})

let messageCount = 0
export function sendMessage(message: any): void {
  if (connectionManager.ws?.readyState === WebSocket.OPEN) {
    try {
      connectionManager.ws.send(JSON.stringify(message))
      // Check memory periodically (every ~100 messages)
      if (++messageCount % 100 === 0) {
        checkMemory()
      }
    } catch (error: any) {
      console.debug('ERROR sending message:', error, 'message type:', message.method || 'response')
    }
  }
}

async function getPreferredWindowId(): Promise<number | undefined> {
  const { preferredWindowId, currentTabId } = store.getState()
  if (preferredWindowId !== undefined) {
    try {
      await chrome.windows.get(preferredWindowId)
      return preferredWindowId
    } catch {
      store.setState({ preferredWindowId: undefined })
    }
  }

  if (currentTabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(currentTabId)
      if (tab.windowId !== undefined) {
        return tab.windowId
      }
    } catch {}
  }

  try {
    const focusedWindow = await chrome.windows.getLastFocused({ populate: false })
    return focusedWindow.id
  } catch {
    return undefined
  }
}

async function createTabInPreferredWindow(options: { url: string; active: boolean }): Promise<chrome.tabs.Tab> {
  const windowId = await getPreferredWindowId()
  const createProperties: chrome.tabs.CreateProperties = {
    url: options.url,
    active: options.active,
    ...(windowId !== undefined ? { windowId } : {}),
  }

  try {
    return await chrome.tabs.create(createProperties)
  } catch (error) {
    logger.debug('Could not create tab in preferred window, falling back:', (error as Error).message)
    return await chrome.tabs.create({ url: options.url, active: options.active })
  }
}

/**
 * Resolve a persisted tab-group id to its live group, or undefined when the group no longer
 * exists. chrome.tabGroups.get throws for an unknown id; a throw here means the group was
 * closed (group ids are unique within a browser session and vanish when a group empties or
 * the browser restarts). This is a documented Chrome state we handle by RECREATING the group,
 * never by falling back to a shared/global group.
 */
async function getGroupOrUndefined(groupId: number): Promise<chrome.tabGroups.TabGroup | undefined> {
  try {
    return await chrome.tabGroups.get(groupId)
  } catch {
    return undefined
  }
}

/**
 * Reconcile Chrome tab groups with the current ownership in `store.tabs`. Each workspace key
 * owns its own group (identity from workspace-groups.ts's persisted `groupIds` map, NEVER a
 * title query — invariant I5); freestyle tabs (workspaceKey === null) all share the single
 * grey FREESTYLE_GROUP_KEY group (D3). Two sessions in the same worktree share one group
 * because they share one key.
 *
 * LOOP-GUARD NOTE (do not weaken): this function is the densest edge-case logic in the file.
 * Its protection against the ungroup→disconnect / group-change→event→re-sync feedback loop
 * rests on three facts, none of which this function may break:
 *   1. It is only ever scheduled on the single serialized `tabGroupQueue` chain (see the
 *      store.subscribe below and disconnectEverything), so it never runs concurrently with
 *      the chrome.tabs.onUpdated group handler or with itself.
 *   2. It NEVER calls store.setState — it only reads store.getState(). So the programmatic
 *      grouping/ungrouping it performs cannot trigger the store.subscribe that (re)schedules
 *      it. There is no path from this function back into itself except the queue.
 *   3. 'connecting' tabs are grouped only while the relay is connected; the onUpdated handler
 *      ignores group-removal events for 'connecting' tabs. Together these stop a tab that is
 *      mid-attach from being ungrouped-then-disconnected.
 */
async function syncTabGroups(): Promise<void> {
  try {
    // Include 'connecting' tabs in a group only when the relay is alive, so that tabs the
    // user drags into a group stay visible while attaching. When the relay is dead all tabs
    // are 'connecting' (waiting for reconnect) and their groups should be cleaned up. The
    // chrome.tabs.onUpdated handler (registered near the bottom of this file) already guards
    // against the ungroup→disconnect loop for 'connecting' tabs, so excluding them here is
    // safe.
    const { connectionState } = store.getState()
    const isRelayConnected = connectionState === 'connected'

    // Partition connected tabs by their owning workspace key. Freestyle tabs
    // (workspaceKey === null) all fall into the single shared FREESTYLE_GROUP_KEY bucket (D3);
    // every worktree key gets its own bucket. Each bucket carries the label used to title its
    // group — null for the freestyle bucket (which uses FREESTYLE_GROUP_TITLE), and, by the
    // TabInfo invariant (workspaceLabel non-null iff workspaceKey non-null), non-null for
    // every worktree bucket.
    const buckets = new Map<string, { tabIds: number[]; label: string | null }>()
    for (const [tabId, info] of store.getState().tabs.entries()) {
      const isConnected =
        info.state === 'connected' || (info.state === 'connecting' && isRelayConnected)
      if (!isConnected) continue
      const bucketKey = info.workspaceKey === null ? FREESTYLE_GROUP_KEY : info.workspaceKey
      const existing = buckets.get(bucketKey)
      if (existing) {
        existing.tabIds.push(tabId)
      } else {
        buckets.set(bucketKey, { tabIds: [tabId], label: info.workspaceLabel })
      }
    }

    const groupIds = await getGroupIds()

    // --- Phase 1: clean up groups whose bucket went empty. For every persisted key that has
    // no connected tabs now, ungroup ONLY that key's own group and forget its map entry.
    // Never touch another key's group (per-key isolation).
    for (const [key, groupId] of Object.entries(groupIds)) {
      if (buckets.has(key)) continue
      const group = await getGroupOrUndefined(groupId)
      if (group !== undefined) {
        const tabsInGroup = await chrome.tabs.query({ groupId })
        const idsToUngroup = tabsInGroup.map((t) => t.id).filter((id): id is number => id !== undefined)
        if (idsToUngroup.length > 0) {
          await chrome.tabs.ungroup(idsToUngroup)
        }
      }
      await deleteGroupId(key)
      logger.debug('Cleared empty workspace group:', key, groupId)
    }

    // --- Phase 2: resolve each live bucket's group id against the persisted map, validating
    // the mapped id with chrome.tabGroups.get. A stale/absent id resolves to null → a fresh
    // group is created in Phase 3. A live worktree group's current colour is recorded so a
    // newly created worktree group can avoid it (distinct concurrent worktrees look distinct).
    const resolved = new Map<string, { groupId: number; color: chrome.tabGroups.ColorEnum } | null>()
    const takenColors = new Set<chrome.tabGroups.ColorEnum>()
    for (const key of buckets.keys()) {
      const mappedId = groupIds[key]
      if (mappedId === undefined) {
        resolved.set(key, null)
        continue
      }
      const group = await getGroupOrUndefined(mappedId)
      if (group === undefined) {
        resolved.set(key, null)
        continue
      }
      resolved.set(key, { groupId: mappedId, color: group.color })
      if (key !== FREESTYLE_GROUP_KEY) {
        takenColors.add(group.color)
      }
    }

    // --- Phase 3: reconcile each live bucket against its own group, creating one if needed.
    for (const [key, bucket] of buckets.entries()) {
      const isFreestyle = key === FREESTYLE_GROUP_KEY
      let title: string
      if (isFreestyle) {
        title = FREESTYLE_GROUP_TITLE
      } else {
        if (bucket.label === null) {
          // The TabInfo invariant guarantees a non-null label for a keyed tab; a null here is
          // a real upstream bug, not a state to paper over with a default (no fallback).
          throw new Error(
            `Worktree group '${key}' has a null workspaceLabel — the ownership invariant ` +
              `(workspaceLabel non-null whenever workspaceKey is non-null) is violated`,
          )
        }
        title = bucket.label.slice(0, 20)
      }

      const existing = resolved.get(key) ?? null

      if (existing === null) {
        // No live group for this key — create one and record its id in the identity map.
        const color = isFreestyle ? FREESTYLE_GROUP_COLOR : pickColor(key, takenColors)
        if (!isFreestyle) {
          takenColors.add(color)
        }
        const newGroupId = await chrome.tabs.group({ tabIds: bucket.tabIds })
        await setGroupId(key, newGroupId)
        await chrome.tabGroups.update(newGroupId, { title, color })
        logger.debug('Created workspace group:', key, newGroupId, color, 'tabs:', bucket.tabIds)
      } else {
        // A live group already exists for this key. Keep its colour STABLE (Chrome can reset
        // title/colour on collapse/expand or tab moves, so we re-apply the exact colour we
        // read back — never re-pick, which would make an existing group flip colours).
        const groupId = existing.groupId
        const color = isFreestyle ? FREESTYLE_GROUP_COLOR : existing.color
        const tabsInGroup = await chrome.tabs.query({ groupId })
        const idsInGroup = new Set(
          tabsInGroup.map((t) => t.id).filter((id): id is number => id !== undefined),
        )
        const toAdd = bucket.tabIds.filter((id) => !idsInGroup.has(id))
        const toRemove = Array.from(idsInGroup).filter((id) => !bucket.tabIds.includes(id))

        if (toRemove.length > 0) {
          try {
            await chrome.tabs.ungroup(toRemove)
            logger.debug('Removed tabs from group:', key, toRemove)
          } catch (e: any) {
            logger.debug('Failed to ungroup tabs:', toRemove, e.message)
          }
        }
        if (toAdd.length > 0) {
          await chrome.tabs.group({ tabIds: toAdd, groupId })
          logger.debug('Added tabs to group:', key, toAdd)
        }
        await chrome.tabGroups.update(groupId, { title, color })
      }
    }
  } catch (error: any) {
    logger.debug('Failed to sync tab groups:', error.message)
  }
}

export function getTabBySessionId(sessionId: string): { tabId: number; tab: TabInfo } | undefined {
  for (const [tabId, tab] of store.getState().tabs) {
    if (tab.sessionId === sessionId) {
      return { tabId, tab }
    }
  }
  return undefined
}

function getTabByTargetId(targetId: string): { tabId: number; tab: TabInfo } | undefined {
  for (const [tabId, tab] of store.getState().tabs) {
    if (tab.targetId === targetId) {
      return { tabId, tab }
    }
  }
  return undefined
}

function emitChildDetachesForTab(tabId: number): void {
  const childEntries = Array.from(childSessions.entries()).filter(([_, parentTab]) => parentTab.tabId === tabId)

  childEntries.forEach(([childSessionId, parentTab]) => {
    const childDetachParams: Protocol.Target.DetachedFromTargetEvent = parentTab.targetId
      ? { sessionId: childSessionId, targetId: parentTab.targetId }
      : { sessionId: childSessionId }
    sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: childDetachParams,
      },
    })
    logger.debug('Cleaning up child session:', childSessionId, 'for tab:', tabId)
    childSessions.delete(childSessionId)
  })
}

// Resolve which tab a CDP command targets by checking sessionId sources in priority order:
// 1. Top-level sessionId (the CDP session the command was sent on)
// 2. params.sessionId (e.g. Target.detachFromTarget on the root session, see #40)
// 3. params.targetId (e.g. Target.closeTarget)
function getTabForCommand(msg: ExtensionCommandMessage): { tabId: number; tab: TabInfo } | undefined {
  const sessionId = msg.params.sessionId
  if (sessionId) {
    const found = getTabBySessionId(sessionId)
    if (found) {
      return found
    }
    const child = childSessions.get(sessionId)
    if (child) {
      const tab = store.getState().tabs.get(child.tabId)
      if (tab) {
        return { tabId: child.tabId, tab }
      }
    }
  }

  const paramsSessionId =
    msg.params.params && 'sessionId' in msg.params.params && typeof msg.params.params.sessionId === 'string'
      ? msg.params.params.sessionId
      : undefined
  if (paramsSessionId) {
    const found = getTabBySessionId(paramsSessionId)
    if (found) {
      return found
    }
    const child = childSessions.get(paramsSessionId)
    if (child) {
      const tab = store.getState().tabs.get(child.tabId)
      if (tab) {
        return { tabId: child.tabId, tab }
      }
    }
  }

  const targetId =
    msg.params.params && 'targetId' in msg.params.params && typeof msg.params.params.targetId === 'string'
      ? msg.params.params.targetId
      : undefined
  if (targetId) {
    return getTabByTargetId(targetId)
  }

  return undefined
}

async function handleCommand(msg: ExtensionCommandMessage): Promise<any> {
  if (msg.method !== 'forwardCDPCommand') return

  const resolved = getTabForCommand(msg)
  let targetTabId = resolved?.tabId
  let targetTab = resolved?.tab

  const debuggee = targetTabId ? { tabId: targetTabId } : undefined

  // Root-level Target.setAutoAttach must apply to all connected tabs since
  // CDP auto-attach is per-debugger-session. Without this, OOPIF targets never attach.
  if (msg.params.method === 'Target.setAutoAttach' && !msg.params.sessionId) {
    const params = msg.params.params as Protocol.Target.SetAutoAttachRequest | undefined
    if (!params) {
      return {}
    }

    autoAttachParams = params
    const connectedTabIds = Array.from(store.getState().tabs.entries())
      .filter(([_, info]) => info.state === 'connected')
      .map(([tabId]) => tabId)

    await Promise.all(
      connectedTabIds.map(async (tabId) => {
        try {
          await sendCommandWithTimeout({ tabId }, 'Target.setAutoAttach', params, 10000)
        } catch (error) {
          logger.debug('Failed to set auto-attach for tab:', tabId, error)
        }
      }),
    )

    return {}
  }

  // TODO disable network things?
  // if (msg.params.method === 'Network.enable' && msg.params.source !== 'playwriter') {
  //   logger.debug('Skipping Network.enable from non-playwriter CDP client:', msg.params.sessionId)
  //   return {}
  // }

  switch (msg.params.method) {
    case 'Runtime.enable': {
      if (!debuggee) {
        throw new Error(`No debuggee found for Runtime.enable (sessionId: ${msg.params.sessionId})`)
      }
      // Keep Runtime.enable bound to the incoming child sessionId for OOPIF iframes.
      // If we send Runtime.enable on the tab root session, child iframe targets never
      // emit Runtime.executionContextCreated and frame locators can hang.
      const runtimeSession: chrome.debugger.DebuggerSession = {
        ...debuggee,
        sessionId: msg.params.sessionId !== targetTab?.sessionId ? msg.params.sessionId : undefined,
      }
      // When multiple Playwright clients connect to the same tab, each calls Runtime.enable.
      // If Runtime is already enabled, the enable call succeeds but Chrome doesn't re-send
      // Runtime.executionContextCreated events - those were already sent to the first client.
      // By disabling first, we force Chrome to re-send all execution context events when we
      // re-enable, ensuring the new client receives them. The relay server waits for the
      // executionContextCreated events before returning. See cdp-timing.md for details.
      try {
        await sendCommandWithTimeout(runtimeSession, 'Runtime.disable', undefined, 10000)
        await sleep(50)
      } catch (e) {
        logger.debug('Error disabling Runtime (ignoring):', e)
      }
      return await sendCommandWithTimeout(runtimeSession, 'Runtime.enable', msg.params.params, 10000)
    }

    case 'Target.createTarget': {
      const url = msg.params.params?.url || 'about:blank'
      logger.debug('Creating new tab with URL:', url)
      const tab = await createTabInPreferredWindow({ url, active: false })
      if (!tab.id) throw new Error('Failed to create tab')
      // Target.createTarget is context.newPage(): the new tab belongs to the workspace of
      // the client that requested it, so that client — and only it — can see the page.
      // The relay injects that identity onto the forwarded command (Todo 20, Job B). A
      // missing (undefined) key means the relay never injected it (older/misconfigured
      // relay): fail loudly rather than silently mis-own the tab. null is a real value
      // (the requester is freestyle/keyless in a disconnect race) — never default to it.
      const { workspaceKey, workspaceLabel } = msg.params
      if (workspaceKey === undefined || workspaceLabel === undefined) {
        throw new Error(
          'Target.createTarget received no workspace ownership from the relay; the relay must ' +
            'inject workspaceKey/workspaceLabel (Todo 20). Refusing to create an unowned tab.',
        )
      }
      setTabConnecting(tab.id, { workspaceKey, workspaceLabel })
      logger.debug('Created tab:', tab.id, 'waiting for it to load...')
      await sleep(100)
      const { targetInfo } = await attachTab(tab.id)
      return { targetId: targetInfo.targetId } satisfies Protocol.Target.CreateTargetResponse
    }

    case 'Target.closeTarget': {
      if (!targetTabId) {
        logger.log(`Target not found: ${msg.params.params?.targetId}`)
        return { success: false } satisfies Protocol.Target.CloseTargetResponse
      }
      await chrome.tabs.remove(targetTabId)
      return { success: true } satisfies Protocol.Target.CloseTargetResponse
    }
  }

  if (!debuggee || !targetTab) {
    // Target.detachFromTarget is best-effort — no-op if the session is already gone (#40).
    if (msg.params.method === 'Target.detachFromTarget') {
      return {}
    }

    throw new Error(
      `No tab found for method ${msg.params.method} sessionId: ${msg.params.sessionId} params: ${JSON.stringify(msg.params.params || null)}`,
    )
  }

  logger.debug('CDP command:', msg.params.method, 'for tab:', targetTabId)

  const debuggerSession: chrome.debugger.DebuggerSession = {
    ...debuggee,
    sessionId: msg.params.sessionId !== targetTab.sessionId ? msg.params.sessionId : undefined,
  }

  const timeout = FAST_CDP_COMMAND_TIMEOUT_MS.get(msg.params.method)
  if (timeout) {
    return await sendCommandWithTimeout(debuggerSession, msg.params.method, msg.params.params, timeout)
  }
  return await chrome.debugger.sendCommand(debuggerSession, msg.params.method, msg.params.params)
}

// CDP events dropped before sending over WebSocket to the relay.
// Only events no Playwright API depends on. The relay also filters these server-side
// for backwards compatibility with old extensions.
// NOTE: *ExtraInfo events feed Playwright's ResponseExtraInfoTracker (request/response.allHeaders()).
// webSocketFrame* events feed page.on('websocket'). Both must be forwarded.
// See: https://github.com/remorses/playwriter/issues/96
const DROPPED_CDP_EVENTS = new Set([
  'Network.dataReceived',
  'Network.resourceChangedPriority',
])

function onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
  if (DROPPED_CDP_EVENTS.has(method)) {
    return
  }

  const tab = source.tabId ? store.getState().tabs.get(source.tabId) : undefined
  if (!tab) return

  logger.debug('Forwarding CDP event:', method, 'from tab:', source.tabId)

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    const targetUrl = params.targetInfo?.url as string | undefined
    // Filter out restricted child targets (other extensions' chrome-extension:// iframes,
    // chrome:// pages, devtools://, etc). Without this, Chrome's debugger API throws
    // "Cannot access a chrome-extension:// URL of a different extension" when the relay
    // tries to send commands (e.g. Runtime.runIfWaitingForDebugger) to these targets,
    // crashing the entire debugger session. See: https://github.com/remorses/playwriter/issues/18
    if (isRestrictedUrl(targetUrl)) {
      logger.debug(
        'Ignoring restricted child target:',
        targetUrl,
        'sessionId:',
        params.sessionId,
        'for tab:',
        source.tabId,
      )
      // Detach from the restricted child target to clean up. This command is sent on
      // the parent tab's debugger session (not the child), so it won't trigger the
      // restricted URL error.
      if (source.tabId) {
        chrome.debugger
          .sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: params.sessionId })
          .catch((e) => {
            logger.debug('Failed to detach restricted child target (expected):', e)
          })
      }
      return
    }

    logger.debug('Child target attached:', params.sessionId, 'for tab:', source.tabId)
    const targetId = params.targetInfo?.targetId as string | undefined
    childSessions.set(params.sessionId, { tabId: source.tabId!, targetId })
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    const mainTab = getTabBySessionId(params.sessionId)
    if (mainTab) {
      logger.debug('Main tab detached via CDP event:', mainTab.tabId, 'sessionId:', params.sessionId)
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        newTabs.delete(mainTab.tabId)
        return { tabs: newTabs }
      })
      emitChildDetachesForTab(mainTab.tabId)
    } else {
      logger.debug('Child target detached:', params.sessionId)
      childSessions.delete(params.sessionId)
    }
  }

  sendMessage({
    method: 'forwardCDPEvent',
    params: {
      sessionId: source.sessionId || tab.sessionId,
      method,
      params,
      // Echo the owning workspace key for every event this tab forwards (Todo 20, Job A).
      // The relay only consumes it on Target.attachedToTarget, where it stamps the target's
      // ownership — including child/OOPIF targets, which belong to their parent tab's
      // workspace (`tab` here is the parent, resolved from source.tabId). Without this, an
      // owned tab's cross-origin iframe target would be stamped freestyle and its live
      // events would reach nobody. null = freestyle.
      workspaceKey: tab.workspaceKey,
    },
  })
}

function onDebuggerDetach(source: chrome.debugger.Debuggee, reason: `${chrome.debugger.DetachReason}`): void {
  const tabId = source.tabId
  if (!tabId || !store.getState().tabs.has(tabId)) {
    logger.debug('Ignoring debugger detach event for untracked tab:', tabId)
    return
  }

  if (connectionManager.preserveTabsOnDetach) {
    logger.debug('Ignoring debugger detach during relay reconnect:', tabId, reason)
    return
  }

  logger.warn(`DISCONNECT: onDebuggerDetach tabId=${tabId} reason=${reason}`)

  const detachTabFromPlaywright = (detachedTabId: number, tab: TabInfo) => {
    sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: tab.sessionId, targetId: tab.targetId },
      },
    })
    emitChildDetachesForTab(detachedTabId)
  }

  if (reason === chrome.debugger.DetachReason.CANCELED_BY_USER) {
    // Chrome's debugger info bar cancellation detaches every debugger session
    // in this extension process. Clear every tracked tab so Playwright does not
    // keep sending commands to tabs Chrome already detached from.
    for (const [detachedTabId, tab] of store.getState().tabs.entries()) {
      detachTabFromPlaywright(detachedTabId, tab)
    }

    store.setState({ tabs: new Map(), connectionState: 'idle', errorText: undefined })
    return
  }

  const tab = store.getState().tabs.get(tabId)
  if (tab) {
    detachTabFromPlaywright(tabId, tab)
  }

  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    newTabs.delete(tabId)
    return { tabs: newTabs }
  })
}

type AttachTabResult = {
  targetInfo: Protocol.Target.TargetInfo
  sessionId: string
}

// Remove chrome-extension:// iframes from the page DOM before attaching the debugger.
// Chrome's chrome.debugger.attach API refuses to attach to tabs that contain frames from
// other extensions ("Cannot access a chrome-extension:// URL of different extension").
// Extensions like LastPass, SurfingKeys, etc. inject chrome-extension:// iframes into every
// page, breaking debugger attachment. This function temporarily removes them so the debugger
// can attach. The iframes stay removed while the debugger is active — they're typically
// re-injected by the owning extension on next page load.
// See: https://github.com/remorses/playwriter/issues/18
async function removeRestrictedIframes(tabId: number): Promise<number> {
  try {
    const results = await chrome.scripting.executeScript({
      // allFrames: true ensures we also scan same-origin subframes, not just the top document.
      target: { tabId, allFrames: true },
      func: (ownExtIds: string[]) => {
        // Traverse both the document and any open shadow roots, since some extensions
        // inject their chrome-extension:// iframes inside shadow DOM.
        const roots: ParentNode[] = [document]
        const elements = document.querySelectorAll('*')
        elements.forEach((el) => {
          const shadow = (el as HTMLElement).shadowRoot
          if (shadow) {
            roots.push(shadow)
          }
        })

        let removed = 0
        for (const root of roots) {
          root.querySelectorAll('iframe').forEach((iframe) => {
            const src = iframe.src || iframe.getAttribute('src') || ''
            if (!src.startsWith('chrome-extension://')) {
              return
            }
            const extId = src.replace('chrome-extension://', '').split('/')[0]
            if (ownExtIds.includes(extId)) {
              return
            }
            iframe.remove()
            removed++
          })
        }
        return removed
      },
      args: [OUR_EXTENSION_IDS],
    })
    const totalRemoved = results.reduce((sum, r) => sum + (r.result ?? 0), 0)
    if (totalRemoved > 0) {
      logger.debug(`Removed ${totalRemoved} restricted chrome-extension:// iframe(s) from tab:`, tabId)
    }
    return totalRemoved
  } catch (e) {
    // Scripting may fail on restricted pages (chrome://, about:, etc.) — that's fine,
    // those pages won't have extension iframes anyway.
    logger.debug('Could not remove restricted iframes (expected on some pages):', (e as Error).message)
    return 0
  }
}

async function attachTab(
  tabId: number,
  { skipAttachedEvent = false }: { skipAttachedEvent?: boolean } = {},
): Promise<AttachTabResult> {
  const debuggee = { tabId }
  let debuggerAttached = false

  try {
    logger.debug('Attaching debugger to tab:', tabId)

    // Bounded retry loop: chrome.debugger.attach fails if the tab contains chrome-extension://
    // iframes from other extensions. We remove them and retry, but aggressive extensions can
    // re-inject between cleanup and retry, so we allow up to 3 attempts.
    const maxAttachAttempts = 3
    for (let attempt = 1; attempt <= maxAttachAttempts; attempt++) {
      try {
        await chrome.debugger.attach(debuggee, '1.3')
        break
      } catch (attachError: any) {
        const msg = attachError.message ?? ''
        const isRestrictedIframeError = msg.includes('chrome-extension://') || msg.includes('different extension')
        if (!isRestrictedIframeError || attempt === maxAttachAttempts) {
          throw attachError
        }
        logger.debug(
          `Debugger attach blocked by chrome-extension:// iframe (attempt ${attempt}/${maxAttachAttempts}), removing and retrying:`,
          tabId,
        )
        await removeRestrictedIframes(tabId)
        await sleep(50)
      }
    }

    debuggerAttached = true
    logger.debug('Debugger attached successfully to tab:', tabId)

    // Evidence + anti-freeze: a discarded/frozen renderer accepts the debugger attach but
    // never answers renderer-side DevTools commands — the documented hang that
    // sendCommandWithTimeout exists for. Log the tab's lifecycle state so the relay log
    // shows WHY a setup command timed out, and pin the tab against Memory-Saver
    // auto-discard while it is under automation.
    // Fire-and-forget: this is evidence and a nice-to-have pin, and tabs.get itself hangs
    // when the worker's API pipeline wedges — it must never block the setup sequence.
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        logger.debug(
          'attach: tab lifecycle', tabId,
          'status:', tab.status,
          'discarded:', tab.discarded,
          'frozen:', (tab as { frozen?: boolean }).frozen,
          'active:', tab.active,
        )
        if (tab.autoDiscardable) {
          void chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {})
        }
      })
      .catch(() => {})

    // Every setup command below should return near-instantly on a healthy renderer, so
    // all of them are bounded: a tab whose renderer never answers must fail ITS attach in
    // seconds — not hang attachTab forever, strand the relay's awaiting createInitialTab,
    // and take the whole connection down with it. (The addScriptToEvaluateOnNewDocument
    // exemption in FAST_CDP_COMMAND_TIMEOUT_MS is about USER-provided scripts routed
    // through handleCommand; these are our own tiny bundles.)
    const setupCommand = (method: string, params?: object): Promise<unknown> => {
      logger.debug(`attach step: ${method} tab:`, tabId)
      return sendCommandWithTimeout(debuggee, method, params, ATTACH_SETUP_TIMEOUT_MS)
    }

    await setupCommand('Page.enable')

    // Reapply cached auto-attach for new tabs so OOPIF targets are reported immediately.
    if (autoAttachParams) {
      try {
        await setupCommand('Target.setAutoAttach', autoAttachParams)
      } catch (error) {
        logger.debug('Failed to apply auto-attach for tab:', tabId, error)
      }
    }

    const contextMenuScript = js`
      document.addEventListener('contextmenu', (e) => {
        window.__playwriter_lastRightClicked = e.target;
      }, true);
    `
    await setupCommand('Page.addScriptToEvaluateOnNewDocument', { source: contextMenuScript })
    await setupCommand('Runtime.evaluate', { expression: contextMenuScript })

    // Ghost cursor — survives navigations via addScriptToEvaluateOnNewDocument.
    try {
      await setupCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: ghostCursorBundleCode,
      })
      await setupCommand('Runtime.evaluate', { expression: ghostCursorBundleCode })
    } catch (err) {
      logger.debug('Could not inject ghost cursor (restricted page):', (err as Error).message)
    }

    const result = (await setupCommand('Target.getTargetInfo')) as Protocol.Target.GetTargetInfoResponse

    const targetInfo = result.targetInfo

    // Log error if URL is empty - this causes Playwright to create broken pages
    if (!targetInfo.url || targetInfo.url === '' || targetInfo.url === ':') {
      logger.error(
        'WARNING: Target.attachedToTarget will be sent with empty URL! tabId:',
        tabId,
        'targetInfo:',
        JSON.stringify(targetInfo),
      )
    }

    const attachOrder = nextSessionId
    const sessionId = `pw-tab-${tabSessionScope}-${nextSessionId++}`

    // Ownership (I2) was stamped by setTabConnecting BEFORE attachTab ran — every caller
    // sets the tab to 'connecting' with its owner first: createInitialTab and
    // Target.createTarget (real key from the relay), connectTab (its own params), and the
    // maintainLoop re-attach (which preserves ownership via `{ ...tab, state:'connecting' }`).
    // Preserve that owner onto the 'connected' TabInfo — never re-derive or default it. If
    // there is no prior TabInfo, the tab was never marked connecting: that is a bug, so fail
    // loudly (a defaulted owner would silently mis-own the tab).
    const owner = store.getState().tabs.get(tabId)
    if (!owner) {
      throw new Error(
        `attachTab: tab ${tabId} has no TabInfo to inherit ownership from; ` +
          `setTabConnecting must run before attachTab`,
      )
    }
    const { workspaceKey, workspaceLabel } = owner

    store.setState((state) => {
      const newTabs = new Map(state.tabs)
      newTabs.set(tabId, {
        sessionId,
        targetId: targetInfo.targetId,
        state: 'connected',
        attachOrder,
        workspaceKey,
        workspaceLabel,
      })
      return { tabs: newTabs, connectionState: 'connected', errorText: undefined }
    })

    if (!skipAttachedEvent) {
      sendMessage({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          // Echo the owning workspace key so the relay stamps ConnectedTarget.workspaceKey
          // (Todo 20, Job A) instead of null. Without this, live target-scoped events
          // (Todo 17) reach nobody for this extension-attached tab. Field name is
          // `workspaceKey` on both ends — a `workspace` mismatch fails silently. null =
          // freestyle (human icon-click), visible to no workspace.
          workspaceKey,
          params: {
            sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })
    }

    logger.debug(
      'Tab attached successfully:',
      tabId,
      'sessionId:',
      sessionId,
      'targetId:',
      targetInfo.targetId,
      'url:',
      targetInfo.url,
      'skipAttachedEvent:',
      skipAttachedEvent,
    )

    // Inject the in-page toolbar into the MAIN world (best-effort: silently
    // fails on restricted pages like chrome:// or about:blank)
    chrome.scripting
      .executeScript({
        target: { tabId, allFrames: false },
        world: 'MAIN',
        func: initPlaywriterToolbar,
      })
      .catch((err: Error) => {
        logger.debug('Could not inject toolbar (restricted page):', err.message)
      })

    return { targetInfo, sessionId }
  } catch (error) {
    // Clean up debugger if we attached but failed later
    if (debuggerAttached) {
      logger.debug('Cleaning up debugger after partial attach failure:', tabId)
      chrome.debugger.detach(debuggee).catch(() => {})
    }
    throw error
  }
}

function detachTab(tabId: number, shouldDetachDebugger: boolean): void {
  const tab = store.getState().tabs.get(tabId)
  if (!tab) {
    logger.debug('detachTab: tab not found in map:', tabId)
    return
  }

  // Clean up any active recording for this tab
  cleanupRecordingForTab(tabId)

  // Destroy the in-page toolbar (best-effort: tab may already be closing or navigating)
  void chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        ;(window as any).__playwriterToolbarDestroy?.()
      },
    })
    .catch(() => {})

  void chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        ;(globalThis as any).__playwriterGhostCursor?.disable?.()
      },
    })
    .catch(() => {})

  logger.warn(`DISCONNECT: detachTab tabId=${tabId} shouldDetach=${shouldDetachDebugger} stack=${getCallStack()}`)

  // Only send detach event if tab was fully attached (has sessionId/targetId)
  // Tabs in 'connecting' state may not have these yet
  if (tab.sessionId && tab.targetId) {
    sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: tab.sessionId, targetId: tab.targetId },
      },
    })
  }

  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    newTabs.delete(tabId)
    return { tabs: newTabs }
  })

  emitChildDetachesForTab(tabId)

  if (shouldDetachDebugger) {
    chrome.debugger.detach({ tabId }).catch((err) => {
      logger.debug('Error detaching debugger from tab:', tabId, err.message)
    })
  }
}

async function connectTab(
  tabId: number,
  { workspaceKey, workspaceLabel }: { workspaceKey: string | null; workspaceLabel: string | null },
): Promise<void> {
  try {
    logger.debug(`Starting connection to tab ${tabId}`)

    setTabConnecting(tabId, { workspaceKey, workspaceLabel })

    await connectionManager.ensureConnection()
    await attachTab(tabId)

    logger.debug(`Successfully connected to tab ${tabId}`)
  } catch (error: any) {
    logger.debug(`Failed to connect to tab ${tabId}:`, error)

    // Distinguish between WS connection errors and tab-specific errors
    // WS errors: keep in 'connecting' state, maintainLoop will retry when WS is available
    // Tab errors: show 'error' state (e.g., restricted page, debugger attach failed)
    // Extension in use: set global 'extension-replaced' state to enter polling mode
    const isExtensionInUse =
      error.message === 'Extension Already In Use' ||
      error.message === 'Another Playwriter extension is already connected'

    const isWsError =
      error.message === 'Server not available' ||
      error.message === 'Connection timeout' ||
      error.message.startsWith('WebSocket')

    if (isExtensionInUse) {
      logger.debug(`Another extension is in use, entering polling mode`)
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        newTabs.delete(tabId)
        return {
          tabs: newTabs,
          connectionState: 'extension-replaced',
          errorText: 'Another Playwriter extension is actively in use',
        }
      })
    } else if (isWsError) {
      logger.debug(`WS connection failed, keeping tab ${tabId} in connecting state for retry`)
      // Tab stays in 'connecting' state - maintainLoop will retry when WS becomes available
    } else {
      // If the tab was closed mid-attach, don't write an error entry —
      // onTabRemoved already deleted it and we'd leak a dead tabId.
      let tabStillExists = true
      try {
        await chrome.tabs.get(tabId)
      } catch {
        tabStillExists = false
      }
      if (!tabStillExists) {
        logger.debug(`Tab ${tabId} was closed during connect, dropping error state`)
        store.setState((state) => {
          const newTabs = new Map(state.tabs)
          newTabs.delete(tabId)
          return { tabs: newTabs }
        })
        return
      }
      if (!store.getState().tabs.has(tabId)) {
        logger.debug(`Tab ${tabId} was detached during connect, dropping error state`)
        return
      }
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        // Stamp the ownership this connect was invoked with (I2): an errored tab still
        // belongs to whatever workspace asked for it (null = freestyle human click).
        newTabs.set(tabId, { state: 'error', errorText: `Error: ${error.message}`, workspaceKey, workspaceLabel })
        return { tabs: newTabs }
      })
    }
  }
}

function setTabConnecting(
  tabId: number,
  { workspaceKey, workspaceLabel }: { workspaceKey: string | null; workspaceLabel: string | null },
): void {
  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    const existing = newTabs.get(tabId)
    // The caller always knows the owning workspace (I2): a real key for a
    // programmatic/agent tab, or null for a freestyle (human icon-click) tab. Stamp it
    // explicitly — this also completes the TabInfo for a brand-new tab, where `existing`
    // is undefined and the spread alone would leave workspaceKey/workspaceLabel missing.
    // Never inherit `existing?.workspaceKey`: the caller is the authority (Todo 9's
    // "no merge" rule), and a re-click must be able to re-stamp the owner.
    newTabs.set(tabId, { ...existing, state: 'connecting', workspaceKey, workspaceLabel })
    return { tabs: newTabs }
  })
  // Persist ownership so it survives a service-worker restart (Todo 21). This is the single
  // chokepoint every attach path funnels through (createInitialTab, Target.createTarget,
  // connectTab, ghost-browser), so persisting here captures every owned/freestyle tab.
  // Fire-and-forget: the store update above is the source of truth for the live SW; the
  // storage write only needs to win before the SW dies, and it is serialized internally.
  void setTabOwner(tabId, { workspaceKey, workspaceLabel }).catch((error) => {
    logger.debug('Failed to persist tab owner:', tabId, error)
  })
}

async function disconnectTab(tabId: number): Promise<void> {
  logger.debug(`Disconnecting tab ${tabId}`)

  const { tabs } = store.getState()
  if (!tabs.has(tabId)) {
    logger.debug('Tab not in tabs map, ignoring disconnect')
    return
  }

  detachTab(tabId, true)
  // Drop the persisted ownership (Todo 21) so a DELIBERATELY disconnected tab does not
  // rehydrate and silently re-attach on the next SW restart. disconnectTab is the single
  // chokepoint for every intentional disconnect — onTabRemoved (the plan's named sync
  // point), a manual drag out of the group, disconnectEverything, and the icon-click
  // toggle all route through here. A transient WS loss does NOT: handleClose keeps tabs in
  // 'connecting' and never calls disconnectTab, so their owners correctly stay persisted.
  void deleteTabOwner(tabId).catch((error) => {
    logger.debug('Failed to delete persisted tab owner:', tabId, error)
  })
  // WS connection is maintained even with no tabs - maintainConnection handles it
}

async function toggleExtensionForActiveTab(
  workspaceKey: string | null,
  workspaceLabel: string | null,
): Promise<{ isConnected: boolean; state: ExtensionState }> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab?.id) throw new Error('No active tab found')

  // Programmatic (agent/test) toggle — the twin of the human icon click, but keyed: the
  // caller passes its OWN workspace so the tab is owned by and visible to that workspace.
  // A caller that genuinely wants a freestyle tab passes (null, null) explicitly. This is
  // why toggleExtensionForActiveTab does NOT route through onActionClicked, which is
  // permanently freestyle (Z6).
  await applyActionForTab(tab, workspaceKey, workspaceLabel)

  await new Promise<void>((resolve) => {
    const check = () => {
      const state = store.getState()
      const tabInfo = state.tabs.get(tab.id!)
      if (tabInfo?.state === 'connecting') {
        setTimeout(check, 100)
        return
      }
      resolve()
    }
    check()
  })

  const state = store.getState()
  const isConnected = state.tabs.has(tab.id) && state.tabs.get(tab.id)?.state === 'connected'
  return { isConnected, state }
}

async function disconnectEverything(): Promise<void> {
  // Queue disconnect operation to serialize with other tab group operations
  tabGroupQueue = tabGroupQueue.then(async () => {
    const { tabs } = store.getState()
    for (const tabId of tabs.keys()) {
      await disconnectTab(tabId)
    }
  })
  await tabGroupQueue
  // WS connection is maintained - maintainConnection handles it
}

async function resetDebugger(): Promise<void> {
  let targets = await chrome.debugger.getTargets()
  targets = targets.filter((x) => x.tabId && x.attached)
  logger.log(`found ${targets.length} existing debugger targets. detaching them before background script starts`)
  for (const target of targets) {
    await chrome.debugger.detach({ tabId: target.tabId })
  }
}

// Our extension IDs - allow attaching to our own extension pages for debugging
const OUR_EXTENSION_IDS = [
  'jfeammnjpkecdekppnclgkkffahnhfhe', // Production extension (Chrome Web Store)
  'pebbngnfojnignonigcnkdilknapkgid', // Dev extension (stable ID from manifest key)
]

// undefined URL is for about:blank pages (not restricted) and chrome:// URLs (restricted).
// We can't distinguish them without the `tabs` permission, so we just let attachment fail.
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false

  // Allow our own extension pages, block all other extensions
  if (url.startsWith('chrome-extension://')) {
    const extensionId = url.replace('chrome-extension://', '').split('/')[0]
    return !OUR_EXTENSION_IDS.includes(extensionId)
  }

  const restrictedPrefixes = [
    'chrome://',
    'devtools://',
    'edge://',
    'https://chrome.google.com/',
    'https://chromewebstore.google.com/',
  ]
  return restrictedPrefixes.some((prefix) => url.startsWith(prefix))
}

const icons = {
  connected: {
    path: {
      '16': '/icons/icon-green-16.png',
      '32': '/icons/icon-green-32.png',
      '48': '/icons/icon-green-48.png',
      '128': '/icons/icon-green-128.png',
    },
    title: 'Connected - Click to disconnect',
    badgeText: '',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  connecting: {
    path: {
      '16': '/icons/icon-gray-16.png',
      '32': '/icons/icon-gray-32.png',
      '48': '/icons/icon-gray-48.png',
      '128': '/icons/icon-gray-128.png',
    },
    title: 'Waiting for MCP WS server...',
    badgeText: '...',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  idle: {
    path: {
      '16': '/icons/icon-black-16.png',
      '32': '/icons/icon-black-32.png',
      '48': '/icons/icon-black-48.png',
      '128': '/icons/icon-black-128.png',
    },
    title: 'Click to attach debugger',
    badgeText: '',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  restricted: {
    path: {
      '16': '/icons/icon-gray-16.png',
      '32': '/icons/icon-gray-32.png',
      '48': '/icons/icon-gray-48.png',
      '128': '/icons/icon-gray-128.png',
    },
    title: 'Cannot attach to this page',
    badgeText: '',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  extensionReplaced: {
    path: {
      '16': '/icons/icon-gray-16.png',
      '32': '/icons/icon-gray-32.png',
      '48': '/icons/icon-gray-48.png',
      '128': '/icons/icon-gray-128.png',
    },
    title: 'Another Playwriter extension connected - Click to retry',
    badgeText: '!',
    badgeColor: [220, 38, 38, 255] as [number, number, number, number],
  },
  tabError: {
    path: {
      '16': '/icons/icon-gray-16.png',
      '32': '/icons/icon-gray-32.png',
      '48': '/icons/icon-gray-48.png',
      '128': '/icons/icon-gray-128.png',
    },
    title: 'Error',
    badgeText: '!',
    badgeColor: [220, 38, 38, 255] as [number, number, number, number],
  },
} as const

async function updateIcons(): Promise<void> {
  const state = store.getState()
  const { connectionState, tabs, errorText } = state

  const connectedCount = Array.from(tabs.values()).filter((t) => t.state === 'connected').length

  const allTabs = await chrome.tabs.query({})
  const tabUrlMap = new Map(allTabs.map((tab) => [tab.id, tab.url]))
  const allTabIds = [undefined, ...allTabs.map((tab) => tab.id).filter((id): id is number => id !== undefined)]

  for (const tabId of allTabIds) {
    const tabInfo = tabId !== undefined ? tabs.get(tabId) : undefined
    const tabUrl = tabId !== undefined ? tabUrlMap.get(tabId) : undefined

    const iconConfig = (() => {
      if (connectionState === 'extension-replaced') return icons.extensionReplaced
      if (tabId !== undefined && isRestrictedUrl(tabUrl)) return icons.restricted
      if (tabInfo?.state === 'error') return icons.tabError
      if (tabInfo?.state === 'connecting') return icons.connecting
      if (tabInfo?.state === 'connected') return icons.connected
      return icons.idle
    })()

    const title = (() => {
      if (connectionState === 'extension-replaced' && errorText) return errorText
      if (tabInfo?.errorText) return tabInfo.errorText
      return iconConfig.title
    })()

    const badgeText = (() => {
      if (iconConfig === icons.connected || iconConfig === icons.idle || iconConfig === icons.restricted) {
        return connectedCount > 0 ? String(connectedCount) : ''
      }
      return iconConfig.badgeText
    })()

    void chrome.action.setIcon({ tabId, path: iconConfig.path })
    void chrome.action.setTitle({ tabId, title })
    if (iconConfig.badgeColor) void chrome.action.setBadgeBackgroundColor({ tabId, color: iconConfig.badgeColor })
    void chrome.action.setBadgeText({ tabId, text: badgeText })
  }
}

async function onTabRemoved(tabId: number): Promise<void> {
  popupSourceTabMap.delete(tabId)
  const { tabs } = store.getState()
  if (!tabs.has(tabId)) return
  logger.debug(`Connected tab ${tabId} was closed, disconnecting`)
  await disconnectTab(tabId)
}

async function onTabActivated(activeInfo: chrome.tabs.TabActiveInfo): Promise<void> {
  store.setState({ currentTabId: activeInfo.tabId, preferredWindowId: activeInfo.windowId })
}

// Shared connect/disconnect toggle for a tab. workspaceKey/workspaceLabel are the
// ownership to stamp when the tab (re)connects (I2): a real key = programmatic/agent tab
// (owned by, and visible to, that workspace); null = freestyle (visible to no workspace,
// ever — Z6). The two entry points differ ONLY in what they pass here: onActionClicked
// (human icon click) hardcodes (null, null); toggleExtensionForActiveTab (agent/test)
// passes its caller's real key.
async function applyActionForTab(
  tab: chrome.tabs.Tab,
  workspaceKey: string | null,
  workspaceLabel: string | null,
): Promise<void> {
  if (!tab.id) {
    logger.debug('No tab ID available')
    return
  }

  if (tab.windowId !== undefined) {
    store.setState({ currentTabId: tab.id, preferredWindowId: tab.windowId })
  }

  if (isRestrictedUrl(tab.url)) {
    logger.debug('Cannot attach to restricted URL:', tab.url)
    return
  }

  const { tabs, connectionState } = store.getState()
  const tabInfo = tabs.get(tab.id)

  // If another Playwriter extension took over, clear error state and try to reconnect this tab
  if (connectionState === 'extension-replaced') {
    logger.debug('Clearing extension-replaced state, attempting to reconnect')
    store.setState({ connectionState: 'idle', errorText: undefined })
    await connectTab(tab.id, { workspaceKey, workspaceLabel })
    return
  }

  if (tabInfo?.state === 'error') {
    logger.debug('Tab has error - disconnecting to clear state')
    await disconnectTab(tab.id)
    return
  }

  if (tabInfo?.state === 'connecting') {
    logger.debug('Tab is already connecting, ignoring click')
    return
  }

  if (tabInfo?.state === 'connected') {
    await disconnectTab(tab.id)
  } else {
    await connectTab(tab.id, { workspaceKey, workspaceLabel })
  }
}

// The human clicking the extension icon. ALWAYS freestyle, permanently (Z6): a clicked
// tab carries no workspace key (null, null), so it is visible to no agent workspace,
// ever. This is the ONE place null is the intended, correct value — never a placeholder,
// never a shortcut. If this ever passed a real key, clicked tabs would become claimable
// and Z6 would be violated at its most visible point.
async function onActionClicked(tab: chrome.tabs.Tab): Promise<void> {
  await applyActionForTab(tab, null, null)
}

// Startup sequence (Todo 21): resetDebugger force-detaches stale debugger targets, THEN we
// rehydrate persisted tab ownership from chrome.storage.session, THEN the reconnect loop
// starts. Order is load-bearing: rehydration must run AFTER resetDebugger (which just tore
// down any leftover debugger attachments) and BEFORE maintainLoop, so maintainLoop's
// existing re-attach path (which reads each tab's owner off its 'connecting' TabInfo)
// restores rehydrated tabs with ownership intact. Rehydrated tabs are marked 'connecting',
// never 'connected': their debugger is detached, so 'connected' would be a lying state
// machine. maintainLoop always starts (finally), even if rehydration hiccups.
// Wake source of last resort. MV3 kills the service worker whenever Chrome deems it
// idle; the relay's WebSocket pings extend its life only best-effort (observed on
// Chrome 149: workers terminated ~2.5min after connect despite 5s pings). A dead worker
// has no maintainLoop, so without an external wake the extension silently vanishes from
// the relay until some user event in this profile fires. The periodic alarm bounds that
// outage at ~30s: waking the worker re-runs module evaluation, which restarts
// maintainLoop, which reconnects. The listener body is intentionally empty — being woken
// IS the work.
const RECONNECT_ALARM = 'playwriter-reconnect'
void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => {})

// Worker heartbeat. The service worker's console is not observable from outside the
// browser, and this worker has been repeatedly terminated mid-work; the heartbeat gives
// the relay log (a) a timestamped record of how long each worker instance actually
// lives, and (b) whether the chrome.* API pipeline still answers (bounded probe — this
// same pipeline has been observed to stop settling calls). The completed API call also
// resets the idle timer, belt-and-suspenders alongside the relay's WS pings.
const workerStartedAt = Date.now()
setInterval(() => {
  const uptimeS = Math.round((Date.now() - workerStartedAt) / 1000)
  void Promise.race([
    chrome.runtime.getPlatformInfo(),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('probe timeout'))
      }, 2000)
    }),
  ]).then(
    () => {
      logger.debug(`heartbeat: worker up ${uptimeS}s, chrome api ok`)
    },
    () => {
      logger.warn(`heartbeat: worker up ${uptimeS}s, chrome.* API pipeline NOT answering`)
    },
  )
}, 15000)

// Warm the profile cache now (fire-and-forget) so a healthy profile's email has usually
// resolved by the time the first connect attempt reads it. Never awaited anywhere.
fetchProfileInBackground()
void (async () => {
  try {
    await resetDebugger()
    const survivors = await rehydrateTabOwners()
    if (survivors.size > 0) {
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        for (const [tabId, owner] of survivors) {
          // Never clobber a tab a live path already re-added in the meantime.
          if (newTabs.has(tabId)) continue
          newTabs.set(tabId, {
            state: 'connecting',
            workspaceKey: owner.workspaceKey,
            workspaceLabel: owner.workspaceLabel,
          })
        }
        return { tabs: newTabs }
      })
      logger.log(`Rehydrated ${survivors.size} tab(s) from chrome.storage.session`)
    }
  } catch (error) {
    logger.warn('Startup tab-ownership rehydration failed:', error)
  } finally {
    connectionManager.maintainLoop()
  }
})()

chrome.contextMenus
  .remove('playwriter-pin-element')
  .catch(() => {})
  .finally(() => {
    chrome.contextMenus?.create({
      id: 'playwriter-pin-element',
      title: 'Copy Playwriter Element Reference',
      contexts: ['all'],
      visible: false,
    })
  })

chrome.contextMenus
  .remove('playwriter-copy-react-source')
  .catch(() => {})
  .finally(() => {
    chrome.contextMenus?.create({
      id: 'playwriter-copy-react-source',
      title: 'Copy React Component Source Path',
      contexts: ['all'],
      visible: false,
    })
  })

function updateContextMenuVisibility(): void {
  const { currentTabId, tabs } = store.getState()
  const isConnected = currentTabId !== undefined && tabs.get(currentTabId)?.state === 'connected'
  chrome.contextMenus?.update('playwriter-pin-element', { visible: isConnected })
  chrome.contextMenus?.update('playwriter-copy-react-source', { visible: isConnected })
}

function buildPinnedElementInspectionCode(options: { pinName: string; url: string }): string {
  const URL_LIT = JSON.stringify(options.url).replace(/'/g, '\\u0027')
  return `inspectPinnedElement(${URL_LIT},"globalThis.${options.pinName}")`
}

chrome.runtime.onInstalled.addListener((details) => {
  if (import.meta.env.TESTING) return
  if (!__PLAYWRITER_OPEN_WELCOME_PAGE__) return
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: 'src/welcome.html' })
  }
})

function serializeTabs(tabs: Map<number, TabInfo>): string {
  return JSON.stringify(Array.from(tabs.entries()))
}

store.subscribe((state, prevState) => {
  logger.log(state)
  void updateIcons()
  updateContextMenuVisibility()
  const tabsChanged = serializeTabs(state.tabs) !== serializeTabs(prevState.tabs)
  if (tabsChanged) {
    tabGroupQueue = tabGroupQueue.then(syncTabGroups).catch((e) => {
      logger.debug('syncTabGroups error:', e)
    })
  }
})

logger.debug(`Using relay host: ${RELAY_HOST}, port: ${RELAY_PORT}`)

// Memory monitoring - helps debug service worker termination issues
let lastMemoryUsage = 0
let lastMemoryCheck = Date.now()
const MEMORY_WARNING_THRESHOLD = 50 * 1024 * 1024 // 50MB
const MEMORY_CRITICAL_THRESHOLD = 100 * 1024 * 1024 // 100MB
const MEMORY_GROWTH_THRESHOLD = 10 * 1024 * 1024 // 10MB growth per interval is suspicious

function checkMemory(): void {
  try {
    // @ts-ignore - performance.memory is Chrome-specific and not in TS types
    const memory = performance.memory
    if (!memory) {
      return
    }

    const used = memory.usedJSHeapSize
    const total = memory.totalJSHeapSize
    const limit = memory.jsHeapSizeLimit
    const now = Date.now()
    const timeDelta = now - lastMemoryCheck
    const memoryDelta = used - lastMemoryUsage

    const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + 'MB'
    const growthRate = timeDelta > 0 ? (memoryDelta / timeDelta) * 1000 : 0 // bytes per second

    // Log if memory is high or growing rapidly
    if (used > MEMORY_CRITICAL_THRESHOLD) {
      logger.error(
        `MEMORY CRITICAL: used=${formatMB(used)} total=${formatMB(total)} limit=${formatMB(limit)} growth=${formatMB(memoryDelta)} rate=${formatMB(growthRate)}/s`,
      )
    } else if (used > MEMORY_WARNING_THRESHOLD) {
      logger.warn(
        `MEMORY WARNING: used=${formatMB(used)} total=${formatMB(total)} limit=${formatMB(limit)} growth=${formatMB(memoryDelta)} rate=${formatMB(growthRate)}/s`,
      )
    } else if (memoryDelta > MEMORY_GROWTH_THRESHOLD && timeDelta < 60000) {
      logger.warn(
        `MEMORY SPIKE: grew ${formatMB(memoryDelta)} in ${(timeDelta / 1000).toFixed(1)}s (used=${formatMB(used)})`,
      )
    }

    lastMemoryUsage = used
    lastMemoryCheck = now
  } catch (e) {
    // Silently ignore - performance.memory may not be available
  }
}

// Check memory every 5 seconds
setInterval(checkMemory, 5000)

// Initial memory check
checkMemory()

chrome.tabs.onRemoved.addListener(onTabRemoved)
chrome.tabs.onActivated.addListener(onTabActivated)
chrome.action.onClicked.addListener(onActionClicked)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void updateIcons()
  if (changeInfo.groupId !== undefined) {
    // Narrowed to `number` here; captured so the (deferred) async callback below keeps the
    // narrowing — TypeScript drops the outer narrowing across the closure boundary.
    const changedGroupId = changeInfo.groupId
    // Queue tab group operations to serialize with syncTabGroups and disconnectEverything
    tabGroupQueue = tabGroupQueue
      .then(async () => {
        // Recognise playwriter groups by IDENTITY, never by title (invariant I5): reverse-look
        // up the changed group id in workspace-groups.ts's persisted `groupIds` map. A HIT means
        // the tab landed in one of OUR groups (any worktree group OR the single shared freestyle
        // group); a MISS means it left them — ungrouped (id -1), or moved to a group that is not
        // ours. This supersedes the old chrome.tabGroups.query({title}) lookup, which only ever
        // recognised the freestyle group and so misclassified worktree-group events.
        //
        // This reverse lookup is what closes the residual worktree-thrash edge Todo 22
        // documented: when syncTabGroups first groups an already-'connected' worktree tab, it
        // awaits setGroupId(key, newGroupId) BEFORE returning, and this handler is chained AFTER
        // syncTabGroups on the single serialized tabGroupQueue, so the map already contains that
        // group id by the time this runs. The event therefore lands in the benign added-branch
        // (tab already tracked → no-op) instead of falling through to disconnectTab.
        const groupIds = await getGroupIds()
        const isPlaywriterGroup = Object.values(groupIds).includes(changedGroupId)
        const { tabs } = store.getState()
        if (isPlaywriterGroup) {
          if (!tabs.has(tabId) && !isRestrictedUrl(tab.url)) {
            logger.debug('Tab manually added to playwriter group:', tabId)
            // A human dragged this UNTRACKED tab into a playwriter group by hand — same
            // semantics as clicking the extension icon: freestyle (null), owned by no agent
            // workspace. There is NO claiming, even when the tab is dropped into a WORKTREE
            // group (Z6). A tab that syncTabGroups grouped is already tracked, so this branch
            // no-ops for it — only genuine human drags of new tabs reach connectTab here.
            await connectTab(tabId, { workspaceKey: null, workspaceLabel: null })
          }
        } else if (tabs.has(tabId)) {
          const tabInfo = tabs.get(tabId)
          if (tabInfo?.state === 'connecting') {
            logger.debug('Tab removed from group while connecting, ignoring:', tabId)
            return
          }
          logger.debug('Tab manually removed from playwriter group:', tabId)
          await disconnectTab(tabId)
        }
      })
      .catch((e) => {
        logger.debug('onTabUpdated handler error:', e)
      })
  }
})

// Track every new tab's source (opener) tab via webNavigation.
// chrome.tabs.Tab.openerTabId is unreliable for window.open popups — on
// Chromium 145 it is left null. onCreatedNavigationTarget gives a reliable
// source_tab_id → new_tab_id mapping for every window.open / target=_blank
// / cmd+click. Entries expire after 10s to cap memory for plain-new-tab
// cases that never trigger windows.onCreated.
const popupSourceTabMap = new Map<number, number>()

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  popupSourceTabMap.set(details.tabId, details.sourceTabId)
  setTimeout(() => {
    popupSourceTabMap.delete(details.tabId)
  }, 10000)
})

// Relocate popup windows opened by a Playwriter-connected tab into the
// source tab's window as a regular tab, since Playwriter cannot attach
// its debugger to separate popup windows. When the source tab is NOT
// connected, leave the popup alone so unrelated sites keep normal Chrome
// popup behavior. After relocation, auto-attach Playwriter to the new
// tab so it appears in context.pages().
chrome.windows.onCreated.addListener(async (popupWindow) => {
  if (popupWindow.type !== 'popup' || popupWindow.id === undefined) {
    return
  }
  try {
    // Retry tab discovery — windows.onCreated can fire before
    // chrome.tabs.query({ windowId }) sees the new popup tab.
    let popupTabs: chrome.tabs.Tab[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      popupTabs = await chrome.tabs.query({ windowId: popupWindow.id })
      if (popupTabs.length > 0) break
      await sleep(20)
    }
    const tabIds = popupTabs
      .map((t) => t.id)
      .filter((id): id is number => {
        return id !== undefined
      })
    if (tabIds.length === 0) {
      logger.debug(`Popup window ${popupWindow.id} has no tabs after retry, skipping`)
      return
    }

    const { tabs: connectedTabs } = store.getState()
    let sourceTabId: number | undefined
    // A relocated popup inherits the workspace of the tab that opened it: the opener is a
    // Playwriter-connected tab, so its TabInfo carries the real owning workspace, and the
    // popup belongs to that same workspace (window.open from a keyed page must stay
    // visible to that page's agent). Captured here alongside sourceTabId; the null-init is
    // never used as-is because we return early when sourceTabId stays undefined.
    let sourceWorkspaceKey: string | null = null
    let sourceWorkspaceLabel: string | null = null
    for (const tabId of tabIds) {
      const candidate = popupSourceTabMap.get(tabId)
      const candidateOwner = candidate !== undefined ? connectedTabs.get(candidate) : undefined
      if (candidateOwner !== undefined) {
        sourceTabId = candidate
        sourceWorkspaceKey = candidateOwner.workspaceKey
        sourceWorkspaceLabel = candidateOwner.workspaceLabel
        break
      }
    }
    for (const tabId of tabIds) {
      popupSourceTabMap.delete(tabId)
    }
    if (sourceTabId === undefined) {
      logger.debug(
        `Popup window ${popupWindow.id} not opened by a Playwriter-connected tab, leaving alone (tabs=${JSON.stringify(tabIds)})`,
      )
      return
    }

    let destinationWindowId: number
    try {
      const sourceTab = await chrome.tabs.get(sourceTabId)
      if (sourceTab.windowId === undefined) {
        const focused = await chrome.windows.getLastFocused({ populate: false })
        if (focused.id === undefined || focused.id === popupWindow.id) {
          return
        }
        destinationWindowId = focused.id
      } else {
        destinationWindowId = sourceTab.windowId
      }
    } catch (e) {
      logger.debug(`Source tab ${sourceTabId} no longer exists, skipping relocation:`, e)
      return
    }

    logger.debug(
      `Relocating ${tabIds.length} popup tab(s) from window ${popupWindow.id} into source window ${destinationWindowId} (sourceTabId=${sourceTabId})`,
    )
    await chrome.tabs.move(tabIds, { windowId: destinationWindowId, index: -1 })
    try {
      await chrome.windows.remove(popupWindow.id)
    } catch {
      // Chrome may have already closed the empty popup window.
    }
    for (const tabId of tabIds) {
      if (connectedTabs.has(tabId)) continue
      try {
        await connectTab(tabId, { workspaceKey: sourceWorkspaceKey, workspaceLabel: sourceWorkspaceLabel })
      } catch (e) {
        logger.warn(`Failed to auto-connect relocated popup tab ${tabId}:`, e)
      }
    }
  } catch (e) {
    logger.warn('Failed to relocate popup window:', e)
  }
})

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return

  const tabInfo = store.getState().tabs.get(tab.id)
  if (!tabInfo || tabInfo.state !== 'connected') {
    logger.debug('Tab not connected, ignoring')
    return
  }

  const debuggee = { tabId: tab.id }

  if (info.menuItemId === 'playwriter-pin-element') {
    try {
      // Allocate the next pin name by reading and incrementing the shared MAIN-world
      // counter (window.__playwriterPinCount). This ensures right-click and toolbar
      // pins never produce conflicting globalThis.playwriterPinnedElemN names.
      const jsAllocatePin = js`
        (function() {
          window.__playwriterPinCount = (window.__playwriterPinCount || 0) + 1;
          return window.__playwriterPinCount;
        })()
      `
      const counterResult = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsAllocatePin,
        returnByValue: true,
      })) as { result?: { value?: number }; exceptionDetails?: { text: string } }

      const count = counterResult.result?.value ?? 1
      const name = `playwriterPinnedElem${count}`

      const jsAssignPin = js`
        if (window.__playwriter_lastRightClicked) {
          window.${name} = window.__playwriter_lastRightClicked;
          '${name}';
        } else {
          throw new Error('No element was right-clicked');
        }
      `
      const result = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsAssignPin,
        returnByValue: true,
      })) as { result?: { value?: string }; exceptionDetails?: { text: string } }

      if (result.exceptionDetails) {
        logger.error('Failed to pin element:', result.exceptionDetails.text)
        return
      }

      const code = buildPinnedElementInspectionCode({ pinName: name, url: tab.url || '' })
      const clipboardText = "playwriter -e '" + code + "'"

      const jsPinFlashAndCopy = js`
        (() => {
          const el = window.${name};
          if (!el) return;
          const orig = el.getAttribute('style') || '';
          el.setAttribute('style', orig + '; outline: 3px solid #22c55e !important; outline-offset: 2px !important; box-shadow: 0 0 0 3px #22c55e !important;');
          setTimeout(() => el.setAttribute('style', orig), 300);
          return navigator.clipboard.writeText(${JSON.stringify(clipboardText)});
        })()
      `
      await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsPinFlashAndCopy,
        awaitPromise: true,
        userGesture: true,
      })

      logger.debug('Pinned element as:', name)
    } catch (error: any) {
      logger.error('Failed to pin element:', error.message)
    }
  }

  if (info.menuItemId === 'playwriter-copy-react-source') {
    try {
      // Inject bippy (React fiber introspection) if not already present.
      // bippy exposes globalThis.__bippy with methods to walk the React fiber tree
      // and resolve source file locations from React DevTools metadata.
      const hasBippy = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: '!!globalThis.__bippy',
        returnByValue: true,
      })) as { result?: { value?: boolean } }

      if (!hasBippy.result?.value) {
        await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
          expression: bippyBundleCode,
        })
      }

      // Walk from the right-clicked DOM element up through React fiber tree to find
      // the nearest composite component with source location info. Uses bippy's
      // getSource() first (direct __source prop from JSX transform), then falls back
      // to getOwnerStack() for production builds with source maps.
      const jsResolveSource = js`
        (async () => {
          const el = window.__playwriter_lastRightClicked;
          if (!el) return JSON.stringify({ error: 'No element was right-clicked' });

          const bippy = globalThis.__bippy;
          if (!bippy) return JSON.stringify({ error: 'bippy not loaded' });

          // bippy.normalizeFileName strips "/app-pages-browser/" but not the parenthesized
          // form "/(app-pages-browser)/" that Next.js webpack actually uses. This regex
          // strips all Next.js webpack layer prefixes: (app-pages-browser), (ssr), (rsc),
          // (action-browser), (pages-dir-browser), (pages-dir-edge), (pages-dir-node).
          // Also strips leading "./" that often follows the layer prefix.
          const cleanFileName = (name) => {
            let f = bippy.normalizeFileName(name);
            f = f.replace(/^\/?\\([-\\w]+\\)\\//, '');
            f = f.replace(/^\\.[\\/]/, '');
            return f;
          };

          let fiber;
          try { fiber = bippy.getFiberFromHostInstance(el); } catch {}
          if (!fiber) return JSON.stringify({ error: 'No React fiber found. Is this a React app?' });

          // Walk up to find nearest composite fiber with source info
          let current = fiber;
          for (let i = 0; i < 50 && current; i++) {
            try {
              if (bippy.isCompositeFiber(current)) {
                const source = await bippy.getSource(current);
                if (source && source.fileName && bippy.isSourceFile(source.fileName)) {
                  return JSON.stringify({
                    fileName: cleanFileName(source.fileName),
                    lineNumber: source.lineNumber || null,
                    columnNumber: source.columnNumber || null,
                    componentName: source.functionName || bippy.getDisplayName(current.type) || null,
                  });
                }
                // Try owner stack as fallback for this fiber
                const ownerStack = await bippy.getOwnerStack(current);
                for (const frame of ownerStack) {
                  if (frame.fileName && bippy.isSourceFile(frame.fileName)) {
                    return JSON.stringify({
                      fileName: cleanFileName(frame.fileName),
                      lineNumber: frame.lineNumber || null,
                      columnNumber: frame.columnNumber || null,
                      componentName: frame.functionName || bippy.getDisplayName(current.type) || null,
                    });
                  }
                }
              }
            } catch {}
            current = current.return;
          }
          return JSON.stringify({ error: 'No React source location found. Is this a dev build with source maps?' });
        })()
      `
      const sourceResult = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsResolveSource,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: string }; exceptionDetails?: { text: string } }

      if (sourceResult.exceptionDetails) {
        logger.error('Failed to get React source:', sourceResult.exceptionDetails.text)
        return
      }

      const parsed = JSON.parse(sourceResult.result?.value || '{}')

      if (!parsed.fileName && !parsed.error) {
        parsed.error = 'React source result missing fileName'
      }

      if (parsed.error) {
        // Flash red outline on the element to indicate no React source found
        const jsFlashRed = js`
          (() => {
            const el = window.__playwriter_lastRightClicked;
            if (!el) return;
            const orig = el.getAttribute('style') || '';
            el.setAttribute('style', orig + '; outline: 3px solid #ef4444 !important; outline-offset: 2px !important;');
            setTimeout(() => el.setAttribute('style', orig), 600);
          })()
        `
        await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
          expression: jsFlashRed,
        })
        logger.debug('React source not found:', parsed.error)
        return
      }

      // Build clipboard text: "path/to/file.tsx:42" or "path/to/file.tsx" if no line
      const clipboardText: string = (() => {
        if (parsed.lineNumber) {
          return `${parsed.fileName}:${parsed.lineNumber}`
        }
        return parsed.fileName
      })()

      // Flash green outline and copy to clipboard
      const jsFlashGreenAndCopy = js`
        (() => {
          const el = window.__playwriter_lastRightClicked;
          if (!el) return;
          const orig = el.getAttribute('style') || '';
          el.setAttribute('style', orig + '; outline: 3px solid #22c55e !important; outline-offset: 2px !important; box-shadow: 0 0 0 3px #22c55e !important;');
          setTimeout(() => el.setAttribute('style', orig), 300);
          return navigator.clipboard.writeText(${JSON.stringify(clipboardText)});
        })()
      `
      await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: jsFlashGreenAndCopy,
        awaitPromise: true,
        userGesture: true,
      })

      logger.debug('Copied React source path:', clipboardText, 'component:', parsed.componentName)
    } catch (error: any) {
      logger.error('Failed to copy React source:', error.message)
    }
  }
})

// Sync icons on first load
void updateIcons()

// Handle messages from offscreen document (recording chunks)
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (message.action === 'recordingChunk') {
    const { tabId, data, final } = message

    if (connectionManager.ws?.readyState === WebSocket.OPEN) {
      // Send metadata message first
      sendMessage({
        method: 'recordingData',
        params: { tabId, final },
      })

      // Then send binary data if not final
      if (data && !final) {
        const buffer = new Uint8Array(data)
        connectionManager.ws.send(buffer)
      }
    } else {
      // Buffer chunks when WebSocket isn't ready - they'll be flushed when it opens.
      // This prevents data loss during brief disconnections or slow WebSocket startup.
      logger.debug(`Buffering recording chunk for tab ${tabId} (WebSocket not ready)`)
      recordingChunkBuffer.push({ tabId, data, final })
    }

    return false // Sync response, no need to keep channel open
  }

  if (message.action === 'recordingCancelled') {
    const { tabId } = message

    getActiveRecordings().delete(tabId)
    store.setState((state) => {
      const newTabs = new Map(state.tabs)
      const existing = newTabs.get(tabId)
      if (existing) {
        newTabs.set(tabId, { ...existing, isRecording: false })
      }
      return { tabs: newTabs }
    })

    if (connectionManager.ws?.readyState === WebSocket.OPEN) {
      sendMessage({
        method: 'recordingCancelled',
        params: { tabId },
      })
    }

    return false
  }

  return false
})

// Re-inject the toolbar after hard navigations in connected tabs.
// The MAIN-world script is destroyed on every full page load, so we re-run
// initPlaywriterToolbar once the new document's DOM is ready.
// onDOMContentLoaded is used instead of onCommitted because executeScript
// with world:'MAIN' needs the document to exist before injecting.
// Note: SPA route changes (pushState/replaceState) don't trigger this because
// the document is not reset — the toolbar DOM persists across SPA navigations.
chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
  if (details.frameId !== 0) return // top frame only
  const { tabs } = store.getState()
  const tabInfo = tabs.get(details.tabId)
  if (!tabInfo || tabInfo.state !== 'connected') return

  chrome.scripting
    .executeScript({
      target: { tabId: details.tabId, allFrames: false },
      world: 'MAIN',
      func: initPlaywriterToolbar,
    })
    .catch((err: Error) => {
      logger.debug('Could not re-inject toolbar after navigation:', err.message)
    })
})
