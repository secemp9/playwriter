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
import type { Page, Locator, ElementHandle } from '@xmorse/playwright-core';
import type { ICDPSession } from './cdp-session.js';
import type { Debugger } from './debugger.js';
import type { ModuleGraph } from './module-graph.js';
import type { TraceHop, Loc, Hazard, BlockedReason } from './static-analysis.js';
import type { PageModelHandle } from './page-model.js';
import { type ReactComponentInfo } from './react-source.js';
/** How a value was cut to fit the token budget. Present ONLY when cut. */
export interface LogpointTruncation {
    originalLength: number;
    keptLength: number;
}
export interface LogpointHit {
    tag: string;
    value: unknown;
    /** Present ONLY when the value was cut. Its absence means the value is whole. */
    truncated?: LogpointTruncation;
    /**
     * Present when the payload was not usable JSON — a page-side stringify failure,
     * an `undefined` expression, a payload the page capped, or a cut log line. The
     * raw text is kept so the failure is diagnosable instead of silently coerced.
     */
    malformed?: {
        reason: string;
        raw: string;
    };
    ts?: number;
    /** Index of the source line within the scanned log array. */
    lineIndex: number;
}
export interface LogpointRead {
    /** The returned window: the most-recent `caps.maxHits` matching hits. */
    hits: LogpointHit[];
    /** TRUE number of matching hits in the scanned range, before windowing. */
    totalHits: number;
    /** totalHits - hits.length. Non-zero means older hits were dropped. */
    droppedHits: number;
    /** How many of the returned hits carry a `malformed` marker. */
    malformedHits: number;
    /** Lines carrying the marker whose tag could not be read at all. */
    unparsableLines: string[];
    caps: {
        maxHits: number;
        maxLen: number;
    };
    linesScanned: number;
    /** Pass back as `sinceCursor` to read only lines added after this call. */
    cursor: number;
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
export declare function readLogpoints({ getLogs, tag, sinceCursor, maxHits, maxLen, }: {
    getLogs: () => string[] | Promise<string[]>;
    tag?: string;
    sinceCursor?: number;
    maxHits?: number;
    maxLen?: number;
}): Promise<LogpointRead>;
export type StoreDiscoveryVia = 'caller-storeExpr' | 'global' | 'react-fiber';
export interface StoreDiscovery {
    via: StoreDiscoveryVia;
    /** A reusable expression that re-reads the state. Safe to pass as `storeExpr`. */
    expr: string;
    /** Where in the fiber tree the store came from, when `via === 'react-fiber'`. */
    path?: string;
    componentName?: string | null;
    /** Set when the probe pinned the store on the page so it can be re-read. */
    pinnedAs?: string;
}
/**
 * The measured half. `sameReference` EXISTS ONLY HERE: reading it requires having
 * a `measured: true` result in hand, so "I never found your store" can no longer
 * be mistaken for "your store correctly produced a new reference".
 */
export interface StoreIdentityMeasured {
    measured: true;
    /** true = the SAME object came back after the action: an in-place mutation. */
    sameReference: boolean;
    verdict: 'in-place-mutation' | 'fresh-reference';
    discovery: StoreDiscovery;
    /** Top-level keys whose value reference differs between the two captures. */
    changedKeys: string[];
    changedKeysCapped: boolean;
    stateKind: 'object' | 'array';
    note: string;
}
export type StoreIdentityFailure = 'store-not-found' | 'not-an-object' | 'expr-threw' | 'eval-blocked-by-csp' | 'store-vanished' | 'page-error';
/** The un-measured half. Deliberately carries NO verdict field of any kind. */
export interface StoreIdentityUnmeasured {
    measured: false;
    reason: StoreIdentityFailure;
    /** Everything the probe looked at, verbatim, so the gap is obvious. */
    tried: string[];
    detail: string;
    /** What to do next. Always names `storeExpr` explicitly. */
    remedy: string;
    /** Whether `action` still ran (the page may have changed even though nothing was measured). */
    actionRan: boolean;
}
export type StoreIdentityResult = StoreIdentityMeasured | StoreIdentityUnmeasured;
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
export declare function storeIdentity({ page, action, storeExpr, }: {
    page: Page;
    action: () => Promise<void> | void;
    storeExpr?: string;
}): Promise<StoreIdentityResult>;
export type TraceProbeKind = 'net.timeline' | 'net.delay';
export interface TraceProbeInfo {
    id: string;
    kind: TraceProbeKind;
    /** true = this probe changes page behaviour while it is live. */
    perturbing: boolean;
    live: boolean;
    startedAt: number;
    stoppedAt: number | null;
    stoppedReason: 'caller' | 'ttl' | 'stopAll' | 'error' | null;
    /** When the probe will auto-stop; null means "until stopped" (reported as unbounded). */
    expiresAt: number | null;
    spec: Record<string, unknown>;
    /** Counters, plus the boolean verdicts a counter cannot express — `interceptedNothing`
     *  exists precisely because "0" and "nothing was measured" are different facts. */
    stats: Record<string, number | boolean>;
    describe: string;
}
/**
 * Every probe this process has started, live or stopped. The stopped ones are kept
 * for the session so "who perturbed my measurement?" has an answer.
 */
export declare function listTraceProbes(opts?: {
    live?: boolean;
    kind?: TraceProbeKind;
}): TraceProbeInfo[];
export declare function getTraceProbe(id: string): TraceProbeInfo | null;
/** Read a probe's captured data by id — works after the controller went out of scope. */
export declare function readTraceProbe(id: string): unknown;
export declare function stopTraceProbe(id: string): Promise<boolean>;
export declare function stopAllTraceProbes(opts?: {
    owner?: unknown;
    kind?: TraceProbeKind;
}): Promise<string[]>;
/**
 * One line per live PERTURBING probe. `traceValue` folds these into its result so a
 * forgotten `net.delay` cannot silently poison every later measurement: the next
 * trace you run says so out loud.
 */
export declare function tracePerturbationWarnings(): string[];
export interface NetEntry {
    phase: 'request' | 'response';
    url: string;
    method?: string;
    status?: number;
    ts: number;
}
export declare function matchesUrlPattern(url: string, urlPattern: string | RegExp | undefined): boolean;
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
export declare function urlPatternToFetchGlob(urlPattern: string | RegExp | undefined): string;
export interface NetTimelineController {
    /** Registry id. Survives this `execute()` call: `net.read(id)` drains it later. */
    id: string;
    entries(): NetEntry[];
    /** Retention accounting — a full buffer drops the OLDEST entries, visibly. */
    stats(): {
        total: number;
        retained: number;
        dropped: number;
        maxEntries: number;
    };
    stop(): void;
    info(): TraceProbeInfo | null;
}
/**
 * PASSIVE network capture: record issued/resolved order + timestamps for requests
 * matching `urlPattern` (a substring or RegExp). Non-perturbing — safe to auto-run.
 *
 * The controller is also registered in the session probe registry, so a caller who
 * forgets to stash it in `state` does NOT silently record nothing: the listeners
 * stay attached, `net.active()` still lists the probe, and `net.read(id)` drains
 * the entries from a later call. Buffer retention is capped and reported.
 */
export declare function netTimeline({ page, urlPattern, buffer, maxEntries, }: {
    page: Page;
    urlPattern?: string | RegExp;
    buffer?: NetEntry[];
    maxEntries?: number;
}): NetTimelineController;
export type NetDelayStats = {
    /** Requests this probe actually HELD for `ms`. */
    paused: number;
    continued: number;
    failed: number;
    pending: number;
    /** Every `Fetch.requestPaused` the probe saw, matching or not. */
    seen: number;
    /** Seen but not matching `urlPattern` — continued immediately, never delayed. */
    notMatched: number;
    /**
     * TRUE while the probe has held nothing. A `net.delay` that intercepts nothing is
     * NOT a clean run: it is a measurement that never happened, and it must not be
     * readable as one that happened and found no delay to introduce.
     */
    interceptedNothing: boolean;
};
export interface NetDelayController {
    id: string;
    stop(): Promise<void>;
    stats(): NetDelayStats;
    info(): TraceProbeInfo | null;
}
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
export declare function netDelay({ cdp, urlPattern, ms, ttlMs, force, }: {
    cdp: ICDPSession;
    /** A SUBSTRING of the URL, or a RegExp — the same language `netTimeline` uses. NOT a
     *  `Fetch.enable` glob; see `matchesUrlPattern`. */
    urlPattern: string | RegExp;
    ms: number;
    ttlMs?: number;
    force?: boolean;
}): Promise<NetDelayController>;
/** One prop of an identity-capturing snapshot. `ref` is a page-side identity token. */
export interface IdentifiedProp {
    /** Stable while the reference is unchanged; 0 for primitives. */
    ref: number;
    type: 'primitive' | 'function' | 'object' | 'array';
    /** Structural projection; functions render as `[fn name/arity]` (paired with `ref`). */
    value: unknown;
    fnName?: string | null;
    arity?: number;
    fnSource?: string;
}
export interface FiberIdentitySnapshot {
    identityCaptured: true;
    componentName: string | null;
    source: ReactComponentInfo['source'];
    hierarchy: ReactComponentInfo['hierarchy'];
    props: Record<string, IdentifiedProp>;
    /** Every function reachable in props (bounded), by dotted path -> identity token. */
    fnRefs: Array<{
        path: string;
        ref: number;
        name: string | null;
        arity: number;
    }>;
    caps: {
        maxKeys: number;
        maxDepth: number;
        keysOmitted: number;
        fnRefsOmitted: number;
    };
    note: string;
}
/** What `fiberDiff` can compare: a plain snapshot, an identity snapshot, or any
 *  object exposing `props` (live in-process objects included). */
export interface FiberDiffInput {
    componentName?: string | null;
    hierarchy?: unknown;
    props?: unknown;
    identityCaptured?: boolean;
    fnRefs?: Array<{
        path: string;
        ref: number;
        name: string | null;
        arity: number;
    }>;
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
export declare function fiberSnapshot(opts: {
    locator: Locator | ElementHandle;
    cdp: ICDPSession;
    identity?: false;
}): Promise<ReactComponentInfo | null>;
export declare function fiberSnapshot(opts: {
    locator: Locator | ElementHandle;
    cdp: ICDPSession;
    identity: true;
    maxKeys?: number;
    maxDepth?: number;
}): Promise<FiberIdentitySnapshot | null>;
export type PropChangeKind = 'changed-by-value' | 'changed-by-identity' | 'added' | 'removed' | 'unobservable';
export interface PropChange {
    key: string;
    kind: PropChangeKind;
    /** Compact, capped projections of the two values. */
    before?: string;
    after?: string;
    valueType?: string;
    /** For functions: enough to tell WHICH handler churned. */
    fn?: {
        name: string | null;
        arity?: number;
        sameSource?: boolean;
        sourceExcerpt?: string;
    };
    /** Why the comparison could not be made (`kind: 'unobservable'` only). */
    reason?: string;
}
export interface FiberDiff {
    sameComponent: boolean;
    /** Every non-unchanged prop, capped (see `caps`). */
    changes: PropChange[];
    unchangedKeys: string[];
    /** Deep-equal but a NEW reference: the props that defeat React.memo. */
    identityChangedKeys: string[];
    /** Props whose comparison could NOT be performed. Never "unchanged". */
    unobservableKeys: string[];
    changedHierarchyDepth: boolean;
    caps: {
        maxDepth: number;
        maxNodes: number;
        maxKeys: number;
        maxChanges: number;
        nodesVisited: number;
        hitCap: boolean;
        changesOmitted: number;
        notes: string[];
    };
    /** Derived convenience: changed = changed-by-value + changed-by-identity. */
    changedProps: string[];
    addedProps: string[];
    removedProps: string[];
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
export declare function fiberDiff(a: FiberDiffInput | null, b: FiberDiffInput | null, opts?: {
    maxDepth?: number;
    maxNodes?: number;
    maxKeys?: number;
    maxChanges?: number;
}): FiberDiff;
export interface CapturedLog {
    level: string;
    args: unknown[];
    ts: number;
}
export type OffendingCategory = 'logging' | 'network' | 'storage' | 'dom' | 'timers' | 'process-or-module' | 'closure-or-import';
export interface OffendingIdentifier {
    name: string;
    line: number | null;
    column: number | null;
    category: OffendingCategory;
    /** Whether it can legitimately be admitted via `allow` / `bindings`. */
    admissible: boolean;
    why: string;
}
export interface ReplayOk {
    ok: true;
    value: unknown;
    /** Everything the function logged, in order. Logging is virtualised, not permitted. */
    logs: CapturedLog[];
    logsDropped: number;
    logsCapped: boolean;
    /** Names admitted into scope for this run (`console` + `bindings` + `allow`). */
    allowed: string[];
    evaluatedIn: 'node-executor-process';
    note: string;
}
export interface ReplayRefused {
    ok: false;
    stage: 'parse' | 'purity' | 'execution';
    reason: string;
    /** Kept for compatibility: the offending names only. */
    freeIdentifiers: string[];
    /** Every offending free identifier WITH its source position and verdict. */
    offending: OffendingIdentifier[];
    /** Offenders that `allow` (plus a matching `bindings` value) can admit. */
    admissible: string[];
    /** Offenders that can never be admitted — nothing in this process can supply them. */
    categoricallyUnsafe: string[];
    logs?: CapturedLog[];
    evaluatedIn: 'node-executor-process';
    note: string;
}
export type ReplayResult = ReplayOk | ReplayRefused;
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
export declare function replayPure(opts: {
    fn: string | ((...a: any[]) => unknown);
    args?: unknown[];
    allow?: string[];
    /** Values for captured/imported identifiers; each name is admitted and injected. */
    bindings?: Record<string, unknown>;
    maxLogs?: number;
}): ReplayResult;
/** As `replayPure`, but awaits a returned Promise (an async sliced function). */
export declare function replayPureAsync(opts: {
    fn: string | ((...a: any[]) => unknown);
    args?: unknown[];
    allow?: string[];
    bindings?: Record<string, unknown>;
    maxLogs?: number;
}): Promise<ReplayResult>;
export type ProbeType = 'storeIdentity' | 'captureArgs' | 'netTimeline' | 'netDelay' | 'runtime-scripts' | 'logpoint'
/** The leaf is not a runtime blind spot: the remedy is static (budget, cycle, parse). */
 | 'static-remedy'
/** This build has no entry for the leaf's `blockedBy`. Refuses to run. */
 | 'unknown-blind-spot';
export interface RuntimeProbe {
    type: ProbeType;
    /** True for observation-only probes safe to auto-run; false for perturbing/pausing. */
    passive: boolean;
    /** Always false: no probe armed here uses a pausing breakpoint. */
    pausing: false;
    /** True when the hypothesis is about ORDERING — capture must not reorder timers. */
    raceClass: boolean;
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
export interface RenderOptions {
    /** Hard line budget (default 60). The collapse is always announced in the output. */
    maxLines?: number;
    /** Include the blocked leaves' code frames (default true). */
    codeFrames?: boolean;
}
/**
 * A hop plus a BOUNDED slice of its subtree, cycle-free and JSON-safe. Carries the
 * hop's own fields inline (so it reads like a TraceHop) plus the accounting for
 * what the depth/node caps left out.
 */
export interface TraceSubtree extends Omit<TraceHop, 'children'> {
    id: string;
    children: TraceSubtree[];
    /** Children NOT included because of the depth/node cap. 0 means none were cut. */
    omittedChildren: number;
    /** True when this node and everything under it is present. */
    complete: boolean;
}
export interface TraceResult {
    /**
     * Token-bounded summary. A METHOD, not a precomputed string: rendering is cheap
     * only when it is asked for, and options (`maxLines`, `codeFrames`) belong to the
     * caller, not to the trace. The sandbox exposes it as a function too.
     */
    render(opts?: RenderOptions): string;
    tree: TraceHop;
    blocked: BlockedLeaf[];
    anchor: AnchorInfo | null;
    /** Bounded subtree in ONE call. `depth` defaults to 1 (this hop + its children). */
    expand(hopId: string, opts?: {
        depth?: number;
        maxNodes?: number;
    }): TraceSubtree | null;
    /** Every hop id, so a caller can address a hop without walking the tree. */
    hopIds: string[];
    /** Live perturbing probes and unhandled blind spots — surfaced, never implicit. */
    warnings: string[];
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
/** The `blockedBy` variants this table handles. A variant NOT in here gets the
 *  `unknown-blind-spot` probe, never a plausible-looking substitute. */
export declare const HANDLED_BLOCKED_REASONS: readonly ["mutation", "interprocedural", "async", "unresolved-module", "dynamic", "budget-hops", "cycle", "parse-error"];
```

## Static-analysis types

```ts
import type { NodePath, Binding, BindingKind } from '@babel/traverse';
import { parse } from '@babel/parser';
import type { ModuleGraph, ParseFailure, ReexportStep } from './module-graph.js';
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
    /** Which mutation/escape pattern was matched — the reason this is a hazard. */
    pattern?: HazardPattern;
    /** Set when the hazard was found through an alias of the traced binding. */
    viaAlias?: string;
}
export type HazardPattern = 'member-assign' | 'member-update' | 'member-delete' | 'mutating-method' | 'mutating-method-apply' | 'mutating-static-call' | 'call-argument' | 'returned' | 'stored-in-object' | 'assigned-into-member';
export interface BindingInfo {
    name: string;
    kind: BindingKind;
    declPath: NodePath | null;
    referencePaths: NodePath[];
    constantViolations: NodePath[];
    constant: boolean;
    binding: Binding | null;
}
/**
 * Why the static walk stopped. The value is a *next action* for the agent, so
 * budget exhaustion, a cycle break and a genuine runtime blind spot must never
 * share a variant:
 *
 *   mutation          — a write/aliasing site; go prove it at runtime
 *   unresolved-module — the chain left the project or a dependency is blackboxed
 *   interprocedural   — which caller supplied the value is not statically knowable
 *   async             — the value arrives across a promise/generator boundary
 *   dynamic           — genuinely unknown statically; go get runtime evidence
 *   parse-error       — a source file does not parse; FIX THE FILE, no probe helps
 *   budget-hops       — the walk ran out of budget; RESUMABLE, raise `maxHops`
 *   cycle             — the walk re-entered a node it was already expanding
 */
export type BlockedReason = 'mutation' | 'unresolved-module' | 'interprocedural' | 'async' | 'dynamic' | 'parse-error' | 'budget-hops' | 'cycle' | null;
export type HopKind = 'root' | 'value' | 'constant' | 'writer' | 'module-export' | 'param-caller'
/** A local binding whose initialiser only NAMES its value (`const x = imported`). */
 | 'alias' | 'blocked';
/** A stop the caller can lift by re-running with a bigger budget. */
export interface ResumableHint {
    option: 'maxHops' | 'maxBreadth';
    current: number;
    suggested: number;
}
/** A branch set that was cut short. A truncated branch that looks complete is a lie. */
export interface TruncationInfo {
    of: 'callers';
    shown: number;
    total: number;
    resumeWith: ResumableHint;
}
/** What the callers of a parameter actually agreed (or failed to agree) on. */
export interface DivergenceInfo {
    agreement: 'convergent' | 'divergent' | 'unknown';
    /** One entry per explored caller, in `children` order. */
    candidates: {
        site: Loc | null;
        confident: boolean;
        value?: unknown;
        blockedBy?: BlockedReason;
    }[];
    /** Distinct confident values, JSON-rendered. Populated when `divergent`. */
    distinctValues?: string[];
    /**
     * The single value every explored caller supplied. Set only when
     * `agreement: 'convergent'` — i.e. the value is knowable regardless of which
     * caller was live. Deliberately NOT written to the hop's `evaluated`: that
     * field means "this subtree collapses, nothing below it matters", which is
     * false for a hop whose whole point is the caller branches underneath it.
     */
    agreedValue?: unknown;
}
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
    /** Set when a branch set was cut by `maxBreadth`. */
    truncated?: TruncationInfo;
    /** Set when the stop is a budget stop, not a knowledge stop. */
    resumable?: ResumableHint;
    /** Set on multi-caller parameter hops. */
    divergence?: DivergenceInfo;
    /** Set when the dead end is a file the parser could not read. */
    parseError?: ParseFailure;
    /** Re-export links followed to reach this hop's site. */
    reexportChain?: ReexportStep[];
    /** Where a `module-export` hop landed, after every re-export link. */
    resolved?: {
        file: string;
        exportName: string;
    };
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
export interface AliasingResult {
    /** Worst hazard found: `aliasing` outranks `escape`. Null when clean. */
    hazard: 'aliasing' | 'escape' | null;
    /** Every hazard site, aliasing first. Kept for the existing M4 consumer. */
    sites: Loc[];
    /** Per-site hazards with their own type + matched pattern. */
    hazards: Hazard[];
    aliasingSites: Loc[];
    escapeSites: Loc[];
}
/**
 * Flag whether any reference to `binding` mutates the referent in place
 * (aliasing) or lets it escape (escape). A `constant: true` binding with a
 * hazard MUST still be reported, so a mutating reducer is never mistaken for a
 * genuine constant — Babel's `constant` only means "never reassigned", which
 * says nothing about writes THROUGH the reference.
 *
 * Deliberately biased toward false positives: a missed mutation makes the whole
 * trace lie, while a spurious one only costs one runtime probe.
 */
export declare function aliasingHazard(binding: BindingInfo, opts?: {
    file?: string;
}): AliasingResult;
/**
 * Static constant-fold of an expression path via Babel's `path.evaluate()`.
 * When not confident, surfaces the deopt NodePath (the next hop pointer).
 *
 * `deoptPath` is an internal pointer — it must never reach a sandbox or a
 * TraceHop. Use `probeValueSerializable` for anything an agent reads.
 */
export declare function probeValue(path: NodePath): {
    confident: boolean;
    value?: unknown;
    deoptLoc?: Loc;
    deoptPath?: NodePath;
    deoptType?: string;
};
export interface SerializableProbe {
    confident: boolean;
    value?: unknown;
    /** Where constant-folding gave up, and on what kind of node. */
    deoptLoc?: Loc;
    deoptType?: string;
}
/** `probeValue` with the NodePath projected away and the value bounded. */
export declare function probeValueSerializable(path: NodePath, file?: string): SerializableProbe;
export type AsyncBoundaryKind = 'await' | 'promise-chain' | 'promise-combinator' | 'promise-constructor' | 'async-call' | 'then-callback-param' | 'async-writer' | 'for-await' | 'yield';
export interface AsyncBoundary {
    kind: AsyncBoundaryKind;
    site: Loc | null;
    note: string;
}
/**
 * Decide whether the binding's value arrives across an asynchronous boundary,
 * and say WHICH one. This drives probe selection (`net.timeline` first, because
 * logpoints perturb races), so a wrong "async" is worse than an honest unknown —
 * every recogniser here must be a shape that genuinely defers a value.
 */
export declare function classifyAsyncBoundary(binding: BindingInfo, graph?: ModuleGraph, file?: string): AsyncBoundary | null;
/**
 * Turn a deopt point into a typed next step. Given the identifier `path` and its
 * analyzed `binding`, decide where the trace should hop next (or why it is
 * blocked). Returns the TraceHop shape reused by the M4 orchestrator.
 */
export declare function classifyDeopt(path: NodePath, binding: BindingInfo, graph: ModuleGraph): TraceHop;
export interface AliasContinuation {
    path: NodePath;
    file: string | undefined;
    note: string;
}
/**
 * A local binding whose initialiser does not fold but only NAMES its value:
 * `const x = imported`, `const { a } = imported`, `const y = ns.thing`. These
 * are among the most common shapes in real component code, and treating them as
 * `dynamic` is the worst available answer — it sends the agent after runtime
 * evidence for a value that is fully resolvable two files away.
 *
 * Returns ONE link. The slice walks the rest, so each link keeps its own hop,
 * its own budget charge and its own cycle check.
 */
export declare function aliasContinuation(binding: BindingInfo, graph: ModuleGraph, file: string | undefined): AliasContinuation | null;
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
export interface BackwardSliceOptions {
    graph: ModuleGraph;
    startFile: string;
    startExpr: string | NodePath;
    maxHops?: number;
    maxBreadth?: number;
}
/**
 * Frontier walk chaining the primitives into a bounded static slice tree. Each
 * blocked leaf carries `{ site, codeFrame, blockedBy, hazards }` but NO runtime
 * probe (M4 attaches those). Confident branches collapse to a `value` leaf.
 *
 * Documented limits:
 * - Interprocedural analysis branches over up to `maxBreadth` resolved callers;
 *   truncation is reported on the hop (`truncated`), never dropped silently.
 * - Re-export chains ARE followed to the defining file; ambiguity from competing
 *   `export *` links is reported rather than guessed at.
 * - Async boundaries stop the slice (`blockedBy: 'async'`).
 * - Running out of `maxHops` yields `blockedBy: 'budget-hops'` with a
 *   `resumable` hint — NOT `'dynamic'`, which would send the agent to a probe
 *   when the right move is a bigger budget.
 */
export declare function backwardSlice({ graph, startFile, startExpr, maxHops, maxBreadth, }: BackwardSliceOptions): TraceHop;
interface SourceRef {
    /** Inline source. Mutually exclusive with `file`. */
    code?: string;
    /** Absolute path of a file already in (or reachable from) `graph`. */
    file?: string;
    graph?: ModuleGraph;
}
export interface BindingReport {
    ok: boolean;
    error?: string;
    name: string;
    kind: string;
    /** Babel's notion: never reassigned. Says NOTHING about writes through it. */
    constant: boolean;
    declSite: Loc | null;
    referenceCount: number;
    writeSites: Loc[];
    hazard: 'aliasing' | 'escape' | null;
    hazards: Hazard[];
    /** One-step classification of where the value comes from. */
    hop?: TraceHop;
}
/**
 * Sandbox entry point for `analyzeBinding` + `aliasingHazard` + `classifyDeopt`:
 * "tell me everything about this binding" in one bounded, serialisable answer.
 * `occurrence` picks among repeated names (0 = first reference).
 */
export declare function inspectBinding(opts: SourceRef & {
    name: string;
    occurrence?: number;
}): BindingReport;
/**
 * Sandbox entry point for `probeValue`: constant-fold the `occurrence`-th
 * expression matching `expr` (an identifier name) and report the fold or the
 * deopt position — never a NodePath.
 */
export declare function evaluateBinding(opts: SourceRef & {
    name: string;
    occurrence?: number;
}): SerializableProbe & {
    ok: boolean;
    error?: string;
    site?: Loc;
};
export interface MissingDepsReport {
    ok: boolean;
    error?: string;
    effects: {
        hook: string;
        effectLoc: Loc;
        missing: string[];
        codeFrame?: string;
    }[];
}
/**
 * Sandbox entry point for `exhaustiveDeps`: scan a whole file for reactive hooks
 * whose dependency array is missing a reactive value it reads. This is the shape
 * the check needed to be reachable at all — the primitive wants a NodePath to a
 * specific hook call, which nothing outside this module can produce.
 */
export declare function findMissingDeps(opts: SourceRef & {
    hooks?: string[];
    max?: number;
    withCodeFrames?: boolean;
}): MissingDepsReport;
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
// `{ page: state.page }` is NOT optional on any of these. Every helper that accepts an
// optional `page` falls back to the sandbox `page` global — the DEFAULT tab — so a task
// that stored its tab in `state.page` and omitted the option inspects the wrong one.
import {
  state,
  pm,
  traceValue,
  storeIdentity,
  setLogpoint,
  readLogpoints,
  net,
  fiberSnapshot,
  fiberDiff,
  replayPure,
  replayPureAsync,
  moduleGraph,
  inspectBinding,
  evaluateBinding,
  findMissingDeps,
  isPureFunctionSource,
  backwardSlice,
  console,
} from './debugger-examples-types.js'
import type { NetEntry } from './trace.js'

// Example: trace a wrong on-screen value back toward its source (observe→act→observe)
async function traceWrongTotal() {
  // Anchor on the DOM symptom; traceValue resolves the React source + runs the
  // static backward slice, arming (never auto-running) a probe at each blind spot.
  // `root` defaults to the SESSION's cwd. Pass it explicitly when the app source lives
  // somewhere else — the module graph is only as good as the tree it was parsed over.
  // This needs author source on disk AND a React dev build: the start of the slice comes
  // from the fiber's source location, which production builds omit. Without both you get
  // a single hop with blockedBy:'dynamic' and a "could not determine a start" note; that
  // is the signal to drop to createDebugger / setLogpoint, not to retry traceValue.
  const result = await traceValue({ page: state.page, selector: '[data-testid="cart-total"]', root: '/abs/repo/root' })

  // render is a METHOD with a line budget — read it first. The collapse is announced.
  console.log(result.render())
  console.log(result.render({ maxLines: 20, codeFrames: false }))

  // warnings names live PERTURBING probes and blind spots this build has no probe for.
  // A forgotten net.delay poisons every timing measurement, and it says so here.
  for (const warning of result.warnings) console.log('!', warning)

  // anchor is where the symptom was pinned in author source.
  if (result.anchor) {
    console.log('anchor:', result.anchor.componentName, '@', result.anchor.file, result.anchor.line)
  }

  // Each blocked leaf names its blind spot + the probe that would resolve it.
  // NEVER fabricate a value past a `blockedBy` — run the armed probe instead.
  for (const leaf of result.blocked) {
    console.log(`[${leaf.id}] blockedBy=${leaf.blockedBy} probe=${leaf.probe?.type} passive=${leaf.probe?.passive}`)
    // budget-hops / cycle / parse-error are STATIC remedies: the probe type is
    // 'static-remedy' and running a runtime probe would tell you nothing. For
    // budget-hops the fix is a bigger `maxHops`, not runtime evidence.
    if (leaf.blockedBy === 'budget-hops') {
      console.log('  → re-run with a bigger maxHops; there is nothing to observe here')
    }
  }

  // Drill into a hop. `expand` returns a BOUNDED SUBTREE in one call — children included,
  // with `omittedChildren` / `complete` reporting anything the caps cut.
  if (result.hopIds.length > 0) {
    const subtree = result.expand(result.hopIds[0], { depth: 3, maxNodes: 100 })
    if (subtree && !subtree.complete) console.log('cut off:', subtree.omittedChildren, 'children')
    console.log('hop detail:', subtree)
  }
}

// Example: trace from a PageModel handle instead of a bare selector.
// NOTE: traceValue's `selector` is a real Playwright selector, while pm.anchor's is a
// page-path selector / exact locator string. Identical-looking arguments, opposite rules.
async function traceFromHandle() {
  const handle = await pm.anchor('[data-testid="cart-total"]', { page: state.page })
  if (!handle) return
  const result = await traceValue({ page: state.page, node: handle })
  console.log(result.render())
}

// Example: archetype 1 — mutating reducer. Prove an in-place store mutation.
async function proveMutatingReducer() {
  // storeIdentity captures the store-state ref, runs the action, re-captures.
  const result = await storeIdentity({
    page: state.page,
    action: async () => {
      await state.page.locator('button:has-text("Add to cart")').click()
    },
  })

  // CHECK `measured` FIRST. The un-measured arm carries NO sameReference field at all, so
  // "I never found your store" cannot be read as "your store produced a fresh reference".
  if (!result.measured) {
    console.log('not measured:', result.reason, '—', result.detail)
    console.log('probed:', result.tried)
    console.log('remedy:', result.remedy) // always names storeExpr
    console.log('the action still ran:', result.actionRan)
    return
  }

  // sameReference:true is the fingerprint of a reducer that mutates instead of returning
  // a fresh object, so React bails out of the re-render.
  console.log('verdict:', result.verdict, 'sameReference:', result.sameReference)
  console.log('discovered via', result.discovery.via, 'as', result.discovery.expr)
  console.log('keys whose reference changed:', result.changedKeys)
}

// Example: archetype 2 — cross-module util. Capture args via an entry logpoint.
async function captureUtilArgs() {
  // setLogpoint THROWS when `expr` cannot be assembled into a provably non-pausing
  // condition (a stray paren, an injected statement, a `debugger`). That refusal is the
  // point: a breakpoint that can pause reorders timers and destroys race hypotheses.
  try {
    await setLogpoint({ page: state.page, file: 'src/lib/format-money.ts', line: 12, expr: 'cents', tag: 'money', maxPayload: 500 })
  } catch (err) {
    console.log('logpoint refused:', (err as Error).message)
    return
  }

  await state.page.locator('button:has-text("Checkout")').click()

  // readLogpoints returns the ACCOUNTING, not a bare array. Iterate `read.hits`.
  const read = await readLogpoints({ page: state.page, tag: 'money', maxHits: 50, maxLen: 200 })
  for (const hit of read.hits) {
    console.log('formatMoney arg:', hit.tag, '=>', hit.value)
    if (hit.truncated) console.log('  (cut from', hit.truncated.originalLength, 'chars)')
    // A payload the page could not serialise is surfaced, never coerced to a plausible string.
    if (hit.malformed) console.log('  MALFORMED:', hit.malformed.reason, hit.malformed.raw)
  }
  // droppedHits > 0 means older hits fell outside the window — raise maxHits.
  console.log(`${read.hits.length}/${read.totalHits} hits, ${read.droppedHits} dropped, caps:`, read.caps)
  if (read.unparsableLines.length) console.log('unparsable marker lines:', read.unparsableLines)

  // Pass the cursor back to read only what arrived after this call.
  const later = await readLogpoints({ page: state.page, tag: 'money', sinceCursor: read.cursor })
  console.log('new hits since:', later.hits.length)
}

// Example: archetype 3 — async race. Passive timeline first, then force the race.
async function forceAsyncRace() {
  // Passive capture is non-perturbing and safe to auto-run. The controller is also in the
  // session probe REGISTRY, so dropping it no longer means recording nothing: net.read(id)
  // drains the entries from a later execute call.
  // `buffer` is the other way to keep entries: the probe pushes into THAT array in
  // place, so `state.cartCalls` is still filling up in the next execute() call.
  const cartCalls: NetEntry[] = []
  state.cartCalls = cartCalls
  const timeline = net.timeline({ page: state.page, urlPattern: '/api/cart', buffer: cartCalls })
  await state.page.locator('button:has-text("Add to cart")').click()
  await state.page.locator('button:has-text("Checkout")').click()
  console.log('request/response order:', timeline.entries())
  console.log('retention:', timeline.stats()) // a full buffer drops the OLDEST, visibly
  timeline.stop()

  // net.delay is PERTURBING — it holds matching requests so the race reproduces
  // deterministically. Three guarantees replace "remember to stop() it": a second
  // overlapping delay on the same page is REFUSED by name (pass force:true to take over),
  // it auto-expires after ttlMs (default 120s; 0 = unbounded), and it is registered so
  // every later traceValue warns while it is live.
  const hold = await net.delay({ page: state.page, urlPattern: '/api/cart', ms: 800, ttlMs: 30_000 })
  await state.page.locator('button:has-text("Checkout")').click()
  console.log('interception stats:', hold.stats())
  await hold.stop()
}

// Example: find and stop a probe you no longer hold a controller for
async function auditProbes() {
  // "Who perturbed my measurement?" now has an answer, including for stopped probes.
  for (const probe of net.active()) {
    console.log(probe.describe) // e.g. "net.delay#2 LIVE for 41s, auto-stops in 79s {...}"
  }
  for (const warning of net.warnings()) console.log('!', warning)

  const live = net.active({ live: true, kind: 'net.delay' })
  for (const probe of live) {
    // net.get(id) is the single-probe form: same accounting, null for an unknown id.
    console.log('before:', net.get(probe.id)?.describe)
    console.log('draining then stopping', probe.id, net.read(probe.id))
    await net.stop(probe.id)
    console.log('after:', net.get(probe.id)?.stoppedReason) // 'caller' — still readable
  }
  // Or stop everything this session armed:
  console.log('stopped:', await net.stopAll())
}

// Example: archetype 4 — stale effect deps / handler churn that defeats React.memo.
async function diffStaleEffect() {
  const loc = state.page.locator('[data-testid="live-price"]')

  // `identity: true` is what makes handler churn OBSERVABLE. Without it every function
  // serialises to the string `[function]` and two different arrows compare equal.
  const before = await fiberSnapshot({ locator: loc, identity: true, maxKeys: 80, maxDepth: 4 })
  await state.page.locator('button:has-text("Refresh")').click()
  const after = await fiberSnapshot({ locator: loc, identity: true })

  const diff = fiberDiff(before, after)
  console.log('same component:', diff.sameComponent)
  // Deep-equal but a NEW reference — exactly the props that defeat React.memo.
  console.log('identity churn:', diff.identityChangedKeys)
  for (const change of diff.changes) {
    console.log(` ${change.key}: ${change.kind}`, change.fn ? `fn ${change.fn.name}/${change.fn.arity}` : '')
  }
  // Props whose comparison could NOT be made. Never reported as unchanged.
  console.log('unobservable:', diff.unobservableKeys)
  console.log('unchanged:', diff.unchangedKeys.length, 'caps:', diff.caps)
}

// Example: re-run a pure sliced function in-process with captured args
async function replayPureFunction() {
  // `fn` must be an EXPRESSION (arrow / function expression). It runs in the NODE
  // EXECUTOR PROCESS: there is no window, no document, no page network. `console` is
  // VIRTUALISED (its calls come back in `logs`), so real sliced code that logs still
  // replays without weakening the gate on anything that can reach outside.
  const result = replayPure({
    fn: '(items) => { console.log("n", items.length); return items.reduce((s, i) => s + i.price * i.qty, 0) }',
    args: [[{ price: 10, qty: 2 }, { price: 5, qty: 1 }]],
  })
  if (result.ok) {
    console.log('replayed value:', result.value, 'logs:', result.logs)
  } else {
    console.log('refused at stage:', result.stage, result.reason)
    // Every offender comes with its source position and a verdict.
    for (const o of result.offending) console.log(` ${o.name} @${o.line}:${o.column} ${o.category} — ${o.why}`)
    // `admissible` can be supplied via bindings; `categoricallyUnsafe` never can.
    console.log('supply these via bindings:', result.admissible)
    console.log('nothing can supply these honestly:', result.categoricallyUnsafe)
  }

  // A closure capture or import IS admissible — pass the value in and it is injected.
  const withCapture = replayPure({
    fn: '(cents) => formatMoney(cents)',
    args: [1999],
    bindings: { formatMoney: (c: number) => `$${(c / 100).toFixed(2)}` },
  })
  console.log('with an injected binding:', withCapture.ok && withCapture.value)

  // An async sliced function needs the awaiting variant.
  const asyncResult = await replayPureAsync({ fn: 'async (n) => n * 2', args: [21] })
  console.log('async replay:', asyncResult.ok && asyncResult.value)
}

// Example: the purity gate on its own, before you commit to a replay
function checkPurity() {
  console.log(isPureFunctionSource('(a, b) => a + b')) // { pure: true, freeIdentifiers: [] }
  const verdict = isPureFunctionSource('() => window.__CONFIG__.rate * base', { allow: ['base'] })
  // `window` stays impure even though `base` was allowed: allowing an ambient IO surface
  // would make the replay silently diverge from the runtime being debugged.
  console.log(verdict.pure, verdict.reason, verdict.freeIdentifiers)
}

// Example: static analysis without traceValue's orchestration.
// `moduleGraph` hands back an OPAQUE HANDLE. The live graph holds Babel NodePaths and is
// never exposed — never try to return it; use `summary()` for the digest.
function analyseSourceDirectly() {
  const graph = moduleGraph({ root: '/abs/repo/root' })
  const summary = graph.summary()
  console.log(`${summary.indexedFileCount}/${summary.fileCount} files indexed`)
  // Callee resolution leaves large typed-unresolved buckets — read them before drawing
  // conclusions about "nothing calls this".
  console.log('unresolved call sites by reason:', summary.unresolvedByReason)
  for (const failure of summary.parseFailures) {
    console.log('PARSE FAILURE:', failure.file, failure.line, failure.message)
  }

  // "Never trust a const": constant means never REASSIGNED, not never mutated.
  const binding = inspectBinding({ file: '/abs/repo/root/src/cart.ts', graph, name: 'items' })
  if (binding.ok) {
    console.log('constant:', binding.constant, 'writes through it:', binding.writeSites)
    console.log('hazard:', binding.hazard, binding.hazards)
    // The one-step hop classification is included when a graph was passed.
    console.log('comes from:', binding.hop?.kind, binding.hop?.blockedBy)
  }

  // Constant-fold one reference. Returns a serialisable projection, never a NodePath.
  const folded = evaluateBinding({ code: 'const rate = 0.2 * 100; export default rate', name: 'rate' })
  console.log('confident:', folded.confident, 'value:', folded.value)

  // React exhaustive-deps over a whole FILE (the primitive wants a NodePath to one hook
  // call, which nothing outside the module can produce).
  const deps = findMissingDeps({ file: '/abs/repo/root/src/Cart.tsx', graph, withCodeFrames: true })
  for (const effect of deps.effects) {
    console.log(`${effect.hook} @${effect.effectLoc.line} is missing:`, effect.missing)
    if (effect.codeFrame) console.log(effect.codeFrame)
  }

  // The static backward slice on its own. `startExpr` is a variable NAME.
  const hop = backwardSlice({
    graph,
    startFile: '/abs/repo/root/src/cart.ts',
    startExpr: 'total',
    maxHops: 16,
  })
  // budget-hops means RAISE maxHops — it is not a runtime blind spot.
  if (hop.blockedBy === 'budget-hops') console.log('resume with:', hop.resumable)
  console.log('slice root:', hop.kind, hop.blockedBy, hop.note)
}

export {
  traceWrongTotal,
  traceFromHandle,
  proveMutatingReducer,
  captureUtilArgs,
  forceAsyncRace,
  auditProbes,
  diffStaleEffect,
  replayPureFunction,
  checkPurity,
  analyseSourceDirectly,
}

```