/**
 * PlaywrightExecutor - Manages browser connection and code execution per session.
 * Used by both MCP and CLI to execute Playwright code with persistent state.
 */

import type { Page, Frame, Browser, BrowserContext, Locator, FrameLocator, ElementHandle, Download } from '@xmorse/playwright-core'
import { getChromium, isPatchrightEnabled } from './playwright-import.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import util from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'
import * as acorn from 'acorn'
import { SnapshotRevisions } from './snapshot-delta.js'
import { getCdpUrl, parseRelayHost, sleep } from './utils.js'
import type { Workspace } from './workspace-key.js'
import { getExtensionOutdatedWarning, getExtensionStaleError } from './relay-client.js'
import type { WaitForPageLoadResult } from './wait-for-page-load.js'
import { ICDPSession, getCDPSessionForPage, tabTitle } from './cdp-session.js'
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
import { getAriaSnapshot, resizeImageForAgent, DEFAULT_SNAPSHOT_FORMAT, type SnapshotFormat } from './aria-snapshot.js'
import { screenshotWithAccessibilityLabels, type ScreenshotResult } from './labelled-screenshot.js'
import { takeScreenshot, diffScreenshot, BEYOND_VIEWPORT_EVENTS, type ScreenshotDeps } from './page-screenshot.js'
import { createGhostBrowserChrome, type GhostBrowserCommandResult } from './ghost-browser.js'
export type { SnapshotFormat }
import { getCleanHTML, type GetCleanHTMLOptions, type HtmlDiffStore } from './clean-html.js'
import {
  getPageMarkdown,
  extractMarkdownOutline,
  filterMarkdownSections,
  type PageMarkdownRequest,
  type MarkdownDiffStore,
} from './page-markdown.js'
import { createRecordingApi } from './screen-recording.js'
import { crashOf, crashedLine, replaceCrashedPage, watchForCrash } from './page-crash.js'
import { startCdpScreencast, type CdpScreencastHandle, type CdpScreencastOptions, type InputAction } from './cdp-screencast.js'
import { createDemoVideo } from './ffmpeg.js'
import { type GhostCursorClientOptions } from './ghost-cursor.js'
import { GhostCursorController } from './ghost-cursor-controller.js'
import { createHumanMouseApi, type HumanClickOptions, type HumanMouseApi, type HumanMoveOptions } from './human-mouse-driver.js'
import { formatInputLabel } from './cdp-screencast.js'
import { ModelFacingError, type PolicyMode, type SettleResult, type WatchCheckpoint, type WatchEvents } from './probe-types.js'
import { PageProbes, renderLocatedNode, type PageProbe } from './page-probe.js'
import { CUT_WAIT_MS, DebuggerCutAdoption, type ClosedPageVerdict } from './debugger-cut-adoption.js'
import {
  renderObservation,
  renderObservationDiff,
  findInObservation,
  diffObservations,
  type Observation,
  type ObserveOptions,
} from './page-observe.js'
import { PageUnresponsiveError, withDeadline } from './isolated-world.js'
import { hiddenTabNote, unresponsiveDiagnosis, type TabVisibility } from './tab-state.js'
import { parseTabVisibilityStatus, tabIsHidden } from './tab-visibility.js'
import { analyzeCode, checkPolicy, type CodeAnalysis } from './code-policy.js'
import { explainElement, renderExplanation } from './element-explain.js'
import { ActError, BLOCKING_BUSY_KINDS, createActApi, isBlankUrl, renderActionReport, type ActionRecord } from './human-actions.js'
import { createWebMcpApi } from './webmcp.js'
import { refElementTarget, resolveElement, type ElementTarget, type ResolvedElement } from './element-resolve.js'
import { chooserOpener, describeOpener, type ChooserWindow } from './file-chooser-gate.js'
import { outgoingCallsOf, outgoingGuardsOf, openingOwnCdpSession, type OutgoingCallGuard, type OutgoingCallListener } from './playwright-client-hooks.js'
import { callEffect, isRefusedEffect, refusalFor, unclassifiedRefusal } from './playwright-call-effects.js'
import { readPage } from './read-page.js'
import { runAudit, type AuditReport } from './page-audit.js'
import { parseQuery, queryRef, runQuery, type QueryResult } from './page-query.js'
import { createStorageGlobals } from './page-storage.js'
import { SessionDownloads, jailedTarget, type SessionDownload } from './session-downloads.js'
import { requestDetail, writeHar } from './network-detail.js'
import {
  contextOptionsFor,
  copyDownloadsInto,
  describeNewBrowser,
  launchKey,
  launchNewBrowser,
  planNewBrowser,
  type LaunchedNewBrowser,
  type NewBrowserPlan,
} from './new-browser.js'
import type { NewBrowserOptions } from './new-browser-options.js'
import { parseRelayDownloadStatus, type RelayDownloadStatus } from './download-file.js'
import { createPerfGlobals, layoutShiftLines } from './perf.js'
import { createReactGlobals } from './react-tree.js'


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const require = createRequire(import.meta.url)

export class CodeExecutionTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Code execution timed out after ${timeout}ms`)
    this.name = 'CodeExecutionTimeoutError'
  }
}

/** One output cap for the executor and the MCP layer. */
export const MAX_OUTPUT_CHARS = 16000

/** Cut at a line boundary (never mid-line), and say how much was dropped and how to narrow the output. */
export function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text
  }
  const cut = text.lastIndexOf('\n', MAX_OUTPUT_CHARS - 300)
  const kept = text.slice(0, cut > 0 ? cut : MAX_OUTPUT_CHARS - 300)
  return (
    `${kept}\n\n[Output truncated: ${text.length - kept.length} more characters not shown. Narrow it: ` +
    "observe({ scope: ref }), find('text'), snapshot({ search }), or return only the fields you need.]"
  )
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

const EXTENSION_NOT_CONNECTED_ERROR = `The Playwriter Chrome extension is not connected, so there is no Chrome to drive. Ask the user to:
1. install the extension if they have not: https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe
2. open Chrome and click the extension icon on a tab to enable it (or refresh the page if it was just installed)`

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

/** Methods that by HTTP semantics change nothing on the server. */
const SAFE_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Request types through which a page changes data: a form POST (Document — one journal record per
 * redirect hop, so the POST of POST → 303 → GET keeps its method), XHR and fetch. A non-GET request
 * whose type CDP has not reported yet counts as well: an unknown type is no evidence it changed nothing.
 */
const DATA_REQUEST_TYPES: ReadonlySet<string> = new Set(['Document', 'XHR', 'Fetch'])

/** WebSocket opcodes that carry application data (RFC 6455 §5.2: 1 text, 2 binary); the others are control frames. */
const WEBSOCKET_DATA_OPCODES: ReadonlySet<number> = new Set([1, 2])

/**
 * The CDP commands human-mode code may send through getCDPSession(): reads only. Input, navigation,
 * script evaluation and every state change go through act.* (human pointer path, busy and cover
 * checks, one action per call, a report). `Accessibility.disable` is not a read and would switch the
 * domain off for the probes sharing this session. The Performance, Profiler, Tracing and IO commands
 * measure the renderer and change nothing the page can see (perf.ts sends the same ones); their
 * `*.disable` stays refused on the shared session.
 */
const READ_ONLY_CDP_COMMANDS: Record<string, true> = {
  'DOM.describeNode': true,
  'DOMSnapshot.captureSnapshot': true,
  'Network.getResponseBody': true,
  'Page.getFrameTree': true,
  'Page.getLayoutMetrics': true,
  'Page.getNavigationHistory': true,
  'Page.captureScreenshot': true,
  'Accessibility.enable': true,
  'Performance.enable': true,
  'Performance.getMetrics': true,
  'Profiler.enable': true,
  'Profiler.setSamplingInterval': true,
  'Profiler.start': true,
  'Profiler.stop': true,
  'Tracing.start': true,
  'Tracing.end': true,
  'Tracing.getCategories': true,
  'IO.read': true,
  'IO.close': true,
}
const READ_ONLY_CDP_PREFIXES: readonly string[] = ['DOM.get', 'CSS.get', 'Accessibility.get', 'Accessibility.query']

/**
 * Playwright's locator for the element passed as the node argument, run in the isolated world where
 * dist/selector-generator.js was installed. The generator only reads the DOM; it is built once per
 * world copy, since building it registers its (inert) listeners on the window.
 */
const LOCATOR_STRING_FN = `function (_args, element) {
  if (!element) return null
  var bundle = globalThis.__selectorGenerator
  var generate = globalThis.__playwriterGenerateSelector || (globalThis.__playwriterGenerateSelector = bundle.createSelectorGenerator(globalThis))
  return bundle.toLocator(generate(element).selector, 'javascript')
}`

/** Pins listed under an observation; older ones are counted. */
const MAX_PINS_SHOWN = 5

/** Characters of a pinned element's outerHTML printed by inspectPinnedElement(). */
const MAX_PINNED_MARKUP = 1500

/**
 * State of ONE execute() call that the observe/act globals share with the executor: the abort
 * signal raised when the call times out (so an act method stops dispatching input instead of
 * clicking into the next call), the deadline that budgets typing and settling, the act records
 * the report is built from, and the texts observe()/find()/explain() print.
 */
export interface ExecuteRun {
  signal: AbortSignal
  deadlineAt: number
  actRecords: ActionRecord[]
  probeOutput: string[]
  actActivity: { depth: number }
  /**
   * Raw Playwright input and navigations the code made itself (not through act.*), as labels, in the
   * order they reached the page — seen at run time through the Playwright client instrumentation.
   * act's human-mode counter counts them together with its own records.
   */
  rawActions: string[]
  /** Epoch ms when the last raw action ended: the settle's quiet windows start there after raw-only code. */
  rawEndedAt?: number
  /** The controlled page and its journal position when the code started: waitForPageLoad counts the requests made since. */
  start?: { page: Page; checkpoint: WatchCheckpoint }
  /** Called when act switches the controlled tab, so the action scope watches that tab as well. */
  follow?: (page: Page) => void
  /**
   * Set in human mode: the pages under test (this context's) and the browser. Every protocol call made
   * in this run's async context that would run Playwright's script in them or change them is refused
   * as it goes out ({@link guardHumanRun}).
   */
  humanGuard?: { context: BrowserContext; browser: Browser | null }
}

/** What the executor tracks between "before the code ran" and the action report. */
interface ActionScope {
  page: Page
  probe: PageProbe
  /**
   * The page before the code ran — taken only when the code makes raw input (no act record carries a
   * dispatch-time picture for it) or waits (the report shows what changed while waiting).
   */
  codeBefore: Observation | null
  checkpoint: WatchCheckpoint
  /**
   * Each tab the code's raw input or navigations went to, in the order the first call reached it:
   * its probe and journal position taken as that first call went out (before Playwright sent it).
   */
  rawTargets: Map<Page, RawTarget>
  /** The raw calls in the order they ended, with the tab each one went to (null when it never went out). */
  rawCalls: RawCall[]
  /** The code itself (not act.*) sends input or navigates: always settle and report after it. */
  rawCode: boolean
  /** Tabs opened by a watched tab during the call (`page.on('popup')`: this tab's own popups only). */
  popups: Page[]
  /** Downloads a watched tab started during the call, each kept for the session under its id. */
  downloads: SessionDownload[]
  /** Tabs whose file dialogs could not be held back for the code's raw input, and why. */
  watchFailures: string[]
  /** Stop watching; closes the file-dialog window of every raw call still in flight. */
  detach: () => Promise<void>
}

/** A tab raw code acted on, followed from the moment its first raw call went out. */
interface RawTarget {
  page: Page
  /** The tab's probe, or why it could not be watched. */
  probe: PageProbe | null
  probeError?: string
  /** Journal position right before its first raw call was sent; null when the probe failed. */
  checkpoint: WatchCheckpoint | null
  /** Epoch ms when its first raw call went out. */
  at: number
}

/** One raw Playwright call of the code, as the report lists it. */
interface RawCall {
  label: string
  /** Playwright's error, first line, when the call failed. */
  failure?: string
  page: Page | null
  /** Epoch ms when it went out. */
  startedAt: number
}

/** A run for building the sandbox outside execute() (tests that only inspect the globals). */
function idleExecuteRun(): ExecuteRun {
  return {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10 * 60_000,
    actRecords: [],
    probeOutput: [],
    actActivity: { depth: 0 },
    rawActions: [],
  }
}

/**
 * The execute() run the current async call chain belongs to. Playwright's client instrumentation is
 * per connection, and a connection can be shared by several sessions (the shared headless browser),
 * so the raw-action tap keeps only calls made from its own run's code.
 */
const executeContext = new AsyncLocalStorage<ExecuteRun>()

/** Set while an act.* method runs: act's own Playwright calls are not raw input from the code. */
const insideAct = new AsyncLocalStorage<true>()

/** How long a read that failed on a closing controlled tab waits for that tab's close event before giving up on it. */
const CLOSE_EVENT_WAIT_MS = 1000

/** `api` with every method (and every method of its nested objects, like `act.dialog`) running inside {@link insideAct}. */
function markedAsAct<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if (typeof value === 'function') return (...args: unknown[]) => insideAct.run(true, () => Reflect.apply(value, target, args))
      if (typeof value === 'object' && value !== null) return markedAsAct(value)
      return value
    },
  })
}

/** Characters of a source line a code frame shows around the column it points at. */
const CODE_FRAME_WIDTH = 120

/**
 * A code frame of `text` at `line` / `column` (1-based), with every line longer than
 * {@link CODE_FRAME_WIDTH} cut to a window around the column (`…` marks the cut). A minified
 * stylesheet is one line of hundreds of kilobytes: measured on Wikipedia, the uncut frame for one
 * declaration was 390 000 characters.
 */
function clippedCodeFrame(text: string, line: number, column: number, message: string): string {
  const lines = text.split('\n')
  const first = Math.max(1, line - 2)
  const last = Math.min(lines.length, line + 3)
  const from = Math.max(0, column - 1 - Math.floor(CODE_FRAME_WIDTH / 3))
  const clip = (source: string): string => {
    if (source.length <= CODE_FRAME_WIDTH) return source
    return `${from > 0 ? '…' : ''}${source.slice(from, from + CODE_FRAME_WIDTH)}${from + CODE_FRAME_WIDTH < source.length ? '…' : ''}`
  }
  // Lines before the window stay empty: the frame keeps the stylesheet's own line numbers.
  const shown = Array.from({ length: last }, (_, index) => (index + 1 >= first ? clip(lines[index]) : ''))
  const target = lines[line - 1] ?? ''
  const shownColumn = target.length <= CODE_FRAME_WIDTH ? column : column - from + (from > 0 ? 1 : 0)
  return codeFrameColumns(shown.join('\n'), { start: { line, column: shownColumn } }, { highlightCode: false, message })
}

/** Whether human mode refuses the protocol call `type.method` (wherever it goes): unknown, or with a refused effect. */
function refusedInHumanMode(type: string, method: string, params: unknown): boolean {
  const effect = callEffect(type, method, params)
  return effect === null || isRefusedEffect(effect)
}

/**
 * Human mode, at run time: no protocol call made in a human-mode run's async context may run
 * Playwright's script in the pages under test or change them (playwright-call-effects.ts) — the
 * code's own calls, a helper's and act's alike, the ones Playwright's instrumentation never reports
 * (internal methods, the second call of `locator.boundingBox()`) and the ones the code leaves running
 * after its call returned. The static policy refuses what it can read before anything runs; this is
 * the boundary for the rest. playwriter's own CDP-session borrowing is the one raw-CDP exception.
 */
const guardHumanRun: OutgoingCallGuard = ({ owner, method, params }) => {
  const scope = executeContext.getStore()?.humanGuard
  if (!scope) return
  const type: unknown = Reflect.get(owner, '_type')
  if (typeof type !== 'string') return
  const protocol = `${type}.${method}`
  const effect = callEffect(type, method, params)
  if (effect === null) {
    if (reachesContext(owner, scope.context, scope.browser)) throw new ActError(unclassifiedRefusal(protocol))
    return
  }
  if (!isRefusedEffect(effect) || !reachesContext(owner, scope.context, scope.browser)) return
  if (effect.kind === 'rawCdp' && openingOwnCdpSession.getStore()) return
  throw new ActError(refusalFor(effect, protocol))
}

/**
 * The CDP session human-mode code gets from getCDPSession(): the page's shared session, with every
 * command outside {@link READ_ONLY_CDP_COMMANDS} refused before it is sent. The shared session is an
 * ES private field: a TypeScript `private` property is an ordinary one at run time, and
 * `(await getCDPSession({ page })).session.send(…)` would have bypassed the check.
 */
class ReadOnlyCdpSession implements ICDPSession {
  readonly #session: ICDPSession

  constructor(session: ICDPSession) {
    this.#session = session
  }

  async send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
  ): Promise<ProtocolMapping.Commands[K]['returnType']> {
    if (!Object.hasOwn(READ_ONLY_CDP_COMMANDS, method) && !READ_ONLY_CDP_PREFIXES.some((prefix) => method.startsWith(prefix))) {
      throw new ActError(
        `Refused (human mode): getCDPSession().send('${method}') is not a read. In human mode raw CDP may only read ` +
          '(DOM.get*, DOM.describeNode, Accessibility.*, DOMSnapshot.captureSnapshot, CSS.get*, Network.getResponseBody, ' +
          'Page.getFrameTree/getLayoutMetrics/getNavigationHistory/captureScreenshot, Performance.enable/getMetrics, ' +
          'Profiler.enable/setSamplingInterval/start/stop, Tracing.start/end/getCategories, IO.read/close — perf.* wraps those). Input, navigation and script go ' +
          'through act.* — act.click(ref), act.press(key), act.fill(ref, text), act.open(url, { reason }) — which move ' +
          'like a person and report what happened; readPage(fn) reads the page. Raw CDP that changes the page needs debug ' +
          'mode (ask the user).',
      )
    }
    // Measured (page-screenshot.ts): captureBeyondViewport resizes the window while it shoots, and a clip
    // does too in a headed window with an emulated viewport; the page gets resize events either way.
    if (method === 'Page.captureScreenshot' && typeof params === 'object' && params !== null && (('captureBeyondViewport' in params && params.captureBeyondViewport) || 'clip' in params)) {
      throw new ActError(
        `Refused (human mode): Page.captureScreenshot with ${'clip' in params ? 'clip' : 'captureBeyondViewport'} changes the page while it shoots — ` +
          `${BEYOND_VIEWPORT_EVENTS} (a clip does the same in a window with an emulated viewport). screenshot() takes the window, ` +
          'screenshot({ ref: 12 }) one element cropped in Node, both without touching the page. It was not run.',
      )
    }
    return await this.#session.send(method, params)
  }

  on<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this.#session.on(event, callback)
    return this
  }

  off<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this.#session.off(event, callback)
    return this
  }

  async detach(): Promise<void> {
    await this.#session.detach()
  }
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

/** One headless browser of this process (PlaywrightExecutor.headlessBrowsers). */
interface HeadlessBrowserEntry {
  /** `launchKey` of the plan it was launched for. */
  key: string
  launching: Promise<LaunchedNewBrowser>
  /** Set once launched. */
  browser: Browser | null
  /** The sessions whose contexts live in it. */
  executors: Set<PlaywrightExecutor>
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
  /** Launch a new browser (new-browser.ts: the installed Google Chrome, presented as a person's Chrome)
   *  instead of connecting to an existing one. Its options: `planNewBrowser()` before the first connect. */
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
  /**
   * `human` (default): one input action per call, no goto/reload after the first load, no forced
   * state, every action followed by a settle + "what changed" report. `debug`: everything allowed.
   * Falls back to the PLAYWRITER_POLICY environment variable, then `human`.
   */
  policy?: PolicyMode
}

/** PLAYWRITER_POLICY=human|debug, or undefined when unset. Anything else is a configuration error. */
export function policyFromEnv(): PolicyMode | undefined {
  const raw = process.env.PLAYWRITER_POLICY
  if (raw === undefined || raw === '') return undefined
  if (raw === 'human' || raw === 'debug') return raw
  throw new Error(`PLAYWRITER_POLICY must be "human" or "debug" (got ${JSON.stringify(raw)}).`)
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

/** One Playwright channel call as the client instrumentation reports it. */
interface PlaywrightChannelCall {
  type: string
  method: string
  params?: Record<string, unknown>
}

/**
 * One Playwright channel call -> a navigation label (`goto https://…`, `reload`, `goBack`), or null.
 * `page.goto`/`frame.goto` and `setContent` are Frame calls; reload and history moves are Page calls.
 */
export function playwrightChannelToNavigation(channel: PlaywrightChannelCall): string | null {
  if (channel.type === 'Frame' && channel.method === 'goto') return `goto ${String(channel.params?.url ?? '')}`
  if (channel.type === 'Frame' && channel.method === 'setContent') return 'setContent'
  if (channel.type === 'Page' && (channel.method === 'reload' || channel.method === 'goBack' || channel.method === 'goForward')) return channel.method
  return null
}

/** The listener half of Playwright's client instrumentation (`client/clientInstrumentation.ts`). */
interface ClientInstrumentation {
  addListener(listener: object): void
  removeListener(listener: object): void
}

/** The client instrumentation behind `page` — one per Playwright connection — or null when this client has none. */
function clientInstrumentationOf(page: Page): ClientInstrumentation | null {
  const instrumentation: unknown = Reflect.get(page, '_instrumentation')
  if (typeof instrumentation !== 'object' || instrumentation === null) return null
  const add: unknown = Reflect.get(instrumentation, 'addListener')
  const remove: unknown = Reflect.get(instrumentation, 'removeListener')
  if (typeof add !== 'function' || typeof remove !== 'function') return null
  return {
    addListener: (listener) => Reflect.apply(add, instrumentation, [listener]),
    removeListener: (listener) => Reflect.apply(remove, instrumentation, [listener]),
  }
}

/** The tab of `context` a Playwright call was made on: the Page itself, a Frame's page, or a handle's frame's page. */
function pageOfCallOwner(owner: object, context: BrowserContext): Page | null {
  const pages = context.pages()
  for (let current: unknown = owner; typeof current === 'object' && current !== null; current = Reflect.get(current, '_parent')) {
    const type: unknown = Reflect.get(current, '_type')
    if (type === 'Page') return pages.find((candidate) => candidate === current) ?? null
    if (type === 'Frame') {
      const framePage: unknown = Reflect.get(current, '_page')
      return pages.find((candidate) => candidate === framePage) ?? null
    }
  }
  return null
}

/**
 * Whether a protocol call made on `owner` reaches the pages under test: this session's browser
 * context, one of its pages, or anything inside them (frames, element handles, workers, tracing, the
 * context's request client) — or the browser itself, whose CDP sessions reach every page. A page of
 * another context (`browser.newContext()`) is not under test.
 */
function reachesContext(owner: object, context: BrowserContext, browser: Browser | null): boolean {
  if (owner === browser) return true
  for (let current: unknown = owner; typeof current === 'object' && current !== null; ) {
    if (current === context) return true
    const framePage: unknown = Reflect.get(current, '_type') === 'Frame' ? Reflect.get(current, '_page') : undefined
    current = framePage ?? Reflect.get(current, '_parent')
  }
  return false
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
  /** The revisions of every snapshot() scope: what `snapshot({ diff: true })` compares against. */
  private snapshotRevisions = new SnapshotRevisions()
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
   * Everything this executor has ever registered as a trace-probe `owner` (the page for both
   * `net.timeline` and `net.delay`).
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
  /** Per-page state of the observe/act layer: refs, journal, dialogs, last observation. */
  private probes: PageProbes
  /** Over the relay: the closed controlled page whose tab Chrome may only have taken the debugger off (debugger-cut.ts). */
  private readonly debuggerCuts: DebuggerCutAdoption
  /** DEBUGGER CUT lines for the top of this call's output (debugger-cut.ts). */
  private readonly cutNotices: string[] = []
  /** Calls already told their tab is still cut. */
  private readonly runsToldStillCut = new WeakSet<ExecuteRun>()
  /** Controlled pages that closed and were replaced (replaceClosedPage): a sandbox `page` still holding one follows the replacement. */
  private readonly replacedPages = new WeakSet<Page>()
  /** human (default) or debug — see `PolicyMode`. Fixed per session by whoever created it. */
  private policy: PolicyMode
  private suppressPageCloseWarnings = false
  /** The tab each popup/new tab came from (the report asks the opener how it was opened). */
  private readonly popupOpeners = new WeakMap<Page, Page>()
  /** Set when the controlled tab closed and none was left: the blank tab getCurrentPage opens next is reported. */
  private controlledTabLost = false

  private scopedFs: ScopedFS
  /** Every download an action report saw, by id: `downloads.list()` / `downloads.save(id, path)`. */
  private sessionDownloads: SessionDownloads
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
    this.policy = options.policy ?? policyFromEnv() ?? 'human'
    // Whether the user can see a tab: only the extension can tell (tab-visibility.ts); a launched
    // browser does not throttle its background tabs, so it needs no source.
    this.probes = new PageProbes({
      logger: {
        error: (...args: unknown[]) => {
          this.logger.error(...args)
        },
      },
      ...(this.cdpConfig.headless ? {} : { readTabVisibility: (targetId: string) => this.tabVisibility(targetId) }),
    })
    this.debuggerCuts = new DebuggerCutAdoption({
      probes: this.probes,
      relay: () => {
        const { host = '127.0.0.1', port = 19988, token } = this.cdpConfig
        return { httpBaseUrl: parseRelayHost(host, port).httpBaseUrl, token: token || process.env.PLAYWRITER_TOKEN }
      },
    })
    this.cloudSession = options.cloudSession || null
    // Same precedence as connectToBrowser: headless, then direct CDP (cloud or not), then the extension relay.
    this.sessionDownloads = new SessionDownloads(
      this.cdpConfig.headless
        ? { kind: 'launched' }
        : this.cdpConfig.directCdpUrl
          ? { kind: this.cloudSession ? 'cloud' : 'direct', endpoint: this.cdpConfig.directCdpUrl }
          : { kind: 'extension', relay: (guid) => this.relayDownloadStatus(guid) },
    )
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
        const cdpSession = await openingOwnCdpSession.run(true, () => page.context().newCDPSession(page))
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
    // A closed page of the old connection awaits no verdict in the new one.
    this.debuggerCuts.forget()
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
    // A renderer crash ends the Page for good: the next call is refused or recovers (execute()).
    watchForCrash(page)
    // Attach before anything can open a confirm(): without a `dialog` listener Playwright
    // auto-dismisses it, and a "Delete" click silently does nothing.
    this.probes.dialogsFor(page)
    // The event journal (network, console, navigations) should cover the page from the start,
    // not from the first observe(): an error logged before then is still part of the story.
    this.probes.get(page).catch((error: unknown) => {
      this.logger.error('[playwriter] could not start the page probe:', error)
    })
    this.ghostCursorController.attachToPage({ page })
    page.on('close', () => {
      this.ghostCursorController.detachFromPage({ page })
      // A live Fetch interceptor or request listener that outlives its page silently
      // perturbs (or misattributes) every later measurement in the session, so probes
      // die with the page they were armed on.
      void this.stopTraceProbesFor([page])
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
      const wasCurrentPage = this.page === page
      // Over the relay a closed controlled page may be a tab Chrome only took the debugger off: the tab
      // is still open and comes back (debugger-cut.ts). Nothing replaces it until the relay has said
      // which it is (settleClosedPage). A reset or disconnect closes pages on purpose.
      if (wasCurrentPage && !this.isHeadlessMode() && !this.isDirectCdpMode() && !this.suppressPageCloseWarnings) {
        this.page = null
        this.debuggerCuts.pageClosed(page)
        return
      }
      this.reportClosedPage(page, wasCurrentPage)
    })
  }

  /** A page closed for good: the controlled one is replaced (replaceClosedPage), and `state` keys still holding it are named. */
  private reportClosedPage(page: Page, wasCurrentPage: boolean): void {
    const stateKeysForClosedPage = Object.entries(this.userState)
      .filter(([, value]) => {
        return value === page
      })
      .map(([key]) => key)

    const replacementPageInfo = wasCurrentPage ? this.replaceClosedPage(page) : null

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
  }

  /**
   * Over the relay, what became of the closed controlled page's tab (debugger-cut.ts), waiting up to
   * `waitMs` for a cut tab to come back: back → its new page is controlled (and `state` keys holding
   * the old one hold it); gone → reportClosedPage; still cut → nothing is controlled yet. The caller
   * decides where the verdict's notice goes.
   */
  private async settleClosedPage(waitMs: number): Promise<ClosedPageVerdict | null> {
    if (!this.context) return null
    const verdict = await this.debuggerCuts.settle({ context: this.context, waitMs })
    if (verdict?.kind === 'closed') this.reportClosedPage(verdict.page, true)
    if (verdict?.kind === 'reattached') {
      for (const [key, value] of Object.entries(this.userState)) {
        if (value === verdict.page) this.userState[key] = verdict.replacement
      }
      // Code later in the call that ended with the cut may already have switched to another tab.
      if (!this.page) {
        this.page = verdict.replacement
        this.replacedPages.add(verdict.page)
      }
    }
    return verdict
  }

  /**
   * The controlled page closed during this call (`run`): what became of its tab, waited for within
   * the call's time, with the DEBUGGER CUT line queued for the top of its output — once per call for a
   * tab that is still cut.
   */
  private async noteCutDuringCall(run: ExecuteRun): Promise<void> {
    if (!this.debuggerCuts.pending || this.runsToldStillCut.has(run)) return
    const verdict = await this.settleClosedPage(Math.min(CUT_WAIT_MS, Math.max(0, run.deadlineAt - Date.now())))
    if (verdict?.kind === 'still-cut') this.runsToldStillCut.add(run)
    if (verdict?.notice) this.cutNotices.push(verdict.notice)
  }

  /**
   * The controlled tab closed (by the page, the person, or the browser): control moves to the tab
   * that opened it when that is still open, else to the first open tab — never silently: the next
   * report says `TAB CLOSED` with both tabs. With no tab left, nothing is created here; the next
   * call's blank tab is reported by getCurrentPage.
   */
  private replaceClosedPage(closed: Page): { index: number; url: string } | null {
    this.page = null
    const context = this.context || closed.context()
    const open = context.pages().filter((candidate) => !candidate.isClosed())
    const describe = (tab: Page): string => {
      const title = this.probes.lastTitle(tab)
      return `${title === undefined ? '(title never read)' : `"${title}"`} ${tab.url() || 'about:blank'}`
    }
    const closedLabel = describe(closed)
    if (open.length === 0) {
      // A reset closes every tab on purpose and says so itself.
      if (!this.suppressPageCloseWarnings) {
        this.controlledTabLost = true
        this.enqueueWarning(
          `TAB CLOSED — the controlled tab ${closedLabel} was closed and no tab is left. The next call opens a new blank tab to work in; load a page there with page.goto(url).`,
        )
      }
      return null
    }
    const opener = this.popupOpeners.get(closed)
    const replacement = opener && !opener.isClosed() ? opener : open[0]
    this.page = replacement
    this.replacedPages.add(closed)
    const index = open.indexOf(replacement)
    if (!this.suppressPageCloseWarnings) {
      const why = replacement === opener ? 'the tab that opened it' : 'the first open tab'
      const blank = isBlankUrl(replacement.url()) ? ' It is an empty tab: load a page in it with page.goto(url), or pick another.' : ''
      this.enqueueWarning(
        `TAB CLOSED — the controlled tab ${closedLabel} was closed; now controlling tab ${index} ${describe(replacement)} (${why}).${blank} ` +
          'act.switchTab(n or text of its title/URL) works in another; refs of open tabs still work.',
      )
    }
    return { index, url: replacement.url() || 'unknown' }
  }

  /**
   * A failure's message for the model. A tab that did not answer in time gets what is known about
   * it — the dialog controller's record and whether the user can see it, read now — instead of a guess;
   * any other timeout on a tab the user cannot see gets the HIDDEN line (Chrome throttles that tab).
   */
  private async explainFailure(error: unknown, page: Page | null): Promise<string> {
    const message = error instanceof Error ? error.message : String(error)
    const unresponsive = error instanceof PageUnresponsiveError
    const timedOut = error instanceof CodeExecutionTimeoutError || (error instanceof Error && error.name === 'TimeoutError')
    if ((!unresponsive && !timedOut) || !page || page.isClosed()) return message
    const probe = await this.probes.get(page).catch(() => null)
    if (!probe) return message
    const visibility = await this.probes.visibility(probe)
    if (unresponsive) return `${message} ${unresponsiveDiagnosis({ dialog: probe.dialogs.current(), visibility })}`
    return visibility?.kind === 'read' && tabIsHidden(visibility.report) ? `${message}\n${hiddenTabNote(visibility.report)}` : message
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

    // Each entry keeps where it came from on its following lines, `    at <url>:<line>:<col>` like a stack
    // frame (just `    at <url>` for Chrome's own messages, which name the resource without a line), so a
    // search finds the entry and the first line stays the message.
    page.on('console', (msg) => {
      try {
        const { url, lineNumber, columnNumber } = msg.location()
        const at = !url ? '' : lineNumber === 0 && columnNumber === 0 ? `\n    at ${url}` : `\n    at ${url}:${lineNumber + 1}:${columnNumber + 1}`
        this.addBrowserLog({ page, logEntry: `[${msg.type()}] ${msg.text()}${at}` })
      } catch (e) {
        this.logger.error('[Executor] Failed to get console message text:', e)
      }
    })

    page.on('pageerror', (error) => {
      const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line))
      this.addBrowserLog({ page, logEntry: [`[pageerror] ${error.message}`, ...frames.map((frame) => `    ${frame.trim()}`)].join('\n') })
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

  /**
   * What the relay knows of the extension download `guid` (`GET /downloads/:guid`, download-file.ts):
   * null when it has no record of it. Rejects with the reason when the relay cannot be asked or answers
   * something else.
   */
  private async relayDownloadStatus(guid: string): Promise<RelayDownloadStatus | null> {
    const { host = '127.0.0.1', port = 19988, token } = this.cdpConfig
    const { httpBaseUrl } = parseRelayHost(host, port)
    const effectiveToken = token || process.env.PLAYWRITER_TOKEN
    const response = await fetch(`${httpBaseUrl}/downloads/${encodeURIComponent(guid)}`, {
      signal: AbortSignal.timeout(2000),
      headers: effectiveToken ? { Authorization: `Bearer ${effectiveToken}` } : {},
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`the relay at ${httpBaseUrl} answered HTTP ${response.status}`)
    const status = parseRelayDownloadStatus(await response.json())
    if ('invalid' in status) throw new Error(`the relay at ${httpBaseUrl} answered something that is not a download status (${status.invalid})`)
    return status
  }

  /**
   * Whether the user can see tab `targetId`: the extension's report through the relay
   * (`GET /tab-visibility/:targetId`, tab-visibility.ts). Rejects when the relay cannot be asked.
   */
  private async tabVisibility(targetId: string): Promise<TabVisibility> {
    if (this.isDirectCdpMode()) {
      return { kind: 'unreadable', error: 'connected over CDP directly, which does not say which tab is in front of its window; only the Playwriter extension can' }
    }
    const { host = '127.0.0.1', port = 19988, token } = this.cdpConfig
    const { httpBaseUrl } = parseRelayHost(host, port)
    const effectiveToken = token || process.env.PLAYWRITER_TOKEN
    // The relay waits up to 1 s for the extension to re-read the tab.
    const response = await fetch(`${httpBaseUrl}/tab-visibility/${encodeURIComponent(targetId)}`, {
      signal: AbortSignal.timeout(3000),
      headers: effectiveToken ? { Authorization: `Bearer ${effectiveToken}` } : {},
    })
    if (response.status === 404) {
      return { kind: 'unreadable', error: 'the relay has no report of this tab from the extension (an extension older than this relay sends none)' }
    }
    if (!response.ok) return { kind: 'unreadable', error: `the relay at ${httpBaseUrl} answered HTTP ${response.status}` }
    const status = parseTabVisibilityStatus(await response.json())
    if ('invalid' in status) return { kind: 'unreadable', error: `the relay at ${httpBaseUrl} answered something that is not a tab visibility (${status.invalid})` }
    return { kind: 'read', report: status }
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

  /** The new browser this headless session runs in: set by `planNewBrowser`, the defaults otherwise. */
  private newBrowserPlan: NewBrowserPlan | null = null
  /** What that browser presents, once launched (for `describeNewBrowser`). */
  private newBrowserLaunch: LaunchedNewBrowser | null = null
  /** The key of the shared headless browser this session's context lives in (`launchKey`). */
  private headlessKey: string | null = null

  /**
   * Check `options` for this headless session's new browser (new-browser.ts `planNewBrowser`): they
   * apply from its next connect. Throws a ModelFacingError naming the fix for an option it refuses.
   */
  async planNewBrowser(options: NewBrowserOptions): Promise<NewBrowserPlan> {
    const plan = await planNewBrowser(options, { cwd: this.sessionCwd ?? process.cwd() })
    this.newBrowserPlan = plan
    return plan
  }

  /** One line per option of this session's new browser, and what still shows this computer; null when not headless. */
  describeNewBrowser(): string[] | null {
    return this.isHeadlessMode() && this.newBrowserPlan ? describeNewBrowser(this.newBrowserPlan, this.newBrowserLaunch) : null
  }

  /**
   * This session's context in a new browser (new-browser.ts). Sessions whose browser-wide options are the
   * same share one Chrome, each in its own context. Does NOT add per-session disconnect listeners to the
   * shared browser; ensureConnection checks browser.isConnected() on each call.
   */
  private async connectHeadlessBrowser(): Promise<{ browser: Browser; page: Page; context: BrowserContext }> {
    const plan = this.newBrowserPlan ?? (await this.planNewBrowser({}))
    const entry = PlaywrightExecutor.headlessBrowserFor(plan, this.logger)
    // Claimed before the launch finishes, so a launch for other options does not close it as idle.
    entry.executors.add(this)
    this.headlessKey = entry.key
    let launched: LaunchedNewBrowser
    try {
      launched = await entry.launching
    } catch (error) {
      entry.executors.delete(this)
      throw error
    }
    this.newBrowserLaunch = launched
    const browser = launched.browser

    const context = await browser.newContext(contextOptionsFor(plan))
    try {
      context.setDefaultTimeout(60000)
      context.setDefaultNavigationTimeout(10000)

      context.on('page', (page) => {
        this.setupPageListeners(page)
      })
      if (plan.downloads) copyDownloadsInto(context, plan.downloads)

      const page = await context.newPage()
      this.setupPageListeners(page)

      await this.setDeviceScaleFactorForMacOS(context)

      return { browser, page, context }
    } catch (e) {
      // Clean up the partially created context so it doesn't leak on the
      // long-lived shared browser.
      await context.close().catch(() => {})
      throw e
    }
  }

  /**
   * The headless browsers of this process, by `launchKey`: one launch each (concurrent sessions share
   * its promise), and the executors whose contexts live in it. A browser closes when its last executor
   * leaves, and leaves the map when it disconnects (a crash), so the next session launches it again.
   */
  private static headlessBrowsers = new Map<string, HeadlessBrowserEntry>()

  private static headlessBrowserFor(plan: NewBrowserPlan, logger: ExecutorLogger): HeadlessBrowserEntry {
    const browsers = PlaywrightExecutor.headlessBrowsers
    const key = launchKey(plan)
    const existing = browsers.get(key)
    if (existing && (existing.browser === null || existing.browser.isConnected())) return existing
    // A browser nobody uses, launched for other options (a prelaunch the session did not take), closes now.
    for (const [otherKey, other] of browsers) {
      if (otherKey === key || other.executors.size > 0) continue
      browsers.delete(otherKey)
      other.launching.then(({ browser }) => browser.close()).catch(() => {})
    }
    const launching = getChromium().then((chromium) => launchNewBrowser(chromium, plan, logger))
    const entry: HeadlessBrowserEntry = { key, launching, browser: null, executors: new Set() }
    browsers.set(key, entry)
    launching.then(
      ({ browser }) => {
        entry.browser = browser
        browser.on('disconnected', () => {
          if (browsers.get(key) === entry) browsers.delete(key)
        })
      },
      // The sessions awaiting the launch get the error; the next connect launches again.
      () => {
        if (browsers.get(key) === entry) browsers.delete(key)
      },
    )
    return entry
  }

  /**
   * Start launching this session's new browser now, before its first call needs it (the MCP server does
   * this at startup with PLAYWRITER_BROWSER=new). The session owns the browser from here: its first
   * connect takes it, and `disconnect()` closes it even before that. A failed launch is reported by
   * the first connect, which launches again. Needs `planNewBrowser()` first.
   */
  prelaunch(): void {
    if (!this.isHeadlessMode() || !this.newBrowserPlan) {
      throw new Error('prelaunch() is for a headless session whose options planNewBrowser() has checked.')
    }
    const entry = PlaywrightExecutor.headlessBrowserFor(this.newBrowserPlan, this.logger)
    entry.executors.add(this)
    this.headlessKey = entry.key
  }

  /** Close the headless context for this session (called on session delete).
   *  When the last executor of its browser leaves, that browser is closed too
   *  so the Chrome process doesn't linger. */
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

    const key = this.headlessKey
    const entry = key === null ? undefined : PlaywrightExecutor.headlessBrowsers.get(key)
    if (key !== null && entry?.executors.delete(this) && entry.executors.size === 0) {
      PlaywrightExecutor.headlessBrowsers.delete(key)
      await entry.launching.then(({ browser }) => browser.close()).catch(() => {})
    }
  }

  /** Close every headless browser of this process (relay shutdown). Each leaves the map before
   *  it closes, so a concurrent session launches a fresh one instead of reusing a dying one. */
  static async closeSharedHeadlessBrowser(): Promise<void> {
    const entries = [...PlaywrightExecutor.headlessBrowsers.values()]
    PlaywrightExecutor.headlessBrowsers.clear()
    await Promise.all(entries.map((entry) => entry.launching.then(({ browser }) => browser.close()).catch(() => {})))
  }

  /**
   * Stop driving the browser this executor is bound to (an MCP session switching browsers).
   *
   * - Headless: `closeHeadlessContext()` — this session's context closes, and the shared headless
   *   Chrome closes with it when no other session uses it.
   * - Relay (the user's Chrome through the extension) and direct CDP: what this session armed in
   *   the browser is released (`disposeBrowserSideResources`), then Playwright disconnects. The
   *   Chrome and its tabs stay open: closing a connectOverCDP browser only drops the connection.
   *
   * The connection state is cleared either way; `state` is not. A close that fails is logged
   * through the executor's logger.
   */
  async disconnect(): Promise<void> {
    if (this.isHeadlessMode()) {
      await this.closeHeadlessContext()
      return
    }
    await this.disposeBrowserSideResources()
    const browser = this.browser
    this.clearConnectionState()
    if (!browser) {
      return
    }
    this.suppressPageCloseWarnings = true
    try {
      await browser.close()
    } catch (e) {
      this.logger.error('Error disconnecting from the browser:', e)
    } finally {
      this.suppressPageCloseWarnings = false
    }
  }

  private async ensureConnection(): Promise<void> {
    // In headless mode, also check the shared browser is still alive.
    // After a crash, isConnected() returns false and we need to reconnect.
    const browserAlive = this.isHeadlessMode() ? this.browser?.isConnected() : true
    // A closed controlled tab (this.page null) is not a lost connection: reconnecting here made a
    // new context with a blank tab and moved to it silently. getCurrentPage picks the next tab of
    // this session's context and says so.
    if (this.isConnected && this.browser && (this.page || this.context) && browserAlive) return

    try {
      const { browser, page, context } = await this.connectToBrowser()

      this.browser = browser
      this.page = page
      this.context = context
      this.isConnected = true
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
    // The controlled page closed over the relay: when Chrome only took the debugger off its tab
    // (debugger-cut.ts), that tab is waited for and taken back — never replaced while it is open.
    if (this.debuggerCuts.pending) {
      const verdict = await this.settleClosedPage(Math.min(CUT_WAIT_MS, timeout))
      if (verdict?.kind === 'still-cut') throw new ModelFacingError(`${verdict.notice} Nothing from this call was run.`)
      if (verdict?.notice) this.cutNotices.push(verdict.notice)
    }
    if (this.page && !this.page.isClosed()) {
      return this.page
    }

    if (this.browser) {
      const contexts = this.browser.contexts()
      if (contexts.length > 0) {
        // This session's own context when it is still open: a shared headless browser holds other
        // sessions' contexts too, and contexts[0] can be one of them.
        const context = this.context && contexts.includes(this.context) ? this.context : contexts[0]
        this.context = context
        const pages = context.pages().filter((p) => !p.isClosed())
        if (pages.length > 0) {
          const page = pages[0]
          await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
          this.page = page
          if (this.controlledTabLost) {
            this.controlledTabLost = false
            this.enqueueWarning(`TAB    now controlling tab 0 ${page.url() || 'about:blank'}, a tab opened since the controlled tab closed.`)
          }
          return page
        }
        const page = await this.ensurePageForContext({ context, timeout })
        this.page = page
        if (this.controlledTabLost) {
          this.controlledTabLost = false
          this.enqueueWarning(
            `TAB    no tab was left, so a new blank tab was opened (tab 0, ${page.url() || 'about:blank'}) to work in — page.goto(url) loads a page in it.`,
          )
        }
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
    run = idleExecuteRun(),
  }: {
    page: Page
    context: BrowserContext
    consoleLogs: Array<{ method: string; args: any[] }>
    /** Per-call state shared with observe/act. Omitted only by tests that inspect the globals without running code. */
    run?: ExecuteRun
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

      /**
       * Human mode: the Locator / ElementHandle / FrameLocator / selector forms of the element readers
       * resolve the element with Playwright's script in the page, which Playwright runs as a user
       * gesture. The static policy refuses the forms it can read before the code runs; this refuses the
       * rest (options built in a variable, a locator in a variable) when the reader is called, before
       * any Playwright call of it — earlier statements of the code have run by then. Debug mode keeps
       * every form.
       */
      const refuseScriptForm = (call: string, what: string, instead: string): void => {
        if (self.policy !== 'human') return
        throw new ActError(
          `Refused (human mode): ${call} resolves ${what} with Playwright's script in the page, which Playwright runs as a user ` +
            `gesture (the page then counts as clicked: navigator.userActivation). Pass a ref from observe() or find(): ${instead}. ` +
            'It was not run.',
        )
      }

      const snapshot = async (options: {
        page?: Page
        /** Optional frame to scope the snapshot (e.g. from iframe.contentFrame() or page.frames()) */
        frame?: Frame | FrameLocator
        /** Optional locator to scope the snapshot to a subtree (debug mode only) */
        locator?: Locator
        /** Scope the snapshot to the subtree of this element: a ref from observe()/find() */
        ref?: number | string
        search?: string | RegExp
        /**
         * Return a revision of this scope (the page, or the ref's subtree): `full` the first time and
         * for a new document, `unchanged`, or a `delta` of the nodes that appeared, went away or changed.
         */
        diff?: boolean
        /** The same as `diff` (the name getCleanHTML and getPageMarkdown use). */
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
      } = {}) => {
        const {
          page: targetPage,
          frame,
          locator,
          ref,
          search,
          // Opt-in. As a default the second call returned a delta, and weak models read it as the page.
          diff = false,
          showDiffSinceLastCall = false,
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
        if (locator && ref !== undefined) {
          throw new ModelFacingError('snapshot: pass `locator` or `ref` to scope it, not both.')
        }
        if (locator) refuseScriptForm('snapshot({ locator })', 'the locator', 'snapshot({ ref: 12 })')
        if (frame && !('frameId' in frame)) {
          refuseScriptForm(
            'snapshot({ frame })',
            'the frame locator',
            'snapshot({ ref: 12 }) with an element in the frame, or the Frame itself: snapshot({ frame: page.frames()[1] })',
          )
        }
        const element = ref === undefined ? null : await self.probes.element(ref)
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
        const pageFromScope: Page | undefined = element
          ? element.page
          : locator
            ? locator.page()
            : frame && 'page' in frame
              ? frame.page()
              : undefined
        const resolvedPage = targetPage || pageFromScope || currentPage()
        if (!resolvedPage) {
          throw new Error('snapshot requires a page')
        }

        const wantsRevision = diff || showDiffSinceLastCall
        if (wantsRevision && search !== undefined) {
          throw new ModelFacingError('snapshot: `diff` returns what changed in the whole scope, and `search` filters lines; pass one of them.')
        }
        if (wantsRevision && frame) {
          throw new ModelFacingError(
            "snapshot: `diff` keeps revisions of the page or of one element's subtree. For an iframe pass its ref from observe(): snapshot({ ref: 7, diff: true }).",
          )
        }

        const {
          snapshot: rawSnapshot,
          tree,
          refs,
          getSelectorForRef,
        } = await getAriaSnapshot({
          page: resolvedPage,
          frame,
          locator: element ? refElementTarget(element) : locator,
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

        const shown =
          self.policy === 'human'
            ? `${snapshotStr}\n\nThe selector on each line (like [id="q"] or role=button[name="Save"]) is a Playwright locator; human mode refuses locators, because they run Playwright's script in the page. Act with a ref from observe() or find().`
            : snapshotStr

        // A `diff` snapshot of a scope is its next revision, compared with the previous `diff` snapshot of it.
        if (wantsRevision) {
          const documentId = element
            ? `${element.target.documentId}:${element.target.frameDocumentId}`
            : (
                await withDeadline((await self.probes.get(resolvedPage)).cdp.send('Page.getFrameTree'), 5000, 'reading which document the page shows (Page.getFrameTree)')
              ).frameTree.frame.loaderId
          const scope = `${locator ? `locator:${locator.selector()}` : element ? `ref:${element.target.ref}` : 'page'}|${interactiveOnly ? 'interactive' : 'all'}`
          return this.snapshotRevisions.record({ page: resolvedPage, scope, documentId, tree, snapshot: snapshotStr, shown })
        }

        if (!search) return shown

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
       * session scoping. `{ ref }` reads one element through playwriter's isolated world.
       */
      const getCleanHTMLFn = async (
        options: GetCleanHTMLOptions | (Omit<GetCleanHTMLOptions, 'locator' | 'diffStore'> & { ref: number | string }),
      ) => {
        if (options !== undefined && 'ref' in options) {
          const { ref, ...rest } = options
          if ('locator' in rest) throw new ModelFacingError('getCleanHTML: pass `locator` or `ref`, not both.')
          return getCleanHTML({ ...rest, locator: refElementTarget(await self.probes.element(ref)), diffStore: this.lastCleanHtml })
        }
        if (options?.locator === undefined) {
          throw new ModelFacingError(
            'getCleanHTML needs what to read: getCleanHTML({ locator: page }) for the whole page, or getCleanHTML({ ref: 12 }) for one element (a ref from observe() or find()).',
          )
        }
        // A Page is read over CDP; a Locator is read with Playwright's script in the page.
        if (!('goto' in options.locator)) refuseScriptForm('getCleanHTML({ locator })', 'the locator', 'getCleanHTML({ ref: 12 })')
        return getCleanHTML({ ...options, diffStore: this.lastCleanHtml })
      }
      // Every option is optional: `getPageMarkdown()` reads the controlled page.
      const getPageMarkdownFn = async (options: PageMarkdownRequest = {}) => {
        const target = options.page ?? currentPage()
        // Readability runs in the page's shared probe world, never in the page's own realm.
        const probe = await self.probes.get(target)
        if (probe.dialogs.current()) {
          throw new ActError('A native dialog is open and freezes the page, so its text cannot be read. Handle it first: act.dialog.accept() or act.dialog.dismiss().')
        }
        return getPageMarkdown({ ...options, page: target, frames: probe.frames, diffStore: this.lastPageMarkdown })
      }

      const refToLocator = (options: { ref: string; page?: Page }): string | null => {
        const targetPage = options.page || page
        const map = this.lastRefToLocator.get(targetPage)
        if (!map) {
          return null
        }
        return map.get(options.ref) ?? null
      }

      /**
       * Read-only and invisible to the page: the element is resolved to its CDP node (from a ref, or
       * from a Locator/ElementHandle in debug mode), and Playwright's selector generator
       * (dist/selector-generator.js) runs in playwriter's isolated world on the element's frame —
       * installed there once per world copy, never in the page's own realm.
       */
      const getLocatorStringForElement = async (element: Locator | ElementHandle | { ref: number | string }): Promise<string> => {
        const usage = 'getLocatorStringForElement: argument must be { ref } (a ref from observe() or find()), or a Playwright Locator or ElementHandle'
        if (typeof element !== 'object' || element === null) throw new Error(usage)
        let resolved: ResolvedElement
        if ('ref' in element) {
          resolved = refElementTarget(await self.probes.element(element.ref))
        } else {
          if (typeof element.evaluate !== 'function') throw new Error(usage)
          refuseScriptForm('getLocatorStringForElement(locator)', 'the element', 'getLocatorStringForElement({ ref: 12 })')
          const elementPage = 'page' in element ? element.page() : ((await element.ownerFrame())?.page() ?? page)
          const probe = await self.probes.get(elementPage)
          resolved = await resolveElement({ target: element, cdp: probe.cdp })
        }
        const installed = await resolved.world.evaluate<boolean>('typeof globalThis.__selectorGenerator === "object"', {
          what: 'checking for the selector generator in the isolated world',
        })
        if (!installed) {
          const source = await fs.promises.readFile(path.join(__dirname, '..', 'dist', 'selector-generator.js'), 'utf-8')
          await resolved.world.evaluate<undefined>(source, { what: 'installing the selector generator in the isolated world' })
        }
        const locator = await resolved.world.callFunctionOnNodes<string | null>([resolved.backendNodeId], LOCATOR_STRING_FN, {
          what: 'generating a locator for the element',
        })
        if (locator === null) throw new Error('getLocatorStringForElement: the element was removed from the page before its locator could be generated')
        return locator
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

      // getCDPSessionForPage refuses a closed page itself, with a model-facing message.
      const getCDPSession = (options: { page: Page }) => getCDPSessionForPage({ page: options.page })
      /** The sandbox's getCDPSession(): in human mode the shared session, read-only (see READ_ONLY_CDP_COMMANDS). */
      const sandboxGetCDPSession = async (options: { page: Page }): Promise<ICDPSession> => {
        const session = await getCDPSession(options)
        return self.policy === 'human' ? new ReadOnlyCdpSession(session) : session
      }

      const createDebugger = (options: { cdp: ICDPSession }) => new Debugger(options)
      const createEditor = (options: { cdp: ICDPSession }) => new Editor(options)

      /** The element a ref names, as the element readers take it, with its tab and that tab's session. */
      const elementOfRef = async (ref: number | string): Promise<{ target: ResolvedElement; page: Page; cdp: ICDPSession }> => {
        const element = await self.probes.element(ref)
        return { target: refElementTarget(element), page: element.page, cdp: element.probe.cdp }
      }

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
        locator?: any
        /** A ref from observe()/find(): read over CDP, no Playwright script in the page. */
        ref?: number | string
        /** Reused when supplied; otherwise the element's page session. */
        cdp?: ICDPSession
        /** Include browser default (user-agent) rules in `rules`. Default false. */
        includeUserAgentStyles?: boolean
      }) => {
        if (options.ref !== undefined) {
          const element = await elementOfRef(options.ref)
          // Its own document's session by default, so an out-of-process iframe's element reads too.
          return getStylesForLocator({ locator: element.target, cdp: options.cdp ?? element.target.cdp, includeUserAgentStyles: options.includeUserAgentStyles })
        }
        refuseScriptForm('getStylesForLocator({ locator })', 'the locator', 'getStylesForLocator({ ref: 12 })')
        const cdp = options.cdp ?? (await getCDPSession({ page: options.locator.page() }))
        return getStylesForLocator({
          locator: options.locator,
          cdp,
          includeUserAgentStyles: options.includeUserAgentStyles,
        })
      }

      const getReactSourceFn = async (options: { locator?: any; ref?: number | string }) => {
        if (options.ref !== undefined) {
          const element = await elementOfRef(options.ref)
          return getReactSource({ locator: element.target, cdp: element.cdp })
        }
        refuseScriptForm('getReactSource({ locator })', 'the locator', 'getReactSource({ ref: 12 })')
        const cdp = await getCDPSession({ page: options.locator.page() })
        return getReactSource({ locator: options.locator, cdp })
      }

      const getReactComponentInfoFn = async (options: { locator?: Locator | ElementHandle; ref?: number | string }) => {
        if (options.ref !== undefined) {
          const element = await elementOfRef(options.ref)
          return getReactComponentInfo({ locator: element.target, cdp: element.cdp })
        }
        if (!options.locator) throw new ModelFacingError('getReactComponentInfo needs { ref } (a ref from observe() or find()) or { locator }.')
        refuseScriptForm('getReactComponentInfo({ locator })', 'the locator', 'getReactComponentInfo({ ref: 12 })')
        const locator = options.locator
        const targetPage = await (async (): Promise<Page | null> => {
          if ('page' in locator) {
            return locator.page()
          }

          return (await locator.ownerFrame())?.page() ?? null
        })()
        if (!targetPage) {
          throw new Error('Could not get page from locator')
        }
        const cdp = await getCDPSession({ page: targetPage })
        return getReactComponentInfo({ locator, cdp })
      }

      /**
       * The element debugStyle/whyOccluded read, its page and that page's session. `ref` is read over
       * CDP; `locator`, or `node` — a PageModel handle (carries a `.locator` selector string) or a raw
       * locator — is resolved with Playwright's script in the page, so human mode refuses those.
       */
      const resolveStyleTarget = async (
        options: { ref?: number | string; locator?: any; node?: any },
        call: 'debugStyle' | 'whyOccluded',
      ): Promise<{ target: ElementTarget; page: Page; cdp: ICDPSession }> => {
        if (options.ref !== undefined) return await elementOfRef(options.ref)
        const locator: Locator | null =
          options.locator && typeof options.locator.page === 'function'
            ? options.locator
            : typeof options.node?.page === 'function'
              ? options.node
              : typeof options.node?.locator === 'string'
                ? page.locator(options.node.locator)
                : null
        if (!locator) throw new Error(`${call} needs { ref } (a ref from observe() or find()), a { locator }, or a { node } with a locator`)
        refuseScriptForm(`${call}({ ${options.locator ? 'locator' : 'node'} })`, options.locator ? 'the locator' : "the node's locator", `${call}({ ref: 12 })`)
        return { target: locator, page: locator.page(), cdp: await getCDPSession({ page: locator.page() }) }
      }

      // The code frame of a winning declaration: its stylesheet's text around the rule. A rule
      // without a stylesheet (an inline style attribute, the browser's own defaults) has none; a
      // stylesheet whose text cannot be read says why instead of leaving the frame out unexplained.
      const renderDeclCodeFrame = async (
        cdp: ICDPSession,
        rule: NormalizedRule | undefined,
        message: string,
      ): Promise<string | null> => {
        if (!rule || !rule.styleSheetId || !rule.source) return null
        let text: string
        try {
          ;({ text } = await withDeadline(
            cdp.send('CSS.getStyleSheetText', { styleSheetId: rule.styleSheetId }),
            5000,
            `reading the stylesheet of ${rule.selector}`,
          ))
        } catch (error) {
          return `(no code frame: the text of the stylesheet with ${rule.selector} could not be read — ${error instanceof Error ? error.message : String(error)})`
        }
        if (text.length === 0) return `(no code frame: Chrome returned no text for the stylesheet with ${rule.selector})`
        return clippedCodeFrame(text, rule.source.line, rule.source.column + 1, message)
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
      const debugStyle = async (options: { ref?: number | string; locator?: any; node?: any; property?: string }) => {
        const { target, cdp: pageCdp } = await resolveStyleTarget(options, 'debugStyle')
        // A ref's element is read in its own document's session, an out-of-process iframe's too.
        const cdp = 'backendNodeId' in target ? target.cdp : pageCdp
        const { rules } = await fetchNormalizedStyles({ locator: target, cdp })
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
       * silent pick here) is the thing that reports a conflict. `root` scopes the fetch to
       * an element resolved from a ref instead.
       */
      type BuildPageModelOptions = { page?: Page; rootSelector?: string; scope?: string; root?: ResolvedElement }
      const buildPageModelFn = async (options?: BuildPageModelOptions): Promise<PageModel> => {
        const p = options?.page || page
        const cdp = await getCDPSession({ page: p })
        const model = await buildPageModel({
          page: p,
          cdp,
          rootSelector: options?.rootSelector,
          scope: options?.scope,
          root: options?.root,
        })
        const prev = self.lastPageModel.get(p)
        if (prev) model.diffAgainst(prev)
        self.lastPageModel.set(p, model)
        return model
      }

      /**
       * `pm`: lazy per-execute accessor. Builds the page model once (per page + root
       * selector or root ref) and reuses it across anchor/query/renderText/debugMode calls
       * in the same turn. Returns only cycle-free projections (handles/rows/strings), never
       * the live model.
       *
       * The cache is keyed by page AND root, because a root-scoped model is a DIFFERENT
       * tree: keying by page alone would let the first call's scope silently decide what
       * every later call in the turn can see.
       */
      const pmModels = new Map<string, PageModel>()
      const pmPageKeys = new WeakMap<Page, number>()
      let pmPageSeq = 0
      const getPmModel = async (opts?: PmModelOptions): Promise<PageModel> => {
        const rootSelector = opts?.rootSelector ?? opts?.scope
        if (rootSelector != null) {
          refuseScriptForm('pm.*({ rootSelector })', 'the root selector', 'pm.query({ rootRef: 12 }) builds the model under that element')
        }
        const root = opts?.rootRef === undefined ? null : await elementOfRef(opts.rootRef)
        if (root && opts?.page && opts.page !== root.page) {
          throw new ModelFacingError(`pm: rootRef [${opts.rootRef}] is in another tab than the \`page\` passed. Leave \`page\` out: a ref names its tab.`)
        }
        const p = root?.page ?? opts?.page ?? page
        if (!p) {
          throw new Error('pm requires a page')
        }
        let pageKey = pmPageKeys.get(p)
        if (pageKey === undefined) {
          pageKey = ++pmPageSeq
          pmPageKeys.set(p, pageKey)
        }
        // NUL separates the parts because neither a page id, a selector nor a ref can
        // contain it, so no (page, selector, ref) triple can collide with another. It MUST stay
        // written as an escape: a raw NUL byte here makes the whole file read as binary,
        // and grep then skips it in silence — which is exactly how one slipped in.
        const cacheKey = `${pageKey}\u0000${rootSelector ?? ''}\u0000${opts?.rootRef ?? ''}`
        const existing = pmModels.get(cacheKey)
        if (existing) return existing
        const model = await buildPageModelFn({ page: p, rootSelector: opts?.rootSelector, scope: opts?.scope, root: root?.target })
        pmModels.set(cacheKey, model)
        return model
      }

      /**
       * Everything `pm.*` accepts for choosing/scoping the model it builds. `rootSelector` (a
       * Playwright selector, debug mode only) or `rootRef` (a ref from observe()/find()) scopes the
       * build to one element's subtree.
       */
      type PmModelOptions = { page?: Page; rootSelector?: string; scope?: string; rootRef?: number | string }
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
        const { scope: _buildScope, rootSelector: _rootSelector, rootRef: _rootRef, page: _page, ...queryOpts } = opts
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
      const whyOccluded = async (options: { ref?: number | string; locator?: any; node?: any; page?: Page }) => {
        const { target, page: elementPage, cdp: elementCdp } = await resolveStyleTarget(options, 'whyOccluded')
        if (options.ref !== undefined && options.page && options.page !== elementPage) {
          throw new ModelFacingError(`whyOccluded: [${options.ref}] is in another tab than the \`page\` passed. Leave \`page\` out: a ref names its tab.`)
        }
        if ('backendNodeId' in target && target.ownSession) {
          throw new ModelFacingError(
            `whyOccluded: [${options.ref}] is inside an out-of-process iframe (frame ${target.frameId}, ${target.frame.url()}). ` +
              "whyOccluded measures the tab's own document, which cannot see into another renderer process. observe() reports " +
              `what covers that iframe's controls, and debugStyle({ ref: ${options.ref} }) reads the element's cascade.`,
          )
        }
        const targetPage: Page = options.page ?? elementPage
        const cdp = targetPage === elementPage ? elementCdp : await getCDPSession({ page: targetPage })
        const { rules } = await fetchNormalizedStyles({ locator: target, cdp })
        const cascade = resolveCascade(rules)

        const stacking: Record<string, { value: string; selector: string; important: boolean; source: DeclRef['source'] }> =
          {}
        for (const prop of STACKING_PROPS) {
          const ref = cascade.winnerFor[prop]
          if (ref) {
            stacking[prop] = { value: ref.value, selector: ref.selector, important: ref.important, source: ref.source }
          }
        }

        // Join the element to the measured model. A ref joins by its node; a handle from THIS turn
        // resolves by key; otherwise fall back to the locator string the model indexes nodes under.
        const model = await getPmModel({ page: targetPage })
        const handleKey = typeof options.node?.key === 'string' ? options.node.key : null
        const selector: string | undefined =
          (typeof options.node?.locator === 'string' ? options.node.locator : undefined) ??
          ('selector' in target ? target.selector() : undefined)
        const anchored = 'backendNodeId' in target ? model.anchor({ backendNodeId: target.backendNodeId }) : selector ? model.anchor(selector) : null
        const modelNode = (handleKey ? model.byKey.get(handleKey as never) : undefined) ?? (anchored ? model.byKey.get(anchored.key) : undefined)

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

      const screenshotCollector: ScreenshotResult[] = []
      // Separate collector for images produced by resizeImageForAgent() calls.
      // These get merged into result.images so the CLI can emit them via Kitty Graphics.
      const resizedImageCollector: Array<{ data: string; mimeType: string }> = []

      const resizeImageForAgentFn: typeof resizeImageForAgent = async (options) => {
        const result = await resizeImageForAgent(options)
        resizedImageCollector.push({ data: result.buffer.toString('base64'), mimeType: result.mimeType })
        return result
      }

      /**
       * A screenshot with observe()'s refs drawn on it, rendered in Node from one capture of the
       * viewport: nothing is added to the page. The labels are exactly the refs observe() prints.
       */
      const screenshotWithAccessibilityLabelsFn = async (options: { page?: Page; scope?: number } = {}) => {
        const target = options.page ?? currentPage()
        const observation = await self.probes.observe(target, context, options.scope === undefined ? {} : { scope: options.scope }, false)
        const probe = await self.probes.get(target)
        await screenshotWithAccessibilityLabels({
          cdp: probe.cdp,
          world: probe.world,
          observation,
          ...(options.scope === undefined ? {} : { scope: options.scope }),
          collector: screenshotCollector,
        })
      }

      /** screenshot() / diffScreenshot() (page-screenshot.ts): plain captures of the controlled tab, saved in the session folder. */
      const screenshotDeps = async (): Promise<ScreenshotDeps> => {
        const target = currentPage()
        const probe = await self.probes.get(target)
        return {
          policy: self.policy,
          page: target,
          cdp: probe.cdp,
          world: probe.world,
          dialog: () => probe.dialogs.current(),
          observe: () => self.probes.observe(target, context, {}, false),
          jail: self.scopedFs,
          emit: (image) => resizedImageCollector.push(image),
        }
      }
      const screenshotFn = async (options?: unknown) => await takeScreenshot(options, await screenshotDeps())
      const diffScreenshotFn = async (baselinePath: unknown, options?: unknown) => await diffScreenshot(baselinePath, options, await screenshotDeps())

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
      // everything it crosses, which is a behaviour change, not a visual nicety. act.* drives
      // the driver itself; sandbox code gets `humanMouse` below.
      const humanMouseDriver = createHumanMouseApi({
        defaultPage: page,
        getCdpSession: getCDPSession,
        // A ref's element is measured over CDP (content quads, mapped through its iframes), clipped
        // to the viewport: nothing runs in the page.
        resolveRef: async (ref) => {
          const element = await self.probes.element(ref)
          const label = `[${element.target.ref}] ${element.target.role}${element.target.name ? ` "${element.target.name}"` : ''}`
          const rects = await element.probe.frames
            .contentRects(element.frame, element.target.backendNodeId, `measuring ${label}`)
            .catch((error: unknown) => {
              if (error instanceof Error && /Could not compute content quads/i.test(error.message)) {
                throw new ActError(`${label} has no box on the page now (hidden, removed, or not laid out). observe() shows what is visible.`)
              }
              throw error
            })
          const viewport = await element.probe.frames.box(element.probe.frames.mainFrameId())
          const visible = rects.flatMap((rect) => {
            const x = Math.max(rect.x, 0)
            const y = Math.max(rect.y, 0)
            const right = Math.min(rect.x + rect.width, viewport.width)
            const bottom = Math.min(rect.y + rect.height, viewport.height)
            return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : []
          })
          if (rects.length > 0 && visible.length === 0) {
            throw new ActError(`${label} is outside the visible page. Bring it into view first: act.scrollTo(${element.target.ref}).`)
          }
          return { page: element.page, rects: visible, label }
        },
      })
      /** Human mode: the locator forms measure the element with Playwright's script in the page (`locator.boundingBox()`). */
      const refuseHumanMouseLocator = (method: string, moveOptions: HumanMoveOptions | undefined): void => {
        if (moveOptions?.locator) refuseScriptForm(`humanMouse.${method}({ locator })`, 'the locator', `humanMouse.${method}({ ref: 12 })`)
      }
      const humanMouse: HumanMouseApi = {
        plan: async (moveOptions: HumanMoveOptions) => {
          refuseHumanMouseLocator('plan', moveOptions)
          return await humanMouseDriver.plan(moveOptions)
        },
        moveTo: async (moveOptions: HumanMoveOptions) => {
          refuseHumanMouseLocator('moveTo', moveOptions)
          return await humanMouseDriver.moveTo(moveOptions)
        },
        click: async (clickOptions: HumanClickOptions) => {
          refuseHumanMouseLocator('click', clickOptions)
          return await humanMouseDriver.click(clickOptions)
        },
        hover: async (moveOptions: HumanMoveOptions) => {
          refuseHumanMouseLocator('hover', moveOptions)
          return await humanMouseDriver.hover(moveOptions)
        },
        enable: async (enableOptions) => {
          if (self.policy === 'human') {
            throw new ActError(
              'Refused (human mode): humanMouse.enable() routes locator.click/dblclick/hover through human motion, and those locator ' +
                "actions run Playwright's script in the page, which Playwright runs as a user gesture (the page then counts as clicked: " +
                'navigator.userActivation). Click and hover like a person with a ref from observe() or find(): act.click(12), ' +
                'act.hover(12). Nothing from this call was run.',
            )
          }
          return await humanMouseDriver.enable(enableOptions)
        },
        disable: humanMouseDriver.disable,
        isEnabled: humanMouseDriver.isEnabled,
        position: humanMouseDriver.position,
        defaults: humanMouseDriver.defaults,
      }

      // ---- observe / find / explain / act: the "browse like a human" layer ----------------
      // They act on the sandbox's CURRENT `page`, read at call time (user code may reassign it).
      // observe/find/explain PRINT their text into the call's output, because a weak model that
      // forgets to log what it looked at learns nothing; what they return inspects as one line,
      // so `return await observe()` does not print the page twice.
      const currentPage = (): Page => vmContextObj.page
      /**
       * The controlled page once a close of it seen during this call has its verdict (noteCutDuringCall):
       * a tab really closed is replaced (TAB CLOSED), a cut one re-adopted, before anything reads it.
       * A sandbox `page` that was the controlled page and got replaced follows the replacement.
       */
      const settledPage = async (): Promise<Page> => {
        if (self.debuggerCuts.pending) await self.noteCutDuringCall(run)
        const held = vmContextObj.page
        const controlled = self.page
        if (held.isClosed() && self.replacedPages.has(held) && controlled && !controlled.isClosed()) {
          vmContextObj.page = controlled
          run.follow?.(controlled)
        }
        return vmContextObj.page
      }
      /**
       * `read` on `explicit`, else on the controlled page (settledPage). The controlled tab can close
       * while it is read, before its close event reaches this session (the protocol says "closed"
       * first): then the close is waited for briefly, its verdict settled, and the read is made once
       * on the page now controlled — never a failure that reads the closed tab.
       */
      const readControlled = async <T,>(explicit: Page | undefined, read: (target: Page) => Promise<T>): Promise<{ target: Page; value: T }> => {
        if (explicit) return { target: explicit, value: await read(explicit) }
        const target = await settledPage()
        try {
          return { target, value: await read(target) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!target.isClosed() && !message.includes('has been closed')) throw error
          if (!target.isClosed()) {
            const closing = Promise.withResolvers<void>()
            const timer = setTimeout(closing.resolve, CLOSE_EVENT_WAIT_MS)
            target.once('close', () => closing.resolve())
            await closing.promise
            clearTimeout(timer)
          }
          const next = await settledPage()
          if (next === target || next.isClosed()) throw error
          return { target: next, value: await read(next) }
        }
      }
      /** `api` whose calls first wait for a pending closed-page verdict (settledPage); its getPage is synchronous. */
      const afterClosedVerdict = <T extends object>(api: T): T =>
        new Proxy(api, {
          get(target, key, receiver) {
            const value: unknown = Reflect.get(target, key, receiver)
            if (typeof value === 'function') {
              return (...args: unknown[]) =>
                self.debuggerCuts.pending || (vmContextObj.page.isClosed() && self.replacedPages.has(vmContextObj.page))
                  ? settledPage().then(() => Reflect.apply(value, target, args))
                  : Reflect.apply(value, target, args)
            }
            if (typeof value === 'object' && value !== null) return afterClosedVerdict(value)
            return value
          },
        })
      const quietInspect = <T extends object>(value: T, summary: string): T => {
        Object.defineProperty(value, util.inspect.custom, { value: () => summary, enumerable: false })
        return value
      }

      const observe = async (options: ObserveOptions & { page?: Page } = {}): Promise<Observation> => {
        const { target, value: observation } = await readControlled(options.page, (candidate) => self.probes.observe(candidate, context, options))
        const pinned = await renderPins(target, observation)
        run.probeOutput.push(pinned ? `${renderObservation(observation, options)}\n${pinned}` : renderObservation(observation, options))
        return quietInspect(observation, `[observation of ${observation.url} — printed above]`)
      }

      /**
       * What the human pointed at with Chrome's element picker (extension menu "Pin an element for
       * Playwriter"), newest first, placed among the refs just observed. A pin whose node is gone is
       * reported once and then dropped: it can never resolve again.
       */
      const renderPins = async (target: Page, observation: Observation): Promise<string> => {
        const probe = await self.probes.get(target)
        const pins = probe.pins.pins().reverse()
        if (pins.length === 0) return ''
        const shown = pins.slice(0, MAX_PINS_SHOWN)
        const lines = await Promise.all(
          shown.map(async (pin) => {
            const located = await self.probes.locateNode(target, observation, pin.backendNodeId)
            if (located.kind === 'gone') probe.pins.forget(pin.backendNodeId)
            return `  ${renderLocatedNode(located)} — pinned ${Math.round((Date.now() - pin.at) / 1000)}s ago`
          }),
        )
        const older = pins.length - shown.length
        return (
          `PINNED by the user — they pointed at these with Chrome's element picker, newest first:\n${lines.join('\n')}` +
          (older > 0 ? `\n  + ${older} older pin(s)` : '')
        )
      }

      const find = async (query: string, options: { limit?: number; page?: Page } = {}): Promise<{ text: string } | QueryResult> => {
        // role/, label/, text/, pierce/… (page-query.ts); plain words are searched in what observe() lists.
        const handlerQuery = typeof query === 'string' ? parseQuery(query) : null
        if (handlerQuery) {
          const { value: result } = await readControlled(options.page, (target) =>
            runQuery({ probes: self.probes, context }, target, handlerQuery, { limit: options.limit }),
          )
          run.probeOutput.push(result.text)
          return quietInspect(result, `[find("${query}") — ${result.count} match${result.count === 1 ? '' : 'es'}, printed above]`)
        }
        const { value: observation } = await readControlled(options.page, (target) => self.probes.observe(target, context))
        const text = findInObservation(observation, query, { limit: options.limit })
        run.probeOutput.push(text)
        return quietInspect({ text }, `[find("${query}") — printed above]`)
      }

      /** Refs are unique across the session's tabs, so the ref alone says which tab to read. */
      const explain = async (ref: number | string): Promise<object> => {
        const resolution = self.probes.registry.resolve(ref)
        if (!resolution.ok) {
          throw new ActError(resolution.error)
        }
        const target = self.probes.pageOf(resolution.target.targetId)
        if (!target) {
          throw new ActError(`[${resolution.target.ref}] was listed in a tab that is no longer open. observe() the tab you are working in for current refs.`)
        }
        const probe = await self.probes.get(target)
        const explanation = await explainElement({
          page: target,
          frames: probe.frames,
          frameId: resolution.target.frameId,
          backendNodeId: resolution.target.backendNodeId,
          jsDialog: probe.dialogs.current(),
        })
        const head = `[${resolution.target.ref}] ${resolution.target.role}${resolution.target.name ? ` "${resolution.target.name}"` : ''}`
        run.probeOutput.push(`${head}\n${renderExplanation(explanation)}`)
        return quietInspect(explanation, `[explanation of ${head} — printed above]`)
      }

      /**
       * Read the page with a function run in the page under V8's side-effect check, in the frame of
       * `ref` (read-page.ts): nothing it calls can change the page, and no user gesture is involved.
       * The function's console.* lines print with the call's console output.
       */
      const readPageFn = async (fn: unknown, options?: unknown): Promise<unknown> =>
        await readPage(fn, options, {
          probes: self.probes,
          context,
          currentPage,
          log: (level, text) => consoleLogs.push({ method: level, args: [`[readPage] ${text}`] }),
          resolveQuery: async (query, target) => await queryRef({ probes: self.probes, context }, target, query),
        })

      /**
       * Accessibility audit (page-audit.ts): axe-core in each frame's isolated world plus playwriter's
       * own checks, printed grouped by impact with refs; the full report is the return value.
       */
      const audit = async (options?: unknown): Promise<AuditReport> => {
        const report = await runAudit(options, {
          probes: self.probes,
          currentPage,
          observeQuietly: (target) => self.probes.observe(target, context, {}, false),
          deadlineAt: run.deadlineAt,
        })
        run.probeOutput.push(report.text)
        return quietInspect(report, `[audit of ${report.url} — printed above]`)
      }

      /**
       * Ask the human to point at the element they mean: Chrome's element picker turns on in the tab
       * (elements highlight under their pointer) and the call waits for their click. Nothing is added
       * to the page. The wait is bounded by this call's own timeout.
       */
      const pickElement = async (options: { page?: Page; timeoutMs?: number } = {}): Promise<{ ref?: number; text: string }> => {
        const target = options.page ?? (await settledPage())
        const probe = await self.probes.get(target)
        // Room left after the click for the observation that turns it into a ref.
        const available = run.deadlineAt - Date.now() - 5000
        const timeoutMs = options.timeoutMs ?? available
        if (available <= 0 || timeoutMs > available) {
          throw new ActError(
            `pickElement needs ${options.timeoutMs === undefined ? 'time' : `${options.timeoutMs}ms`} to wait for the user's click, but this call has ` +
              `${Math.max(0, available)}ms left for it. Give execute a larger timeout (e.g. 120000) — the user needs time to find the element.`,
          )
        }
        const picked = await probe.pins.pickElement({ timeoutMs })
        const observation = await self.probes.observe(target, context, {}, false)
        const located = await self.probes.locateNode(target, observation, picked.backendNodeId)
        const text = `The user picked ${renderLocatedNode(located)}.`
        run.probeOutput.push(text)
        return quietInspect({ ...(located.kind === 'element' ? { ref: located.element.ref } : {}), text }, '[pickElement — printed above]')
      }

      /**
       * The command the extension's "Pin an element for Playwriter" puts on the clipboard. Finds the
       * tab the element was pinned in, makes it `state.page`, and prints the element's ref, its markup
       * and explain() of it (component chain, handlers, what they do).
       */
      const inspectPinnedElement = async (pin: { url: string; backendNodeId: number }): Promise<object> => {
        if (typeof pin !== 'object' || pin === null || typeof pin.url !== 'string' || !Number.isInteger(pin.backendNodeId)) {
          throw new ActError(
            'inspectPinnedElement takes { url, backendNodeId }: paste the command the extension copied when the element was pinned.',
          )
        }
        const open = context.pages().filter((candidate) => !candidate.isClosed())
        // The tab whose picker reported this node is exact. A session started after the pin never
        // saw the event; then the pinned page's URL identifies the tab, if exactly one shows it.
        const owners: Page[] = []
        for (const candidate of open) {
          const candidateProbe = await self.probes.get(candidate)
          if (candidateProbe.pins.pins().some((existing) => existing.backendNodeId === pin.backendNodeId)) owners.push(candidate)
        }
        const showingUrl = open.filter((candidate) => candidate.url() === pin.url)
        const matches = owners.length > 0 ? owners : showingUrl
        if (matches.length !== 1) {
          const tabs = open.map((candidate, index) => `  ${index}: ${candidate.url()}`).join('\n')
          throw new ActError(
            matches.length === 0
              ? `No open tab shows ${pin.url}, where the element was pinned. Open tabs:\n${tabs}`
              : `${matches.length} tabs show ${pin.url}; the pin cannot be told apart between them. Ask the user to pin the element again. Open tabs:\n${tabs}`,
          )
        }
        const target = matches[0]
        this.userState.page = target
        const probe = await self.probes.get(target)
        const observation = await self.probes.observe(target, context, {}, false)
        const located = await self.probes.locateNode(target, observation, pin.backendNodeId)
        if (located.kind === 'gone') {
          probe.pins.forget(pin.backendNodeId)
          throw new ActError(
            `The pinned element is no longer on ${target.url()}: it was removed, or the page navigated after it was pinned. Ask the user to pin it again.`,
          )
        }
        const outer = await withDeadline(
          probe.cdp.send('DOM.getOuterHTML', { backendNodeId: pin.backendNodeId }),
          5000,
          'reading the pinned element markup',
        )
        const markup =
          outer.outerHTML.length > MAX_PINNED_MARKUP ? `${outer.outerHTML.slice(0, MAX_PINNED_MARKUP)}… (${outer.outerHTML.length} chars)` : outer.outerHTML
        // Handlers and components live on the control the point is inside, when there is one.
        const explained = await explainElement({
          page: target,
          frames: probe.frames,
          frameId: located.kind === 'element' ? located.element.frameId : probe.frames.mainFrameId(),
          backendNodeId: located.kind === 'element' ? located.element.backendNodeId : pin.backendNodeId,
          jsDialog: probe.dialogs.current(),
        })
        const head = `PINNED  ${renderLocatedNode(located)} · ${target.url()} (now state.page)`
        run.probeOutput.push(`${head}\nMARKUP  ${markup}\n${renderExplanation(explained)}`)
        return quietInspect(
          { url: target.url(), ...(located.kind === 'element' ? { ref: located.element.ref } : {}), markup, explanation: explained },
          `[${head} — printed above]`,
        )
      }

      /**
       * The full reference, readable from inside a call. The MCP description carries only the short
       * guide, and not every MCP client lets a model read resources, so the docs travel through
       * execute itself: docs() lists the headings, docs('recording') prints the matching sections.
       * It is the build's dist/skill-reference.md — skill.md without its `## CLI Usage` section,
       * so a session is never told to run the CLI or a shell command (`playwriter skill` prints all).
       */
      const docs = async (topic?: string): Promise<{ text: string }> => {
        const reference = await fs.promises.readFile(path.join(__dirname, '..', 'dist', 'skill-reference.md'), 'utf-8')
        const text = topic
          ? filterMarkdownSections(reference, topic) ||
            `No reference heading contains "${topic}". docs() lists every heading; pick words from one of them.`
          : `${extractMarkdownOutline(reference)}\n\nRead a section with docs('<words from its heading>').`
        run.probeOutput.push(text)
        return quietInspect({ text }, `[docs(${topic === undefined ? '' : JSON.stringify(topic)}) — printed above]`)
      }

      // Wrapped so act's own Playwright calls run inside `insideAct`: the raw-action tap counts only the code's;
      // and so each call waits for the verdict on a controlled tab that closed (afterClosedVerdict).
      const act = markedAsAct(
        afterClosedVerdict(
        createActApi({
          getPage: currentPage,
          setPage: (target) => {
            vmContextObj.page = target
            self.page = target
            run.follow?.(target)
          },
          listTabs: () => context.pages().filter((candidate) => !candidate.isClosed()),
          pageOf: (targetId) => self.probes.pageOf(targetId),
          registry: self.probes.registry,
          getProbe: (target) => self.probes.get(target),
          humanMouse: humanMouseDriver,
          mode: self.policy,
          signal: run.signal,
          deadlineAt: run.deadlineAt,
          cwd: self.sessionCwd || process.cwd(),
          records: run.actRecords,
          rawActions: run.rawActions,
          activity: run.actActivity,
          observeQuietly: (target, known) => self.probes.observe(target, context, {}, false, known),
          setDialogPolicy: (policy, options) => self.probes.setDialogPolicy(policy, options),
        }),
        ),
      )

      const webmcp = afterClosedVerdict(createWebMcpApi({
        getPage: currentPage,
        getProbe: (target) => self.probes.get(target),
        mode: self.policy,
        signal: run.signal,
        deadlineAt: run.deadlineAt,
        records: run.actRecords,
        rawActions: run.rawActions,
        observeQuietly: (target) => self.probes.observe(target, context, {}, false),
      }))

      /**
       * The previous implementation polled `performance.getEntriesByType('resource')`, which lists a
       * request only once it has FINISHED: an in-flight fetch was invisible, so it reported "loaded" in
       * the middle of one. It is now the page journal's settle (DOM content quiet + network quiet among
       * the requests made since this call's code started on that page — page.goto's subresources
       * included), with the same result shape. Its `pollInterval` option is gone: the journal is
       * event-driven, so there is no polling interval to set.
       */
      const waitForPageLoadFn = async (options: { page?: Page; timeout?: number; minWait?: number } = {}): Promise<WaitForPageLoadResult> => {
        const target = options.page ?? (await settledPage())
        const probe = await self.probes.get(target)
        const startedAt = Date.now()
        const result = await probe.watch.settle({
          since: run.start?.page === target ? run.start.checkpoint : probe.watch.checkpoint(),
          timeoutMs: options.timeout ?? 30_000,
        })
        const minWait = options.minWait ?? 0
        if (result.settled && Date.now() - startedAt < minWait) {
          await sleep(minWait - (Date.now() - startedAt))
        }
        const readyState =
          result.reason === 'js-dialog' || result.reason === 'page-closed'
            ? result.reason
            : await probe.world.evaluate<string>('document.readyState', { what: 'reading document.readyState' })
        return {
          success: result.settled,
          readyState,
          pendingRequests: result.pendingRequests.map((request) => `${request.method} ${request.url}`),
          waitTimeMs: Math.round(result.waitedMs),
          timedOut: result.reason === 'timeout',
        }
      }

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
        // In the tab's isolated world: no user gesture, and no getter the page could have replaced.
        viewportOf: async (target) =>
          (await self.probes.get(target)).world.evaluate<{ width: number; height: number }>('({ width: innerWidth, height: innerHeight })', {
            what: 'reading the viewport size for the pointer track',
          }),
        // A launched headless Chrome and a direct CDP connection have no extension, so no tab capture:
        // there recording.* drive this session's CDP screencast (startCdp below; arrows because those
        // are declared further down).
        tabCapture: !self.isHeadlessMode() && !self.isDirectCdpMode(),
        cdp: {
          start: ({ page: target, outputPath, fps, maxDurationMs, pointer }) => startCdpRecording({ page: target, outputPath, fps, maxDurationMs, pointer }),
          stop: () => stopCdpRecording(),
          cancel: async () => {
            await cancelCdpRecording()
          },
          active: () => (self.cdpScreencast ? { startedAt: self.cdpScreencast.startedAt, frames: self.cdpScreencast.frameCount() } : null),
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
          self.traceProbeOwners.add(p)
          return netDelay({
            page: p,
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
        /**
         * Every request this page made since playwriter first saw it (ring of the last 500),
         * filterable — the request log omp's browser tool keeps, ported. Ids are `r1`, `r2`…
         */
        requests: async (filter: { urlIncludes?: string; method?: string; failedOnly?: boolean; limit?: number; page?: Page } = {}) => {
          const probe = await self.probes.get(filter.page ?? currentPage())
          return probe.watch.requests(filter)
        },
        /**
         * Everything Chrome reported about one request (`r12`): request and response headers (as on the wire
         * when Chrome reported them), status text, sizes, duration, failure and CORS reason, request body,
         * and the response body (textual bodies decoded, capped at 64K characters). Credential headers are
         * redacted unless `secrets: true`.
         */
        request: async (id: string, options: { page?: Page; secrets?: boolean } = {}) => {
          const probe = await self.probes.get(options.page ?? currentPage())
          return await requestDetail(probe.watch, id, { secrets: options.secrets === true })
        },
        /**
         * The page's request journal written as a HAR 1.2 file (jailed like the sandbox fs), with the
         * response bodies Chrome still holds. A read: nothing is requested again.
         */
        har: async (options: { path: string; page?: Page; urlIncludes?: string; bodies?: boolean; secrets?: boolean }) => {
          const resolved = jailedTarget({ jail: self.scopedFs, target: options?.path, call: 'net.har({ path })', example: "net.har({ path: 'requests.har' })" })
          const target = options.page ?? currentPage()
          const probe = await self.probes.get(target)
          return await writeHar({
            journal: probe.watch,
            target: resolved,
            pageUrl: target.url(),
            secrets: options.secrets === true,
            bodies: options.bodies !== false,
            ...(options.urlIncludes !== undefined ? { urlIncludes: options.urlIncludes } : {}),
          })
        },
        /**
         * One request's WHOLE response body written to a file (an image, a large JSON response — what
         * net.request caps at 64K characters), decoded to bytes. The path is resolved and jailed like
         * the sandbox fs (relative to the session folder). Returns where it went and its size.
         */
        save: async (id: string, target: string, options: { page?: Page } = {}) => {
          const resolved = jailedTarget({ jail: self.scopedFs, target, call: `net.save('${id}', path)`, example: `net.save('${id}', 'image.png')` })
          const probe = await self.probes.get(options.page ?? currentPage())
          let response: { status?: number; mimeType?: string; bytes: Buffer }
          try {
            response = await probe.watch.responseBytes(id)
          } catch (error) {
            if (error instanceof ModelFacingError) throw error
            throw new ModelFacingError(`${error instanceof Error ? error.message : String(error)} Nothing was saved.`, { cause: error })
          }
          try {
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            fs.writeFileSync(resolved, response.bytes)
          } catch (error) {
            throw new ModelFacingError(`net.save('${id}', path): writing ${resolved} failed: ${error instanceof Error ? error.message : String(error)}. Nothing was saved.`, { cause: error })
          }
          return { id, path: resolved, bytes: response.bytes.length, status: response.status, mimeType: response.mimeType }
        },
      }

      /**
       * `identity: true` adds identity tokens held by playwriter per frame (nothing is stored on the page) for every object/function prop.
       * That is the ONLY way handler-identity churn survives the process boundary: the
       * default serialisation renders every function as `[function]`, so two different
       * arrows look identical to `fiberDiff`.
       */
      const fiberSnapshotFn = async (options: {
        locator?: Locator | ElementHandle
        /** A ref from observe()/find(): read over CDP, no Playwright script in the page. */
        ref?: number | string
        identity?: boolean
        maxKeys?: number
        maxDepth?: number
      }) => {
        let target: ElementTarget
        let cdp: ICDPSession
        if (options.ref !== undefined) {
          ;({ target, cdp } = await elementOfRef(options.ref))
        } else {
          if (!options.locator) throw new ModelFacingError('fiberSnapshot needs { ref } (a ref from observe() or find()) or { locator }.')
          refuseScriptForm('fiberSnapshot({ locator })', 'the locator', 'fiberSnapshot({ ref: 12 })')
          const locator = options.locator
          const targetPage = await (async (): Promise<Page | null> => {
            if ('page' in locator) return locator.page()
            return (await locator.ownerFrame())?.page() ?? null
          })()
          if (!targetPage) throw new Error('Could not get page from locator')
          target = locator
          cdp = await getCDPSession({ page: targetPage })
        }
        if (options.identity) {
          return fiberSnapshot({
            locator: target,
            cdp,
            identity: true,
            maxKeys: options.maxKeys,
            maxDepth: options.maxDepth,
          })
        }
        return fiberSnapshot({ locator: target, cdp })
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
        if (options.ref !== undefined && (options.locator || options.selector)) {
          throw new ModelFacingError('traceValue: anchor with one of `ref`, `locator` or `selector`, not several.')
        }
        if (options.locator || options.selector) {
          refuseScriptForm(`traceValue({ ${options.locator ? 'locator' : 'selector'} })`, options.locator ? 'the locator' : 'the selector', 'traceValue({ ref: 12 })')
        }
        const anchor = options.ref === undefined ? null : await elementOfRef(options.ref)
        if (anchor && options.page && options.page !== anchor.page) {
          throw new ModelFacingError(`traceValue: [${options.ref}] is in another tab than the \`page\` passed. Leave \`page\` out: a ref names its tab.`)
        }
        const targetPage = anchor?.page ?? (options.page || page)
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
        const result = await traceValue({ ...options, locator: anchor ? anchor.target : options.locator, root: options.root ?? defaultGraphRoot(), deps })
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

      // `Omit<…, 'cdp'>` rather than a hand-copied option list: a hand-copied inline type once
      // silently omitted `mode` and everything added since, so the sandbox accepted them at
      // runtime while TypeScript claimed they did not exist.
      // `page` is narrowed back to a real Page because this wrapper also needs it to
      // open the CDP session.
      const startCdpRecording = async (options: Omit<CdpScreencastOptions, 'cdp' | 'page'> & { page?: Page }) => {
        if (self.cdpScreencast) throw new Error('A CDP screencast is already running; stop it first.')
        const p = options.page || page
        if (!p) throw new Error('No page available to record')
        const cdp = await getCDPSession({ page: p })
        // The page is passed for the pointer track (a Playwright Page has one) and, only under
        // the explicit mode: 'screenshot', for bringToFront() before polling — captureScreenshot
        // on a hidden tab blocks for up to 26s at a time. The default mode, 'screencast', never
        // foregrounds; on a visible tab it takes one start-time screenshot as the first frame.
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
          startedAt: handle.startedAt,
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

      // Cookies, Web Storage, saved state and the clipboard (page-storage.ts): reads in every mode,
      // writes in debug mode only. The clipboard reader's own Playwright calls run as act's do.
      const storageGlobals = createStorageGlobals({
        policy: () => self.policy,
        currentPage,
        probes: self.probes,
        fs: self.scopedFs,
        browser: () => self.browser,
        viaExtension: !self.isHeadlessMode() && !self.isDirectCdpMode(),
        ownCalls: (work) => insideAct.run(true, work),
      })

      // Read-only instruments (perf.ts, react-tree.ts): Web Vitals, metrics, Chrome trace, CPU
      // profile, PDF, the React tree. None reloads or writes the page; pdf() says what the page saw.
      const print = (text: string): void => {
        run.probeOutput.push(text)
      }
      const instruments = createPerfGlobals({ probes: self.probes, context, currentPage, jail: self.scopedFs, print })
      const react = createReactGlobals({ probes: self.probes, context, currentPage, print })

      let vmContextObj: any = {
        page,
        context,
        browser: this.browser,
        state: this.userState,
        console: customConsole,
        snapshot,
        accessibilitySnapshot: snapshot, // backward compat alias
        refToLocator,
        perf: instruments.perf,
        pdf: instruments.pdf,
        react,
        // Wrapped only to pin the diff baseline to THIS session — see `lastCleanHtml`.
        getCleanHTML: getCleanHTMLFn,
        getPageMarkdown: getPageMarkdownFn,
        getLocatorStringForElement,
        getLatestLogs,
        clearAllLogs,
        waitForPageLoad: waitForPageLoadFn,
        observe,
        find,
        explain,
        readPage: readPageFn,
        audit,
        act,
        webmcp,
        docs,
        getCDPSession: sandboxGetCDPSession,
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
        cookies: storageGlobals.cookies,
        storage: storageGlobals.storage,
        saveState: storageGlobals.saveState,
        loadState: storageGlobals.loadState,
        setCookies: storageGlobals.setCookies,
        clearCookies: storageGlobals.clearCookies,
        setStorage: storageGlobals.setStorage,
        clearStorage: storageGlobals.clearStorage,
        clipboard: storageGlobals.clipboard,
        // The downloads this session's action reports listed (`DOWNLOAD [d1] …`): list() shows each
        // with its state, save(id, path) writes one where the sandbox fs may write, waiting for it to
        // finish within this call.
        downloads: {
          list: () => self.sessionDownloads.list(),
          save: (id: string, target: string) => self.sessionDownloads.save({ id, target, deadlineAt: run.deadlineAt, jail: self.scopedFs }),
        },
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
        pickElement,
        screenshotWithAccessibilityLabels: screenshotWithAccessibilityLabelsFn,
        screenshot: screenshotFn,
        diffScreenshot: diffScreenshotFn,
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

  /**
   * Before the code runs: in human mode refuse statically visible raw Playwright input while a native
   * dialog or a file dialog waits for an answer or the app shows a strong busy signal (act.* checks
   * this for itself, per action); take the "before" picture the raw input and waits need; mark the
   * journal; and start watching for what the report lists — raw Playwright input and navigations
   * (counted at run time in human mode), this tab's popups and downloads with their outcome. Each raw
   * input call goes out once its tab holds file dialogs back, for as long as that input can open one.
   */
  private async beginActionScope({
    page,
    context,
    analysis,
    run,
  }: {
    page: Page
    context: BrowserContext
    analysis: CodeAnalysis
    run: ExecuteRun
  }): Promise<ActionScope> {
    const probe = await this.probes.get(page)
    const rawCode = analysis.inputActions.some((site) => !site.viaAct) || analysis.navigations.some((site) => !site.viaAct)
    if (this.policy === 'human' && rawCode) {
      const dialog = probe.dialogs.current()
      if (dialog) {
        throw new ActError(
          `A native ${dialog.type}("${dialog.message}") dialog is open and blocks the page. Handle it first, like a person ` +
            'would: act.dialog.accept() or act.dialog.dismiss(). Nothing from this call was run.',
        )
      }
      const fileDialogs = await probe.fileChoosers.openDialogs()
      if (fileDialogs.length > 0) {
        throw new ActError(
          'A file dialog is open on this page and waits for an answer, like a person facing it: act.dialog.chooseFiles(path) ' +
            'chooses the files, act.dialog.dismiss() cancels it. Nothing from this call was run.',
        )
      }
      const busy = (await probe.watch.busySignals({ since: probe.history.at(-1)?.checkpoint })).filter(
        (signal) => signal.strength === 'strong' && BLOCKING_BUSY_KINDS.has(signal.kind),
      )
      if (busy.length > 0) {
        throw new ActError(
          `Not run: the page is still busy (${busy.map((signal) => signal.label).join('; ')}). A person waits for it to finish ` +
            'before doing anything else. Call act.waitForIdle(), read what changed, then decide. Nothing from this call was run.',
        )
      }
    }
    const waits = analysis.waits.some((site) => site.api === 'act.waitForIdle' || site.api === 'act.wait')
    // A page frozen by a native dialog looks as it did at the last full observation.
    const codeBefore = rawCode || waits ? (probe.dialogs.current() ? probe.lastFullObservation : await this.probes.baseline(page, context)) : null
    const checkpoint = probe.watch.checkpoint()
    run.start = { page, checkpoint }

    const scope: ActionScope = {
      page,
      probe,
      codeBefore,
      checkpoint,
      rawTargets: new Map(),
      rawCalls: [],
      rawCode,
      popups: [],
      downloads: [],
      watchFailures: [],
      detach: async () => {},
    }

    const instrumentation = clientInstrumentationOf(page)
    const outgoing = outgoingCallsOf(page)
    const guards = outgoingGuardsOf(page)
    if (!instrumentation || !outgoing || !guards) {
      throw new Error(
        `This Playwright client exposes no ${instrumentation ? 'outgoing-call hook (Connection.sendMessageToServer)' : 'client instrumentation'}, ` +
          'so input and navigations made by the code could not be seen, counted or reported. Nothing from this call was run.',
      )
    }
    // Installed once per connection and never removed: it guards every call made in a human-mode
    // run's async context, the ones the code leaves running after the call returns included.
    if (this.policy === 'human') {
      run.humanGuard = { context, browser: this.browser }
      guards.add(guardHumanRun)
    }
    const inFlight = new Map<object, { label: string; startedAt: number }>()
    /** The tab each in-flight raw call went out to. */
    const callTargets = new Map<object, Page>()
    /** In-flight raw calls that send input (not navigations): a click or a key can open a file dialog. */
    const inputCalls = new Set<object>()
    /** The file-dialog window each raw input call holds on its tab; null when it could not be opened (reported). */
    const rawWindows = new Map<object, Promise<ChooserWindow | null>>()
    const tap = {
      onApiCallBegin: (apiCall: object, channel: PlaywrightChannelCall): void => {
        if (executeContext.getStore() !== run || insideAct.getStore()) return
        // Refused by the guard as it goes out: never an action of this call.
        if (this.policy === 'human' && refusedInHumanMode(channel.type, channel.method, channel.params)) return
        const input = playwrightChannelToInputAction(channel)
        const navigation = input ? null : playwrightChannelToNavigation(channel)
        if (!input && !navigation) return
        const inputLabel = input ? formatInputLabel(input).label : ''
        const label = navigation ?? (input?.target ? `${inputLabel} on ${input.target}` : inputLabel)
        // Throwing here fails the Playwright call before it is sent (channelOwner._wrapApiCall).
        if (this.policy === 'human') this.refuseRawAction({ label, navigation: navigation !== null, analysis, run, inFlight: [...inFlight.values()].map((call) => call.label) })
        inFlight.set(apiCall, { label, startedAt: Date.now() })
        if (input) inputCalls.add(apiCall)
      },
      onApiCallEnd: (apiCall: { error?: Error } & object): void => {
        const call = inFlight.get(apiCall)
        if (call === undefined) return
        inFlight.delete(apiCall)
        inputCalls.delete(apiCall)
        const endedAt = Date.now()
        // The input landed by now; its activation can open a file dialog for a while yet.
        void rawWindows.get(apiCall)?.then((window) => window?.close(endedAt))
        rawWindows.delete(apiCall)
        const failure = apiCall.error ? apiCall.error.message.split('\n')[0] : undefined
        scope.rawCalls.push({ label: call.label, failure, page: callTargets.get(apiCall) ?? null, startedAt: call.startedAt })
        callTargets.delete(apiCall)
        run.rawActions.push(failure === undefined ? call.label : `${call.label} — FAILED: ${failure}`)
        run.rawEndedAt = endedAt
      },
    }
    instrumentation.addListener(tap)

    const watched = new Set<Page>()
    const onDownload = (download: Download): void => {
      scope.downloads.push(this.sessionDownloads.track(download))
    }
    const listeners: Array<() => void> = []
    /** Watch `target` for popups and downloads. */
    const watch = (target: Page): void => {
      if (watched.has(target) || target.isClosed()) return
      watched.add(target)
      const onPopup = (popup: Page): void => {
        scope.popups.push(popup)
        this.popupOpeners.set(popup, target)
        watch(popup)
      }
      target.on('popup', onPopup)
      target.on('download', onDownload)
      listeners.push(() => {
        target.off('popup', onPopup)
        target.off('download', onDownload)
      })
    }

    // Raw input or a navigation on a tab other than this one (`state.page = await context.newPage()`
    // earlier, then `state.page.goto(url)`) is followed on that tab: its call is held back until the
    // tab's probe exists and its journal position is taken, so the report reads what that tab did
    // rather than this one. Raw input on any tab also waits for that tab to hold file dialogs back.
    // Held calls go out in the order they were made.
    const following = new Map<Page, Promise<void>>()
    let lastHeld: Promise<void> = Promise.resolve()
    const onOutgoing: OutgoingCallListener = ({ owner, apiCall }) => {
      if (!inFlight.has(apiCall)) return undefined
      const target = pageOfCallOwner(owner, context)
      if (!target) return undefined
      callTargets.set(apiCall, target)
      const holds: Array<Promise<unknown>> = []
      if (target === page) {
        if (!scope.rawTargets.has(page)) scope.rawTargets.set(page, { page, probe, checkpoint: probe.watch.checkpoint(), at: Date.now() })
      } else {
        let ready = following.get(target)
        if (!ready) {
          const entry: RawTarget = { page: target, probe: null, checkpoint: null, at: Date.now() }
          scope.rawTargets.set(target, entry)
          ready = (async () => {
            try {
              const targetProbe = await this.probes.get(target)
              entry.probe = targetProbe
              entry.checkpoint = targetProbe.watch.checkpoint()
            } catch (error) {
              entry.probeError = error instanceof Error ? error.message : String(error)
            }
            watch(target)
          })()
          following.set(target, ready)
        }
        holds.push(ready)
      }
      if (inputCalls.has(apiCall)) {
        const window = this.probes.get(target).then(
          (targetProbe) => targetProbe.fileChoosers.open(),
        ).catch((error: unknown) => {
          scope.watchFailures.push(`file dialogs of ${target.url()} were not held back for ${inFlight.get(apiCall)?.label ?? 'the input'}: ${error instanceof Error ? error.message : String(error)}`)
          return null
        })
        rawWindows.set(apiCall, window)
        holds.push(window)
      }
      if (holds.length === 0) return undefined
      const held = lastHeld.then(() => Promise.all(holds)).then(() => {})
      lastHeld = held
      return held
    }
    outgoing.add(onOutgoing)

    watch(page)
    run.follow = (target) => watch(target)

    let detached = false
    scope.detach = async () => {
      // Once: Playwright's removeListener splices at indexOf(listener), so a second call would remove someone else's.
      if (detached) return
      detached = true
      run.follow = undefined
      instrumentation.removeListener(tap)
      outgoing.delete(onOutgoing)
      for (const remove of listeners) remove()
      // A raw call still in flight may have landed its input: its window closes from now.
      const now = Date.now()
      for (const window of await Promise.all(rawWindows.values())) window?.close(now)
      rawWindows.clear()
    }
    return scope
  }

  /**
   * Human mode, at run time: raw Playwright input or a navigation the code makes is one action, and a
   * call does one action. A raw navigation the static policy did not see and allow (it was reached
   * through code the analysis could not read) is refused as well.
   */
  private refuseRawAction({
    label,
    navigation,
    analysis,
    run,
    inFlight,
  }: {
    label: string
    navigation: boolean
    analysis: CodeAnalysis
    run: ExecuteRun
    inFlight: string[]
  }): void {
    if (navigation && !analysis.navigations.some((site) => !site.viaAct)) {
      throw new ActError(
        `Refused (human mode): ${label} was reached through code the policy could not read before it ran, and a script ` +
          'navigation reloads the document (client-side caches and in-memory state are wiped). Navigate like a user: ' +
          "act.click(ref) a link that observe() lists, act.spaNavigate('/path'), or act.open(url, { reason: '…' }) when a " +
          'full reload is what you are testing. It was not run.',
      )
    }
    const earlier = [
      ...run.actRecords
        .filter((record) => record.dispatched && record.kind !== 'wait' && record.kind !== 'waitForIdle')
        .map((record) => `act.${record.kind}${record.target ? ` [${record.target.ref}]` : ''}`),
      ...run.rawActions,
      ...inFlight,
    ]
    if (earlier.length === 0) return
    throw new ActError(
      `Refused (human mode): ${label} would be another action in this call, after ${earlier.join(', ')}. A person does ` +
        "one thing, then looks at what happened: read this call's report, then send the next action on its own. It was not run.",
    )
  }

  /**
   * After the code ran: wait for the page to settle, look again, and describe what the action did —
   * navigation kind, dialogs, live/toast text, console errors and failed requests, popups, downloads
   * and file choosers, the element diff, duplicates, and whether the app is still busy.
   *
   * The baseline is the picture and journal position taken right before the first input reached the
   * page (act records carry their own; raw input uses the pre-code picture and the tap's checkpoint),
   * and the quiet windows start when the last input ended. Every section that fails says so on its own
   * line (`NOT SETTLED — …`, `EVENTS UNAVAILABLE — …`, `AFTER-STATE UNAVAILABLE — …`); the records
   * and everything else are still reported.
   */
  private async finishActionScope({ scope, run, context }: { scope: ActionScope; run: ExecuteRun; context: BrowserContext }): Promise<string> {
    const records = run.actRecords
    const dispatchedRecords = records.filter((record) => record.dispatched)
    // Refused before anything reached the page (busy, covered, stale ref, disabled): the report is
    // the refusal alone. A settle and diff here would credit the page's own changes to an action
    // that never happened.
    const dispatched =
      scope.rawCode ||
      run.rawActions.length > 0 ||
      dispatchedRecords.length > 0 ||
      records.some((record) => (record.kind === 'waitForIdle' || record.kind === 'wait') && record.ok)
    if (!dispatched) {
      await scope.detach()
      return renderActionReport({
        records,
        rawInputs: run.rawActions,
        settle: null,
        events: null,
        after: null,
        diff: null,
        newTabs: [],
        downloads: [],
        fileDialogs: [...(await this.fileDialogLines(scope)).lines, ...scope.watchFailures.map((failure) => `watch: ${failure}`)],
      })
    }

    const first = dispatchedRecords[0]
    // The first tab raw code acted on, when its first call went out before the first act record.
    const firstRaw = scope.rawTargets.values().next().value
    const rawFirst = firstRaw !== undefined && (!first?.checkpoint || firstRaw.at < first.checkpoint.at)
    const firstPage = !rawFirst && first?.targetId ? this.probes.pageOf(first.targetId) : null
    const reportPage = rawFirst ? firstRaw.page : (firstPage ?? scope.page)
    // The pre-code picture is of the controlled tab only: another tab the code acted on has no
    // "before", so its report has no diff and makes no claim that nothing changed.
    const baseline: { before: Observation | null; checkpoint: WatchCheckpoint | null } = rawFirst
      ? { before: firstRaw.page === scope.page ? scope.codeBefore : null, checkpoint: firstRaw.checkpoint }
      : first
        ? { before: first.before ?? null, checkpoint: first.checkpoint ?? null }
        : { before: scope.codeBefore, checkpoint: scope.checkpoint }
    const endings = dispatchedRecords.map((record) => record.endedAt).filter((endedAt) => endedAt > 0)
    if (run.rawEndedAt !== undefined) endings.push(run.rawEndedAt)
    const origin = endings.length > 0 ? Math.max(...endings) : undefined
    const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

    let probe: PageProbe | null = null
    let probeError: string | undefined
    if (rawFirst) {
      // The probe the tab was followed with: its journal is the one the checkpoint belongs to.
      probe = firstRaw.probe
      probeError = firstRaw.probeError
    } else {
      try {
        probe = reportPage === scope.page ? scope.probe : await this.probes.get(reportPage)
      } catch (error) {
        probeError = messageOf(error)
      }
    }

    let settle: SettleResult | null = null
    // A page closed by a debugger cut (debugger-cut.ts) belongs to a tab that is still open: the relay is
    // asked before the report calls it closed.
    const closedWhy = async (): Promise<string> => {
      await this.noteCutDuringCall(run)
      return this.debuggerCuts.wasCut(reportPage) ? 'Chrome took the debugger off the tab (DEBUGGER CUT above)' : 'the page was closed'
    }
    let settleError: string | undefined
    if (reportPage.isClosed()) settleError = await closedWhy()
    else if (!probe) settleError = `the page could not be watched: ${probeError}`
    else {
      try {
        const remaining = run.deadlineAt - Date.now()
        settle = await probe.watch.settle({
          since: baseline.checkpoint ?? scope.checkpoint,
          origin,
          timeoutMs: Math.min(5000, Math.max(1500, remaining - 1000)),
        })
      } catch (error) {
        settleError = await this.explainFailure(error, reportPage)
      }
    }

    // A new tab ends in a document, or closes again (a download opened in a new tab does): wait for
    // either, within the call's budget, so its download and its title are in the report.
    const popupWaitMs = Math.max(0, Math.min(5000, run.deadlineAt - Date.now() - 1000))
    const stillLoading = new Set<Page>()
    await Promise.all(
      scope.popups.map(async (popup) => {
        if (popup.isClosed()) return
        const closed = Promise.withResolvers<void>()
        const onClose = (): void => closed.resolve()
        popup.once('close', onClose)
        const loaded = popup
          .waitForURL((url) => url.href !== 'about:blank', { waitUntil: 'domcontentloaded', timeout: popupWaitMs })
          .catch(() => {
            if (!popup.isClosed()) stillLoading.add(popup)
          })
        await Promise.race([loaded, closed.promise])
        popup.off('close', onClose)
      }),
    )

    let events: WatchEvents | null = null
    let eventsError: string | undefined
    if (!probe) eventsError = `the page could not be watched: ${probeError}`
    else {
      try {
        events = await probe.watch.since(baseline.checkpoint ?? scope.checkpoint)
      } catch (error) {
        eventsError = await this.explainFailure(error, reportPage)
      }
    }

    let after: Observation | null = null
    let afterError: string | undefined
    if (reportPage.isClosed() || settle?.reason === 'page-closed') afterError = await closedWhy()
    else {
      try {
        after = await this.probes.observe(reportPage, context)
      } catch (error) {
        afterError = await this.explainFailure(error, reportPage)
      }
    }
    // Content that moved by itself since the action began (layout shifts without recent input).
    const shifts =
      probe && after
        ? await layoutShiftLines({ probes: this.probes, probe, page: reportPage, after, since: (baseline.checkpoint ?? scope.checkpoint).at }).catch(
            (error: unknown) => [`could not be read: ${error instanceof Error ? error.message : String(error)}`],
          )
        : []
    // Watching stops only now: a popup or download can follow the input by a moment.
    await scope.detach()
    const dialogs = await this.fileDialogLines(scope)

    const diff = baseline.before && after ? diffObservations(baseline.before, after) : null
    const eventChange =
      (events?.navigations.length ?? 0) > 0 ||
      (events?.dialogs.length ?? 0) > 0 ||
      scope.popups.length > 0 ||
      scope.downloads.length > 0 ||
      dialogs.opened > 0
    // No baseline and no event: nothing was measured, so nothing is claimed.
    const changed = eventChange ? true : diff ? renderObservationDiff(diff) !== '' : undefined
    if (changed !== undefined) {
      for (const record of records) {
        if (record.ok && record.kind !== 'wait' && record.kind !== 'waitForIdle') record.effect = changed ? 'changed' : 'no-change'
      }
    }

    // The data-changing requests and WebSocket sends each action caused, between it and the next
    // dispatched action. The repeat guard refuses to send them a second time.
    dispatchedRecords.forEach((record, index) => {
      const until = dispatchedRecords[index + 1]?.startedAt ?? Number.POSITIVE_INFINITY
      const requests = (events?.network ?? []).filter(
        (request) =>
          request.startedAt >= record.startedAt &&
          request.startedAt < until &&
          !SAFE_HTTP_METHODS.has(request.method) &&
          (request.resourceType === undefined || DATA_REQUEST_TYPES.has(request.resourceType)),
      )
      const sockets = new Map<string, { url: string; frames: number }>()
      for (const frame of events?.webSockets ?? []) {
        if (frame.direction !== 'sent' || !WEBSOCKET_DATA_OPCODES.has(frame.opcode) || frame.at < record.startedAt || frame.at >= until) continue
        const socket = sockets.get(frame.requestId) ?? { url: frame.url ?? `socket ${frame.requestId}`, frames: 0 }
        socket.frames++
        sockets.set(frame.requestId, socket)
      }
      const mutations = [
        ...requests.map((request) => `${request.method} ${URL.canParse(request.url) ? new URL(request.url).pathname : request.url}`),
        ...[...sockets.values()].map((socket) => `WebSocket send ×${socket.frames} ${socket.url}`),
      ]
      if (mutations.length > 0) record.mutations = mutations
    })

    const openTabs = context.pages().filter((candidate) => !candidate.isClosed())
    const newTabs = await Promise.all(
      scope.popups.map(async (popup) => {
        const opener = this.popupOpeners.get(popup)
        const opened = opener ? await this.probes.openedBy(popup, opener, scope.checkpoint.at).catch(() => undefined) : undefined
        return {
          title: popup.isClosed()
            ? '(closed again)'
            : stillLoading.has(popup)
              ? `(still loading ${popupWaitMs}ms after the action)`
              : await tabTitle(popup).catch(
                  (error: unknown) => `(title unreadable: ${error instanceof Error ? error.message.split('.')[0] : String(error)})`,
                ),
          url: popup.url(),
          index: openTabs.indexOf(popup) >= 0 ? openTabs.indexOf(popup) : null,
          ...(opened ? { opened: { popup: opened.popup, features: opened.features } } : {}),
        }
      }),
    )

    // Raw calls on a tab other than the controlled one name that tab (its index is act.switchTab's).
    const rawInputs = await Promise.all(
      scope.rawCalls.map(async (call) => {
        const failed = call.failure === undefined ? '' : ` — FAILED: ${call.failure}`
        if (!call.page || call.page === scope.page) return `${call.label}${failed}`
        if (call.page.isClosed()) return `${call.label} on a tab that has closed since (${call.page.url()})${failed}`
        const title = await tabTitle(call.page).catch(
          (error: unknown) => `(title unreadable: ${error instanceof Error ? error.message.split('.')[0] : String(error)})`,
        )
        return `${call.label} on tab ${openTabs.indexOf(call.page)} "${title}"${failed}`
      }),
    )

    // A download keeps going after the page settled; it gets what is left of the call, up to 5s.
    const downloadWaitMs = Math.max(0, Math.min(5000, run.deadlineAt - Date.now() - 500))
    const downloads = await Promise.all(
      scope.downloads.map(async (entry) => {
        const cap = Promise.withResolvers<null>()
        const timer = setTimeout(() => cap.resolve(null), downloadWaitMs)
        const outcome = await Promise.race([entry.outcome, cap.promise])
        clearTimeout(timer)
        const tab = entry.download.page()
        return this.sessionDownloads.reportLine(entry, outcome, { waitedMs: downloadWaitMs, where: tab === reportPage ? '' : ` (in the tab ${tab.url()})` })
      }),
    )

    const fileDialogs = [...dialogs.lines, ...scope.watchFailures.map((failure) => `watch: ${failure}`)]

    return renderActionReport({
      records,
      rawInputs,
      settle,
      settleError,
      events,
      eventsError,
      after,
      afterError,
      diff,
      newTabs,
      downloads,
      fileDialogs,
      changed,
      shifts,
    })
  }

  /**
   * The file dialogs every tab opened since the last report — an input's activation can open one
   * after its call returned — each once, with the input it followed and how to answer it. Ones that
   * act.upload or act.dialog.* already answered are said by their own action lines.
   */
  private async fileDialogLines(scope: ActionScope): Promise<{ lines: string[]; opened: number }> {
    const lines: string[] = []
    let opened = 0
    for (const { page: tab, probe } of await this.probes.all()) {
      const { records: choosers, failures } = probe.fileChoosers.drain()
      const where = tab === scope.page ? '' : ` on the tab ${tab.url()}`
      for (const chooser of choosers) {
        if (chooser.outcome === 'chosen' || chooser.outcome === 'cancelled') continue
        opened += 1
        const files = chooser.multiple ? 'several files allowed' : 'one file'
        if (chooser.toCode) {
          lines.push(`handed to your page.on('filechooser') listener${where} (${files})`)
          continue
        }
        const act = chooserOpener(probe.history, chooser)
        const raw = scope.rawCalls.findLast((call) => call.page === tab && call.startedAt <= chooser.at)
        const byRaw = raw !== undefined && (act === undefined || raw.startedAt > act.startedAt)
        const cause = byRaw ? `your raw Playwright ${raw.label}` : act ? describeOpener(act) : 'the page itself (no input of yours came before it)'
        // Opened after the previous call's report: that input's activation was still live.
        const late = !byRaw && act && chooser.at < scope.checkpoint.at ? `, ${((chooser.at - act.endedAt) / 1000).toFixed(1)}s after that action ended` : ''
        if (chooser.outcome === 'gone') {
          lines.push(`opened by ${cause}${where}${late}, then its input left the page (the page changed): it is closed`)
        } else if (chooser.backendNodeId === undefined) {
          lines.push(
            `OPEN: a file picker the page's script opened without a file input (window.showOpenFilePicker), after ${cause}${where}${late} — ` +
              'files cannot be chosen in it over this browser connection; act.dialog.dismiss() closes it',
          )
        } else {
          lines.push(`OPEN, opened by ${cause}${where}${late} (${files}) — the page waits for an answer: act.dialog.chooseFiles(path) chooses the files, act.dialog.dismiss() cancels`)
        }
      }
      for (const failure of failures) lines.push(`watch: ${failure}`)
    }
    return { lines, opened }
  }

  async execute(code: string, timeout = 30000): Promise<ExecuteResult> {
    const consoleLogs: Array<{ method: string; args: any[] }> = []
    const warningScope = this.beginWarningScope()
    const abort = new AbortController()
    const run: ExecuteRun = {
      signal: abort.signal,
      deadlineAt: Date.now() + timeout,
      actRecords: [],
      probeOutput: [],
      actActivity: { depth: 0 },
      rawActions: [],
    }
    let scope: ActionScope | null = null
    let reportText = ''

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

    /**
     * The action report must never replace the code's own outcome, so it cannot throw. finishActionScope
     * reports every section's failure on its own line; anything else still keeps the records.
     */
    let reported = false
    const buildReport = async (context: BrowserContext): Promise<void> => {
      if (!scope) return
      reported = true
      try {
        reportText = await this.finishActionScope({ scope, run, context })
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        reportText = renderActionReport({
          records: run.actRecords,
          rawInputs: run.rawActions,
          settle: null,
          settleError: cause,
          events: null,
          eventsError: cause,
          after: null,
          afterError: cause,
          diff: null,
          newTabs: [],
          downloads: [],
          fileDialogs: [],
        })
      }
    }

    /** Report, then what observe()/find()/explain() printed, separated so each reads as its own block. */
    const headSections = (): string => {
      // The tab crashed during this call: what the report could not read is explained by this line.
      const crash = this.page ? crashOf(this.page) : null
      // A DEBUGGER CUT line comes first: it explains every line below that could not read the tab.
      const sections = [...this.cutNotices.splice(0), reportText, ...run.probeOutput, crash ? crashedLine(crash) : ''].filter((section) => section.trim().length > 0)
      return sections.length ? `${sections.join('\n\n')}\n\n` : ''
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
      const current = await this.getCurrentPage(timeout)
      const context = this.context || current.context()

      // Read the code before running it (Babel AST). What it does to the page decides whether it
      // may run at all (human policy) and whether an action report follows it.
      const analysis = analyzeCode(code)
      // A crashed tab's Page never works again (page-crash.ts): only a reload brings the session back,
      // in a new tab that replaces it. Anything else would wait on a renderer that is gone.
      const crash = crashOf(current)
      if (crash && !analysis.navigations.some((site) => site.api === 'act.open' || site.api === 'act.reload')) {
        return { text: `${crashedLine(crash)} Nothing from this call was run.`, images: [], screenshots: [], isError: true }
      }
      let page = current
      if (crash) {
        const adopt = (replacement: Page): void => {
          this.page = replacement
          page = replacement
        }
        run.probeOutput.push(await replaceCrashedPage(current, crash, adopt))
      }
      const verdict = checkPolicy(analysis, { mode: this.policy, pageIsBlank: isBlankUrl(page.url()) })
      if (!verdict.allowed) {
        return { text: verdict.refusal ?? 'Refused by the human-mode policy.', images: [], screenshots: [], isError: true }
      }
      // Always: raw input and navigations are counted and reported at run time, including the ones
      // the static analysis could not see.
      scope = await this.beginActionScope({ page, context, analysis, run })

      this.logger.log('Executing code:', code)

      const { vmContextObj, screenshotCollector, resizedImageCollector } = this.buildSandboxContext({
        page,
        context,
        consoleLogs,
        run,
      })

      const vmContext = vm.createContext(vmContextObj)
      const autoReturnExpr = getAutoReturnExpression(code)
      const wrappedCode = autoReturnExpr !== null
        ? `(async () => { return await (${autoReturnExpr}) })()`
        : `(async () => { ${code} })()`
      // From the AST, not /\breturn\b/: that matched the word inside strings and comments.
      const hasExplicitReturn = autoReturnExpr !== null || analysis.hasTopLevelReturn

      // Playwright's own waits give up before this call does, so a stuck locator.click() fails with
      // Playwright's precise reason ("element is not visible", "<div> intercepts pointer events")
      // instead of a generic execute timeout that names nothing.
      const innerTimeout = Math.max(1000, timeout - 1500)
      page.setDefaultTimeout(innerTimeout)
      context.setDefaultTimeout(innerTimeout)

      // Track execution timestamps relative to recording start (seconds).
      // Used to identify idle gaps that can be sped up in demo videos.
      // Captured before execution so we can record timing even if it throws.
      const recordingStartSnapshot = this.recordingStartedAt
      const execStartSec = recordingStartSnapshot !== null
        ? (Date.now() - recordingStartSnapshot) / 1000
        : -1

      let result: unknown
      let codeError: unknown = null
      const deadline = Promise.withResolvers<never>()
      const timer = setTimeout(() => deadline.reject(new CodeExecutionTimeoutError(timeout)), timeout)
      try {
        result = await Promise.race([
          executeContext.run(run, () => vm.runInContext(wrappedCode, vmContext, { timeout, displayErrors: true })),
          deadline.promise,
        ])
      } catch (error) {
        codeError = error
      } finally {
        clearTimeout(timer)
        // A timed-out call must not keep acting: act.* checks this signal before every dispatch,
        // so a click cannot land in the middle of the NEXT call.
        if (codeError instanceof CodeExecutionTimeoutError) {
          abort.abort()
        }
        // Record timestamp even on error — the execution still occupied real time
        // that should not be sped up in the demo video.
        // Compare against snapshot to avoid cross-session contamination if
        // recording was stopped and restarted inside the same execute() call.
        if (recordingStartSnapshot !== null && execStartSec >= 0 && this.recordingStartedAt === recordingStartSnapshot) {
          const execEndSec = (Date.now() - recordingStartSnapshot) / 1000
          this.executionTimestamps.push({ start: execStartSec, end: execEndSec })
        }
      }

      // An act.* call the code forgot to await is still running; let it finish before reporting.
      while (run.actActivity.depth > 0 && Date.now() < run.deadlineAt + 2000) {
        await sleep(50)
      }
      // Chrome took the debugger off the controlled tab during this call (debugger-cut.ts). A command
      // in flight then fails with Chrome's "Detached while handling command." a moment before the page
      // closes; the close is waited for, then the tab, briefly — so this call already says whether it
      // came back, and its report says why it could not read the tab.
      if (codeError instanceof Error && codeError.message.includes('Detached while handling command') && !page.isClosed()) {
        await page.waitForEvent('close', { timeout: 1000 }).catch(() => {})
      }
      await this.noteCutDuringCall(run)
      await buildReport(context)
      // The cut came while the report was being read.
      await this.noteCutDuringCall(run)
      if (codeError !== null) {
        throw codeError
      }

      let responseText = headSections() + formatConsoleLogs(consoleLogs)

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

      const finalText = capOutput(responseText.trim())

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
      // Failed before the report (building the sandbox, the connection): still stop watching.
      if (scope && !reported) await scope.detach()
      const errorStack = error.stack || error.message
      const isTimeoutError =
        error instanceof CodeExecutionTimeoutError || error?.name === 'TimeoutError' || error?.name === 'AbortError'
      // Model-facing messages (ActError, ExplainError, picker and unresponsive-page errors) are
      // complete on their own; a stack and the generic reset hint only add noise.
      const isModelFacing = error instanceof ModelFacingError
      // The code failed because Chrome took the debugger off the tab: the DEBUGGER CUT line says what
      // happened and what to do; a stack and the reset hint would point elsewhere.
      const cutNoticed = this.cutNotices.length > 0

      this.logger.error('Error in execute:', errorStack)

      const logsText = formatConsoleLogs(consoleLogs, 'Console output (before error)')
      const warningText = this.flushWarningsForScope(warningScope)

      // Cloud sessions: disconnection errors mean the VM expired or was destroyed.
      // Give a clear actionable message instead of a generic "call reset" hint.
      const isDisconnect = error instanceof Error && isDisconnectionError(error)
      const resetHint = (() => {
        if (isTimeoutError || isModelFacing || cutNoticed) return ''
        if (this.cloudSession && isDisconnect) {
          return `\n\n[Cloud browser expired or disconnected. Create a new session with: playwriter session new --browser cloud]`
        }
        return '\n\n[HINT: If this is an internal Playwright error, page/browser closed, or connection issue, call reset to reconnect.]'
      })()

      // timeout stacks are internal noise (Promise.race / setTimeout); only show the message
      const errorText = isTimeoutError || isModelFacing || cutNoticed ? await this.explainFailure(error, this.page) : errorStack
      return {
        text: capOutput(`${headSections()}${logsText}${warningText}\nError executing code: ${errorText}${resetHint}`.trim()),
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
    /** human (default) or debug for this session; see `PolicyMode`. */
    policy?: PolicyMode
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
        policy: options.policy,
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
