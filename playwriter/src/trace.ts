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
 *      plus the lossless tree and an `expand(hopId, { depth })` drill-down.
 *
 * Nothing here mutates the M3 static-analysis output shapes — TraceHop / Loc /
 * Hazard / BlockedReason are imported and reused verbatim.
 *
 * ONE RULE ABOVE THE OTHERS: a probe that failed to MEASURE must never be
 * readable as a probe that measured a healthy result. Every result type here is
 * shaped so the verdict field does not exist unless a measurement happened, and
 * every cap / truncation / dropped record is named in the returned value.
 */

import type { Page, Locator, ElementHandle } from '@xmorse/playwright-core'
import type { ICDPSession } from './cdp-session.js'
import type { Debugger } from './debugger.js'
import type { ModuleGraph } from './module-graph.js'
import { buildModuleGraph } from './module-graph.js'
import type { TraceHop, Loc, Hazard, BlockedReason } from './static-analysis.js'
import { backwardSlice, isPureFunctionSource, parseModule } from './static-analysis.js'
import type { PageModelHandle } from './page-model.js'
import { getReactComponentInfo, type ReactComponentInfo } from './react-source.js'
import _traverse from '@babel/traverse'
import type { NodePath } from '@babel/traverse'

// @babel/traverse is CJS with a double-default under ESM interop.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse

// ---------------------------------------------------------------------------
// Logpoint reading
// ---------------------------------------------------------------------------

/** How a value was cut to fit the token budget. Present ONLY when cut. */
export interface LogpointTruncation {
  originalLength: number
  keptLength: number
}

export interface LogpointHit {
  tag: string
  value: unknown
  /** Present ONLY when the value was cut. Its absence means the value is whole. */
  truncated?: LogpointTruncation
  /**
   * Present when the payload was not usable JSON — a page-side stringify failure,
   * an `undefined` expression, a payload the page capped, or a cut log line. The
   * raw text is kept so the failure is diagnosable instead of silently coerced.
   */
  malformed?: { reason: string; raw: string }
  ts?: number
  /** Index of the source line within the scanned log array. */
  lineIndex: number
}

export interface LogpointRead {
  /** The returned window: the most-recent `caps.maxHits` matching hits. */
  hits: LogpointHit[]
  /** TRUE number of matching hits in the scanned range, before windowing. */
  totalHits: number
  /** totalHits - hits.length. Non-zero means older hits were dropped. */
  droppedHits: number
  /** How many of the returned hits carry a `malformed` marker. */
  malformedHits: number
  /** Lines carrying the marker whose tag could not be read at all. */
  unparsableLines: string[]
  caps: { maxHits: number; maxLen: number }
  linesScanned: number
  /** Pass back as `sinceCursor` to read only lines added after this call. */
  cursor: number
}

// Token budget: at most 20 hits, each value capped to ~50 chars. Both are
// reported in `caps` and both are configurable — a silent cap is a lie.
const LOGPOINT_MAX_HITS = 20
const LOGPOINT_MAX_LEN = 50

function capForBudget(value: unknown, maxLen: number): { value: unknown; truncated?: LogpointTruncation } {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s == null) return { value }
  if (s.length <= maxLen) return { value }
  const kept = s.slice(0, maxLen)
  return {
    value: kept + `…(${s.length})`,
    truncated: { originalLength: s.length, keptLength: kept.length },
  }
}

// The envelopes `buildLogpointCondition` emits when the page cannot produce plain
// JSON. Recognising them here is what turns a page-side failure into a diagnosis
// instead of a mystery string.
function decodePayload(raw: string): { value: unknown; malformed?: { reason: string; raw: string } } {
  const text = raw.trim()
  if (text === '') {
    return { value: undefined, malformed: { reason: 'empty payload after the marker', raw } }
  }
  if (text === 'undefined') {
    return {
      value: undefined,
      malformed: {
        reason: 'payload was the bare word `undefined` — JSON.stringify(expr) returned undefined (the expression is undefined, a function, or a symbol)',
        raw,
      },
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    const looksStructural = /^[[{]/.test(text)
    return {
      value: text,
      malformed: {
        reason: looksStructural
          ? `payload starts like JSON but does not parse (${(e as Error).message}) — most likely cut by the log pipeline; lower \`maxPayload\` on the logpoint or log a narrower expression`
          : `payload is not JSON (${(e as Error).message}); kept as raw text`,
        raw,
      },
    }
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (typeof o.__playwriter_logpoint_error === 'string') {
      return { value: undefined, malformed: { reason: `logpoint failed in the page: ${o.__playwriter_logpoint_error}`, raw } }
    }
    if (o.__playwriter_logpoint_undefined === true) {
      return { value: undefined, malformed: { reason: 'the logged expression evaluated to undefined in the page', raw } }
    }
    if (typeof o.__playwriter_logpoint_truncated === 'number') {
      return {
        value: o.head,
        malformed: {
          reason: `the page capped this payload at ${String(o.__playwriter_logpoint_truncated)} chars before logging (raise \`maxPayload\` on setLogpoint to keep more)`,
          raw,
        },
      }
    }
  }
  return { value: parsed }
}

/**
 * Parse `[[logpoint:TAG]] <json>` lines out of the page console log stream (the
 * executor's `browserLogs`/`getLatestLogs`). Pure over the log array — feed it a
 * plain string[] getter and it needs no browser.
 *
 * The window is capped (20 hits, 50 chars per value by default) but never
 * silently: `totalHits`/`droppedHits` report what the window hid and each cut
 * value carries a `truncated` marker. Payloads the page could not serialise are
 * surfaced as `malformed` rather than dropped or coerced to a plausible string.
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
}): Promise<LogpointRead> {
  const all = await getLogs()
  const offset = typeof sinceCursor === 'number' && sinceCursor > 0 ? Math.min(sinceCursor, all.length) : 0
  const logs = offset ? all.slice(offset) : all

  // The marker is emitted as a single console.log argument, so it can sit anywhere
  // in the line (the log pipeline prefixes `[log] `). Payload runs to end of line.
  const re = /\[\[logpoint:([^\]\s]+)\]\][ ]?(.*)$/
  const hits: LogpointHit[] = []
  const unparsableLines: string[] = []

  for (let i = 0; i < logs.length; i++) {
    const line = logs[i]
    if (!line.includes('[[logpoint:')) continue
    const m = line.match(re)
    if (!m) {
      unparsableLines.push(line.length > 200 ? line.slice(0, 200) + '…' : line)
      continue
    }
    const [, t, rest] = m
    if (tag && t !== tag) continue
    const decoded = decodePayload(rest)
    const capped = capForBudget(decoded.value, maxLen)
    const hit: LogpointHit = { tag: t, value: capped.value, lineIndex: offset + i }
    if (capped.truncated) hit.truncated = capped.truncated
    if (decoded.malformed) hit.malformed = decoded.malformed
    hits.push(hit)
  }

  const window = hits.slice(-maxHits)
  return {
    hits: window,
    totalHits: hits.length,
    droppedHits: hits.length - window.length,
    malformedHits: window.filter((h) => h.malformed).length,
    unparsableLines,
    caps: { maxHits, maxLen },
    linesScanned: logs.length,
    cursor: all.length,
  }
}

// ---------------------------------------------------------------------------
// storeIdentity
// ---------------------------------------------------------------------------

export type StoreDiscoveryVia = 'caller-storeExpr' | 'global' | 'react-fiber'

export interface StoreDiscovery {
  via: StoreDiscoveryVia
  /** A reusable expression that re-reads the state. Safe to pass as `storeExpr`. */
  expr: string
  /** Where in the fiber tree the store came from, when `via === 'react-fiber'`. */
  path?: string
  componentName?: string | null
  /** Set when the probe pinned the store on the page so it can be re-read. */
  pinnedAs?: string
}

/**
 * The measured half. `sameReference` EXISTS ONLY HERE: reading it requires having
 * a `measured: true` result in hand, so "I never found your store" can no longer
 * be mistaken for "your store correctly produced a new reference".
 */
export interface StoreIdentityMeasured {
  measured: true
  /** true = the SAME object came back after the action: an in-place mutation. */
  sameReference: boolean
  verdict: 'in-place-mutation' | 'fresh-reference'
  discovery: StoreDiscovery
  /** Top-level keys whose value reference differs between the two captures. */
  changedKeys: string[]
  changedKeysCapped: boolean
  stateKind: 'object' | 'array'
  note: string
}

export type StoreIdentityFailure =
  | 'store-not-found'
  | 'not-an-object'
  | 'expr-threw'
  | 'eval-blocked-by-csp'
  | 'store-vanished'
  | 'page-error'

/** The un-measured half. Deliberately carries NO verdict field of any kind. */
export interface StoreIdentityUnmeasured {
  measured: false
  reason: StoreIdentityFailure
  /** Everything the probe looked at, verbatim, so the gap is obvious. */
  tried: string[]
  detail: string
  /** What to do next. Always names `storeExpr` explicitly. */
  remedy: string
  /** Whether `action` still ran (the page may have changed even though nothing was measured). */
  actionRan: boolean
}

export type StoreIdentityResult = StoreIdentityMeasured | StoreIdentityUnmeasured

/** Globals probed by default, in order. Structural (`typeof x.getState === 'function'`)
 *  rather than eval'd, so a strict-CSP page does not defeat the default path. */
const STORE_GLOBAL_CANDIDATES = [
  '__STORE__',
  'store',
  '__REDUX_STORE__',
  '__NEXT_REDUX_STORE__',
  'reduxStore',
  '__APP_STORE__',
  '__store__',
  '__ZUSTAND_STORE__',
  '__MOBX_STORE__',
]

const STORE_REMEDY =
  'pass `storeExpr` — any JS expression, evaluated in the page, that RETURNS the state object ' +
  "(e.g. storeExpr: 'window.myStore.getState()' or 'document.querySelector(\"#root\")._reactRootContainer…'). " +
  'The probe cannot verdict on a store it never read.'

/**
 * Prove (or refute) that an action mutates store state IN PLACE rather than
 * returning a fresh object. Captures the store-state reference, runs `action`,
 * re-captures, and reports whether the reference is identical: `sameReference:
 * true` is the fingerprint of a mutating reducer (React bails out of the
 * re-render because the reference did not change).
 *
 * Discovery order: a caller `storeExpr` (eval'd in the page), then a list of
 * conventional globals probed structurally, then the React fiber tree — a
 * `<Provider store={…}>` prop or a context provider whose value exposes
 * `getState`. A fiber-discovered store is pinned as
 * `globalThis.__playwriter_trace_store` so it can be re-read after the action and
 * reused as a `storeExpr` later; that pin is reported in `discovery.pinnedAs`.
 *
 * When nothing is found the result is `{ measured: false }` and carries no
 * verdict field at all — there is no shape in which a failed probe reads as a
 * healthy store.
 */
export async function storeIdentity({
  page,
  action,
  storeExpr,
}: {
  page: Page
  action: () => Promise<void> | void
  storeExpr?: string
}): Promise<StoreIdentityResult> {
  type CaptureOut = {
    found: boolean
    via?: StoreDiscoveryVia
    expr?: string
    path?: string
    componentName?: string | null
    kind?: 'object' | 'array' | 'other'
    tried: string[]
    error?: string
    errorKind?: 'eval-blocked-by-csp' | 'expr-threw' | 'not-an-object'
    pinnedAs?: string
  }

  let capture: CaptureOut
  try {
    capture = await page.evaluate(
      (arg: { expr: string | null; globals: string[] }): CaptureOut => {
        const g = globalThis as any
        const tried: string[] = []

        const kindOf = (v: unknown): 'object' | 'array' | 'other' =>
          Array.isArray(v) ? 'array' : v !== null && typeof v === 'object' ? 'object' : 'other'

        const remember = (state: unknown, mode: 'expr' | 'store', payload: { expr?: string; store?: any }) => {
          // A SHALLOW snapshot of the top-level values, not just the root
          // reference: when the reducer mutates in place the root reference is
          // unchanged, so comparing the object against itself afterwards would
          // report "nothing changed" and hide the mutation. Holding the old
          // top-level values is what makes the mutation provable.
          const shallow: Record<string, unknown> = {}
          if (state && typeof state === 'object') {
            for (const k of Object.keys(state as object).slice(0, 200)) shallow[k] = (state as any)[k]
          }
          g.__playwriter_trace_probe = { prev: state, prevShallow: shallow, mode, expr: payload.expr, store: payload.store }
        }

        // --- 1. caller-supplied expression -------------------------------------
        if (arg.expr) {
          tried.push(`storeExpr: ${arg.expr}`)
          let state: unknown
          try {
            state = g.Function('return (' + arg.expr + ')')()
          } catch (e: any) {
            const msg = String((e && e.message) || e)
            const csp = /unsafe-eval|Content Security Policy|EvalError/i.test(msg) || (typeof EvalError === 'function' && e instanceof EvalError)
            return {
              found: false,
              tried,
              error: `storeExpr \`${arg.expr}\` threw in the page: ${msg}`,
              errorKind: csp ? 'eval-blocked-by-csp' : 'expr-threw',
            }
          }
          const kind = kindOf(state)
          if (kind === 'other') {
            return {
              found: false,
              tried,
              error: `storeExpr \`${arg.expr}\` returned ${state === null ? 'null' : typeof state}, not an object — it must RETURN the state object`,
              errorKind: 'not-an-object',
            }
          }
          remember(state, 'expr', { expr: arg.expr })
          return { found: true, via: 'caller-storeExpr', expr: arg.expr, kind, tried }
        }

        // --- 2. conventional globals (no eval: CSP-proof) ----------------------
        for (const name of arg.globals) {
          tried.push(`globalThis.${name}`)
          const s = g[name]
          if (s && (typeof s === 'object' || typeof s === 'function') && typeof s.getState === 'function') {
            let state: unknown
            try {
              state = s.getState()
            } catch (e: any) {
              tried.push(`globalThis.${name}.getState() threw: ${String((e && e.message) || e)}`)
              continue
            }
            const kind = kindOf(state)
            if (kind === 'other') {
              tried.push(`globalThis.${name}.getState() returned ${typeof state}, not an object`)
              continue
            }
            remember(state, 'store', { store: s })
            return { found: true, via: 'global', expr: `globalThis.${name}.getState()`, kind, tried }
          }
        }

        // --- 3. the React fiber tree -------------------------------------------
        const doc = g.document
        if (!doc) {
          return { found: false, tried, error: 'no document in this context', errorKind: 'expr-threw' }
        }
        const elements: any[] = [doc.documentElement]
        if (doc.body) {
          const all = doc.body.querySelectorAll('*')
          for (let i = 0; i < all.length && elements.length < 400; i++) elements.push(all[i])
        }
        let rootFiber: any = null
        for (const el of elements) {
          for (const key of Object.keys(el)) {
            if (key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$')) {
              rootFiber = el[key]
              break
            }
            if (key === '_reactRootContainer') {
              rootFiber = el[key] && el[key]._internalRoot ? el[key]._internalRoot.current : null
              break
            }
          }
          if (rootFiber) break
        }
        if (!rootFiber) {
          tried.push(`react fiber tree (scanned ${elements.length} elements; no __reactFiber$/__reactContainer$ key — not React, or a production build that strips them)`)
          return { found: false, tried, errorKind: undefined }
        }

        let top = rootFiber
        let climb = 0
        while (top.return && climb++ < 10000) top = top.return

        const nameOf = (f: any): string | null => {
          const t = f && f.type
          if (!t) return null
          if (typeof t === 'function') return t.displayName || t.name || null
          if (typeof t === 'object') {
            if (t.displayName) return t.displayName
            if (t._context && t._context.displayName) return `${t._context.displayName}.Provider`
            if (t.$$typeof) return 'Provider'
          }
          return null
        }

        const stack: any[] = [top]
        let visited = 0
        while (stack.length > 0 && visited < 20000) {
          const f = stack.pop()
          visited++
          const props = f && f.memoizedProps
          if (props && typeof props === 'object') {
            const candidates: Array<[string, any]> = [
              ['props.store', (props as any).store],
              ['props.value', (props as any).value],
              ['props.value.store', (props as any).value && (props as any).value.store],
            ]
            for (const [path, v] of candidates) {
              if (v && (typeof v === 'object' || typeof v === 'function') && typeof v.getState === 'function') {
                let state: unknown
                try {
                  state = v.getState()
                } catch {
                  continue
                }
                const kind = kindOf(state)
                if (kind === 'other') continue
                g.__playwriter_trace_store = v
                remember(state, 'store', { store: v })
                return {
                  found: true,
                  via: 'react-fiber',
                  expr: 'globalThis.__playwriter_trace_store.getState()',
                  path: `<${nameOf(f) ?? '?'}>.${path}`,
                  componentName: nameOf(f),
                  kind,
                  tried,
                  pinnedAs: 'globalThis.__playwriter_trace_store',
                }
              }
            }
          }
          if (f && f.child) stack.push(f.child)
          if (f && f.sibling && f !== top) stack.push(f.sibling)
        }
        tried.push(`react fiber tree (${visited} fibers: no <Provider store>, and no context value exposing getState())`)
        return { found: false, tried }
      },
      { expr: storeExpr ?? null, globals: STORE_GLOBAL_CANDIDATES },
    )
  } catch (e) {
    return {
      measured: false,
      reason: 'page-error',
      tried: [storeExpr ? `storeExpr: ${storeExpr}` : 'default discovery'],
      detail: `capturing the store threw in the page: ${(e as Error).message}`,
      remedy: STORE_REMEDY,
      actionRan: false,
    }
  }

  if (!capture.found) {
    const reason: StoreIdentityFailure =
      capture.errorKind === 'eval-blocked-by-csp'
        ? 'eval-blocked-by-csp'
        : capture.errorKind === 'expr-threw'
          ? 'expr-threw'
          : capture.errorKind === 'not-an-object'
            ? 'not-an-object'
            : 'store-not-found'
    return {
      measured: false,
      reason,
      tried: capture.tried,
      detail:
        capture.error ??
        'no store was found: none of the conventional globals exposed getState(), and no fiber carried a store prop or a context value with getState()',
      remedy:
        reason === 'eval-blocked-by-csp'
          ? `the page's CSP blocks the Function constructor, so a string \`storeExpr\` cannot be evaluated in-page. Expose the store on a global (window.__STORE__ = store) or relax CSP for the debug session. ${STORE_REMEDY}`
          : STORE_REMEDY,
      actionRan: false,
    }
  }

  await action()

  type RecaptureOut =
    | { ok: true; same: boolean; changedKeys: string[]; changedKeysCapped: boolean; kind: 'object' | 'array' | 'other' }
    | { ok: false; reason: 'probe-state-lost' | 'recapture-threw'; error?: string }

  let recapture: RecaptureOut
  try {
    recapture = await page.evaluate((): RecaptureOut => {
      const g = globalThis as any
      const p = g.__playwriter_trace_probe
      if (!p) return { ok: false, reason: 'probe-state-lost' }
      let cur: unknown
      try {
        cur = p.mode === 'store' ? p.store.getState() : g.Function('return (' + p.expr + ')')()
      } catch (e: any) {
        delete g.__playwriter_trace_probe
        return { ok: false, reason: 'recapture-threw', error: String((e && e.message) || e) }
      }
      const prev = p.prev
      const prevShallow = p.prevShallow || {}
      const same = cur === prev
      const changedKeys: string[] = []
      let capped = false
      if (cur && typeof cur === 'object') {
        const keys = new Set<string>([...Object.keys(cur as object), ...Object.keys(prevShallow)])
        for (const k of keys) {
          if ((cur as any)[k] !== prevShallow[k]) {
            if (changedKeys.length >= 50) {
              capped = true
              break
            }
            changedKeys.push(k)
          }
        }
      }
      // Never retain page state past the measurement.
      delete g.__playwriter_trace_probe
      return {
        ok: true,
        same,
        changedKeys,
        changedKeysCapped: capped,
        kind: Array.isArray(cur) ? 'array' : cur !== null && typeof cur === 'object' ? 'object' : 'other',
      }
    })
  } catch (e) {
    return {
      measured: false,
      reason: 'page-error',
      tried: capture.tried,
      detail: `re-reading the store after the action threw in the page: ${(e as Error).message}`,
      remedy: STORE_REMEDY,
      actionRan: true,
    }
  }

  if (!recapture.ok) {
    return {
      measured: false,
      reason: 'store-vanished',
      tried: capture.tried,
      detail:
        recapture.reason === 'probe-state-lost'
          ? 'the captured reference was gone after the action — the page navigated or reloaded, so the two captures cannot be compared'
          : `re-reading the store threw: ${recapture.error}`,
      remedy: `re-run with an action that does not navigate, or capture across the navigation with two explicit calls. ${STORE_REMEDY}`,
      actionRan: true,
    }
  }

  const same = recapture.same
  return {
    measured: true,
    sameReference: same,
    verdict: same ? 'in-place-mutation' : 'fresh-reference',
    discovery: {
      via: capture.via!,
      expr: capture.expr!,
      path: capture.path,
      componentName: capture.componentName ?? null,
      pinnedAs: capture.pinnedAs,
    },
    changedKeys: recapture.changedKeys,
    changedKeysCapped: recapture.changedKeysCapped,
    stateKind: recapture.kind === 'array' ? 'array' : 'object',
    note: same
      ? `the SAME state object came back after the action${
          recapture.changedKeys.length
            ? ` while top-level key(s) ${recapture.changedKeys.join(', ')} changed value` +
              ' — that is an in-place mutation: React sees an unchanged reference and bails out of the re-render'
            : ' and no top-level value changed either — that is EITHER a nested in-place mutation' +
              ' (state.items.push(…) leaves both the root and the top-level references untouched) OR an action that did nothing.' +
              ' Distinguish them by logpointing the nested container, or by re-running with a storeExpr aimed at the nested slice'
        }`
      : `a NEW state object came back after the action (top-level keys changed: ${
          recapture.changedKeys.join(', ') || 'none'
        }) — the reducer is producing fresh references, so a missed re-render lies elsewhere`,
  }
}

// ---------------------------------------------------------------------------
// Session-scoped probe registry (net.* lifetime)
// ---------------------------------------------------------------------------

export type TraceProbeKind = 'net.timeline' | 'net.delay'

export interface TraceProbeInfo {
  id: string
  kind: TraceProbeKind
  /** true = this probe changes page behaviour while it is live. */
  perturbing: boolean
  live: boolean
  startedAt: number
  stoppedAt: number | null
  stoppedReason: 'caller' | 'ttl' | 'stopAll' | 'error' | null
  /** When the probe will auto-stop; null means "until stopped" (reported as unbounded). */
  expiresAt: number | null
  spec: Record<string, unknown>
  /** Counters, plus the boolean verdicts a counter cannot express — `interceptedNothing`
   *  exists precisely because "0" and "nothing was measured" are different facts. */
  stats: Record<string, number | boolean>
  describe: string
}

interface RegistryEntry {
  info: Omit<TraceProbeInfo, 'describe' | 'stats'>
  owner: unknown
  stats: () => Record<string, number | boolean>
  read?: () => unknown
  doStop: (reason: NonNullable<TraceProbeInfo['stoppedReason']>) => void | Promise<void>
  timer?: ReturnType<typeof setTimeout>
}

// Module-level on purpose: the executor process IS the session, and a controller
// that lives only inside one `execute()` call is the trap this registry exists to
// remove. A dropped controller stays discoverable (and stoppable) here.
const registry = new Map<string, RegistryEntry>()
let probeSeq = 0

/**
 * A probe that intercepted nothing, said out loud.
 *
 * `stats()` returning zeros used to be indistinguishable from a probe that ran cleanly
 * and simply had nothing to do. For a PERTURBING probe those are opposite facts: the
 * first means the measurement never happened.
 */
function describeInterception(e: RegistryEntry): string {
  if (e.info.kind !== 'net.delay') return ''
  const s = e.stats() as unknown as NetDelayStats
  if (!s.interceptedNothing) return ` [held ${s.paused} request(s)]`
  const seen = s.seen ?? 0
  return (
    ` [INTERCEPTED NOTHING: ${seen} request(s) reached the interceptor, 0 matched urlPattern ` +
    `${JSON.stringify(e.info.spec.urlPattern)}` +
    (seen === 0
      ? ` and none reached it at all — no matching request was issued while it was live`
      : `; the pattern is a SUBSTRING of the url (or a RegExp), not a glob`) +
    `. This probe has perturbed nothing, so any timing read while it was live is unperturbed, NOT a clean measurement ` +
    `of the delayed case]`
  )
}

function describeEntry(e: RegistryEntry): string {
  const ageS = Math.round((Date.now() - e.info.startedAt) / 1000)
  const state = e.info.live
    ? `LIVE for ${ageS}s${e.info.expiresAt ? `, auto-stops in ${Math.max(0, Math.round((e.info.expiresAt - Date.now()) / 1000))}s` : ', unbounded'}`
    : `stopped (${e.info.stoppedReason})`
  return `${e.info.kind} ${e.info.id} ${state} ${JSON.stringify(e.info.spec)}${describeInterception(e)}`
}

function toInfo(e: RegistryEntry): TraceProbeInfo {
  return { ...e.info, stats: e.stats(), describe: describeEntry(e) }
}

function registerProbe(entry: RegistryEntry): string {
  registry.set(entry.info.id, entry)
  return entry.info.id
}

function nextProbeId(kind: TraceProbeKind): string {
  probeSeq += 1
  return `${kind}#${probeSeq}`
}

async function stopEntry(e: RegistryEntry, reason: NonNullable<TraceProbeInfo['stoppedReason']>): Promise<void> {
  if (!e.info.live) return
  if (e.timer) clearTimeout(e.timer)
  try {
    await e.doStop(reason)
    e.info.stoppedReason = reason
  } catch {
    e.info.stoppedReason = 'error'
  }
  e.info.live = false
  e.info.stoppedAt = Date.now()
}

/**
 * Every probe this process has started, live or stopped. The stopped ones are kept
 * for the session so "who perturbed my measurement?" has an answer.
 */
export function listTraceProbes(opts?: { live?: boolean; kind?: TraceProbeKind }): TraceProbeInfo[] {
  const out: TraceProbeInfo[] = []
  for (const e of registry.values()) {
    if (opts?.live !== undefined && e.info.live !== opts.live) continue
    if (opts?.kind && e.info.kind !== opts.kind) continue
    out.push(toInfo(e))
  }
  return out
}

export function getTraceProbe(id: string): TraceProbeInfo | null {
  const e = registry.get(id)
  return e ? toInfo(e) : null
}

/** Read a probe's captured data by id — works after the controller went out of scope. */
export function readTraceProbe(id: string): unknown {
  const e = registry.get(id)
  if (!e) return null
  return e.read ? e.read() : null
}

export async function stopTraceProbe(id: string): Promise<boolean> {
  const e = registry.get(id)
  if (!e) return false
  await stopEntry(e, 'caller')
  return true
}

export async function stopAllTraceProbes(opts?: { owner?: unknown; kind?: TraceProbeKind }): Promise<string[]> {
  const stopped: string[] = []
  for (const e of registry.values()) {
    if (!e.info.live) continue
    if (opts?.owner !== undefined && e.owner !== opts.owner) continue
    if (opts?.kind && e.info.kind !== opts.kind) continue
    await stopEntry(e, 'stopAll')
    stopped.push(e.info.id)
  }
  return stopped
}

/**
 * One line per live PERTURBING probe. `traceValue` folds these into its result so a
 * forgotten `net.delay` cannot silently poison every later measurement: the next
 * trace you run says so out loud.
 */
export function tracePerturbationWarnings(): string[] {
  const out: string[] = []
  for (const e of registry.values()) {
    if (!e.info.live || !e.info.perturbing) continue
    out.push(
      `PERTURBING: ${describeEntry(e)} — every timing measurement in this session is affected until ` +
        `net.stop('${e.info.id}') (or net.stopAll()).`,
    )
  }
  return out
}

// NOTE: there was a `traceProbes` convenience namespace here, JSDoc'd "Convenience
// namespace for the sandbox". Nothing ever imported it — zero importers — so the sandbox
// never had it, while a maintainer reading this file would reasonably conclude that
// `traceProbes.get(id)` was reachable from `execute()`. It is deleted rather than wired,
// because the real sandbox namespace is `net` in `executor.ts` and a second grouping of
// the same six functions is how two spellings drift apart. The one member `net` lacked,
// `getTraceProbe`, is now exposed there as `net.get(id)`.

// ---------------------------------------------------------------------------
// net.timeline / net.delay
// ---------------------------------------------------------------------------

export interface NetEntry {
  phase: 'request' | 'response'
  url: string
  method?: string
  status?: number
  ts: number
}

/**
 * THE one meaning of `urlPattern` across this module: a SUBSTRING of the URL, or a
 * RegExp tested against it. `netTimeline` has always meant this. `netDelay` did not —
 * it passed the caller's string straight to `Fetch.enable`, whose `urlPattern` is a
 * whole-URL GLOB (`*` = any run, `?` = one char, `\` escapes). Measured against real
 * Chromium on a page fetching `http://127.0.0.1:8897/api/cart?x=1`:
 *
 *     "/api/"    -> intercepted 0 requests
 *     "*​/api/*"  -> intercepted 1
 *     "*"        -> intercepted 1
 *
 * So `net.delay({ urlPattern: '/api/' })` held nothing, continued nothing, and still
 * announced itself LIVE and PERTURBING in `tracePerturbationWarnings()` — a race-class
 * probe reporting a clean measurement having perturbed nothing.
 *
 * Rejecting non-glob strings loudly was the alternative and is worse: it leaves the two
 * neighbouring functions meaning two different things by the same option name, just
 * noisily, and it cannot express a RegExp at all. Translating is what makes the option
 * name honest.
 */
/**
 * Reject a glob where a substring is expected, instead of matching nothing.
 *
 * The option is *named* `urlPattern`, so a glob is the natural guess — and it used to be
 * the correct thing to pass to `netDelay`, which forwarded it verbatim to `Fetch.enable`.
 * Under the unified substring language `'*​/api/*'` means "a URL containing the literal
 * characters `*​/api/*`", which no URL does. Measured against the current implementation:
 * `'*​/api/*'`, `'*'` and `'*.json'` all match nothing.
 *
 * That is the failure this whole change set exists to remove — a probe that intercepts
 * nothing while reporting a clean run. `interceptedNothing` catches it after the fact;
 * this catches it before the run, which is the only point at which the caller can still
 * do something about it. A literal `*` or `?` in a URL substring is essentially never
 * what anyone means, so the false-rejection cost is close to zero.
 */
function assertNotGlob(urlPattern: string): void {
  if (!/[*?]/.test(urlPattern)) return
  throw new Error(
    `urlPattern ${JSON.stringify(urlPattern)} looks like a glob, but net.timeline/net.delay take a ` +
      `SUBSTRING of the URL or a RegExp — a glob is matched literally here and would intercept nothing. ` +
      `Write the substring you actually mean (e.g. '/api/' instead of '*/api/*'), a RegExp ` +
      `(e.g. /\\/api\\/.*\\.json$/), or omit urlPattern entirely to match every request.`,
  )
}

export function matchesUrlPattern(url: string, urlPattern: string | RegExp | undefined): boolean {
  if (!urlPattern) return true
  if (typeof urlPattern !== 'string') return urlPattern.test(url)
  assertNotGlob(urlPattern)
  return url.includes(urlPattern)
}

/**
 * The `Fetch.enable` glob that intercepts a SUPERSET of what `urlPattern` matches.
 *
 * A substring becomes `*<escaped>*`, with the glob metacharacters (`\`, `*`, `?`)
 * escaped so a literal `?` in a query string is matched as itself rather than as the
 * one-character wildcard. A RegExp cannot be expressed as a glob at all, so it
 * intercepts `*` and is narrowed by `matchesUrlPattern` in the handler.
 *
 * The handler re-checks EVERY paused request with `matchesUrlPattern` regardless, so
 * the glob is only a cheap pre-filter and the two functions' semantics stay identical
 * by construction rather than by two implementations agreeing.
 */
export function urlPatternToFetchGlob(urlPattern: string | RegExp | undefined): string {
  if (!urlPattern) return '*'
  if (typeof urlPattern !== 'string') return '*'
  // Reject here too, not only in the handler: this runs at arm time, so a glob fails
  // before Fetch.enable is sent rather than after a run that held nothing.
  assertNotGlob(urlPattern)
  return `*${urlPattern.replace(/[\\*?]/g, '\\$&')}*`
}

export interface NetTimelineController {
  /** Registry id. Survives this `execute()` call: `net.read(id)` drains it later. */
  id: string
  entries(): NetEntry[]
  /** Retention accounting — a full buffer drops the OLDEST entries, visibly. */
  stats(): { total: number; retained: number; dropped: number; maxEntries: number }
  stop(): void
  info(): TraceProbeInfo | null
}

const NET_TIMELINE_MAX_ENTRIES = 2000

/**
 * PASSIVE network capture: record issued/resolved order + timestamps for requests
 * matching `urlPattern` (a substring or RegExp). Non-perturbing — safe to auto-run.
 *
 * The controller is also registered in the session probe registry, so a caller who
 * forgets to stash it in `state` does NOT silently record nothing: the listeners
 * stay attached, `net.active()` still lists the probe, and `net.read(id)` drains
 * the entries from a later call. Buffer retention is capped and reported.
 */
export function netTimeline({
  page,
  urlPattern,
  buffer,
  maxEntries = NET_TIMELINE_MAX_ENTRIES,
}: {
  page: Page
  urlPattern?: string | RegExp
  buffer?: NetEntry[]
  maxEntries?: number
}): NetTimelineController {
  const entries: NetEntry[] = buffer ?? []
  let total = 0
  let dropped = 0

  const matches = (url: string): boolean => matchesUrlPattern(url, urlPattern)
  const push = (e: NetEntry) => {
    total++
    entries.push(e)
    while (entries.length > maxEntries) {
      entries.shift()
      dropped++
    }
  }
  const onRequest = (req: { url(): string; method(): string }) => {
    const url = req.url()
    if (matches(url)) push({ phase: 'request', url, method: req.method(), ts: Date.now() })
  }
  const onResponse = (res: { url(): string; status(): number }) => {
    const url = res.url()
    if (matches(url)) push({ phase: 'response', url, status: res.status(), ts: Date.now() })
  }
  page.on('request', onRequest as any)
  page.on('response', onResponse as any)

  const stats = () => ({ total, retained: entries.length, dropped, maxEntries })
  const id = registerProbe({
    info: {
      id: nextProbeId('net.timeline'),
      kind: 'net.timeline',
      perturbing: false,
      live: true,
      startedAt: Date.now(),
      stoppedAt: null,
      stoppedReason: null,
      expiresAt: null,
      spec: { urlPattern: urlPattern ? String(urlPattern) : null, maxEntries },
    },
    owner: page,
    stats,
    read: () => ({ entries: entries.slice(), ...stats() }),
    doStop: () => {
      page.off('request', onRequest as any)
      page.off('response', onResponse as any)
    },
  })

  return {
    id,
    entries: () => entries.slice(),
    stats,
    stop: () => {
      void stopTraceProbe(id)
    },
    info: () => getTraceProbe(id),
  }
}

// A type alias, not an interface: the probe registry stores `Record<string, number |
// boolean>` and only a type alias is structurally assignable to an index signature.
export type NetDelayStats = {
  /** Requests this probe actually HELD for `ms`. */
  paused: number
  continued: number
  failed: number
  pending: number
  /** Every `Fetch.requestPaused` the probe saw, matching or not. */
  seen: number
  /** Seen but not matching `urlPattern` — continued immediately, never delayed. */
  notMatched: number
  /**
   * TRUE while the probe has held nothing. A `net.delay` that intercepts nothing is
   * NOT a clean run: it is a measurement that never happened, and it must not be
   * readable as one that happened and found no delay to introduce.
   */
  interceptedNothing: boolean
}

export interface NetDelayController {
  id: string
  stop(): Promise<void>
  stats(): NetDelayStats
  info(): TraceProbeInfo | null
}

/** Default lifetime for a `net.delay`: an interceptor nobody stops is a session-wide
 *  measurement poison, so it expires on its own and says so in the registry. */
const NET_DELAY_DEFAULT_TTL_MS = 120_000

/**
 * Deterministic race-forcing: hold matching requests for `ms` before continuing, so
 * an async ordering bug reproduces every time. Uses the CDP Fetch domain.
 * PERTURBING — never auto-run.
 *
 * Three guarantees replace the old "remember to call stop()" doctrine:
 *   - a second overlapping `net.delay` on the same CDP session is REFUSED (naming
 *     the live one), because `Fetch.enable` replaces the previous patterns and the
 *     two probes would silently fight;
 *   - the interception auto-expires after `ttlMs` (default 120s; `0` disables the
 *     expiry and is recorded as `unbounded`);
 *   - the probe is registered, so `net.active()` lists it and every later
 *     `traceValue` warns while it is live.
 */
export async function netDelay({
  cdp,
  urlPattern,
  ms,
  ttlMs = NET_DELAY_DEFAULT_TTL_MS,
  force = false,
}: {
  cdp: ICDPSession
  /** A SUBSTRING of the URL, or a RegExp — the same language `netTimeline` uses. NOT a
   *  `Fetch.enable` glob; see `matchesUrlPattern`. */
  urlPattern: string | RegExp
  ms: number
  ttlMs?: number
  force?: boolean
}): Promise<NetDelayController> {
  const conflict = [...registry.values()].find((e) => e.info.live && e.info.kind === 'net.delay' && e.owner === cdp)
  if (conflict && !force) {
    throw new Error(
      `refusing to start a second net.delay on this page: ${describeEntry(conflict)}. ` +
        `Fetch.enable REPLACES the previous interception patterns, so the two probes would silently fight and both ` +
        `measurements would be wrong. Stop it first — net.stop('${conflict.info.id}') — or pass { force: true } to ` +
        `deliberately take over.`,
    )
  }

  let paused = 0
  let continued = 0
  let failed = 0
  let seen = 0
  let notMatched = 0
  let stopped = false

  const fetchGlob = urlPatternToFetchGlob(urlPattern)
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: fetchGlob }] })

  const handler = (params: { requestId: string; request?: { url?: string } }) => {
    seen++
    const url = params.request?.url ?? ''
    // `delayed` is false for a request the glob let through but `urlPattern` does not
    // match: it is released at once and must not be counted as one this probe held.
    const release = (delayed: boolean) => {
      cdp
        .send('Fetch.continueRequest', { requestId: params.requestId })
        .then(() => {
          if (delayed) continued++
        })
        .catch(() => {
          // The request may already be gone (Fetch.disable auto-continues) — count
          // it rather than swallowing it, so a mismatch is visible in stats().
          if (delayed) failed++
        })
    }
    // The glob is a superset of `urlPattern` (and is just `*` for a RegExp), so a paused
    // request that does not match is continued at once and never counted as delayed.
    // This is what makes `netDelay`'s urlPattern mean exactly what `netTimeline`'s does.
    if (!matchesUrlPattern(url, urlPattern)) {
      notMatched++
      release(false)
      return
    }
    paused++
    // Once stopped, release immediately: a held request that nobody continues is a
    // hung page, which is a worse perturbation than the delay itself.
    if (stopped) release(true)
    else setTimeout(() => release(true), ms)
  }
  cdp.on('Fetch.requestPaused', handler)

  const stats = (): NetDelayStats => ({
    paused,
    continued,
    failed,
    pending: Math.max(0, paused - continued - failed),
    seen,
    notMatched,
    interceptedNothing: paused === 0,
  })
  const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : null

  const id = registerProbe({
    info: {
      id: nextProbeId('net.delay'),
      kind: 'net.delay',
      perturbing: true,
      live: true,
      startedAt: Date.now(),
      stoppedAt: null,
      stoppedReason: null,
      expiresAt,
      spec: {
        urlPattern: String(urlPattern),
        urlPatternKind: typeof urlPattern === 'string' ? 'substring' : 'regexp',
        // The glob actually sent to Fetch.enable, so a caller can see what Chrome was
        // asked to intercept rather than inferring it from the substring.
        fetchGlob,
        ms,
        ttlMs,
        unbounded: ttlMs <= 0,
        tookOverFrom: conflict?.info.id ?? null,
      },
    },
    owner: cdp,
    stats,
    doStop: async () => {
      stopped = true
      cdp.off('Fetch.requestPaused', handler)
      try {
        await cdp.send('Fetch.disable')
      } catch {
        // interception already gone
      }
    },
  })

  if (expiresAt) {
    const entry = registry.get(id)!
    entry.timer = setTimeout(() => {
      void stopEntry(entry, 'ttl')
    }, ttlMs)
    // Never hold the process open for a debug interceptor.
    ;(entry.timer as any)?.unref?.()
  }

  return {
    id,
    stop: () => stopTraceProbe(id).then(() => undefined),
    stats,
    info: () => getTraceProbe(id),
  }
}

// ---------------------------------------------------------------------------
// fiberSnapshot / fiberDiff
// ---------------------------------------------------------------------------

/** One prop of an identity-capturing snapshot. `ref` is a page-side identity token. */
export interface IdentifiedProp {
  /** Stable while the reference is unchanged; 0 for primitives. */
  ref: number
  type: 'primitive' | 'function' | 'object' | 'array'
  /** Structural projection; functions render as `[fn name/arity]` (paired with `ref`). */
  value: unknown
  fnName?: string | null
  arity?: number
  fnSource?: string
}

export interface FiberIdentitySnapshot {
  identityCaptured: true
  componentName: string | null
  source: ReactComponentInfo['source']
  hierarchy: ReactComponentInfo['hierarchy']
  props: Record<string, IdentifiedProp>
  /** Every function reachable in props (bounded), by dotted path -> identity token. */
  fnRefs: Array<{ path: string; ref: number; name: string | null; arity: number }>
  caps: { maxKeys: number; maxDepth: number; keysOmitted: number; fnRefsOmitted: number }
  note: string
}

/** What `fiberDiff` can compare: a plain snapshot, an identity snapshot, or any
 *  object exposing `props` (live in-process objects included). */
export interface FiberDiffInput {
  componentName?: string | null
  hierarchy?: unknown
  props?: unknown
  identityCaptured?: boolean
  fnRefs?: Array<{ path: string; ref: number; name: string | null; arity: number }>
}

/**
 * Capture a React component's props/hierarchy for later diffing.
 *
 * With `identity: true` the snapshot additionally carries page-side identity
 * tokens for every object/function prop (and for nested functions, by path). That
 * is the ONLY way handler-identity churn is observable across the process
 * boundary: the default serialisation renders every function as the string
 * `[function]`, so two different arrows look identical to any comparison.
 */
export async function fiberSnapshot(opts: {
  locator: Locator | ElementHandle
  cdp: ICDPSession
  identity?: false
}): Promise<ReactComponentInfo | null>
export async function fiberSnapshot(opts: {
  locator: Locator | ElementHandle
  cdp: ICDPSession
  identity: true
  maxKeys?: number
  maxDepth?: number
}): Promise<FiberIdentitySnapshot | null>
export async function fiberSnapshot({
  locator,
  cdp,
  identity,
  maxKeys = 60,
  maxDepth = 3,
}: {
  locator: Locator | ElementHandle
  cdp: ICDPSession
  identity?: boolean
  maxKeys?: number
  maxDepth?: number
}): Promise<ReactComponentInfo | FiberIdentitySnapshot | null> {
  // Also loads bippy into the page, which the identity walk below relies on.
  const base = await getReactComponentInfo({ locator, cdp })
  if (!identity) return base
  if (!base) return null

  const walk = (el: any, arg: { maxKeys: number; maxDepth: number }) => {
    const g = globalThis as any
    const bippy = g.__bippy
    if (!bippy) return { ok: false as const, reason: 'bippy is not loaded in the page' }
    let fiber: any
    try {
      fiber = bippy.getFiberFromHostInstance(el)
    } catch {
      return { ok: false as const, reason: 'getFiberFromHostInstance threw' }
    }
    let composite: any = fiber
    let guard = 0
    while (composite && guard++ < 50) {
      try {
        if (bippy.isCompositeFiber(composite)) break
      } catch {
        /* keep climbing */
      }
      composite = composite.return
    }
    if (!composite) return { ok: false as const, reason: 'no composite fiber above this element' }

    const reg = (g.__playwriter_trace_ids = g.__playwriter_trace_ids || { next: 1, map: new WeakMap() })
    const idOf = (v: any): number => {
      let id = reg.map.get(v)
      if (!id) {
        id = reg.next++
        reg.map.set(v, id)
      }
      return id
    }

    const fnRefs: Array<{ path: string; ref: number; name: string | null; arity: number }> = []
    let fnRefsOmitted = 0
    const project = (v: any, depth: number, path: string, seen: any): unknown => {
      if (v === null) return null
      const t = typeof v
      if (t === 'string') return v.length > 300 ? v.slice(0, 300) + '…[truncated]' : v
      if (t === 'number' || t === 'boolean') return v
      if (t === 'undefined') return '[undefined]'
      if (t === 'bigint') return `${v.toString()}n`
      if (t === 'symbol') return '[symbol]'
      if (t === 'function') {
        if (fnRefs.length < 200) fnRefs.push({ path, ref: idOf(v), name: v.name || null, arity: v.length })
        else fnRefsOmitted++
        // `[fn …]`, NOT `[function …]`: the latter is the OPAQUE marker family
        // (a function whose content was never captured). This one is a projection
        // whose paired identity token IS captured, in `fnRefs`.
        return `[fn ${v.name || 'anonymous'}/${v.length}]`
      }
      if (t !== 'object') return `[${t}]`
      const tag = Object.prototype.toString.call(v)
      if (tag.includes('Element]') || tag === '[object Window]' || tag === '[object Document]') return '[dom-node]'
      if (seen.has(v)) return '[circular]'
      if (depth >= arg.maxDepth) return '[max-depth]'
      seen.add(v)
      let out: unknown
      if (Array.isArray(v)) {
        const items = v.slice(0, 20).map((x: any, i: number) => project(x, depth + 1, `${path}[${i}]`, seen))
        if (v.length > 20) items.push(`…[${v.length - 20} more]`)
        out = items
      } else if (tag === '[object Date]') {
        out = `[Date ${v.getTime()}]`
      } else if (tag === '[object RegExp]') {
        out = `[RegExp ${String(v)}]`
      } else if (tag === '[object Map]') {
        out = { '[Map size]': v.size }
      } else if (tag === '[object Set]') {
        out = { '[Set size]': v.size }
      } else {
        const o: Record<string, unknown> = {}
        const keys = Object.keys(v)
        for (const k of keys.slice(0, 20)) o[k] = project(v[k], depth + 1, `${path}.${k}`, seen)
        if (keys.length > 20) o['…'] = `[${keys.length - 20} more keys]`
        const ctor = v.constructor && v.constructor.name
        if (ctor && ctor !== 'Object') o['[class]'] = ctor
        out = o
      }
      seen.delete(v)
      return out
    }

    const props = composite.memoizedProps
    const result: Record<string, any> = {}
    let keysOmitted = 0
    if (props && typeof props === 'object') {
      const keys = Object.keys(props)
      for (const k of keys) {
        if (Object.keys(result).length >= arg.maxKeys) {
          keysOmitted++
          continue
        }
        const v = (props as any)[k]
        const t = typeof v
        if (t === 'function') {
          // Also indexed in fnRefs so the flat function list is complete; the diff
          // skips top-level paths there because they are compared per-key already.
          if (fnRefs.length < 200) fnRefs.push({ path: k, ref: idOf(v), name: v.name || null, arity: v.length })
          result[k] = {
            ref: idOf(v),
            type: 'function',
            value: `[fn ${v.name || 'anonymous'}/${v.length}]`,
            fnName: v.name || null,
            arity: v.length,
            fnSource: String(v).slice(0, 240),
          }
        } else if (v !== null && t === 'object') {
          result[k] = {
            ref: idOf(v),
            type: Array.isArray(v) ? 'array' : 'object',
            value: project(v, 0, k, new WeakSet()),
          }
        } else {
          result[k] = { ref: 0, type: 'primitive', value: project(v, 0, k, new WeakSet()) }
        }
      }
    }
    return { ok: true as const, props: result, fnRefs, keysOmitted, fnRefsOmitted }
  }

  const arg = { maxKeys, maxDepth }
  const walked =
    'page' in locator ? await locator.evaluate(walk as any, arg) : await locator.evaluate(walk as any, arg)
  const w = walked as
    | { ok: true; props: Record<string, IdentifiedProp>; fnRefs: FiberIdentitySnapshot['fnRefs']; keysOmitted: number; fnRefsOmitted: number }
    | { ok: false; reason: string }

  if (!w.ok) return null

  return {
    identityCaptured: true,
    componentName: base.componentName,
    source: base.source,
    hierarchy: base.hierarchy,
    props: w.props,
    fnRefs: w.fnRefs,
    caps: { maxKeys, maxDepth, keysOmitted: w.keysOmitted, fnRefsOmitted: w.fnRefsOmitted },
    note:
      'identity tokens (`ref`) are page-side and stable while the reference is unchanged: same ref = same object, ' +
      'different ref with an equal projection = a NEW reference for an equal value (the memoisation-defeating case)',
  }
}

export type PropChangeKind = 'changed-by-value' | 'changed-by-identity' | 'added' | 'removed' | 'unobservable'

export interface PropChange {
  key: string
  kind: PropChangeKind
  /** Compact, capped projections of the two values. */
  before?: string
  after?: string
  valueType?: string
  /** For functions: enough to tell WHICH handler churned. */
  fn?: { name: string | null; arity?: number; sameSource?: boolean; sourceExcerpt?: string }
  /** Why the comparison could not be made (`kind: 'unobservable'` only). */
  reason?: string
}

export interface FiberDiff {
  sameComponent: boolean
  /** Every non-unchanged prop, capped (see `caps`). */
  changes: PropChange[]
  unchangedKeys: string[]
  /** Deep-equal but a NEW reference: the props that defeat React.memo. */
  identityChangedKeys: string[]
  /** Props whose comparison could NOT be performed. Never "unchanged". */
  unobservableKeys: string[]
  changedHierarchyDepth: boolean
  caps: {
    maxDepth: number
    maxNodes: number
    maxKeys: number
    maxChanges: number
    nodesVisited: number
    hitCap: boolean
    changesOmitted: number
    notes: string[]
  }
  /** Derived convenience: changed = changed-by-value + changed-by-identity. */
  changedProps: string[]
  addedProps: string[]
  removedProps: string[]
}

// Markers the page-side serialiser emits in place of a real value. Two of these
// on both sides means the comparison is IMPOSSIBLE, not that nothing changed —
// which is precisely the false negative that hid handler churn.
const OPAQUE_MARKERS: Record<string, string> = {
  '[function]': 'both snapshots serialised this function to the string `[function]`, so reference identity is unobservable — re-capture with fiberSnapshot({ identity: true })',
  '[symbol]': 'symbols are serialised opaquely; identity is unobservable',
  '[dom-node]': 'DOM nodes are serialised opaquely; identity is unobservable',
  '[circular]': 'the serialiser cut a cycle here; the subtree was never captured',
  '[max-depth]': 'the serialiser hit its depth cap here; the subtree was never captured',
}

// `debugger.ts`'s `readRemoteObject` emits the same KIND of stand-in for values CDP
// could not send: `[function name]`, `[accessor]`, `[object Object]`, `[array
// Array(3)]`, `[map Map(2)]`, `[symbol Symbol(x)]`. Those are shape descriptions, not
// values — two equal markers do NOT mean two equal objects — so a locals/callframe
// value fed to fiberDiff must be unobservable, never silently equal. `[date …]`,
// `[regexp …]` and `[bigint …]` are deliberately EXCLUDED: their description is the
// value, so equal text really does mean equal value.
const OPAQUE_MARKER_PATTERN =
  /^\[(function|accessor|symbol|object|array|typedarray|map|set|weakmap|weakset|promise|proxy|iterator|generator|node|string|number)\b[^\]]*\]$/

function isOpaque(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (OPAQUE_MARKERS[v]) return OPAQUE_MARKERS[v]
  if (v.endsWith('…[truncated]')) return 'both values were truncated by the serialiser; the tails were never captured'
  if (/^…\[\d+ more\]$/.test(v)) return 'the serialiser dropped array items here; they were never captured'
  if (/^\[\d+ more keys\]$/.test(v)) return 'the serialiser dropped object keys here; they were never captured'
  const m = OPAQUE_MARKER_PATTERN.exec(v)
  if (m) {
    return (
      `both sides are the marker \`${v}\` — a stand-in the debugger/serialiser emits for a ${m[1]} whose content was ` +
      `never captured. Equal markers do not mean equal values, so this prop is unobservable; re-read it with ` +
      `evaluate({ expression }) or fiberSnapshot({ identity: true })`
    )
  }
  return null
}

function describeValue(v: unknown, maxLen = 120): string {
  let s: string
  if (typeof v === 'function') {
    s = `[function ${(v as any).name || 'anonymous'}/${(v as any).length}]`
  } else if (typeof v === 'bigint') {
    s = `${v}n`
  } else if (typeof v === 'symbol') {
    s = String(v)
  } else if (v === undefined) {
    s = 'undefined'
  } else {
    const seen = new WeakSet<object>()
    try {
      s = JSON.stringify(v, (_k, val) => {
        if (typeof val === 'function') return `[function ${val.name || 'anonymous'}/${val.length}]`
        if (typeof val === 'bigint') return `${val}n`
        if (val && typeof val === 'object') {
          // A cyclic props object must render, not throw.
          if (seen.has(val)) return '[circular]'
          seen.add(val)
          if (val instanceof Map) return { '[Map size]': val.size }
          if (val instanceof Set) return { '[Set size]': val.size }
        }
        return val
      }) as string
    } catch {
      s = String(v)
    }
  }
  if (s == null) s = String(v)
  return s.length > maxLen ? s.slice(0, maxLen) + `…(${s.length})` : s
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  if (t !== 'object') return t
  const ctor = (v as any).constructor
  return ctor && ctor.name ? ctor.name : 'object'
}

type Verdict = 'same-ref' | 'deep-equal' | 'different' | 'unknown'

interface CompareCtx {
  depth: number
  maxDepth: number
  maxNodes: number
  maxKeys: number
  nodes: { n: number }
  hitCap: { v: boolean }
  notes: string[]
  /** Why the most recent `unknown` verdict was unknown (shared, per top-level key). */
  unknownReason: { v: string | null }
  seen: Map<object, Set<object>>
}

// Record WHY a comparison came back unknown, so the prop-level report can quote the
// real cause instead of guessing from the note list.
function unknown(ctx: CompareCtx, reason: string): Verdict {
  ctx.unknownReason.v = reason
  ctx.notes.push(reason)
  return 'unknown'
}

function worst(a: Verdict, b: Verdict): Verdict {
  const rank: Record<Verdict, number> = { 'same-ref': 0, 'deep-equal': 1, unknown: 2, different: 3 }
  return rank[a] >= rank[b] ? a : b
}

/**
 * Structural comparison that keeps the distinction the whole diff hinges on:
 *   same-ref    — identical reference (or identical primitive)
 *   deep-equal  — equal content, DIFFERENT reference (defeats memoisation)
 *   different   — content differs
 *   unknown     — could not be compared (opaque marker, cap, unobservable object)
 *
 * Functions compare by reference; two different references with the same name /
 * arity / source are `deep-equal`, which is exactly the inline-arrow case. Cycles
 * are handled co-inductively (an already-paired pair is assumed equal). `unknown`
 * is never rounded down to `deep-equal`.
 */
function compareValues(a: unknown, b: unknown, ctx: CompareCtx): Verdict {
  if (ctx.nodes.n++ > ctx.maxNodes) {
    ctx.hitCap.v = true
    return unknown(ctx, `comparison stopped at the ${ctx.maxNodes}-node cap`)
  }
  if (Object.is(a, b)) {
    // Both sides may be the SAME opaque marker string: equal text, unknown truth.
    const opaque = isOpaque(a)
    if (opaque) return unknown(ctx, opaque)
    return 'same-ref'
  }
  const opaqueA = isOpaque(a)
  const opaqueB = isOpaque(b)
  if (opaqueA || opaqueB) return unknown(ctx, opaqueA ?? opaqueB!)

  const ta = typeof a
  const tb = typeof b
  if (ta !== tb) return 'different'

  if (ta === 'function') {
    const fa = a as any
    const fb = b as any
    if (fa.name !== fb.name || fa.length !== fb.length) return 'different'
    let sa: string
    let sb: string
    try {
      sa = String(fa)
      sb = String(fb)
    } catch {
      return unknown(ctx, 'the function source could not be read, so identity churn cannot be told from a real change')
    }
    return sa === sb ? 'deep-equal' : 'different'
  }

  if (a === null || b === null) return 'different'
  if (ta !== 'object') return 'different' // primitives that failed Object.is

  const oa = a as any
  const ob = b as any

  // Cycles: if this pair is already being compared, assume equal (co-induction).
  const paired = ctx.seen.get(oa)
  if (paired?.has(ob)) return 'deep-equal'
  if (paired) paired.add(ob)
  else ctx.seen.set(oa, new Set([ob]))

  if (ctx.depth >= ctx.maxDepth) {
    ctx.hitCap.v = true
    return unknown(ctx, `comparison stopped at the depth cap (${ctx.maxDepth})`)
  }

  const tagA = Object.prototype.toString.call(oa)
  const tagB = Object.prototype.toString.call(ob)
  if (tagA !== tagB) return 'different'

  const child: CompareCtx = { ...ctx, depth: ctx.depth + 1 }

  switch (tagA) {
    case '[object Date]':
      return Object.is(oa.getTime(), ob.getTime()) ? 'deep-equal' : 'different'
    case '[object RegExp]':
      return oa.source === ob.source && oa.flags === ob.flags ? 'deep-equal' : 'different'
    case '[object Error]':
      return oa.name === ob.name && oa.message === ob.message ? 'deep-equal' : 'different'
    case '[object Promise]':
    case '[object WeakMap]':
    case '[object WeakSet]':
      return unknown(ctx, `${tagA} contents cannot be read; only reference identity is knowable, and it changed`)
    case '[object Map]': {
      if (oa.size !== ob.size) return 'different'
      const ea = [...oa.entries()]
      const eb = [...ob.entries()]
      let v: Verdict = 'deep-equal'
      for (let i = 0; i < ea.length; i++) {
        v = worst(v, compareValues(ea[i][0], eb[i][0], child))
        v = worst(v, compareValues(ea[i][1], eb[i][1], child))
        if (v === 'different') return 'different'
      }
      return v === 'same-ref' ? 'deep-equal' : v
    }
    case '[object Set]': {
      if (oa.size !== ob.size) return 'different'
      const ea = [...oa.values()]
      const eb = [...ob.values()]
      let v: Verdict = 'deep-equal'
      for (let i = 0; i < ea.length; i++) {
        v = worst(v, compareValues(ea[i], eb[i], child))
        if (v === 'different') return 'different'
      }
      return v === 'same-ref' ? 'deep-equal' : v
    }
    default:
      break
  }

  if (typeof (oa as any).nodeType === 'number' && typeof (ob as any).nodeType === 'number') {
    return 'different' // distinct DOM nodes: reference is the only identity
  }

  if (ArrayBuffer.isView(oa) && ArrayBuffer.isView(ob)) {
    const ba = new Uint8Array(oa.buffer, oa.byteOffset, oa.byteLength)
    const bb = new Uint8Array(ob.buffer, ob.byteOffset, ob.byteLength)
    if (ba.length !== bb.length) return 'different'
    for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) return 'different'
    return 'deep-equal'
  }

  if (Array.isArray(oa)) {
    if (oa.length !== ob.length) return 'different'
    let v: Verdict = 'deep-equal'
    const limit = Math.min(oa.length, ctx.maxKeys)
    if (oa.length > ctx.maxKeys) {
      ctx.hitCap.v = true
      unknown(ctx, `only the first ${ctx.maxKeys} of ${oa.length} array items were compared`)
    }
    for (let i = 0; i < limit; i++) {
      v = worst(v, compareValues(oa[i], ob[i], child))
      if (v === 'different') return 'different'
    }
    if (oa.length > ctx.maxKeys) v = worst(v, 'unknown')
    return v === 'same-ref' ? 'deep-equal' : v
  }

  // Plain / class objects. A different constructor is a different value even when
  // the own properties happen to match.
  const ctorA = oa.constructor && oa.constructor.name
  const ctorB = ob.constructor && ob.constructor.name
  if (ctorA !== ctorB) return 'different'

  const keysA = Object.keys(oa)
  const keysB = Object.keys(ob)
  if (keysA.length !== keysB.length) return 'different'
  const keys = new Set([...keysA, ...keysB])
  if (keys.size !== keysA.length) return 'different' // same count, different names
  let v: Verdict = 'deep-equal'
  let seenKeys = 0
  for (const k of keys) {
    if (seenKeys++ >= ctx.maxKeys) {
      ctx.hitCap.v = true
      v = worst(v, unknown(ctx, `only the first ${ctx.maxKeys} of ${keys.size} keys were compared`))
      break
    }
    // `undefined` vs missing was already excluded by the key-set check above.
    v = worst(v, compareValues(oa[k], ob[k], child))
    if (v === 'different') return 'different'
  }
  return v === 'same-ref' ? 'deep-equal' : v
}

function propsOf(x: FiberDiffInput | null, notes: string[], side: string): Record<string, unknown> {
  const p = x?.props
  if (p === undefined || p === null) return {}
  if (typeof p !== 'object' || Array.isArray(p)) {
    notes.push(`${side} snapshot's props is a ${typeName(p)}, not an object; treated as empty`)
    return {}
  }
  return p as Record<string, unknown>
}

/**
 * Diff two `fiberSnapshot` results per prop: unchanged / changed-by-value /
 * changed-by-identity / added / removed / unobservable.
 *
 * `changed-by-identity` is the answer to "why does my memoised child re-render":
 * the value is deep-equal but arrived with a new reference — a fresh inline arrow,
 * a rebuilt object literal, a `.map()` result. It used to be invisible because
 * props were compared with `JSON.stringify`, which makes every function (and every
 * Date, Map, Set and class instance) compare equal.
 *
 * `unobservable` is the other half of the honesty: when a value was serialised to
 * an opaque marker, or a cap cut the walk short, the prop is reported as
 * unobservable — never as unchanged. Pure — no browser.
 */
export function fiberDiff(
  a: FiberDiffInput | null,
  b: FiberDiffInput | null,
  opts?: { maxDepth?: number; maxNodes?: number; maxKeys?: number; maxChanges?: number },
): FiberDiff {
  const maxDepth = opts?.maxDepth ?? 8
  const maxNodes = opts?.maxNodes ?? 5000
  const maxKeys = opts?.maxKeys ?? 100
  const maxChanges = opts?.maxChanges ?? 60

  const notes: string[] = []
  const propsA = propsOf(a, notes, 'before')
  const propsB = propsOf(b, notes, 'after')
  const identityMode = a?.identityCaptured === true && b?.identityCaptured === true
  if ((a?.identityCaptured === true) !== (b?.identityCaptured === true) && (a || b)) {
    notes.push('only one side was captured with identity tokens; falling back to structural comparison')
  }

  const nodes = { n: 0 }
  const hitCap = { v: false }
  // One reason cell per top-level key, so the reported reason is that key's own.
  let unknownReason = { v: null as string | null }
  const mkCtx = (): CompareCtx => {
    unknownReason = { v: null }
    return { depth: 0, maxDepth, maxNodes, maxKeys, nodes, hitCap, notes, unknownReason, seen: new Map() }
  }

  const changes: PropChange[] = []
  const unchangedKeys: string[] = []
  const keysA = Object.keys(propsA)
  const keysB = Object.keys(propsB)
  const setA = new Set(keysA)
  const setB = new Set(keysB)

  // Count every change we WANTED to report, so the omission count is exact even
  // for the nested-function changes appended after the key walk.
  let attemptedChanges = 0
  const pushChange = (c: PropChange) => {
    attemptedChanges++
    if (changes.length < maxChanges) changes.push(c)
  }

  for (const k of keysB) {
    if (!setA.has(k)) {
      pushChange({ key: k, kind: 'added', after: describeValue(unwrap(propsB[k], identityMode)), valueType: typeName(unwrap(propsB[k], identityMode)) })
      continue
    }
    const rawA = propsA[k]
    const rawB = propsB[k]

    if (identityMode) {
      const ia = rawA as IdentifiedProp
      const ib = rawB as IdentifiedProp
      if (ia.ref !== 0 && ia.ref === ib.ref) {
        unchangedKeys.push(k)
        continue
      }
      // Functions are settled by the identity token plus the captured source: they
      // must never route through the opaque-marker path, which exists for values
      // whose content was NOT captured. Here it was.
      if (ia.type === 'function' || ib.type === 'function') {
        const sameShape =
          ia.type === ib.type && ia.fnName === ib.fnName && ia.arity === ib.arity && ia.fnSource === ib.fnSource
        pushChange({
          key: k,
          kind: sameShape ? 'changed-by-identity' : 'changed-by-value',
          before: describeValue(ia.value),
          after: describeValue(ib.value),
          valueType: ib.type,
          fn: {
            name: ib.fnName ?? ia.fnName ?? null,
            arity: ib.arity ?? ia.arity,
            sameSource: ia.fnSource !== undefined && ib.fnSource !== undefined ? ia.fnSource === ib.fnSource : undefined,
            sourceExcerpt: ib.fnSource,
          },
        })
        continue
      }
      const verdict = compareValues(ia.value, ib.value, mkCtx())
      if (verdict === 'same-ref' && ia.type === 'primitive') {
        unchangedKeys.push(k)
        continue
      }
      if (verdict === 'unknown') {
        pushChange({
          key: k,
          kind: 'unobservable',
          before: describeValue(ia.value),
          after: describeValue(ib.value),
          valueType: ia.type,
          reason: unknownReason.v ?? 'the projected values could not be compared',
        })
        continue
      }
      // Functions already returned above, so this is an object/array/primitive.
      const identical = verdict === 'same-ref' || verdict === 'deep-equal'
      pushChange({
        key: k,
        kind: identical ? 'changed-by-identity' : 'changed-by-value',
        before: describeValue(ia.value),
        after: describeValue(ib.value),
        valueType: ib.type,
      })
      continue
    }

    const verdict = compareValues(rawA, rawB, mkCtx())
    if (verdict === 'same-ref') {
      unchangedKeys.push(k)
      continue
    }
    if (verdict === 'unknown') {
      pushChange({
        key: k,
        kind: 'unobservable',
        before: describeValue(rawA),
        after: describeValue(rawB),
        valueType: typeName(rawB),
        reason: unknownReason.v ?? 'the values could not be compared',
      })
      continue
    }
    pushChange({
      key: k,
      kind: verdict === 'deep-equal' ? 'changed-by-identity' : 'changed-by-value',
      before: describeValue(rawA),
      after: describeValue(rawB),
      valueType: typeName(rawB),
      fn:
        typeof rawA === 'function' || typeof rawB === 'function'
          ? {
              name: (rawB as any)?.name ?? (rawA as any)?.name ?? null,
              arity: (rawB as any)?.length ?? (rawA as any)?.length,
              sameSource: typeof rawA === 'function' && typeof rawB === 'function' ? String(rawA) === String(rawB) : undefined,
              sourceExcerpt: typeof rawB === 'function' ? String(rawB).slice(0, 240) : undefined,
            }
          : undefined,
    })
  }

  for (const k of keysA) {
    if (!setB.has(k)) {
      pushChange({ key: k, kind: 'removed', before: describeValue(unwrap(propsA[k], identityMode)), valueType: typeName(unwrap(propsA[k], identityMode)) })
    }
  }

  // Nested function identity: only an identity snapshot can see it, and it is
  // reported by dotted path so `onRow` inside `rows[0]` is nameable.
  if (identityMode && a?.fnRefs && b?.fnRefs) {
    const byPathA = new Map(a.fnRefs.map((r) => [r.path, r]))
    for (const rb of b.fnRefs) {
      const ra = byPathA.get(rb.path)
      if (!ra || ra.path.indexOf('.') === -1 && ra.path.indexOf('[') === -1) continue // top-level handled above
      if (ra.ref !== rb.ref && ra.name === rb.name && ra.arity === rb.arity) {
        pushChange({
          key: rb.path,
          kind: 'changed-by-identity',
          valueType: 'function',
          before: `[function ${ra.name ?? 'anonymous'}/${ra.arity} #${ra.ref}]`,
          after: `[function ${rb.name ?? 'anonymous'}/${rb.arity} #${rb.ref}]`,
          fn: { name: rb.name, arity: rb.arity },
        })
      }
    }
  }

  const changesOmitted = attemptedChanges - changes.length
  if (changesOmitted > 0) notes.push(`${changesOmitted} further change(s) omitted by the ${maxChanges}-change output cap`)

  const identityChangedKeys = changes.filter((c) => c.kind === 'changed-by-identity').map((c) => c.key)
  const unobservableKeys = changes.filter((c) => c.kind === 'unobservable').map((c) => c.key)
  const hierA = Array.isArray(a?.hierarchy) ? (a!.hierarchy as unknown[]).length : 0
  const hierB = Array.isArray(b?.hierarchy) ? (b!.hierarchy as unknown[]).length : 0

  return {
    sameComponent: (a?.componentName ?? null) === (b?.componentName ?? null),
    changes,
    unchangedKeys,
    identityChangedKeys,
    unobservableKeys,
    changedHierarchyDepth: hierA !== hierB,
    caps: {
      maxDepth,
      maxNodes,
      maxKeys,
      maxChanges,
      nodesVisited: nodes.n,
      hitCap: hitCap.v,
      changesOmitted,
      notes: [...new Set(notes)],
    },
    changedProps: changes.filter((c) => c.kind === 'changed-by-value' || c.kind === 'changed-by-identity').map((c) => c.key),
    addedProps: changes.filter((c) => c.kind === 'added').map((c) => c.key),
    removedProps: changes.filter((c) => c.kind === 'removed').map((c) => c.key),
  }
}

function unwrap(v: unknown, identityMode: boolean): unknown {
  return identityMode && v && typeof v === 'object' && 'ref' in (v as any) ? (v as IdentifiedProp).value : v
}

// ---------------------------------------------------------------------------
// replayPure
// ---------------------------------------------------------------------------

export interface CapturedLog {
  level: string
  args: unknown[]
  ts: number
}

export type OffendingCategory =
  | 'logging'
  | 'network'
  | 'storage'
  | 'dom'
  | 'timers'
  | 'process-or-module'
  | 'closure-or-import'

export interface OffendingIdentifier {
  name: string
  line: number | null
  column: number | null
  category: OffendingCategory
  /** Whether it can legitimately be admitted via `allow` / `bindings`. */
  admissible: boolean
  why: string
}

const REPLAY_SCOPE_NOTE =
  'replayPure runs the function with `new Function` in the NODE EXECUTOR PROCESS. It cannot observe the page: ' +
  'there is no window, no document, no DOM, no page network and no page globals here. Anything the function needs ' +
  'from the page must be passed in via `args` / `bindings`. `console` is virtualised and its calls are returned in `logs`.'

export interface ReplayOk {
  ok: true
  value: unknown
  /** Everything the function logged, in order. Logging is virtualised, not permitted. */
  logs: CapturedLog[]
  logsDropped: number
  logsCapped: boolean
  /** Names admitted into scope for this run (`console` + `bindings` + `allow`). */
  allowed: string[]
  evaluatedIn: 'node-executor-process'
  note: string
}

export interface ReplayRefused {
  ok: false
  stage: 'parse' | 'purity' | 'execution'
  reason: string
  /** Kept for compatibility: the offending names only. */
  freeIdentifiers: string[]
  /** Every offending free identifier WITH its source position and verdict. */
  offending: OffendingIdentifier[]
  /** Offenders that `allow` (plus a matching `bindings` value) can admit. */
  admissible: string[]
  /** Offenders that can never be admitted — nothing in this process can supply them. */
  categoricallyUnsafe: string[]
  logs?: CapturedLog[]
  evaluatedIn: 'node-executor-process'
  note: string
}

export type ReplayResult = ReplayOk | ReplayRefused

// Reaching outside the process. No `allow` entry can make these honest, because
// this process has no page to reach into: admitting them would make the replay
// silently diverge from the runtime being debugged.
const UNSAFE_IDENTIFIERS: Record<string, { category: OffendingCategory; why: string }> = {
  fetch: { category: 'network', why: 'network access — the executor process is not the page; a replayed fetch would hit a different origin (or nothing)' },
  XMLHttpRequest: { category: 'network', why: 'network access — not available and not equivalent here' },
  WebSocket: { category: 'network', why: 'network access — not available and not equivalent here' },
  EventSource: { category: 'network', why: 'network access — not available and not equivalent here' },
  navigator: { category: 'network', why: 'ambient browser state that does not exist in this process' },
  localStorage: { category: 'storage', why: 'page storage does not exist in this process' },
  sessionStorage: { category: 'storage', why: 'page storage does not exist in this process' },
  indexedDB: { category: 'storage', why: 'page storage does not exist in this process' },
  caches: { category: 'storage', why: 'page storage does not exist in this process' },
  cookieStore: { category: 'storage', why: 'page storage does not exist in this process' },
  window: { category: 'dom', why: 'the page realm does not exist here; reading it would silently diverge' },
  document: { category: 'dom', why: 'the DOM does not exist here; reading it would silently diverge' },
  self: { category: 'dom', why: 'the page realm does not exist here' },
  top: { category: 'dom', why: 'the page realm does not exist here' },
  parent: { category: 'dom', why: 'the page realm does not exist here' },
  getComputedStyle: { category: 'dom', why: 'the DOM does not exist here' },
  setTimeout: { category: 'timers', why: 'timers change ordering; a replay must be a pure function of its inputs' },
  setInterval: { category: 'timers', why: 'timers change ordering; a replay must be a pure function of its inputs' },
  setImmediate: { category: 'timers', why: 'timers change ordering; a replay must be a pure function of its inputs' },
  queueMicrotask: { category: 'timers', why: 'defers work past the return value; the result would be incomplete' },
  requestAnimationFrame: { category: 'timers', why: 'there are no frames in this process' },
  process: { category: 'process-or-module', why: 'executor-process state, unrelated to the page under test' },
  require: { category: 'process-or-module', why: 'module loading in the executor is not the page module graph' },
  module: { category: 'process-or-module', why: 'module scope of the executor, not the page' },
  exports: { category: 'process-or-module', why: 'module scope of the executor, not the page' },
  __dirname: { category: 'process-or-module', why: 'executor filesystem context, not the page' },
  __filename: { category: 'process-or-module', why: 'executor filesystem context, not the page' },
}

function classifyIdentifier(name: string): { category: OffendingCategory; admissible: boolean; why: string } {
  if (name === 'console') {
    return { category: 'logging', admissible: true, why: 'logging is observable-only; it is virtualised automatically and returned in `logs`' }
  }
  const unsafe = UNSAFE_IDENTIFIERS[name]
  if (unsafe) return { ...unsafe, admissible: false }
  return {
    category: 'closure-or-import',
    admissible: true,
    why: 'a closure capture or an imported binding: supply its value with `bindings: { ' + name + ': … }` (which also admits it)',
  }
}

interface ParsedTarget {
  ok: boolean
  reason?: string
  kind?: string
}

/**
 * The purity gate parses `(${src})` with error recovery, so a STATEMENT does not
 * throw — it just yields nonsense. Reject it here, up front, with the parse errors.
 */
function parseReplayTarget(src: string): ParsedTarget {
  let ast: ReturnType<typeof parseModule>
  try {
    ast = parseModule(`(${src.trim()})`, 'replay.tsx')
  } catch (e) {
    return {
      ok: false,
      reason:
        `not a function EXPRESSION — \`(${'<src>'})\` does not parse: ${(e as Error).message}. ` +
        'replayPure needs a single function expression, e.g. `(a, b) => a + b` or `function f(a) { return a }`; ' +
        'a statement or declaration (`const x = …`, `if (…) …`) cannot be replayed — wrap the body in an arrow.',
    }
  }
  const errors = (ast as any).errors as Array<{ reasonCode?: string; message?: string; loc?: { line: number; column: number } }> | undefined
  if (errors && errors.length > 0) {
    const first = errors[0]
    return {
      ok: false,
      reason: `not a function expression — the source does not parse cleanly (${first.message ?? first.reasonCode ?? 'syntax error'}${
        first.loc ? ` at ${first.loc.line}:${first.loc.column}` : ''
      }). replayPure needs a single function EXPRESSION, e.g. \`(a, b) => a + b\` or \`function f(a) { return a }\`; a statement or declaration list cannot be replayed.`,
    }
  }
  const body = (ast as any).program?.body ?? []
  if (body.length !== 1 || body[0].type !== 'ExpressionStatement') {
    return { ok: false, reason: `expected a single expression, parsed ${body.length} statement(s) [${body.map((s: any) => s.type).join(', ')}]` }
  }
  const expr = body[0].expression
  const kind = expr?.type
  if (kind !== 'ArrowFunctionExpression' && kind !== 'FunctionExpression') {
    return {
      ok: false,
      reason: `expected a function expression, got ${kind}. replayPure evaluates \`(${'<src>'})\` and calls the result; wrap the body in an arrow if you sliced a statement.`,
    }
  }
  return { ok: true, kind }
}

/**
 * Positions for free identifiers. `isPureFunctionSource` (the single source of
 * truth for the whitelist) reports names only, so the loc scan is repeated here
 * over the same wrapped source. Column 1 on line 1 is the wrapper's `(`.
 */
function freeIdentifierLocs(src: string, allowed: Set<string>): Map<string, { line: number; column: number }> {
  const out = new Map<string, { line: number; column: number }>()
  let ast: ReturnType<typeof parseModule>
  try {
    ast = parseModule(`(${src.trim()})`, 'replay.tsx')
  } catch {
    return out
  }
  traverse(ast as any, {
    ReferencedIdentifier(p: NodePath) {
      const name = (p.node as any).name as string
      if (allowed.has(name)) return
      if (p.scope.getBinding(name)) return
      if (out.has(name)) return
      const loc = (p.node as any).loc?.start
      out.set(name, loc ? { line: loc.line, column: loc.line === 1 ? Math.max(0, loc.column - 1) : loc.column } : { line: 0, column: 0 })
    },
  })
  return out
}

const REPLAY_MAX_LOGS = 200

function makeCapturingConsole(maxLogs: number): { console: Record<string, (...a: unknown[]) => void>; logs: CapturedLog[]; dropped: () => number } {
  const logs: CapturedLog[] = []
  let dropped = 0
  const record = (level: string) => (...args: unknown[]) => {
    if (logs.length >= maxLogs) {
      dropped++
      return
    }
    logs.push({
      level,
      args: args.map((a) => (typeof a === 'string' ? (a.length > 400 ? a.slice(0, 400) + `…(${a.length})` : a) : JSON.parse(describeValueSafe(a)))),
      ts: Date.now(),
    })
  }
  const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'group', 'groupEnd', 'groupCollapsed', 'count', 'time', 'timeEnd', 'assert']
  const c: Record<string, (...a: unknown[]) => void> = {}
  for (const l of levels) c[l] = record(l)
  return { console: c, logs, dropped: () => dropped }
}

// Keep captured log arguments structurally intact but JSON-safe (cycles, functions).
function describeValueSafe(v: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      v,
      (_k, val) => {
        if (typeof val === 'function') return `[function ${val.name || 'anonymous'}/${val.length}]`
        if (typeof val === 'bigint') return `${val}n`
        if (typeof val === 'undefined') return '[undefined]'
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[circular]'
          seen.add(val)
          if (val instanceof Map) return { '[Map size]': val.size }
          if (val instanceof Set) return { '[Set size]': val.size }
        }
        return val
      },
    ) ?? '"[undefined]"'
  } catch {
    return JSON.stringify(String(v))
  }
}

function runReplay(
  {
    fn,
    args,
    allow,
    bindings,
    maxLogs = REPLAY_MAX_LOGS,
  }: {
    fn: string | ((...a: any[]) => unknown)
    args?: unknown[]
    allow?: string[]
    bindings?: Record<string, unknown>
    maxLogs?: number
  },
  awaitResult: boolean,
): ReplayResult | Promise<ReplayResult> {
  const src = typeof fn === 'string' ? fn : fn.toString()
  const bindingNames = Object.keys(bindings ?? {})

  const refuse = (stage: ReplayRefused['stage'], reason: string, offending: OffendingIdentifier[] = [], logs?: CapturedLog[]): ReplayRefused => ({
    ok: false,
    stage,
    reason,
    freeIdentifiers: offending.map((o) => o.name),
    offending,
    admissible: offending.filter((o) => o.admissible).map((o) => o.name),
    categoricallyUnsafe: offending.filter((o) => !o.admissible).map((o) => o.name),
    logs,
    evaluatedIn: 'node-executor-process',
    note: REPLAY_SCOPE_NOTE,
  })

  const parsed = parseReplayTarget(src)
  if (!parsed.ok) return refuse('parse', parsed.reason!)

  // A caller cannot widen the gate to something this process is unable to honour.
  const badAllow = (allow ?? []).filter((n) => UNSAFE_IDENTIFIERS[n])
  if (badAllow.length > 0) {
    return refuse(
      'purity',
      `\`allow\` cannot admit ${badAllow.join(', ')}: ` +
        badAllow.map((n) => `${n} — ${UNSAFE_IDENTIFIERS[n].why}`).join('; ') +
        `. Pass the value the function needs via \`bindings\` instead of opening the real surface.`,
      badAllow.map((n) => ({ name: n, line: null, column: null, ...UNSAFE_IDENTIFIERS[n], admissible: false })),
    )
  }

  // `console` is admitted ALWAYS, because it is virtualised below: a logging
  // function is replayable without weakening the gate on anything that can reach
  // outside the process.
  const allowList = ['console', ...bindingNames, ...(allow ?? [])]
  const purity = isPureFunctionSource(src, { allow: allowList })
  if (!purity.pure) {
    const locs = freeIdentifierLocs(src, new Set(allowList))
    const offending: OffendingIdentifier[] = purity.freeIdentifiers.map((name) => {
      const loc = locs.get(name)
      const cls = classifyIdentifier(name)
      return { name, line: loc?.line ?? null, column: loc?.column ?? null, ...cls }
    })
    const admissible = offending.filter((o) => o.admissible)
    const unsafe = offending.filter((o) => !o.admissible)
    const at = (o: OffendingIdentifier) => (o.line ? `${o.name} @${o.line}:${o.column}` : o.name)
    return refuse(
      'purity',
      `not replayable: references free identifier(s) ${offending.map(at).join(', ')}. ` +
        (unsafe.length
          ? `CATEGORICALLY UNSAFE (never admissible): ${unsafe.map((o) => `${o.name} (${o.category}: ${o.why})`).join('; ')}. `
          : '') +
        (admissible.length
          ? `Admissible via bindings/allow: ${admissible.map((o) => o.name).join(', ')} — e.g. bindings: { ${admissible[0].name}: … }.`
          : ''),
      offending,
    )
  }

  const cap = makeCapturingConsole(maxLogs)
  const finish = (value: unknown): ReplayOk => ({
    ok: true,
    value,
    logs: cap.logs,
    logsDropped: cap.dropped(),
    logsCapped: cap.dropped() > 0,
    allowed: allowList,
    evaluatedIn: 'node-executor-process',
    note: REPLAY_SCOPE_NOTE,
  })

  let value: unknown
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function('console', ...bindingNames, `return (${src})`)
    const f = factory(cap.console, ...bindingNames.map((n) => (bindings as any)[n])) as (...a: any[]) => unknown
    value = f(...(args ?? []))
  } catch (e) {
    return refuse('execution', `replay threw: ${(e as Error).message}`, [], cap.logs)
  }

  const thenable = value && typeof (value as any).then === 'function'
  if (thenable) {
    if (!awaitResult) {
      return refuse(
        'execution',
        'the function returned a Promise and replayPure is synchronous, so the value is not observable here. Use replayPureAsync({ … }) to await it.',
        [],
        cap.logs,
      )
    }
    return (value as Promise<unknown>).then(
      (v) => finish(v),
      (e) => refuse('execution', `replay rejected: ${(e as Error)?.message ?? String(e)}`, [], cap.logs),
    )
  }
  return finish(value)
}

/**
 * Verify the sliced function is PURE (only params/locals + a safe-globals
 * whitelist — reusing the @babel/parser scope analysis in `isPureFunctionSource`)
 * and, only then, execute its source with the captured `args`.
 *
 * WHERE THIS RUNS: `new Function` in the NODE EXECUTOR PROCESS — never in the
 * page. It can therefore observe NOTHING about page state; every result carries
 * `evaluatedIn: 'node-executor-process'` and a `note` saying so.
 *
 * `console` is not a hole in the gate: it is VIRTUALISED. A function containing
 * `console.log` replays and its calls come back in `logs`, so real sliced code
 * (which logs) is replayable without weakening the purity guarantee on anything
 * that can actually reach outside — network, storage, DOM, timers, imports. Those
 * are refused even when a caller asks for them via `allow`.
 *
 * Refusals name every offending identifier WITH its source position, and split
 * them into `admissible` (a closure capture or import: pass it in `bindings`) and
 * `categoricallyUnsafe` (nothing in this process can supply it honestly).
 */
export function replayPure(opts: {
  fn: string | ((...a: any[]) => unknown)
  args?: unknown[]
  allow?: string[]
  /** Values for captured/imported identifiers; each name is admitted and injected. */
  bindings?: Record<string, unknown>
  maxLogs?: number
}): ReplayResult {
  return runReplay(opts, false) as ReplayResult
}

/** As `replayPure`, but awaits a returned Promise (an async sliced function). */
export async function replayPureAsync(opts: {
  fn: string | ((...a: any[]) => unknown)
  args?: unknown[]
  allow?: string[]
  bindings?: Record<string, unknown>
  maxLogs?: number
}): Promise<ReplayResult> {
  return runReplay(opts, true)
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
  /** The leaf is not a runtime blind spot: the remedy is static (budget, cycle, parse). */
  | 'static-remedy'
  /** This build has no entry for the leaf's `blockedBy`. Refuses to run. */
  | 'unknown-blind-spot'

export interface RuntimeProbe {
  type: ProbeType
  /** True for observation-only probes safe to auto-run; false for perturbing/pausing. */
  passive: boolean
  /** Always false: no probe armed here uses a pausing breakpoint. */
  pausing: false
  /** True when the hypothesis is about ORDERING — capture must not reorder timers. */
  raceClass: boolean
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

export interface RenderOptions {
  /** Hard line budget (default 60). The collapse is always announced in the output. */
  maxLines?: number
  /** Include the blocked leaves' code frames (default true). */
  codeFrames?: boolean
}

/**
 * A hop plus a BOUNDED slice of its subtree, cycle-free and JSON-safe. Carries the
 * hop's own fields inline (so it reads like a TraceHop) plus the accounting for
 * what the depth/node caps left out.
 */
export interface TraceSubtree extends Omit<TraceHop, 'children'> {
  id: string
  children: TraceSubtree[]
  /** Children NOT included because of the depth/node cap. 0 means none were cut. */
  omittedChildren: number
  /** True when this node and everything under it is present. */
  complete: boolean
}

export interface TraceResult {
  /**
   * Token-bounded summary. A METHOD, not a precomputed string: rendering is cheap
   * only when it is asked for, and options (`maxLines`, `codeFrames`) belong to the
   * caller, not to the trace. The sandbox exposes it as a function too.
   */
  render(opts?: RenderOptions): string
  tree: TraceHop
  blocked: BlockedLeaf[]
  anchor: AnchorInfo | null
  /** Bounded subtree in ONE call. `depth` defaults to 1 (this hop + its children). */
  expand(hopId: string, opts?: { depth?: number; maxNodes?: number }): TraceSubtree | null
  /** Every hop id, so a caller can address a hop without walking the tree. */
  hopIds: string[]
  /** Live perturbing probes and unhandled blind spots — surfaced, never implicit. */
  warnings: string[]
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
  const warnings: string[] = [...tracePerturbationWarnings()]

  const walk = (hop: TraceHop, id: string): void => {
    idByHop.set(hop, id)
    hopById.set(id, hop)
    if (hop.blockedBy) {
      const probe = armProbe(hop, deps)
      blocked.push({
        id,
        blockedBy: hop.blockedBy,
        site: hop.site,
        hazards: hop.hazards,
        note: hop.note,
        codeFrame: hop.codeFrame,
        probe,
      })
      if (probe?.type === 'unknown-blind-spot') {
        warnings.push(
          `hop ${id} is blocked by \`${String(hop.blockedBy)}\`, which this build's blind-spot -> probe table does not ` +
            `handle. No probe was guessed: running it throws rather than reporting a plausible-looking result.`,
        )
      }
    }
    const children = hop.children ?? []
    children.forEach((child, i) => walk(child, `${id}.${i}`))
  }
  walk(tree, '0')

  const render = (opts?: RenderOptions): string => {
    const maxLines = opts?.maxLines ?? RENDER_MAX_LINES
    const codeFrames = opts?.codeFrames ?? true
    const lines: string[] = []
    if (anchor) {
      const where = anchor.file ? `${anchor.file}${anchor.line != null ? ':' + anchor.line : ''}` : '(no source)'
      lines.push(`anchor: <${anchor.componentName ?? '?'}> slot=${anchor.slot ?? '?'} @ ${where}`)
    }
    renderHop(tree, 0, lines, idByHop, codeFrames)
    for (const w of warnings) lines.push(`! ${w}`)
    if (lines.length > maxLines) {
      const kept = lines.slice(0, Math.max(1, maxLines - 1))
      kept.push(`… (${lines.length - kept.length} more lines collapsed; use expand(hopId, { depth }) or render({ maxLines }))`)
      return kept.join('\n')
    }
    return lines.join('\n')
  }

  const expand = (hopId: string, opts?: { depth?: number; maxNodes?: number }): TraceSubtree | null => {
    const hop = hopById.get(hopId)
    if (!hop) return null
    const depth = Math.max(0, opts?.depth ?? 1)
    const maxNodes = opts?.maxNodes ?? 200
    let nodes = 0

    const build = (h: TraceHop, id: string, d: number): TraceSubtree => {
      nodes++
      const { children: kids, ...rest } = h
      const childHops = kids ?? []
      const out: TraceSubtree[] = []
      if (d > 0) {
        for (let i = 0; i < childHops.length; i++) {
          if (nodes >= maxNodes) break
          out.push(build(childHops[i], `${id}.${i}`, d - 1))
        }
      }
      const omittedChildren = childHops.length - out.length
      return {
        ...rest,
        id,
        children: out,
        omittedChildren,
        complete: omittedChildren === 0 && out.every((c) => c.complete),
      }
    }
    return build(hop, hopId, depth)
  }

  return { render, tree, blocked, anchor, expand, hopIds: [...hopById.keys()], warnings }
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

function renderHop(hop: TraceHop, depth: number, lines: string[], idByHop: WeakMap<TraceHop, string>, codeFrames: boolean): void {
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
  if (codeFrames && hop.blockedBy && hop.codeFrame) {
    for (const frameLine of hop.codeFrame.split('\n')) {
      lines.push(`${indent}  | ${frameLine}`)
    }
  }

  for (const child of hop.children ?? []) {
    renderHop(child, depth + 1, lines, idByHop, codeFrames)
  }
}

// --- Blind-spot -> probe table ---------------------------------------------

/** The `blockedBy` variants this table handles. A variant NOT in here gets the
 *  `unknown-blind-spot` probe, never a plausible-looking substitute. */
export const HANDLED_BLOCKED_REASONS = [
  'mutation',
  'interprocedural',
  'async',
  'unresolved-module',
  'dynamic',
  'budget-hops',
  'cycle',
  'parse-error',
] as const

/**
 * The heart of M4: map a blocked leaf's `blockedBy` reason (+ hazards) to a
 * pre-built, non-executed runtime probe.
 *
 *   mutation          -> storeIdentity (+ hazard sites for write-logpoints)
 *   interprocedural   -> captureArgsAt (entry logpoint on the arg's function)
 *   async             -> netTimeline (passive) first, netDelay to force the race
 *   unresolved-module -> runtime-only: listScripts + getScriptSourceByUrl
 *   dynamic           -> runtime-only: a value logpoint at the site
 *
 * The switch is deliberately NOT defaulting to the logpoint probe: `BlockedReason`
 * grows (hop-budget exhaustion, new async-boundary classes), and a new variant
 * silently landing in the `dynamic` branch would arm a probe for the wrong
 * hypothesis and read as a real answer. Unhandled variants get a probe that
 * refuses to run and says which variant it did not understand.
 */
function armProbe(hop: TraceHop, deps: TraceDeps): RuntimeProbe | null {
  switch (hop.blockedBy) {
    case null:
    case undefined:
      return null

    case 'mutation':
      return {
        type: 'storeIdentity',
        passive: false,
        pausing: false,
        raceClass: false,
        spec: {
          hazardSites: hop.hazards.map((h) => h.loc),
          note: 'capture store-state ref, run the action, re-capture; sameReference=true proves an in-place mutation',
          alsoConsider: 'write-logpoints at the hazard sites',
          resultShape: 'discriminated union: read `measured` first — a `measured:false` result carries no verdict',
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
        pausing: false,
        raceClass: false,
        spec: { fn, file, site: hop.site, note: 'arm an entry LOGPOINT (never a pausing breakpoint) on the function; drain args from the log stream' },
        run: async () => {
          if (!deps.dbg) throw new Error('captureArgs probe needs deps { dbg }')
          if (!file || !fn) throw new Error('captureArgs probe could not recover function name/file from the slice')
          const dbg = deps.dbg
          return dbg.runNonPausingOnly(() => dbg.captureArgsAt({ file, fn }), {
            reason: 'captureArgs probe: a pause here changes the very call ordering being captured',
          })
        },
      }
    }

    case 'async':
      return {
        type: 'netTimeline',
        passive: true,
        pausing: false,
        raceClass: true,
        spec: {
          site: hop.site,
          urlPattern: deps.urlPattern ?? null,
          note:
            'passively record request/response order first; use netDelay to force the race deterministically. ' +
            'RACE-CLASS: pausing capture is refused for this probe — a pause reorders timers on resume and destroys the hypothesis.',
          lifetime: 'the controller is registered session-wide: net.active() lists it, net.read(id) drains it later',
        },
        run: async () => {
          if (!deps.page) throw new Error('netTimeline probe needs deps { page }')
          const start = async () => {
            const controller = netTimeline({ page: deps.page!, urlPattern: deps.urlPattern })
            return {
              id: controller.id,
              controller,
              note: `passive capture started; drain with net.read('${controller.id}') or controller.entries(), stop with net.stop('${controller.id}')`,
            }
          }
          // Race-class: refuse pausing capture for the duration of the arming.
          return deps.dbg
            ? deps.dbg.runNonPausingOnly(start, { reason: 'race-class probe (async ordering): a pause reorders timers on resume' })
            : start()
        },
      }

    case 'unresolved-module':
      return {
        type: 'runtime-scripts',
        passive: true,
        pausing: false,
        raceClass: false,
        spec: { site: hop.site, note: 'no author source: list live scripts + fetch bundled source by url' },
        run: async () => {
          if (!deps.dbg) throw new Error('runtime-scripts probe needs deps { dbg }')
          const scripts = await deps.dbg.listScripts()
          return { scripts }
        },
      }

    case 'dynamic':
      return {
        type: 'logpoint',
        passive: false,
        pausing: false,
        raceClass: false,
        spec: { site: hop.site, note: 'dynamic value: arm a non-pausing value logpoint at the site and drain the log stream' },
        run: async () => {
          if (!deps.dbg || !hop.site?.file || hop.site.line == null) {
            throw new Error('logpoint probe needs deps { dbg } and a resolved site')
          }
          const dbg = deps.dbg
          const site = hop.site
          return dbg.runNonPausingOnly(() => dbg.setLogpoint({ file: site.file!, line: site.line, expr: 'this', tag: 'trace' }), {
            reason: 'value capture must not pause: a pause reorders timers on resume',
          })
        },
      }

    // Leaves the STATIC lane cut short. No runtime probe can answer these: the
    // remedy is another slice (bigger budget, explicit start) or a source fix. They
    // still get a probe object rather than `probe: null`, because a null probe reads
    // as "nothing to investigate here".
    case 'budget-hops':
    case 'cycle':
    case 'parse-error': {
      const reason = hop.blockedBy
      const remedy =
        reason === 'budget-hops'
          ? 'the slice hit its hop budget — re-run traceValue with a larger `maxHops` (see the hop\'s `resumable` field); nothing was measured here'
          : reason === 'cycle'
            ? 'the slice revisited a path it had already expanded — re-run from a narrower `startExpr`, or read the already-expanded hop; nothing was measured here'
            : 'the start file failed to PARSE — fix the source (or point `root` at the real author source); no runtime probe helps'
      return {
        type: 'static-remedy',
        passive: true,
        pausing: false,
        raceClass: false,
        spec: { site: hop.site, blockedBy: reason, remedy, note: `NOT a runtime blind spot: ${remedy}` },
        run: async () => {
          throw new Error(`no runtime probe applies to blockedBy '${reason}': ${remedy}`)
        },
      }
    }

    default: {
      // A BlockedReason this build does not know. Surfaced, never guessed: the
      // static-analysis lane may add variants (hop-budget exhaustion, finer async
      // classes) and arming the `dynamic` probe for one of those would answer a
      // question nobody asked while looking exactly like a real result.
      const unhandled: string = String(hop.blockedBy)
      return {
        type: 'unknown-blind-spot',
        passive: true,
        pausing: false,
        raceClass: false,
        spec: {
          site: hop.site,
          unhandledBlockedBy: unhandled,
          handledReasons: [...HANDLED_BLOCKED_REASONS],
          note:
            `blockedBy '${unhandled}' has no entry in the blind-spot -> probe table, so NO probe was armed. ` +
            `Add a case to armProbe() in trace.ts. Do not read this leaf as "nothing to probe".`,
        },
        run: async () => {
          throw new Error(
            `no probe is armed for blockedBy '${unhandled}' (handled: ${HANDLED_BLOCKED_REASONS.join(', ')}). ` +
              `Refusing to substitute a probe for a different blind spot — extend armProbe() in trace.ts instead.`,
          )
        },
      }
    }
  }
}

function fnNameFromNote(note?: string): string | null {
  if (!note) return null
  const m = note.match(/of "([^"]+)"/)
  return m ? m[1] : null
}
