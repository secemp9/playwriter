/** SnapshotRevisions on hand-built trees: identity by node, re-renders paired, scopes and documents apart. */

import { describe, expect, it } from 'vitest'
import type { AriaSnapshotNode } from './aria-snapshot.js'
import { SnapshotRevisions } from './snapshot-delta.js'

function node(role: string, name: string, backendNodeId: number | undefined, children: AriaSnapshotNode[] = []): AriaSnapshotNode {
  return { role, name, ...(backendNodeId !== undefined ? { backendNodeId } : {}), children }
}

/** The snapshot text getAriaSnapshot prints for `tree`: one line per node, depth first. */
function render(tree: AriaSnapshotNode[], depth = 0): string[] {
  return tree.flatMap((item) => [`${'  '.repeat(depth)}- ${item.role}${item.name ? ` "${item.name}"` : ''}${item.children.length > 0 ? ':' : ''}`, ...render(item.children, depth + 1)])
}

function record(revisions: SnapshotRevisions, page: object, tree: AriaSnapshotNode[], documentId = 'doc-1', scope = 'page|all') {
  const snapshot = render(tree).join('\n')
  return revisions.record({ page, scope, documentId, tree, snapshot, shown: snapshot })
}

describe('SnapshotRevisions', () => {
  it('pairs a subtree the page re-rendered without a change, and lists what did change by identity', () => {
    const revisions = new SnapshotRevisions()
    const page = {}
    const row = (id: number, cell: number, text: string): AriaSnapshotNode => node('row', text, id, [node('cell', text, cell)])
    expect(record(revisions, page, [node('table', 'People', 1, [row(2, 3, 'Ada'), row(4, 5, 'Bob')])]).status).toBe('full')
    // Both rows re-rendered as new DOM nodes; only Bob's text changed.
    const result = record(revisions, page, [node('table', 'People', 1, [row(12, 13, 'Ada'), row(14, 15, 'Bea')])])
    expect(result.status).toBe('delta')
    // Counts are nodes: Bob's row and its cell went away, Bea's row and cell appeared; Ada's two were re-rendered.
    expect(String(result)).toContain('2 added, 2 removed, 0 changed (2 more re-rendered without a change, not listed)')
    expect(String(result)).toContain('- - row "Bob":  (was in table "People")\n-   - cell "Bob"')
    expect(String(result)).toContain('+ - row "Bea":  (in table "People")\n+   - cell "Bea"')
    // Re-rendered again, the same: unchanged, and the new nodes are the baseline.
    const again = record(revisions, page, [node('table', 'People', 1, [row(22, 23, 'Ada'), row(24, 25, 'Bea')])])
    expect(again).toMatchObject({ status: 'unchanged', revision: 2 })
  })

  it('keeps one revision line per scope, and starts over on a new document', () => {
    const revisions = new SnapshotRevisions()
    const page = {}
    const tree = [node('button', 'Save', 1)]
    expect(record(revisions, page, tree)).toMatchObject({ status: 'full', revision: 1 })
    expect(record(revisions, page, tree, 'doc-1', 'ref:7|all')).toMatchObject({ status: 'full', revision: 1 })
    expect(record(revisions, page, [node('button', 'Save', 1), node('button', 'Undo', 2)])).toMatchObject({ status: 'delta', revision: 2, baseRevision: 1, added: 1 })
    expect(record(revisions, page, tree, 'doc-2')).toMatchObject({ status: 'full', revision: 3, reason: 'a new document since r2' })
  })
})
