import type { Page, Locator, ElementHandle } from '@xmorse/playwright-core'
import type { ICDPSession } from './cdp-session.js'
import type { Debugger } from './debugger.js'
import type { Editor } from './editor.js'
import type { StylesResult } from './styles.js'
import type { PageModelHandle, ProjectionRow, ProjectionConfig, QueryOptions } from './page-model.js'
import type { LogpointHit, NetTimelineController, FiberDiff, ReplayResult, AnchorInfo } from './trace.js'
import type { Loc, BlockedReason } from './static-analysis.js'
import type { ReactComponentInfo } from './react-source.js'

export declare const page: Page
export declare const getCDPSession: (options: { page: Page }) => Promise<ICDPSession>
export declare const createDebugger: (options: { cdp: ICDPSession }) => Debugger
export declare const createEditor: (options: { cdp: ICDPSession }) => Editor
export declare const getStylesForLocator: (options: {
  locator: Locator
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
export declare const whyOccluded: (options: { locator?: Locator; node?: unknown }) => Promise<{
  stacking: Record<string, { value: string; selector: string; important: boolean; source: DeclRef['source'] }>
  createsStackingContext: boolean
  position: string | null
  zIndex: string | null
  occludedBy: null
  note: string
  text: string
}>
export declare const console: { log: (...args: unknown[]) => void }

// --- PageModel sandbox helpers (`pm`, `queryPage`) -------------------------
export declare const pm: {
  anchor: (
    selector: string | { backendNodeId: number } | { x: number; y: number },
    options?: { page?: Page },
  ) => Promise<PageModelHandle | null>
  query: (opts?: QueryOptions & { page?: Page }) => Promise<ProjectionRow[]>
  renderText: (opts?: { visibleOnly?: boolean; page?: Page }) => Promise<string>
  debugMode: (options?: { page?: Page }) => Promise<ProjectionConfig>
}
export declare const queryPage: (opts?: QueryOptions & { page?: Page }) => Promise<ProjectionRow[]>

// --- trace / runtime-debug sandbox helpers ---------------------------------
export interface TraceResultSummary {
  render: string
  anchor: AnchorInfo | null
  blocked: Array<{
    id: string
    blockedBy: BlockedReason
    site: Loc | null
    note?: string
    probe: { type: string; passive: boolean; spec: Record<string, unknown> } | null
  }>
  expand: (hopId: string) => unknown
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
export declare const setLogpoint: (options: {
  page?: Page
  file: string
  line: number
  expr: string
  tag?: string
}) => Promise<unknown>
export declare const readLogpoints: (options?: {
  page?: Page
  tag?: string
  sinceCursor?: number
}) => Promise<LogpointHit[]>
export declare const getScriptSourceByUrl: (options: { page?: Page; url: string }) => Promise<unknown>
export declare const storeIdentity: (options: {
  page?: Page
  action: () => Promise<void> | void
  storeExpr?: string
}) => Promise<{ sameReference: boolean; captured: boolean }>
export declare const net: {
  timeline: (options?: { page?: Page; urlPattern?: string | RegExp }) => NetTimelineController
  delay: (options: { page?: Page; urlPattern: string; ms: number }) => Promise<{ stop(): Promise<void> }>
}
export declare const fiberSnapshot: (options: {
  locator: Locator | ElementHandle
}) => Promise<ReactComponentInfo | null>
export declare const fiberDiff: (a: ReactComponentInfo | null, b: ReactComponentInfo | null) => FiberDiff
export declare const replayPure: (options: {
  fn: string | ((...a: any[]) => unknown)
  args?: unknown[]
  allow?: string[]
}) => ReplayResult
