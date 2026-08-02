/**
 * capture-snapshot-fixture.ts — the synthetic `DOMSnapshot.captureSnapshot` generator,
 * and the structural describer that keeps it honest.
 *
 * WHY THIS IS NOT IN THE TEST FILE ANY MORE
 *
 * The geometry lane had 67 green unit tests and threw on the first real browser call,
 * because the generator encoded the same misunderstanding of the wire format as the
 * decoder did. Every assertion was self-referential: the fixtures were built to the
 * decoder's beliefs, so they could only ever confirm them. Nothing tested the generator.
 *
 * The generator now lives here, importable, so a live test can capture a REAL snapshot
 * from a real headless Chromium and assert that `describeSnapshotShape` of the two is
 * the same object. That is the de-self-referencing mechanism, chosen over the two
 * alternatives:
 *
 *   - A COMMITTED GOLDEN CAPTURE pins one Chrome build's bytes. It rots silently as
 *     Chrome evolves, and it can only catch "the decoder mishandles this old payload" —
 *     never "the generator emits a table Chrome does not", which is the failure that
 *     actually happened.
 *   - GENERATING FIXTURES FROM LIVE makes every geometry unit test need a browser and
 *     become non-deterministic, destroying the pure `buildPageModelFromRaw` seam that is
 *     the reason the fast tests exist.
 *
 * Comparing SHAPES keeps the unit tests pure and browser-free while making the generator
 * itself the thing under test against Chrome, on every run. A shape (which tables exist,
 * what each one is indexed by, how "absent" is encoded, what row widths occur) is
 * stable across pages and Chrome versions, but it is exactly the layer the original bug
 * lived in — so drift cannot hide in it.
 *
 * The generator therefore emits the FULL table key set Chromium emits, including the
 * sparse rare-data tables the decoder never reads. Emitting only the consumed subset is
 * what let a missing table go unnoticed the first time.
 */

import type { Protocol } from 'devtools-protocol'
import { PAGE_MODEL_COMPUTED_STYLES } from './page-model.js'

// ---------------------------------------------------------------------------
// Fixture input shapes
// ---------------------------------------------------------------------------

export interface FixtureLayout {
  bounds: [number, number, number, number]
  styles?: Record<string, string>
  paintOrder?: number
  stackingContext?: boolean
  /** LayoutText content, for text boxes. */
  text?: string
}

export interface FixtureNode {
  backendNodeId: number
  nodeName: string
  /** 1 = element (default), 3 = text, 9 = document. */
  nodeType?: number
  attributes?: Record<string, string>
  /** Absent = the node has no layout object (what `display: none` looks like). */
  layout?: FixtureLayout
  /** Marks the node in the sparse `isClickable` rare-boolean table. */
  clickable?: boolean
  children?: FixtureNode[]
}

export interface FixtureDocument {
  frameId: string
  root: FixtureNode
  scrollOffsetX?: number
  scrollOffsetY?: number
}

const DOCUMENT_NODE_TYPE = 9

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function buildCaptureSnapshot({
  documents,
  computedStyles = PAGE_MODEL_COMPUTED_STYLES,
}: {
  documents: FixtureDocument[]
  computedStyles?: readonly string[]
}): Protocol.DOMSnapshot.CaptureSnapshotResponse {
  const strings: string[] = []
  const interned = new Map<string, number>()
  // Interning is what makes the fixture exercise real indirection: repeated values
  // ('block', 'visible', 'div') come back as the SAME index from different tables.
  const s = (value: string): number => {
    const existing = interned.get(value)
    if (existing !== undefined) return existing
    strings.push(value)
    const index = strings.length - 1
    interned.set(value, index)
    return index
  }
  /** -1 is the wire encoding for "no string", not index 0. */
  const sOpt = (value: string | undefined): number => (value == null ? -1 : s(value))

  const docs: Protocol.DOMSnapshot.DocumentSnapshot[] = documents.map((doc) => {
    const parentIndex: number[] = []
    const nodeType: number[] = []
    const nodeName: number[] = []
    const nodeValue: number[] = []
    const backendNodeId: number[] = []
    const attributes: number[][] = []
    const clickableIndexes: number[] = []
    const flat: Array<{ node: FixtureNode; index: number }> = []

    const visit = (node: FixtureNode, parent: number): void => {
      const index = backendNodeId.length
      parentIndex.push(parent)
      nodeType.push(node.nodeType ?? 1)
      nodeName.push(s(node.nodeName))
      // Chromium sends `nodeValue` densely per node; elements carry the empty string.
      nodeValue.push(s(''))
      backendNodeId.push(node.backendNodeId)
      const attrs: number[] = []
      for (const [name, value] of Object.entries(node.attributes ?? {})) {
        attrs.push(s(name), s(value))
      }
      attributes.push(attrs)
      if (node.clickable) clickableIndexes.push(index)
      flat.push({ node, index })
      for (const child of node.children ?? []) visit(child, index)
    }
    visit(doc.root, -1)

    const layoutNodeIndex: number[] = []
    const layoutStyles: number[][] = []
    const bounds: number[][] = []
    const text: number[] = []
    const paintOrders: number[] = []
    const stackingIndexes: number[] = []

    for (const { node, index } of flat) {
      // Verified against Chromium: the `#document` node IS in the layout tree (paint
      // order 0, box = the layout viewport, flagged as a stacking context) but carries an
      // EMPTY styles array, because it is not an element and has no computed style. Every
      // element and text node carries the full requested list. A generator that emitted
      // only elements would let the decoder's positional check pass here and throw
      // against a real page — which is exactly what happened.
      const layout =
        node.layout ??
        (node.nodeType === DOCUMENT_NODE_TYPE
          ? { bounds: [0, 0, 800, 600] as [number, number, number, number], paintOrder: 0, stackingContext: true }
          : undefined)
      if (!layout) continue
      const layoutIndex = layoutNodeIndex.length
      layoutNodeIndex.push(index)
      bounds.push([...layout.bounds])
      // One entry per requested property, positionally — -1 where the fixture sets none.
      // Non-element, non-text nodes get `[]`, the way Chrome sends them.
      const carriesComputedStyle = node.nodeType == null || node.nodeType === 1 || node.nodeType === 3
      layoutStyles.push(carriesComputedStyle ? computedStyles.map((property) => sOpt(layout.styles?.[property])) : [])
      text.push(sOpt(layout.text))
      // Dense and exactly as long as `nodeIndex` — measured against Chromium with
      // `includePaintOrder: true`. Without that flag Chromium omits the table entirely
      // rather than shortening it, which `buildCaptureSnapshotWithoutPaintOrder` models.
      paintOrders.push(layout.paintOrder ?? layoutIndex)
      if (layout.stackingContext) stackingIndexes.push(layoutIndex)
    }

    /** Chromium's empty sparse rare tables: `{index}` for booleans, `{index,value}` otherwise. */
    const rareBool = (): Protocol.DOMSnapshot.RareBooleanData => ({ index: [] })
    const rareString = (): Protocol.DOMSnapshot.RareStringData => ({ index: [], value: [] })
    const rareInteger = (): Protocol.DOMSnapshot.RareIntegerData => ({ index: [], value: [] })

    return {
      documentURL: s(`https://example.test/${doc.frameId}`),
      title: s(''),
      baseURL: s(`https://example.test/${doc.frameId}`),
      contentLanguage: -1,
      encodingName: s('utf-8'),
      publicId: -1,
      systemId: -1,
      frameId: s(doc.frameId),
      nodes: {
        parentIndex,
        nodeType,
        // Every rare table Chromium emits is emitted here too, even though the decoder
        // reads none of them: a generator that emits only the CONSUMED subset cannot be
        // shape-compared against a real capture, and an absent table is exactly the kind
        // of drift this file exists to make impossible.
        shadowRootType: rareString(),
        nodeName,
        nodeValue,
        backendNodeId,
        attributes,
        textValue: rareString(),
        inputValue: rareString(),
        inputChecked: rareBool(),
        optionSelected: rareBool(),
        contentDocumentIndex: rareInteger(),
        pseudoType: rareString(),
        pseudoIdentifier: rareString(),
        // A sparse rare-boolean table the decoder does not consume: populated so a decoder
        // that confused rare-index lists with dense arrays would be caught.
        isClickable: { index: clickableIndexes },
        currentSourceURL: rareString(),
        originURL: rareString(),
      },
      layout: {
        nodeIndex: layoutNodeIndex,
        styles: layoutStyles,
        bounds,
        text,
        // Sparse: only the flagged layout entries appear, indexed by LAYOUT position.
        stackingContexts: { index: stackingIndexes },
        paintOrders,
      },
      textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      scrollOffsetX: doc.scrollOffsetX ?? 0,
      scrollOffsetY: doc.scrollOffsetY ?? 0,
      contentWidth: 800,
      contentHeight: 2000,
    }
  })

  return { documents: docs, strings }
}

/**
 * The same fixture with `layout.paintOrders` omitted, modelling a `captureSnapshot`
 * called WITHOUT `includePaintOrder: true`. Measured: Chromium drops the table entirely
 * in that case — it never sends a short one.
 */
export function buildCaptureSnapshotWithoutPaintOrder(
  args: Parameters<typeof buildCaptureSnapshot>[0],
): Protocol.DOMSnapshot.CaptureSnapshotResponse {
  const snapshot = buildCaptureSnapshot(args)
  for (const doc of snapshot.documents) {
    delete (doc.layout as { paintOrders?: number[] }).paintOrders
  }
  return snapshot
}

// ---------------------------------------------------------------------------
// Structural describer
// ---------------------------------------------------------------------------

/** How a table is indexed. This is the layer the original geometry bug lived in. */
export type TableKind =
  /** A dense array with one entry per NODE. */
  | 'per-node'
  /** A dense array with one entry per LAYOUT entry. */
  | 'per-layout'
  /** A dense array of rows, one row per layout entry. */
  | 'per-layout-rows'
  /** A sparse `{ index: number[] }` list of positions carrying the value. */
  | 'sparse-index'
  /** A sparse `{ index: number[], value: … }` pair of parallel lists. */
  | 'sparse-index-value'
  | 'absent'
  | 'unknown'

export interface SnapshotShape {
  documentKeys: string[]
  documents: Array<{
    nodeTableKinds: Record<string, TableKind>
    layoutTableKinds: Record<string, TableKind>
    textBoxKeys: string[]
    /** Distinct widths of `layout.bounds` rows. Must be exactly `[4]`. */
    boundsRowWidths: number[]
    /** Distinct widths of `layout.styles` rows, as categories rather than raw numbers. */
    styleRowWidths: Array<'empty' | 'full' | 'other'>
    /** Distinct widths of `nodes.attributes` rows, as a parity category. */
    attributeRowParity: Array<'even' | 'odd'>
    /** `-1` is the wire encoding for an absent string. Which tables actually use it. */
    absentStringEncoding: { parentIndexRootIsMinusOne: boolean; layoutTextUsesMinusOne: boolean }
    /** Every `stackingContexts.index` entry lies inside the LAYOUT table, never the node table. */
    stackingIndexesWithinLayoutTable: boolean
  }>
}

function kindOf(
  value: unknown,
  { nodeCount, layoutCount }: { nodeCount: number; layoutCount: number },
): TableKind {
  if (value == null) return 'absent'
  if (Array.isArray(value)) {
    const rowed = value.length > 0 && Array.isArray(value[0])
    if (value.length === layoutCount && rowed) return 'per-layout-rows'
    // A node table and a layout table can coincidentally be the same length; the caller
    // avoids that by using a fixture whose counts differ.
    if (value.length === nodeCount) return 'per-node'
    if (value.length === layoutCount) return 'per-layout'
    if (rowed) return 'per-layout-rows'
    return 'unknown'
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort()
    if (keys.length === 1 && keys[0] === 'index') return 'sparse-index'
    if (keys.length === 2 && keys[0] === 'index' && keys[1] === 'value') return 'sparse-index-value'
    return 'unknown'
  }
  return 'unknown'
}

/**
 * A structural, page-independent description of a `captureSnapshot` payload.
 *
 * Two snapshots of completely different pages describe identically; a snapshot whose
 * generator invented a table, dropped one, or got an index space wrong does not. That is
 * exactly the discrimination the geometry lane was missing.
 */
export function describeSnapshotShape(
  snapshot: Protocol.DOMSnapshot.CaptureSnapshotResponse,
  { computedStyleCount = PAGE_MODEL_COMPUTED_STYLES.length }: { computedStyleCount?: number } = {},
): SnapshotShape {
  return {
    documentKeys: Object.keys(snapshot.documents[0] ?? {}).sort(),
    documents: snapshot.documents.map((doc) => {
      const nodeCount = doc.nodes.backendNodeId?.length ?? 0
      const layoutCount = doc.layout.nodeIndex?.length ?? 0
      const counts = { nodeCount, layoutCount }

      const nodeTableKinds: Record<string, TableKind> = {}
      for (const key of Object.keys(doc.nodes).sort()) {
        nodeTableKinds[key] = kindOf((doc.nodes as Record<string, unknown>)[key], counts)
      }
      const layoutTableKinds: Record<string, TableKind> = {}
      for (const key of Object.keys(doc.layout).sort()) {
        layoutTableKinds[key] = kindOf((doc.layout as unknown as Record<string, unknown>)[key], counts)
      }

      const styleRowWidths = [
        ...new Set(
          (doc.layout.styles ?? []).map((row) =>
            row.length === 0 ? 'empty' : row.length === computedStyleCount ? 'full' : 'other',
          ),
        ),
      ].sort() as Array<'empty' | 'full' | 'other'>

      const attributeRowParity = [
        ...new Set((doc.nodes.attributes ?? []).map((row) => (row.length % 2 === 0 ? 'even' : 'odd'))),
      ].sort() as Array<'even' | 'odd'>

      const stackingIndex = doc.layout.stackingContexts?.index ?? []

      return {
        nodeTableKinds,
        layoutTableKinds,
        textBoxKeys: Object.keys(doc.textBoxes ?? {}).sort(),
        boundsRowWidths: [...new Set((doc.layout.bounds ?? []).map((row) => row.length))].sort((a, b) => a - b),
        styleRowWidths,
        attributeRowParity,
        absentStringEncoding: {
          parentIndexRootIsMinusOne: (doc.nodes.parentIndex ?? [])[0] === -1,
          layoutTextUsesMinusOne: (doc.layout.text ?? []).includes(-1),
        },
        stackingIndexesWithinLayoutTable: stackingIndex.every((i) => i >= 0 && i < layoutCount),
      }
    }),
  }
}
