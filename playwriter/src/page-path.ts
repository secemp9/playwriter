/**
 * page-path.ts — a generic, Babel-`@babel/traverse`-imitated node-path traversal engine.
 *
 * This is the traversal core for the forthcoming "PageModel" — a tree of DOM/CSS/JS
 * nodes. It reproduces the *design* of babel-traverse (type registry, lazily-created
 * and reused `NodePath`s, an exploded visitor system with aliases and virtual types,
 * a queue-based traversal loop with skip/stop/requeue and self-healing `resync`) but
 * over a completely generic plain-object node tree. Nothing here is coupled to JS ASTs
 * and it imports neither `@babel/traverse` nor `@babel/types`.
 *
 * A "node" is any object with a string `type` field whose children live under named
 * "visitor keys" — each key holds either a single child node or an array of child nodes.
 */

// ---------------------------------------------------------------------------
// Node / container shapes
// ---------------------------------------------------------------------------

export interface PageNode {
  type: string
  [key: string]: unknown
}

/** A container is whatever holds a node: its parent node (single child) or an array (list child). */
type PageContainer = PageNode | PageNode[] | Record<string, unknown> | null

// ---------------------------------------------------------------------------
// Type registry (module-level mutable maps), mirroring @babel/types
// ---------------------------------------------------------------------------

export interface TypeDefinition {
  /** Ordered visitor keys — the named fields under which child nodes are stored. */
  visitor?: string[]
  /** Alias names this type also answers to (e.g. an `Element` is also a `Node`). */
  aliases?: string[]
}

/** type -> ordered child field names. */
export const VISITOR_KEYS: Record<string, string[]> = Object.create(null)
/** type -> its alias names. */
export const ALIAS_KEYS: Record<string, string[]> = Object.create(null)
/** alias name -> the concrete types that carry it (the "flip" of ALIAS_KEYS). */
export const FLIPPED_ALIAS_KEYS: Record<string, string[]> = Object.create(null)
/** Every known name: concrete types, aliases and virtual types. */
export const TYPES: Set<string> = new Set()
/** virtual-type name -> predicate deciding whether a path matches it. */
export const VIRTUAL_TYPES: Record<string, (path: PagePath) => boolean> = Object.create(null)

/**
 * Register a concrete node type, its ordered visitor keys and any aliases.
 * Re-registering a type overwrites its previous definition.
 */
export function registerType(type: string, def: TypeDefinition = {}): void {
  VISITOR_KEYS[type] = def.visitor ? [...def.visitor] : []
  ALIAS_KEYS[type] = def.aliases ? [...def.aliases] : []
  TYPES.add(type)
  if (def.aliases) {
    for (const alias of def.aliases) {
      const list = FLIPPED_ALIAS_KEYS[alias] || (FLIPPED_ALIAS_KEYS[alias] = [])
      if (!list.includes(type)) list.push(type)
      // Aliases are addressable names too, so visitors may key on them.
      TYPES.add(alias)
    }
  }
}

/**
 * Register a "virtual type" — a name backed by a runtime predicate rather than a
 * concrete `node.type` (Babel's `VisibleElement`/`ReferencedIdentifier` idea). A
 * visitor keyed on the name runs only for paths whose predicate returns true.
 */
export function registerVirtualType(name: string, predicate: (path: PagePath) => boolean): void {
  VIRTUAL_TYPES[name] = predicate
  TYPES.add(name)
}

// ---------------------------------------------------------------------------
// Visitor types
// ---------------------------------------------------------------------------

export type VisitorFunction<S = unknown> = (path: PagePath, state: S) => void

export interface VisitorNodeObject<S = unknown> {
  enter?: VisitorFunction<S> | VisitorFunction<S>[]
  exit?: VisitorFunction<S> | VisitorFunction<S>[]
}

/**
 * A visitor keyed by concrete type, alias, virtual type, or `"A|B"` piped combinations.
 * Each value is either a bare enter function or an `{ enter, exit }` object.
 */
export type Visitor<S = unknown> = Record<string, VisitorFunction<S> | VisitorNodeObject<S> | undefined>

interface ExplodedVisitorNode {
  enter?: VisitorFunction[]
  exit?: VisitorFunction[]
}

/** A normalized visitor: keyed by concrete type, every entry `{ enter: fn[], exit: fn[] }`. */
export interface ExplodedVisitor {
  [type: string]: ExplodedVisitorNode | undefined
}

const EXPLODED = Symbol('pagePath.exploded')
const VIRTUAL_LIST = Symbol('pagePath.virtualTypes')

function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}

function normalizeEntry(value: VisitorFunction | VisitorNodeObject): ExplodedVisitorNode {
  if (typeof value === 'function') {
    return { enter: [value] }
  }
  return {
    enter: value.enter ? toArray(value.enter) : undefined,
    exit: value.exit ? toArray(value.exit) : undefined,
  }
}

function mergeInto(exploded: ExplodedVisitor, key: string, add: ExplodedVisitorNode): void {
  const target = exploded[key] || (exploded[key] = {})
  if (add.enter) target.enter = [...(target.enter || []), ...add.enter]
  if (add.exit) target.exit = [...(target.exit || []), ...add.exit]
}

/** Wrap every fn so it only runs when the virtual-type predicate matches (Babel's `wrapCheck`). */
function wrapCheck(predicate: (path: PagePath) => boolean, node: ExplodedVisitorNode): ExplodedVisitorNode {
  const wrap =
    (fn: VisitorFunction): VisitorFunction =>
    (path, state) => {
      if (predicate(path)) fn(path, state)
    }
  return {
    enter: node.enter?.map(wrap),
    exit: node.exit?.map(wrap),
  }
}

/**
 * Validate that every visitor key is a known type/alias/virtual name.
 * Throws on unknown keys — a footgun Babel guards against too.
 */
export function verify(visitor: Visitor): void {
  if ((visitor as Record<symbol, unknown>)[EXPLODED]) return
  for (const rawKey of Object.keys(visitor)) {
    for (const part of rawKey.split('|')) {
      const key = part.trim()
      if (!TYPES.has(key)) {
        throw new Error(`You gave us a visitor for the node type "${key}" but it's not a registered type`)
      }
    }
  }
}

/**
 * Normalize a visitor into an `ExplodedVisitor`:
 *   - shorthand `Type(path){}` -> `{ Type: { enter: [fn] } }`
 *   - piped `"A|B"` keys fan out to each name
 *   - virtual-type keys get predicate-wrapped and tracked separately
 *   - alias keys expand onto every concrete type carrying that alias
 *   - multiple enter/exit fns merge into arrays
 */
export function explode(visitor: Visitor): ExplodedVisitor {
  if ((visitor as Record<symbol, unknown>)[EXPLODED]) return visitor as ExplodedVisitor

  const exploded: ExplodedVisitor = Object.create(null)
  const virtualTypes: string[] = []

  // Pass 1 — normalize entries and split piped keys.
  for (const rawKey of Object.keys(visitor)) {
    const value = visitor[rawKey]
    if (value == null) continue
    const normalized = normalizeEntry(value)
    for (const part of rawKey.split('|')) {
      mergeInto(exploded, part.trim(), normalized)
    }
  }

  // Validate before any alias/virtual rewriting so error messages name the author's key.
  verify(exploded as unknown as Visitor)

  // Pass 2 — wrap virtual-type entries with their predicate check.
  for (const key of Object.keys(exploded)) {
    const predicate = VIRTUAL_TYPES[key]
    if (predicate) {
      exploded[key] = wrapCheck(predicate, exploded[key]!)
      virtualTypes.push(key)
    }
  }

  // Pass 3 — expand alias keys onto every concrete type that carries the alias.
  for (const key of Object.keys(exploded)) {
    if (VIRTUAL_TYPES[key]) continue
    const concrete = FLIPPED_ALIAS_KEYS[key]
    if (!concrete) continue
    const entry = exploded[key]!
    delete exploded[key]
    for (const type of concrete) {
      mergeInto(exploded, type, entry)
    }
  }

  Object.defineProperty(exploded, EXPLODED, { value: true, enumerable: false })
  Object.defineProperty(exploded, VIRTUAL_LIST, { value: virtualTypes, enumerable: false })
  return exploded
}

// ---------------------------------------------------------------------------
// Traversal state & context
// ---------------------------------------------------------------------------

/** Shared, mutable state for one `traverse` (or `path.traverse`) invocation. */
class TraverseState {
  visitor: ExplodedVisitor
  stateArg: unknown
  stopped = false

  constructor(visitor: ExplodedVisitor, stateArg: unknown) {
    this.visitor = visitor
    this.stateArg = stateArg
  }
}

/**
 * Visits a single container's worth of sibling paths. Owns the `priorityQueue` that
 * `requeue` feeds, imitating Babel's `TraversalContext`.
 */
class TraversalContext {
  state: TraverseState
  parentPath: PagePath | null
  queue: PagePath[] = []
  priorityQueue: PagePath[] = []

  constructor(state: TraverseState, parentPath: PagePath | null) {
    this.state = state
    this.parentPath = parentPath
  }

  /** Returns true when the whole traversal has been stopped. */
  visitQueue(queue: PagePath[]): boolean {
    this.queue = queue
    this.priorityQueue = []
    // Guards against visiting the same node twice within one container pass.
    const visited = new WeakSet<object>()
    let stop = false

    for (const path of queue) {
      path.resync()
      if (path._removed) continue
      path._setContext(this)

      const node = path.node as unknown as object | null
      if (node) {
        if (visited.has(node)) continue
        visited.add(node)
      }

      if (path.visit()) {
        stop = true
        break
      }
      if (this.state.stopped) {
        stop = true
        break
      }

      // Drain anything requeued during this path's visit before moving on.
      if (this.priorityQueue.length) {
        stop = this.visitQueue(this.priorityQueue)
        this.priorityQueue = []
        this.queue = queue
        if (stop) break
      }
    }

    this.queue = []
    return stop
  }

  requeue(path: PagePath): void {
    if (path._removed) return
    this.priorityQueue.push(path)
  }
}

/** Walk every visitor key of `path.node`, visiting child paths in declared order. */
function traverseChildren(path: PagePath, state: TraverseState): boolean {
  const node = path.node as unknown as PageNode | null
  if (!node) return false
  const keys = VISITOR_KEYS[node.type]
  if (!keys || keys.length === 0) return false

  const context = new TraversalContext(state, path)
  for (const key of keys) {
    if (path.skipKeys[key]) continue
    const value = (node as Record<string, unknown>)[key]
    if (value == null) continue

    const queue: PagePath[] = []
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] == null) continue
        const child = PagePath.get({ parentPath: path, parent: node, container: value, listKey: key, key: i })
        child._resetForVisit()
        queue.push(child)
      }
    } else {
      const child = PagePath.get({ parentPath: path, parent: node, container: node, key })
      child._resetForVisit()
      queue.push(child)
    }

    if (context.visitQueue(queue)) return true
    if (state.stopped) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// PagePath
// ---------------------------------------------------------------------------

interface PagePathFactoryOptions {
  parentPath: PagePath | null
  parent: object
  container: PageContainer
  listKey?: string
  key: string | number
}

export class PagePath<N = any> {
  /** The node this path currently points at. May become `null` after removal. */
  node: N
  /** The owning parent node (also the two-tier cache key). */
  parent: object | null
  parentPath: PagePath | null
  /** Whatever directly holds the node: the parent node, or the list array. */
  container: PageContainer
  /** The field name when the node lives in a list; undefined for single children. */
  listKey?: string
  /** Property name (single child) or array index (list child). */
  key: string | number

  /** Per-path data bag that survives across traversals (paths are cached & reused). */
  readonly data: Map<string, unknown> = new Map()

  _removed = false
  shouldSkip = false
  shouldStop = false
  /** Visitor keys to skip when descending into this node's children. */
  skipKeys: Record<string, boolean> = {}

  private context: TraversalContext | null = null

  /**
   * Two-tier path cache: parent node -> (target node -> path). Keying the inner map
   * by the *node* means a path is created once and reused, so `data` (and identity)
   * persist across gets and across separate traversals of the same tree.
   */
  private static cache = new WeakMap<object, Map<unknown, PagePath>>()

  private constructor(parent: object | null, container: PageContainer) {
    this.parent = parent
    this.container = container
    this.node = null as unknown as N
    this.key = ''
    this.parentPath = null
  }

  /** Consult the cache (or create+cache) the path for a given position. */
  static get(opts: PagePathFactoryOptions): PagePath {
    const { parentPath, parent, container, listKey, key } = opts
    const targetNode = (container as Record<string | number, unknown>)[key]

    let paths = PagePath.cache.get(parent)
    if (!paths) {
      paths = new Map()
      PagePath.cache.set(parent, paths)
    }
    let path = targetNode != null ? paths.get(targetNode) : undefined
    if (!path) {
      path = new PagePath(parent, container)
      if (targetNode != null) paths.set(targetNode, path)
    }

    path.parentPath = parentPath
    path.parent = parent
    path.container = container as PageContainer
    path.listKey = listKey
    path.key = key
    path.node = targetNode as never
    return path
  }

  /** Clear the entire path cache (paths and their data bags are dropped). */
  static clearCache(): void {
    PagePath.cache = new WeakMap()
  }

  // --- child / sibling access --------------------------------------------

  /** Get the child path(s) under a visitor key. Cached, so repeated gets reuse paths. */
  get(key: string): PagePath | PagePath[] {
    const node = this.node as unknown as PageNode
    const value = (node as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      return value.map((_, i) =>
        PagePath.get({ parentPath: this, parent: node, container: value, listKey: key, key: i }),
      )
    }
    return PagePath.get({ parentPath: this, parent: node, container: node, key })
  }

  getSibling(key: string | number): PagePath {
    return PagePath.get({
      parentPath: this.parentPath,
      parent: (this.parent ?? {}) as object,
      container: this.container,
      listKey: this.listKey,
      key,
    })
  }

  getAllPrevSiblings(): PagePath[] {
    if (typeof this.key !== 'number') return []
    const siblings: PagePath[] = []
    for (let k = this.key - 1; k >= 0; k--) siblings.push(this.getSibling(k))
    return siblings
  }

  getAllNextSiblings(): PagePath[] {
    if (typeof this.key !== 'number') return []
    const siblings: PagePath[] = []
    const container = this.container as unknown[]
    for (let k = this.key + 1; k < container.length; k++) siblings.push(this.getSibling(k))
    return siblings
  }

  // --- type / lookup helpers ---------------------------------------------

  /** True if the node is exactly `type`, carries it as an alias, or matches it as a virtual type. */
  is(type: string): boolean {
    const node = this.node as unknown as PageNode | null
    if (!node) return false
    if (node.type === type) return true
    const concrete = FLIPPED_ALIAS_KEYS[type]
    if (concrete && concrete.includes(node.type)) return true
    const predicate = VIRTUAL_TYPES[type]
    if (predicate) return predicate(this)
    return false
  }

  /** Walk this path and its ancestors, returning the first that matches. */
  find(predicate: (path: PagePath) => boolean): PagePath | null {
    let path: PagePath | null = this
    while (path) {
      if (predicate(path)) return path
      path = path.parentPath
    }
    return null
  }

  /** Walk strictly the ancestors, returning the first that matches. */
  findParent(predicate: (path: PagePath) => boolean): PagePath | null {
    let path = this.parentPath
    while (path) {
      if (predicate(path)) return path
      path = path.parentPath
    }
    return null
  }

  // --- data bag ----------------------------------------------------------

  getData<T = unknown>(key: string, def?: T): T | undefined {
    if (this.data.has(key)) return this.data.get(key) as T
    return def
  }

  setData<T>(key: string, value: T): T {
    this.data.set(key, value)
    return value
  }

  // --- traversal control -------------------------------------------------

  /** Prune: don't descend into this node's children. */
  skip(): void {
    this.shouldSkip = true
  }

  /** Abort the entire traversal. */
  stop(): void {
    this.shouldStop = true
    this.shouldSkip = true
    if (this.context) this.context.state.stopped = true
  }

  /** Re-queue a path (default: this one) to be visited again in the active context. */
  requeue(path: PagePath = this): void {
    if (path._removed) return
    if (this.context) this.context.requeue(path)
  }

  /** Detach the node from its container. */
  remove(): void {
    if (this._removed) return
    const container = this.container
    if (Array.isArray(container) && typeof this.key === 'number') {
      container.splice(this.key, 1)
    } else if (container && typeof this.key === 'string') {
      ;(container as Record<string, unknown>)[this.key] = null
    }
    this._markRemoved()
  }

  // --- self-healing ------------------------------------------------------

  /**
   * Babel's self-healing step. If the tree was mutated under this path so that
   * `container[key]` no longer holds our node, re-find the node in its container
   * by identity and fix `key`; if it's gone entirely, mark the path removed.
   */
  resync(): void {
    if (this._removed) return
    const container = this.container
    if (container == null || this.node == null) return
    if ((container as Record<string | number, unknown>)[this.key] === (this.node as unknown)) return

    if (Array.isArray(container)) {
      const idx = container.indexOf(this.node as unknown as PageNode)
      if (idx >= 0) {
        this.key = idx
        return
      }
    } else {
      for (const key of Object.keys(container)) {
        if ((container as Record<string, unknown>)[key] === (this.node as unknown)) {
          this.key = key
          return
        }
      }
    }
    // The node is no longer anywhere in its container — it was removed.
    this._markRemoved()
  }

  // --- sub-traversal -----------------------------------------------------

  /** Traverse this path's descendants (not the node itself) with a fresh visitor. */
  traverse<S = unknown>(visitor: Visitor<S>, state?: S): void {
    const exploded = explode(visitor as Visitor)
    traverseChildren(this, new TraverseState(exploded, state))
  }

  // --- internals (used by the traversal loop) ----------------------------

  _setContext(context: TraversalContext): void {
    this.context = context
  }

  /** Reset per-traversal flags. Called when a path is freshly enqueued, never on requeue. */
  _resetForVisit(): void {
    this.shouldSkip = false
    this.shouldStop = false
    this.skipKeys = {}
  }

  private _markRemoved(): void {
    this._removed = true
    this.shouldSkip = true
    this.node = null as unknown as N
  }

  private _getVisitorFns(phase: 'enter' | 'exit'): VisitorFunction[] {
    const state = this.context!.state
    const visitor = state.visitor
    const node = this.node as unknown as PageNode
    const out: VisitorFunction[] = []

    const own = visitor[node.type]
    if (own && own[phase]) out.push(...own[phase]!)

    // Virtual-type visitors are already predicate-wrapped, so it is safe to offer
    // them to every node; each one no-ops unless its predicate matches.
    const virtualList = (visitor as Record<symbol, unknown>)[VIRTUAL_LIST] as string[] | undefined
    if (virtualList) {
      for (const name of virtualList) {
        const v = visitor[name]
        if (v && v[phase]) out.push(...v[phase]!)
      }
    }
    return out
  }

  private _callPhase(phase: 'enter' | 'exit'): boolean {
    const fns = this._getVisitorFns(phase)
    const stateArg = this.context!.state.stateArg
    for (const fn of fns) {
      if (this.node == null) return true
      fn.call(stateArg, this, stateArg)
      // Any of these flags means "stop descending / stop calling further fns".
      if (this._removed || this.shouldStop || this.shouldSkip) return true
    }
    return false
  }

  /**
   * Visit this path: enter fns, then children, then exit fns. Returns `shouldStop`.
   * `shouldSkip` is checked *before* enter so a path that was requeued and then
   * skipped never re-runs its enter handlers (Babel's behavior).
   */
  visit(): boolean {
    if (this.node == null || this._removed) return false

    if (this.shouldSkip || this._callPhase('enter')) {
      return this.shouldStop
    }

    if (!this.shouldSkip && !this._removed) {
      traverseChildren(this, this.context!.state)
    }

    this._callPhase('exit')
    return this.shouldStop
  }
}

// ---------------------------------------------------------------------------
// Top-level traverse & query
// ---------------------------------------------------------------------------

/** Stable fake container per root node so the root path is cached and its data persists. */
const rootContainers = new WeakMap<object, { node: PageNode }>()

function getRootPath(root: PageNode): PagePath {
  let container = rootContainers.get(root)
  if (!container) {
    container = { node: root }
    rootContainers.set(root, container)
  }
  return PagePath.get({ parentPath: null, parent: container, container, key: 'node' })
}

export interface TraverseOptions<S = unknown> {
  /** Arbitrary state passed as the second argument to every visitor fn. */
  state?: S
}

/**
 * Traverse `root` and all descendants, invoking the visitor's enter/exit handlers.
 * Unlike `path.traverse`, this visits the root node itself as well.
 */
export function traverse<S = unknown>(root: PageNode, visitor: Visitor<S>, opts: TraverseOptions<S> = {}): void {
  const exploded = explode(visitor as Visitor)
  const state = new TraverseState(exploded, opts.state)
  const rootPath = getRootPath(root)
  rootPath._resetForVisit()
  const context = new TraversalContext(state, null)
  context.visitQueue([rootPath])
}

export type Selector = string | ((path: PagePath) => boolean)

/**
 * Compile a selector into a path predicate. Supported string forms:
 *   - `"Type"` / alias / virtual-type name  (matched via `path.is`)
 *   - `"Type[attr=value]"`  (matched against `node.attributes[attr]`)
 *   - `"Type#id"`  (matched against `node.id` or `node.attributes.id`)
 * The leading type is optional and may be `*`. This is deliberately not a full CSS engine.
 */
function compileSelector(selector: Selector): (path: PagePath) => boolean {
  if (typeof selector === 'function') return selector

  // Bare '*' matches every node.
  if (selector === '*') return () => true

  const attrMatch = selector.match(/^([A-Za-z0-9_$*]*)\[([^\]=]+)=([^\]]*)\]$/)
  if (attrMatch) {
    const [, type, attr, value] = attrMatch
    return (path) => {
      if (type && type !== '*' && !path.is(type)) return false
      const attrs = (path.node as unknown as PageNode | null)?.attributes as Record<string, unknown> | undefined
      return !!attrs && String(attrs[attr]) === value
    }
  }

  const idMatch = selector.match(/^([A-Za-z0-9_$*]*)#(.+)$/)
  if (idMatch) {
    const [, type, id] = idMatch
    return (path) => {
      if (type && type !== '*' && !path.is(type)) return false
      const node = path.node as unknown as PageNode | null
      const attrs = node?.attributes as Record<string, unknown> | undefined
      const nodeId = node?.id ?? attrs?.id
      return nodeId != null && String(nodeId) === id
    }
  }

  return (path) => path.is(selector)
}

/**
 * Collect every path in the tree matching `selector`, using `traverse` under the hood.
 * The synthetic visitor keys on every registered concrete type so all nodes are tested.
 */
export function query(root: PageNode, selector: Selector): PagePath[] {
  const predicate = compileSelector(selector)
  const matches: PagePath[] = []
  const collect: VisitorFunction = (path) => {
    if (predicate(path)) matches.push(path)
  }

  const visitor: Visitor = Object.create(null)
  for (const type of Object.keys(VISITOR_KEYS)) {
    visitor[type] = collect
  }
  traverse(root, visitor)
  return matches
}
