/**
 * page-model.ts — Milestone 1 of the PageModel feature.
 *
 * A PageModel is a tree of DOM/CSS/JS nodes fused from three independent sources:
 *   - the ARIA snapshot (role/name/locator + backendNodeId)          — aria-snapshot.ts
 *   - the flattened DOM  (tag + attributes, keyed by backendNodeId)  — CDP DOM.getFlattenedDocument
 *   - lazy edges: React fiber info and matched CSS rules             — react-source.ts / M2
 *
 * The node shape is `PageNode`-compatible (a `type` field plus children under a
 * visitor key) so the generic traversal core in `page-path.ts` can walk it. This
 * module does NOT reimplement traversal — it registers node types with page-path
 * and delegates `query`/`traverse` to it.
 *
 * Two build entry points:
 *   - `buildPageModel({ page, cdp, scope })`  — talks to the browser (CDP + aria)
 *   - `buildPageModelFromRaw({ ariaTree, domByBackendId, frameId })` — pure fuse/project,
 *     unit-testable without a browser. `buildPageModel` is a thin CDP wrapper over it.
 */

import type { Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import type { AriaSnapshotNode } from './aria-snapshot.js'
import { getAriaSnapshot } from './aria-snapshot.js'
import { getReactComponentInfo } from './react-source.js'
import { fetchNormalizedStyles } from './styles.js'
import { resolveCascade, type NormalizedRule, type DeclRef } from './css-cascade.js'
import { registerType, registerVirtualType, traverse, query, type PagePath, type PageNode } from './page-path.js'

/** page-path's `PageNode` requires a string index signature; our nodes are structurally compatible. */
function asPageNode(node: PageModelNode): PageNode {
  return node as unknown as PageNode
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type NodeKey = `${string}:${number}` // `${frameId}:${backendNodeId}`

export interface PageModelNode {
  type: 'document' | 'element' | 'text'
  key: NodeKey
  backendNodeId: number
  frameId: string
  tag: string
  role?: string
  name?: string
  attributes: Record<string, string>
  locator?: string
  runtime: {
    visible: boolean
    box?: { x: number; y: number; width: number; height: number }
    computedStyles: Record<string, string>
    changedSince?: 'new' | 'moved' | 'style' | 'removed'
  }
  edges: {
    // M1: lazy resolvers, not eager. matchedRules/reactFiber attached on demand.
    reactFiber?: { componentName: string | null; source: unknown; props: unknown }
    // M2: normalized matched rules + the cascade winner per property.
    matchedRules?: NormalizedRule[]
    winnerFor?: Record<string, DeclRef>
  }
  children: PageModelNode[]
  // NOTE: no parentNode object pointer (util.inspect cycle hazard). Parent lookup
  // lives in `PageModel.parentByKey` (a side Map<NodeKey, NodeKey>).
}

/** A plain, cycle-free projection row emitted by `query`. */
export type ProjectionRow = Record<string, unknown>

/** Projection config seam returned by `debugMode()` — flips lossy levers off. */
export interface ProjectionConfig {
  visibleOnly: boolean
  includeAllNodes: boolean
  styleWhitelist: string[] | null
  dedup: boolean
}

export interface PageModelHandle {
  key: NodeKey
  role?: string
  name?: string
  tag: string
  locator?: string
  runtime: PageModelNode['runtime']
  reactFiber(): Promise<{ componentName: string | null; source: unknown; props: unknown } | null>
  styles(): Promise<unknown>
  render(): string
}

export interface QueryOptions {
  scope?: string
  roles?: string[]
  depth?: number
  fields?: string[]
  visibleOnly?: boolean
  changedSince?: boolean
  /** Optional page-path selector (e.g. `'VisibleElement'`, `'Interactive'`) — uses page-path `query`. */
  select?: string
}

/** Minimal DOM info needed to fuse tag/attributes onto aria nodes. */
export interface ModelDomInfo {
  nodeName: string
  attributes: Record<string, string>
}

interface ModelDeps {
  page?: Page
  cdp?: ICDPSession
}

// ---------------------------------------------------------------------------
// Type registry (module load, once)
// ---------------------------------------------------------------------------

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'searchbox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
])

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'option'])

let typesRegistered = false
function ensureTypesRegistered(): void {
  if (typesRegistered) return
  typesRegistered = true
  registerType('document', { visitor: ['children'] })
  registerType('element', { visitor: ['children'], aliases: ['Node'] })
  registerType('text', {})
  registerVirtualType('VisibleElement', (path: PagePath) => {
    const node = path.node as PageModelNode | null
    return !!node && !!node.runtime && node.runtime.visible === true
  })
  registerVirtualType('Interactive', (path: PagePath) => {
    const node = path.node as PageModelNode | null
    if (!node) return false
    if (node.role && INTERACTIVE_ROLES.has(node.role)) return true
    return !!node.tag && INTERACTIVE_TAGS.has(node.tag)
  })
  // Occlusion is a later refinement; keep the hook, predicate is a placeholder.
  registerVirtualType('OccludedElement', () => false)
}

ensureTypesRegistered()

// ---------------------------------------------------------------------------
// Projection helpers (pure, cycle-free output)
// ---------------------------------------------------------------------------

export const DEFAULT_FIELDS = ['key', 'role', 'name', 'tag', 'locator', 'runtime.visible']

const TEXT_ROLES = new Set(['text', 'statictext', 'inlinetextbox'])

function getField(node: PageModelNode, field: string): unknown {
  if (!field.includes('.')) {
    return (node as unknown as Record<string, unknown>)[field]
  }
  let current: unknown = node
  for (const part of field.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function projectNode(node: PageModelNode, fields: string[], includeChanged: boolean): ProjectionRow {
  const row: ProjectionRow = {}
  for (const field of fields) {
    row[field] = getField(node, field)
  }
  if (includeChanged && node.runtime.changedSince) {
    row.changedSince = node.runtime.changedSince
  }
  return row
}

function pathDepth(path: PagePath): number {
  let depth = 0
  let p = path.parentPath
  while (p) {
    depth++
    p = p.parentPath
  }
  return depth
}

// ---------------------------------------------------------------------------
// PageModel
// ---------------------------------------------------------------------------

export class PageModel {
  root: PageModelNode
  byKey: Map<NodeKey, PageModelNode>
  parentByKey: Map<NodeKey, NodeKey>
  frameId: string
  private deps: ModelDeps

  constructor(opts: {
    root: PageModelNode
    byKey: Map<NodeKey, PageModelNode>
    parentByKey: Map<NodeKey, NodeKey>
    frameId: string
    deps?: ModelDeps
  }) {
    this.root = opts.root
    this.byKey = opts.byKey
    this.parentByKey = opts.parentByKey
    this.frameId = opts.frameId
    this.deps = opts.deps ?? {}
  }

  /** Resolve a selector / backendNodeId / point to a lightweight, cycle-free handle. */
  anchor(selector: string | { backendNodeId: number } | { x: number; y: number }): PageModelHandle | null {
    const node = this.resolveNode(selector)
    if (!node) return null
    return this.makeHandle(node)
  }

  private resolveNode(selector: string | { backendNodeId: number } | { x: number; y: number }): PageModelNode | null {
    if (typeof selector === 'string') {
      // 1) exact locator match, 2) page-path selector match
      for (const node of this.byKey.values()) {
        if (node.locator === selector) return node
      }
      const paths = query(asPageNode(this.root), selector)
      return paths.length ? (paths[0].node as PageModelNode) : null
    }
    if ('backendNodeId' in selector) {
      const key = `${this.frameId}:${selector.backendNodeId}` as NodeKey
      return this.byKey.get(key) ?? null
    }
    // point hit-test — best-effort; boxes are mostly undefined in M1.
    const { x, y } = selector
    for (const node of this.byKey.values()) {
      const box = node.runtime.box
      if (box && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
        return node
      }
    }
    return null
  }

  private makeHandle(node: PageModelNode): PageModelHandle {
    const deps = this.deps
    return {
      key: node.key,
      role: node.role,
      name: node.name,
      tag: node.tag,
      locator: node.locator,
      runtime: { ...node.runtime, computedStyles: { ...node.runtime.computedStyles } },
      async reactFiber() {
        if (node.edges.reactFiber) return node.edges.reactFiber
        if (!deps.page || !deps.cdp || !node.locator) return null
        const info = await getReactComponentInfo({ locator: deps.page.locator(node.locator), cdp: deps.cdp })
        const fiber = info ? { componentName: info.componentName, source: info.source, props: info.props } : null
        if (fiber) node.edges.reactFiber = fiber
        return fiber
      },
      async styles() {
        // Fetch matched styles for this node, run the cascade, cache the normalized
        // rules + winner map on the node's edges, and return a compact, cycle-free
        // winner-per-property projection.
        if (!node.edges.winnerFor) {
          if (!deps.page || !deps.cdp || !node.locator) return null
          const { rules } = await fetchNormalizedStyles({
            locator: deps.page.locator(node.locator),
            cdp: deps.cdp,
          })
          const cascade = resolveCascade(rules)
          node.edges.matchedRules = rules
          node.edges.winnerFor = cascade.winnerFor
        }
        const winners: Record<string, { value: string; selector: string; important: boolean; source: DeclRef['source'] }> =
          {}
        for (const [prop, ref] of Object.entries(node.edges.winnerFor)) {
          winners[prop] = { value: ref.value, selector: ref.selector, important: ref.important, source: ref.source }
        }
        return winners
      },
      render() {
        const label = node.role || node.tag || node.type
        const name = node.name ? ` "${node.name}"` : ''
        const loc = node.locator ? ` @${node.locator}` : ''
        return `<${label}${name}${loc} ${node.key}>`
      },
    }
  }

  /**
   * Select nodes via page-path `query`/`traverse` and project ONLY requested fields
   * into plain, cycle-free rows. This is the token-economy projection.
   */
  query(opts: QueryOptions = {}): ProjectionRow[] {
    const fields = opts.fields ?? DEFAULT_FIELDS
    const scopeRoot = this.resolveScopeRoot(opts.scope)
    const rows: ProjectionRow[] = []

    const passesFilters = (node: PageModelNode): boolean => {
      if (opts.visibleOnly && !node.runtime.visible) return false
      if (opts.roles && !(node.role && opts.roles.includes(node.role))) return false
      return true
    }

    if (opts.select) {
      // Virtual-type / typed selection routed through page-path's query engine.
      for (const path of query(asPageNode(scopeRoot), opts.select)) {
        const node = path.node as PageModelNode
        if (!passesFilters(node)) continue
        rows.push(projectNode(node, fields, !!opts.changedSince))
      }
      return rows
    }

    const maxDepth = opts.depth
    traverse(asPageNode(scopeRoot), {
      'document|element|text': (path: PagePath) => {
        const node = path.node as PageModelNode
        if (maxDepth != null && pathDepth(path) > maxDepth) {
          path.skip()
          return
        }
        if (!passesFilters(node)) return
        rows.push(projectNode(node, fields, !!opts.changedSince))
      },
    })
    return rows
  }

  private resolveScopeRoot(scope?: string): PageModelNode {
    if (!scope) return this.root
    const paths = query(asPageNode(this.root), scope)
    return paths.length ? (paths[0].node as PageModelNode) : this.root
  }

  /** Indented text projection (like the aria snapshot) for compact display. */
  renderText(opts: { visibleOnly?: boolean } = {}): string {
    const lines: string[] = []
    const walk = (node: PageModelNode, indent: number): void => {
      const isRoot = node === this.root
      if (!isRoot) {
        if (opts.visibleOnly && !node.runtime.visible) {
          // still descend so visible descendants are reachable
        } else {
          const prefix = '  '.repeat(indent)
          const label = node.role || node.tag || node.type
          const name = node.name ? ` "${node.name.replace(/"/g, '\\"')}"` : ''
          const changed = node.runtime.changedSince ? ` *${node.runtime.changedSince}` : ''
          lines.push(`${prefix}- ${label}${name}${changed}`)
        }
      }
      const nextIndent = isRoot ? indent : indent + 1
      for (const child of node.children) {
        walk(child, nextIndent)
      }
    }
    walk(this.root, 0)
    return lines.join('\n')
  }

  /** Projection config that disables lossy levers (debug/inspection mode). */
  debugMode(): ProjectionConfig {
    return {
      visibleOnly: false,
      includeAllNodes: true,
      styleWhitelist: null,
      dedup: false,
    }
  }

  /** Mark nodes whose key is absent in `prev` as `changedSince: 'new'`. */
  diffAgainst(prev: PageModel): void {
    for (const [key, node] of this.byKey) {
      if (!prev.byKey.has(key)) {
        node.runtime.changedSince = 'new'
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fuse (pure) — unit-testable without a browser
// ---------------------------------------------------------------------------

function nodeTypeForRole(role: string | undefined): PageModelNode['type'] {
  if (role && TEXT_ROLES.has(role)) return 'text'
  return 'element'
}

/**
 * Pure fuse/project: build a PageModel from already-fetched raw inputs. No CDP,
 * no page — safe to unit-test. `buildPageModel` wraps this after fetching.
 */
export function buildPageModelFromRaw({
  ariaTree,
  domByBackendId,
  frameId,
  deps,
}: {
  ariaTree: AriaSnapshotNode[]
  domByBackendId: Map<number, ModelDomInfo>
  frameId: string
  deps?: ModelDeps
}): PageModel {
  ensureTypesRegistered()

  const byKey = new Map<NodeKey, PageModelNode>()
  const parentByKey = new Map<NodeKey, NodeKey>()
  let ariaOnlyCounter = 0

  const mapNode = (ariaNode: AriaSnapshotNode, parentKey: NodeKey | null): PageModelNode => {
    const backendNodeId = ariaNode.backendNodeId
    const hasBackend = typeof backendNodeId === 'number'
    // Aria-only nodes (no backendNodeId) get a synthetic negative id so the node
    // is still traversable, but are deliberately excluded from `byKey`.
    const effectiveBackendId = hasBackend ? (backendNodeId as number) : --ariaOnlyCounter
    const key = `${frameId}:${effectiveBackendId}` as NodeKey

    const domInfo = hasBackend ? domByBackendId.get(backendNodeId as number) : undefined
    const tag = domInfo ? domInfo.nodeName.toLowerCase() : ''
    const attributes = domInfo ? { ...domInfo.attributes } : {}

    const node: PageModelNode = {
      type: nodeTypeForRole(ariaNode.role),
      key,
      backendNodeId: effectiveBackendId,
      frameId,
      tag,
      role: ariaNode.role || undefined,
      name: ariaNode.name || undefined,
      attributes,
      locator: ariaNode.locator,
      runtime: {
        // Presence in the aria snapshot implies the node is in the a11y tree.
        // Geometry isn't cheaply available here, so default visible=true, box undefined.
        visible: true,
        computedStyles: {},
      },
      edges: {},
      children: [],
    }

    if (hasBackend) {
      byKey.set(key, node)
    }
    if (parentKey) {
      parentByKey.set(key, parentKey)
    }

    node.children = (ariaNode.children ?? []).map((child) => mapNode(child, key))
    return node
  }

  const root: PageModelNode = {
    type: 'document',
    key: `${frameId}:0` as NodeKey,
    backendNodeId: 0,
    frameId,
    tag: '#document',
    attributes: {},
    runtime: { visible: true, computedStyles: {} },
    edges: {},
    children: [],
  }
  root.children = ariaTree.map((child) => mapNode(child, root.key))

  return new PageModel({ root, byKey, parentByKey, frameId, deps })
}

// ---------------------------------------------------------------------------
// Build (CDP) — thin wrapper over the pure fuse
// ---------------------------------------------------------------------------

function attrsToRecord(attributes?: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  if (!attributes) return result
  for (let i = 0; i < attributes.length; i += 2) {
    const name = attributes[i]
    if (name) result[name] = attributes[i + 1] ?? ''
  }
  return result
}

/**
 * Build a PageModel for a page: fetch the aria snapshot + flattened DOM over CDP,
 * then delegate to the pure `buildPageModelFromRaw`. Main frame only for M1, but
 * the `(frameId, backendNodeId)` keying keeps OOPIF support additive.
 */
export async function buildPageModel({
  page,
  cdp,
  scope,
}: {
  page: Page
  cdp: ICDPSession
  scope?: string
}): Promise<PageModel> {
  const locator = scope ? page.locator(scope) : undefined
  const aria = await getAriaSnapshot({ page, locator, cdp })

  const { nodes } = (await cdp.send('DOM.getFlattenedDocument', {
    depth: -1,
    pierce: true,
  })) as Protocol.DOM.GetFlattenedDocumentResponse

  const domByBackendId = new Map<number, ModelDomInfo>()
  for (const node of nodes) {
    domByBackendId.set(node.backendNodeId, {
      nodeName: node.nodeName,
      attributes: attrsToRecord(node.attributes),
    })
  }

  const frameId = page.mainFrame().frameId()

  return buildPageModelFromRaw({ ariaTree: aria.tree, domByBackendId, frameId, deps: { page, cdp } })
}
