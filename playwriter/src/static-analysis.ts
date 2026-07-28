import _traverse from '@babel/traverse'
import type { NodePath, Binding, BindingKind } from '@babel/traverse'
import { parse } from '@babel/parser'
import type { ModuleGraph } from './module-graph.js'
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
}

export interface BindingInfo {
  name: string
  kind: BindingKind
  declPath: NodePath | null
  referencePaths: NodePath[]
  constantViolations: NodePath[]
  constant: boolean
  binding: Binding | null
}

export type BlockedReason =
  | 'mutation'
  | 'unresolved-module'
  | 'interprocedural'
  | 'async'
  | 'dynamic'
  | null

export type HopKind =
  | 'root'
  | 'value'
  | 'constant'
  | 'writer'
  | 'module-export'
  | 'param-caller'
  | 'blocked'

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

function isObjectAssignCallee(callee: BabelNode): boolean {
  return (
    callee?.type === 'MemberExpression' &&
    callee.object?.type === 'Identifier' &&
    callee.object.name === 'Object' &&
    callee.property?.type === 'Identifier' &&
    callee.property.name === 'assign'
  )
}

/**
 * Flag whether any reference to `binding` mutates the referent in place
 * (aliasing) or lets it escape (escape). A `constant: true` binding with a
 * hazard MUST still be reported, so a mutating reducer is never mistaken for a
 * genuine constant.
 */
export function aliasingHazard(binding: BindingInfo): { hazard: 'aliasing' | 'escape' | null; sites: Loc[] } {
  const aliasingSites: Loc[] = []
  const escapeSites: Loc[] = []
  const file = undefined

  for (const ref of binding.referencePaths) {
    const parent = ref.parentPath
    if (!parent) continue

    // (a) object of an assigned MemberExpression: `ref.x = ...`
    if (
      parent.isMemberExpression() &&
      (parent.node as any).object === ref.node &&
      parent.parentPath?.isAssignmentExpression() &&
      (parent.parentPath.node as any).left === parent.node
    ) {
      aliasingSites.push(locOf(ref.node as BabelNode, file)!)
      continue
    }

    // (b) receiver of a mutating method anywhere up a member chain rooted at
    // `ref`: `ref.push(...)`, `ref.items.push(...)`, etc.
    let mutatedByCall = false
    let cur: NodePath = ref
    while (cur.parentPath?.isMemberExpression() && (cur.parentPath.node as any).object === cur.node) {
      const member = cur.parentPath
      const call = member.parentPath
      if (
        call?.isCallExpression() &&
        (call.node as any).callee === member.node &&
        (member.node as any).property?.type === 'Identifier' &&
        MUTATING_METHODS.has((member.node as any).property.name) &&
        !(member.node as any).computed
      ) {
        mutatedByCall = true
        break
      }
      cur = cur.parentPath
    }
    if (mutatedByCall) {
      aliasingSites.push(locOf(ref.node as BabelNode, file)!)
      continue
    }

    // Object.assign(ref, ...) — ref is the mutated target (first argument).
    if (
      parent.isCallExpression() &&
      isObjectAssignCallee((parent.node as any).callee) &&
      (parent.node as any).arguments[0] === ref.node
    ) {
      aliasingSites.push(locOf(ref.node as BabelNode, file)!)
      continue
    }

    // (c) escape: passed as a call argument.
    if (parent.isCallExpression() && (parent.node as any).arguments.includes(ref.node)) {
      escapeSites.push(locOf(ref.node as BabelNode, file)!)
      continue
    }
    // returned.
    if (parent.isReturnStatement()) {
      escapeSites.push(locOf(ref.node as BabelNode, file)!)
      continue
    }
    // assigned into another object: `other.x = ref` (ref on the RHS).
    if (
      parent.isAssignmentExpression() &&
      (parent.node as any).right === ref.node &&
      (parent.node as any).left?.type === 'MemberExpression'
    ) {
      escapeSites.push(locOf(ref.node as BabelNode, file)!)
      continue
    }
    // stored as an object-literal property value: `{ k: ref }`.
    if (parent.isObjectProperty() && (parent.node as any).value === ref.node) {
      escapeSites.push(locOf(ref.node as BabelNode, file)!)
      continue
    }
  }

  if (aliasingSites.length > 0) {
    return { hazard: 'aliasing', sites: [...aliasingSites, ...escapeSites] }
  }
  if (escapeSites.length > 0) {
    return { hazard: 'escape', sites: escapeSites }
  }
  return { hazard: null, sites: [] }
}

function hazardList(binding: BindingInfo): Hazard[] {
  const { hazard, sites } = aliasingHazard(binding)
  if (!hazard) return []
  return sites.map((loc) => ({ type: hazard, loc }))
}

// ---------------------------------------------------------------------------
// probeValue
// ---------------------------------------------------------------------------

/**
 * Static constant-fold of an expression path via Babel's `path.evaluate()`.
 * When not confident, surfaces the deopt NodePath (the next hop pointer).
 */
export function probeValue(path: NodePath): {
  confident: boolean
  value?: unknown
  deoptLoc?: Loc
  deoptPath?: NodePath
} {
  const result = (path as any).evaluate() as { confident: boolean; value: any; deopt: NodePath | null }
  if (result.confident) {
    return { confident: true, value: result.value }
  }
  const deopt = result.deopt ?? null
  return {
    confident: false,
    deoptPath: deopt ?? undefined,
    deoptLoc: deopt ? locOf(deopt.node as BabelNode) ?? undefined : undefined,
  }
}

// ---------------------------------------------------------------------------
// classifyDeopt
// ---------------------------------------------------------------------------

function enclosingFunction(binding: Binding): NodePath | null {
  const scopePath = binding.scope.path
  return scopePath && scopePath.isFunction() ? scopePath : scopePath ?? null
}

function functionNameOf(fnPath: NodePath | null): string | null {
  if (!fnPath) return null
  const node = fnPath.node as any
  if (node.id?.name) return node.id.name
  const parent = fnPath.parentPath
  if (parent?.isVariableDeclarator() && (parent.node as any).id?.type === 'Identifier') {
    return (parent.node as any).id.name
  }
  return null
}

function isAsyncBoundary(binding: BindingInfo): boolean {
  const decl = binding.declPath
  if (!decl) return false
  const init = (decl.node as any).init
  if (init?.type === 'AwaitExpression') return true
  // Value is the resolution of a promise chain: `const x = p.then(...)`.
  if (
    init?.type === 'CallExpression' &&
    init.callee?.type === 'MemberExpression' &&
    init.callee.property?.type === 'Identifier' &&
    (init.callee.property.name === 'then' || init.callee.property.name === 'catch')
  ) {
    return true
  }
  return false
}

/**
 * Turn a deopt point into a typed next step. Given the identifier `path` and its
 * analyzed `binding`, decide where the trace should hop next (or why it is
 * blocked). Returns the TraceHop shape reused by the M4 orchestrator.
 */
export function classifyDeopt(path: NodePath, binding: BindingInfo, graph: ModuleGraph): TraceHop {
  const file = graph.fileOf(path)
  const hazards = hazardList(binding)

  // Cross-module: resolve the import to the target export.
  if (binding.kind === 'module' && binding.declPath) {
    return classifyModuleBinding(path, binding, graph, file, hazards)
  }

  // Reassignment writers.
  if (binding.constantViolations.length > 0) {
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

  // Constant-but-mutated (aliasing/escape hazard on an otherwise-const binding).
  if (hazards.length > 0) {
    return {
      kind: 'blocked',
      site: hazards[0].loc,
      blockedBy: 'mutation',
      hazards,
      evaluated: null,
      note: `binding "${binding.name}" is constant but mutated in place`,
    }
  }

  // Parameter: single-caller salvage, else interprocedural block.
  if (binding.kind === 'param') {
    return classifyParam(binding, graph, file, hazards)
  }

  // Async/promise boundary.
  if (isAsyncBoundary(binding)) {
    return {
      kind: 'blocked',
      site: pathLoc(binding.declPath, file),
      blockedBy: 'async',
      hazards,
      evaluated: null,
      note: `binding "${binding.name}" crosses an async/promise boundary`,
    }
  }

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
          evaluated: { confident: true, value: probe.value },
        }
      }
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
      note: `import "${info.source}" is external / blackboxed`,
    }
  }
  const exportMap = graph.exportsByFile.get(target.file)
  const entry = exportMap?.get(info.imported)
  if (!entry) {
    return {
      kind: 'blocked',
      site: pathLoc(binding.declPath, file),
      blockedBy: 'unresolved-module',
      hazards,
      evaluated: null,
      note: `export "${info.imported}" not found in ${target.file}`,
    }
  }
  // Try to constant-fold the target export's value.
  let evaluated: { confident: boolean; value?: unknown } | null = null
  if (entry.path) {
    const valuePath = entry.path.isVariableDeclaration()
      ? ((entry.path.get('declarations') as NodePath[])[0]?.get('init') as NodePath | undefined)
      : entry.path
    if (valuePath && valuePath.node && typeof (valuePath as any).evaluate === 'function') {
      const probe = probeValue(valuePath)
      if (probe.confident) evaluated = { confident: true, value: probe.value }
    }
  }
  return {
    kind: 'module-export',
    site: entry.loc,
    blockedBy: null,
    hazards,
    evaluated,
    note: `resolved import "${info.imported}" from "${info.source}" -> ${target.file}`,
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

function classifyParam(
  binding: BindingInfo,
  graph: ModuleGraph,
  file: string | undefined,
  hazards: Hazard[],
): TraceHop {
  const fnPath = enclosingFunction(binding.binding!)
  const fnName = functionNameOf(fnPath)
  const params: BabelNode[] = ((fnPath?.node as any)?.params ?? []) as BabelNode[]
  const paramIndex = params.findIndex((p) => p?.type === 'Identifier' && (p as any).name === binding.name)
  const callers = fnName ? graph.callSites.get(fnName) ?? [] : []

  if (callers.length === 1 && paramIndex >= 0) {
    const arg = callers[0].args[paramIndex]
    return {
      kind: 'param-caller',
      site: arg ? pathLoc(arg, callers[0].file) : callers[0].loc,
      blockedBy: null,
      hazards,
      evaluated: null,
      note: `single-caller salvage: "${fnName}" called once; hop into argument #${paramIndex}`,
    }
  }

  return {
    kind: 'blocked',
    site: pathLoc(binding.declPath, file),
    blockedBy: 'interprocedural',
    hazards,
    evaluated: null,
    note: fnName
      ? `parameter "${binding.name}" of "${fnName}" has ${callers.length} callers`
      : `parameter "${binding.name}" of an anonymous function`,
  }
}

// ---------------------------------------------------------------------------
// exhaustiveDeps  (the stale-effect check)
// ---------------------------------------------------------------------------

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
export function backwardSlice({
  graph,
  startFile,
  startExpr,
  maxHops = 8,
  maxBreadth = 3,
}: {
  graph: ModuleGraph
  startFile: string
  startExpr: string | NodePath
  maxHops?: number
  maxBreadth?: number
}): TraceHop {
  let startPath: NodePath | null
  let code = ''
  if (typeof startExpr === 'string') {
    const mod = graph.getFile(startFile)
    if (!mod) {
      return { kind: 'blocked', site: null, blockedBy: 'dynamic', hazards: [], evaluated: null, note: `file not found: ${startFile}` }
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

  const seen = new Set<NodePath>()

  const withFrame = (hop: TraceHop, srcCode: string): TraceHop => {
    if (hop.site && srcCode && !hop.codeFrame) {
      try { hop.codeFrame = renderCodeFrame({ code: srcCode, loc: hop.site, message: hop.note }) }
      catch { /* code-frame is best-effort; never crash the trace on rendering */ }
    }
    return hop
  }

  function expand(path: NodePath, depth: number, srcCode: string): TraceHop {
    if (depth >= maxHops) {
      return withFrame(
        { kind: 'blocked', site: locOf(path.node as BabelNode), blockedBy: 'dynamic', hazards: [], evaluated: null, note: 'max hop depth reached' },
        srcCode,
      )
    }
    if (seen.has(path)) {
      return { kind: 'blocked', site: locOf(path.node as BabelNode), blockedBy: 'dynamic', hazards: [], evaluated: null, note: 'cycle' }
    }
    seen.add(path)

    // Confident constant-fold collapses immediately.
    const probe = probeValue(path)
    if (probe.confident) {
      return withFrame(
        { kind: 'value', site: locOf(path.node as BabelNode), blockedBy: null, hazards: [], evaluated: { confident: true, value: probe.value }, note: 'constant' },
        srcCode,
      )
    }

    // Resolve the identifier binding and classify the next step.
    const idPath = path.isIdentifier() ? path : (probe.deoptPath ?? path)
    if (!idPath.isIdentifier()) {
      return withFrame(
        { kind: 'blocked', site: locOf(idPath.node as BabelNode), blockedBy: 'dynamic', hazards: [], evaluated: null, note: 'non-identifier deopt' },
        srcCode,
      )
    }

    const binding = analyzeBinding(idPath)
    const hop = classifyDeopt(idPath, binding, graph)

    // Terminal / blocked hops become leaves.
    if (hop.blockedBy || hop.kind === 'value' || hop.kind === 'module-export') {
      return withFrame(hop, srcCode)
    }

    // param-caller / writer: attempt to recurse into the next path within budget.
    const children: TraceHop[] = []
    const nextPaths = nextHopPaths(hop, binding, graph).slice(0, maxBreadth)
    for (const { path: np, code: nc } of nextPaths) {
      children.push(expand(np, depth + 1, nc))
    }
    if (children.length > 0) hop.children = children
    return withFrame(hop, srcCode)
  }

  return expand(startPath, 0, code)
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

function nextHopPaths(
  hop: TraceHop,
  binding: BindingInfo,
  graph: ModuleGraph,
): { path: NodePath; code: string }[] {
  const out: { path: NodePath; code: string }[] = []
  if (hop.kind === 'param-caller') {
    const fnName = binding.binding ? functionNameOf(enclosingFunction(binding.binding)) : null
    const params: BabelNode[] = ((binding.binding && enclosingFunction(binding.binding)?.node as any)?.params ?? []) as BabelNode[]
    const paramIndex = params.findIndex((p) => p?.type === 'Identifier' && (p as any).name === binding.name)
    const callers = fnName ? graph.callSites.get(fnName) ?? [] : []
    if (callers.length === 1 && paramIndex >= 0) {
      const arg = callers[0].args[paramIndex]
      if (arg && arg.node) out.push({ path: arg, code: graph.getFile(callers[0].file)?.code ?? '' })
    }
  }
  return out
}
