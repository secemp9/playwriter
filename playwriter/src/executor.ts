/**
 * PlaywrightExecutor - Manages browser connection and code execution per session.
 * Used by both MCP and CLI to execute Playwright code with persistent state.
 */

import type { Page, Frame, Browser, BrowserContext, Locator, FrameLocator, ElementHandle } from '@xmorse/playwright-core'
import { getChromium, isPatchrightEnabled } from './playwright-import.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import util from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import * as acorn from 'acorn'
import { createSmartDiff } from './diff-utils.js'
import { getCdpUrl, parseRelayHost } from './utils.js'
import type { Workspace } from './workspace-key.js'
import { getExtensionOutdatedWarning, getExtensionStaleError } from './relay-client.js'
import { waitForPageLoad, WaitForPageLoadOptions, WaitForPageLoadResult } from './wait-for-page-load.js'
import { ICDPSession, getCDPSessionForPage } from './cdp-session.js'
import { Debugger } from './debugger.js'
import { Editor } from './editor.js'
import { getStylesForLocator, formatStylesAsText, fetchNormalizedStyles, type StylesResult } from './styles.js'
import { resolveCascade, formatCascadeReport, type DeclRef, type NormalizedRule } from './css-cascade.js'
import { codeFrameColumns } from '@babel/code-frame'
import { getReactSource, getReactComponentInfo, type ReactSourceLocation } from './react-source.js'
import { buildPageModel, type PageModel, type PageModelHandle, type QueryOptions } from './page-model.js'
import { buildModuleGraph, type ModuleGraph, type ModuleGraphSummary } from './module-graph.js'
import {
  traceValue,
  readLogpoints,
  storeIdentity,
  netTimeline,
  netDelay,
  fiberSnapshot,
  fiberDiff,
  replayPure,
  replayPureAsync,
  listTraceProbes,
  getTraceProbe,
  readTraceProbe,
  stopTraceProbe,
  stopAllTraceProbes,
  tracePerturbationWarnings,
  type TraceDeps,
  type RenderOptions,
  type NetEntry,
} from './trace.js'
import {
  inspectBinding,
  evaluateBinding,
  findMissingDeps,
  isPureFunctionSource,
  backwardSlice,
} from './static-analysis.js'
import { ScopedFS } from './scoped-fs.js'
import {
  screenshotWithAccessibilityLabels,
  getAriaSnapshot,
  resizeImageForAgent,
  DEFAULT_SNAPSHOT_FORMAT,
  type ScreenshotResult,
  type SnapshotFormat,
} from './aria-snapshot.js'
import { createGhostBrowserChrome, type GhostBrowserCommandResult } from './ghost-browser.js'
export type { SnapshotFormat }
import { getCleanHTML, type GetCleanHTMLOptions, type HtmlDiffStore } from './clean-html.js'
import { getPageMarkdown, type GetPageMarkdownOptions, type MarkdownDiffStore } from './page-markdown.js'
import { createRecordingApi } from './screen-recording.js'
import { startCdpScreencast, type CdpScreencastHandle, type CdpScreencastOptions, type InputAction } from './cdp-screencast.js'
import { createDemoVideo } from './ffmpeg.js'
import { type GhostCursorClientOptions } from './ghost-cursor.js'
import { GhostCursorController } from './ghost-cursor-controller.js'
import { createHumanMouseApi } from './human-mouse-driver.js'


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const require = createRequire(import.meta.url)

export class CodeExecutionTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Code execution timed out after ${timeout}ms`)
    this.name = 'CodeExecutionTimeoutError'
  }
}

const usefulGlobals = {
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  URL,
  URLSearchParams,
  fetch,
  Buffer,
  TextEncoder,
  TextDecoder,
  crypto,
  AbortController,
  AbortSignal,
  structuredClone,
  // `process` is DELIBERATELY absent here. The sandbox gets a hardened Proxy over it
  // (see buildSandboxContext), and that proxy is installed AFTER `...usefulGlobals` is
  // spread into the context object. Listing the raw `process` here as well made the
  // whole boundary depend on nothing ever reordering two lines in an object literal.
} as const

/**
 * Parse code and check if it's a single expression that should be auto-returned.
 * Returns the exact expression source (without trailing semicolon) using AST
 * node offsets, or null if the code should not be auto-wrapped. See #58.
 */
export function getAutoReturnExpression(code: string): string | null {
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      sourceType: 'script',
    })

    // Must be exactly one statement
    if (ast.body.length !== 1) {
      return null
    }

    const stmt = ast.body[0]

    // If it's already a return statement, don't auto-wrap
    if (stmt.type === 'ReturnStatement') {
      return null
    }

    // Must be an ExpressionStatement
    if (stmt.type !== 'ExpressionStatement') {
      return null
    }

    // Don't auto-return side-effect expressions
    const expr = stmt.expression
    if (
      expr.type === 'AssignmentExpression' ||
      expr.type === 'UpdateExpression' ||
      (expr.type === 'UnaryExpression' && expr.operator === 'delete')
    ) {
      return null
    }

    // Don't auto-return sequence expressions that contain assignments
    if (expr.type === 'SequenceExpression') {
      const hasAssignment = expr.expressions.some((e) => e.type === 'AssignmentExpression')
      if (hasAssignment) {
        return null
      }
    }

    // Use the expression node's start/end offsets to extract just the expression
    // source, excluding any trailing semicolon. This is more robust than regex.
    return code.slice(expr.start, expr.end)
  } catch {
    // Parse failed, don't auto-return
    return null
  }
}

/** Backward-compatible helper: returns true if code should be auto-wrapped. */
export function shouldAutoReturn(code: string): boolean {
  return getAutoReturnExpression(code) !== null
}

/**
 * Wraps user code in an async IIFE for vm execution.
 * Uses AST node offsets to extract the expression without trailing semicolons,
 * avoiding SyntaxError when embedding inside `return await (...)`. See #58.
 */
export function wrapCode(code: string): string {
  const expr = getAutoReturnExpression(code)
  if (expr !== null) {
    return `(async () => { return await (${expr}) })()`
  }
  return `(async () => { ${code} })()`
}

const EXTENSION_NOT_CONNECTED_ERROR = `The Playwriter Chrome extension is not connected. Make sure you have:
1. Installed the extension: https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe
2. Clicked the extension icon on a tab to enable it (or refreshed the page if just installed)
3. Or use a cloud browser instead: run \`playwriter cloud login\` in your terminal to rent a browser in the cloud, with auto CAPTCHA solving, residential proxies and anti-detection built in`

const NO_PAGES_AVAILABLE_ERROR =
  'No Playwright pages are available: the browser has no open contexts. Call reset to reconnect.'

const CLOUD_SESSION_EXPIRED_ERROR =
  'Cloud browser session expired or was destroyed. Create a new session with: playwriter session new --browser cloud'

/** Patterns that indicate the browser/page/context was closed or the WebSocket died.
 *  Used to detect cloud VM expiration vs other Playwright errors. */
const DISCONNECTION_PATTERNS = [
  'browser has been closed',
  'browser.close',
  'Target page, context or browser has been closed',
  'Target closed',
  'connection refused',
  'WebSocket is not open',
  'WebSocket error',
  'connect ECONNREFUSED',
  'Session closed',
  'Connection closed',
  'NS_ERROR_NET_RESET',
]

function isDisconnectionError(error: Error): boolean {
  const msg = error.message || ''
  const stack = error.stack || ''
  const matchesHere = DISCONNECTION_PATTERNS.some((pattern) => {
    return msg.includes(pattern) || stack.includes(pattern)
  })
  if (matchesHere) return true
  // Walk the cause chain — ensureConnection wraps the real WebSocket error
  // in a new Error with { cause }, so we need to check nested causes too.
  if (error.cause instanceof Error) {
    return isDisconnectionError(error.cause)
  }
  return false
}

const MAX_LOGS_PER_PAGE = 5000

const ALLOWED_MODULES = new Set([
  'path',
  'node:path',
  'url',
  'node:url',
  'querystring',
  'node:querystring',
  'punycode',
  'node:punycode',
  'crypto',
  'node:crypto',
  'buffer',
  'node:buffer',
  'string_decoder',
  'node:string_decoder',
  'util',
  'node:util',
  'assert',
  'node:assert',
  'events',
  'node:events',
  'timers',
  'node:timers',
  'stream',
  'node:stream',
  'zlib',
  'node:zlib',
  'http',
  'node:http',
  'https',
  'node:https',
  'http2',
  'node:http2',
  'os',
  'node:os',
  'fs',
  'node:fs',
])

/**
 * The single refusal used by EVERY module-loading entry point the sandbox has.
 *
 * There is more than one such entry point, which is the whole reason this is shared:
 * `require(id)`, `require.resolve(id)` and `process.getBuiltinModule(id)` all reach the
 * host module system, and until this existed only the first of them consulted
 * ALLOWED_MODULES.
 */
function moduleNotAllowedError(id: string): Error {
  const error = new Error(
    `Module "${id}" is not allowed in the sandbox. ` +
      `Only safe Node.js built-ins are permitted: ${[...ALLOWED_MODULES].filter((m) => !m.startsWith('node:')).join(', ')}`,
  )
  error.name = 'ModuleNotAllowedError'
  return error
}

/**
 * `process` members the sandbox may not CALL. Reading them yields a function that
 * throws, so the refusal is loud and names itself instead of surfacing as a mystery
 * crash somewhere downstream.
 *
 * Three groups, all of which were reachable before:
 *   - ending or re-privileging the host process. `exit` was already blocked "to prevent
 *     killing the relay server", but `abort`, `reallyExit`, `kill(process.pid)` and
 *     `_kill` all do the same thing, so blocking only `exit` blocked nothing.
 *   - loading native code or raw internal bindings: `process.binding('spawn_sync').spawn`
 *     IS a shell, and `dlopen` loads any .node file on disk into this process.
 *   - reading the filesystem outside the ScopedFS jail: `loadEnvFile(path)` parses ANY
 *     file into `process.env`, from where sandbox code reads it back.
 */
const DENIED_PROCESS_METHODS = new Set([
  'abort',
  'reallyExit',
  'kill',
  '_kill',
  '_debugProcess',
  '_debugEnd',
  'umask',
  'setuid',
  'setgid',
  'seteuid',
  'setegid',
  'setgroups',
  'initgroups',
  'binding',
  '_linkedBinding',
  'dlopen',
  'loadEnvFile',
])

/**
 * `process` members the sandbox reads as `undefined`, because they are objects rather
 * than callables and the capability is reached by walking INTO them:
 *   - `mainModule.require` is the UNRESTRICTED host require. Already undefined under an
 *     ESM entry point; pinned so moving to a CJS entry point cannot silently re-open it.
 *   - `report.writeReport(path)` writes a diagnostic dump — full environment, argv,
 *     loaded libraries — to any path on disk, past the ScopedFS jail in both directions.
 */
const DENIED_PROCESS_PROPERTIES = new Set(['mainModule', 'report'])

export interface ExecuteScreenshot {
  path: string
  base64: string
  mimeType: 'image/png'
  snapshot: string
  labelCount: number
}

export interface ExecuteResult {
  text: string
  images: Array<{ data: string; mimeType: string }>
  screenshots: ExecuteScreenshot[]
  isError: boolean
}

interface WarningEvent {
  id: number
  message: string
}

interface WarningScope {
  cursor: number
}

export interface ExecutorLogger {
  log(...args: any[]): void
  error(...args: any[]): void
}

export interface CdpConfig {
  host?: string
  port?: number
  token?: string
  extensionId?: string | null
  /** Isolation identity for this client, carried to the relay on the CDP URL's query string.
   *  Derived in the MCP/CLI client process and passed in — never derived here (I4).
   *  Only meaningful for relay/extension mode: directCdpUrl and headless never call getCdpUrl. */
  workspace?: Workspace
  /** Direct CDP WebSocket URL — bypasses relay + extension, connects straight to Chrome */
  directCdpUrl?: string
  /** Launch a headless Chrome via chromium.launch() instead of connecting to an existing one.
   *  Uses direct Playwright browser management, no extension or relay CDP routing needed. */
  headless?: boolean
}

export interface SessionMetadata {
  extensionId: string | null
  browser: string | null
  profile: { email: string; id: string } | null
  /** Isolation identity for the session. ExecutorManager merges this into the executor's
   *  CdpConfig, which is how it reaches the relay via getCdpUrl. null means the session is
   *  not workspace-keyed — correct for headless and direct-CDP sessions, which own their
   *  browser outright and never touch the relay. */
  workspace: Workspace | null
}

export interface SessionInfo {
  id: string
  stateKeys: string[]
  extensionId: string | null
  browser: string | null
  profile: { email: string; id: string } | null
  cwd: string | null
}

export interface CloudSessionInfo {
  /** Timestamp (epoch ms) when the BU VM will hard-timeout */
  timeoutAt?: number
  /** Whether proxy is enabled — when true, images/video/fonts are blocked to save bandwidth.
   *  Set to false via --disable-proxy-bandwidth-acceleration to allow all resources. */
  blockProxyResources?: boolean
}

export interface ExecutorOptions {
  cdpConfig: CdpConfig
  sessionMetadata?: SessionMetadata
  logger?: ExecutorLogger
  /** Working directory for scoped fs access */
  cwd?: string
  /** Set when this executor is connected to a cloud Browser Use VM */
  cloudSession?: CloudSessionInfo
}

function isRegExp(value: any): value is RegExp {
  return (
    typeof value === 'object' && value !== null && typeof value.test === 'function' && typeof value.exec === 'function'
  )
}

function isPromise(value: any): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof value.then === 'function'
}

/**
 * Duck-type check for a Playwright ChannelOwner (Response, Page, Browser,
 * Request, Frame, BrowserContext, etc.). Used to skip auto-printing these
 * objects from the REPL — they're meant for programmatic use, and dumping
 * them risks leaking internal fields. Users can still `console.log(obj)` to
 * inspect them via the safe handler in playwright-core. See issue #82.
 */
export function isPlaywrightChannelOwner(value: any): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value._type === 'string' &&
    typeof value._guid === 'string' &&
    value._connection !== undefined
  )
}

/* ------------------------------------ input overlay: where the events come from */

/**
 * Feed the recorder's on-screen input overlay from Playwright's own client
 * instrumentation.
 *
 * THREE CANDIDATE SOURCES WERE EVALUATED. This is the one that survives:
 *
 * 1. **In-page `addEventListener('keydown', …)` via `addInitScript`.** Dead on arrival
 *    for the most common action in any repro. `page.fill()` reaches
 *    `keyboard.insertText` (playwright-core `server/dom.ts` → `server/input.ts`), and
 *    `insertText` dispatches `Input.insertText` — NO keydown, NO keyup. An in-page
 *    listener sees nothing at all for a `fill()`. It also cannot see a click that hits no
 *    listener-bearing element, and it perturbs the page under test.
 * 2. **A tap on the relay's CDP command stream.** Ground truth for everything including
 *    `insertText`, and unreachable from here: the relay is a DETACHED singleton daemon
 *    (`relay-client.ts` `spawn(..., { detached: true })`), and this process reaches it as
 *    a websocket CDP client via `getCdpUrl()` + `connectOverCDP`. Its `cdp:command`
 *    emitter is closure-scoped inside `startPlayWriterCDPRelayServer`, obtainable only by
 *    whoever called it — the daemon, `playwriter serve`, and tests. Worse, direct-CDP mode
 *    bypasses the relay entirely, so the source would not even exist there.
 * 3. **This: `ClientInstrumentation.onApiCallBegin/End`** (playwright-core
 *    `client/clientInstrumentation.ts`, fired from `client/channelOwner.ts`). Every
 *    Playwright input, from any object, funnels through one channel call and is reported
 *    once with `{ type, method, params }`. Verified by running it: `page.fill`,
 *    `locator.fill`, `page.click`, `locator.click({button:'right'})`, `locator.dblclick`,
 *    `keyboard.press('Control+A')`, `keyboard.type`, `keyboard.insertText`,
 *    `mouse.wheel`, `locator.pressSequentially`, `elementHandle.click` all appear, each
 *    exactly once, with the arguments intact. It is client-side, so it works identically
 *    in extension, direct-CDP and headless modes.
 *
 * WHAT THIS DOES NOT SEE, and cannot:
 *   - a REAL HUMAN typing or clicking in the browser — nothing reaches this process;
 *   - input synthesised by the page itself (`el.dispatchEvent(new KeyboardEvent(…))`);
 *   - raw CDP the sandbox sends itself (`cdp.send('Input.dispatchKeyEvent', …)`), which
 *     bypasses the Playwright client entirely;
 *   - `page.mouse.move()`, deliberately: movement is not a press, and the ghost cursor
 *     already draws it. `mouseDown`/`mouseUp`/`click` are captured.
 *
 * The instrumentation object is per-CONNECTION, not per-page, so a recording that drives
 * two pages at once will show chips for both. One page is the normal case and the chips
 * are still a true account of what the code did.
 */
const PAGE_INPUT_METHODS = new Set([
  'keyboardDown',
  'keyboardUp',
  'keyboardInsertText',
  'keyboardType',
  'keyboardPress',
  'mouseDown',
  'mouseUp',
  'mouseClick',
  'mouseWheel',
  'touchscreenTap',
])

const ELEMENT_INPUT_METHODS = new Set([
  'click',
  'dblclick',
  'tap',
  'dragAndDrop',
  'hover',
  'fill',
  'type',
  'press',
  'check',
  'uncheck',
  'focus',
  'selectOption',
  'selectText',
  'setInputFiles',
])

/**
 * One Playwright channel call -> one chip, or `null` for everything that is not input.
 *
 * Pure and exported so the mapping can be tested without a browser: the failure mode here
 * is a silently unhandled method, which no end-to-end test would notice.
 */
export function playwrightChannelToInputAction(channel: {
  type: string
  method: string
  params?: Record<string, any>
}): InputAction | null {
  const p = channel.params ?? {}
  const target: string | undefined = typeof p.selector === 'string' ? p.selector : undefined

  if (channel.type === 'Page') {
    if (!PAGE_INPUT_METHODS.has(channel.method)) return null
    switch (channel.method) {
      case 'keyboardPress':
        return { kind: 'key', key: String(p.key ?? '') }
      case 'keyboardDown':
        return { kind: 'key', key: String(p.key ?? ''), phase: 'down' }
      case 'keyboardUp':
        return { kind: 'key', key: String(p.key ?? ''), phase: 'up' }
      case 'keyboardType':
        return { kind: 'text', text: String(p.text ?? ''), via: 'type' }
      case 'keyboardInsertText':
        return { kind: 'text', text: String(p.text ?? ''), via: 'insertText' }
      case 'mouseClick':
        return { kind: 'mouse', action: 'click', button: p.button, clickCount: p.clickCount }
      case 'mouseDown':
        return { kind: 'mouse', action: 'down', button: p.button }
      case 'mouseUp':
        return { kind: 'mouse', action: 'up', button: p.button }
      case 'mouseWheel':
        return { kind: 'mouse', action: 'wheel', deltaX: p.deltaX, deltaY: p.deltaY }
      case 'touchscreenTap':
        return { kind: 'mouse', action: 'tap' }
    }
    return null
  }

  // Frame and ElementHandle share method names; only ElementHandle omits the selector.
  if (channel.type !== 'Frame' && channel.type !== 'ElementHandle') return null
  if (!ELEMENT_INPUT_METHODS.has(channel.method)) return null
  switch (channel.method) {
    case 'click':
      return { kind: 'mouse', action: 'click', button: p.button, clickCount: p.clickCount, target }
    case 'dblclick':
      return { kind: 'mouse', action: 'dblclick', button: p.button, target }
    case 'tap':
      return { kind: 'mouse', action: 'tap', target }
    case 'dragAndDrop':
      return { kind: 'mouse', action: 'drag', target: typeof p.source === 'string' ? p.source : undefined }
    case 'hover':
      return { kind: 'action', verb: 'Hover', target }
    case 'fill':
      return { kind: 'text', text: String(p.value ?? ''), via: 'fill', target }
    case 'type':
      return { kind: 'text', text: String(p.text ?? ''), via: 'type', target }
    case 'press':
      return { kind: 'key', key: String(p.key ?? ''), target }
    case 'check':
      return { kind: 'action', verb: 'Check', target }
    case 'uncheck':
      return { kind: 'action', verb: 'Uncheck', target }
    case 'focus':
      return { kind: 'action', verb: 'Focus', target }
    case 'selectText':
      return { kind: 'action', verb: 'Select text', target }
    case 'setInputFiles': {
      const count = Array.isArray(p.localPaths)
        ? p.localPaths.length
        : Array.isArray(p.payloads)
          ? p.payloads.length
          : Array.isArray(p.streams)
            ? p.streams.length
            : 0
      return { kind: 'action', verb: 'Upload', detail: count === 1 ? '1 file' : `${count} files`, target }
    }
    case 'selectOption': {
      const first = Array.isArray(p.options) ? p.options[0] : undefined
      const label = first?.valueOrLabel ?? first?.value ?? first?.label
      // The chosen value is not typed text, but it is still user data, so it goes through
      // the same length cap as everything else via formatInputLabel.
      return { kind: 'action', verb: 'Select', detail: label === undefined ? undefined : `"${String(label)}"`, target }
    }
  }
  return null
}

/**
 * Subscribe to the instrumentation and hand every input to `onAction`.
 *
 * Emitted on `onApiCallEnd`, not `onApiCallBegin`, for two reasons that both matter:
 *   - a `locator.click()` that spends three seconds waiting for actionability BEGINS three
 *     seconds before the click actually lands, and a chip at the begin time would sit on
 *     screen pointing at nothing;
 *   - an action that THREW (timeout, strict-mode violation) never happened, and burning
 *     "Click" into a video where no click occurred is a lie the viewer cannot check.
 * `onApiCallBegin` carries the channel and `onApiCallEnd` carries the outcome, so the
 * action is stashed against the (identical) apiCall object and emitted when it resolves.
 */
export function attachInputOverlayTap({
  page,
  onAction,
}: {
  page: Page
  onAction: (action: InputAction) => void
}): { detach: () => void; note?: string } {
  const instrumentation = (page as any)?._instrumentation
  if (!instrumentation || typeof instrumentation.addListener !== 'function' || typeof instrumentation.removeListener !== 'function') {
    return {
      detach: () => {},
      note:
        'The input overlay found no Playwright client instrumentation on this page, so nothing will be ' +
        'captured. The recording is otherwise unaffected.',
    }
  }

  const pending = new Map<object, InputAction>()
  const listener = {
    onApiCallBegin(apiCall: object, channel: { type: string; method: string; params?: Record<string, any> }) {
      try {
        const action = playwrightChannelToInputAction(channel)
        if (action) pending.set(apiCall, action)
      } catch {
        // The tap observes; it must never be able to fail the call it is observing.
      }
    },
    onApiCallEnd(apiCall: { error?: Error } & object) {
      const action = pending.get(apiCall)
      if (!action) return
      pending.delete(apiCall)
      if (apiCall.error) return
      try {
        onAction(action)
      } catch {
        // Same: a full event cap or a stopped recorder must not break page.click().
      }
    },
  }
  instrumentation.addListener(listener)
  return {
    detach: () => {
      try {
        instrumentation.removeListener(listener)
      } catch {
        // Connection already torn down; the listener died with it.
      }
      pending.clear()
    },
  }
}

/**
 * An OPAQUE reference to a parsed module graph.
 *
 * A `ModuleGraph` holds live Babel `NodePath`s (and, through them, the whole AST with
 * its parent pointers). Handing one to sandbox code would let it be `return`ed, and
 * `util.inspect` would then either explode on the cycles or dump tens of thousands of
 * lines. So the sandbox never sees the graph: it gets this handle, which carries only
 * the bounded digest, and every helper that needs the real graph looks it up in the
 * module-private `graphByHandle` map below.
 */
export interface ModuleGraphHandle {
  /** Absolute root the graph was built over. */
  root: string
  /** How many files were indexed. The file LIST is on `summary()`, not here. */
  fileCount: number
  /** Bounded, serialisable digest — this is the only thing safe to return. */
  summary(): ModuleGraphSummary
}

/** handle -> live graph. Module-private on purpose: nothing in the sandbox can reach it. */
const graphByHandle = new WeakMap<ModuleGraphHandle, ModuleGraph>()

/** Resolve a sandbox-supplied `graph` argument (a handle) to the live graph. */
function unwrapGraph(graph: unknown, who: string): ModuleGraph {
  if (graph && typeof graph === 'object') {
    const live = graphByHandle.get(graph as ModuleGraphHandle)
    if (live) return live
  }
  throw new Error(
    `${who}: \`graph\` must be a handle from moduleGraph({ root }). ` +
      'The live module graph is never exposed to the sandbox — it holds Babel NodePaths.',
  )
}

export class PlaywrightExecutor {
  private isConnected = false
  private page: Page | null = null
  private browser: Browser | null = null
  private context: BrowserContext | null = null

  private userState: Record<string, any> = {}
  private browserLogs: Map<Page, string[]> = new Map()
  // Tracks the index up to which getLatestLogs({ sinceLastCall: true }) has
  // returned logs. 0 means "return everything" (first call gets full buffer).
  // When addBrowserLog shifts old entries (cap at MAX_LOGS_PER_PAGE), cursors
  // are decremented so they stay in sync with the array.
  private pageLogCursor: Map<Page, number> = new Map()
  private lastSnapshots: WeakMap<Page, Map<string, string>> = new WeakMap()
  /**
   * Diff baselines for the other two readers, held HERE rather than in their modules.
   *
   * `prompt.md` promises `getCleanHTML`, `getPageMarkdown` and `snapshot` the same
   * `showDiffSinceLastCall` semantics, and they did not have them: `snapshot`'s baseline
   * was per-executor (above) while the other two were module-global. Two sessions in one
   * relay process driving the same `Page` therefore shared a getCleanHTML baseline, so
   * each was told "no changes since last call" about the other's edits. Same scope now.
   */
  private lastCleanHtml: HtmlDiffStore = new WeakMap()
  private lastPageMarkdown: MarkdownDiffStore = new WeakMap()
  private lastRefToLocator: WeakMap<Page, Map<string, string>> = new WeakMap()
  // Per-page PageModel cache (same lifecycle as lastSnapshots). Used as the diff
  // baseline for `changedSince` markers on the next buildPageModel for the page.
  private lastPageModel: WeakMap<Page, PageModel> = new WeakMap()
  /** In-flight CDP screencast, if any. Survives across execute() calls. */
  cdpScreencast: CdpScreencastHandle | null = null
  /**
   * Removes the input-overlay tap on Playwright's client instrumentation.
   *
   * Lives beside `cdpScreencast` and for the same reason: the listener outlives the
   * `execute()` call that armed it, and leaving it attached after `stopCdp` would keep
   * every later `page.click()` walking a dead recorder.
   */
  private cdpScreencastInputDetach: (() => void) | null = null
  // Per-cwd module-graph cache (M4): traceValue/backwardSlice reuse the parsed
  // graph across turns instead of re-walking the source tree each call.
  private moduleGraphCache: Map<string, ModuleGraph> = new Map()
  // Per-page Debugger cache (M4): logpoint/script-source/trace closures reuse a
  // single Debugger per page instead of re-enabling on every call.
  private debuggerCache: WeakMap<Page, Debugger> = new WeakMap()
  /**
   * Per-page CDP adapter handed to `net.delay`.
   *
   * `getCDPSessionForPage` mints a NEW adapter object every call, and `netDelay`
   * registers the adapter as the probe's `owner` and compares owners by identity — so
   * without a stable per-page adapter its "refusing to start a second net.delay on this
   * page" guard could never fire, and two interceptors would silently fight over
   * `Fetch.enable`. Caching also gives teardown a handle to stop by.
   */
  private netDelayCdpCache: WeakMap<Page, ICDPSession> = new WeakMap()
  /**
   * Everything this executor has ever registered as a trace-probe `owner` (pages for
   * `net.timeline`, CDP adapters for `net.delay`).
   *
   * The registry in trace.ts is MODULE-level, so an unfiltered `stopAllTraceProbes()`
   * would also kill probes belonging to other sessions sharing this relay process.
   * Teardown stops probes owner-by-owner instead, which is precise and never reaches
   * across sessions.
   */
  private traceProbeOwners = new Set<unknown>()
  private warningEvents: WarningEvent[] = []
  private nextWarningEventId = 0
  private lastDeliveredWarningEventId = 0

  // Recording timestamp tracking: when recording is active, each execute()
  // call pushes {start, end} (seconds relative to recordingStartedAt).
  // Returned by stopRecording() so the model can speed up idle sections.
  private recordingStartedAt: number | null = null
  private executionTimestamps: Array<{ start: number; end: number }> = []
  private activeWarningScopes = new Set<WarningScope>()
  private pagesWithListeners = new WeakSet<Page>()
  private suppressPageCloseWarnings = false

  private scopedFs: ScopedFS
  private sandboxedRequire: NodeRequire

  private cdpConfig: CdpConfig
  private logger: ExecutorLogger
  private sessionMetadata: SessionMetadata
  private sessionCwd: string | null
  private hasWarnedExtensionOutdated = false

  private ghostCursorController: GhostCursorController
  /** Non-null when this executor is backed by a cloud Browser Use VM */
  private cloudSession: CloudSessionInfo | null
  /** Last minute bucket for which a cloud timeout warning was enqueued (dedup) */
  private lastCloudTimeoutWarningMinute: number | null = null

  constructor(options: ExecutorOptions) {
    this.cdpConfig = options.cdpConfig
    this.logger = options.logger || { log: console.log, error: console.error }
    this.sessionMetadata = options.sessionMetadata || { extensionId: null, browser: null, profile: null, workspace: null }
    this.sessionCwd = options.cwd ? path.resolve(options.cwd) : null
    this.cloudSession = options.cloudSession || null
    // ScopedFS expects an array of allowed directories. If cwd is provided, use it; otherwise use defaults.
    this.scopedFs = new ScopedFS(
      this.sessionCwd ? [this.sessionCwd, '/tmp', os.tmpdir()] : undefined,
      this.sessionCwd || undefined,
    )
    this.sandboxedRequire = this.createSandboxedRequire(require)
    this.ghostCursorController = new GhostCursorController({
      logger: {
        error: (...args: unknown[]) => {
          this.logger.error(...args)
        },
      },
    })
  }

  /**
   * The sandbox `require`: an allowlist gate in front of the host require, with `fs`
   * swapped for the write-jailed ScopedFS.
   *
   * The properties hung off it are as much a part of the boundary as the function
   * itself, and copying the host's straight across defeated the gate entirely:
   *   - `cache` is `Module._cache`. Every value in it is a live `Module` carrying an
   *     UNRESTRICTED `.require`, so `require.cache[anyKey].require('child_process')`
   *     was a complete allowlist bypass — 923 entries were reachable in a plain test
   *     run. The sandbox gets a frozen empty null-prototype object: nothing to walk.
   *   - `extensions` is `Module._extensions`. READING it hands out host functions;
   *     WRITING it rewrites how this entire host process loads every future `.js` file.
   *     Also replaced with a frozen empty object.
   *   - `resolve` probes the real filesystem and does NOT go through ScopedFS:
   *     `require.resolve('/etc/passwd')` returned that path, and threw for paths that
   *     do not exist — a whole-disk existence oracle. Gated by the same allowlist, and
   *     `resolve.paths` no longer discloses the host's module search path.
   *   - `main` is undefined under ESM `createRequire` today. Pinned to `undefined` so a
   *     future CJS entry point cannot quietly re-expose `main.require`.
   */
  private createSandboxedRequire(originalRequire: NodeRequire): NodeRequire {
    const scopedFs = this.scopedFs
    const sandboxedRequire = ((id: string) => {
      if (!ALLOWED_MODULES.has(id)) {
        throw moduleNotAllowedError(id)
      }
      if (id === 'fs' || id === 'node:fs') {
        return scopedFs
      }
      return originalRequire(id)
    }) as NodeRequire

    const sandboxedResolve = ((id: string, options?: { paths?: string[] }) => {
      if (!ALLOWED_MODULES.has(id)) {
        throw moduleNotAllowedError(id)
      }
      return originalRequire.resolve(id, options)
    }) as NodeRequire['resolve']
    sandboxedResolve.paths = () => null

    sandboxedRequire.resolve = sandboxedResolve
    sandboxedRequire.cache = Object.freeze(Object.create(null))
    sandboxedRequire.extensions = Object.freeze(Object.create(null))
    sandboxedRequire.main = undefined

    return sandboxedRequire
  }

  private async setDeviceScaleFactorForMacOS(context: BrowserContext): Promise<void> {
    if (os.platform() !== 'darwin') {
      return
    }
    const options = (context as any)._options
    if (!options || options.deviceScaleFactor === 2) {
      return
    }
    options.deviceScaleFactor = 2
  }

  /** Block images, video, and font resources via Network.setBlockedURLs to save
   *  residential proxy bandwidth. Single CDP command, zero per-request overhead.
   *  Applied per-context on every page (existing and future). */
  private async applyProxyResourceBlocking(context: BrowserContext): Promise<void> {
    // URL patterns using the URLPattern spec syntax (absolute patterns).
    // Covers the vast majority of image/video/font resources by file extension.
    const blockedPatterns = [
      // Images (SVGs excluded — lightweight and often used for icons/UI)
      '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.ico', '*.bmp', '*.avif',
    ]

    const applyToPage = async (page: Page) => {
      try {
        const cdpSession = await page.context().newCDPSession(page)
        await cdpSession.send('Network.enable')
        await cdpSession.send('Network.setBlockedURLs', {
          urls: blockedPatterns,
        })
        await cdpSession.detach()
      } catch (err) {
        // Best-effort: don't break the session if blocking fails
        this.logger.error('Failed to apply proxy resource blocking:', err)
      }
    }

    // Apply to existing pages
    const pages = context.pages().filter((p) => !p.isClosed())
    await Promise.all(pages.map(applyToPage))

    // Apply to future pages
    context.on('page', (page) => {
      applyToPage(page)
    })

    this.logger.log('Proxy bandwidth acceleration enabled: blocking raster images')
  }

  private clearUserState() {
    Object.keys(this.userState).forEach((key) => delete this.userState[key])
  }

  private clearConnectionState() {
    this.isConnected = false
    this.browser = null
    this.page = null
    this.context = null
  }

  enqueueWarning(message: string) {
    this.nextWarningEventId += 1
    this.warningEvents.push({ id: this.nextWarningEventId, message })
  }

  /** Update the cloud session timeout from external tracking (relay timer). */
  updateCloudTimeout(timeoutAt: number) {
    if (this.cloudSession) {
      this.cloudSession.timeoutAt = timeoutAt
    }
  }

  private beginWarningScope(): WarningScope {
    // Use lastDeliveredWarningEventId as cursor (not nextWarningEventId) so
    // warnings enqueued by the relay interval between execute() calls are
    // picked up by the next scope. Using nextWarningEventId would skip them.
    const scope: WarningScope = {
      cursor: this.lastDeliveredWarningEventId,
    }
    this.activeWarningScopes.add(scope)
    return scope
  }

  private flushWarningsForScope(scope: WarningScope): string {
    const relevantWarnings = this.warningEvents.filter((warning) => {
      return warning.id > scope.cursor
    })
    const latestWarningId = relevantWarnings.at(-1)?.id
    if (latestWarningId && latestWarningId > this.lastDeliveredWarningEventId) {
      this.lastDeliveredWarningEventId = latestWarningId
    }

    this.activeWarningScopes.delete(scope)
    this.pruneDeliveredWarnings()

    if (relevantWarnings.length === 0) {
      return ''
    }

    return `${relevantWarnings.map((warning) => `[WARNING] ${warning.message}`).join('\n')}\n`
  }

  private pruneDeliveredWarnings() {
    const activeCursors = [...this.activeWarningScopes].map((scope) => {
      return scope.cursor
    })
    const minActiveCursor = activeCursors.length > 0 ? Math.min(...activeCursors) : this.lastDeliveredWarningEventId
    const pruneBeforeOrAt = Math.min(this.lastDeliveredWarningEventId, minActiveCursor)
    this.warningEvents = this.warningEvents.filter((warning) => {
      return warning.id > pruneBeforeOrAt
    })
  }

  /**
   * Hard-reject a STALE extension (older than this relay/CLI). Unlike
   * warnIfExtensionOutdated (the NEWER-extension case, which warns and continues), a stale
   * extension no longer echoes workspace ownership, so every page it opens is invisible to
   * this session — "no pages anywhere". Throwing here surfaces an explicit, actionable error
   * instead of that silent empty-page mystery. Deliberately NOT gated by
   * hasWarnedExtensionOutdated: that boolean must never suppress this error path.
   */
  private throwIfExtensionStale(playwriterVersion: string | null) {
    const staleError = getExtensionStaleError(playwriterVersion)
    if (staleError) {
      throw new Error(staleError)
    }
  }

  private warnIfExtensionOutdated(playwriterVersion: string | null) {
    if (this.hasWarnedExtensionOutdated) {
      return
    }
    const warning = getExtensionOutdatedWarning(playwriterVersion)
    if (warning) {
      this.logger.log(warning)
      // Enqueue so MCP agents see version-skew messages in their next execute
      // response — logger.log alone only reaches stdout, not the LLM.
      this.enqueueWarning(warning)
      this.hasWarnedExtensionOutdated = true
    }
  }

  private setupPageListeners(page: Page) {
    if (this.pagesWithListeners.has(page)) {
      return
    }
    this.pagesWithListeners.add(page)
    this.setupPageCloseDetection(page)
    this.setupPageConsoleListener(page)
    this.setupNewPageLogging(page)
    this.ghostCursorController.attachToPage({ page })
    page.on('close', () => {
      this.ghostCursorController.detachFromPage({ page })
      // A live Fetch interceptor or request listener that outlives its page silently
      // perturbs (or misattributes) every later measurement in the session, so probes
      // die with the page they were armed on.
      void this.stopTraceProbesFor([page, this.netDelayCdpCache.get(page)])
    })
  }

  /**
   * Stop every live trace probe owned by one of `owners`. Owner-filtered rather than a
   * blanket `stopAllTraceProbes()`: the probe registry is module-level and shared by
   * every session in this relay process.
   */
  private async stopTraceProbesFor(owners: Array<unknown>): Promise<string[]> {
    const stopped: string[] = []
    for (const owner of owners) {
      if (owner === undefined) continue
      try {
        stopped.push(...(await stopAllTraceProbes({ owner })))
      } catch (e) {
        this.logger.error('Failed to stop trace probes:', e)
      }
    }
    return stopped
  }

  /**
   * Release everything this session armed against the browser: live trace probes
   * (`net.timeline` listeners, `net.delay`'s `Fetch` interception) and an in-flight CDP
   * screencast. Called on session delete, on `reset()`, and on headless context close —
   * every path where the executor stops driving its pages.
   *
   * Idempotent, and never throws: teardown must not be able to fail a session delete.
   */
  async disposeBrowserSideResources(): Promise<{ probesStopped: string[]; screencastCancelled: boolean }> {
    const owners: unknown[] = [...this.traceProbeOwners]
    this.traceProbeOwners.clear()
    const probesStopped = await this.stopTraceProbesFor(owners)

    // Always dropped, even with no screencast running: a listener on the client
    // instrumentation would otherwise outlive the session that armed it.
    const detachInput = this.cdpScreencastInputDetach
    this.cdpScreencastInputDetach = null
    try {
      detachInput?.()
    } catch (e) {
      this.logger.error('Failed to detach the input overlay tap during teardown:', e)
    }

    let screencastCancelled = false
    const screencast = this.cdpScreencast
    if (screencast) {
      this.cdpScreencast = null
      try {
        await screencast.cancel()
        screencastCancelled = true
      } catch (e) {
        this.logger.error('Failed to cancel CDP screencast during teardown:', e)
      }
    }
    return { probesStopped, screencastCancelled }
  }

  private setupPageCloseDetection(page: Page) {
    page.on('close', () => {
      const stateKeysForClosedPage = Object.entries(this.userState)
        .filter(([, value]) => {
          return value === page
        })
        .map(([key]) => key)

      const wasCurrentPage = this.page === page
      let replacementPageInfo: { index: string; url: string } | null = null

      if (wasCurrentPage) {
        this.page = null
        const context = this.context || page.context()
        const openPages = context.pages().filter((candidate) => {
          return !candidate.isClosed()
        })
        if (openPages.length > 0) {
          const replacementPage = openPages[0]
          this.page = replacementPage
          const replacementIndex = context.pages().indexOf(replacementPage)
          replacementPageInfo = {
            index: replacementIndex >= 0 ? String(replacementIndex) : 'unknown',
            url: replacementPage.url() || 'unknown',
          }
        }
      }

      if (!this.isConnected || this.suppressPageCloseWarnings || stateKeysForClosedPage.length === 0) {
        return
      }

      const stateKeyLabel = stateKeysForClosedPage.map((key) => `state.${key}`).join(', ')
      const closedUrl = page.url() || 'unknown'

      if (!wasCurrentPage) {
        this.enqueueWarning(
          `Page closed (url: ${closedUrl}) for ${stateKeyLabel}. ` +
            `Assign a new open page to ${stateKeyLabel} before reusing it.`,
        )
        return
      }

      if (replacementPageInfo) {
        this.enqueueWarning(
          `The current page in ${stateKeyLabel} was closed (url: ${closedUrl}). ` +
            `Switched active page to index ${replacementPageInfo.index} (url: ${replacementPageInfo.url}). ` +
            `Reassign ${stateKeyLabel} before using it again.`,
        )
        return
      }

      this.enqueueWarning(
        `The current page in ${stateKeyLabel} was closed (url: ${closedUrl}). ` +
          `No open pages remain. Open a tab with Playwriter enabled, then reassign ${stateKeyLabel}.`,
      )
    })
  }

  private setupNewPageLogging(page: Page) {
    // page.on('popup') fires for window.open, target=_blank, and cmd+click
    // (but not context.newPage() or CDP reconnection). The extension
    // auto-relocates popups to tabs, so these pages are controllable via
    // context.pages(). Enqueue synchronously so the warning lands in the
    // enclosing execute() call's scope. initialUrl may be 'about:blank'
    // for blank-then-scripted popups.
    page.on('popup', (popup) => {
      const pages = popup.context().pages()
      const rawIndex = pages.indexOf(popup)
      const pageIndex = rawIndex >= 0 ? String(rawIndex) : 'unknown'
      const initialUrl = popup.url() || 'about:blank'
      this.enqueueWarning(
        `New page opened from current page (index ${pageIndex}, initial url: ${initialUrl}). ` +
          `Access it via context.pages()[${pageIndex}] to interact with it.`,
      )
    })
  }

  private setupPageConsoleListener(page: Page) {
    if (!this.browserLogs.has(page)) {
      this.browserLogs.set(page, [])
    }

    // Logs are NOT cleared on navigation so that getLatestLogs({ sinceLastCall: true })
    // can return errors from the previous page load. The MAX_LOGS_PER_PAGE cap (5000)
    // prevents unbounded growth; old entries are shifted out in addBrowserLog.

    page.on('close', () => {
      this.browserLogs.delete(page)
      this.pageLogCursor.delete(page)
    })

    page.on('console', (msg) => {
      try {
        const logEntry = `[${msg.type()}] ${msg.text()}`
        this.addBrowserLog({ page, logEntry })
      } catch (e) {
        this.logger.error('[Executor] Failed to get console message text:', e)
      }
    })

    page.on('pageerror', (error) => {
      this.addBrowserLog({ page, logEntry: `[pageerror] ${error.message}` })
    })
  }

  private addBrowserLog(options: { page: Page; logEntry: string }) {
    if (!this.browserLogs.has(options.page)) {
      this.browserLogs.set(options.page, [])
    }
    const pageLogs = this.browserLogs.get(options.page)!
    pageLogs.push(options.logEntry)
    if (pageLogs.length > MAX_LOGS_PER_PAGE) {
      pageLogs.shift()
      // Decrement cursor so it stays in sync with the shifted array.
      // Clamp to 0 so the cursor never goes negative.
      const cursor = this.pageLogCursor.get(options.page)
      if (cursor !== undefined && cursor > 0) {
        this.pageLogCursor.set(options.page, cursor - 1)
      }
    }
  }

  private pagesRelatedToPage(page: Page): Page[] {
    const frameUrls = new Set(
      page
        .frames()
        .map((frame) => {
          return frame.url()
        })
        .filter((url) => {
          return url && url !== 'about:blank'
        }),
    )

    return page
      .context()
      .pages()
      .filter((candidate) => {
        return candidate === page || frameUrls.has(candidate.url())
      })
  }

  private async checkExtensionStatus(): Promise<{
    connected: boolean
    activeTargets: number
    playwriterVersion: string | null
  }> {
    const { host = '127.0.0.1', port = 19988, extensionId, token } = this.cdpConfig
    const { httpBaseUrl } = parseRelayHost(host, port)
    const notConnected = { connected: false, activeTargets: 0, playwriterVersion: null }
    const headers: Record<string, string> = {}
    const effectiveToken = token || process.env.PLAYWRITER_TOKEN
    if (effectiveToken) {
      headers['Authorization'] = `Bearer ${effectiveToken}`
    }
    try {
      if (extensionId) {
        const response = await fetch(`${httpBaseUrl}/extensions/status`, {
          signal: AbortSignal.timeout(2000),
          headers,
        })
        if (!response.ok) {
          const fallback = await fetch(`${httpBaseUrl}/extension/status`, {
            signal: AbortSignal.timeout(2000),
            headers,
          })
          if (!fallback.ok) {
            return notConnected
          }
          return (await fallback.json()) as {
            connected: boolean
            activeTargets: number
            playwriterVersion: string | null
          }
        }
        const data = (await response.json()) as {
          extensions: Array<{
            extensionId: string
            stableKey?: string
            activeTargets: number
            playwriterVersion?: string | null
          }>
        }
        const extension = data.extensions.find((item) => {
          return item.extensionId === extensionId || item.stableKey === extensionId
        })
        if (!extension) {
          return notConnected
        }
        return {
          connected: true,
          activeTargets: extension.activeTargets,
          playwriterVersion: extension?.playwriterVersion || null,
        }
      }

      const response = await fetch(`${httpBaseUrl}/extension/status`, {
        signal: AbortSignal.timeout(2000),
        headers,
      })
      if (!response.ok) {
        return notConnected
      }
      return (await response.json()) as { connected: boolean; activeTargets: number; playwriterVersion: string | null }
    } catch {
      return notConnected
    }
  }

  private isDirectCdpMode(): boolean {
    return !!this.cdpConfig.directCdpUrl
  }

  private isHeadlessMode(): boolean {
    return !!this.cdpConfig.headless
  }

  /**
   * Connect to Chrome and set up context/page. Shared by ensureConnection and reset.
   * In headless mode, launches Chrome via chromium.launch().
   * In direct CDP mode, connects straight to Chrome's WebSocket.
   * In extension mode, checks extension status then connects via relay.
   */
  private async connectToBrowser(): Promise<{ browser: Browser; page: Page; context: BrowserContext }> {
    // Headless mode: launch Chrome directly via Playwright (no extension, no relay CDP routing)
    if (this.isHeadlessMode()) {
      return this.connectHeadlessBrowser()
    }

    if (this.isDirectCdpMode()) {
      // Direct CDP: connect straight to Chrome, no relay or extension needed
      const chromium = await getChromium()
      const browser = await chromium.connectOverCDP(this.cdpConfig.directCdpUrl!)

      browser.on('disconnected', () => {
        this.logger.log('Browser disconnected, clearing connection state')
        this.clearConnectionState()
      })

      const contexts = browser.contexts()
      const context = contexts.length > 0 ? contexts[0] : await browser.newContext()

      context.setDefaultTimeout(60000)
      context.setDefaultNavigationTimeout(10000)

      context.on('page', (page) => {
        this.setupPageListeners(page)
      })

      context.pages().forEach((p) => this.setupPageListeners(p))

      // In direct CDP mode, pages are always available (all tabs visible).
      // Use the first non-closed page, or create one.
      const pages = context.pages().filter((p) => !p.isClosed())
      const page = pages.length > 0 ? pages[0] : await context.newPage()
      this.setupPageListeners(page)

      await this.setDeviceScaleFactorForMacOS(context)

      // Block images, video, and fonts for cloud sessions with proxy enabled
      // to reduce residential proxy bandwidth costs. Uses Network.setBlockedURLs
      // which is a single fire-and-forget CDP command with zero per-request overhead.
      if (this.cloudSession?.blockProxyResources) {
        await this.applyProxyResourceBlocking(context)
      }

      return { browser, page, context }
    }

    // Extension mode: check status first for better error messages
    const extensionStatus = await this.checkExtensionStatus()
    if (!extensionStatus.connected) {
      throw new Error(EXTENSION_NOT_CONNECTED_ERROR)
    }
    this.throwIfExtensionStale(extensionStatus.playwriterVersion)
    this.warnIfExtensionOutdated(extensionStatus.playwriterVersion)

    const cdpUrl = getCdpUrl(this.cdpConfig)
    const chromium = await getChromium()
    const browser = await chromium.connectOverCDP(cdpUrl)

    browser.on('disconnected', () => {
      this.logger.log('Browser disconnected, clearing connection state')
      this.clearConnectionState()
    })

    const contexts = browser.contexts()
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext()

    // Action timeout (click, fill, hover, etc.) is longer to tolerate slower
    // SPA/Turbo navigations and post-click settling on real sites.
    // Navigation timeout (goto, reload) remains separate.
    context.setDefaultTimeout(60000)
    context.setDefaultNavigationTimeout(10000)

    context.on('page', (page) => {
      this.setupPageListeners(page)
    })

    context.pages().forEach((p) => this.setupPageListeners(p))
    const page = await this.ensurePageForContext({ context, timeout: 10000 })

    await this.setDeviceScaleFactorForMacOS(context)

    return { browser, page, context }
  }

  /**
   * Launch a headless Chrome via chromium.launch(). No extension, no relay CDP routing.
   * Reuses an existing shared browser if one was already launched for headless mode.
   * Does NOT add per-session disconnect listeners to avoid accumulation on the shared
   * browser; instead, ensureConnection checks browser.isConnected() on each call.
   */
  private async connectHeadlessBrowser(): Promise<{ browser: Browser; page: Page; context: BrowserContext }> {
    const browser = await PlaywrightExecutor.getOrLaunchHeadlessBrowser()

    const context = await browser.newContext()
    try {
      context.setDefaultTimeout(60000)
      context.setDefaultNavigationTimeout(10000)

      context.on('page', (page) => {
        this.setupPageListeners(page)
      })

      const page = await context.newPage()
      this.setupPageListeners(page)

      await this.setDeviceScaleFactorForMacOS(context)

      PlaywrightExecutor._headlessExecutors.add(this)
      return { browser, page, context }
    } catch (e) {
      // Clean up the partially created context so it doesn't leak on the
      // long-lived shared browser.
      await context.close().catch(() => {})
      throw e
    }
  }

  /** Shared headless browser instance across all headless sessions.
   *  Uses a launch promise to prevent concurrent first-session races from
   *  spawning multiple browsers. The disconnect handler is registered once
   *  at launch time and clears both statics so the next session relaunches. */
  private static _sharedHeadlessBrowser: Browser | null = null
  private static _sharedHeadlessBrowserPromise: Promise<Browser> | null = null
  /** Active headless executors sharing the browser. Using a Set instead of a
   *  counter makes tracking idempotent: reset() re-adds the same executor (no-op),
   *  and concurrent deletes can't double-decrement. When the set empties after
   *  a session delete, the shared browser is auto-closed. */
  private static _headlessExecutors = new Set<PlaywrightExecutor>()

  private static async getOrLaunchHeadlessBrowser(): Promise<Browser> {
    // Check the cached browser is actually alive (not just non-null after a crash)
    if (PlaywrightExecutor._sharedHeadlessBrowser?.isConnected()) {
      return PlaywrightExecutor._sharedHeadlessBrowser
    }

    // Deduplicate concurrent launches: second caller awaits the first's promise
    if (PlaywrightExecutor._sharedHeadlessBrowserPromise) {
      return PlaywrightExecutor._sharedHeadlessBrowserPromise
    }

    const launchPromise = (async () => {
      const chromium = await getChromium()
      const { resolveBrowserExecutablePath } = await import('./browser-config.js')
      const executablePath = resolveBrowserExecutablePath()

      const browser = await chromium.launch({
        headless: true,
        executablePath,
      })

      // Single handler registered once per browser lifetime.
      // Only clears statics if this is still the current shared browser;
      // prevents an old browser's disconnect from wiping state for a newer one
      // (race: new session launches while old browser.close() is in progress).
      browser.on('disconnected', () => {
        if (PlaywrightExecutor._sharedHeadlessBrowser !== browser) {
          return
        }
        PlaywrightExecutor._sharedHeadlessBrowser = null
        PlaywrightExecutor._sharedHeadlessBrowserPromise = null
        PlaywrightExecutor._headlessExecutors.clear()
      })

      PlaywrightExecutor._sharedHeadlessBrowser = browser
      // Clear the promise now that the browser is cached; future callers
      // use _sharedHeadlessBrowser directly. Concurrent waiters already
      // hold a reference to launchPromise so they still resolve correctly.
      PlaywrightExecutor._sharedHeadlessBrowserPromise = null
      return browser
    })()

    PlaywrightExecutor._sharedHeadlessBrowserPromise = launchPromise
    try {
      return await launchPromise
    } catch (error) {
      PlaywrightExecutor._sharedHeadlessBrowserPromise = null
      throw error
    }
  }

  /** Close the headless context for this session (called on session delete).
   *  When the last headless executor is removed, the shared browser is also
   *  closed automatically so the Chrome process doesn't linger. */
  async closeHeadlessContext(): Promise<void> {
    if (!this.isHeadlessMode()) {
      return
    }
    await this.disposeBrowserSideResources()
    const context = this.context
    this.clearConnectionState()

    if (context) {
      await context.close().catch((e) => {
        this.logger.error('Error closing headless context:', e)
      })
    }

    const wasTracked = PlaywrightExecutor._headlessExecutors.delete(this)
    if (wasTracked && PlaywrightExecutor._headlessExecutors.size === 0) {
      await PlaywrightExecutor.closeSharedHeadlessBrowser()
    }
  }

  /** Close the shared headless browser (called on relay shutdown or when last
   *  session is deleted). Nulls statics before awaiting close so concurrent
   *  callers of getOrLaunchHeadlessBrowser() launch a fresh browser instead
   *  of reusing one that is mid-shutdown. */
  static async closeSharedHeadlessBrowser(): Promise<void> {
    const browser = PlaywrightExecutor._sharedHeadlessBrowser
    if (browser) {
      // Detach from statics first so new sessions don't reuse a dying browser.
      // The disconnect handler checks identity, so it becomes a no-op for this browser.
      PlaywrightExecutor._sharedHeadlessBrowser = null
      PlaywrightExecutor._sharedHeadlessBrowserPromise = null
      await browser.close().catch(() => {})
    }
  }

  private async ensureConnection(): Promise<{ browser: Browser; page: Page }> {
    // In headless mode, also check the shared browser is still alive.
    // After a crash, isConnected() returns false and we need to reconnect.
    const browserAlive = this.isHeadlessMode() ? this.browser?.isConnected() : true
    if (this.isConnected && this.browser && this.page && browserAlive) {
      return { browser: this.browser, page: this.page }
    }

    try {
      const { browser, page, context } = await this.connectToBrowser()

      this.browser = browser
      this.page = page
      this.context = context
      this.isConnected = true

      return { browser, page }
    } catch (error) {
      // Cloud sessions that fail to connect are likely expired VMs.
      // Give a clear error instead of a cryptic WebSocket/connection error.
      if (this.cloudSession && error instanceof Error && isDisconnectionError(error)) {
        throw new Error(CLOUD_SESSION_EXPIRED_ERROR, { cause: error })
      }
      throw error
    }
  }

  private async getCurrentPage(timeout = 10000): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page
    }

    if (this.browser) {
      const contexts = this.browser.contexts()
      if (contexts.length > 0) {
        const context = contexts[0]
        this.context = context
        const pages = context.pages().filter((p) => !p.isClosed())
        if (pages.length > 0) {
          const page = pages[0]
          await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
          this.page = page
          return page
        }
        const page = await this.ensurePageForContext({ context, timeout })
        this.page = page
        return page
      }
    }

    throw new Error(NO_PAGES_AVAILABLE_ERROR)
  }

  async reset(): Promise<{ page: Page; context: BrowserContext }> {
    this.suppressPageCloseWarnings = true
    // Probes armed against the old pages must not survive the reconnect — their owners
    // are about to become unreachable, which is exactly how a Fetch interceptor turns
    // into an un-stoppable session-wide measurement poison.
    await this.disposeBrowserSideResources()
    try {
      if (this.isHeadlessMode()) {
        // In headless mode, only close this session's context, not the shared browser.
        // Other headless sessions share the same browser instance.
        if (this.context) {
          await this.context.close().catch((e) => {
            this.logger.error('Error closing context:', e)
          })
        }
      } else if (this.browser) {
        await this.browser.close()
      }
    } catch (e) {
      this.logger.error('Error closing browser:', e)
    } finally {
      this.suppressPageCloseWarnings = false
    }

    this.clearConnectionState()
    this.clearUserState()

    const { browser, page, context } = await this.connectToBrowser()

    this.browser = browser
    this.page = page
    this.context = context
    this.isConnected = true

    return { page, context }
  }

  /**
   * Build the object that becomes the `execute()` sandbox's global scope.
   *
   * Extracted from `execute()` deliberately: every helper below is only useful if it is
   * actually REACHABLE as a sandbox global, and while this lived inline inside a method
   * that first requires a live browser, nothing could assert that. `executor-sandbox.test.ts`
   * calls this with stub page/context and checks every documented name is present.
   */
  buildSandboxContext({
    page,
    context,
    consoleLogs,
  }: {
    page: Page
    context: BrowserContext
    consoleLogs: Array<{ method: string; args: any[] }>
  }): {
    vmContextObj: Record<string, any>
    screenshotCollector: ScreenshotResult[]
    resizedImageCollector: Array<{ data: string; mimeType: string }>
  } {
      const customConsole = {
        log: (...args: any[]) => {
          consoleLogs.push({ method: 'log', args })
        },
        info: (...args: any[]) => {
          consoleLogs.push({ method: 'info', args })
        },
        warn: (...args: any[]) => {
          consoleLogs.push({ method: 'warn', args })
        },
        error: (...args: any[]) => {
          consoleLogs.push({ method: 'error', args })
        },
        debug: (...args: any[]) => {
          consoleLogs.push({ method: 'debug', args })
        },
      }

      const snapshot = async (options: {
        page?: Page
        /** Optional frame to scope the snapshot (e.g. from iframe.contentFrame() or page.frames()) */
        frame?: Frame | FrameLocator
        /** Optional locator to scope the snapshot to a subtree */
        locator?: Locator
        search?: string | RegExp
        showDiffSinceLastCall?: boolean
        /** Snapshot format. `'raw'` is the only one that exists; anything else THROWS. */
        format?: SnapshotFormat
        /**
         * Only include interactive elements. Default **false** — the whole accessible
         * tree, because a snapshot is usually read to find out what is on the page, not
         * only what can be clicked. Note the sibling `screenshotWithAccessibilityLabels`
         * genuinely defaults this to **true** (`aria-snapshot.ts`): a label overlay is
         * for finding click targets, so labelling every static node is just clutter.
         */
        interactiveOnly?: boolean
      }) => {
        const {
          page: targetPage,
          frame,
          locator,
          search,
          showDiffSinceLastCall = !search,
          interactiveOnly = false,
          format = DEFAULT_SNAPSHOT_FORMAT,
        } = options
        // `format` was accepted by the type and never read, so passing one type-checked,
        // read as supported, and did nothing whatsoever. There is exactly one format; an
        // unknown one is a caller expecting an output shape this cannot produce.
        if (format !== DEFAULT_SNAPSHOT_FORMAT) {
          throw new Error(
            `snapshot: unsupported format ${JSON.stringify(format)}. The only snapshot format is ` +
              `'${DEFAULT_SNAPSHOT_FORMAT}'. For a tree fused with tags/attributes use pm.renderText(), and for ` +
              'article text use getPageMarkdown().',
          )
        }
        /**
         * Explicit `page` wins; otherwise take it from the `locator` or `frame` being
         * scoped to, and only then fall back to the sandbox default.
         *
         * The middle step is not a convenience. `snapshot({ locator: state.page.locator('main') })`
         * — exactly as the docs show it — used to resolve the locator against the DEFAULT
         * page while the locator belonged to `state.page`, which is the silent-wrong-tab
         * failure the `{ page: state.page }` rule exists to prevent. `debugStyle`,
         * `whyOccluded` and `fiberSnapshot` already took their page from the locator; this
         * makes `snapshot` agree with them. A `FrameLocator` has no `page()`, so it still
         * falls through to the default.
         */
        const pageFromScope: Page | undefined =
          typeof (locator as any)?.page === 'function'
            ? (locator as any).page()
            : typeof (frame as any)?.page === 'function'
              ? (frame as any).page()
              : undefined
        const resolvedPage = targetPage || pageFromScope || page
        if (!resolvedPage) {
          throw new Error('snapshot requires a page')
        }

        // Use new in-page implementation via getAriaSnapshot
        const {
          snapshot: rawSnapshot,
          refs,
          getSelectorForRef,
        } = await getAriaSnapshot({
          page: resolvedPage,
          frame,
          locator,
          interactiveOnly,
        })
        const snapshotStr = rawSnapshot.toWellFormed?.() ?? rawSnapshot

        const refToLocator = new Map<string, string>()
        for (const entry of refs) {
          const locatorStr = getSelectorForRef(entry.ref)
          if (locatorStr) {
            refToLocator.set(entry.shortRef, locatorStr)
          }
        }
        this.lastRefToLocator.set(resolvedPage, refToLocator)

        const shouldCacheSnapshot = !frame
        // Cache keyed by locator selector so full-page and locator-scoped snapshots
        // don't pollute each other's diff baselines
        const snapshotKey = locator ? `locator:${locator.selector()}` : 'page'
        let pageSnapshots = this.lastSnapshots.get(resolvedPage)
        if (!pageSnapshots) {
          pageSnapshots = new Map()
          this.lastSnapshots.set(resolvedPage, pageSnapshots)
        }
        const previousSnapshot = shouldCacheSnapshot ? pageSnapshots.get(snapshotKey) : undefined
        if (shouldCacheSnapshot) {
          pageSnapshots.set(snapshotKey, snapshotStr)
        }

        // Diff defaults off when search is provided, but agent can explicitly enable both
        if (showDiffSinceLastCall && previousSnapshot && shouldCacheSnapshot) {
          const diffResult = createSmartDiff({
            oldContent: previousSnapshot,
            newContent: snapshotStr,
            label: 'snapshot',
          })
          if (diffResult.type === 'no-change') {
            return 'No changes since last snapshot. Use showDiffSinceLastCall: false to see full content.'
          }
          return diffResult.content
        }

        if (!search) {
          return `${snapshotStr}\n\nuse refToLocator({ ref: 'e3' }) to get locators for ref strings.`
        }

        const lines = snapshotStr.split('\n')
        const matchIndices: number[] = []
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const isMatch = isRegExp(search) ? search.test(line) : line.includes(search)
          if (isMatch) {
            matchIndices.push(i)
            if (matchIndices.length >= 10) break
          }
        }

        if (matchIndices.length === 0) {
          return 'No matches found'
        }

        const CONTEXT_LINES = 5
        const includedLines = new Set<number>()
        for (const idx of matchIndices) {
          const start = Math.max(0, idx - CONTEXT_LINES)
          const end = Math.min(lines.length - 1, idx + CONTEXT_LINES)
          for (let i = start; i <= end; i++) {
            includedLines.add(i)
          }
        }

        const sortedIndices = [...includedLines].sort((a, b) => a - b)
        const result: string[] = []
        for (let i = 0; i < sortedIndices.length; i++) {
          const lineIdx = sortedIndices[i]
          if (i > 0 && sortedIndices[i - 1] !== lineIdx - 1) {
            result.push('---')
          }
          result.push(lines[lineIdx])
        }
        return result.join('\n')
      }

      /**
       * The other two diffing readers, pinned to this session's baseline store so all
       * three agree on what "since last call" means. Everything else is theirs — the
       * options object is forwarded whole, so neither wrapper can drop one, and the store
       * is applied AFTER the spread so sandbox code cannot opt itself back out of the
       * session scoping.
       */
      const getCleanHTMLFn = (options: GetCleanHTMLOptions) =>
        getCleanHTML({ ...options, diffStore: this.lastCleanHtml })
      const getPageMarkdownFn = (options: GetPageMarkdownOptions) =>
        getPageMarkdown({ ...options, diffStore: this.lastPageMarkdown })

      const refToLocator = (options: { ref: string; page?: Page }): string | null => {
        const targetPage = options.page || page
        const map = this.lastRefToLocator.get(targetPage)
        if (!map) {
          return null
        }
        return map.get(options.ref) ?? null
      }

      const getLocatorStringForElement = async (element: any) => {
        if (!element || typeof element.evaluate !== 'function') {
          throw new Error('getLocatorStringForElement: argument must be a Playwright Locator or ElementHandle')
        }
        const elementPage = element.page ? element.page() : page
        const hasGenerator = await elementPage.evaluate(() => !!(globalThis as any).__selectorGenerator)
        if (!hasGenerator) {
          const scriptPath = path.join(__dirname, '..', 'dist', 'selector-generator.js')
          const scriptContent = fs.readFileSync(scriptPath, 'utf-8')
          const cdp = await getCDPSession({ page: elementPage })
          await cdp.send('Runtime.evaluate', { expression: scriptContent })
        }
        return await element.evaluate((el: any) => {
          const { createSelectorGenerator, toLocator } = (globalThis as any).__selectorGenerator
          const generator = createSelectorGenerator(globalThis)
          const result = generator(el)
          return toLocator(result.selector, 'javascript')
        })
      }

      const getLatestLogs = async (options?: {
        page?: Page
        count?: number
        search?: string | RegExp
        // When true, only return logs added since the last getLatestLogs call
        // with sinceLastCall: true. First call returns all buffered logs.
        // Cursors are tracked per page so navigations and new logs are
        // never missed. Useful for checking page errors after each action.
        sinceLastCall?: boolean
      }) => {
        const { page: filterPage, count, search, sinceLastCall = false } = options || {}
        let allLogs: string[] = []

        // Collect logs, optionally slicing from cursor when sinceLastCall is set
        const collectLogs = (targetPage: Page): string[] => {
          const logs = this.browserLogs.get(targetPage) || []
          if (!sinceLastCall) {
            return logs
          }
          const cursor = this.pageLogCursor.get(targetPage) || 0
          return logs.slice(cursor)
        }

        if (filterPage) {
          const relatedPages = this.pagesRelatedToPage(filterPage)
          allLogs = relatedPages.flatMap((relatedPage) => {
            return collectLogs(relatedPage)
          })
        } else {
          for (const [p] of this.browserLogs) {
            allLogs.push(...collectLogs(p))
          }
        }

        // Advance cursors after collecting so next sinceLastCall call starts fresh
        if (sinceLastCall) {
          const pagesToAdvance = filterPage
            ? this.pagesRelatedToPage(filterPage)
            : [...this.browserLogs.keys()]
          for (const p of pagesToAdvance) {
            const logs = this.browserLogs.get(p)
            if (logs) {
              this.pageLogCursor.set(p, logs.length)
            }
          }
        }

        if (search) {
          const matchIndices: number[] = []
          for (let i = 0; i < allLogs.length; i++) {
            const log = allLogs[i]
            const isMatch = typeof search === 'string' ? log.includes(search) : isRegExp(search) && search.test(log)
            if (isMatch) matchIndices.push(i)
          }

          const CONTEXT_LINES = 5
          const includedIndices = new Set<number>()
          for (const idx of matchIndices) {
            const start = Math.max(0, idx - CONTEXT_LINES)
            const end = Math.min(allLogs.length - 1, idx + CONTEXT_LINES)
            for (let i = start; i <= end; i++) {
              includedIndices.add(i)
            }
          }

          const sortedIndices = [...includedIndices].sort((a, b) => a - b)
          const result: string[] = []
          for (let i = 0; i < sortedIndices.length; i++) {
            const logIdx = sortedIndices[i]
            if (i > 0 && sortedIndices[i - 1] !== logIdx - 1) {
              result.push('---')
            }
            result.push(allLogs[logIdx])
          }
          allLogs = result
        }

        return count !== undefined ? allLogs.slice(-count) : allLogs
      }

      const clearAllLogs = () => {
        this.browserLogs.clear()
        this.pageLogCursor.clear()
      }

      const getCDPSession = async (options: { page: Page }) => {
        if (options.page.isClosed()) {
          throw new Error('Cannot create CDP session for closed page')
        }
        return await getCDPSessionForPage({ page: options.page })
      }

      const createDebugger = (options: { cdp: ICDPSession }) => new Debugger(options)
      const createEditor = (options: { cdp: ICDPSession }) => new Editor(options)

      /**
       * Both of the options here used to be dropped on the floor, and each dropped one
       * silently:
       *   - `includeUserAgentStyles` is supported by `getStylesForLocator` itself and is
       *     the entire point of the `getStylesWithUserAgent` example in
       *     `styles-examples.ts` — with it discarded, that example produced output
       *     identical to the one right above it;
       *   - a caller-supplied `cdp` was replaced with a freshly minted one, so the
       *     documented `cdp: await getCDPSession({ page })` argument taught a round-trip
       *     that bought nothing. It is reused when given.
       */
      const getStylesForLocatorFn = async (options: {
        locator: any
        /** Reused when supplied; otherwise one is opened for the locator's page. */
        cdp?: ICDPSession
        /** Include browser default (user-agent) rules in `rules`. Default false. */
        includeUserAgentStyles?: boolean
      }) => {
        const cdp = options.cdp ?? (await getCDPSession({ page: options.locator.page() }))
        return getStylesForLocator({
          locator: options.locator,
          cdp,
          includeUserAgentStyles: options.includeUserAgentStyles,
        })
      }

      const getReactSourceFn = async (options: { locator: any }) => {
        const cdp = await getCDPSession({ page: options.locator.page() })
        return getReactSource({ locator: options.locator, cdp })
      }

      const getReactComponentInfoFn = async (options: { locator: Locator | ElementHandle }) => {
        const targetPage = await (async (): Promise<Page | null> => {
          if ('page' in options.locator) {
            return options.locator.page()
          }

          return (await options.locator.ownerFrame())?.page() ?? null
        })()
        if (!targetPage) {
          throw new Error('Could not get page from locator')
        }
        const cdp = await getCDPSession({ page: targetPage })
        return getReactComponentInfo({ locator: options.locator, cdp })
      }

      // Resolve a { locator } | { node } arg to a Playwright Locator. `node` may be
      // a PageModel handle (carries a `.locator` selector string) or a raw locator.
      const resolveStyleTargetLocator = (options: { locator?: any; node?: any }): Locator => {
        if (options.locator && typeof options.locator.page === 'function') {
          return options.locator
        }
        const node = options.node
        if (node) {
          if (typeof node.page === 'function') return node as Locator
          if (typeof node.locator === 'string') return page.locator(node.locator)
        }
        throw new Error('debugStyle/whyOccluded require a { locator } or a { node } with a locator')
      }

      // Best-effort code-frame for a winning declaration. Fetches the stylesheet
      // text by styleSheetId and renders the source region. Returns null if the
      // text is unavailable — code-frame is a nice-to-have, never required.
      const renderDeclCodeFrame = async (
        cdp: ICDPSession,
        rule: NormalizedRule | undefined,
        message: string,
      ): Promise<string | null> => {
        if (!rule || !rule.styleSheetId || !rule.source) return null
        try {
          const { text } = await cdp.send('CSS.getStyleSheetText', { styleSheetId: rule.styleSheetId })
          if (typeof text !== 'string' || text.length === 0) return null
          return codeFrameColumns(
            text,
            { start: { line: rule.source.line, column: rule.source.column + 1 } },
            { highlightCode: false, message },
          )
        } catch {
          return null
        }
      }

      // Find the NormalizedRule that produced a winning DeclRef (to recover its
      // styleSheetId for code-frames). Matches on selector + source location.
      const findRuleForRef = (rules: NormalizedRule[], ref: DeclRef): NormalizedRule | undefined => {
        return rules.find(
          (r) =>
            r.selector === ref.selector &&
            r.source?.url === ref.source?.url &&
            r.source?.line === ref.source?.line &&
            r.source?.column === ref.source?.column,
        )
      }

      // debugStyle: explain WHY a property has the value it does — the winning
      // declaration plus the ordered losers, with source locations (and, when
      // cheaply available, a code-frame of the winning rule).
      const debugStyle = async (options: { locator?: any; node?: any; property?: string }) => {
        const locator = resolveStyleTargetLocator(options)
        const cdp = await getCDPSession({ page: locator.page() })
        const { rules } = await fetchNormalizedStyles({ locator, cdp })
        const cascade = resolveCascade(rules)

        // Which props to report: the requested one, else contested props (a real
        // conflict), else all winners.
        const allProps = Object.keys(cascade.winnerFor)
        let properties: string[]
        if (options.property) {
          properties = allProps.includes(options.property) ? [options.property] : []
        } else {
          const contested = allProps.filter((p) => (cascade.losersFor[p]?.length ?? 0) > 0)
          properties = contested.length > 0 ? contested : allProps
        }

        const propertiesReport: Record<
          string,
          { winner: DeclRef; losers: DeclRef[] }
        > = {}
        for (const prop of properties) {
          propertiesReport[prop] = {
            winner: cascade.winnerFor[prop],
            losers: cascade.losersFor[prop] ?? [],
          }
        }

        let text = formatCascadeReport({
          winnerFor: cascade.winnerFor,
          losersFor: cascade.losersFor,
          properties,
        })

        // Code-frame the single requested winner when one property is targeted.
        if (options.property && properties.length === 1) {
          const winner = cascade.winnerFor[options.property]
          const winRule = findRuleForRef(rules, winner)
          const frame = await renderDeclCodeFrame(cdp, winRule, `${options.property}: ${winner.value} (winner)`)
          if (frame) {
            text = `${text}\n\n${frame}`
          }
        }

        return { properties: propertiesReport, text }
      }

      /**
       * Build (or rebuild) the PageModel for a page, diffing against the previous
       * per-page model so `changedSince` markers are populated. Caches on lastPageModel.
       *
       * `rootSelector` is a **Playwright** selector and scopes what is FETCHED. It is a
       * different language from `query({ within })`, a page-path selector over the tree
       * that already exists. `scope` is the deprecated alias each layer still accepts;
       * it is passed straight through so `buildPageModel`'s own disagreement check (not a
       * silent pick here) is the thing that reports a conflict.
       */
      type BuildPageModelOptions = { page?: Page; rootSelector?: string; scope?: string }
      const buildPageModelFn = async (options?: BuildPageModelOptions): Promise<PageModel> => {
        const p = options?.page || page
        const cdp = await getCDPSession({ page: p })
        const model = await buildPageModel({
          page: p,
          cdp,
          rootSelector: options?.rootSelector,
          scope: options?.scope,
        })
        const prev = self.lastPageModel.get(p)
        if (prev) model.diffAgainst(prev)
        self.lastPageModel.set(p, model)
        return model
      }

      /**
       * `pm`: lazy per-execute accessor. Builds the page model once (per page + root
       * selector) and reuses it across anchor/query/renderText/debugMode calls in the
       * same turn. Returns only cycle-free projections (handles/rows/strings), never the
       * live model.
       *
       * The cache is keyed by page AND `rootSelector`, because a root-scoped model is a
       * DIFFERENT tree: keying by page alone would let the first call's scope silently
       * decide what every later call in the turn can see.
       */
      const pmModels = new Map<string, PageModel>()
      const pmPageKeys = new WeakMap<Page, number>()
      let pmPageSeq = 0
      const getPmModel = async (opts?: BuildPageModelOptions): Promise<PageModel> => {
        const p = opts?.page || page
        if (!p) {
          throw new Error('pm requires a page')
        }
        let pageKey = pmPageKeys.get(p)
        if (pageKey === undefined) {
          pageKey = ++pmPageSeq
          pmPageKeys.set(p, pageKey)
        }
        // NUL separates the two halves because neither a page id nor a selector can
        // contain it, so no (page, selector) pair can collide with another. It MUST stay
        // written as an escape: a raw NUL byte here makes the whole file read as binary,
        // and grep then skips it in silence — which is exactly how one slipped in.
        const cacheKey = `${pageKey}\u0000${opts?.rootSelector ?? opts?.scope ?? ''}`
        const existing = pmModels.get(cacheKey)
        if (existing) return existing
        const model = await buildPageModelFn({ page: p, rootSelector: opts?.rootSelector, scope: opts?.scope })
        pmModels.set(cacheKey, model)
        return model
      }

      /** Everything `pm.*` accepts for choosing/scoping the model it builds. */
      type PmModelOptions = { page?: Page; rootSelector?: string; scope?: string }
      /**
       * `pm.query`'s options. `within` scopes the QUERY (page-path, over the built tree);
       * `rootSelector` scopes the BUILD (Playwright, before any tree exists). Both are
       * exposed because they answer different questions and neither substitutes for the
       * other.
       *
       * NOTE: an unmatched `within` THROWS, by design — the old behaviour was a silent
       * widen to the whole document, which made a typo indistinguishable from a real
       * empty result. Nothing here catches it: the error propagates out of `execute()`
       * and is reported to the agent verbatim.
       */
      type PmQueryOptions = QueryOptions & PmModelOptions
      /**
       * Strip the build-layer `scope` alias before the options reach `model.query`.
       *
       * `scope` is ONE name for TWO incompatible selector languages, and the wrapper used
       * to hand the same string to both layers: `buildPageModel({ scope })` reads it as
       * `rootSelector`, a **Playwright** selector applied before any tree exists, while
       * `model.query({ scope })` reads it as `within`, a **page-path** selector over the
       * tree that was just built. No string is valid in both, so one of the two was always
       * wrong — and since an unmatched `within` THROWS, a perfectly good
       * `pm.query({ scope: 'main' })` died inside a query scope the caller never asked for.
       *
       * On `pm.*` the alias means `rootSelector`, which is what the docs say and what
       * `pm.anchor` / `pm.renderText` / `pm.debugMode` already did. `within` is how a query
       * is scoped, and it is passed through untouched.
       */
      const queryOptionsOnly = (opts?: PmQueryOptions): QueryOptions | undefined => {
        if (!opts) return opts
        const { scope: _buildScope, rootSelector: _rootSelector, page: _page, ...queryOpts } = opts
        return queryOpts
      }
      const pm = {
        anchor: async (
          selector: string | { backendNodeId: number } | { x: number; y: number; frameId?: string },
          options?: PmModelOptions,
        ): Promise<PageModelHandle | null> => (await getPmModel(options)).anchor(selector),
        /**
         * Ground-truth point hit test (`DOM.getNodeForLocation`), as opposed to
         * `anchor({x, y})`, which INFERS the topmost node from snapshot geometry.
         * `point` is in document coordinates, the same space as `runtime.box`.
         */
        anchorAt: async (
          point: { x: number; y: number },
          options?: PmModelOptions,
        ): Promise<PageModelHandle | null> => (await getPmModel(options)).anchorAt(point),
        query: async (opts?: PmQueryOptions) => (await getPmModel(opts)).query(queryOptionsOnly(opts)),
        renderText: async (
          opts?: { visibleOnly?: boolean; inViewportOnly?: boolean; includeRemoved?: boolean } & PmModelOptions,
        ) => (await getPmModel(opts)).renderText(opts),
        debugMode: async (options?: PmModelOptions) => (await getPmModel(options)).debugMode(),
      }
      const queryPage = async (opts?: PmQueryOptions) => (await getPmModel(opts)).query(queryOptionsOnly(opts))

      /** Stacking-relevant declarations, reported to EXPLAIN the ground-truth flag. */
      const STACKING_PROPS = [
        'z-index',
        'position',
        'opacity',
        'transform',
        'filter',
        'mix-blend-mode',
        'isolation',
        'will-change',
        'pointer-events',
        'clip-path',
      ]
      /** Declarations that mean an occluder's bounds rectangle is not the shape it paints. */
      const SHAPE_DISTORTING_PROPS = ['clip-path', 'transform', 'filter', 'border-radius']

      /**
       * whyOccluded: is something painting over this element, and what?
       *
       * Three DIFFERENT kinds of evidence, kept separate on purpose rather than collapsed
       * into one confident-sounding verdict:
       *
       *   1. `occluded` / `occludedBy` / `occludedFraction` — an INFERENCE from the layout
       *      snapshot's paint order and bounds containment. It is wrong exactly when the
       *      painted shape is not the bounds rectangle (`clip-path`, `border-radius`,
       *      rotated/skewed transforms), when the covering node paints nothing, and for
       *      overlays living in another frame (bounds are per-frame coordinates).
       *   2. `hitTest` — GROUND TRUTH from `DOM.getNodeForLocation` at the element's box
       *      centre. One point, so it cannot see partial coverage; but when it disagrees
       *      with (1) it is the one that is right.
       *   3. `stackingContext` / `stackingReasons` — the flag is Chromium's own, read off
       *      the layout tree; the reasons (and `stacking` below) are the DECLARATIONS that
       *      explain it. The declarations never decide the flag.
       */
      const whyOccluded = async (options: { locator?: any; node?: any; page?: Page }) => {
        const locator = resolveStyleTargetLocator(options)
        const targetPage: Page = options.page ?? locator.page()
        const cdp = await getCDPSession({ page: targetPage })
        const { rules } = await fetchNormalizedStyles({ locator, cdp })
        const cascade = resolveCascade(rules)

        const stacking: Record<string, { value: string; selector: string; important: boolean; source: DeclRef['source'] }> =
          {}
        for (const prop of STACKING_PROPS) {
          const ref = cascade.winnerFor[prop]
          if (ref) {
            stacking[prop] = { value: ref.value, selector: ref.selector, important: ref.important, source: ref.source }
          }
        }

        // Join the element to the measured model. A handle from THIS turn resolves by key;
        // otherwise fall back to the locator string the model indexes nodes under.
        const model = await getPmModel({ page: targetPage })
        const handleKey = typeof options.node?.key === 'string' ? options.node.key : null
        const selector: string | undefined =
          (typeof options.node?.locator === 'string' ? options.node.locator : undefined) ??
          (typeof locator.selector === 'function' ? locator.selector() : undefined)
        const modelNode =
          (handleKey ? model.byKey.get(handleKey as never) : undefined) ??
          (selector ? (model.anchor(selector) ? model.byKey.get(model.anchor(selector)!.key) : undefined) : undefined)

        const runtime = modelNode?.runtime
        const box = runtime?.box ?? null

        // Ground-truth tiebreak: who actually receives a hit at the box centre?
        let hitTest: { key: string; label: string; isTarget: boolean } | null = null
        let hitTestError: string | null = null
        if (box && box.width > 0 && box.height > 0) {
          try {
            const hit = await model.anchorAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
            if (hit) {
              hitTest = {
                key: hit.key,
                label: `${hit.role ?? hit.tag}${hit.name ? ` "${hit.name}"` : ''}`,
                isTarget: hit.key === modelNode!.key,
              }
            }
          } catch (e) {
            // A hit test that could not run is reported, never silently treated as "clear".
            hitTestError = e instanceof Error ? e.message : String(e)
          }
        }

        const occludedBy = runtime?.occludedBy ?? []
        const occludedByLabels = runtime?.occludedByLabels ?? []
        const distorting = SHAPE_DISTORTING_PROPS.filter((p) => {
          const v = cascade.winnerFor[p]?.value
          return v != null && v !== 'none' && v !== '0px'
        })

        const lines: string[] = []
        if (!modelNode) {
          lines.push(
            'NOT IN THE PAGE MODEL: this element is not in the measured tree (a11y-only node, ' +
              'user-agent shadow content, or a locator the model does not index), so occlusion ' +
              'could not be computed. Only the declared stacking inputs below are real.',
          )
        } else if (runtime?.visible === undefined) {
          lines.push('UNMEASURED: this node has no geometry, so occlusion is unknown — not "clear".')
        } else if (runtime.occluded) {
          lines.push(
            `INFERRED ${runtime.occluded.toUpperCase()} occlusion — ~${Math.round((runtime.occludedFraction ?? 0) * 100)}% of the box is covered by: ` +
              (occludedByLabels.length ? occludedByLabels.join(', ') : occludedBy.join(', ')),
          )
        } else {
          lines.push('No covering node found by the geometric pass.')
        }
        if (hitTest) {
          lines.push(
            hitTest.isTarget
              ? `HIT TEST (ground truth) at the box centre lands on the element itself.`
              : `HIT TEST (ground truth) at the box centre lands on ${hitTest.label} [${hitTest.key}] — that is what a click hits.`,
          )
        } else if (hitTestError) {
          lines.push(`HIT TEST could not run: ${hitTestError}`)
        }
        if (distorting.length) {
          lines.push(
            `CAUTION: ${distorting.join(', ')} present — the painted shape is not the bounds rectangle, ` +
              'so the geometric occlusion inference above can be wrong in either direction. Trust the hit test.',
          )
        }
        lines.push(
          `stacking context: ${runtime?.stackingContext === undefined ? 'unmeasured' : runtime.stackingContext}` +
            (runtime?.stackingReasons?.length ? ` (${runtime.stackingReasons.join(', ')})` : ''),
        )
        const cascadeText = formatCascadeReport({
          element: 'stacking-relevant declarations',
          winnerFor: cascade.winnerFor,
          losersFor: cascade.losersFor,
          properties: Object.keys(stacking),
        })

        return {
          /** INFERENCE: `'partial'` | `'full'` | null. null also covers "unmeasured". */
          occluded: runtime?.occluded ?? null,
          /** INFERENCE: keys of the covering nodes, topmost first. */
          occludedBy,
          /** `tag#id.class` for each `occludedBy` entry, same order. */
          occludedByLabels,
          /** INFERENCE: estimated covered fraction of the box (0..1). */
          occludedFraction: runtime?.occludedFraction ?? null,
          /** GROUND TRUTH: what `DOM.getNodeForLocation` returns at the box centre. */
          hitTest,
          hitTestError,
          /** GROUND TRUTH from the layout tree; `null` when the node was not measured. */
          stackingContext: runtime?.stackingContext ?? null,
          /** The declarations that EXPLAIN `stackingContext`. They do not decide it. */
          stackingReasons: runtime?.stackingReasons ?? [],
          /** Declared props that make the bounds rectangle an unreliable proxy for the paint. */
          shapeDistortingProps: distorting,
          /** The element's own stacking-relevant declarations, with source locations. */
          stacking,
          position: cascade.winnerFor['position']?.value ?? null,
          zIndex: cascade.winnerFor['z-index']?.value ?? null,
          box,
          /** false when the element could not be joined to the measured model at all. */
          measured: !!runtime,
          text: `${lines.join('\n')}\n\n${cascadeText}`,
        }
      }

      const inspectPinnedElement = async (pageUrl: string, elementExpression: string) => {
        const targetPage = context.pages().find((candidate) => candidate.url() === pageUrl) || context.pages()[0]
        if (!targetPage) {
          throw new Error('No Playwright pages are available')
        }

        this.userState.page = targetPage
        const handle = (await targetPage.evaluateHandle((expression) => {
          return Function(`return (${expression})`)()
        }, elementExpression)).asElement()

        const result = await (async () => {
          if (!handle) {
            return { url: targetPage.url(), outerHTML: null, react: null }
          }
          return {
            url: targetPage.url(),
            outerHTML: await handle.evaluate((el) => el.outerHTML),
            react: await getReactComponentInfoFn({ locator: handle }),
          }
        })()

        console.log(result)
        return result
      }

      const screenshotCollector: ScreenshotResult[] = []
      // Separate collector for images produced by resizeImageForAgent() calls.
      // These get merged into result.images so the CLI can emit them via Kitty Graphics.
      const resizedImageCollector: Array<{ data: string; mimeType: string }> = []

      const resizeImageForAgentFn: typeof resizeImageForAgent = async (options) => {
        const result = await resizeImageForAgent(options)
        resizedImageCollector.push({ data: result.buffer.toString('base64'), mimeType: result.mimeType })
        return result
      }

      const screenshotWithAccessibilityLabelsFn = async (options: { page: Page; interactiveOnly?: boolean }) => {
        return screenshotWithAccessibilityLabels({
          ...options,
          collector: screenshotCollector,
          logger: {
            info: (...args) => {
              this.logger.error('[playwriter]', ...args)
            },
            error: (...args) => {
              this.logger.error('[playwriter]', ...args)
            },
          },
        })
      }

      // Screen recording functions (via chrome.tabCapture in extension - survives navigation)
      // Recording uses chrome.tabCapture which requires activeTab permission.
      // This permission is granted when the user clicks the Playwriter extension icon on a tab.
      const relayPort = this.cdpConfig.port || 19988
      const self = this
      const ghostCursorController = this.ghostCursorController

      const showGhostCursor = async (options?: ({ page?: Page } & GhostCursorClientOptions)) => {
        const targetPage = options?.page || page
        const cursorOptions: GhostCursorClientOptions | undefined = (() => {
          if (!options) {
            return undefined
          }

          const { page: _ignoredPage, ...rest } = options
          return rest
        })()

        await ghostCursorController.show({ page: targetPage, cursorOptions })
      }

      const hideGhostCursor = async (options?: { page?: Page }) => {
        const targetPage = options?.page || page
        await ghostCursorController.hide({ page: targetPage })
      }

      // Human pointer motion. OFF unless called: a real trajectory fires mouseover on
      // everything it crosses, which is a behaviour change, not a visual nicety.
      const humanMouse = createHumanMouseApi({
        defaultPage: page,
        getCdpSession: getCDPSession,
      })

      const recordingApi = createRecordingApi({
        context,
        defaultPage: page,
        relayPort,
        ghostCursorController,
        onStart: () => {
          self.recordingStartedAt = Date.now()
          self.executionTimestamps = []
        },
        onFinish: () => {
          self.recordingStartedAt = null
          self.executionTimestamps = []
        },
        getExecutionTimestamps: () => {
          return self.executionTimestamps
        },
      })

      // Ghost Browser API - creates chrome object that mirrors Ghost Browser's APIs
      // See extension/src/ghost-browser-api.d.ts for full API documentation
      const chromeGhostBrowser = createGhostBrowserChrome(async (namespace, method, args) => {
        const cdp = await getCDPSession({ page })
        const result = await cdp.send('ghost-browser' as any, { namespace, method, args })
        const typed = result as GhostBrowserCommandResult
        if (!typed.success) {
          throw new Error(typed.error || `Ghost Browser API call failed: ${namespace}.${method}`)
        }
        return typed.result
      })


      // ---- M4: runtime-debug / trace lane wiring ---------------------------
      // Reuse one Debugger per page (logpoints, script-source, captureArgs).
      const getDebuggerForPage = async (targetPage?: Page): Promise<Debugger> => {
        const p = targetPage || page
        const existing = self.debuggerCache.get(p)
        if (existing) return existing
        const cdp = await getCDPSession({ page: p })
        const dbg = new Debugger({ cdp })
        self.debuggerCache.set(p, dbg)
        return dbg
      }

      /**
       * The root a module graph is built over when the caller does not name one.
       *
       * `traceValue` in trace.ts falls back to `process.cwd()`, which is the RELAY
       * SERVER's directory, not the session's — so the default is resolved here, before
       * the option ever reaches trace.ts, and the session cwd wins.
       */
      const defaultGraphRoot = (): string => self.sessionCwd ?? process.cwd()

      // Lazily build + cache the module graph for a root (defaults to session cwd).
      const getModuleGraph = (root?: string): ModuleGraph => {
        const key = root ?? defaultGraphRoot()
        const cached = self.moduleGraphCache.get(key)
        if (cached) return cached
        const graph = buildModuleGraph({ root: key })
        self.moduleGraphCache.set(key, graph)
        return graph
      }

      /**
       * Hand the sandbox an OPAQUE handle to the (cached) module graph. Reuses
       * `moduleGraphCache`, so a graph parsed by `traceValue` earlier in the session is
       * the same object `backwardSlice` / `inspectBinding` get here.
       */
      const handlesByRoot = new Map<string, ModuleGraphHandle>()
      const moduleGraphFn = (options?: { root?: string }): ModuleGraphHandle => {
        const root = options?.root ?? defaultGraphRoot()
        const existing = handlesByRoot.get(root)
        if (existing) return existing
        const graph = getModuleGraph(root)
        const handle: ModuleGraphHandle = {
          root: graph.root,
          fileCount: graph.files.length,
          summary: () => graph.summary(),
        }
        graphByHandle.set(handle, graph)
        handlesByRoot.set(root, handle)
        return handle
      }

      /** `{ code }` or `{ file, graph }` — the source the static helpers analyse. */
      type SandboxSourceRef = { code?: string; file?: string; graph?: unknown }
      const resolveSourceRef = (opts: SandboxSourceRef, who: string): { code?: string; file?: string; graph?: ModuleGraph } => {
        if (opts.code != null) return { code: opts.code, file: opts.file }
        return { file: opts.file, graph: unwrapGraph(opts.graph, who) }
      }

      const setLogpointFn = async (options: {
        page?: Page
        file: string
        line: number
        expr: string
        tag?: string
        /** Cap on the JSON payload, applied IN the page. Over-cap payloads log a visible cut. */
        maxPayload?: number
      }) => {
        const dbg = await getDebuggerForPage(options.page)
        // setLogpoint THROWS when `expr` cannot be assembled into a provably non-pausing
        // condition. That error is the whole point of the check, so it propagates
        // untouched — a swallowed refusal here would install nothing and read as success.
        return dbg.setLogpoint({
          file: options.file,
          line: options.line,
          expr: options.expr,
          tag: options.tag,
          maxPayload: options.maxPayload,
        })
      }

      const getScriptSourceByUrlFn = async (options: { page?: Page; url: string }) => {
        const dbg = await getDebuggerForPage(options.page)
        return dbg.getScriptSourceByUrl({ url: options.url })
      }

      /**
       * Returns the full `LogpointRead` — `{ hits, totalHits, droppedHits, malformedHits,
       * unparsableLines, caps, linesScanned, cursor }`, NOT a bare array. The accounting
       * fields are what make a capped window honest, so the wrapper never strips them
       * down to `hits`.
       */
      const readLogpointsFn = async (options?: {
        page?: Page
        tag?: string
        sinceCursor?: number
        maxHits?: number
        maxLen?: number
      }) => {
        return readLogpoints({
          getLogs: async () => getLatestLogs({ page: options?.page }),
          tag: options?.tag,
          sinceCursor: options?.sinceCursor,
          maxHits: options?.maxHits,
          maxLen: options?.maxLen,
        })
      }

      /**
       * Returns the discriminated union verbatim. The `measured: false` arm has NO
       * `sameReference` field, and it must stay that way: flattening the two arms into one
       * shape is exactly how "I never found your store" used to read as "your store
       * correctly produced a new reference".
       */
      const storeIdentityFn = async (options: { page?: Page; action: () => Promise<void> | void; storeExpr?: string }) => {
        const p = options.page || page
        return storeIdentity({ page: p, action: options.action, storeExpr: options.storeExpr })
      }

      /** Stable per-page CDP adapter, so `net.delay`'s owner-identity guard can work. */
      const getNetDelayCdp = async (p: Page): Promise<ICDPSession> => {
        const existing = self.netDelayCdpCache.get(p)
        if (existing) return existing
        const cdp = await getCDPSession({ page: p })
        self.netDelayCdpCache.set(p, cdp)
        return cdp
      }

      const netFns = {
        timeline: (options?: {
          page?: Page
          urlPattern?: string | RegExp
          /**
           * Fill THIS array instead of a private one. The probe pushes into it in place,
           * so `state.entries = []; net.timeline({ page, buffer: state.entries })` keeps
           * the capture readable from later execute() calls without going through the
           * registry. `netTimeline` has always supported it; the wrapper dropped it.
           */
          buffer?: NetEntry[]
          maxEntries?: number
        }) => {
          const p = options?.page || page
          self.traceProbeOwners.add(p)
          return netTimeline({
            page: p,
            urlPattern: options?.urlPattern,
            buffer: options?.buffer,
            maxEntries: options?.maxEntries,
          })
        },
        delay: async (options: {
          page?: Page
          /**
           * A SUBSTRING of the url, or a RegExp — exactly what `net.timeline` means by
           * the same option name. It is NOT a `Fetch.enable` glob: passing `'/api/'`
           * used to intercept ZERO requests while the probe still announced itself
           * LIVE and PERTURBING, so a race-class measurement reported clean having
           * perturbed nothing. `stats().interceptedNothing` now reports that case.
           */
          urlPattern: string | RegExp
          ms: number
          /** Auto-stop after this long. `0` disables the expiry and is recorded as unbounded. */
          ttlMs?: number
          /** Take over from a live `net.delay` on the same page instead of being refused. */
          force?: boolean
        }) => {
          const p = options.page || page
          const cdp = await getNetDelayCdp(p)
          self.traceProbeOwners.add(cdp)
          return netDelay({
            cdp,
            urlPattern: options.urlPattern,
            ms: options.ms,
            ttlMs: options.ttlMs,
            force: options.force,
          })
        },
        /**
         * The session probe registry. A controller that went out of scope at the end of an
         * `execute()` call is still listed here, still readable, and still stoppable —
         * which is the trap the registry exists to remove.
         */
        active: (opts?: { live?: boolean; kind?: 'net.timeline' | 'net.delay' }) => listTraceProbes(opts),
        /**
         * One probe's accounting by id — spec, stats, live/stopped and why it stopped.
         * `net.active()` had to be filtered by hand to answer that, and the only direct
         * route to it was `traceProbes.get`, an exported namespace nothing ever imported.
         * Returns null for an unknown id rather than throwing: asking about a probe that
         * no longer exists is a normal question.
         */
        get: (id: string) => getTraceProbe(id),
        read: (id: string) => readTraceProbe(id),
        stop: (id: string) => stopTraceProbe(id),
        /**
         * Stops only the probes THIS session armed. The registry is module-level and
         * shared by every session in the relay process, so an unfiltered stopAll would
         * silently disarm another agent's measurement mid-run.
         */
        stopAll: async (opts?: { kind?: 'net.timeline' | 'net.delay' }) => {
          const stopped: string[] = []
          for (const owner of self.traceProbeOwners) {
            stopped.push(...(await stopAllTraceProbes({ owner, kind: opts?.kind })))
          }
          return stopped
        },
        /** One line per live PERTURBING probe — read this before trusting any timing. */
        warnings: () => tracePerturbationWarnings(),
      }

      /**
       * `identity: true` adds page-side identity tokens for every object/function prop.
       * That is the ONLY way handler-identity churn survives the process boundary: the
       * default serialisation renders every function as `[function]`, so two different
       * arrows look identical to `fiberDiff`.
       */
      const fiberSnapshotFn = async (options: {
        locator: Locator | ElementHandle
        identity?: boolean
        maxKeys?: number
        maxDepth?: number
      }) => {
        const targetPage = await (async (): Promise<Page | null> => {
          if ('page' in options.locator) return options.locator.page()
          return (await options.locator.ownerFrame())?.page() ?? null
        })()
        if (!targetPage) throw new Error('Could not get page from locator')
        const cdp = await getCDPSession({ page: targetPage })
        if (options.identity) {
          return fiberSnapshot({
            locator: options.locator,
            cdp,
            identity: true,
            maxKeys: options.maxKeys,
            maxDepth: options.maxDepth,
          })
        }
        return fiberSnapshot({ locator: options.locator, cdp })
      }

      // ---- static-analysis lane -------------------------------------------
      // The NodePath-level primitives (analyzeBinding, probeValue, exhaustiveDeps,
      // classifyDeopt, …) stay unexposed: they take and return live Babel objects. These
      // six are the serialisable entry points built over them.

      const inspectBindingFn = (opts: SandboxSourceRef & { name: string; occurrence?: number }) =>
        inspectBinding({ ...resolveSourceRef(opts, 'inspectBinding'), name: opts.name, occurrence: opts.occurrence })

      const evaluateBindingFn = (opts: SandboxSourceRef & { name: string; occurrence?: number }) =>
        evaluateBinding({ ...resolveSourceRef(opts, 'evaluateBinding'), name: opts.name, occurrence: opts.occurrence })

      const findMissingDepsFn = (
        opts: SandboxSourceRef & { hooks?: string[]; max?: number; withCodeFrames?: boolean },
      ) =>
        findMissingDeps({
          ...resolveSourceRef(opts, 'findMissingDeps'),
          hooks: opts.hooks,
          max: opts.max,
          withCodeFrames: opts.withCodeFrames,
        })

      const backwardSliceFn = (opts: {
        graph?: unknown
        root?: string
        startFile: string
        /** A variable NAME (`'count'`), never a path or an expression. */
        startExpr: string
        maxHops?: number
        maxBreadth?: number
      }) => {
        // `graph` is optional here (unlike the primitive) so the common case is one call:
        // omitting it builds/reuses the graph for the session cwd.
        const graph = opts.graph ? unwrapGraph(opts.graph, 'backwardSlice') : getModuleGraph(opts.root)
        return backwardSlice({
          graph,
          startFile: opts.startFile,
          startExpr: opts.startExpr,
          maxHops: opts.maxHops,
          maxBreadth: opts.maxBreadth,
        })
      }

      // traceValue: orchestrates anchor + static slice + probe arming, returning
      // a cycle-free, token-bounded summary (the render() string + compact blocked
      // leaves), NEVER the live TraceHop tree. The lossless result is retained in
      // the closure so `expand(hopId)` / `runProbe(hopId)` drill without re-tracing.
      const traceValueFn = async (options: any = {}) => {
        const targetPage = options.page || page
        const cdp = targetPage ? await getCDPSession({ page: targetPage }) : undefined
        const dbg = targetPage ? await getDebuggerForPage(targetPage) : undefined
        const deps: TraceDeps = {
          page: targetPage ?? undefined,
          cdp,
          dbg,
          getLogs: async () => getLatestLogs({ page: targetPage }),
          buildGraph: ({ root }) => getModuleGraph(root),
          action: options.action,
          storeExpr: options.storeExpr,
          urlPattern: options.urlPattern,
        }
        // Default `root` HERE, not in trace.ts: its own fallback is `process.cwd()`, the
        // relay server's directory, which would parse a module graph over the wrong tree.
        const result = await traceValue({ ...options, root: options.root ?? defaultGraphRoot(), deps })
        return {
          /**
           * A METHOD, not a precomputed string — `render({ maxLines, codeFrames })`
           * belongs to the caller. Rendering eagerly is also what forced two different
           * docs to disagree about whether this was a property or a call.
           */
          render: (opts?: RenderOptions) => result.render(opts),
          anchor: result.anchor,
          blocked: result.blocked.map((b) => ({
            id: b.id,
            blockedBy: b.blockedBy,
            site: b.site,
            hazards: b.hazards,
            note: b.note,
            codeFrame: b.codeFrame,
            probe: b.probe ? { type: b.probe.type, passive: b.probe.passive, spec: b.probe.spec } : null,
          })),
          /**
           * A BOUNDED SUBTREE in one call — `TraceSubtree` is already cycle-free, JSON-safe
           * and depth/node-capped, and it reports `omittedChildren` / `complete` so a cut
           * is never invisible. The old wrapper flattened children to a `childCount`, which
           * cost one round-trip per level for no safety gain.
           */
          expand: (hopId: string, opts?: { depth?: number; maxNodes?: number }) => result.expand(hopId, opts),
          /** Every hop id, so a hop can be addressed without walking the tree. */
          hopIds: result.hopIds,
          /** Live perturbing probes + unhandled blind spots. Read before trusting timings. */
          warnings: result.warnings,
          runProbe: async (hopId: string) => {
            const leaf = result.blocked.find((b) => b.id === hopId)
            if (!leaf?.probe) throw new Error(`no probe armed at hop ${hopId}`)
            return leaf.probe.run()
          },
        }
      }

      // --- gesture-free CDP screencast (direct-CDP mode only) ---
      // NOTE: the handle lives on the executor instance, NOT in this closure —
      // `execute()` runs fresh per call, so a closure variable would be reset
      // between `startCdp` and `stopCdp`.

      // `Omit<…, 'cdp'>` rather than a hand-copied option list: the previous inline type
      // silently omitted `mode`, `probeMs` and everything added since, so the sandbox
      // accepted them at runtime while TypeScript claimed they did not exist.
      // `page` is narrowed back to a real Page because this wrapper also needs it to
      // open the CDP session; the recorder itself only ever calls bringToFront() on it.
      const startCdpRecording = async (options: Omit<CdpScreencastOptions, 'cdp' | 'page'> & { page?: Page }) => {
        if (self.cdpScreencast) throw new Error('A CDP screencast is already running; stop it first.')
        const p = options.page || page
        if (!p) throw new Error('No page available to record')
        const cdp = await getCDPSession({ page: p })
        // Pass the page so the screenshot path can foreground the tab. It is always
        // passed, so `mode: 'screenshot'` — and `mode: 'auto'`, the default, whenever it
        // falls back — WILL bringToFront() this tab. The reason is measured, and it is not
        // the "a backgrounded tab has no compositor surface" story this comment used to
        // tell: captureScreenshot on a hidden tab neither fails nor returns stale pixels,
        // it blocks, for up to 26 seconds at a time, collapsing a 10fps poll to ~0.1fps.
        // See the table in `startScreenshotPolling`.
        const handle = await startCdpScreencast({ cdp, page: p, ...options })
        self.cdpScreencast = handle

        // The overlay renders nothing on its own — it draws what this tap feeds it.
        // Attached after the recorder exists so no event can arrive before it can be
        // stamped, and torn down by stopCdp/cancelCdp/disposeBrowserSideResources.
        let inputOverlayNote: string | undefined
        if (options.inputOverlay) {
          const tap = attachInputOverlayTap({
            page: p,
            onAction: (action: InputAction) => handle.inputEvent(action),
          })
          self.cdpScreencastInputDetach = tap.detach
          inputOverlayNote = tap.note
        }

        return {
          started: true,
          outputPath: options.outputPath,
          ...(options.inputOverlay ? { inputOverlay: true } : {}),
          ...(inputOverlayNote ? { note: inputOverlayNote } : {}),
        }
      }

      /** Drop the instrumentation listener. Idempotent; safe to call when none was armed. */
      const detachInputOverlayTap = () => {
        const detach = self.cdpScreencastInputDetach
        self.cdpScreencastInputDetach = null
        try {
          detach?.()
        } catch (e) {
          self.logger.error('Failed to detach the input overlay tap:', e)
        }
      }

      /**
       * Narration is stamped against the LIVE recorder, so it has to reach the same
       * instance `startCdp` created — hence the executor field, same reason as stopCdp.
       * With no recording running there is nothing to attach a caption to, and quietly
       * accepting one would leave the agent believing the video is narrated when it is not.
       */
      const captionCdpRecording = (text: string, opts?: { atMs?: number; durationMs?: number }) => {
        if (!self.cdpScreencast) {
          throw new Error(
            'No CDP screencast is running, so there is nothing to caption. Call recording.startCdp({ outputPath }) first.',
          )
        }
        return self.cdpScreencast.caption(text, opts)
      }

      const clearCdpCaption = (opts?: { atMs?: number }) => {
        if (!self.cdpScreencast) {
          throw new Error(
            'No CDP screencast is running, so there is no caption to clear. Call recording.startCdp({ outputPath }) first.',
          )
        }
        return self.cdpScreencast.clearCaption(opts)
      }

      /**
       * Pace the recording from the narration itself. Throws with no recorder for the same
       * reason `caption` does: a hold that silently did nothing would leave the agent
       * believing it had spaced the beats out when the clip is still unwatchable.
       */
      const holdCdpRecording = (opts?: { minMs?: number; extraMs?: number }) => {
        if (!self.cdpScreencast) {
          throw new Error(
            'No CDP screencast is running, so there is no caption to hold. Call recording.startCdp({ outputPath }) first.',
          )
        }
        return self.cdpScreencast.hold(opts)
      }

      /**
       * How many frames the live recorder has captured.
       *
       * The handle's `frameCount()` never escaped `startCdpRecording`, so the one
       * question an agent actually asks mid-recording — "is this thing capturing
       * anything at all, or am I about to hand over a `frames: 0` file?" — could only be
       * answered by stopping. The sibling `captionCount()`/`inputEventCount()` stay
       * unexposed on purpose: both are fully reported in `stopCdp()`'s result
       * (`captions[]`, `inputEvents[]`), and neither changes what you would do next.
       */
      const cdpRecordingFrameCount = (): number => {
        if (!self.cdpScreencast) {
          throw new Error(
            'No CDP screencast is running, so there are no frames to count. Call recording.startCdp({ outputPath }) first.',
          )
        }
        return self.cdpScreencast.frameCount()
      }

      const stopCdpRecording = async () => {
        if (!self.cdpScreencast) throw new Error('No CDP screencast is running')
        const handle = self.cdpScreencast
        self.cdpScreencast = null
        // Before stop(), so an action still in flight cannot stamp onto a stopped recorder.
        detachInputOverlayTap()
        return handle.stop()
      }

      const cancelCdpRecording = async () => {
        if (!self.cdpScreencast) return { cancelled: false }
        const handle = self.cdpScreencast
        self.cdpScreencast = null
        detachInputOverlayTap()
        await handle.cancel()
        return { cancelled: true }
      }

      let vmContextObj: any = {
        page,
        context,
        browser: this.browser,
        state: this.userState,
        console: customConsole,
        snapshot,
        accessibilitySnapshot: snapshot, // backward compat alias
        refToLocator,
        // Wrapped only to pin the diff baseline to THIS session — see `lastCleanHtml`.
        getCleanHTML: getCleanHTMLFn,
        getPageMarkdown: getPageMarkdownFn,
        getLocatorStringForElement,
        getLatestLogs,
        clearAllLogs,
        waitForPageLoad,
        getCDPSession,
        createDebugger,
        createEditor,
        getStylesForLocator: getStylesForLocatorFn,
        formatStylesAsText,
        debugStyle,
        whyOccluded,
        getReactSource: getReactSourceFn,
        getReactComponentInfo: getReactComponentInfoFn,
        // M4 runtime-debug / trace lane
        traceValue: traceValueFn,
        setLogpoint: setLogpointFn,
        getScriptSourceByUrl: getScriptSourceByUrlFn,
        readLogpoints: readLogpointsFn,
        storeIdentity: storeIdentityFn,
        net: netFns,
        fiberSnapshot: fiberSnapshotFn,
        fiberDiff,
        replayPure,
        replayPureAsync,
        // M5 static-analysis lane: the six serialisable entry points. The NodePath-level
        // primitives behind them stay unexposed — they take and return live Babel objects.
        inspectBinding: inspectBindingFn,
        evaluateBinding: evaluateBindingFn,
        findMissingDeps: findMissingDepsFn,
        isPureFunctionSource,
        backwardSlice: backwardSliceFn,
        moduleGraph: moduleGraphFn,
        // NOTE: `buildPageModelFn` is deliberately NOT a sandbox global. It returns the
        // LIVE PageModel (byKey map, full node tree), and `pm.*` exists precisely so
        // sandbox code only ever sees bounded, cycle-free projections. `rootSelector` is
        // reachable through every `pm.*` call instead.
        pm,
        queryPage,
        inspectPinnedElement,
        screenshotWithAccessibilityLabels: screenshotWithAccessibilityLabelsFn,
        resizeImageForAgent: resizeImageForAgentFn,
        // Backward-compatible alias for resizeImageForAgent
        resizeImage: resizeImageForAgentFn,
        ghostCursor: {
          show: showGhostCursor,
          hide: hideGhostCursor,
        },
        // Opt-in human pointer motion (Fitts + minimum-jerk + corrective submovements).
        // Moves the REAL pointer along the path, so it fires mouseover/mouseenter on
        // every element in between — see the skill docs before enabling it on a suite.
        humanMouse,
        recording: {
          start: recordingApi.start,
          stop: recordingApi.stop,
          isRecording: recordingApi.isRecording,
          cancel: recordingApi.cancel,
          // Gesture-free recorder — no extension-icon click required. Works on
          // extension-connected sessions as well as direct CDP, and does NOT need a
          // foreground tab: measured through the extension, a backgrounded tab
          // captured 31 frames against 30 in the foreground.
          startCdp: startCdpRecording,
          stopCdp: stopCdpRecording,
          cancelCdp: cancelCdpRecording,
          // Narration for a repro nobody watched live. Burned into the pixels by
          // default, because the players a clip gets pasted into show no soft track.
          caption: captionCdpRecording,
          clearCaption: clearCdpCaption,
          // Pacing, taken from the caption text rather than from a guessed sleep. The
          // reason the recorder owns this instead of the caller writing setTimeout: only
          // the recorder knows how long the cue currently on screen needs to be read.
          hold: holdCdpRecording,
          // "Is it actually capturing?" — answerable mid-recording instead of only after
          // stopCdp() hands back a file with frames: 0.
          frameCount: cdpRecordingFrameCount,
        },
        // Backward-compatible aliases
        startRecording: recordingApi.start,
        stopRecording: recordingApi.stop,
        isRecording: recordingApi.isRecording,
        cancelRecording: recordingApi.cancel,
        createDemoVideo,
        resetPlaywright: async () => {
          const { page: newPage, context: newContext } = await self.reset()
          vmContextObj.page = newPage
          vmContextObj.context = newContext
          vmContextObj.browser = self.browser
          return { page: newPage, context: newContext }
        },
        require: this.sandboxedRequire,
        // There is deliberately NO `import` global.
        //
        // A raw `import: (specifier) => import(specifier)` used to sit on this line, one
        // line after the allowlisted `require`, with no allowlist of its own:
        // `globalThis.import('node:child_process').execSync('id -un')` ran a shell, and
        // `globalThis.import('node:fs')` returned the RAW fs module, past the ScopedFS
        // write jail. It is gone rather than allowlisted because it was never callable
        // by ordinary sandbox code in the first place:
        //   - `import` is a reserved word, so it cannot be written as a bare identifier;
        //   - `import(specifier)` in sandbox source parses as the syntactic dynamic-import
        //     form, which never consults the globals and fails in a vm context with
        //     "A dynamic import callback was not specified";
        // so the ONLY expression that ever reached it was `globalThis.import(...)`, which
        // is the escape spelling and nothing else. Nothing in this repo — src, tests,
        // docs, skill.md — referenced it, and every entry in ALLOWED_MODULES is a Node
        // built-in that `require` already loads, so removing it costs no capability.
        // `src/skill.md` has always documented `import` as unavailable; now that is true.
        // Ghost Browser API - only works in Ghost Browser, mirrors chrome.ghostPublicAPI etc
        chrome: chromeGhostBrowser,
        ...usefulGlobals,
        /**
         * `process`, exposed because scripts legitimately read `env`, `platform`, `argv`
         * and `version` — and simultaneously the richest single source of host capability
         * in the sandbox, so the proxy is a DENY LIST, not the two overrides it began as.
         *
         * Kept from before: `cwd()` reports the SESSION's cwd (the raw one is the relay
         * server's), `exit()` and `chdir()` are refused.
         *
         * Added because each was a live escape, verified by running it:
         *   - `getBuiltinModule(id)` is a module loader that consulted no allowlist at
         *     all: `process.getBuiltinModule('child_process')` ran a shell and
         *     `process.getBuiltinModule('fs')` returned the raw, unjailed fs. It now
         *     routes through `sandboxedRequire`, so an allowed module comes back as the
         *     SAME object `require` hands out — `fs` is the one ScopedFS instance, never
         *     the real module.
         *   - everything in DENIED_PROCESS_METHODS / DENIED_PROCESS_PROPERTIES above.
         *
         * Writes are refused outright. Only `get` was trapped before, so the default
         * traps reached the real process object: `delete process.exit` removed the HOST's
         * own exit function, and `process.exitCode = 1` set the relay's exit status.
         *
         * `process.env` is deliberately still the live host object — sandbox scripts read
         * it, and it is data rather than capability. It stays readable AND writable, and
         * `src/skill.md` says so; do not mistake this proxy for env isolation.
         */
        process: new Proxy(process, {
          get(target, prop, receiver) {
            if (prop === 'cwd') return () => self.sessionCwd || target.cwd()
            if (prop === 'exit') return () => { throw new Error('process.exit() is not allowed in the sandbox') }
            if (prop === 'chdir') return () => { throw new Error('process.chdir() is not allowed in the sandbox, use a new session with a different cwd instead') }
            if (prop === 'getBuiltinModule') return (id: string) => self.sandboxedRequire(id)
            if (typeof prop === 'string' && DENIED_PROCESS_PROPERTIES.has(prop)) return undefined
            if (typeof prop === 'string' && DENIED_PROCESS_METHODS.has(prop)) {
              return () => {
                throw new Error(`process.${prop}() is not allowed in the sandbox`)
              }
            }
            return Reflect.get(target, prop, receiver)
          },
          set(_target, prop) {
            throw new Error(
              `Cannot assign to process.${String(prop)}: the sandbox process object is read-only. ` +
                `(process.env is a live host object and is still writable.)`,
            )
          },
          defineProperty(_target, prop) {
            throw new Error(`Cannot define process.${String(prop)}: the sandbox process object is read-only`)
          },
          deleteProperty(_target, prop) {
            throw new Error(`Cannot delete process.${String(prop)}: the sandbox process object is read-only`)
          },
        }),
      }

    return { vmContextObj, screenshotCollector, resizedImageCollector }
  }

  async execute(code: string, timeout = 10000): Promise<ExecuteResult> {
    const consoleLogs: Array<{ method: string; args: any[] }> = []
    const warningScope = this.beginWarningScope()

    const formatConsoleLogs = (logs: Array<{ method: string; args: any[] }>, prefix = 'Console output') => {
      if (logs.length === 0) {
        return ''
      }
      let text = `${prefix}:\n`
      logs.forEach(({ method, args }) => {
        const formattedArgs = args
          .map((arg) => {
            if (typeof arg === 'string') return arg
            return util.inspect(arg, {
              depth: 4,
              colors: false,
              maxArrayLength: 100,
              maxStringLength: 1000,
              breakLength: 80,
            })
          })
          .join(' ')
        text += `[${method}] ${formattedArgs}\n`
      })
      return text + '\n'
    }

    try {
      // Warn if cloud VM is approaching its hard timeout (deduped by minute bucket)
      if (this.cloudSession?.timeoutAt) {
        const remainingMs = this.cloudSession.timeoutAt - Date.now()
        if (remainingMs <= 0) {
          throw new Error(CLOUD_SESSION_EXPIRED_ERROR)
        }
        if (remainingMs < 5 * 60_000) {
          const mins = Math.ceil(remainingMs / 60_000)
          if (this.lastCloudTimeoutWarningMinute !== mins) {
            this.lastCloudTimeoutWarningMinute = mins
            this.enqueueWarning(
              `Cloud browser expires in ~${mins} minute${mins === 1 ? '' : 's'}. ` +
                `Create a new session soon with: playwriter session new --browser cloud`,
            )
          }
        }
      }

      await this.ensureConnection()
      const page = await this.getCurrentPage(timeout)
      const context = this.context || page.context()

      this.logger.log('Executing code:', code)

      const { vmContextObj, screenshotCollector, resizedImageCollector } = this.buildSandboxContext({
        page,
        context,
        consoleLogs,
      })

      const vmContext = vm.createContext(vmContextObj)
      const autoReturnExpr = getAutoReturnExpression(code)
      const wrappedCode = autoReturnExpr !== null
        ? `(async () => { return await (${autoReturnExpr}) })()`
        : `(async () => { ${code} })()`
      const hasExplicitReturn = autoReturnExpr !== null || /\breturn\b/.test(code)

      // Track execution timestamps relative to recording start (seconds).
      // Used to identify idle gaps that can be sped up in demo videos.
      // Captured before execution so we can record timing even if it throws.
      const recordingStartSnapshot = this.recordingStartedAt
      const execStartSec = recordingStartSnapshot !== null
        ? (Date.now() - recordingStartSnapshot) / 1000
        : -1

      const result = await (async () => {
        try {
          return await Promise.race([
            vm.runInContext(wrappedCode, vmContext, { timeout, displayErrors: true }),
            new Promise((_, reject) => setTimeout(() => reject(new CodeExecutionTimeoutError(timeout)), timeout)),
          ])
        } finally {
          // Record timestamp even on error — the execution still occupied real time
          // that should not be sped up in the demo video.
          // Compare against snapshot to avoid cross-session contamination if
          // recording was stopped and restarted inside the same execute() call.
          if (recordingStartSnapshot !== null && execStartSec >= 0 && this.recordingStartedAt === recordingStartSnapshot) {
            const execEndSec = (Date.now() - recordingStartSnapshot) / 1000
            this.executionTimestamps.push({ start: execStartSec, end: execEndSec })
          }
        }
      })()

      let responseText = formatConsoleLogs(consoleLogs)

      // Only show return value if user explicitly used return
      if (hasExplicitReturn) {
        const resolvedResult = isPromise(result) ? await result : result
        // Auto-returned Playwright handles (Response, Page, Browser, Request,
        // Frame, etc.) are silently skipped — they're programmatic references,
        // not useful display data. Users can `console.log(response)` or
        // return specific fields (`return response.url()`) to see values.
        // See issue #82.
        if (resolvedResult !== undefined && !isPlaywrightChannelOwner(resolvedResult)) {
          const formatted =
            typeof resolvedResult === 'string'
              ? resolvedResult
              : util.inspect(resolvedResult, {
                  depth: 4,
                  colors: false,
                  maxArrayLength: 100,
                  maxStringLength: 1000,
                  breakLength: 80,
                })
          if (formatted.trim()) {
            responseText += `[return value] ${formatted}\n`
          }
        }
      }

      responseText += this.flushWarningsForScope(warningScope)

      if (!responseText.trim()) {
        responseText = 'Code executed successfully (no output)'
      }

      const MAX_LENGTH = 10000
      let finalText = responseText.trim()
      if (finalText.length > MAX_LENGTH) {
        finalText =
          finalText.slice(0, MAX_LENGTH) +
          `\n\n[Truncated to ${MAX_LENGTH} characters. Use search to find specific content]`
      }

      const images = [
        ...screenshotCollector.map((s) => ({ data: s.base64, mimeType: s.mimeType })),
        ...resizedImageCollector,
      ]
      const screenshots: ExecuteScreenshot[] = screenshotCollector.map((s) => ({
        path: s.path,
        base64: s.base64,
        mimeType: s.mimeType,
        snapshot: s.snapshot,
        labelCount: s.labelCount,
      }))

      return { text: finalText, images, screenshots, isError: false }
    } catch (error: any) {
      const errorStack = error.stack || error.message
      const isTimeoutError =
        error instanceof CodeExecutionTimeoutError || error?.name === 'TimeoutError' || error?.name === 'AbortError'

      this.logger.error('Error in execute:', errorStack)

      const logsText = formatConsoleLogs(consoleLogs, 'Console output (before error)')
      const warningText = this.flushWarningsForScope(warningScope)

      // Cloud sessions: disconnection errors mean the VM expired or was destroyed.
      // Give a clear actionable message instead of a generic "call reset" hint.
      const isDisconnect = error instanceof Error && isDisconnectionError(error)
      const resetHint = (() => {
        if (isTimeoutError) return ''
        if (this.cloudSession && isDisconnect) {
          return `\n\n[Cloud browser expired or disconnected. Create a new session with: playwriter session new --browser cloud]`
        }
        return '\n\n[HINT: If this is an internal Playwright error, page/browser closed, or connection issue, call reset to reconnect.]'
      })()

      // timeout stacks are internal noise (Promise.race / setTimeout); only show the message
      const errorText = isTimeoutError ? error.message : errorStack
      return {
        text: `${logsText}${warningText}\nError executing code: ${errorText}${resetHint}`,
        images: [],
        screenshots: [],
        isError: true,
      }
    }
  }

  // When extension is connected but has no pages, auto-create one.
  // In direct CDP mode, always create a page (no extension check needed).
  private async ensurePageForContext(options: { context: BrowserContext; timeout: number }): Promise<Page> {
    const { context, timeout } = options
    const pages = context.pages().filter((p) => !p.isClosed())
    if (pages.length > 0) {
      return pages[0]
    }

    // Direct CDP mode: always create a new page, no extension involved
    if (this.isDirectCdpMode()) {
      const page = await context.newPage()
      this.setupPageListeners(page)
      await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
      return page
    }

    const extensionStatus = await this.checkExtensionStatus()
    if (!extensionStatus.connected) {
      throw new Error(EXTENSION_NOT_CONNECTED_ERROR)
    }

    const page = await context.newPage()
    this.setupPageListeners(page)
    const pageUrl = page.url()
    if (pageUrl === 'about:blank') {
      return page
    }

    // Avoid burning the full timeout on about:blank-like pages.
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
    return page
  }

  /** Get info about current connection state */
  getStatus(): { connected: boolean; pageUrl: string | null; pagesCount: number } {
    return {
      connected: this.isConnected,
      pageUrl: this.page?.url() || null,
      pagesCount: this.context?.pages().length || 0,
    }
  }

  /** Get keys of user-defined state */
  getStateKeys(): string[] {
    return Object.keys(this.userState)
  }

  getSessionMetadata(): SessionMetadata {
    return this.sessionMetadata
  }

  getSessionInfo({ id }: { id: string }): SessionInfo {
    return {
      id,
      stateKeys: this.getStateKeys(),
      extensionId: this.sessionMetadata.extensionId,
      browser: this.sessionMetadata.browser,
      profile: this.sessionMetadata.profile,
      cwd: this.sessionCwd,
    }
  }
}

/**
 * Session manager for multiple executors, keyed by session ID.
 */
export class ExecutorManager {
  private executors = new Map<string, PlaywrightExecutor>()
  private cdpConfig: CdpConfig | ((sessionId: string) => CdpConfig)
  private logger: ExecutorLogger

  constructor(options: { cdpConfig: CdpConfig | ((sessionId: string) => CdpConfig); logger?: ExecutorLogger }) {
    this.cdpConfig = options.cdpConfig
    this.logger = options.logger || { log: console.log, error: console.error }
  }

  getExecutor(options: {
    sessionId: string
    cwd?: string
    sessionMetadata?: SessionMetadata
    /** Override cdpConfig for this session (e.g. direct CDP connection) */
    cdpConfig?: CdpConfig
    /** Cloud session info (set when connecting to a Browser Use VM) */
    cloudSession?: CloudSessionInfo
  }): PlaywrightExecutor {
    const { sessionId, cwd, sessionMetadata } = options
    let executor = this.executors.get(sessionId)
    if (!executor) {
      const cdpConfig = (() => {
        // Per-session override takes priority (used for direct CDP and headless sessions).
        // Those bypass the relay entirely, so no workspace is merged in: they never reach getCdpUrl.
        if (options.cdpConfig) {
          return options.cdpConfig
        }
        const baseConfig = typeof this.cdpConfig === 'function' ? this.cdpConfig(sessionId) : this.cdpConfig
        // extensionId and workspace are independent: the extension route sets BOTH, so these
        // must accumulate rather than early-return, or whichever is checked second is dropped.
        let config = baseConfig
        if (sessionMetadata?.extensionId) {
          config = { ...config, extensionId: sessionMetadata.extensionId }
        }
        if (sessionMetadata?.workspace) {
          config = { ...config, workspace: sessionMetadata.workspace }
        }
        return config
      })()
      executor = new PlaywrightExecutor({
        cdpConfig,
        sessionMetadata,
        logger: this.logger,
        cwd,
        cloudSession: options.cloudSession,
      })
      this.executors.set(sessionId, executor)
    }
    return executor
  }

  deleteExecutor(sessionId: string): boolean {
    const executor = this.executors.get(sessionId)
    // Fire-and-forget: the caller's contract is synchronous, and teardown must not be
    // able to fail (or stall) a session delete. disposeBrowserSideResources swallows
    // its own errors, so the only thing left to guard is the promise itself.
    if (executor) {
      void executor.disposeBrowserSideResources().catch(() => {})
    }
    return this.executors.delete(sessionId)
  }

  getSession(sessionId: string): PlaywrightExecutor | null {
    return this.executors.get(sessionId) || null
  }

  listSessions(): SessionInfo[] {
    return [...this.executors.entries()].map(([id, executor]) => {
      return executor.getSessionInfo({ id })
    })
  }
}
