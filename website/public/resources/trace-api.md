# Trace API Reference

The trace lane turns a symptom into a cause. `traceValue` anchors a wrong
on-screen value to its React source, runs the static backward slice, and arms
(never auto-runs) a runtime probe at each blind spot. The probe toolkit
(`storeIdentity`, `setLogpoint` / `readLogpoints`, `net.timeline` / `net.delay`,
`fiberSnapshot` / `fiberDiff`, `replayPure`) resolves those blind spots. Never
fabricate a value past a `blockedBy` — run the armed probe instead.

## Types

```ts
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
import type { Page, Locator, ElementHandle } from '@xmorse/playwright-core';
import type { ICDPSession } from './cdp-session.js';
import type { Debugger } from './debugger.js';
import type { ModuleGraph } from './module-graph.js';
import type { TraceHop, Loc, Hazard, BlockedReason } from './static-analysis.js';
import type { PageModelHandle } from './page-model.js';
import { type ReactComponentInfo } from './react-source.js';
export interface LogpointHit {
    tag: string;
    value: unknown;
    ts?: number;
}
/**
 * Parse `[[logpoint:TAG]] <json>` lines out of the page console log stream (the
 * executor's `browserLogs`/`getLatestLogs`). Pure over the log array — feed it a
 * plain string[] getter and it needs no browser. Output is capped to the token
 * budget (20 most-recent hits, each value truncated).
 */
export declare function readLogpoints({ getLogs, tag, sinceCursor, maxHits, maxLen, }: {
    getLogs: () => string[] | Promise<string[]>;
    tag?: string;
    sinceCursor?: number;
    maxHits?: number;
    maxLen?: number;
}): Promise<LogpointHit[]>;
/**
 * Prove (or refute) that an action mutates store state IN PLACE rather than
 * returning a fresh object. Captures the store-state reference, runs `action`,
 * re-captures, and reports whether the reference is identical. A `sameReference:
 * true` result is the fingerprint of a mutating reducer.
 */
export declare function storeIdentity({ page, action, storeExpr, }: {
    page: Page;
    action: () => Promise<void> | void;
    storeExpr?: string;
}): Promise<{
    sameReference: boolean;
    captured: boolean;
}>;
export interface NetEntry {
    phase: 'request' | 'response';
    url: string;
    method?: string;
    status?: number;
    ts: number;
}
export interface NetTimelineController {
    entries(): NetEntry[];
    stop(): void;
}
/**
 * PASSIVE network capture: record issued/resolved order + timestamps for requests
 * matching `urlPattern` (a substring or RegExp). Attaches Playwright request/
 * response listeners and buffers into `buffer` (or a fresh array). Call `stop()`
 * to detach. Non-perturbing — safe to auto-run.
 */
export declare function netTimeline({ page, urlPattern, buffer, }: {
    page: Page;
    urlPattern?: string | RegExp;
    buffer?: NetEntry[];
}): NetTimelineController;
/**
 * Deterministic race-forcing: hold matching requests for `ms` before continuing,
 * so an async ordering bug reproduces every time. Uses the CDP Fetch domain. Call
 * the returned `stop()` to disable interception. PERTURBING — never auto-run.
 */
export declare function netDelay({ cdp, urlPattern, ms, }: {
    cdp: ICDPSession;
    urlPattern: string;
    ms: number;
}): Promise<{
    stop(): Promise<void>;
}>;
/** Capture a React component's props/hierarchy for later diffing. */
export declare function fiberSnapshot({ locator, cdp, }: {
    locator: Locator | ElementHandle;
    cdp: ICDPSession;
}): Promise<ReactComponentInfo | null>;
export interface FiberDiff {
    sameComponent: boolean;
    changedProps: string[];
    addedProps: string[];
    removedProps: string[];
    changedHierarchyDepth: boolean;
}
/**
 * Diff two `fiberSnapshot` results: which prop keys changed / were added / removed
 * between renders, whether the component identity changed, and whether the
 * rendered hierarchy depth moved. Pure — no browser.
 */
export declare function fiberDiff(a: ReactComponentInfo | null, b: ReactComponentInfo | null): FiberDiff;
export interface ReplayResult {
    ok: boolean;
    value?: unknown;
    reason?: string;
    freeIdentifiers?: string[];
}
/**
 * Verify the sliced function is PURE (only params/locals + a safe-globals
 * whitelist — reusing the @babel/parser scope analysis in `isPureFunctionSource`)
 * and, only then, execute its source with the captured `args` in-process. Refuses
 * with a reason otherwise: an impure function depends on runtime state that is not
 * present here, so replaying it would throw or silently diverge.
 */
export declare function replayPure({ fn, args, allow, }: {
    fn: string | ((...a: any[]) => unknown);
    args?: unknown[];
    allow?: string[];
}): ReplayResult;
export type ProbeType = 'storeIdentity' | 'captureArgs' | 'netTimeline' | 'netDelay' | 'runtime-scripts' | 'logpoint';
export interface RuntimeProbe {
    type: ProbeType;
    /** True for observation-only probes safe to auto-run; false for perturbing/pausing. */
    passive: boolean;
    /** Human-facing description of what running the probe would do. */
    spec: Record<string, unknown>;
    run: () => Promise<unknown>;
}
export interface BlockedLeaf {
    id: string;
    blockedBy: BlockedReason;
    site: Loc | null;
    hazards: Hazard[];
    note?: string;
    codeFrame?: string;
    probe: RuntimeProbe | null;
}
export interface AnchorInfo {
    componentName: string | null;
    file: string | null;
    line: number | null;
    slot: string | null;
    note?: string;
}
/** Dependencies the orchestrator needs to anchor + arm probes. All optional so
 *  `traceValue` is fully unit-testable with an injected slice and no browser. */
export interface TraceDeps {
    page?: Page;
    cdp?: ICDPSession;
    dbg?: Debugger;
    /** Returns the page console log lines (for logpoint-based probes). */
    getLogs?: () => string[] | Promise<string[]>;
    /** Build (or fetch a cached) module graph for a root. Defaults to buildModuleGraph. */
    buildGraph?: (opts: {
        root: string;
    }) => ModuleGraph;
    /** The action that reproduces the symptom (for storeIdentity). */
    action?: () => Promise<void> | void;
    storeExpr?: string;
    urlPattern?: string;
}
export interface TraceValueOptions {
    node?: PageModelHandle;
    locator?: Locator | ElementHandle;
    selector?: string;
    slot?: string;
    maxHops?: number;
    maxBreadth?: number;
    root?: string;
    slice?: TraceHop;
    graph?: ModuleGraph;
    startFile?: string;
    startExpr?: string;
    deps?: TraceDeps;
}
export interface TraceResult {
    render(): string;
    tree: TraceHop;
    blocked: BlockedLeaf[];
    anchor: AnchorInfo | null;
    expand(hopId: string, opts?: {
        depth?: number;
    }): TraceHop | null;
}
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
export declare function traceValue(opts: TraceValueOptions): Promise<TraceResult>;
```

## Static-analysis types

```ts
import type { NodePath, Binding, BindingKind } from '@babel/traverse';
import { parse } from '@babel/parser';
import type { ModuleGraph } from './module-graph.js';
type BabelNode = {
    type: string;
    loc?: any;
} & Record<string, any>;
export interface Loc {
    file?: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
}
export interface Hazard {
    type: 'aliasing' | 'escape';
    loc: Loc;
}
export interface BindingInfo {
    name: string;
    kind: BindingKind;
    declPath: NodePath | null;
    referencePaths: NodePath[];
    constantViolations: NodePath[];
    constant: boolean;
    binding: Binding | null;
}
export type BlockedReason = 'mutation' | 'unresolved-module' | 'interprocedural' | 'async' | 'dynamic' | null;
export type HopKind = 'root' | 'value' | 'constant' | 'writer' | 'module-export' | 'param-caller' | 'blocked';
/**
 * A single step in a backward value-trace. Produced statically here; the M4
 * runtime orchestrator attaches live probes to the blocked leaves.
 */
export interface TraceHop {
    kind: HopKind;
    site: Loc | null;
    blockedBy: BlockedReason;
    hazards: Hazard[];
    evaluated: {
        confident: boolean;
        value?: unknown;
    } | null;
    codeFrame?: string;
    note?: string;
    children?: TraceHop[];
}
export declare function locOf(node: BabelNode | null | undefined, file?: string): Loc | null;
export type ParsedFile = ReturnType<typeof parse>;
export declare function parseModule(code: string, filename?: string): ParsedFile;
/** Depth-first search for the first NodePath matching `predicate`. */
export declare function findNodePath(ast: ParsedFile, predicate: (p: NodePath) => boolean): NodePath | null;
/**
 * Read the scope binding for an identifier path into a plain, serialisable-ish
 * summary. `path` should be an Identifier (or any node exposing `.scope` and a
 * resolvable name).
 */
export declare function analyzeBinding(path: NodePath): BindingInfo;
/**
 * Flag whether any reference to `binding` mutates the referent in place
 * (aliasing) or lets it escape (escape). A `constant: true` binding with a
 * hazard MUST still be reported, so a mutating reducer is never mistaken for a
 * genuine constant.
 */
export declare function aliasingHazard(binding: BindingInfo): {
    hazard: 'aliasing' | 'escape' | null;
    sites: Loc[];
};
/**
 * Static constant-fold of an expression path via Babel's `path.evaluate()`.
 * When not confident, surfaces the deopt NodePath (the next hop pointer).
 */
export declare function probeValue(path: NodePath): {
    confident: boolean;
    value?: unknown;
    deoptLoc?: Loc;
    deoptPath?: NodePath;
};
/**
 * Turn a deopt point into a typed next step. Given the identifier `path` and its
 * analyzed `binding`, decide where the trace should hop next (or why it is
 * blocked). Returns the TraceHop shape reused by the M4 orchestrator.
 */
export declare function classifyDeopt(path: NodePath, binding: BindingInfo, graph: ModuleGraph): TraceHop;
/**
 * For a `useEffect` / `useCallback` / `useMemo` CallExpression path, compute the
 * reactive free variables referenced in the callback that are missing from the
 * dependency array. useState/useReducer setters are treated as stable and
 * excluded, matching the react-hooks lint rule.
 */
export declare function exhaustiveDeps(effectPath: NodePath): {
    missing: string[];
    effectLoc: Loc;
};
/**
 * Frontier walk chaining the primitives into a bounded static slice tree. Each
 * blocked leaf carries `{ site, codeFrame, blockedBy, hazards }` but NO runtime
 * probe (M4 attaches those). Confident branches collapse to a `value` leaf.
 *
 * Documented limits:
 * - Interprocedural depth is one hop (single-caller salvage only).
 * - Re-export chains are not transitively followed.
 * - Async boundaries stop the slice (marked `blocked: 'async'`).
 */
export declare function backwardSlice({ graph, startFile, startExpr, maxHops, maxBreadth, }: {
    graph: ModuleGraph;
    startFile: string;
    startExpr: string | NodePath;
    maxHops?: number;
    maxBreadth?: number;
}): TraceHop;
export interface PurityResult {
    pure: boolean;
    reason?: string;
    freeIdentifiers: string[];
}
/**
 * Decide whether a function's SOURCE is pure enough to replay in-process: it may
 * only reference its own params/locals and a whitelist of safe globals. Any free
 * identifier outside the whitelist (a captured closure variable, `window`,
 * `fetch`, an imported binding, …) makes it impure — replaying it would either
 * throw or silently diverge from the real runtime.
 */
export declare function isPureFunctionSource(src: string, opts?: {
    allow?: string[];
}): PurityResult;
export {};
```

## Examples

```ts
// ALL debug helpers below are GLOBAL VARIABLES in the sandbox.
// Call them directly — no import, no require needed.
// (The imports here are only for TypeScript type-checking of this examples file.)
import {
  page,
  pm,
  traceValue,
  storeIdentity,
  setLogpoint,
  readLogpoints,
  net,
  fiberSnapshot,
  fiberDiff,
  replayPure,
  console,
} from './debugger-examples-types.js'

// Example: trace a wrong on-screen value back toward its source (observe→act→observe)
async function traceWrongTotal() {
  // Anchor on the DOM symptom; traceValue resolves the React source + runs the
  // static backward slice, arming (never auto-running) a probe at each blind spot.
  const result = await traceValue({ selector: '[data-testid="cart-total"]' })

  // render is a token-bounded summary string — read it first.
  console.log(result.render)

  // anchor is where the symptom was pinned in author source.
  if (result.anchor) {
    console.log('anchor:', result.anchor.componentName, '@', result.anchor.file, result.anchor.line)
  }

  // Each blocked leaf names its blind spot + the probe that would resolve it.
  // NEVER fabricate a value past a `blockedBy` — run the armed probe instead.
  for (const leaf of result.blocked) {
    console.log(`[${leaf.id}] blockedBy=${leaf.blockedBy} probe=${leaf.probe?.type} passive=${leaf.probe?.passive}`)
  }

  // Drill into one hop losslessly without re-tracing.
  if (result.blocked.length > 0) {
    console.log('hop detail:', result.expand(result.blocked[0].id))
  }
}

// Example: trace from a PageModel handle instead of a bare selector
async function traceFromHandle() {
  const handle = await pm.anchor('[data-testid="cart-total"]')
  if (!handle) return
  const result = await traceValue({ node: handle })
  console.log(result.render)
}

// Example: archetype 1 — mutating reducer. Prove an in-place store mutation.
async function proveMutatingReducer() {
  // storeIdentity captures the store-state ref, runs the action, re-captures.
  // sameReference:true is the fingerprint of a reducer that mutates instead of
  // returning a fresh object (so React bails out of the re-render).
  const { sameReference, captured } = await storeIdentity({
    action: async () => {
      await page.locator('button:has-text("Add to cart")').click()
    },
  })
  console.log('captured store:', captured, 'mutated in place:', sameReference)
}

// Example: archetype 2 — cross-module util. Capture args via an entry logpoint.
async function captureUtilArgs() {
  // Arm a logpoint at the util's call site, trigger the flow, then drain the log.
  await setLogpoint({ file: 'src/lib/format-money.ts', line: 12, expr: 'cents', tag: 'money' })
  await page.locator('button:has-text("Checkout")').click()
  const hits = await readLogpoints({ tag: 'money' })
  for (const hit of hits) {
    console.log('formatMoney arg:', hit.tag, '=>', hit.value)
  }
}

// Example: archetype 3 — async race. Passive timeline first, then force the race.
async function forceAsyncRace() {
  // Passive capture is non-perturbing and safe to auto-run.
  const timeline = net.timeline({ urlPattern: '/api/cart' })
  await page.locator('button:has-text("Add to cart")').click()
  await page.locator('button:has-text("Checkout")').click()
  console.log('request/response order:', timeline.entries())
  timeline.stop()

  // net.delay is PERTURBING — it holds matching requests so the race reproduces
  // deterministically. Always stop() it afterward.
  const hold = await net.delay({ urlPattern: '/api/cart', ms: 800 })
  await page.locator('button:has-text("Checkout")').click()
  await hold.stop()
}

// Example: archetype 4 — stale effect deps. Diff two fiber snapshots across a render.
async function diffStaleEffect() {
  const loc = page.locator('[data-testid="live-price"]')
  const before = await fiberSnapshot({ locator: loc })
  await page.locator('button:has-text("Refresh")').click()
  const after = await fiberSnapshot({ locator: loc })

  const diff = fiberDiff(before, after)
  console.log('same component:', diff.sameComponent)
  console.log('changed props:', diff.changedProps)
  console.log('added / removed:', diff.addedProps, diff.removedProps)
  console.log('hierarchy depth moved:', diff.changedHierarchyDepth)
}

// Example: re-run a pure sliced function in-process with captured args
async function replayPureFunction() {
  // replayPure refuses impure functions (they depend on runtime state not present
  // here) with a reason + the offending free identifiers.
  const result = replayPure({
    fn: '(items) => items.reduce((sum, i) => sum + i.price * i.qty, 0)',
    args: [[{ price: 10, qty: 2 }, { price: 5, qty: 1 }]],
  })
  if (result.ok) {
    console.log('replayed value:', result.value)
  } else {
    console.log('refused:', result.reason, 'free identifiers:', result.freeIdentifiers)
  }
}

export {
  traceWrongTotal,
  traceFromHandle,
  proveMutatingReducer,
  captureUtilArgs,
  forceAsyncRace,
  diffStaleEffect,
  replayPureFunction,
}

```