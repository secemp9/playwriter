import _traverse from '@babel/traverse'
import type { NodePath, Binding, BindingKind } from '@babel/traverse'
import { parse } from '@babel/parser'
import type {
  CallSite,
  ExportEntry,
  ExportResolution,
  ModuleGraph,
  ParseFailure,
  ReexportStep,
} from './module-graph.js'
import { renderCodeFrame } from './source-provenance.js'

// @babel/traverse is CJS with a double-default under ESM interop.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse

type BabelNode = { type: string; loc?: any } & Record<string, any>

// ---------------------------------------------------------------------------
// Shared types (M4 orchestrator depends on these exact shapes)
// ---------------------------------------------------------------------------

export interface Loc {
  file?: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

export interface Hazard {
  type: 'aliasing' | 'escape'
  loc: Loc
  /** Which mutation/escape pattern was matched — the reason this is a hazard. */
  pattern?: HazardPattern
  /** Set when the hazard was found through an alias of the traced binding. */
  viaAlias?: string
}

export type HazardPattern =
  | 'member-assign'
  | 'member-update'
  | 'member-delete'
  | 'mutating-method'
  | 'mutating-method-apply'
  | 'mutating-static-call'
  | 'call-argument'
  | 'returned'
  | 'stored-in-object'
  | 'assigned-into-member'

export interface BindingInfo {
  name: string
  kind: BindingKind
  declPath: NodePath | null
  referencePaths: NodePath[]
  constantViolations: NodePath[]
  constant: boolean
  binding: Binding | null
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
export type BlockedReason =
  | 'mutation'
  | 'unresolved-module'
  | 'interprocedural'
  | 'async'
  | 'dynamic'
  | 'parse-error'
  | 'budget-hops'
  | 'cycle'
  | null

export type HopKind =
  | 'root'
  | 'value'
  | 'constant'
  | 'writer'
  | 'module-export'
  | 'param-caller'
  /** A local binding whose initialiser only NAMES its value (`const x = imported`). */
  | 'alias'
  | 'blocked'

/** A stop the caller can lift by re-running with a bigger budget. */
export interface ResumableHint {
  option: 'maxHops' | 'maxBreadth'
  current: number
  suggested: number
}

/** A branch set that was cut short. A truncated branch that looks complete is a lie. */
export interface TruncationInfo {
  of: 'callers'
  shown: number
  total: number
  resumeWith: ResumableHint
}

/** What the callers of a parameter actually agreed (or failed to agree) on. */
export interface DivergenceInfo {
  agreement: 'convergent' | 'divergent' | 'unknown'
  /** One entry per explored caller, in `children` order. */
  candidates: {
    site: Loc | null
    confident: boolean
    value?: unknown
    blockedBy?: BlockedReason
  }[]
  /** Distinct confident values, JSON-rendered. Populated when `divergent`. */
  distinctValues?: string[]
  /**
   * The single value every explored caller supplied. Set only when
   * `agreement: 'convergent'` — i.e. the value is knowable regardless of which
   * caller was live. Deliberately NOT written to the hop's `evaluated`: that
   * field means "this subtree collapses, nothing below it matters", which is
   * false for a hop whose whole point is the caller branches underneath it.
   */
  agreedValue?: unknown
}

/**
 * A single step in a backward value-trace. Produced statically here; the M4
 * runtime orchestrator attaches live probes to the blocked leaves.
 */
export interface TraceHop {
  kind: HopKind
  site: Loc | null
  blockedBy: BlockedReason
  hazards: Hazard[]
  evaluated: { confident: boolean; value?: unknown } | null
  codeFrame?: string
  note?: string
  children?: TraceHop[]
  /** Set when a branch set was cut by `maxBreadth`. */
  truncated?: TruncationInfo
  /** Set when the stop is a budget stop, not a knowledge stop. */
  resumable?: ResumableHint
  /** Set on multi-caller parameter hops. */
  divergence?: DivergenceInfo
  /** Set when the dead end is a file the parser could not read. */
  parseError?: ParseFailure
  /** Re-export links followed to reach this hop's site. */
  reexportChain?: ReexportStep[]
  /** Where a `module-export` hop landed, after every re-export link. */
  resolved?: { file: string; exportName: string }
}

// Method names whose call mutates the receiver in place.
const MUTATING_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  'set',
  'add',
  'delete',
  'clear',
])

// Static helpers whose FIRST argument is mutated in place.
const MUTATING_STATIC_CALLS = new Map<string, Set<string>>([
  ['Object', new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'])],
  ['Reflect', new Set(['set', 'deleteProperty', 'defineProperty', 'setPrototypeOf'])],
])

// `.then` / `.catch` / `.finally` — a value produced inside one of these arrives
// after the synchronous frame has already returned.
const PROMISE_CHAIN_METHODS = new Set(['then', 'catch', 'finally'])

// `Promise.<x>()` forms that yield a promise.
const PROMISE_STATICS = new Set(['all', 'allSettled', 'race', 'any', 'resolve', 'reject'])

/**
 * Escapes that genuinely invalidate a statically-read value: some other frame
 * now holds the reference and may write through it, so folding the initialiser
 * would be a confident answer we cannot justify.
 *
 * `returned` is deliberately NOT here. Handing a value back to the caller says
 * nothing about what it WAS at this point — and for a parameter it says nothing
 * at all — so blocking on it would stop the walk on every `return x` in the
 * codebase. It is still reported in `hazards`, just not as a wall.
 */
const BLOCKING_ESCAPE_PATTERNS = new Set<HazardPattern>([
  'call-argument',
  'assigned-into-member',
  'stored-in-object',
])

// Aliases are followed a few hops so a destructured/renamed reference to a
// mutated object is still caught; past that the chain is pathological.
const MAX_ALIAS_DEPTH = 3

// Serialisation bounds for anything an agent might read.
const MAX_VALUE_STRING = 200
const MAX_VALUE_ITEMS = 20
const MAX_VALUE_DEPTH = 3

// ---------------------------------------------------------------------------
// Loc helpers
// ---------------------------------------------------------------------------

export function locOf(node: BabelNode | null | undefined, file?: string): Loc | null {
  if (!node || !node.loc) return null
  return {
    file,
    line: node.loc.start.line,
    column: node.loc.start.column,
    endLine: node.loc.end?.line,
    endColumn: node.loc.end?.column,
  }
}

function pathLoc(p: NodePath | null | undefined, file?: string): Loc | null {
  return p ? locOf(p.node as BabelNode, file) : null
}

/**
 * Reduce a `path.evaluate()` result to something that survives JSON and a token
 * budget. Babel can hand back arrays, plain objects and RegExps; a hop an agent
 * reads must never carry an unbounded or unserialisable payload.
 */
function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'string') {
    const s = value as string
    return s.length > MAX_VALUE_STRING ? `${s.slice(0, MAX_VALUE_STRING)}…(${s.length})` : s
  }
  if (t === 'number' || t === 'boolean' || t === 'undefined') return value
  if (t === 'bigint') return `${String(value)}n`
  if (t === 'function') return '[Function]'
  if (t === 'symbol') return String(value)
  if (value instanceof RegExp) return String(value)
  if (value instanceof Date) return value.toISOString()
  if (depth >= MAX_VALUE_DEPTH) return '[…]'
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_VALUE_ITEMS).map((v) => sanitizeValue(v, depth + 1))
    if (value.length > MAX_VALUE_ITEMS) out.push(`…(${value.length} items)`)
    return out
  }
  if (t === 'object') {
    const out: Record<string, unknown> = {}
    const keys = Object.keys(value as object)
    for (const k of keys.slice(0, MAX_VALUE_ITEMS)) {
      out[k] = sanitizeValue((value as Record<string, unknown>)[k], depth + 1)
    }
    if (keys.length > MAX_VALUE_ITEMS) out['…'] = `${keys.length} keys`
    return out
  }
  return String(value)
}

function evaluatedOf(probe: { confident: boolean; value?: unknown }): { confident: boolean; value?: unknown } | null {
  if (!probe.confident) return null
  return { confident: true, value: sanitizeValue(probe.value) }
}

function renderValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Parse / find helpers (handy for callers and tests)
// ---------------------------------------------------------------------------

export type ParsedFile = ReturnType<typeof parse>

export function parseModule(code: string, filename = 'inline.tsx'): ParsedFile {
  return parse(code, {
    sourceType: 'module',
    errorRecovery: true,
    sourceFilename: filename,
    plugins: ['jsx', 'typescript', 'decorators-legacy'],
  })
}

/** Depth-first search for the first NodePath matching `predicate`. */
export function findNodePath(
  ast: ParsedFile,
  predicate: (p: NodePath) => boolean,
): NodePath | null {
  let found: NodePath | null = null
  traverse(ast, {
    enter(p: NodePath) {
      if (found) {
        p.stop()
        return
      }
      if (predicate(p)) {
        found = p
        p.stop()
      }
    },
  })
  return found
}

/** DFS over a subtree that never descends into a nested function body. */
function findInSameFrame(root: NodePath, test: (p: NodePath) => boolean): NodePath | null {
  if (test(root)) return root
  let found: NodePath | null = null
  root.traverse({
    enter(p: NodePath) {
      if (found) {
        p.stop()
        return
      }
      // An `await` / `yield` inside a nested function belongs to THAT function,
      // not to the expression we are classifying.
      if (p.isFunction()) {
        p.skip()
        return
      }
      if (test(p)) {
        found = p
        p.stop()
      }
    },
  })
  return found
}

// ---------------------------------------------------------------------------
// analyzeBinding
// ---------------------------------------------------------------------------

/**
 * Read the scope binding for an identifier path into a plain, serialisable-ish
 * summary. `path` should be an Identifier (or any node exposing `.scope` and a
 * resolvable name).
 */
export function analyzeBinding(path: NodePath): BindingInfo {
  const name = (path.node as any)?.name ?? ''
  const binding = name ? path.scope.getBinding(name) ?? null : null
  return {
    name,
    kind: binding?.kind ?? 'unknown',
    declPath: binding?.path ?? null,
    referencePaths: binding?.referencePaths ?? [],
    constantViolations: binding?.constantViolations ?? [],
    constant: binding?.constant ?? false,
    binding,
  }
}

// ---------------------------------------------------------------------------
// aliasingHazard  (the non-negotiable check)
// ---------------------------------------------------------------------------

/**
 * Climb the member chain rooted at `ref` (`ref` -> `ref.a` -> `ref.a.b`) and
 * return its outermost link. Every in-place write to the referent goes through
 * one of these links, so mutation detection has to look at the whole chain and
 * not just `ref`'s immediate parent.
 */
function memberChain(ref: NodePath): { top: NodePath; depth: number; links: NodePath[] } {
  const links: NodePath[] = []
  let cur = ref
  while (
    cur.parentPath &&
    (cur.parentPath.isMemberExpression() || cur.parentPath.isOptionalMemberExpression()) &&
    (cur.parentPath.node as any).object === cur.node
  ) {
    cur = cur.parentPath
    links.push(cur)
  }
  return { top: cur, depth: links.length, links }
}

function staticPropertyName(member: BabelNode): string | null {
  if (member.computed) return null
  return member.property?.name ?? null
}

/** `Array.prototype.push.call(x, v)` / `[].splice.apply(x, a)` — x is mutated. */
function isPrototypeMutatorApply(call: NodePath | null | undefined, argNode: unknown): boolean {
  if (!call || !call.isCallExpression()) return false
  const callee = (call.node as any).callee
  if (callee?.type !== 'MemberExpression' || callee.computed) return false
  const invoke = callee.property?.name
  if (invoke !== 'call' && invoke !== 'apply') return false
  const inner = callee.object
  if (inner?.type !== 'MemberExpression' || inner.computed) return false
  if (!MUTATING_METHODS.has(inner.property?.name)) return false
  return (call.node as any).arguments?.[0] === argNode
}

/** `Object.assign(x, …)` / `Reflect.set(x, …)` — x is mutated. */
function mutatingStaticCall(call: NodePath | null | undefined, argNode: unknown): boolean {
  if (!call || !call.isCallExpression()) return false
  const callee = (call.node as any).callee
  if (callee?.type !== 'MemberExpression' || callee.computed) return false
  const objName = callee.object?.type === 'Identifier' ? callee.object.name : null
  const method = callee.property?.name
  if (!objName || !method) return false
  return !!MUTATING_STATIC_CALLS.get(objName)?.has(method) && (call.node as any).arguments?.[0] === argNode
}

interface HazardAccumulator {
  hazards: Hazard[]
  seen: Set<Binding>
}

function pushHazard(
  acc: HazardAccumulator,
  type: 'aliasing' | 'escape',
  pattern: HazardPattern,
  node: BabelNode,
  file: string | undefined,
  viaAlias?: string,
): void {
  const loc = locOf(node, file)
  if (!loc) return
  acc.hazards.push({ type, loc, pattern, ...(viaAlias ? { viaAlias } : {}) })
}

/**
 * Follow an alias the referent was handed to (`const { items } = state`,
 * `const items = state.items`, `let s; s = state`) and keep scanning. Without
 * this, the single most common real mutating reducer — destructure then push —
 * looks clean, because the mutation never mentions the traced binding by name.
 */
function scanAliasBinding(
  binding: Binding | null | undefined,
  file: string | undefined,
  depth: number,
  acc: HazardAccumulator,
  aliasName: string,
): void {
  if (!binding || depth > MAX_ALIAS_DEPTH) return
  if (acc.seen.has(binding)) return
  acc.seen.add(binding)
  scanReferences(binding.referencePaths, file, depth, acc, aliasName)
}

function aliasBindingsOfDeclarator(declarator: NodePath): { name: string; binding: Binding | null }[] {
  const ids = Object.keys(declarator.getOuterBindingIdentifiers?.() ?? {})
  return ids.map((name) => ({ name, binding: declarator.scope.getBinding(name) ?? null }))
}

function scanReferences(
  refs: NodePath[],
  file: string | undefined,
  depth: number,
  acc: HazardAccumulator,
  viaAlias?: string,
): void {
  for (const ref of refs) {
    const parent = ref.parentPath
    if (!parent) continue
    const { top, depth: chainDepth, links } = memberChain(ref)
    const topNode = top.node as BabelNode
    const topParent = top.parentPath
    const hazardNode = ref.node as BabelNode

    // (a) Any link of the chain is the receiver of a mutating method:
    //     `ref.push(v)`, `ref.items.push(v)`, `ref.a.b.sort()`.
    let mutated = false
    for (const link of links) {
      const call = link.parentPath
      if (
        call?.isCallExpression() &&
        (call.node as any).callee === link.node &&
        MUTATING_METHODS.has(staticPropertyName(link.node as BabelNode) ?? '')
      ) {
        pushHazard(acc, 'aliasing', 'mutating-method', hazardNode, file, viaAlias)
        mutated = true
        break
      }
    }
    if (mutated) continue

    // (b) The chain top is written through: `ref.x = v`, `ref.a.b = v`,
    //     `ref[i] = v`, `ref[i].x = v`.
    if (
      chainDepth > 0 &&
      topParent?.isAssignmentExpression() &&
      (topParent.node as any).left === topNode
    ) {
      pushHazard(acc, 'aliasing', 'member-assign', hazardNode, file, viaAlias)
      continue
    }
    // (c) `ref.count++` / `--ref.a.b`.
    if (chainDepth > 0 && topParent?.isUpdateExpression()) {
      pushHazard(acc, 'aliasing', 'member-update', hazardNode, file, viaAlias)
      continue
    }
    // (d) `delete ref.k` / `delete ref[k]`.
    if (
      chainDepth > 0 &&
      topParent?.isUnaryExpression() &&
      (topParent.node as any).operator === 'delete'
    ) {
      pushHazard(acc, 'aliasing', 'member-delete', hazardNode, file, viaAlias)
      continue
    }
    // (e) `Array.prototype.push.call(ref, v)` — mutation smuggled past the
    //     receiver position.
    if (isPrototypeMutatorApply(topParent, topNode)) {
      pushHazard(acc, 'aliasing', 'mutating-method-apply', hazardNode, file, viaAlias)
      continue
    }
    // (f) `Object.assign(ref, …)`, `Reflect.set(ref, …)`, `Object.defineProperty(ref, …)`.
    if (mutatingStaticCall(topParent, topNode)) {
      pushHazard(acc, 'aliasing', 'mutating-static-call', hazardNode, file, viaAlias)
      continue
    }

    // (g) Alias creation. Anything that gives the referent a second name has to
    //     be followed, or a mutation through that name is invisible here.
    if (topParent?.isVariableDeclarator() && (topParent.node as any).init === topNode) {
      for (const alias of aliasBindingsOfDeclarator(topParent)) {
        scanAliasBinding(alias.binding, file, depth + 1, acc, alias.name)
      }
      continue
    }
    if (
      topParent?.isAssignmentExpression() &&
      (topParent.node as any).right === topNode &&
      (topParent.node as any).left?.type === 'Identifier'
    ) {
      const name = (topParent.node as any).left.name
      scanAliasBinding(topParent.scope.getBinding(name), file, depth + 1, acc, name)
      continue
    }

    // (h) Escape. Two deliberate restrictions:
    //     - chain depth 0 only: the referent ITSELF leaving this frame is a
    //       hazard, while `f(ref.total)` is indistinguishable from an ordinary
    //       read without interprocedural effect analysis, and flagging every
    //       `console.log(a.b)` would drown the signal this check exists for.
    //     - never through an alias: we follow aliases to catch MUTATIONS of the
    //       referent, not to widen escapes. `const n = obj.count; return n`
    //       returns a copy of a primitive and says nothing about `obj`.
    if (chainDepth === 0 && depth === 0) {
      if (parent.isCallExpression() && (parent.node as any).arguments?.includes(ref.node)) {
        pushHazard(acc, 'escape', 'call-argument', hazardNode, file, viaAlias)
        continue
      }
      if (parent.isReturnStatement()) {
        pushHazard(acc, 'escape', 'returned', hazardNode, file, viaAlias)
        continue
      }
      if (
        parent.isAssignmentExpression() &&
        (parent.node as any).right === ref.node &&
        (parent.node as any).left?.type === 'MemberExpression'
      ) {
        pushHazard(acc, 'escape', 'assigned-into-member', hazardNode, file, viaAlias)
        continue
      }
      if (parent.isObjectProperty() && (parent.node as any).value === ref.node) {
        pushHazard(acc, 'escape', 'stored-in-object', hazardNode, file, viaAlias)
        continue
      }
    }
  }
}

export interface AliasingResult {
  /** Worst hazard found: `aliasing` outranks `escape`. Null when clean. */
  hazard: 'aliasing' | 'escape' | null
  /** Every hazard site, aliasing first. Kept for the existing M4 consumer. */
  sites: Loc[]
  /** Per-site hazards with their own type + matched pattern. */
  hazards: Hazard[]
  aliasingSites: Loc[]
  escapeSites: Loc[]
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
export function aliasingHazard(binding: BindingInfo, opts?: { file?: string }): AliasingResult {
  const acc: HazardAccumulator = { hazards: [], seen: new Set() }
  if (binding.binding) acc.seen.add(binding.binding)
  scanReferences(binding.referencePaths, opts?.file, 0, acc)

  const aliasing = acc.hazards.filter((h) => h.type === 'aliasing')
  const escapes = acc.hazards.filter((h) => h.type === 'escape')
  const ordered = [...aliasing, ...escapes]
  return {
    hazard: aliasing.length > 0 ? 'aliasing' : escapes.length > 0 ? 'escape' : null,
    sites: ordered.map((h) => h.loc),
    hazards: ordered,
    aliasingSites: aliasing.map((h) => h.loc),
    escapeSites: escapes.map((h) => h.loc),
  }
}

function hazardList(binding: BindingInfo, file?: string): Hazard[] {
  return aliasingHazard(binding, { file }).hazards
}

// ---------------------------------------------------------------------------
// probeValue
// ---------------------------------------------------------------------------

/**
 * Static constant-fold of an expression path via Babel's `path.evaluate()`.
 * When not confident, surfaces the deopt NodePath (the next hop pointer).
 *
 * `deoptPath` is an internal pointer — it must never reach a sandbox or a
 * TraceHop. Use `probeValueSerializable` for anything an agent reads.
 */
export function probeValue(path: NodePath): {
  confident: boolean
  value?: unknown
  deoptLoc?: Loc
  deoptPath?: NodePath
  deoptType?: string
} {
  const result = (path as any).evaluate() as { confident: boolean; value: any; deopt: NodePath | null }
  if (result.confident) {
    return { confident: true, value: result.value }
  }
  // Babel occasionally reports a deopt whose path has no node attached; a
  // pointer to nothing is worse than no pointer, so it is dropped.
  const deopt = result.deopt?.node ? result.deopt : null
  return {
    confident: false,
    deoptPath: deopt ?? undefined,
    deoptType: deopt ? (deopt.node as BabelNode).type : undefined,
    deoptLoc: deopt ? locOf(deopt.node as BabelNode) ?? undefined : undefined,
  }
}

export interface SerializableProbe {
  confident: boolean
  value?: unknown
  /** Where constant-folding gave up, and on what kind of node. */
  deoptLoc?: Loc
  deoptType?: string
}

/** `probeValue` with the NodePath projected away and the value bounded. */
export function probeValueSerializable(path: NodePath, file?: string): SerializableProbe {
  const probe = probeValue(path)
  if (probe.confident) return { confident: true, value: sanitizeValue(probe.value) }
  const loc = probe.deoptPath ? pathLoc(probe.deoptPath, file) : null
  return {
    confident: false,
    deoptLoc: loc ?? undefined,
    deoptType: probe.deoptType,
  }
}

// ---------------------------------------------------------------------------
// classifyDeopt
// ---------------------------------------------------------------------------

function enclosingFunction(binding: Binding): NodePath | null {
  const scopePath = binding.scope.path
  if (!scopePath) return null
  if (scopePath.isFunction()) return scopePath
  return scopePath.getFunctionParent?.() ?? scopePath
}

function functionNameOf(fnPath: NodePath | null): string | null {
  if (!fnPath) return null
  const node = fnPath.node as any
  if (node.id?.name) return node.id.name
  // Object / class methods name themselves through their key.
  if ((node.type === 'ObjectMethod' || node.type === 'ClassMethod') && node.key?.name) {
    return node.key.name
  }
  const parent = fnPath.parentPath
  if (parent?.isVariableDeclarator() && (parent.node as any).id?.type === 'Identifier') {
    return (parent.node as any).id.name
  }
  if (parent?.isObjectProperty() && (parent.node as any).key?.name) {
    return (parent.node as any).key.name
  }
  return null
}

// --- async boundary detection ----------------------------------------------

export type AsyncBoundaryKind =
  | 'await'
  | 'promise-chain'
  | 'promise-combinator'
  | 'promise-constructor'
  | 'async-call'
  | 'then-callback-param'
  | 'async-writer'
  | 'for-await'
  | 'yield'

export interface AsyncBoundary {
  kind: AsyncBoundaryKind
  site: Loc | null
  note: string
}

/** The `.then(cb)` / `.catch(cb)` / `.finally(cb)` call a function is the callback of. */
function promiseCallbackHost(fnPath: NodePath | null | undefined): { method: string; call: NodePath } | null {
  if (!fnPath) return null
  const call = fnPath.parentPath
  if (!call?.isCallExpression()) return null
  if (!(call.node as any).arguments?.includes(fnPath.node)) return null
  const callee = (call.node as any).callee
  if (callee?.type !== 'MemberExpression' || callee.computed) return null
  const method = callee.property?.name
  if (!method || !PROMISE_CHAIN_METHODS.has(method)) return null
  return { method, call }
}

function promiseChainMethodOf(node: BabelNode | null | undefined): string | null {
  let cur: any = node
  let guard = 0
  while (cur?.type === 'CallExpression' && guard++ < MAX_ALIAS_DEPTH * 4) {
    const callee = cur.callee
    if (callee?.type === 'MemberExpression' && !callee.computed) {
      const name = callee.property?.name
      if (name && PROMISE_CHAIN_METHODS.has(name)) return name
      cur = callee.object
      continue
    }
    return null
  }
  return null
}

function promiseStaticOf(node: BabelNode | null | undefined): string | null {
  if (node?.type !== 'CallExpression') return null
  const callee = node.callee
  if (callee?.type !== 'MemberExpression' || callee.computed) return null
  if (callee.object?.type !== 'Identifier' || callee.object.name !== 'Promise') return null
  const name = callee.property?.name
  return name && PROMISE_STATICS.has(name) ? name : null
}

/**
 * Decide whether the binding's value arrives across an asynchronous boundary,
 * and say WHICH one. This drives probe selection (`net.timeline` first, because
 * logpoints perturb races), so a wrong "async" is worse than an honest unknown —
 * every recogniser here must be a shape that genuinely defers a value.
 */
export function classifyAsyncBoundary(
  binding: BindingInfo,
  graph?: ModuleGraph,
  file?: string,
): AsyncBoundary | null {
  const decl = binding.declPath
  if (!decl) return null

  // A parameter of a promise-chain callback: `p.then(data => …)`. The value is
  // whatever the promise settled with, which no static read can supply.
  if (binding.kind === 'param' && binding.binding) {
    const fnPath = enclosingFunction(binding.binding)
    const host = promiseCallbackHost(fnPath)
    if (host) {
      return {
        kind: 'then-callback-param',
        site: pathLoc(host.call, file),
        note: `"${binding.name}" is the parameter of a .${host.method}() callback — its value is the settled promise result`,
      }
    }
    return null
  }

  // `for await (const chunk of stream)`.
  const forParent = decl.parentPath?.parentPath
  if (forParent?.isForOfStatement() && (forParent.node as any).await) {
    return {
      kind: 'for-await',
      site: pathLoc(forParent, file),
      note: `"${binding.name}" is bound by a for-await-of loop`,
    }
  }

  if (!decl.isVariableDeclarator()) return null
  const initPath = decl.get('init') as NodePath | undefined
  if (!initPath?.node) return null
  const init = initPath.node as BabelNode

  // `await` anywhere in the initialiser, not merely at the top:
  // `const n = (await load()).length`, `const n = a + await b()`.
  const awaitPath = findInSameFrame(initPath, (p) => p.isAwaitExpression())
  if (awaitPath) {
    return {
      kind: 'await',
      site: pathLoc(awaitPath, file),
      note: `"${binding.name}" is initialised from an awaited expression`,
    }
  }

  // A generator's `yield` result is supplied by whoever drives the iterator.
  const yieldPath = findInSameFrame(initPath, (p) => p.isYieldExpression())
  if (yieldPath) {
    return {
      kind: 'yield',
      site: pathLoc(yieldPath, file),
      note: `"${binding.name}" is initialised from a yield — the value comes from the iterator's driver`,
    }
  }

  const chain = promiseChainMethodOf(init)
  if (chain) {
    return {
      kind: 'promise-chain',
      site: pathLoc(initPath, file),
      note: `"${binding.name}" is the result of a .${chain}() chain`,
    }
  }

  const combinator = promiseStaticOf(init)
  if (combinator) {
    return {
      kind: 'promise-combinator',
      site: pathLoc(initPath, file),
      note: `"${binding.name}" is a Promise.${combinator}() result`,
    }
  }

  if (init.type === 'NewExpression' && init.callee?.type === 'Identifier' && init.callee.name === 'Promise') {
    return {
      kind: 'promise-constructor',
      site: pathLoc(initPath, file),
      note: `"${binding.name}" is a new Promise(...) — settled by its executor`,
    }
  }

  // Calling a function we can SEE is async: the binding holds a promise.
  if (graph && (init.type === 'CallExpression' || init.type === 'OptionalCallExpression')) {
    const resolved = graph.resolveCalleeOfCall(initPath, file)
    if (resolved.kind === 'resolved' && (resolved.isAsync || resolved.isGenerator)) {
      return {
        kind: 'async-call',
        site: pathLoc(initPath, file),
        note:
          `"${binding.name}" is the result of ${resolved.isGenerator ? 'generator' : 'async function'} ` +
          `"${resolved.name}" (${resolved.file})`,
      }
    }
  }

  return null
}

/** Every reassignment happens inside a promise callback -> the value lands late. */
function asyncWriterBoundary(binding: BindingInfo, file?: string): AsyncBoundary | null {
  if (binding.constantViolations.length === 0) return null
  let method: string | null = null
  for (const writer of binding.constantViolations) {
    const fn = writer.getFunctionParent?.()
    const host = promiseCallbackHost(fn)
    if (!host) return null
    method = host.method
  }
  return {
    kind: 'async-writer',
    site: pathLoc(binding.constantViolations[0], file),
    note:
      `"${binding.name}" is written only inside .${method}() callback(s) — ` +
      `every write lands after the synchronous frame returns`,
  }
}

/**
 * Turn a deopt point into a typed next step. Given the identifier `path` and its
 * analyzed `binding`, decide where the trace should hop next (or why it is
 * blocked). Returns the TraceHop shape reused by the M4 orchestrator.
 */
export function classifyDeopt(path: NodePath, binding: BindingInfo, graph: ModuleGraph): TraceHop {
  const file = graph.fileOf(path)
  const hazards = hazardList(binding, file)

  // Cross-module: resolve the import to the target export.
  if (binding.kind === 'module' && binding.declPath) {
    return classifyModuleBinding(path, binding, graph, file, hazards)
  }

  // Reassignment writers.
  if (binding.constantViolations.length > 0) {
    // …unless every write happens in a promise callback, in which case the
    // actionable fact is the ordering, not the assignment.
    const late = asyncWriterBoundary(binding, file)
    if (late) return asyncHop(late, hazards)
    const writer = binding.constantViolations[0]
    return {
      kind: 'writer',
      site: pathLoc(writer, file),
      blockedBy: 'mutation',
      hazards,
      evaluated: null,
      note: `binding "${binding.name}" reassigned at ${binding.constantViolations.length} site(s)`,
    }
  }

  // Constant-but-mutated. A PROVEN in-place write outranks everything below:
  // it is the mutating-reducer trap and the most actionable finding there is.
  const proven = hazards.filter((h) => h.type === 'aliasing')
  if (proven.length > 0) return mutationHop(binding, proven, hazards)

  // Async/promise boundary, checked before both the escape hazards and the
  // parameter branch. An escape is speculative (we cannot see what the callee
  // does), while an async arrival is a definite fact about WHERE the value comes
  // from — and a `.then` callback's parameter is an async arrival, not an
  // interprocedural unknown. The three prescribe different probes.
  const boundary = classifyAsyncBoundary(binding, graph, file)
  if (boundary) return asyncHop(boundary, hazards)

  // Parameter: hop into the caller(s). This outranks the escape check below —
  // a parameter that also escapes still has a caller worth reading, and the
  // escape travels along on the hop's `hazards` either way.
  if (binding.kind === 'param') {
    return classifyParam(binding, graph, file, hazards)
  }

  // Escape-only hazards. These must preempt the constant-fold below: a value
  // another frame holds a reference to may have been written since, so folding
  // its initialiser would be a confident answer we cannot justify.
  const escaped = hazards.filter((h) => h.pattern && BLOCKING_ESCAPE_PATTERNS.has(h.pattern))
  if (escaped.length > 0) return mutationHop(binding, escaped, hazards)

  // Directly constant-foldable value.
  if (binding.declPath) {
    const init = binding.declPath.get('init') as NodePath | undefined
    if (init && init.node) {
      const probe = probeValue(init)
      if (probe.confident) {
        return {
          kind: 'value',
          site: pathLoc(init, file),
          blockedBy: null,
          hazards,
          evaluated: evaluatedOf(probe),
        }
      }
    }
  }

  // Local alias of something nameable. Checked after the fold (a foldable alias
  // chain collapses to its value for free) and before `dynamic`, because
  // `dynamic` would tell the agent to go get runtime evidence for a value that
  // is sitting in another file.
  const alias = aliasContinuation(binding, graph, file)
  if (alias) {
    return {
      kind: 'alias',
      site: pathLoc(alias.path, alias.file),
      blockedBy: null,
      hazards,
      evaluated: null,
      note: alias.note,
    }
  }

  // Unknown / dynamic.
  return {
    kind: 'blocked',
    site: pathLoc(binding.declPath, file) ?? pathLoc(path, file),
    blockedBy: 'dynamic',
    hazards,
    evaluated: null,
    note: `binding "${binding.name}" is dynamic (kind: ${binding.kind})`,
  }
}

function mutationHop(binding: BindingInfo, culprits: Hazard[], hazards: Hazard[]): TraceHop {
  const patterns = [...new Set(culprits.map((h) => h.pattern).filter(Boolean))].join(', ')
  const alias = culprits.find((h) => h.viaAlias)?.viaAlias
  return {
    kind: 'blocked',
    site: culprits[0].loc,
    blockedBy: 'mutation',
    hazards,
    evaluated: null,
    note:
      `binding "${binding.name}" is constant but ${culprits[0].type === 'aliasing' ? 'mutated in place' : 'escapes this frame'}` +
      ` (${patterns})` +
      (alias ? ` — reached through alias "${alias}"` : ''),
  }
}

function asyncHop(boundary: AsyncBoundary, hazards: Hazard[]): TraceHop {
  return {
    kind: 'blocked',
    site: boundary.site,
    blockedBy: 'async',
    hazards,
    evaluated: null,
    note: `async boundary (${boundary.kind}): ${boundary.note}`,
  }
}

function importInfoOf(binding: BindingInfo): { source: string; imported: string } | null {
  const decl = binding.declPath
  if (!decl) return null
  const node = decl.node as any
  const importDecl = decl.parentPath?.node as any
  const source: string | undefined = importDecl?.source?.value
  if (!source) return null
  if (node.type === 'ImportDefaultSpecifier') return { source, imported: 'default' }
  if (node.type === 'ImportNamespaceSpecifier') return { source, imported: '*' }
  if (node.type === 'ImportSpecifier') {
    const imported = node.imported?.name ?? node.imported?.value ?? node.local?.name
    return { source, imported }
  }
  return null
}

function describeChain(chain: ReexportStep[]): string {
  if (chain.length === 0) return ''
  return ` via ${chain.map((s) => `${s.source}${s.via === 'star' ? ' (export *)' : ''}`).join(' -> ')}`
}

/**
 * The value expression an export entry points at — the thing worth folding or
 * hopping into. For `export const x = …` that is the declarator init; for
 * `export { local }` it is whatever `local` is bound to in that file.
 */
function exportValuePath(graph: ModuleGraph, file: string, entry: ExportEntry): NodePath | null {
  const p = entry.path
  if (p && typeof (p as any).isVariableDeclaration === 'function' && p.isVariableDeclaration()) {
    const decls = p.get('declarations') as NodePath[]
    return (decls[0]?.get('init') as NodePath | undefined) ?? null
  }
  if (entry.node?.type === 'Identifier') {
    const binding = graph.moduleBinding(file, entry.node.name)
    const declPath = binding?.path
    if (declPath?.isVariableDeclarator()) return (declPath.get('init') as NodePath) ?? null
    return declPath ?? null
  }
  if (p && (p as any).node) return p
  return null
}

function classifyModuleBinding(
  path: NodePath,
  binding: BindingInfo,
  graph: ModuleGraph,
  file: string | undefined,
  hazards: Hazard[],
): TraceHop {
  const info = importInfoOf(binding)
  if (!info || !file) {
    return unresolvedModule(binding, file, hazards)
  }
  const target = graph.resolve(file, info.source)
  if (!('file' in target)) {
    return {
      kind: 'blocked',
      site: pathLoc(binding.declPath, file),
      blockedBy: 'unresolved-module',
      hazards,
      evaluated: null,
      note:
        target.reason === 'bare-specifier'
          ? `import "${info.source}" is an external / blackboxed dependency`
          : `import "${info.source}" does not resolve to any file on disk (broken path)`,
    }
  }

  // Follow re-export links to the real definition. The chain was already being
  // recorded; abandoning it there was the whole defect.
  const resolution = graph.resolveExport(target.file, info.imported)
  const at = pathLoc(binding.declPath, file)

  switch (resolution.kind) {
    case 'found': {
      const valuePath = exportValuePath(graph, resolution.file, resolution.entry)
      let evaluated: { confident: boolean; value?: unknown } | null = null
      if (valuePath?.node && typeof (valuePath as any).evaluate === 'function') {
        evaluated = evaluatedOf(probeValue(valuePath))
      }
      return {
        kind: 'module-export',
        site: resolution.entry.loc ?? locOf(resolution.entry.node, resolution.file),
        blockedBy: null,
        hazards,
        evaluated,
        note:
          `resolved import "${info.imported}" from "${info.source}"` +
          `${describeChain(resolution.chain)} -> ${resolution.file}` +
          (resolution.name !== info.imported ? ` (renamed to "${resolution.name}")` : ''),
        resolved: { file: resolution.file, exportName: resolution.name },
        ...(resolution.chain.length ? { reexportChain: resolution.chain } : {}),
      }
    }
    case 'namespace':
      return {
        kind: 'module-export',
        site: at,
        blockedBy: null,
        hazards,
        evaluated: null,
        note:
          `"${binding.name}" is the namespace object of ${resolution.file}` +
          `${describeChain(resolution.chain)} — trace a specific member instead`,
        ...(resolution.chain.length ? { reexportChain: resolution.chain } : {}),
      }
    case 'external':
      return {
        kind: 'blocked',
        site: at,
        blockedBy: 'unresolved-module',
        hazards,
        evaluated: null,
        note:
          `re-export chain for "${info.imported}"${describeChain(resolution.chain)} ` +
          `leaves the project at "${resolution.specifier}" (imported by ${resolution.fromFile})`,
        ...(resolution.chain.length ? { reexportChain: resolution.chain } : {}),
      }
    case 'parse-error':
      if (resolution.failure.severity === 'unreadable') {
        return {
          kind: 'blocked',
          site: at,
          blockedBy: 'unresolved-module',
          hazards,
          evaluated: null,
          note:
            `import "${info.source}"${describeChain(resolution.chain)} resolved to ` +
            `${resolution.failure.file}, which could not be read: ${resolution.failure.message}`,
          ...(resolution.chain.length ? { reexportChain: resolution.chain } : {}),
        }
      }
      return parseErrorHop(resolution.failure, at, hazards, resolution.chain, info.imported)
    case 'ambiguous':
      return {
        kind: 'blocked',
        site: at,
        blockedBy: 'unresolved-module',
        hazards,
        evaluated: null,
        note:
          `export "${resolution.name}" is AMBIGUOUS in ${resolution.file}: supplied by ` +
          `${resolution.candidates.map((c) => `${c.file}#${c.name}`).join(' and ')} ` +
          `via separate "export *" links — the module spec makes this an error, so no single definition can be chosen`,
        ...(resolution.chain.length ? { reexportChain: resolution.chain } : {}),
      }
    case 'cycle':
      return {
        kind: 'blocked',
        site: at,
        blockedBy: 'cycle',
        hazards,
        evaluated: null,
        note:
          `re-export chain for "${info.imported}" is CYCLIC and was broken at ` +
          `${resolution.file}#${resolution.name}${describeChain(resolution.chain)}`,
        ...(resolution.chain.length ? { reexportChain: resolution.chain } : {}),
      }
    case 'not-found':
      if (resolution.parseDiagnostic) {
        return parseErrorHop(resolution.parseDiagnostic, at, hazards, resolution.chain, info.imported)
      }
      return {
        kind: 'blocked',
        site: at,
        blockedBy: 'unresolved-module',
        hazards,
        evaluated: null,
        note:
          `export "${resolution.name}" not found in ${resolution.file}` +
          `${describeChain(resolution.chain)}` +
          (resolution.searchedStars.length
            ? ` (also searched ${resolution.searchedStars.length} "export *" link(s): ${resolution.searchedStars.join(', ')})`
            : ''),
        ...(resolution.chain.length ? { reexportChain: resolution.chain } : {}),
      }
  }
}

function parseErrorHop(
  failure: ParseFailure,
  at: Loc | null,
  hazards: Hazard[],
  chain: ReexportStep[],
  imported: string,
): TraceHop {
  const where = `${failure.file}:${failure.line ?? '?'}:${failure.column ?? '?'}`
  return {
    kind: 'blocked',
    site: at,
    blockedBy: 'parse-error',
    hazards,
    evaluated: null,
    parseError: failure,
    note:
      `cannot resolve "${imported}" because ${where} FAILED TO PARSE ` +
      `(${failure.severity}): ${failure.message}${describeChain(chain)} — ` +
      `no runtime probe helps here; fix the source file`,
    ...(chain.length ? { reexportChain: chain } : {}),
  }
}

function unresolvedModule(binding: BindingInfo, file: string | undefined, hazards: Hazard[]): TraceHop {
  return {
    kind: 'blocked',
    site: pathLoc(binding.declPath, file),
    blockedBy: 'unresolved-module',
    hazards,
    evaluated: null,
    note: `could not resolve module binding "${binding.name}"`,
  }
}

// --- parameter / caller analysis -------------------------------------------

interface ParamCallers {
  fnPath: NodePath | null
  fnName: string | null
  paramIndex: number
  /** Set when the parameter is destructured out of the argument. */
  paramProperty: string | null
  callers: CallSite[]
  /** Argument path per caller, aligned with `callers`. Null when not passed. */
  argPaths: (NodePath | null)[]
}

/**
 * Locate the parameter position for `binding` by CONTAINMENT, not by name
 * equality: `function f({ userId })` binds `userId` inside param 0, and a
 * name-only search reports -1 and gives up on a resolvable hop.
 */
function paramIndexOf(fnPath: NodePath | null, binding: BindingInfo): { index: number; property: string | null } {
  const params: BabelNode[] = ((fnPath?.node as any)?.params ?? []) as BabelNode[]
  const declNode = binding.binding?.identifier ?? null
  for (let i = 0; i < params.length; i++) {
    const param = params[i]
    if (!param) continue
    if (param.type === 'Identifier' && param.name === binding.name) return { index: i, property: null }
    if (declNode && subtreeContains(param, declNode)) {
      return { index: i, property: destructuredPropertyName(param, binding.name) }
    }
  }
  return { index: -1, property: null }
}

function subtreeContains(root: BabelNode | null | undefined, target: object, depth = 0): boolean {
  if (!root || depth > 12) return false
  if ((root as object) === target) return true
  for (const key of Object.keys(root)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const v = (root as any)[key]
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object' && subtreeContains(item, target, depth + 1)) return true
      }
    } else if (v && typeof v === 'object' && typeof (v as any).type === 'string') {
      if (subtreeContains(v, target, depth + 1)) return true
    }
  }
  return false
}

/** For `{ a }` / `{ a: local }` patterns, the source property name of `local`. */
function destructuredPropertyName(pattern: BabelNode, localName: string): string | null {
  if (pattern.type === 'AssignmentPattern') return destructuredPropertyName(pattern.left, localName)
  if (pattern.type !== 'ObjectPattern') return null
  for (const prop of pattern.properties ?? []) {
    if (prop.type !== 'ObjectProperty') continue
    if (prop.value?.type === 'Identifier' && prop.value.name === localName) {
      return prop.key?.name ?? prop.key?.value ?? null
    }
    if (prop.value?.type === 'AssignmentPattern' && prop.value.left?.type === 'Identifier' && prop.value.left.name === localName) {
      return prop.key?.name ?? prop.key?.value ?? null
    }
  }
  return null
}

/** The argument expression a given caller supplies for this parameter. */
function argumentForParam(site: CallSite, info: ParamCallers): NodePath | null {
  const args = site.args
  const arg = args[info.paramIndex] ?? null
  if (!arg?.node) return null
  if (!info.paramProperty) return arg
  // Destructured parameter: resolve the property out of an object literal
  // argument rather than pretending the whole object is the value.
  if (arg.isObjectExpression()) {
    for (const prop of arg.get('properties') as NodePath[]) {
      const node = prop.node as any
      if (node.type !== 'ObjectProperty' || node.computed) continue
      const key = node.key?.name ?? node.key?.value
      if (key === info.paramProperty) return prop.get('value') as NodePath
    }
  }
  return null
}

/** Index of `localName` inside an array-destructuring pattern, or -1. */
function destructuredElementIndex(pattern: BabelNode, localName: string): number {
  if (pattern.type === 'AssignmentPattern') return destructuredElementIndex(pattern.left, localName)
  if (pattern.type !== 'ArrayPattern') return -1
  const els = pattern.elements ?? []
  for (let i = 0; i < els.length; i++) {
    const el = els[i]
    if (!el) continue
    if (el.type === 'Identifier' && el.name === localName) return i
    if (el.type === 'AssignmentPattern' && el.left?.type === 'Identifier' && el.left.name === localName) return i
  }
  return -1
}

function objectPropertyValuePath(objPath: NodePath | null | undefined, key: string): NodePath | null {
  if (!objPath || !objPath.isObjectExpression()) return null
  for (const prop of objPath.get('properties') as NodePath[]) {
    const n = prop.node as any
    if (n.type !== 'ObjectProperty' || n.computed) continue
    if ((n.key?.name ?? n.key?.value) === key) return (prop.get('value') as NodePath) ?? null
  }
  return null
}

function arrayElementPath(arrPath: NodePath | null | undefined, index: number): NodePath | null {
  if (!arrPath || !arrPath.isArrayExpression()) return null
  const els = arrPath.get('elements') as NodePath[]
  const el = els[index]
  return el?.node ? el : null
}

/**
 * The expression a name ultimately points at, following local aliases and
 * import/re-export chains across files. Used to reach INTO a definition (to
 * project a destructured property), not to walk the trace — the trace walks one
 * link per hop so every link stays visible and budgeted.
 */
function definitionValuePath(
  graph: ModuleGraph,
  idPath: NodePath,
  file: string | undefined,
  depth = 0,
): { path: NodePath; file: string | undefined } | null {
  if (depth > MAX_ALIAS_DEPTH) return null
  const name = (idPath.node as any)?.name
  if (!name || !idPath.scope.getBinding(name)) return null
  const info = analyzeBinding(idPath)

  if (info.kind === 'module') {
    const imp = importInfoOf(info)
    if (!imp || !file || imp.imported === '*') return null
    const target = graph.resolve(file, imp.source)
    if (!('file' in target)) return null
    const res = graph.resolveExport(target.file, imp.imported)
    if (res.kind !== 'found') return null
    const vp = exportValuePath(graph, res.file, res.entry)
    if (!vp?.node) return null
    // The export may itself only name its value: `export const obj = other`.
    if (vp.isIdentifier()) return definitionValuePath(graph, vp, res.file, depth + 1)
    return { path: vp, file: res.file }
  }

  const decl = info.declPath
  if (decl?.isVariableDeclarator()) {
    const init = decl.get('init') as NodePath | undefined
    if (!init?.node) return null
    if (init.isIdentifier()) return definitionValuePath(graph, init, file, depth + 1)
    return { path: init, file }
  }
  return null
}

/** `import * as ns from './m'; ns.thing` -> the definition of `thing` in m. */
function namespaceMemberValuePath(
  graph: ModuleGraph,
  objPath: NodePath,
  property: string,
  file: string | undefined,
): { path: NodePath; file: string } | null {
  const info = analyzeBinding(objPath)
  if (info.kind !== 'module' || !file) return null
  const imp = importInfoOf(info)
  if (!imp || imp.imported !== '*') return null
  const target = graph.resolve(file, imp.source)
  if (!('file' in target)) return null
  const res = graph.resolveExport(target.file, property)
  if (res.kind !== 'found') return null
  const vp = exportValuePath(graph, res.file, res.entry)
  return vp?.node ? { path: vp, file: res.file } : null
}

export interface AliasContinuation {
  path: NodePath
  file: string | undefined
  note: string
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
export function aliasContinuation(
  binding: BindingInfo,
  graph: ModuleGraph,
  file: string | undefined,
): AliasContinuation | null {
  const decl = binding.declPath
  if (!decl?.isVariableDeclarator()) return null
  const initPath = decl.get('init') as NodePath | undefined
  if (!initPath?.node) return null
  const id = (decl.node as any).id

  // (A) `const top = mid` — continue at the name it points at. That reference
  //     may be an import, a param, or another local alias; the next hop decides.
  if (id?.type === 'Identifier' && initPath.isIdentifier()) {
    const target = (initPath.node as any).name
    if (!initPath.scope.getBinding(target)) return null
    return { path: initPath, file, note: `"${binding.name}" is a local alias of "${target}"` }
  }

  // (B) `const y = ns.thing` / `const y = cfg.thing`
  if (id?.type === 'Identifier' && initPath.isMemberExpression() && !(initPath.node as any).computed) {
    const property = (initPath.node as any).property?.name
    const objPath = initPath.get('object') as NodePath
    if (!property || !objPath.isIdentifier()) return null
    const objName = (objPath.node as any).name
    const viaNamespace = namespaceMemberValuePath(graph, objPath, property, file)
    if (viaNamespace) {
      return {
        path: viaNamespace.path,
        file: viaNamespace.file,
        note: `"${binding.name}" is "${property}" of namespace import "${objName}"`,
      }
    }
    const def = definitionValuePath(graph, objPath, file)
    const value = objectPropertyValuePath(def?.path, property)
    if (value) {
      return {
        path: value,
        file: def!.file,
        note: `"${binding.name}" is property "${property}" of "${objName}"`,
      }
    }
    return null
  }

  // (C) `const { a: x } = imported` / `const [first] = imported`. Hopping into
  //     the whole object would be a WRONG answer, so this only continues when
  //     the property can actually be projected out of a literal definition.
  if ((id?.type === 'ObjectPattern' || id?.type === 'ArrayPattern') && initPath.isIdentifier()) {
    const objName = (initPath.node as any).name
    const def = definitionValuePath(graph, initPath, file)
    if (!def) return null
    if (id.type === 'ObjectPattern') {
      const key = destructuredPropertyName(id, binding.name)
      const value = key ? objectPropertyValuePath(def.path, key) : null
      if (value) {
        return {
          path: value,
          file: def.file,
          note: `"${binding.name}" is property "${key}" destructured from "${objName}"`,
        }
      }
    } else {
      const index = destructuredElementIndex(id, binding.name)
      const value = index >= 0 ? arrayElementPath(def.path, index) : null
      if (value) {
        return {
          path: value,
          file: def.file,
          note: `"${binding.name}" is element #${index} destructured from "${objName}"`,
        }
      }
    }
    return null
  }

  return null
}

function paramCallersOf(binding: BindingInfo, graph: ModuleGraph, file: string | undefined): ParamCallers {
  const fnPath = binding.binding ? enclosingFunction(binding.binding) : null
  const fnName = functionNameOf(fnPath)
  const { index, property } = paramIndexOf(fnPath, binding)
  // Identity-keyed: two files each defining `format()` no longer share a bucket,
  // so a one-caller function is never mistaken for an ambiguous one.
  const callers = index >= 0 ? graph.callersOfFunction(fnPath, file) : []
  const info: ParamCallers = {
    fnPath,
    fnName,
    paramIndex: index,
    paramProperty: property,
    callers,
    argPaths: [],
  }
  info.argPaths = callers.map((site) => argumentForParam(site, info))
  return info
}

function paramLabel(info: ParamCallers, binding: BindingInfo): string {
  const named = info.fnName ? `of "${info.fnName}"` : 'of an anonymous function'
  const prop = info.paramProperty ? ` (destructured as "${info.paramProperty}" from argument #${info.paramIndex})` : ''
  return `parameter "${binding.name}" ${named}${prop}`
}

function classifyParam(
  binding: BindingInfo,
  graph: ModuleGraph,
  file: string | undefined,
  hazards: Hazard[],
): TraceHop {
  const info = paramCallersOf(binding, graph, file)

  if (info.paramIndex < 0) {
    return {
      kind: 'blocked',
      site: pathLoc(binding.declPath, file),
      blockedBy: 'interprocedural',
      hazards,
      evaluated: null,
      note: `${paramLabel(info, binding)} — could not locate the parameter position`,
    }
  }

  if (info.callers.length === 0) {
    return {
      kind: 'blocked',
      site: pathLoc(binding.declPath, file),
      blockedBy: 'interprocedural',
      hazards,
      evaluated: null,
      note:
        `${paramLabel(info, binding)} has no resolvable caller in the indexed source ` +
        `(it may be called dynamically, exported for external use, or used as a callback)`,
    }
  }

  if (info.callers.length === 1) {
    const arg = info.argPaths[0]
    return {
      kind: 'param-caller',
      site: arg ? pathLoc(arg, info.callers[0].file) : info.callers[0].loc,
      blockedBy: null,
      hazards,
      evaluated: null,
      note: `single-caller salvage: ${paramLabel(info, binding)} called once; hop into argument #${info.paramIndex}`,
    }
  }

  // Multiple callers is a BRANCH, not a wall: backwardSlice explores them as
  // sibling children. The hop still names the blind spot, because which caller
  // was live during the symptom is not a static fact — but the candidate values
  // are all enumerated below it, and if they converge the block is lifted.
  return {
    kind: 'param-caller',
    site: pathLoc(binding.declPath, file),
    blockedBy: 'interprocedural',
    hazards,
    evaluated: null,
    note: `${paramLabel(info, binding)} has ${info.callers.length} resolved callers`,
  }
}

// ---------------------------------------------------------------------------
// exhaustiveDeps  (the stale-effect check)
// ---------------------------------------------------------------------------

const REACTIVE_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useCallback', 'useMemo', 'useInsertionEffect'])

function isUseStateSetter(binding: Binding): boolean {
  const p = binding.path
  if (!p) return false
  // The binding identifier must be the 2nd element of an array pattern whose
  // declarator initialises from useState / useReducer.
  const declarator = p.isVariableDeclarator() ? p : p.findParent((x) => x.isVariableDeclarator())
  if (!declarator) return false
  const id = (declarator.node as any).id
  const init = (declarator.node as any).init
  if (id?.type !== 'ArrayPattern') return false
  if (init?.type !== 'CallExpression') return false
  const calleeName = init.callee?.type === 'Identifier' ? init.callee.name : undefined
  if (calleeName !== 'useState' && calleeName !== 'useReducer') return false
  const setterEl = id.elements[1]
  return setterEl?.type === 'Identifier' && setterEl.name === binding.identifier?.name
}

/**
 * For a `useEffect` / `useCallback` / `useMemo` CallExpression path, compute the
 * reactive free variables referenced in the callback that are missing from the
 * dependency array. useState/useReducer setters are treated as stable and
 * excluded, matching the react-hooks lint rule.
 */
export function exhaustiveDeps(effectPath: NodePath): { missing: string[]; effectLoc: Loc } {
  const node = effectPath.node as any
  const effectLoc = locOf(node) ?? { line: 0, column: 0 }
  const empty = { missing: [], effectLoc }
  if (!effectPath.isCallExpression()) return empty

  const callback = effectPath.get('arguments.0') as NodePath | undefined
  if (!callback || !(callback.isArrowFunctionExpression() || callback.isFunctionExpression())) {
    return empty
  }

  // Declared dependency names.
  const depsArg = effectPath.get('arguments.1') as NodePath | undefined
  const declaredDeps = new Set<string>()
  if (depsArg && depsArg.isArrayExpression()) {
    for (const el of depsArg.get('elements') as NodePath[]) {
      if (el && el.isIdentifier()) declaredDeps.add((el.node as any).name)
      else if (el && el.isMemberExpression()) {
        // Track the root object name for `foo.bar` style deps.
        let root: any = el.node
        while (root?.type === 'MemberExpression') root = root.object
        if (root?.type === 'Identifier') declaredDeps.add(root.name)
      }
    }
  }

  const cbScope = callback.scope
  const programScope = cbScope.getProgramParent()
  const missing = new Set<string>()

  callback.traverse({
    Identifier(p: NodePath) {
      if (!p.isReferencedIdentifier()) return
      const name = (p.node as any).name
      if (declaredDeps.has(name) || missing.has(name)) return
      const binding = p.scope.getBinding(name)
      if (!binding) return
      // Skip module/global-scope bindings (imports, module-level consts/fns).
      if (binding.scope === programScope) return
      // Skip anything declared inside the callback itself (locals / params).
      if (binding.scope === cbScope || isDescendantScope(binding.scope, cbScope)) return
      // Skip stable useState/useReducer setters.
      if (isUseStateSetter(binding)) return
      missing.add(name)
    },
  })

  return { missing: [...missing], effectLoc }
}

function isDescendantScope(scope: any, ancestor: any): boolean {
  let s = scope
  while (s) {
    if (s === ancestor) return true
    s = s.parent
  }
  // ancestor never seen walking up from scope -> check the other direction:
  // is `scope` strictly below `ancestor`?
  return false
}

// ---------------------------------------------------------------------------
// backwardSlice
// ---------------------------------------------------------------------------

interface HopTarget {
  path: NodePath
  file: string | undefined
  code: string
}

interface SliceFrame {
  file: string | undefined
  code: string
}

/**
 * Where a non-terminal hop continues, and how many candidates existed before
 * `maxBreadth` cut the list.
 */
function hopTargets(
  hop: TraceHop,
  binding: BindingInfo,
  graph: ModuleGraph,
  file: string | undefined,
  maxBreadth: number,
): { targets: HopTarget[]; total: number } {
  if (hop.kind === 'param-caller') {
    const info = paramCallersOf(binding, graph, file)
    const targets: HopTarget[] = []
    for (let i = 0; i < info.callers.length; i++) {
      const arg = info.argPaths[i]
      if (!arg?.node) continue
      const callerFile = info.callers[i].file
      targets.push({
        path: arg,
        file: callerFile,
        code: graph.getFile(callerFile)?.code ?? '',
      })
    }
    return { targets: targets.slice(0, maxBreadth), total: targets.length }
  }
  if (hop.kind === 'alias') {
    const cont = aliasContinuation(binding, graph, file)
    if (!cont?.path?.node) return { targets: [], total: 0 }
    return {
      targets: [
        { path: cont.path, file: cont.file, code: (cont.file ? graph.getFile(cont.file)?.code : '') ?? '' },
      ],
      total: 1,
    }
  }
  if (hop.kind === 'module-export' && !hop.evaluated?.confident && hop.resolved) {
    // A resolved-but-unfoldable export is not a dead end: continue inside the
    // defining file. Stopping here was how re-export chains "resolved" to null.
    const targetFile = hop.resolved.file
    const entry = graph.exportsByFile.get(targetFile)?.get(hop.resolved.exportName)
    const valuePath = entry ? exportValuePath(graph, targetFile, entry) : null
    if (!valuePath?.node) return { targets: [], total: 0 }
    return {
      targets: [
        {
          path: valuePath,
          file: targetFile,
          code: graph.getFile(targetFile)?.code ?? '',
        },
      ],
      total: 1,
    }
  }
  return { targets: [], total: 0 }
}

/** Stable identity for cycle detection: the AST node itself. */
function nodeIdentity(path: NodePath): object {
  return path.node as unknown as object
}

function nodeLabel(path: NodePath, file: string | undefined): string {
  const loc = pathLoc(path, file)
  return `${file ?? '<unknown file>'}:${loc?.line ?? '?'}:${loc?.column ?? '?'}`
}

export interface BackwardSliceOptions {
  graph: ModuleGraph
  startFile: string
  startExpr: string | NodePath
  maxHops?: number
  maxBreadth?: number
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
export function backwardSlice({
  graph,
  startFile,
  startExpr,
  maxHops = 8,
  maxBreadth = 3,
}: BackwardSliceOptions): TraceHop {
  let startPath: NodePath | null
  let code = ''
  if (typeof startExpr === 'string') {
    const mod = graph.getFile(startFile)
    if (!mod) {
      const failure = graph.parseFailures.get(startFile)
      // Only a file that EXISTS but will not parse is a parse-error. A path that
      // is simply not there is a different problem with a different fix.
      if (failure && failure.severity !== 'unreadable') {
        return {
          kind: 'blocked',
          site: failure.line != null ? { file: failure.file, line: failure.line, column: failure.column ?? 0 } : null,
          blockedBy: 'parse-error',
          hazards: [],
          evaluated: null,
          parseError: failure,
          note:
            `start file ${failure.file}:${failure.line ?? '?'}:${failure.column ?? '?'} FAILED TO PARSE ` +
            `(${failure.severity}): ${failure.message} — fix the source file; no probe helps`,
        }
      }
      return {
        kind: 'blocked',
        site: null,
        blockedBy: 'dynamic',
        hazards: [],
        evaluated: null,
        note: `file not found: ${startFile}`,
      }
    }
    code = mod.code
    startPath = findNodePath(
      mod.ast,
      (p) => p.isReferencedIdentifier() && (p.node as any).name === startExpr,
    )
    if (!startPath) {
      startPath = findNodePath(mod.ast, (p) => p.isIdentifier() && (p.node as any).name === startExpr)
    }
  } else {
    startPath = startExpr
    code = graph.getFile(startFile)?.code ?? ''
  }

  if (!startPath) {
    return {
      kind: 'blocked',
      site: null,
      blockedBy: 'dynamic',
      hazards: [],
      evaluated: null,
      note: `start expression "${String(startExpr)}" not found`,
    }
  }

  const withFrame = (hop: TraceHop, srcCode: string): TraceHop => {
    if (hop.site && srcCode && !hop.codeFrame) {
      try { hop.codeFrame = renderCodeFrame({ code: srcCode, loc: hop.site, message: hop.note }) }
      catch { /* code-frame is best-effort; never crash the trace on rendering */ }
    }
    return hop
  }

  /**
   * `expanding` is the CURRENT ancestor chain, not a global visited set. A cycle
   * is re-entering a node we are already inside (recursion, mutual recursion);
   * two sibling branches legitimately reaching the same node is not one, and
   * treating it as one is how a global set fabricates dead ends. Node object
   * identity is exactly (file, node): each file has its own AST, so no two files
   * can share a node.
   */
  function expand(path: NodePath, frame: SliceFrame, depth: number, expanding: Set<object>): TraceHop {
    const identity = nodeIdentity(path)

    if (expanding.has(identity)) {
      return withFrame(
        {
          kind: 'blocked',
          site: pathLoc(path, frame.file),
          blockedBy: 'cycle',
          hazards: [],
          evaluated: null,
          note: `cycle broken: already expanding ${nodeLabel(path, frame.file)} on this path (recursive definition)`,
        },
        frame.code,
      )
    }

    if (depth >= maxHops) {
      const suggested = Math.max(maxHops * 2, maxHops + 4)
      return withFrame(
        {
          kind: 'blocked',
          site: pathLoc(path, frame.file),
          blockedBy: 'budget-hops',
          hazards: [],
          evaluated: null,
          resumable: { option: 'maxHops', current: maxHops, suggested },
          note:
            `hop budget exhausted at depth ${depth} (maxHops=${maxHops}) — RESUMABLE: ` +
            `this is NOT a runtime blind spot; re-run with maxHops >= ${suggested} to continue`,
        },
        frame.code,
      )
    }

    const nextExpanding = new Set(expanding)
    nextExpanding.add(identity)

    // Confident constant-fold collapses immediately.
    const probe = probeValue(path)
    if (probe.confident) {
      return withFrame(
        {
          kind: 'value',
          site: pathLoc(path, frame.file),
          blockedBy: null,
          hazards: [],
          evaluated: evaluatedOf(probe),
          note: 'constant',
        },
        frame.code,
      )
    }

    // Resolve the identifier binding and classify the next step.
    const idPath = path.isIdentifier() ? path : (probe.deoptPath ?? path)
    if (!idPath.isIdentifier()) {
      return withFrame(
        {
          kind: 'blocked',
          site: pathLoc(idPath, frame.file),
          blockedBy: 'dynamic',
          hazards: [],
          evaluated: null,
          note: `constant-folding stopped at a ${(idPath.node as BabelNode).type} that is not a named binding`,
        },
        frame.code,
      )
    }

    const binding = analyzeBinding(idPath)
    const hop = classifyDeopt(idPath, binding, graph)

    // Terminal blind spots that cannot be continued.
    if (hop.blockedBy && hop.kind !== 'param-caller') return withFrame(hop, frame.code)
    if (hop.kind === 'value') return withFrame(hop, frame.code)

    const { targets, total } = hopTargets(hop, binding, graph, frame.file, maxBreadth)

    // Record the cut BEFORE bailing out: `maxBreadth: 0` throws every branch
    // away, and a hop that dropped all of them must not look like a hop that
    // never had any.
    if (total > targets.length) {
      const truncation: TruncationInfo = {
        of: 'callers',
        shown: targets.length,
        total,
        resumeWith: { option: 'maxBreadth', current: maxBreadth, suggested: total },
      }
      hop.truncated = truncation
      hop.resumable = truncation.resumeWith
      hop.note =
        `${hop.note ?? ''} — TRUNCATED: showing ${targets.length} of ${total} callers; ` +
        `RESUMABLE: re-run with maxBreadth >= ${total} to see the rest`
      if (targets.length === 0) hop.blockedBy = 'interprocedural'
    }

    if (targets.length === 0) {
      if ((hop.kind === 'module-export' || hop.kind === 'alias') && !hop.evaluated) {
        // Resolved to a definition we cannot fold and cannot descend into. A
        // non-blocked leaf carrying no value would be a silent dead end.
        hop.blockedBy = 'dynamic'
        hop.note = `${hop.note ?? ''} — the target value is not statically foldable`
      }
      return withFrame(hop, frame.code)
    }

    const children = targets.map((t) =>
      expand(t.path, { file: t.file, code: t.code }, depth + 1, nextExpanding),
    )
    hop.children = children

    if (hop.kind === 'param-caller') mergeCallerBranches(hop, children, total)

    return withFrame(hop, frame.code)
  }

  return expand(startPath, { file: startFile, code }, 0, new Set())
}

/**
 * Reconcile what the explored callers said. Divergence between callers is very
 * often the bug itself, so it is surfaced rather than resolved by picking one;
 * agreement, on the other hand, means the value is knowable regardless of which
 * caller was live, and the interprocedural block is genuinely lifted.
 */
function mergeCallerBranches(hop: TraceHop, children: TraceHop[], total: number): void {
  const candidates: DivergenceInfo['candidates'] = children.map((child) => ({
    site: child.site,
    confident: !!child.evaluated?.confident,
    ...(child.evaluated?.confident ? { value: child.evaluated.value } : {}),
    ...(child.blockedBy ? { blockedBy: child.blockedBy } : {}),
  }))

  const allConfident = children.length > 0 && children.every((c) => c.evaluated?.confident)
  const distinct = [...new Set(children.filter((c) => c.evaluated?.confident).map((c) => renderValue(c.evaluated!.value)))]
  const complete = total === children.length

  if (allConfident && distinct.length === 1 && complete) {
    // Every caller agrees, so which one was live does not matter: the
    // interprocedural block is genuinely lifted, not merely papered over.
    hop.divergence = {
      agreement: 'convergent',
      candidates,
      agreedValue: children[0].evaluated!.value,
    }
    hop.blockedBy = null
    hop.note = `${hop.note ?? ''} — CONVERGENT: all ${children.length} caller(s) supply ${distinct[0]}`
    return
  }
  if (distinct.length > 1) {
    hop.divergence = { agreement: 'divergent', candidates, distinctValues: distinct }
    hop.blockedBy = 'interprocedural'
    hop.note =
      `${hop.note ?? ''} — DIVERGENT: callers supply ${distinct.length} different values ` +
      `(${distinct.join(' | ')}); which one was live is not a static fact`
    return
  }
  // Nothing to reconcile: at most one caller produced a confident value and the
  // rest are blocked leaves of their own. Only claim an interprocedural blind
  // spot when there really is a choice the static pass cannot make.
  hop.divergence = {
    agreement: 'unknown',
    candidates,
    ...(distinct.length ? { distinctValues: distinct } : {}),
    ...(allConfident && distinct.length === 1 && complete ? { agreedValue: children[0].evaluated!.value } : {}),
  }
  if (children.length > 1 || !complete) hop.blockedBy = 'interprocedural'
}

// ---------------------------------------------------------------------------
// Sandbox-facing façades
//
// The NodePath-level primitives above cannot cross a sandbox boundary: they take
// and return live Babel objects. These wrappers are addressed by file/code + a
// name, and return only bounded, JSON-safe data.
// ---------------------------------------------------------------------------

interface SourceRef {
  /** Inline source. Mutually exclusive with `file`. */
  code?: string
  /** Absolute path of a file already in (or reachable from) `graph`. */
  file?: string
  graph?: ModuleGraph
}

function resolveSource(ref: SourceRef): { ast: ParsedFile; code: string; file?: string } | { error: string } {
  if (ref.code != null) {
    try {
      return { ast: parseModule(ref.code, ref.file ?? 'inline.tsx'), code: ref.code, file: ref.file }
    } catch (e) {
      return { error: `could not parse inline code: ${(e as Error).message}` }
    }
  }
  if (!ref.file) return { error: 'pass either `code` or `file`' }
  if (ref.graph) {
    const mod = ref.graph.getFile(ref.file)
    if (!mod) {
      const failure = ref.graph.parseFailures.get(ref.file)
      return {
        error: failure
          ? `${failure.file}:${failure.line ?? '?'}:${failure.column ?? '?'} failed to parse: ${failure.message}`
          : `file not found in graph: ${ref.file}`,
      }
    }
    return { ast: mod.ast, code: mod.code, file: ref.file }
  }
  return { error: 'pass a `graph` alongside `file`, or pass `code`' }
}

export interface BindingReport {
  ok: boolean
  error?: string
  name: string
  kind: string
  /** Babel's notion: never reassigned. Says NOTHING about writes through it. */
  constant: boolean
  declSite: Loc | null
  referenceCount: number
  writeSites: Loc[]
  hazard: 'aliasing' | 'escape' | null
  hazards: Hazard[]
  /** One-step classification of where the value comes from. */
  hop?: TraceHop
}

/**
 * Sandbox entry point for `analyzeBinding` + `aliasingHazard` + `classifyDeopt`:
 * "tell me everything about this binding" in one bounded, serialisable answer.
 * `occurrence` picks among repeated names (0 = first reference).
 */
export function inspectBinding(
  opts: SourceRef & { name: string; occurrence?: number },
): BindingReport {
  const empty: BindingReport = {
    ok: false,
    name: opts.name,
    kind: 'unknown',
    constant: false,
    declSite: null,
    referenceCount: 0,
    writeSites: [],
    hazard: null,
    hazards: [],
  }
  const src = resolveSource(opts)
  if ('error' in src) return { ...empty, error: src.error }

  const wanted = opts.occurrence ?? 0
  let seen = 0
  const idPath = findNodePath(src.ast, (p: NodePath) => {
    if (!p.isIdentifier() || (p.node as any).name !== opts.name) return false
    const referenced = (p as NodePath).isReferencedIdentifier()
    if (!referenced && !p.scope.getBinding(opts.name)) return false
    return seen++ === wanted
  })
  if (!idPath) {
    return { ...empty, error: `no occurrence #${wanted} of "${opts.name}" with a resolvable binding` }
  }

  const info = analyzeBinding(idPath)
  const haz = aliasingHazard(info, { file: src.file })
  const report: BindingReport = {
    ok: true,
    name: info.name,
    kind: String(info.kind),
    constant: info.constant,
    declSite: pathLoc(info.declPath, src.file),
    referenceCount: info.referencePaths.length,
    writeSites: info.constantViolations.map((p) => pathLoc(p, src.file)).filter((l): l is Loc => !!l),
    hazard: haz.hazard,
    hazards: haz.hazards,
  }
  if (opts.graph) {
    const hop = classifyDeopt(idPath, info, opts.graph)
    // Children are never populated by a single-step classification, and a hop is
    // already JSON-safe, so this is handed straight through.
    report.hop = hop
  }
  return report
}

/**
 * Sandbox entry point for `probeValue`: constant-fold the `occurrence`-th
 * expression matching `expr` (an identifier name) and report the fold or the
 * deopt position — never a NodePath.
 */
export function evaluateBinding(
  opts: SourceRef & { name: string; occurrence?: number },
): SerializableProbe & { ok: boolean; error?: string; site?: Loc } {
  const src = resolveSource(opts)
  if ('error' in src) return { ok: false, confident: false, error: src.error }
  const wanted = opts.occurrence ?? 0
  let seen = 0
  const idPath = findNodePath(src.ast, (p) => {
    if (!p.isReferencedIdentifier() || (p.node as any).name !== opts.name) return false
    return seen++ === wanted
  })
  if (!idPath) return { ok: false, confident: false, error: `no reference #${wanted} to "${opts.name}"` }
  return { ok: true, site: pathLoc(idPath, src.file) ?? undefined, ...probeValueSerializable(idPath, src.file) }
}

export interface MissingDepsReport {
  ok: boolean
  error?: string
  effects: { hook: string; effectLoc: Loc; missing: string[]; codeFrame?: string }[]
}

/**
 * Sandbox entry point for `exhaustiveDeps`: scan a whole file for reactive hooks
 * whose dependency array is missing a reactive value it reads. This is the shape
 * the check needed to be reachable at all — the primitive wants a NodePath to a
 * specific hook call, which nothing outside this module can produce.
 */
export function findMissingDeps(
  opts: SourceRef & { hooks?: string[]; max?: number; withCodeFrames?: boolean },
): MissingDepsReport {
  const src = resolveSource(opts)
  if ('error' in src) return { ok: false, error: src.error, effects: [] }
  const hooks = new Set(opts.hooks ?? REACTIVE_HOOKS)
  const max = opts.max ?? 25
  const effects: MissingDepsReport['effects'] = []

  traverse(src.ast, {
    CallExpression(p: NodePath) {
      if (effects.length >= max) {
        p.stop()
        return
      }
      const callee = (p.node as any).callee
      const name =
        callee?.type === 'Identifier'
          ? callee.name
          : callee?.type === 'MemberExpression' && !callee.computed
            ? callee.property?.name
            : undefined
      if (!name || !hooks.has(name)) return
      const result = exhaustiveDeps(p)
      if (result.missing.length === 0) return
      const effectLoc: Loc = { ...result.effectLoc, file: src.file }
      const entry: MissingDepsReport['effects'][number] = {
        hook: name,
        effectLoc,
        missing: result.missing,
      }
      if (opts.withCodeFrames) {
        try {
          entry.codeFrame = renderCodeFrame({
            code: src.code,
            loc: effectLoc,
            message: `missing deps: ${result.missing.join(', ')}`,
          })
        } catch { /* best effort */ }
      }
      effects.push(entry)
    },
  })

  return { ok: true, effects }
}

// ---------------------------------------------------------------------------
// isPureFunctionSource  (M4 replayPure gate)
// ---------------------------------------------------------------------------

/**
 * Globals a replayable function may reference without being considered impure.
 * Deliberately excludes ambient state / IO surfaces (window, document, fetch,
 * localStorage, process, require, …) — a reference to any of those means the
 * function depends on the environment and must NOT be replayed in-process.
 */
const SAFE_REPLAY_GLOBALS = new Set([
  'Math',
  'JSON',
  'Object',
  'Array',
  'Number',
  'String',
  'Boolean',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Symbol',
  'BigInt',
  'Promise',
  'Error',
  'TypeError',
  'RangeError',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'decodeURIComponent',
  'structuredClone',
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
])

export interface PurityResult {
  pure: boolean
  reason?: string
  freeIdentifiers: string[]
}

/**
 * Decide whether a function's SOURCE is pure enough to replay in-process: it may
 * only reference its own params/locals and a whitelist of safe globals. Any free
 * identifier outside the whitelist (a captured closure variable, `window`,
 * `fetch`, an imported binding, …) makes it impure — replaying it would either
 * throw or silently diverge from the real runtime.
 */
export function isPureFunctionSource(src: string, opts?: { allow?: string[] }): PurityResult {
  const allow = new Set([...SAFE_REPLAY_GLOBALS, ...(opts?.allow ?? [])])
  let ast: ParsedFile
  try {
    ast = parseModule(`(${src.trim()})`, 'replay.tsx')
  } catch (e) {
    return { pure: false, reason: `unparseable function source: ${(e as Error).message}`, freeIdentifiers: [] }
  }
  const free = new Set<string>()
  traverse(ast, {
    ReferencedIdentifier(p: NodePath) {
      const name = (p.node as any).name as string
      if (allow.has(name)) return
      if (p.scope.getBinding(name)) return
      free.add(name)
    },
  })
  if (free.size > 0) {
    return {
      pure: false,
      reason: `references free identifier(s): ${[...free].join(', ')}`,
      freeIdentifiers: [...free],
    }
  }
  return { pure: true, freeIdentifiers: [] }
}
