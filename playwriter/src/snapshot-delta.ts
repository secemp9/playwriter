/**
 * snapshot-delta.ts — `snapshot({ diff: true })`: revisioned accessibility snapshots whose second and
 * later results say only what changed, keyed by node identity.
 *
 * A text diff of two snapshots is the wrong tool: the lines carry `>> nth=N` locators that shift
 * whenever anything is inserted above them, a row that re-renders in place reads as removed and
 * added, and a big change makes the diff fall back to the whole tree. Here every node of the tree
 * is identified by its DOM node (Chromium's backendNodeId, stable for the life of the node) — or,
 * for the few AX nodes that have none, by its parent's identity plus its role, name and position
 * among identical siblings — and two revisions of one scope are compared node by node:
 *
 *   `+` a node that appeared (with its new subtree under it), and where;
 *   `-` a node that went away (with its subtree), and where it was;
 *   `~` a node that is still there but reads differently (name, states, value), moved to another
 *       parent, or whose children now come in another order.
 *
 * One revision counter per scope (the page, or one ref's subtree; whole tree and interactive-only
 * are separate scopes). A new document of the scope starts over with a full tree.
 */

import util from 'node:util'
import type { AriaSnapshotNode } from './aria-snapshot.js'

/** A complete tree: the first snapshot of a scope, a new document, or a change bigger than the tree. */
export interface SnapshotFullResult {
  status: 'full'
  revision: number
  /** Why the whole tree, not a delta. */
  reason: string
  snapshot: string
}

/** Nothing in the tree changed since `revision`. */
export interface SnapshotUnchangedResult {
  status: 'unchanged'
  revision: number
}

/** What changed from `baseRevision` to `revision`, one `+`/`-`/`~` line per node. */
export interface SnapshotDeltaResult {
  status: 'delta'
  revision: number
  baseRevision: number
  added: number
  removed: number
  changed: number
  /** Nodes the page replaced by new ones that read the same, in the same place: not listed. */
  rerendered: number
  delta: string
}

export type SnapshotRevisionResult = SnapshotFullResult | SnapshotUnchangedResult | SnapshotDeltaResult

/** One node of a revision, flattened in document order. */
interface FlatNode {
  key: string
  /** The line the snapshot printed for it, indentation removed. */
  line: string
  /** The line without what moves when something else changes (the `>> nth=N` ordinal, the `:` of a parent). */
  content: string
  parentKey: string | null
  depth: number
}

interface Revision {
  /** The document the tree was read from: a new one starts over. */
  documentId: string
  revision: number
  nodes: Map<string, FlatNode>
  order: string[]
  children: Map<string | null, string[]>
}

const NTH_RE = / >> nth=\d+/g
/** Context names (`in navigation "Menu"`) are cut to this many characters. */
const CONTEXT_CHARS = 80

/**
 * Flatten `tree` in document order, each node paired with its line of `snapshot` (the snapshot prints
 * one line per node, depth first).
 */
function flatten(tree: AriaSnapshotNode[], snapshot: string): { nodes: Map<string, FlatNode>; order: string[]; children: Map<string | null, string[]> } {
  const lines = snapshot.split('\n')
  const nodes = new Map<string, FlatNode>()
  const order: string[] = []
  const children = new Map<string | null, string[]>()
  let index = 0
  const walk = (items: AriaSnapshotNode[], parentKey: string | null, depth: number): void => {
    const ordinals = new Map<string, number>()
    for (const item of items) {
      const text = lines[index]
      if (text === undefined) throw new Error(`snapshot: the tree has more nodes than the snapshot has lines (${lines.length}).`)
      index++
      const line = text.trimStart()
      const content = line.replace(NTH_RE, '').replace(/:$/, '')
      let key: string
      if (item.backendNodeId !== undefined && !nodes.has(`n${item.backendNodeId}`)) {
        key = `n${item.backendNodeId}`
      } else {
        const base = `${parentKey ?? ''}/${item.role}:${item.name}`
        const ordinal = ordinals.get(base) ?? 0
        ordinals.set(base, ordinal + 1)
        key = `${base}#${ordinal}`
      }
      nodes.set(key, { key, line, content, parentKey, depth })
      order.push(key)
      const siblings = children.get(parentKey)
      if (siblings) siblings.push(key)
      else children.set(parentKey, [key])
      walk(item.children, key, depth + 1)
    }
  }
  walk(tree, null, 0)
  if (index !== lines.length && !(index === 0 && snapshot === '')) {
    throw new Error(`snapshot: the snapshot has ${lines.length} lines for ${index} tree nodes.`)
  }
  return { nodes, order, children }
}

function contextOf(nodes: Map<string, FlatNode>, parentKey: string | null): string {
  if (parentKey === null) return 'at the top'
  const parent = nodes.get(parentKey)
  if (!parent) return 'at the top'
  const text = parent.content.replace(/^- /, '')
  return `in ${text.length > CONTEXT_CHARS ? `${text.slice(0, CONTEXT_CHARS - 1)}…` : text}`
}

function compare(
  base: Revision,
  next: Omit<Revision, 'documentId' | 'revision'>,
): { lines: string[]; added: number; removed: number; changed: number; rerendered: number } {
  const lines: string[] = []
  let added = 0
  let removed = 0
  let changed = 0

  // Re-rendered unchanged: the page replaced a node with a new one that reads the same, in the same
  // place (a framework re-render, a list marker Chrome rebuilt). Paired — new key to old — from the top
  // down, so the children of a replaced node pair under it; they are neither added nor removed.
  const goneBySignature = new Map<string, string[]>()
  for (const key of base.order) {
    const node = base.nodes.get(key)
    if (!node || next.nodes.has(key)) continue
    const signature = `${node.parentKey ?? ''}\u0000${node.content}`
    const same = goneBySignature.get(signature)
    if (same) same.push(key)
    else goneBySignature.set(signature, [key])
  }
  const alias = new Map<string, string>()
  for (const key of next.order) {
    const node = next.nodes.get(key)
    if (!node || base.nodes.has(key)) continue
    const parent = node.parentKey === null || base.nodes.has(node.parentKey) ? node.parentKey : alias.get(node.parentKey)
    if (parent === undefined) continue
    const old = goneBySignature.get(`${parent ?? ''}\u0000${node.content}`)?.shift()
    if (old !== undefined) alias.set(key, old)
  }
  const replaced = new Set(alias.values())
  const isGone = (key: string): boolean => !next.nodes.has(key) && !replaced.has(key)
  const isNew = (key: string): boolean => !base.nodes.has(key) && !alias.has(key)

  // Gone: printed as subtrees under the first gone node of each branch, where it was.
  for (const key of base.order) {
    const node = base.nodes.get(key)
    if (!node || !isGone(key)) continue
    removed++
    if (node.parentKey !== null && isGone(node.parentKey)) {
      const root = rootOf(base.nodes, key, isGone)
      lines.push(`- ${'  '.repeat(node.depth - root.depth)}${node.line}`)
    } else {
      lines.push(`- ${node.line}  (was ${contextOf(base.nodes, node.parentKey)})`)
    }
  }

  // New and changed, in the new document order.
  for (const key of next.order) {
    const node = next.nodes.get(key)
    if (!node || alias.has(key)) continue
    const before = base.nodes.get(key)
    if (!before) {
      added++
      if (node.parentKey !== null && isNew(node.parentKey)) {
        const root = rootOf(next.nodes, key, isNew)
        lines.push(`+ ${'  '.repeat(node.depth - root.depth)}${node.line}`)
      } else {
        lines.push(`+ ${node.line}  (${contextOf(next.nodes, node.parentKey)})`)
      }
      continue
    }
    const notes: string[] = []
    if (before.content !== node.content) notes.push(`was: ${before.content.replace(/^- /, '')}`)
    const parentNow = node.parentKey === null ? null : (alias.get(node.parentKey) ?? node.parentKey)
    if (before.parentKey !== parentNow) notes.push(`moved: was ${contextOf(base.nodes, before.parentKey)}, now ${contextOf(next.nodes, node.parentKey)}`)
    const oldChildren = base.children.get(key) ?? []
    const newChildren = (next.children.get(key) ?? []).map((child) => alias.get(child) ?? child)
    // The children both revisions have, each in its revision's order: a sort or a moved row differs.
    const newSet = new Set(newChildren)
    const oldOrder = oldChildren.filter((child) => newSet.has(child))
    const kept = new Set(oldOrder)
    const newOrder = newChildren.filter((child) => kept.has(child))
    if (oldOrder.some((child, at) => newOrder[at] !== child)) notes.push('its children are in another order now')
    if (notes.length === 0) continue
    changed++
    lines.push(`~ ${node.line}  (${notes.join('; ')})`)
  }
  return { lines, added, removed, changed, rerendered: alias.size }
}

/** The top of the branch of `key` whose nodes all satisfy `inBranch`. */
function rootOf(nodes: Map<string, FlatNode>, key: string, inBranch: (key: string) => boolean): FlatNode {
  let current = nodes.get(key)
  if (!current) throw new Error(`snapshot: node ${key} is not in its own revision.`)
  while (current.parentKey !== null && inBranch(current.parentKey)) {
    const parent = nodes.get(current.parentKey)
    if (!parent) break
    current = parent
  }
  return current
}

/** Print the result as its text: `return await snapshot({ diff: true })` reads like the snapshot itself. */
function printable<T extends SnapshotRevisionResult>(result: T): T {
  const text =
    result.status === 'full'
      ? `snapshot r${result.revision} — full tree (${result.reason}):\n${result.snapshot}`
      : result.status === 'unchanged'
        ? `snapshot r${result.revision} — unchanged: nothing in this accessibility tree changed since r${result.revision}.`
        : `snapshot r${result.revision} — delta since r${result.baseRevision}: ${result.added} added, ${result.removed} removed, ${result.changed} changed` +
          `${result.rerendered > 0 ? ` (${result.rerendered} more re-rendered without a change, not listed)` : ''} ` +
          '(+ appeared, - went away, ~ still there but changed):\n' +
          result.delta
  Object.defineProperty(result, util.inspect.custom, { value: () => text, enumerable: false })
  Object.defineProperty(result, 'toString', { value: () => text, enumerable: false })
  return result
}

/**
 * The revisions of every snapshot scope of a session's pages. Each `record` call is one snapshot of
 * one scope; with `diff` it returns what changed since the previous one.
 */
export class SnapshotRevisions {
  private readonly pages = new WeakMap<object, Map<string, Revision>>()

  /**
   * Record the tree just read for `scope` of `page` (from document `documentId`) and return it as a
   * revision: full the first time and for a new document, unchanged, or the delta.
   */
  record(options: { page: object; scope: string; documentId: string; tree: AriaSnapshotNode[]; snapshot: string; shown: string }): SnapshotRevisionResult {
    let scopes = this.pages.get(options.page)
    if (!scopes) {
      scopes = new Map()
      this.pages.set(options.page, scopes)
    }
    const flat = flatten(options.tree, options.snapshot)
    const base = scopes.get(options.scope)
    const revision = (base?.revision ?? 0) + 1
    const store = (number: number): void => {
      scopes.set(options.scope, { documentId: options.documentId, revision: number, ...flat })
    }
    if (!base) {
      store(revision)
      return printable({ status: 'full', revision, reason: 'the first snapshot of this scope', snapshot: options.shown })
    }
    if (base.documentId !== options.documentId) {
      store(revision)
      return printable({ status: 'full', revision, reason: `a new document since r${base.revision}`, snapshot: options.shown })
    }
    const { lines, added, removed, changed, rerendered } = compare(base, flat)
    if (lines.length === 0) {
      // The same tree. Nodes the page re-rendered without a change have new identities: they are the baseline now.
      if (rerendered > 0) store(base.revision)
      return printable({ status: 'unchanged', revision: base.revision })
    }
    store(revision)
    if (lines.length >= flat.order.length) {
      return printable({
        status: 'full',
        revision,
        reason: `the changes since r${base.revision} (${lines.length} lines: ${added} added, ${removed} removed, ${changed} changed) are no shorter than the whole tree (${flat.order.length} lines)`,
        snapshot: options.shown,
      })
    }
    return printable({ status: 'delta', revision, baseRevision: base.revision, added, removed, changed, rerendered, delta: lines.join('\n') })
  }
}
