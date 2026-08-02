import type { Page, Locator, ElementHandle } from '@xmorse/playwright-core'
import type { ICDPSession } from './cdp-session.js'
import type { Debugger } from './debugger.js'
import type { Editor } from './editor.js'
import type { StylesResult } from './styles.js'
import type { PageModelHandle, ProjectionRow, ProjectionConfig, QueryOptions, Box, NodeKey } from './page-model.js'
import type {
  LogpointRead,
  NetEntry,
  NetTimelineController,
  NetDelayController,
  TraceProbeInfo,
  TraceProbeKind,
  FiberDiff,
  FiberIdentitySnapshot,
  ReplayResult,
  AnchorInfo,
  StoreIdentityResult,
  RenderOptions,
  TraceSubtree,
} from './trace.js'
import type {
  Loc,
  BlockedReason,
  Hazard,
  TraceHop,
  BindingReport,
  MissingDepsReport,
  PurityResult,
  SerializableProbe,
} from './static-analysis.js'
import type { ModuleGraphSummary } from './module-graph.js'
import type { CdpScreencastOptions, CdpScreencastResult, CaptionStamp, HoldResult } from './cdp-screencast.js'
import type { RecordingState, ExecutionTimestamp } from './screen-recording.js'
import type { ReactComponentInfo } from './react-source.js'
import type { HumanTrajectory, Point as HumanPoint } from './human-mouse.js'
import type { HumanMoveOptions, HumanClickOptions, HumanMoveResult, HumanMouseDefaults } from './human-mouse-driver.js'

/**
 * The default page. It is NOT the page an agent should be driving: every helper that
 * takes an optional `page` falls back to this one, and a task that stored its tab in
 * `state.page` will silently inspect the wrong tab if it lets the fallback happen. The
 * examples therefore pass `{ page: state.page }` everywhere it is accepted.
 */
export declare const page: Page
/** The per-session store, persisted across execute() calls. `state.page` is the tab you own. */
export declare const state: { page: Page; [key: string]: unknown }
export declare const getCDPSession: (options: { page: Page }) => Promise<ICDPSession>
export declare const createDebugger: (options: { cdp: ICDPSession }) => Debugger
export declare const createEditor: (options: { cdp: ICDPSession }) => Editor
export declare const getStylesForLocator: (options: {
  locator: Locator
  /** Reused when supplied; otherwise one is opened for the locator's page. */
  cdp?: ICDPSession
  includeUserAgentStyles?: boolean
}) => Promise<StylesResult>
export declare const formatStylesAsText: (styles: StylesResult) => string
export interface DeclRef {
  selector: string
  value: string
  important: boolean
  source: { url: string; line: number; column: number } | null
  origin: string
}
export declare const debugStyle: (options: {
  locator?: Locator
  node?: unknown
  property?: string
}) => Promise<{ properties: Record<string, { winner: DeclRef; losers: DeclRef[] }>; text: string }>
/**
 * Three DIFFERENT kinds of evidence, deliberately not collapsed into one verdict:
 * `occluded*` is a geometric INFERENCE, `hitTest` is GROUND TRUTH at one point, and
 * `stackingContext` is Chromium's own flag with the declarations that explain it.
 */
export declare const whyOccluded: (options: { locator?: Locator; node?: unknown; page?: Page }) => Promise<{
  /** INFERENCE. `null` also covers "this node was never measured". */
  occluded: 'partial' | 'full' | null
  occludedBy: NodeKey[]
  occludedByLabels: string[]
  occludedFraction: number | null
  /** GROUND TRUTH: `DOM.getNodeForLocation` at the box centre. `isTarget` is the answer. */
  hitTest: { key: string; label: string; isTarget: boolean } | null
  hitTestError: string | null
  /** GROUND TRUTH from the layout tree; `null` when unmeasured. */
  stackingContext: boolean | null
  /** The declarations that EXPLAIN the flag above. They never decide it. */
  stackingReasons: string[]
  /** `clip-path` / `transform` / `filter` / `border-radius` — the inference's blind spots. */
  shapeDistortingProps: string[]
  stacking: Record<string, { value: string; selector: string; important: boolean; source: DeclRef['source'] }>
  position: string | null
  zIndex: string | null
  box: Box | null
  /** false = the element could not be joined to the measured model; occlusion is unknown. */
  measured: boolean
  text: string
}>
export declare const console: { log: (...args: unknown[]) => void }

// --- PageModel sandbox helpers (`pm`, `queryPage`) -------------------------
/**
 * `rootSelector` scopes what is FETCHED (a Playwright selector, applied before any tree
 * exists). `QueryOptions.within` scopes the QUERY (a page-path selector over the tree
 * that already exists). Two different languages; neither substitutes for the other.
 * `scope` is the deprecated alias — on `pm.*` it means `rootSelector`, inside
 * `QueryOptions` it means `within`.
 */
export interface PmModelOptions {
  page?: Page
  rootSelector?: string
  /** @deprecated Alias for `rootSelector`. */
  scope?: string
}
export declare const pm: {
  /**
   * Exact locator string, page-path selector, `{ backendNodeId }`, or a point. The point
   * form INFERS the topmost node from snapshot paint order — use `anchorAt` when the
   * answer has to be right.
   */
  anchor: (
    selector: string | { backendNodeId: number } | { x: number; y: number; frameId?: string },
    options?: PmModelOptions,
  ) => Promise<PageModelHandle | null>
  /** GROUND TRUTH point resolution via `DOM.getNodeForLocation`. Document coordinates. */
  anchorAt: (point: { x: number; y: number }, options?: PmModelOptions) => Promise<PageModelHandle | null>
  /** THROWS when `within` matches nothing — a scope is a precondition, not a filter. */
  query: (opts?: QueryOptions & PmModelOptions) => Promise<ProjectionRow[]>
  renderText: (
    opts?: { visibleOnly?: boolean; inViewportOnly?: boolean; includeRemoved?: boolean } & PmModelOptions,
  ) => Promise<string>
  debugMode: (options?: PmModelOptions) => Promise<ProjectionConfig>
}
export declare const queryPage: (opts?: QueryOptions & PmModelOptions) => Promise<ProjectionRow[]>

// --- trace / runtime-debug sandbox helpers ---------------------------------
export interface TraceResultSummary {
  /** A METHOD, not a string. `maxLines` / `codeFrames` belong to the caller. */
  render: (opts?: RenderOptions) => string
  anchor: AnchorInfo | null
  blocked: Array<{
    id: string
    blockedBy: BlockedReason
    site: Loc | null
    hazards: Hazard[]
    note?: string
    codeFrame?: string
    probe: { type: string; passive: boolean; spec: Record<string, unknown> } | null
  }>
  /** A BOUNDED SUBTREE in one call — `depth` defaults to 1 (this hop + its children). */
  expand: (hopId: string, opts?: { depth?: number; maxNodes?: number }) => TraceSubtree | null
  /** Every hop id, so a hop can be addressed without walking the tree. */
  hopIds: string[]
  /** Live perturbing probes + blind spots this build has no probe for. */
  warnings: string[]
  runProbe: (hopId: string) => Promise<unknown>
}
export declare const traceValue: (options?: {
  page?: Page
  node?: PageModelHandle
  locator?: Locator | ElementHandle
  selector?: string
  slot?: string
  maxHops?: number
  maxBreadth?: number
  root?: string
  startFile?: string
  startExpr?: string
  action?: () => Promise<void> | void
  storeExpr?: string
  urlPattern?: string
}) => Promise<TraceResultSummary>
/** THROWS when `expr` cannot be made into a provably non-pausing condition. */
export declare const setLogpoint: (options: {
  page?: Page
  file: string
  line: number
  expr: string
  tag?: string
  /** Cap on the JSON payload, applied IN the page. Over-cap payloads log a visible cut. */
  maxPayload?: number
}) => Promise<string>
/** Returns the full accounting, NOT a bare array. Iterate `read.hits`. */
export declare const readLogpoints: (options?: {
  page?: Page
  tag?: string
  sinceCursor?: number
  maxHits?: number
  maxLen?: number
}) => Promise<LogpointRead>
export declare const getScriptSourceByUrl: (
  options: { page?: Page; url: string },
) => Promise<{ url: string; scriptId: string; source: string } | null>
/**
 * A discriminated union. Check `measured` FIRST: the `measured: false` arm has no
 * `sameReference` field at all, so a probe that never found your store cannot be read as
 * a store that correctly produced a fresh reference.
 */
export declare const storeIdentity: (options: {
  page?: Page
  action: () => Promise<void> | void
  storeExpr?: string
}) => Promise<StoreIdentityResult>
export declare const net: {
  /** PASSIVE. Also registered, so `net.read(id)` drains it from a later call. */
  timeline: (options?: {
    page?: Page
    urlPattern?: string | RegExp
    /** Fill THIS array in place, so the capture outlives the execute() call that armed it. */
    buffer?: NetEntry[]
    maxEntries?: number
  }) => NetTimelineController
  /** PERTURBING. Auto-expires after `ttlMs` (default 120s; `0` = unbounded). */
  delay: (options: {
    page?: Page
    urlPattern: string
    ms: number
    ttlMs?: number
    force?: boolean
  }) => Promise<NetDelayController>
  /** The session probe registry — works on ids alone, no controller needed. */
  active: (opts?: { live?: boolean; kind?: TraceProbeKind }) => TraceProbeInfo[]
  /** One probe's accounting by id. `null` for an unknown id — a normal question, not an error. */
  get: (id: string) => TraceProbeInfo | null
  read: (id: string) => unknown
  stop: (id: string) => Promise<boolean>
  stopAll: (opts?: { kind?: TraceProbeKind }) => Promise<string[]>
  /** One line per live PERTURBING probe. Read this before trusting any timing. */
  warnings: () => string[]
}
/**
 * The `recording` namespace as the sandbox sees it — BOTH recorders, because both live
 * on this one object and a declaration showing only half of it reads as a complete list.
 *
 * `start`/`stop`/`isRecording`/`cancel` drive the tabCapture recorder: true compositor
 * output at a fixed frame rate, survives navigation, and needs one extension-icon click
 * per tab (so it is unavailable over direct CDP and in headless mode).
 *
 * `startCdp` and everything below it drive the gesture-free CDP recorder, which needs no
 * click and works everywhere. It returns immediately and the handle lives on the
 * executor, not in the calling `execute()` — which is why `stopCdp`/`caption`/`hold`/
 * `frameCount` take no handle, and why they throw rather than no-op when nothing runs.
 */
export declare const recording: {
  /** tabCapture recorder. Auto-resizes the viewport to 16:9 and auto-stops after 15 min. */
  start: (options?: {
    page?: Page
    outputPath?: string
    frameRate?: number
    audio?: boolean
    videoBitsPerSecond?: number
    aspectRatio?: { width: number; height: number } | null
    maxDurationMs?: number
  }) => Promise<RecordingState>
  /** Returns the path, duration, size and the `executionTimestamps` `createDemoVideo` needs. */
  stop: (options?: { page?: Page }) => Promise<{
    path: string
    duration: number
    size: number
    executionTimestamps: ExecutionTimestamp[]
  }>
  isRecording: (options?: { page?: Page }) => Promise<RecordingState>
  cancel: (options?: { page?: Page }) => Promise<void>
  /**
   * `inputOverlay: true` also arms a tap on Playwright's client instrumentation, so every
   * click/fill/press/wheel this session drives becomes a chip. `note` is set when the tap
   * could not be armed — the recording still runs, it just shows no chips.
   */
  startCdp: (
    options: Omit<CdpScreencastOptions, 'cdp' | 'page'> & { page?: Page },
  ) => Promise<{ started: boolean; outputPath: string; inputOverlay?: boolean; note?: string }>
  stopCdp: () => Promise<CdpScreencastResult>
  cancelCdp: () => Promise<{ cancelled: boolean }>
  /** Stamps at call time. `atMs` overrides that when the caller knows the real instant. */
  caption: (text: string, opts?: { atMs?: number; durationMs?: number }) => CaptionStamp
  /** Ends the running caption and shows nothing after it. */
  clearCaption: (opts?: { atMs?: number }) => CaptionStamp
  /**
   * Waits out whatever is left of the current caption's reading time — derived from the
   * text, minus the time the action already took. This is how a repro gets paced; a
   * hard-coded `setTimeout` neither tracks the wording nor discounts the action.
   * With nothing captioned it waits `minMs` — which DEFAULTS TO 1200ms, not 0, so the
   * final state needs an explicit `hold({ minMs: 3000 })` to sit on screen long enough.
   */
  hold: (opts?: { minMs?: number; extraMs?: number }) => Promise<HoldResult>
  /** Frames captured so far. Catches a `frames: 0` recording while it can still be fixed. */
  frameCount: () => number
}
/**
 * `identity: true` is the ONLY way handler-identity churn survives the process boundary —
 * without it every function serialises to `[function]` and two different arrows look equal.
 */
export declare const fiberSnapshot: {
  (options: { locator: Locator | ElementHandle; identity?: false }): Promise<ReactComponentInfo | null>
  (options: {
    locator: Locator | ElementHandle
    identity: true
    maxKeys?: number
    maxDepth?: number
  }): Promise<FiberIdentitySnapshot | null>
}
export declare const fiberDiff: (
  a: ReactComponentInfo | FiberIdentitySnapshot | null,
  b: ReactComponentInfo | FiberIdentitySnapshot | null,
  opts?: { maxDepth?: number; maxNodes?: number; maxKeys?: number; maxChanges?: number },
) => FiberDiff
export declare const replayPure: (options: {
  fn: string | ((...a: any[]) => unknown)
  args?: unknown[]
  allow?: string[]
  /** Values for captured/imported identifiers; each name is admitted and injected. */
  bindings?: Record<string, unknown>
  maxLogs?: number
}) => ReplayResult
/** As `replayPure`, but awaits a returned Promise (an async sliced function). */
export declare const replayPureAsync: (options: {
  fn: string | ((...a: any[]) => unknown)
  args?: unknown[]
  allow?: string[]
  bindings?: Record<string, unknown>
  maxLogs?: number
}) => Promise<ReplayResult>

// --- static-analysis sandbox helpers ---------------------------------------
/**
 * An OPAQUE handle. The live `ModuleGraph` holds Babel NodePaths and is never exposed —
 * `summary()` is the only thing safe to return from sandbox code.
 */
export interface ModuleGraphHandle {
  root: string
  fileCount: number
  summary(): ModuleGraphSummary
}
/** `{ code }` for inline source, or `{ file, graph }` for a file in a parsed graph. */
export interface SourceRefOptions {
  code?: string
  file?: string
  graph?: ModuleGraphHandle
}
/** Build (or reuse) the module graph for `root`. Defaults to the session cwd. */
export declare const moduleGraph: (options?: { root?: string }) => ModuleGraphHandle
/** binding + hazards + one-step hop classification, in one serialisable answer. */
export declare const inspectBinding: (
  options: SourceRefOptions & { name: string; occurrence?: number },
) => BindingReport
/** Constant-fold a reference and report the fold or the deopt position. Never a NodePath. */
export declare const evaluateBinding: (
  options: SourceRefOptions & { name: string; occurrence?: number },
) => SerializableProbe & { ok: boolean; error?: string; site?: Loc }
/** React exhaustive-deps over a whole FILE — the reachable shape of the check. */
export declare const findMissingDeps: (
  options: SourceRefOptions & { hooks?: string[]; max?: number; withCodeFrames?: boolean },
) => MissingDepsReport
/** The `replayPure` gate, callable on its own. */
export declare const isPureFunctionSource: (src: string, opts?: { allow?: string[] }) => PurityResult
/** The static backward slice `traceValue` runs, without the anchor/probe orchestration. */
export declare const backwardSlice: (options: {
  graph?: ModuleGraphHandle
  /** Used only when `graph` is omitted. Defaults to the session cwd. */
  root?: string
  startFile: string
  /** A variable NAME (`'count'`) — never a path, never an expression. */
  startExpr: string
  maxHops?: number
  maxBreadth?: number
}) => TraceHop

// ---------------------------------------------------------------------------
// humanMouse — opt-in human pointer motion
// ---------------------------------------------------------------------------
/**
 * A REAL sampled trajectory for the actual CDP pointer, not a cosmetic tween:
 * Fitts's law for duration, minimum-jerk for the velocity profile, a bowed Bezier
 * path, Meyer corrective submovements near the target, 2/3-power-law re-timing
 * through curves, and sub-pixel 8-12 Hz tremor. Every stochastic element is seeded.
 *
 * THIS IS A BEHAVIOUR CHANGE, NOT A VISUAL ONE. The pointer really travels, so every
 * element between origin and target receives `mouseover`/`mouseenter`/`mousemove`.
 * That can open menus, fire tooltips, dismiss popovers and start hover-intent timers
 * that a teleporting pointer never triggers. It is off unless you call it. Pass
 * `reportCrossings: true` to get back the list of elements the path actually hovered.
 */
export declare const humanMouse: {
  /** Plan without moving. Deterministic for a given seed — useful for assertions. */
  plan: (options: HumanMoveOptions) => Promise<HumanTrajectory>
  moveTo: (options: HumanMoveOptions) => Promise<HumanMoveResult>
  /**
   * Human move, then the click. With a `locator` the press is delegated to
   * `locator.click()`, so Playwright's actionability, hit-target interception and retry
   * loop all still run — its own move to the element centre is then zero-distance.
   * With bare `{ x, y }` there is no element and therefore no actionability.
   */
  click: (options: HumanClickOptions) => Promise<HumanMoveResult>
  /** Alias of `moveTo` — the move IS the hover. */
  hover: (options: HumanMoveOptions) => Promise<HumanMoveResult>
  /**
   * Route subsequent `locator.click/dblclick/hover` on this page through a human move
   * first. Scoped to the page, so other sessions in the same relay are unaffected.
   */
  enable: (options?: { page?: Page } & HumanMouseDefaults) => Promise<{ enabled: true; page: string }>
  disable: (options?: { page?: Page }) => Promise<{ enabled: false }>
  isEnabled: (options?: { page?: Page }) => boolean
  /** Where the driver believes the pointer is. */
  position: (options?: { page?: Page }) => Promise<HumanPoint>
  defaults: HumanMouseDefaults
}
