/**
 * trace.ts — Milestone 4 of the PageModel/debug feature.
 *
 * The runtime-debug / trace lane. Two halves:
 *
 *   1. A probe toolkit — small, mostly-pure helpers that observe or perturb the
 *      live page (`readLogpoints`, `storeIdentity`, `netTimeline`/`netDelay`,
 *      `fiberSnapshot`/`fiberDiff`, `replayPure`). Each keeps the pure/mappable
 *      logic separable so it is unit-testable without a browser.
 *
 *   2. `traceValue` — the orchestrator. It anchors a symptom to a React source
 *      location, runs the M3 static backward-slice, then walks the slice's blocked
 *      leaves and ATTACHES (does not auto-run) a runtime probe to each, chosen
 *      from a blind-spot -> probe table. It returns a token-bounded `render()`
 *      plus the lossless tree and an `expand(hopId)` drill-down.
 *
 * Nothing here mutates the M3 static-analysis output shapes — TraceHop / Loc /
 * Hazard / BlockedReason are imported and reused verbatim.
 */

import type { Page, Locator, ElementHandle } from '@xmorse/playwright-core'
import type { ICDPSession } from './cdp-session.js'
import type { Debugger } from './debugger.js'
import type { ModuleGraph } from './module-graph.js'
import { buildModuleGraph } from './module-graph.js'
import type { TraceHop, Loc, Hazard, BlockedReason } from './static-analysis.js'
import { backwardSlice, isPureFunctionSource } from './static-analysis.js'
import type { PageModelHandle } from './page-model.js'
import { getReactComponentInfo, type ReactComponentInfo } from './react-source.js'

// ---------------------------------------------------------------------------
// Probe toolkit
// ---------------------------------------------------------------------------

export interface LogpointHit {
  tag: string
  value: unknown
  ts?: number
}

// Token budget: at most 20 hits, each value capped to ~50 chars.
const LOGPOINT_MAX_HITS = 20
const LOGPOINT_MAX_LEN = 50

function capForBudget(value: unknown, maxLen: number): unknown {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s == null) return value
  if (s.length <= maxLen) return value
  return s.slice(0, maxLen) + `…(${s.length})`
}

/**
 * Parse `[[logpoint:TAG]] <json>` lines out of the page console log stream (the
 * executor's `browserLogs`/`getLatestLogs`). Pure over the log array — feed it a
 * plain string[] getter and it needs no browser. Output is capped to the token
 * budget (20 most-recent hits, each value truncated).
 */
export async function readLogpoints({
  getLogs,
  tag,
  sinceCursor,
  maxHits = LOGPOINT_MAX_HITS,
  maxLen = LOGPOINT_MAX_LEN,
}: {
  getLogs: () => string[] | Promise<string[]>
  tag?: string
  sinceCursor?: number
  maxHits?: number
  maxLen?: number
}): Promise<LogpointHit[]> {
  let logs = await getLogs()
  if (typeof sinceCursor === 'number' && sinceCursor > 0) {
    logs = logs.slice(sinceCursor)
  }
  const re = /\[\[logpoint:([^\]]+)\]\]\s?(.*)$/
  const hits: LogpointHit[] = []
  for (const line of logs) {
    const m = line.match(re)
    if (!m) continue
    const [, t, rest] = m
    if (tag && t !== tag) continue
    let value: unknown
    try {
      value = JSON.parse(rest)
    } catch {
      value = rest
    }
    hits.push({ tag: t, value: capForBudget(value, maxLen) })
  }
  // Keep only the most-recent `maxHits`.
  return hits.slice(-maxHits)
}

/**
 * Prove (or refute) that an action mutates store state IN PLACE rather than
 * returning a fresh object. Captures the store-state reference, runs `action`,
 * re-captures, and reports whether the reference is identical. A `sameReference:
 * true` result is the fingerprint of a mutating reducer.
 */
export async function storeIdentity({
  page,
  action,
  storeExpr,
}: {
  page: Page
  action: () => Promise<void> | void
  storeExpr?: string
}): Promise<{ sameReference: boolean; captured: boolean }> {
  const getState =
    storeExpr ??
    '(window.__STORE__ && window.__STORE__.getState && window.__STORE__.getState()) ' +
      '|| (window.store && window.store.getState && window.store.getState()) ' +
      '|| (window.__REDUX_DEVTOOLS_EXTENSION__ && window.__REDUX_STORE__ && window.__REDUX_STORE__.getState && window.__REDUX_STORE__.getState())'

  const captured = await page.evaluate(
    (expr) => {
      try {
        const state = Function(`return (${expr})`)()
        ;(globalThis as any).__playwriter_trace_prevState = state
        return state != null && typeof state === 'object'
      } catch {
        return false
      }
    },
    getState,
  )

  await action()

  const sameReference = await page.evaluate(
    (expr) => {
      try {
        const cur = Function(`return (${expr})`)()
        const prev = (globalThis as any).__playwriter_trace_prevState
        return cur != null && cur === prev
      } catch {
        return false
      }
    },
    getState,
  )

  return { sameReference: !!sameReference && !!captured, captured: !!captured }
}

export interface NetEntry {
  phase: 'request' | 'response'
  url: string
  method?: string
  status?: number
  ts: number
}

export interface NetTimelineController {
  entries(): NetEntry[]
  stop(): void
}

/**
 * PASSIVE network capture: record issued/resolved order + timestamps for requests
 * matching `urlPattern` (a substring or RegExp). Attaches Playwright request/
 * response listeners and buffers into `buffer` (or a fresh array). Call `stop()`
 * to detach. Non-perturbing — safe to auto-run.
 */
export function netTimeline({
  page,
  urlPattern,
  buffer,
}: {
  page: Page
  urlPattern?: string | RegExp
  buffer?: NetEntry[]
}): NetTimelineController {
  const entries: NetEntry[] = buffer ?? []
  const matches = (url: string): boolean => {
    if (!urlPattern) return true
    return typeof urlPattern === 'string' ? url.includes(urlPattern) : urlPattern.test(url)
  }
  const onRequest = (req: { url(): string; method(): string }) => {
    const url = req.url()
    if (matches(url)) entries.push({ phase: 'request', url, method: req.method(), ts: Date.now() })
  }
  const onResponse = (res: { url(): string; status(): number }) => {
    const url = res.url()
    if (matches(url)) entries.push({ phase: 'response', url, status: res.status(), ts: Date.now() })
  }
  page.on('request', onRequest as any)
  page.on('response', onResponse as any)
  return {
    entries: () => entries.slice(),
    stop: () => {
      page.off('request', onRequest as any)
      page.off('response', onResponse as any)
    },
  }
}

/**
 * Deterministic race-forcing: hold matching requests for `ms` before continuing,
 * so an async ordering bug reproduces every time. Uses the CDP Fetch domain. Call
 * the returned `stop()` to disable interception. PERTURBING — never auto-run.
 */
export async function netDelay({
  cdp,
  urlPattern,
  ms,
}: {
  cdp: ICDPSession
  urlPattern: string
  ms: number
}): Promise<{ stop(): Promise<void> }> {
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern }] })
  const handler = (params: { requestId: string }) => {
    setTimeout(() => {
      cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {})
    }, ms)
  }
  cdp.on('Fetch.requestPaused', handler)
  return {
    stop: async () => {
      cdp.off('Fetch.requestPaused', handler)
      try {
        await cdp.send('Fetch.disable')
      } catch {
        // interception already gone
      }
    },
  }
}

/** Capture a React component's props/hierarchy for later diffing. */
export async function fiberSnapshot({
  locator,
  cdp,
}: {
  locator: Locator | ElementHandle
  cdp: ICDPSession
}): Promise<ReactComponentInfo | null> {
  return getReactComponentInfo({ locator, cdp })
}

export interface FiberDiff {
  sameComponent: boolean
  changedProps: string[]
  addedProps: string[]
  removedProps: string[]
  changedHierarchyDepth: boolean
}

/**
 * Diff two `fiberSnapshot` results: which prop keys changed / were added / removed
 * between renders, whether the component identity changed, and whether the
 * rendered hierarchy depth moved. Pure — no browser.
 */
export function fiberDiff(a: ReactComponentInfo | null, b: ReactComponentInfo | null): FiberDiff {
  const propsA = (a && typeof a.props === 'object' && a.props ? (a.props as Record<string, unknown>) : {}) as Record<string, unknown>
  const propsB = (b && typeof b.props === 'object' && b.props ? (b.props as Record<string, unknown>) : {}) as Record<string, unknown>
  const keysA = new Set(Object.keys(propsA))
  const keysB = new Set(Object.keys(propsB))
  const changedProps: string[] = []
  const addedProps: string[] = []
  const removedProps: string[] = []
  for (const k of keysB) {
    if (!keysA.has(k)) addedProps.push(k)
    else if (JSON.stringify(propsA[k]) !== JSON.stringify(propsB[k])) changedProps.push(k)
  }
  for (const k of keysA) {
    if (!keysB.has(k)) removedProps.push(k)
  }
  return {
    sameComponent: (a?.componentName ?? null) === (b?.componentName ?? null),
    changedProps,
    addedProps,
    removedProps,
    changedHierarchyDepth: (a?.hierarchy?.length ?? 0) !== (b?.hierarchy?.length ?? 0),
  }
}

export interface ReplayResult {
  ok: boolean
  value?: unknown
  reason?: string
  freeIdentifiers?: string[]
}

/**
 * Verify the sliced function is PURE (only params/locals + a safe-globals
 * whitelist — reusing the @babel/parser scope analysis in `isPureFunctionSource`)
 * and, only then, execute its source with the captured `args` in-process. Refuses
 * with a reason otherwise: an impure function depends on runtime state that is not
 * present here, so replaying it would throw or silently diverge.
 */
export function replayPure({
  fn,
  args,
  allow,
}: {
  fn: string | ((...a: any[]) => unknown)
  args?: unknown[]
  allow?: string[]
}): ReplayResult {
  const src = typeof fn === 'string' ? fn : fn.toString()
  const purity = isPureFunctionSource(src, { allow })
  if (!purity.pure) {
    return { ok: false, reason: purity.reason, freeIdentifiers: purity.freeIdentifiers }
  }
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(`return (${src})`)
    const f = factory() as (...a: any[]) => unknown
    const value = f(...(args ?? []))
    return { ok: true, value }
  } catch (e) {
    return { ok: false, reason: `replay threw: ${(e as Error).message}`, freeIdentifiers: purity.freeIdentifiers }
  }
}

// ---------------------------------------------------------------------------
// traceValue orchestrator
// ---------------------------------------------------------------------------

export type ProbeType =
  | 'storeIdentity'
  | 'captureArgs'
  | 'netTimeline'
  | 'netDelay'
  | 'runtime-scripts'
  | 'logpoint'

export interface RuntimeProbe {
  type: ProbeType
  /** True for observation-only probes safe to auto-run; false for perturbing/pausing. */
  passive: boolean
  /** Human-facing description of what running the probe would do. */
  spec: Record<string, unknown>
  run: () => Promise<unknown>
}

export interface BlockedLeaf {
  id: string
  blockedBy: BlockedReason
  site: Loc | null
  hazards: Hazard[]
  note?: string
  codeFrame?: string
  probe: RuntimeProbe | null
}

export interface AnchorInfo {
  componentName: string | null
  file: string | null
  line: number | null
  slot: string | null
  note?: string
}

/** Dependencies the orchestrator needs to anchor + arm probes. All optional so
 *  `traceValue` is fully unit-testable with an injected slice and no browser. */
export interface TraceDeps {
  page?: Page
  cdp?: ICDPSession
  dbg?: Debugger
  /** Returns the page console log lines (for logpoint-based probes). */
  getLogs?: () => string[] | Promise<string[]>
  /** Build (or fetch a cached) module graph for a root. Defaults to buildModuleGraph. */
  buildGraph?: (opts: { root: string }) => ModuleGraph
  /** The action that reproduces the symptom (for storeIdentity). */
  action?: () => Promise<void> | void
  storeExpr?: string
  urlPattern?: string
}

export interface TraceValueOptions {
  node?: PageModelHandle
  locator?: Locator | ElementHandle
  selector?: string
  slot?: string
  maxHops?: number
  maxBreadth?: number
  root?: string
  // Injection seams (tests / caching): supply a ready slice or graph directly.
  slice?: TraceHop
  graph?: ModuleGraph
  startFile?: string
  startExpr?: string
  deps?: TraceDeps
}

export interface TraceResult {
  render(): string
  tree: TraceHop
  blocked: BlockedLeaf[]
  anchor: AnchorInfo | null
  expand(hopId: string, opts?: { depth?: number }): TraceHop | null
}

const RENDER_MAX_LINES = 60

/**
 * Orchestrate a runtime-assisted backward value trace.
 *
 * 1. Anchor the symptom to a React component source location + slot (best-effort;
 *    degrades to `startFile`/`startExpr` when no DOM target/deps are available).
 * 2. Run the M3 static backward-slice.
 * 3. Walk the blocked leaves and ATTACH a runtime probe to each (never auto-run
 *    perturbing/pausing probes).
 * 4. Return a token-bounded `render()` plus the lossless tree + `expand()`.
 */
export async function traceValue(opts: TraceValueOptions): Promise<TraceResult> {
  const deps = opts.deps ?? {}
  const maxHops = opts.maxHops ?? 8
  const maxBreadth = opts.maxBreadth ?? 3

  let anchor: AnchorInfo | null = null
  let slice: TraceHop

  if (opts.slice) {
    slice = opts.slice
  } else {
    let startFile = opts.startFile
    let startExpr = opts.startExpr

    if (!startFile || !startExpr) {
      if (opts.node || opts.locator || opts.selector) {
        anchor = await resolveAnchor(opts, deps)
        if (anchor) {
          startFile = startFile ?? anchor.file ?? undefined
          startExpr = startExpr ?? anchor.slot ?? undefined
        }
      }
    }

    if (!startFile || !startExpr) {
      slice = {
        kind: 'blocked',
        site: null,
        blockedBy: 'dynamic',
        hazards: [],
        evaluated: null,
        note: 'could not determine a start (need an anchorable node/locator or startFile+startExpr)',
      }
    } else {
      const build = deps.buildGraph ?? buildModuleGraph
      const graph = opts.graph ?? build({ root: opts.root ?? process.cwd() })
      slice = backwardSlice({ graph, startFile, startExpr, maxHops, maxBreadth })
    }
  }

  return buildResult(slice, anchor, deps)
}

/** Best-effort anchor: reactFiber -> source file/line + inferred slot. */
async function resolveAnchor(opts: TraceValueOptions, deps: TraceDeps): Promise<AnchorInfo | null> {
  try {
    let fiber: { componentName: string | null; source: unknown; props: unknown } | null = null

    if (opts.node && typeof opts.node.reactFiber === 'function') {
      fiber = await opts.node.reactFiber()
    } else if ((opts.locator || opts.selector) && deps.cdp) {
      const locator = opts.locator ?? (deps.page && opts.selector ? deps.page.locator(opts.selector) : null)
      if (locator) {
        const info = await getReactComponentInfo({ locator, cdp: deps.cdp })
        fiber = info ? { componentName: info.componentName, source: info.source, props: info.props } : null
      }
    }

    if (!fiber) return null
    const source = (fiber.source ?? {}) as { fileName?: string | null; lineNumber?: number | null }
    const slot = opts.slot ?? inferSlot(fiber.props)
    return {
      componentName: fiber.componentName ?? null,
      file: source.fileName ?? null,
      line: source.lineNumber ?? null,
      slot,
      note: opts.slot ? undefined : 'slot inferred from fiber props (pass `slot` to override)',
    }
  } catch (e) {
    return { componentName: null, file: null, line: null, slot: opts.slot ?? null, note: `anchor failed: ${(e as Error).message}` }
  }
}

function inferSlot(props: unknown): string | null {
  if (!props || typeof props !== 'object') return null
  const keys = Object.keys(props as Record<string, unknown>).filter((k) => k !== 'children')
  return keys.length ? keys[0] : null
}

// --- Result assembly -------------------------------------------------------

function buildResult(tree: TraceHop, anchor: AnchorInfo | null, deps: TraceDeps): TraceResult {
  const idByHop = new WeakMap<TraceHop, string>()
  const hopById = new Map<string, TraceHop>()
  const blocked: BlockedLeaf[] = []

  const walk = (hop: TraceHop, id: string): void => {
    idByHop.set(hop, id)
    hopById.set(id, hop)
    if (hop.blockedBy) {
      blocked.push({
        id,
        blockedBy: hop.blockedBy,
        site: hop.site,
        hazards: hop.hazards,
        note: hop.note,
        codeFrame: hop.codeFrame,
        probe: armProbe(hop, deps),
      })
    }
    const children = hop.children ?? []
    children.forEach((child, i) => walk(child, `${id}.${i}`))
  }
  walk(tree, '0')

  const render = (): string => {
    const lines: string[] = []
    if (anchor) {
      const where = anchor.file ? `${anchor.file}${anchor.line != null ? ':' + anchor.line : ''}` : '(no source)'
      lines.push(`anchor: <${anchor.componentName ?? '?'}> slot=${anchor.slot ?? '?'} @ ${where}`)
    }
    renderHop(tree, 0, lines, idByHop)
    if (lines.length > RENDER_MAX_LINES) {
      const kept = lines.slice(0, RENDER_MAX_LINES - 1)
      kept.push(`… (${lines.length - kept.length} more lines collapsed; use expand(hopId))`)
      return kept.join('\n')
    }
    return lines.join('\n')
  }

  const expand = (hopId: string): TraceHop | null => hopById.get(hopId) ?? null

  return { render, tree, blocked, anchor, expand }
}

function fmtValue(value: unknown): string {
  let s: string
  try {
    s = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s == null) s = String(value)
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

function siteStr(site: Loc | null): string {
  if (!site) return ''
  const file = site.file ? site.file.split('/').pop() : ''
  return `@${file ? file + ':' : ''}${site.line}:${site.column}`
}

function renderHop(hop: TraceHop, depth: number, lines: string[], idByHop: WeakMap<TraceHop, string>): void {
  const indent = '  '.repeat(depth)
  const id = idByHop.get(hop) ?? '?'

  // Confident branch collapses to a one-line `= value` — no children shown.
  if (hop.evaluated?.confident) {
    lines.push(`${indent}[${id}] ${hop.kind} ${siteStr(hop.site)} = ${fmtValue(hop.evaluated.value)}`)
    return
  }

  const blockedTag = hop.blockedBy ? ` BLOCKED:${hop.blockedBy}` : ''
  const hazardTag = hop.hazards.length ? ` hazards=${hop.hazards.map((h) => h.type).join(',')}` : ''
  const note = hop.note ? ` — ${hop.note}` : ''
  lines.push(`${indent}[${id}] ${hop.kind}${blockedTag}${hazardTag} ${siteStr(hop.site)}${note}`)

  // Code-frames only at blocked leaves (the deopt spine's endpoints).
  if (hop.blockedBy && hop.codeFrame) {
    for (const frameLine of hop.codeFrame.split('\n')) {
      lines.push(`${indent}  | ${frameLine}`)
    }
  }

  for (const child of hop.children ?? []) {
    renderHop(child, depth + 1, lines, idByHop)
  }
}

// --- Blind-spot -> probe table ---------------------------------------------

/**
 * The heart of M4: map a blocked leaf's `blockedBy` reason (+ hazards) to a
 * pre-built, non-executed runtime probe.
 *
 *   mutation          -> storeIdentity (+ hazard sites for write-logpoints)
 *   interprocedural   -> captureArgsAt (entry logpoint on the arg's function)
 *   async             -> netTimeline (passive) first, netDelay to force the race
 *   unresolved-module -> runtime-only: listScripts + getScriptSourceByUrl
 *   dynamic / other   -> runtime-only: a value logpoint at the site
 */
function armProbe(hop: TraceHop, deps: TraceDeps): RuntimeProbe | null {
  switch (hop.blockedBy) {
    case 'mutation':
      return {
        type: 'storeIdentity',
        passive: false,
        spec: {
          hazardSites: hop.hazards.map((h) => h.loc),
          note: 'capture store-state ref, run the action, re-capture; sameReference=true proves an in-place mutation',
          alsoConsider: 'write-logpoints at the hazard sites',
        },
        run: async () => {
          if (!deps.page || !deps.action) {
            throw new Error('storeIdentity probe needs deps { page, action }')
          }
          return storeIdentity({ page: deps.page, action: deps.action, storeExpr: deps.storeExpr })
        },
      }

    case 'interprocedural': {
      const fn = fnNameFromNote(hop.note)
      const file = hop.site?.file
      return {
        type: 'captureArgs',
        passive: false,
        spec: { fn, file, site: hop.site, note: 'arm an entry logpoint on the function; drain args from the log stream' },
        run: async () => {
          if (!deps.dbg) throw new Error('captureArgs probe needs deps { dbg }')
          if (!file || !fn) throw new Error('captureArgs probe could not recover function name/file from the slice')
          return deps.dbg.captureArgsAt({ file, fn })
        },
      }
    }

    case 'async':
      return {
        type: 'netTimeline',
        passive: true,
        spec: {
          site: hop.site,
          urlPattern: deps.urlPattern ?? null,
          note: 'passively record request/response order first; use netDelay to force the race deterministically',
        },
        run: async () => {
          if (!deps.page) throw new Error('netTimeline probe needs deps { page }')
          return netTimeline({ page: deps.page, urlPattern: deps.urlPattern })
        },
      }

    case 'unresolved-module':
      return {
        type: 'runtime-scripts',
        passive: true,
        spec: { site: hop.site, note: 'no author source: list live scripts + fetch bundled source by url' },
        run: async () => {
          if (!deps.dbg) throw new Error('runtime-scripts probe needs deps { dbg }')
          const scripts = await deps.dbg.listScripts()
          return { scripts }
        },
      }

    default:
      // dynamic / null-but-noted leaves: fall back to a value logpoint at the site.
      return {
        type: 'logpoint',
        passive: false,
        spec: { site: hop.site, note: 'dynamic value: arm a value logpoint at the site and drain the log stream' },
        run: async () => {
          if (!deps.dbg || !hop.site?.file || hop.site.line == null) {
            throw new Error('logpoint probe needs deps { dbg } and a resolved site')
          }
          return deps.dbg.setLogpoint({ file: hop.site.file, line: hop.site.line, expr: 'this', tag: 'trace' })
        },
      }
  }
}

function fnNameFromNote(note?: string): string | null {
  if (!note) return null
  const m = note.match(/of "([^"]+)"/)
  return m ? m[1] : null
}
