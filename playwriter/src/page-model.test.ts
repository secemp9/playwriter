import { describe, it, expect } from 'vitest'
import type { AriaSnapshotNode } from './aria-snapshot.js'
import {
  buildPageModelFromRaw,
  DEFAULT_FIELDS,
  type FrameGeometry,
  type ModelDomInfo,
  type PageModelNode,
  type SnapshotNodeGeometry,
} from './page-model.js'

// --- fixtures ---------------------------------------------------------------
// Mocked raw inputs (aria tree + flattened-DOM index) so the pure fuse/project
// path is exercised with no live browser.

const FRAME = 'frame-1'

function makeAriaTree(): AriaSnapshotNode[] {
  return [
    {
      role: 'navigation',
      name: 'Main',
      backendNodeId: 10,
      locator: 'role=navigation',
      children: [
        {
          role: 'button',
          name: 'Save',
          backendNodeId: 11,
          locator: 'role=button[name="Save"]',
          children: [
            // aria-only leaf: no backendNodeId — tolerated in the tree, excluded from byKey.
            { role: 'text', name: 'Save', children: [] },
          ],
        },
        {
          role: 'button',
          name: 'Cancel',
          backendNodeId: 12,
          locator: 'role=button[name="Cancel"]',
          children: [],
        },
        {
          role: 'link',
          name: 'Home',
          backendNodeId: 13,
          locator: 'role=link[name="Home"]',
          children: [],
        },
      ],
    },
  ]
}

function makeDomIndex(): Map<number, ModelDomInfo> {
  return new Map<number, ModelDomInfo>([
    [10, { nodeName: 'NAV', attributes: { class: 'nav' } }],
    [11, { nodeName: 'BUTTON', attributes: { id: 'save', type: 'submit' } }],
    [12, { nodeName: 'BUTTON', attributes: { id: 'cancel' } }],
    [13, { nodeName: 'A', attributes: { href: '/' } }],
  ])
}

/**
 * Geometry is a required input — a model nobody measured cannot answer "is this
 * visible?", so `buildPageModelFromRaw` refuses to build one. These tests are about
 * fusing and projection rather than layout, so this factory hands every node a plain
 * measured record: laid out, opaque, on screen, and stacked so that no box overlaps
 * another (hence no occlusion). Geometry-specific behaviour is covered in
 * `page-model-geometry.test.ts`, which decodes real captureSnapshot payloads.
 */
function measuredGeometry(backendNodeIds: number[]): Map<string, FrameGeometry> {
  const byBackendId = new Map<number, SnapshotNodeGeometry>()
  const byNodeIndex = new Map<number, SnapshotNodeGeometry>()
  backendNodeIds.forEach((backendNodeId, index) => {
    const record: SnapshotNodeGeometry = {
      backendNodeId,
      nodeIndex: index,
      nodeType: 1,
      nodeName: 'DIV',
      label: 'div',
      box: { x: 0, y: index * 30, width: 100, height: 20 },
      paintOrder: index,
      styles: { display: 'block', visibility: 'visible', opacity: '1', 'pointer-events': 'auto' },
      stackingContext: false,
    }
    byBackendId.set(backendNodeId, record)
    byNodeIndex.set(index, record)
  })
  return new Map<string, FrameGeometry>([
    [
      FRAME,
      {
        frameId: FRAME,
        byBackendId,
        byNodeIndex,
        documentBackendIds: new Set(backendNodeIds),
        // All siblings: no node is an ancestor of another.
        parentIndex: backendNodeIds.map(() => -1),
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        viewport: { x: 0, y: 0, width: 800, height: 600 },
      },
    ],
  ])
}

const GEOMETRY = measuredGeometry([10, 11, 12, 13, 14])

function build() {
  return buildPageModelFromRaw({
    ariaTree: makeAriaTree(),
    domByBackendId: makeDomIndex(),
    frameId: FRAME,
    geometry: GEOMETRY,
  })
}

// --- tests ------------------------------------------------------------------

describe('buildPageModelFromRaw — keying and byKey membership', () => {
  it('keys nodes as `${frameId}:${backendNodeId}`', () => {
    const model = build()
    const save = model.byKey.get(`${FRAME}:11`)
    expect(save).toBeDefined()
    expect(save!.key).toBe(`${FRAME}:11`)
    expect(save!.frameId).toBe(FRAME)
    expect(save!.backendNodeId).toBe(11)
  })

  it('fuses tag + attributes from the DOM index', () => {
    const model = build()
    const save = model.byKey.get(`${FRAME}:11`)!
    expect(save.tag).toBe('button')
    expect(save.attributes).toEqual({ id: 'save', type: 'submit' })
    expect(save.role).toBe('button')
    expect(save.name).toBe('Save')
    expect(save.locator).toBe('role=button[name="Save"]')
  })

  it('tolerates aria-only nodes (no backendNodeId) but excludes them from byKey', () => {
    const model = build()
    // The synthetic text child exists in the tree...
    const save = model.byKey.get(`${FRAME}:11`)!
    expect(save.children).toHaveLength(1)
    const textChild = save.children[0]
    expect(textChild.type).toBe('text')
    expect(textChild.name).toBe('Save')
    // ...but none of the byKey entries has a negative (synthetic) backendNodeId.
    for (const node of model.byKey.values()) {
      expect(node.backendNodeId).toBeGreaterThanOrEqual(0)
    }
    // and the synthetic key is not registered
    expect(model.byKey.has(textChild.key)).toBe(false)
  })

  it('records parent relationships in a side map (no parent object pointer)', () => {
    const model = build()
    expect(model.parentByKey.get(`${FRAME}:11`)).toBe(`${FRAME}:10`)
    expect(model.parentByKey.get(`${FRAME}:10`)).toBe(`${FRAME}:0`)
    // nodes carry no parent object pointer
    const save = model.byKey.get(`${FRAME}:11`)! as unknown as Record<string, unknown>
    expect(save.parentNode).toBeUndefined()
    expect(save.parent).toBeUndefined()
  })
})

describe('query — roles / fields / visibleOnly / depth', () => {
  it('roles filter returns only buttons', () => {
    const model = build()
    const rows = model.query({ roles: ['button'] })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.role).toBe('button')
    }
    const names = rows.map((r) => r.name).sort()
    expect(names).toEqual(['Cancel', 'Save'])
  })

  it('projects only requested fields', () => {
    const model = build()
    const rows = model.query({ roles: ['button'], fields: ['key', 'role'] })
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['key', 'role'])
    }
  })

  it('default fields projection uses DEFAULT_FIELDS', () => {
    const model = build()
    const [row] = model.query({ roles: ['button'] })
    expect(Object.keys(row).sort()).toEqual([...DEFAULT_FIELDS].sort())
    expect(row['runtime.visible']).toBe(true)
  })

  it('visibleOnly excludes non-visible nodes', () => {
    const model = build()
    model.byKey.get(`${FRAME}:12`)!.runtime.visible = false
    const rows = model.query({ roles: ['button'], visibleOnly: true })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Save')
  })

  it('depth caps traversal', () => {
    const model = build()
    // depth 1: only the document's direct child (navigation) is reached.
    const rows = model.query({ depth: 1, fields: ['role'] })
    const roles = rows.map((r) => r.role)
    expect(roles).toContain('navigation')
    expect(roles).not.toContain('button')
  })
})

describe('query — page-path virtual-type selection', () => {
  it('VisibleElement virtual-type query works', () => {
    const model = build()
    model.byKey.get(`${FRAME}:12`)!.runtime.visible = false
    const rows = model.query({ select: 'VisibleElement', fields: ['key', 'role'] })
    const keys = rows.map((r) => r.key)
    expect(keys).toContain(`${FRAME}:11`) // Save (visible)
    expect(keys).toContain(`${FRAME}:13`) // Home link (visible)
    expect(keys).not.toContain(`${FRAME}:12`) // Cancel (hidden)
  })

  it('Interactive virtual-type query selects buttons and links', () => {
    const model = build()
    const rows = model.query({ select: 'Interactive', fields: ['role'] })
    const roles = rows.map((r) => r.role).sort()
    expect(roles).toEqual(['button', 'button', 'link'])
  })
})

describe('renderText', () => {
  it('produces an indented text projection', () => {
    const model = build()
    const text = model.renderText()
    const lines = text.split('\n')
    expect(lines[0]).toBe('- navigation "Main"')
    // children are indented under navigation
    expect(lines.some((l) => /^ {2}- button "Save"/.test(l))).toBe(true)
    expect(text).toContain('\n')
  })
})

describe('diffAgainst', () => {
  it("marks newly-appeared nodes as changedSince: 'new'", () => {
    const prev = build()
    // Next model gains an extra button (backendNodeId 14).
    const tree = makeAriaTree()
    tree[0].children.push({
      role: 'button',
      name: 'Delete',
      backendNodeId: 14,
      locator: 'role=button[name="Delete"]',
      children: [],
    })
    const dom = makeDomIndex()
    dom.set(14, { nodeName: 'BUTTON', attributes: { id: 'delete' } })
    const next = buildPageModelFromRaw({ ariaTree: tree, domByBackendId: dom, frameId: FRAME, geometry: GEOMETRY })

    next.diffAgainst(prev)

    expect(next.byKey.get(`${FRAME}:14`)!.runtime.changedSince).toBe('new')
    // pre-existing nodes are untouched
    expect(next.byKey.get(`${FRAME}:11`)!.runtime.changedSince).toBeUndefined()
  })

  it('surfaces changedSince in query rows when requested', () => {
    const prev = build()
    const tree = makeAriaTree()
    tree[0].children.push({
      role: 'button',
      name: 'Delete',
      backendNodeId: 14,
      locator: 'x',
      children: [],
    })
    const dom = makeDomIndex()
    dom.set(14, { nodeName: 'BUTTON', attributes: {} })
    const next = buildPageModelFromRaw({ ariaTree: tree, domByBackendId: dom, frameId: FRAME, geometry: GEOMETRY })
    next.diffAgainst(prev)

    const rows = next.query({ roles: ['button'], changedSince: true })
    const del = rows.find((r) => r.name === 'Delete')!
    expect(del.changedSince).toBe('new')
  })
})

describe('anchor', () => {
  it('resolves a backendNodeId to a cycle-free handle', () => {
    const model = build()
    const handle = model.anchor({ backendNodeId: 11 })
    expect(handle).not.toBeNull()
    expect(handle!.key).toBe(`${FRAME}:11`)
    expect(handle!.role).toBe('button')
    expect(handle!.tag).toBe('button')
    expect(typeof handle!.render()).toBe('string')
    // handle carries no children/tree — safe to serialize
    expect(() => JSON.stringify({ key: handle!.key, runtime: handle!.runtime })).not.toThrow()
  })

  it('resolves a locator string', () => {
    const model = build()
    const handle = model.anchor('role=button[name="Cancel"]')
    expect(handle!.key).toBe(`${FRAME}:12`)
  })

  it('returns null for an unknown selector', () => {
    const model = build()
    expect(model.anchor({ backendNodeId: 9999 })).toBeNull()
  })
})

describe('debugMode', () => {
  it('returns a config with lossy levers disabled', () => {
    const model = build()
    const cfg = model.debugMode()
    expect(cfg.visibleOnly).toBe(false)
    expect(cfg.includeAllNodes).toBe(true)
    expect(cfg.dedup).toBe(false)
    expect(cfg.styleWhitelist).toBeNull()
  })
})

describe('projection rows are JSON-serializable (no cycles)', () => {
  it('query output survives JSON.stringify', () => {
    const model = build()
    const rows = model.query({})
    expect(() => JSON.stringify(rows)).not.toThrow()
    const roundTrip = JSON.parse(JSON.stringify(rows)) as PageModelNode[]
    expect(Array.isArray(roundTrip)).toBe(true)
  })
})
