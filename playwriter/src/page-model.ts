/**
 * page-model.ts — Milestone 1 of the PageModel feature.
 *
 * A PageModel is a tree of DOM/CSS/JS nodes fused from four independent sources:
 *   - the ARIA snapshot (role/name/locator + backendNodeId)          — aria-snapshot.ts
 *   - the flattened DOM  (tag + attributes, keyed by backendNodeId)  — CDP DOM.getFlattenedDocument
 *   - the layout snapshot (box / paint order / computed styles)      — CDP DOMSnapshot.captureSnapshot
 *   - lazy edges: React fiber info and matched CSS rules             — react-source.ts / M2
 *
 * The node shape is `PageNode`-compatible (a `type` field plus children under a
 * visitor key) so the generic traversal core in `page-path.ts` can walk it. This
 * module does NOT reimplement traversal — it registers node types with page-path
 * and delegates `query`/`traverse` to it.
 *
 * Two build entry points:
 *   - `buildPageModel({ page, cdp, rootSelector })`  — talks to the browser (CDP + aria)
 *   - `buildPageModelFromRaw({ ariaTree, domByBackendId, frameId, geometry })` — pure
 *     fuse/project, unit-testable without a browser. `buildPageModel` is a thin CDP
 *     wrapper over it.
 *
 * Ground truth vs inference — the distinction matters and is kept explicit:
 *   - box / paintOrder / computedStyles / stacking-context flag come straight out of
 *     the layout snapshot: ground truth for the instant the snapshot was taken.
 *   - `visible`, `inViewport` and `occluded` are *computed* from that data. They are
 *     inferences, and each carries a doc comment naming what it can get wrong.
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

/**
 * A rectangle in CSS pixels, in the coordinate space of its own frame's DOCUMENT.
 *
 * Measured against Chromium rather than assumed, because two comments in this file used
 * to disagree about it. `DOMSnapshot.captureSnapshot`'s `layout.bounds` is:
 *
 *   - DOCUMENT space, not viewport space. Scrolled to y=900, an element whose
 *     `getBoundingClientRect().y` is 308 reports `bounds[1] === 1208` — the scroll offset
 *     is already included. `position: fixed` is no exception: its rect reads 10 in the
 *     viewport and 910 in the snapshot at the same scroll. So `scrollOffsetY` must NOT be
 *     added again, which is why nothing in this module ever reads it.
 *   - CSS pixels, NOT device pixels. At `deviceScaleFactor` 1, 2 and 3 the very same page
 *     reports byte-identical bounds. Nothing here is "converted through the DPR".
 *
 * `Page.getLayoutMetrics().cssLayoutViewport` is in the same space (`pageX`/`pageY` are
 * the scroll offsets), which is what makes `intersect(box, viewport)` in `inViewport`
 * a comparison between two rectangles in one space.
 */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** How a node changed between two models. A node can change in several ways at once. */
export type NodeChangeKind = 'new' | 'moved' | 'style' | 'removed' | 'hidden' | 'shown'

export interface StylePropertyChange {
  property: string
  /** Value in the previous model. Absent when the property was not reported before. */
  from?: string
  /** Value in this model. Absent when the property is no longer reported. */
  to?: string
}

export interface NodeChange {
  kind: NodeChangeKind
  /** 'moved' only — the previous and current boxes plus the per-edge delta. */
  from?: Box
  to?: Box
  delta?: { dx: number; dy: number; dw: number; dh: number }
  /** 'style' | 'hidden' | 'shown' — exactly which tracked properties changed. */
  properties?: StylePropertyChange[]
  /** 'hidden' | 'shown' — why the node started/stopped rendering, in one phrase. */
  reason?: string
}

/**
 * A node that existed in the previous model and is gone from this one. Removed nodes
 * have no node object to tag, so they are carried as records on the model itself —
 * dropping them would defeat the point of the diff (catching disappearing UI).
 */
export interface RemovedNodeRecord {
  key: NodeKey
  role?: string
  name?: string
  tag: string
  locator?: string
  /** The box the node last occupied, when the previous model had measured it. */
  box?: Box
}

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
    /**
     * INFERENCE. True when the node is laid out, has a non-degenerate box and is not
     * hidden by `visibility` / `opacity` / `content-visibility` (its own or an
     * ancestor's opacity). Deliberately says nothing about the viewport — scrolled out
     * of view is `inViewport: false`, not `visible: false`.
     *
     * ABSENT means the node could not be measured at all, which happens for exactly two
     * kinds of node: an a11y-only node (no `backendNodeId`, so nothing to join geometry
     * to — these are excluded from `byKey`), and a node whose `backendNodeId` appears in
     * no captured document (user-agent shadow content, or a node the DOM created between
     * the a11y and layout passes). There is deliberately NO default: absence is not
     * `false` ("measured and hidden") and above all not `true`. `visibleOnly` and
     * `VisibleElement` treat absence as not-visible, so an unmeasurable node can never
     * be mistaken for a visible one.
     */
    visible?: boolean
    /**
     * GROUND TRUTH. True when the node has a layout object. False means it is not
     * rendered at all — `display: none`, inside a `content-visibility: hidden` subtree,
     * or otherwise un-laid-out. Absent under exactly the same conditions as `visible`,
     * with which it is always present or absent together. A real distinction from
     * `visible`, kept separate on purpose.
     */
    rendered?: boolean
    /**
     * INFERENCE. True when the node's box intersects the layout viewport after
     * intersecting the visible rect of its clipping (scroll-container) ancestors.
     * `undefined` when the frame's viewport is unknown. Independent of `visible`.
     */
    inViewport?: boolean
    /** GROUND TRUTH. The absolute border box from the layout snapshot, in CSS px. */
    box?: Box
    /**
     * GROUND TRUTH. Chromium's global paint order index. Nodes painted together share
     * an index; higher paints later, i.e. on top.
     */
    paintOrder?: number
    /** GROUND TRUTH. Whether the node establishes its own stacking context. */
    stackingContext?: boolean
    /**
     * The declared reasons that explain `stackingContext` (e.g. `position:fixed`,
     * `opacity:0.5`). Derived from the tracked computed styles, so it explains the flag
     * rather than deciding it — and therefore absent when the context is structural
     * rather than declared, as it is for the `#document` box. MEASURED against Chromium
     * 145: the `#document` layout row (layout index 0) is present in
     * `layout.stackingContexts.index` and its `layout.styles` entry is an EMPTY array, so
     * there is no declaration to derive a reason from — hence `stackingReasons` is absent
     * for it rather than empty-because-nothing-matched.
     */
    stackingReasons?: string[]
    /**
     * The computed values of `PAGE_MODEL_COMPUTED_STYLES` only. Empty when the node has
     * no layout object — that means "nothing was reported", not "no styles apply".
     */
    computedStyles: Record<string, string>
    /**
     * INFERENCE, not a hit test. Set when another node paints over this one: `'full'`
     * when the covering nodes leave no uncovered area, `'partial'` otherwise. A
     * half-covered button is a different state from a fully covered one, so the two are
     * never collapsed. Undefined means "no covering node found" (or unmeasured).
     *
     * Computed from paint order + bounds containment, so it can be wrong when the real
     * painted shape is not the bounds rectangle: `clip-path`, `border-radius` corners,
     * rotated/skewed `transform`s, a covering node that paints nothing (fully
     * transparent background), and overlays living in a different frame (each frame's
     * bounds are in its own coordinate space, so cross-frame overlap is not computed).
     * `DOM.getNodeForLocation` is the ground-truth hit test for a single point —
     * reconcile with `anchorAt` when the answer has to be certain.
     */
    occluded?: 'partial' | 'full'
    /** Estimated fraction of this node's box covered by `occludedBy` (0..1). */
    occludedFraction?: number
    /**
     * Keys of the covering nodes, topmost (highest paint order) first. A key is always
     * a real `${frameId}:${backendNodeId}`, but overlays frequently are not in the a11y
     * tree, so `byKey.get(...)` may not resolve one — see `occludedByLabels`.
     */
    occludedBy?: NodeKey[]
    /** `tag#id.class` for each entry of `occludedBy`, same order. */
    occludedByLabels?: string[]
    /** The dominant change vs the previous model. See `changes` for the full set. */
    changedSince?: NodeChangeKind
    /** Every way this node changed vs the previous model, with the details. */
    changes?: NodeChange[]
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
  /**
   * A **page-path** selector (`'element#main'`, `'Interactive'`, `'*'`) naming the
   * subtree(s) to project. Not CSS, and not the same language as
   * `buildPageModel({ rootSelector })` — see the note on `rootSelector`.
   * An unmatched `within` throws: a scope is a precondition, not a filter.
   */
  within?: string
  /** @deprecated Alias for `within` (same page-path language). Use `within`. */
  scope?: string
  roles?: string[]
  depth?: number
  fields?: string[]
  /**
   * Keep only nodes with `runtime.visible === true` — laid out and not hidden. A node
   * that could not be measured has no `visible` at all and is excluded, never assumed.
   */
  visibleOnly?: boolean
  /** Keep only nodes with `runtime.inViewport === true` — a different question. */
  inViewportOnly?: boolean
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
// Geometry: the computed-style request list
// ---------------------------------------------------------------------------

/**
 * The exact computed-style properties requested from `DOMSnapshot.captureSnapshot`.
 * The list is deliberately short: every property here is consumed by something below,
 * and nothing is requested "just in case" — the response carries one string-table
 * index per property per laid-out node, so the list is the cost of the whole pass.
 *
 *  (1) `display`, `visibility`, `opacity`, `content-visibility`
 *      → the `runtime.visible` predicate. `display` is kept even though a `display:none`
 *        node has no layout record at all, because it is the answer to "why is this not
 *        rendered" for the ancestor that *does* have one (e.g. `display: contents`).
 *  (2) `pointer-events`
 *      → occlusion. A node that cannot receive pointer events does not block
 *        interaction, so it must not be reported as an occluder.
 *  (3) `overflow-x`, `overflow-y`
 *      → `runtime.inViewport`: a node scrolled out of an `overflow: auto/hidden/clip`
 *        ancestor is off-screen even when it is inside the layout viewport. The
 *        longhands are requested rather than the `overflow` shorthand because the
 *        snapshot resolves one CSS property id per requested name, and shorthand
 *        serialization there is not guaranteed.
 *  (4) `position`, `z-index`, `isolation`, `mix-blend-mode`, `will-change`, `contain`,
 *      `transform`, `filter`
 *      → stacking analysis. The *fact* of a stacking context comes from the snapshot's
 *        own `layout.stackingContexts` flag (ground truth); these declarations exist so
 *        the model can explain WHY (`runtime.stackingReasons`) instead of re-deriving a
 *        rule Chromium already applied. `position` additionally decides which ancestors
 *        clip a node in (3).
 *  (5) `clip-path`
 *      → the honesty flag for occlusion: together with `transform`/`filter` it names
 *        when an occluder's bounds rectangle is not the shape it actually paints, which
 *        is precisely when the geometric occlusion inference can be wrong.
 */
export const PAGE_MODEL_COMPUTED_STYLES: readonly string[] = [
  'display',
  'visibility',
  'opacity',
  'content-visibility',
  'pointer-events',
  'overflow-x',
  'overflow-y',
  'position',
  'z-index',
  'isolation',
  'mix-blend-mode',
  'will-change',
  'contain',
  'transform',
  'filter',
  'clip-path',
]

/** One laid-out node, decoded out of a `DocumentSnapshot`'s layout table. */
export interface SnapshotNodeGeometry {
  backendNodeId: number
  /** Index into the owning document's `NodeTreeSnapshot` tables. */
  nodeIndex: number
  /** DOM nodeType (1 = element, 3 = text). */
  nodeType: number
  nodeName: string
  /** `tag#id.class`, for reports about nodes that are not in the model. */
  label: string
  box: Box
  paintOrder?: number
  styles: Record<string, string>
  stackingContext: boolean
}

/** Everything decoded for one document (= one frame) of a `captureSnapshot`. */
export interface FrameGeometry {
  frameId: string
  /** Laid-out nodes, keyed by backendNodeId. Absent = not rendered. */
  byBackendId: Map<number, SnapshotNodeGeometry>
  /** Laid-out nodes, keyed by their index in the document's node tree. */
  byNodeIndex: Map<number, SnapshotNodeGeometry>
  /** Every backendNodeId in this document's node tree, laid out or not. */
  documentBackendIds: Set<number>
  /** `NodeTreeSnapshot.parentIndex` — the ancestry table (-1 at the root). */
  parentIndex: number[]
  /**
   * The document's scroll offset, as Chromium reported it.
   *
   * Deliberately NOT applied to `box`, and deliberately not read anywhere in this
   * module: `layout.bounds` is ALREADY in document space with the scroll included
   * (measured — see the `Box` doc comment), so adding this would double-count it and
   * shift every box by a screenful. It is carried because it is the frame's own answer
   * to "how far is this document scrolled", which a caller converting a box to viewport
   * coordinates needs, and because deleting it would leave the next reader to re-derive
   * the coordinate space from scratch — which is how the two contradictory comments this
   * replaces came to exist.
   */
  scrollOffsetX: number
  scrollOffsetY: number
  /**
   * The layout viewport in this document's coordinates, when known. The *layout*
   * viewport is used rather than the visual viewport because pinch-zoom is a transient
   * user gesture: `inViewport` should describe the page, not the user's current zoom.
   */
  viewport?: Box
}

const TEXT_NODE_TYPE = 3
const ELEMENT_NODE_TYPE = 1

/**
 * Decode a `DOMSnapshot.captureSnapshot` response into per-frame geometry.
 *
 * The payload is a set of index tables over one shared string table, so decoding is
 * all indirection: `strings[nodes.nodeName[i]]`, `layout.nodeIndex[j] -> i`, and the
 * `RareBooleanData`/`RareStringData` fields are *sparse index lists* (an `index[]` of
 * the node/layout positions that carry the value) rather than dense per-node arrays.
 *
 * Decode failures throw. A silently half-decoded snapshot would produce confidently
 * wrong geometry, which is worse than no geometry at all.
 *
 * Note on frames (checked against Chromium, both with and without site isolation): one
 * `captureSnapshot` returns one `DocumentSnapshot` per document the page's own renderer
 * hosts, each with its own `frameId`. Under site isolation (real Chrome's default) a
 * cross-origin iframe is a separate target and is simply absent from this response —
 * capture it on its own session and merge via `into`. With site isolation off, that same
 * iframe arrives here as an extra document; keying by `frameId` handles both without
 * changing anything.
 *
 * Each document's bounds are in ITS OWN coordinate space (a button at y=8 inside an
 * iframe positioned at y=66 in its parent reports y=8), so boxes are never compared
 * across documents. `paintOrders`, by contrast, ARE global across the documents of one
 * response.
 */
export function decodeCaptureSnapshot({
  snapshot,
  computedStyles = PAGE_MODEL_COMPUTED_STYLES,
  viewports,
  into,
}: {
  snapshot: Protocol.DOMSnapshot.CaptureSnapshotResponse
  /** The property names passed as `computedStyles` to captureSnapshot, in order. */
  computedStyles?: readonly string[]
  /** frameId -> layout viewport in that frame's document coordinates. */
  viewports?: Record<string, Box>
  /** Merge into an existing map (for OOPIF documents captured separately). */
  into?: Map<string, FrameGeometry>
}): Map<string, FrameGeometry> {
  const strings = snapshot.strings
  if (!Array.isArray(strings)) {
    throw new Error('decodeCaptureSnapshot: response has no `strings` table')
  }
  // StringIndex is -1 when the value is absent; any other out-of-range index means the
  // payload and the string table disagree, which is a decode bug worth seeing.
  const str = (index: number | undefined): string => {
    if (index == null || index < 0) return ''
    const value = strings[index]
    if (value === undefined) {
      throw new Error(`decodeCaptureSnapshot: string index ${index} is out of range (${strings.length} strings)`)
    }
    return value
  }

  const result = into ?? new Map<string, FrameGeometry>()

  snapshot.documents.forEach((doc, docIndex) => {
    // A document Chromium did not attribute to a frame still holds real geometry, so it
    // is keyed under a synthetic id rather than dropped: nodes in it are then found by
    // `lookupGeometry`'s same-process fallback instead of being reported as un-rendered.
    // A synthetic id cannot collide with a real frameId (a real one is 32 hex characters
    // and contains no `#`).
    //
    // NOT REPRODUCED HERE — this branch is defensive, and saying so is the honest status.
    // `DocumentSnapshot.frameId` is optional in the protocol, but every shape tried against
    // Chromium 145 produced a real 32-hex frameId on every document: a srcdoc iframe, an
    // `about:blank` iframe, a `sandbox` iframe and an open shadow root gave 4 documents,
    // all four with a populated `frameId` string index. So the case this handles was not
    // observed, and it is kept because dropping a document that DOES lack one would move
    // every node in it to `unmeasurable` — a silent loss of geometry — whereas keying it
    // synthetically costs nothing when the case never arises. What would settle it: a
    // document whose `frameId` string index is absent or -1 in a real capture.
    const frameId = str(doc.frameId) || `#unframed-document-${docIndex}`

    const nodes = doc.nodes
    const layout = doc.layout
    const nodeCount = nodes.backendNodeId?.length ?? 0
    if (!nodes.backendNodeId) {
      throw new Error(`decodeCaptureSnapshot: documents[${docIndex}].nodes has no backendNodeId table`)
    }
    // Ancestry drives the occlusion ancestor/descendant rule and the clip walk. Without
    // it both would silently degrade into confident wrong answers (a node "occluded" by
    // its own child), so a multi-node document with no parentIndex table is a hard error.
    if (!nodes.parentIndex && nodeCount > 1) {
      throw new Error(
        `decodeCaptureSnapshot: documents[${docIndex}].nodes has no parentIndex table, so ancestry cannot be resolved`,
      )
    }
    if (layout.nodeIndex.length !== layout.bounds.length || layout.nodeIndex.length !== layout.styles.length) {
      throw new Error(
        `decodeCaptureSnapshot: documents[${docIndex}].layout tables disagree ` +
          `(nodeIndex=${layout.nodeIndex.length} bounds=${layout.bounds.length} styles=${layout.styles.length})`,
      )
    }
    // `paintOrders` is read POSITIONALLY (`paintOrders[layoutIndex]`), exactly like
    // `bounds` and `styles`, but it was the one parallel table nobody length-checked —
    // the same bug class as the `styles[]` misalignment that already bit.
    //
    // Measured against Chromium: with `includePaintOrder: true` the array is dense and
    // exactly `nodeIndex.length` long (every laid-out node has an order, including text
    // boxes and the `#document` node at order 0); WITHOUT the flag the table is absent
    // entirely rather than short. Those are the only two shapes, so they are the only
    // two accepted. A short array would silently give node N the paint order of some
    // other node, and paint order is what decides every occlusion verdict and every
    // `hitTestPoint` answer.
    if (layout.paintOrders && layout.paintOrders.length !== layout.nodeIndex.length) {
      throw new Error(
        `decodeCaptureSnapshot: documents[${docIndex}].layout.paintOrders has ${layout.paintOrders.length} entries ` +
          `but the layout table has ${layout.nodeIndex.length} — paintOrders is indexed by LAYOUT position, so a ` +
          `mismatch means every occlusion and hit-test answer would be computed from another node's paint order`,
      )
    }

    const documentBackendIds = new Set<number>(nodes.backendNodeId)
    // `stackingContexts` indexes LAYOUT positions (it lives on LayoutTreeSnapshot),
    // not node positions — mixing the two up silently mislabels every stacking context.
    //
    // Measured, not assumed: on a page whose `#sc` element sits at layout index 8 and
    // node index 15, Chromium's `stackingContexts.index` contains 8 and not 15; the same
    // for a `position: fixed` element at layout 12 / node 22. The whole list also stays
    // inside the LAYOUT table (max 13 of 16 layout entries, on a document with 30 nodes),
    // which is only possible under the layout-index reading.
    const stackingIndex = layout.stackingContexts?.index ?? []
    for (const index of stackingIndex) {
      if (!Number.isInteger(index) || index < 0 || index >= layout.nodeIndex.length) {
        throw new Error(
          `decodeCaptureSnapshot: documents[${docIndex}].layout.stackingContexts.index contains ${index}, which is ` +
            `outside the layout table (${layout.nodeIndex.length} entries). These are LAYOUT indexes, not node ` +
            `indexes (the node table has ${nodeCount}) — reading them as node indexes mislabels every stacking context`,
        )
      }
    }
    const stackingLayoutIndexes = new Set<number>(stackingIndex)

    const byBackendId = new Map<number, SnapshotNodeGeometry>()
    const byNodeIndex = new Map<number, SnapshotNodeGeometry>()

    for (let layoutIndex = 0; layoutIndex < layout.nodeIndex.length; layoutIndex++) {
      const nodeIndex = layout.nodeIndex[layoutIndex]
      if (nodeIndex < 0 || nodeIndex >= nodeCount) {
        throw new Error(
          `decodeCaptureSnapshot: layout[${layoutIndex}].nodeIndex ${nodeIndex} is outside the node table (${nodeCount})`,
        )
      }
      const backendNodeId = nodes.backendNodeId[nodeIndex]
      const bounds = layout.bounds[layoutIndex]
      if (!Array.isArray(bounds) || bounds.length < 4) {
        throw new Error(`decodeCaptureSnapshot: layout[${layoutIndex}].bounds is not an [x,y,w,h] rectangle`)
      }

      // The style table is positional: entry `p` is the value of `computedStyles[p]`.
      // Chrome sends an EMPTY array for a layout node that is not an element and so has
      // no computed style — the `#document` node itself is always one of these. That is
      // "no computed styles", and nothing can be misattributed when there is nothing to
      // attribute. Any OTHER length is genuine positional misalignment: the values would
      // land on the wrong property names, so it stays a hard error. (It cannot be caused
      // by a bad name in the request list: Chrome rejects `captureSnapshot` outright with
      // "invalid CSS property" — verified — rather than quietly shortening the rows.)
      const styleIndexes = layout.styles[layoutIndex] ?? []
      if (styleIndexes.length !== 0 && styleIndexes.length !== computedStyles.length) {
        throw new Error(
          `decodeCaptureSnapshot: layout[${layoutIndex}].styles has ${styleIndexes.length} entries but ` +
            `${computedStyles.length} properties were requested — the style table is positional, so a ` +
            `mismatch means the values would be attributed to the wrong properties`,
        )
      }
      const styles: Record<string, string> = {}
      for (let p = 0; p < styleIndexes.length; p++) {
        const value = str(styleIndexes[p])
        // An empty string means "not reported for this node"; keeping it would look
        // like a real computed value of ''.
        if (value !== '') styles[computedStyles[p]] = value
      }

      const nodeName = str(nodes.nodeName?.[nodeIndex])
      const attributes = decodeAttributes(nodes.attributes?.[nodeIndex], str)
      const record: SnapshotNodeGeometry = {
        backendNodeId,
        nodeIndex,
        nodeType: nodes.nodeType?.[nodeIndex] ?? ELEMENT_NODE_TYPE,
        nodeName,
        label: describeSnapshotNode(nodeName, attributes),
        box: { x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] },
        paintOrder: layout.paintOrders?.[layoutIndex],
        styles,
        stackingContext: stackingLayoutIndexes.has(layoutIndex),
      }
      // One backendNodeId CAN appear twice in the layout table: a `::before`/`::after`
      // pseudo-element gets its own backendNodeId (not its originator's, so a real
      // element's box is never at risk) and contributes both its own block box and the
      // inline box of its generated content. Keeping the first entry keeps the outer box,
      // which is the pseudo's actual area.
      //
      // MEASURED against Chromium 145 on `#pseudo::before { content: "BEFORE" }`: exactly
      // one backendNodeId (11) appears twice in the layout table, at layout indexes 4 and
      // 5, both mapping to node index 8 whose `nodeName` is `::before` and whose
      // `pseudoType` is `before`. Its originator `<div id=pseudo>` is a DIFFERENT node
      // (node index 7, backendNodeId 10) and appears once. So the duplicate is confined to
      // the pseudo, exactly as this assumed.
      if (!byBackendId.has(backendNodeId)) byBackendId.set(backendNodeId, record)
      if (!byNodeIndex.has(nodeIndex)) byNodeIndex.set(nodeIndex, record)
    }

    result.set(frameId, {
      frameId,
      byBackendId,
      byNodeIndex,
      documentBackendIds,
      parentIndex: nodes.parentIndex ?? [],
      scrollOffsetX: doc.scrollOffsetX ?? 0,
      scrollOffsetY: doc.scrollOffsetY ?? 0,
      viewport: viewports?.[frameId],
    })
  })

  return result
}

function decodeAttributes(
  flattened: Protocol.DOMSnapshot.ArrayOfStrings | undefined,
  str: (index: number | undefined) => string,
): Record<string, string> {
  const attributes: Record<string, string> = {}
  if (!flattened) return attributes
  for (let i = 0; i + 1 < flattened.length; i += 2) {
    attributes[str(flattened[i])] = str(flattened[i + 1])
  }
  return attributes
}

function describeSnapshotNode(nodeName: string, attributes: Record<string, string>): string {
  let label = nodeName.toLowerCase()
  if (attributes.id) label += `#${attributes.id}`
  if (attributes.class) {
    const classes = attributes.class.trim().split(/\s+/).filter(Boolean)
    if (classes.length) label += `.${classes.join('.')}`
  }
  return label
}

// ---------------------------------------------------------------------------
// Geometry: predicates over the decoded snapshot (pure)
// ---------------------------------------------------------------------------

const HIDDEN_VISIBILITY = new Set(['hidden', 'collapse'])
/** `overflow` values that clip descendants. `visible` (and only it) does not. */
const NON_CLIPPING_OVERFLOW = new Set(['visible'])

function parseOpacity(value: string | undefined): number {
  if (value == null || value === '') return 1
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 1
}

/** Walk `parentIndex` from `nodeIndex` upward, testing for `maybeAncestor`. */
function isSelfOrAncestor(parentIndex: number[], nodeIndex: number, maybeAncestor: number): boolean {
  let current = nodeIndex
  let guard = 0
  while (current >= 0) {
    if (current === maybeAncestor) return true
    current = parentIndex[current] ?? -1
    // parentIndex is a tree; a cycle means the payload is corrupt, not that we should
    // spin forever.
    if (++guard > 100000) {
      throw new Error('decodeCaptureSnapshot: cycle detected in NodeTreeSnapshot.parentIndex')
    }
  }
  return false
}

/**
 * INFERENCE. Is this laid-out node visible on its own terms?
 *
 * Laid out + non-degenerate box + not hidden by `visibility` / `opacity` /
 * `content-visibility`. `visibility` is inherited so the node's own computed value
 * already accounts for ancestors; `opacity` is not, so ancestor opacity is walked.
 * Deliberately ignores the viewport and any covering node — those are `inViewport`
 * and `occluded`.
 */
function isGeometricallyVisible(record: SnapshotNodeGeometry, frame: FrameGeometry, cache: Map<number, boolean>): boolean {
  if (record.box.width <= 0 || record.box.height <= 0) return false
  const styles = record.styles
  if (HIDDEN_VISIBILITY.has(styles['visibility'] ?? '')) return false
  if (styles['content-visibility'] === 'hidden') return false
  return isOpaqueChain(record.nodeIndex, frame, cache)
}

/** True when neither this node nor any laid-out ancestor has `opacity: 0`. */
function isOpaqueChain(nodeIndex: number, frame: FrameGeometry, cache: Map<number, boolean>): boolean {
  const cached = cache.get(nodeIndex)
  if (cached !== undefined) return cached
  const record = frame.byNodeIndex.get(nodeIndex)
  const selfOpaque = record ? parseOpacity(record.styles['opacity']) > 0 : true
  let opaque = selfOpaque
  if (opaque) {
    const parent = frame.parentIndex[nodeIndex] ?? -1
    opaque = parent < 0 ? true : isOpaqueChain(parent, frame, cache)
  }
  cache.set(nodeIndex, opaque)
  return opaque
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * INFERENCE. The rect this node can actually be seen through: the layout viewport,
 * intersected with the boxes of the ancestors that clip it.
 *
 * Which ancestors clip is decided the way CSS decides it, approximately:
 *   - a `position: fixed` node's containing block is the viewport, so no ancestor
 *     scroll container clips it;
 *   - an `overflow != visible` ancestor clips in-flow and relatively-positioned
 *     descendants;
 *   - for an absolutely-positioned node, only ancestors that are themselves in its
 *     containing-block chain (positioned, or transformed/contained) clip it.
 * Not modelled: `clip-path`, per-axis clipping (an `overflow-x: hidden` /
 * `overflow-y: visible` pair clips both axes here), clipping by a transformed ancestor's
 * *rotated* box, and the border-box/padding-box difference (the clip is taken as the
 * ancestor's border box, so it is up to a border width too generous). Returns undefined
 * when the frame's viewport is unknown — that is "unknown", not "not in the viewport".
 */
function visibleClipRect(record: SnapshotNodeGeometry, frame: FrameGeometry): Box | null | undefined {
  if (!frame.viewport) return undefined
  let clip: Box | null = frame.viewport
  const position = record.styles['position'] ?? 'static'
  if (position === 'fixed') return clip

  const isAbsolute = position === 'absolute'
  let parent = frame.parentIndex[record.nodeIndex] ?? -1
  let guard = 0
  while (parent >= 0 && clip) {
    const ancestor = frame.byNodeIndex.get(parent)
    if (ancestor) {
      const overflowX = ancestor.styles['overflow-x'] ?? 'visible'
      const overflowY = ancestor.styles['overflow-y'] ?? 'visible'
      const clips = !NON_CLIPPING_OVERFLOW.has(overflowX) || !NON_CLIPPING_OVERFLOW.has(overflowY)
      if (clips) {
        const ancestorPosition = ancestor.styles['position'] ?? 'static'
        const inContainingBlockChain =
          !isAbsolute ||
          ancestorPosition !== 'static' ||
          (ancestor.styles['transform'] ?? 'none') !== 'none' ||
          (ancestor.styles['filter'] ?? 'none') !== 'none' ||
          ancestor.styles['contain'] != null
        if (inContainingBlockChain) {
          clip = intersect(clip, ancestor.box)
        }
      }
      // A fixed ancestor re-roots the containing block at the viewport; nothing above
      // it can clip us any further.
      if ((ancestor.styles['position'] ?? 'static') === 'fixed') break
    }
    parent = frame.parentIndex[parent] ?? -1
    if (++guard > 100000) {
      throw new Error('decodeCaptureSnapshot: cycle detected in NodeTreeSnapshot.parentIndex')
    }
  }
  return clip
}

// --- occlusion --------------------------------------------------------------

/** Topmost-first occluders and how much of the target they cover. */
export interface OcclusionResult {
  state: 'partial' | 'full'
  /** Estimated covered fraction of the target box (0..1). */
  coveredFraction: number
  by: NodeKey[]
  labels: string[]
}

/**
 * At most this many covering nodes are subtracted from a target box. Rect subtraction
 * splits the remainder into up to 4 fragments per cut, so an unbounded list can blow
 * up; the cuts are taken topmost-first, which is the order that decides the answer.
 */
const MAX_OCCLUDER_CUTS = 16
/** Fragment cap for the same reason. Hitting it can only under-report coverage. */
const MAX_REMAINDER_FRAGMENTS = 256
/** Remainders thinner than this are rounding noise, not visible slivers (px²). */
const MIN_VISIBLE_FRAGMENT_AREA = 0.5

/** The part of `target` not covered by `cut`, as up to four fragments. */
function subtractRect(target: Box, cut: Box): Box[] {
  const overlap = intersect(target, cut)
  if (!overlap) return [target]
  const fragments: Box[] = []
  // top
  if (overlap.y > target.y) {
    fragments.push({ x: target.x, y: target.y, width: target.width, height: overlap.y - target.y })
  }
  // bottom
  const overlapBottom = overlap.y + overlap.height
  const targetBottom = target.y + target.height
  if (overlapBottom < targetBottom) {
    fragments.push({ x: target.x, y: overlapBottom, width: target.width, height: targetBottom - overlapBottom })
  }
  // left
  if (overlap.x > target.x) {
    fragments.push({ x: target.x, y: overlap.y, width: overlap.x - target.x, height: overlap.height })
  }
  // right
  const overlapRight = overlap.x + overlap.width
  const targetRight = target.x + target.width
  if (overlapRight < targetRight) {
    fragments.push({ x: overlapRight, y: overlap.y, width: targetRight - overlapRight, height: overlap.height })
  }
  return fragments
}

function areaOf(box: Box): number {
  return Math.max(0, box.width) * Math.max(0, box.height)
}

/** Fraction of `target` covered by `cuts`, computed by rectangle subtraction (exact union). */
function coveredFraction(target: Box, cuts: Box[]): number {
  const total = areaOf(target)
  if (total <= 0) return 0
  let remainder: Box[] = [target]
  for (const cut of cuts) {
    const next: Box[] = []
    for (const fragment of remainder) {
      for (const piece of subtractRect(fragment, cut)) {
        if (areaOf(piece) >= MIN_VISIBLE_FRAGMENT_AREA) next.push(piece)
      }
    }
    remainder = next
    if (remainder.length === 0) break
    if (remainder.length > MAX_REMAINDER_FRAGMENTS) break
  }
  const uncovered = remainder.reduce((sum, box) => sum + areaOf(box), 0)
  return Math.min(1, Math.max(0, 1 - uncovered / total))
}

/**
 * INFERENCE. Compute occlusion for `targets` within one frame, from paint order and
 * bounds containment.
 *
 * Semantics, stated so callers know exactly what the answer means:
 *   - An occluder must paint strictly later (`paintOrder >`) than the target. Nodes
 *     that share a paint order were painted together and cannot be ordered, so they
 *     never occlude each other.
 *   - An occluder must itself be visible (same predicate as `runtime.visible`) and not
 *     `pointer-events: none` — a node that cannot receive a pointer does not block
 *     interaction with what is under it.
 *   - Only elements occlude. A text box is part of its element's own paint, so
 *     counting it separately would report an element as occluded by its own text.
 *   - Ancestors and descendants of the target are excluded. A child painting over its
 *     parent is the parent's own content, not an overlay, and an ancestor's box
 *     contains its descendant by construction. Only unrelated subtrees occlude.
 *   - `'full'` means the union of the covering rectangles leaves no visible remainder;
 *     `'partial'` means some of the box is still exposed. These are never collapsed.
 */
export function computeFrameOcclusion({
  frame,
  targets,
  visibilityCache,
}: {
  frame: FrameGeometry
  targets: SnapshotNodeGeometry[]
  visibilityCache?: Map<number, boolean>
}): Map<number, OcclusionResult> {
  const cache = visibilityCache ?? new Map<number, boolean>()
  const results = new Map<number, OcclusionResult>()
  if (targets.length === 0) return results

  const occluders: SnapshotNodeGeometry[] = []
  for (const record of frame.byNodeIndex.values()) {
    if (record.nodeType !== ELEMENT_NODE_TYPE) continue
    if (record.paintOrder == null) continue
    if (record.styles['pointer-events'] === 'none') continue
    if (!isGeometricallyVisible(record, frame, cache)) continue
    occluders.push(record)
  }
  // Topmost first: this is both the reported order and the order the cuts are applied.
  occluders.sort((a, b) => (b.paintOrder ?? 0) - (a.paintOrder ?? 0))

  for (const target of targets) {
    if (target.paintOrder == null) continue
    if (areaOf(target.box) <= 0) continue
    if (!isGeometricallyVisible(target, frame, cache)) continue

    const covering: SnapshotNodeGeometry[] = []
    for (const candidate of occluders) {
      if (candidate.paintOrder == null || candidate.paintOrder <= target.paintOrder) continue
      if (!intersect(target.box, candidate.box)) continue
      if (candidate.nodeIndex === target.nodeIndex) continue
      if (
        isSelfOrAncestor(frame.parentIndex, candidate.nodeIndex, target.nodeIndex) ||
        isSelfOrAncestor(frame.parentIndex, target.nodeIndex, candidate.nodeIndex)
      ) {
        continue
      }
      covering.push(candidate)
      if (covering.length >= MAX_OCCLUDER_CUTS) break
    }
    if (covering.length === 0) continue

    const fraction = coveredFraction(
      target.box,
      covering.map((c) => c.box),
    )
    if (fraction <= 0) continue
    results.set(target.backendNodeId, {
      state: fraction >= 1 ? 'full' : 'partial',
      coveredFraction: fraction,
      by: covering.map((c) => `${frame.frameId}:${c.backendNodeId}` as NodeKey),
      labels: covering.map((c) => c.label),
    })
  }

  return results
}

/** The declared reasons a node establishes a stacking context, for reporting. */
export function stackingContextReasons(styles: Record<string, string>): string[] {
  const reasons: string[] = []
  const position = styles['position'] ?? 'static'
  const zIndex = styles['z-index'] ?? 'auto'
  if (position === 'fixed' || position === 'sticky') reasons.push(`position:${position}`)
  else if (position !== 'static' && zIndex !== 'auto') reasons.push(`position:${position} + z-index:${zIndex}`)
  const opacity = styles['opacity']
  if (opacity != null && parseOpacity(opacity) < 1) reasons.push(`opacity:${opacity}`)
  if ((styles['transform'] ?? 'none') !== 'none') reasons.push('transform')
  if ((styles['filter'] ?? 'none') !== 'none') reasons.push('filter')
  if ((styles['mix-blend-mode'] ?? 'normal') !== 'normal') reasons.push(`mix-blend-mode:${styles['mix-blend-mode']}`)
  if (styles['isolation'] === 'isolate') reasons.push('isolation:isolate')
  const willChange = styles['will-change'] ?? 'auto'
  if (/transform|opacity|filter|perspective/.test(willChange)) reasons.push(`will-change:${willChange}`)
  const contain = styles['contain'] ?? 'none'
  if (/paint|layout|strict|content/.test(contain)) reasons.push(`contain:${contain}`)
  return reasons
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
  // "In the viewport" is a different question from "visible" (a visible node can be
  // scrolled out), so it gets its own name rather than being folded into the one above.
  registerVirtualType('InViewportElement', (path: PagePath) => {
    const node = path.node as PageModelNode | null
    return !!node && !!node.runtime && node.runtime.inViewport === true
  })
  registerVirtualType('Interactive', (path: PagePath) => {
    const node = path.node as PageModelNode | null
    if (!node) return false
    if (node.role && INTERACTIVE_ROLES.has(node.role)) return true
    return !!node.tag && INTERACTIVE_TAGS.has(node.tag)
  })
  // Partially OR fully covered. The two states stay distinguishable, so a caller that
  // only cares about completely-hidden nodes uses FullyOccludedElement instead.
  registerVirtualType('OccludedElement', (path: PagePath) => {
    const node = path.node as PageModelNode | null
    return !!node && !!node.runtime && node.runtime.occluded != null
  })
  registerVirtualType('FullyOccludedElement', (path: PagePath) => {
    const node = path.node as PageModelNode | null
    return !!node && !!node.runtime && node.runtime.occluded === 'full'
  })
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
    if (node.runtime.changes) row.changes = node.runtime.changes
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
// Diff thresholds
// ---------------------------------------------------------------------------

/**
 * A box edge must move more than this many CSS pixels to count as `'moved'`.
 *
 * Half a CSS pixel. Layout is quantised to LayoutUnit (1/64 px) and fractional CSS
 * lengths (percentages, `em`, flex distribution) land between those steps, so
 * re-measuring an *unmoved* element can differ in the low fractions. Anything above half
 * a pixel is a real relayout; anything at or below it is noise, and reporting noise as
 * movement would make the diff useless for spotting actual shifts.
 *
 * This threshold has NOTHING to do with the device pixel ratio, which an earlier version
 * of this comment claimed ("the absolute bounds are then converted through the device
 * pixel ratio ... at DPR 2"). Measured: `layout.bounds` is in CSS pixels and is
 * bit-identical at DPR 1, 2 and 3 for the same page. See the `Box` doc comment.
 */
export const MOVED_THRESHOLD_PX = 0.5

// ---------------------------------------------------------------------------
// PageModel
// ---------------------------------------------------------------------------

export class PageModel {
  root: PageModelNode
  byKey: Map<NodeKey, PageModelNode>
  parentByKey: Map<NodeKey, NodeKey>
  frameId: string
  /** Per-frame layout snapshot this model was fused with, when one was fetched. */
  geometry?: Map<string, FrameGeometry>
  /** Nodes present in the previous model and gone from this one. Filled by `diffAgainst`. */
  removed: RemovedNodeRecord[] = []
  /** Keys of `removed`, same order — the cheap membership check. */
  removedKeys: NodeKey[] = []
  private deps: ModelDeps

  constructor(opts: {
    root: PageModelNode
    byKey: Map<NodeKey, PageModelNode>
    parentByKey: Map<NodeKey, NodeKey>
    frameId: string
    geometry?: Map<string, FrameGeometry>
    deps?: ModelDeps
  }) {
    this.root = opts.root
    this.byKey = opts.byKey
    this.parentByKey = opts.parentByKey
    this.frameId = opts.frameId
    this.geometry = opts.geometry
    this.deps = opts.deps ?? {}
  }

  /** Resolve a selector / backendNodeId / point to a lightweight, cycle-free handle. */
  anchor(
    selector: string | { backendNodeId: number } | { x: number; y: number; frameId?: string },
  ): PageModelHandle | null {
    const node = this.resolveNode(selector)
    if (!node) return null
    return this.makeHandle(node)
  }

  /**
   * Ground-truth point resolution: one `DOM.getNodeForLocation` hit test, then walk up
   * to the nearest ancestor the model knows. Prefer this over `anchor({x, y})` when the
   * answer has to be right — `anchor` infers the topmost node from snapshot geometry and
   * cannot see `clip-path`, rounded corners or rotated boxes.
   *
   * `point` is in document coordinates (same space as `runtime.box`); CDP wants viewport
   * coordinates, so the frame's viewport origin is subtracted here.
   */
  async anchorAt(point: { x: number; y: number }): Promise<PageModelHandle | null> {
    const cdp = this.deps.cdp
    if (!cdp) {
      throw new Error('anchorAt needs a CDP session — build the model with buildPageModel({ page, cdp })')
    }
    const frame = this.geometry?.get(this.frameId)
    const viewport = frame?.viewport
    if (!viewport) {
      throw new Error(
        'anchorAt cannot convert document coordinates to viewport coordinates: the layout viewport is unknown for ' +
          `frame ${this.frameId}`,
      )
    }
    await cdp.send('DOM.enable')
    // These two calls are NOT a precondition of `DOM.getNodeForLocation`, and the comment
    // here used to say they were. MEASURED against Chromium 145.0.7632.18:
    // `getNodeForLocation` answers on a fresh session with no `DOM.getDocument` and indeed
    // with no `DOM.enable` at all — it returns a backendNodeId, and only the FRONTEND
    // node-id commands need the document primed (`DOM.pushNodesByBackendIdsToFrontend` on
    // the same session is rejected with "Document needs to be requested first"). The old
    // comment named `pushNodesByBackendIdsToFrontend` as the justification even though
    // this module never calls it.
    //
    // They are kept, cheaply and deliberately: the measurement above is on direct CDP to
    // headless Chromium, and this same code runs against the extension relay, where the
    // debugger-API transport has not been measured the same way. Priming costs one
    // round-trip on a path that is already doing a hit test; assuming the relay behaves
    // like direct CDP is the kind of unmeasured guess this comment exists to retract.
    await cdp.send('DOM.getDocument', { depth: 0 })
    let hit: Protocol.DOM.GetNodeForLocationResponse
    try {
      hit = (await cdp.send('DOM.getNodeForLocation', {
        x: Math.round(point.x - viewport.x),
        y: Math.round(point.y - viewport.y),
      })) as Protocol.DOM.GetNodeForLocationResponse
    } catch (error) {
      // "no node at this point" is an answer, not a failure. Anything else is a bug and
      // must keep propagating.
      const message = error instanceof Error ? error.message : String(error)
      if (/no node found|node not found/i.test(message)) return null
      throw error
    }

    const direct = this.byKey.get(`${this.frameId}:${hit.backendNodeId}` as NodeKey)
    if (direct) return this.makeHandle(direct)

    // The hit node is often not in the model (the a11y tree skips most wrappers, and
    // text nodes carry no backendNodeId of their own here). Climb the snapshot's node
    // tree to the closest ancestor that is.
    if (!frame) return null
    const hitRecord = frame.byBackendId.get(hit.backendNodeId)
    if (!hitRecord) return null
    let index = frame.parentIndex[hitRecord.nodeIndex] ?? -1
    let guard = 0
    while (index >= 0) {
      const ancestor = frame.byNodeIndex.get(index)
      if (ancestor) {
        const node = this.byKey.get(`${this.frameId}:${ancestor.backendNodeId}` as NodeKey)
        if (node) return this.makeHandle(node)
      }
      index = frame.parentIndex[index] ?? -1
      if (++guard > 100000) break
    }
    return null
  }

  private resolveNode(
    selector: string | { backendNodeId: number } | { x: number; y: number; frameId?: string },
  ): PageModelNode | null {
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
    return this.hitTestPoint(selector)
  }

  /**
   * INFERENCE. Topmost visible node whose box contains the point.
   *
   * "Topmost" is paint order, not tree order — a late-painted overlay wins over a node
   * that merely appears later in the DOM. Nodes painted together (equal paint order)
   * are tie-broken by the smaller box, i.e. the more specific one. Non-visible nodes are
   * ignored. `pointer-events: none` nodes are NOT ignored: paint order describes what is
   * drawn on top, not what would receive a click — use `anchorAt` for the hit test.
   *
   * The point is in document coordinates of `frameId` (default: the model's own frame).
   * Frames are never mixed, because each frame's boxes are in its own coordinate space.
   */
  private hitTestPoint(point: { x: number; y: number; frameId?: string }): PageModelNode | null {
    const frameId = point.frameId ?? this.frameId
    let best: PageModelNode | null = null
    for (const node of this.byKey.values()) {
      if (node.frameId !== frameId) continue
      const box = node.runtime.box
      // `visible !== true` also excludes unmeasurable nodes, which have no box anyway.
      if (!box || node.runtime.visible !== true) continue
      if (point.x < box.x || point.x > box.x + box.width) continue
      if (point.y < box.y || point.y > box.y + box.height) continue
      if (!best) {
        best = node
        continue
      }
      const bestOrder = best.runtime.paintOrder ?? -1
      const order = node.runtime.paintOrder ?? -1
      if (order > bestOrder) {
        best = node
      } else if (order === bestOrder) {
        const bestBox = best.runtime.box!
        if (box.width * box.height < bestBox.width * bestBox.height) best = node
      }
    }
    return best
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
    const scopeRoots = this.resolveScopeRoots(opts)
    const rows: ProjectionRow[] = []
    // Scopes can nest, so the same node can be reached from two roots. Rows are keyed
    // by node identity to keep the projection a set, not a bag.
    const seen = new Set<PageModelNode>()

    const passesFilters = (node: PageModelNode): boolean => {
      if (opts.visibleOnly && !node.runtime.visible) return false
      if (opts.inViewportOnly && node.runtime.inViewport !== true) return false
      if (opts.roles && !(node.role && opts.roles.includes(node.role))) return false
      return true
    }

    const emit = (node: PageModelNode): void => {
      if (seen.has(node)) return
      seen.add(node)
      if (!passesFilters(node)) return
      rows.push(projectNode(node, fields, !!opts.changedSince))
    }

    for (const scopeRoot of scopeRoots) {
      if (opts.select) {
        // Virtual-type / typed selection routed through page-path's query engine.
        for (const path of query(asPageNode(scopeRoot), opts.select)) {
          emit(path.node as PageModelNode)
        }
        continue
      }

      const maxDepth = opts.depth
      traverse(asPageNode(scopeRoot), {
        'document|element|text': (path: PagePath) => {
          const node = path.node as PageModelNode
          if (maxDepth != null && pathDepth(path) > maxDepth) {
            path.skip()
            return
          }
          emit(node)
        },
      })
    }
    return rows
  }

  /**
   * Resolve `within` (or its deprecated alias `scope`) to the subtree roots to project.
   *
   * An unmatched scope THROWS. It used to fall back to the whole document, which made a
   * typo in the scope indistinguishable from "the scope matched but nothing in it passed
   * the filters" — and the wrong one of those two is a silent whole-document dump. A
   * scope is a precondition on the query, so failing it is an error, not an empty set.
   */
  private resolveScopeRoots(opts: QueryOptions): PageModelNode[] {
    const within = opts.within ?? opts.scope
    if (opts.within != null && opts.scope != null && opts.within !== opts.scope) {
      throw new Error(
        `query: both \`within\` ("${opts.within}") and the deprecated \`scope\` ("${opts.scope}") were given and they ` +
          'disagree. Pass only `within`.',
      )
    }
    if (!within) return [this.root]
    const paths = query(asPageNode(this.root), within)
    if (paths.length === 0) {
      throw new Error(
        `query: \`within\` selector "${within}" matched no node, so there is no scope to query. ` +
          'This is a page-path selector (a registered type name, `Type#id`, or `Type[attr=value]` with an unquoted ' +
          'value), not a CSS selector.',
      )
    }
    return paths.map((path) => path.node as PageModelNode)
  }

  /** Indented text projection (like the aria snapshot) for compact display. */
  renderText(opts: { visibleOnly?: boolean; inViewportOnly?: boolean; includeRemoved?: boolean } = {}): string {
    const lines: string[] = []
    const walk = (node: PageModelNode, indent: number): void => {
      const isRoot = node === this.root
      let printed = false
      if (!isRoot) {
        const filteredOut =
          (opts.visibleOnly && !node.runtime.visible) || (opts.inViewportOnly && node.runtime.inViewport !== true)
        if (!filteredOut) {
          const prefix = '  '.repeat(indent)
          const label = node.role || node.tag || node.type
          const name = node.name ? ` "${node.name.replace(/"/g, '\\"')}"` : ''
          const changed = node.runtime.changedSince ? ` *${node.runtime.changedSince}` : ''
          lines.push(`${prefix}- ${label}${name}${changed}`)
          printed = true
        }
        // A filtered-out node still descends so visible descendants stay reachable, but
        // it must not consume an indent level it never printed.
      }
      const nextIndent = isRoot || !printed ? indent : indent + 1
      for (const child of node.children) {
        walk(child, nextIndent)
      }
    }
    walk(this.root, 0)
    // Removals have no node to hang a marker on, so they are listed after the tree.
    // Printed by default: a disappearing element is exactly what the diff is for.
    if (opts.includeRemoved !== false) {
      for (const record of this.removed) {
        const label = record.role || record.tag || 'node'
        const name = record.name ? ` "${record.name.replace(/"/g, '\\"')}"` : ''
        lines.push(`- ${label}${name} *removed`)
      }
    }
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

  /**
   * Diff this model against a previous one, tagging every node with how it changed and
   * collecting the nodes that disappeared.
   *
   * A node can change in more than one way at once, so `runtime.changes` carries all of
   * them with their details and `runtime.changedSince` keeps the dominant one for
   * one-line rendering. Removals land in `this.removed` / `this.removedKeys` because a
   * removed node has no node object left to tag.
   */
  diffAgainst(prev: PageModel): void {
    this.removed = []
    this.removedKeys = []

    for (const [key, node] of this.byKey) {
      const before = prev.byKey.get(key)
      if (!before) {
        node.runtime.changes = [{ kind: 'new' }]
        node.runtime.changedSince = 'new'
        continue
      }
      const changes = diffNode(before, node)
      if (changes.length === 0) {
        node.runtime.changes = undefined
        node.runtime.changedSince = undefined
        continue
      }
      node.runtime.changes = changes
      node.runtime.changedSince = dominantChange(changes)
    }

    for (const [key, node] of prev.byKey) {
      if (this.byKey.has(key)) continue
      this.removed.push({
        key,
        role: node.role,
        name: node.name,
        tag: node.tag,
        locator: node.locator,
        box: node.runtime.box,
      })
      this.removedKeys.push(key)
    }
  }
}

/** Precedence when collapsing several changes into one `changedSince` string. */
const CHANGE_PRECEDENCE: NodeChangeKind[] = ['new', 'removed', 'hidden', 'shown', 'moved', 'style']

function dominantChange(changes: NodeChange[]): NodeChangeKind {
  for (const kind of CHANGE_PRECEDENCE) {
    if (changes.some((change) => change.kind === kind)) return kind
  }
  return changes[0].kind
}

function boxesDiffer(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) > MOVED_THRESHOLD_PX ||
    Math.abs(a.y - b.y) > MOVED_THRESHOLD_PX ||
    Math.abs(a.width - b.width) > MOVED_THRESHOLD_PX ||
    Math.abs(a.height - b.height) > MOVED_THRESHOLD_PX
  )
}

/** Every way `after` differs from `before`. Pure; exported shape is `NodeChange`. */
function diffNode(before: PageModelNode, after: PageModelNode): NodeChange[] {
  const changes: NodeChange[] = []

  // Rendered-ness first: when a node stops being rendered its computed styles stop
  // being reported entirely, so emitting a per-property style diff would drown the one
  // fact that matters ("it is gone from the layout").
  const wasRendered = before.runtime.rendered
  const isRendered = after.runtime.rendered
  if (wasRendered === true && isRendered === false) {
    changes.push({ kind: 'hidden', reason: 'no longer rendered (display:none or removed from layout)' })
  } else if (wasRendered === false && isRendered === true) {
    changes.push({ kind: 'shown', reason: 'now rendered' })
  } else if (before.runtime.visible === true && after.runtime.visible === false) {
    changes.push({ kind: 'hidden', reason: 'still laid out but no longer visible', properties: styleChanges(before, after) })
  } else if (before.runtime.visible === false && after.runtime.visible === true) {
    changes.push({ kind: 'shown', reason: 'now visible', properties: styleChanges(before, after) })
  }
  // A node that is unmeasurable on either side reports no visibility change: absence is
  // "not measured", and diffing it against a measurement would invent a transition.

  const beforeBox = before.runtime.box
  const afterBox = after.runtime.box
  if (beforeBox && afterBox && boxesDiffer(beforeBox, afterBox)) {
    changes.push({
      kind: 'moved',
      from: { ...beforeBox },
      to: { ...afterBox },
      delta: {
        dx: afterBox.x - beforeBox.x,
        dy: afterBox.y - beforeBox.y,
        dw: afterBox.width - beforeBox.width,
        dh: afterBox.height - beforeBox.height,
      },
    })
  }

  // Only report a bare 'style' change when it is not already explained by hidden/shown.
  if (!changes.some((change) => change.kind === 'hidden' || change.kind === 'shown')) {
    const properties = styleChanges(before, after)
    if (properties.length > 0) {
      changes.push({ kind: 'style', properties })
    }
  }

  return changes
}

/** Which tracked computed properties changed, with both values. */
function styleChanges(before: PageModelNode, after: PageModelNode): StylePropertyChange[] {
  const beforeStyles = before.runtime.computedStyles
  const afterStyles = after.runtime.computedStyles
  const properties: StylePropertyChange[] = []
  for (const property of new Set([...Object.keys(beforeStyles), ...Object.keys(afterStyles)])) {
    const from = beforeStyles[property]
    const to = afterStyles[property]
    if (from === to) continue
    properties.push({ property, ...(from != null ? { from } : {}), ...(to != null ? { to } : {}) })
  }
  properties.sort((a, b) => (a.property < b.property ? -1 : a.property > b.property ? 1 : 0))
  return properties
}

// ---------------------------------------------------------------------------
// Fuse (pure) — unit-testable without a browser
// ---------------------------------------------------------------------------

function nodeTypeForRole(role: string | undefined): PageModelNode['type'] {
  if (role && TEXT_ROLES.has(role)) return 'text'
  return 'element'
}

/**
 * The three states a node's geometry can be in. There is no fourth "assume it is fine"
 * state: `unmeasurable` is reported as such and never collapses into `not-rendered`,
 * because "the layout tree says this has no box" and "nothing measured this node" are
 * different facts and only the first one licenses `visible: false`.
 */
type GeometryLookup =
  | { kind: 'laid-out'; frame: FrameGeometry; record: SnapshotNodeGeometry }
  | { kind: 'not-rendered'; frame: FrameGeometry }
  | { kind: 'unmeasurable' }

/**
 * Find the geometry record for a node.
 *
 * A node is looked up in its own frame first. If that frame was measured but does not
 * contain the id, the same-process fallback applies: one `captureSnapshot` covers every
 * document in the process, so a node the a11y tree reported under the main frame may
 * actually live in a same-process iframe document. backendNodeIds are unique per
 * process, so that lookup is unambiguous. It is deliberately NOT attempted when the
 * node's own frame was not measured at all — for a cross-process frame the same
 * backendNodeId belongs to a different node entirely, and guessing there would fuse the
 * wrong box onto the node.
 *
 * An id that appears in NO captured document is `unmeasurable` rather than not-rendered:
 * user-agent shadow content is absent from `captureSnapshot` altogether, and a node the
 * page created between the a11y pass and the layout pass is simply too new to be in it.
 *
 * The user-agent half is MEASURED against Chromium 145, not assumed: on a page whose only
 * interesting element is `<input type=range>` — an element whose slider track and thumb
 * live in a user-agent shadow root that `DOM.getDocument({ pierce: true })` DOES expose —
 * the whole set of `nodeName`s in the captured snapshot is `#document, HTML, HEAD, STYLE,
 * #text, BODY, DIV, ::before, INPUT, IFRAME`. The shadow internals appear nowhere, so an
 * a11y node for one of them can only ever land here, and calling it `not-rendered` would
 * assert a measurement that was never taken.
 */
function lookupGeometry(
  geometry: Map<string, FrameGeometry>,
  frameId: string,
  backendNodeId: number,
): GeometryLookup {
  const own = geometry.get(frameId)
  if (!own) return { kind: 'unmeasurable' }
  const record = own.byBackendId.get(backendNodeId)
  if (record) return { kind: 'laid-out', frame: own, record }
  if (own.documentBackendIds.has(backendNodeId)) return { kind: 'not-rendered', frame: own }
  for (const frame of geometry.values()) {
    if (frame === own) continue
    if (!frame.documentBackendIds.has(backendNodeId)) continue
    const other = frame.byBackendId.get(backendNodeId)
    return other ? { kind: 'laid-out', frame, record: other } : { kind: 'not-rendered', frame }
  }
  return { kind: 'unmeasurable' }
}

/**
 * Pure fuse/project: build a PageModel from already-fetched raw inputs. No CDP,
 * no page — safe to unit-test. `buildPageModel` wraps this after fetching.
 *
 * `geometry` is REQUIRED and must cover `frameId`. Visibility is a measured fact, so a
 * model that was never measured has no honest value to report for it — rather than
 * defaulting a whole tree to "visible" (which is the bug this module exists to fix), the
 * unmeasured model is simply not constructible.
 */
export function buildPageModelFromRaw({
  ariaTree,
  domByBackendId,
  frameId,
  geometry,
  deps,
}: {
  ariaTree: AriaSnapshotNode[]
  domByBackendId: Map<number, ModelDomInfo>
  frameId: string
  /** Decoded layout snapshot keyed by frameId — see `decodeCaptureSnapshot`. */
  geometry: Map<string, FrameGeometry>
  deps?: ModelDeps
}): PageModel {
  ensureTypesRegistered()

  if (!geometry.has(frameId)) {
    throw new Error(
      `buildPageModelFromRaw: no layout snapshot for frame ${frameId} (geometry covers: ` +
        `${[...geometry.keys()].join(', ') || 'nothing'}). Every node's visibility would be unknown, so the model ` +
        'would report nothing truthful about what is on screen.',
    )
  }

  const byKey = new Map<NodeKey, PageModelNode>()
  const parentByKey = new Map<NodeKey, NodeKey>()
  let ariaOnlyCounter = 0

  // Per-frame caches shared across the whole fuse: the opacity-chain memo and the
  // set of nodes we must compute occlusion for.
  const visibilityCaches = new Map<string, Map<number, boolean>>()
  const occlusionTargets = new Map<string, SnapshotNodeGeometry[]>()
  const geometryFrameByKey = new Map<NodeKey, string>()
  const visibilityCacheFor = (frame: FrameGeometry): Map<number, boolean> => {
    let cache = visibilityCaches.get(frame.frameId)
    if (!cache) {
      cache = new Map<number, boolean>()
      visibilityCaches.set(frame.frameId, cache)
    }
    return cache
  }

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

    // An a11y-only node has no backendNodeId to join geometry to — that is a genuine
    // unmeasurable, not a lookup miss.
    const located: GeometryLookup = hasBackend
      ? lookupGeometry(geometry, frameId, backendNodeId as number)
      : { kind: 'unmeasurable' }
    const runtime = buildRuntime(located)
    if (located.kind === 'laid-out') {
      geometryFrameByKey.set(key, located.frame.frameId)
      const list = occlusionTargets.get(located.frame.frameId)
      if (list) list.push(located.record)
      else occlusionTargets.set(located.frame.frameId, [located.record])
    }

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
      runtime,
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

  function buildRuntime(located: GeometryLookup): PageModelNode['runtime'] {
    if (located.kind === 'unmeasurable') {
      // Nothing measured this node, so it gets no visibility at all — not `false`, which
      // would assert it was measured and found hidden, and certainly not `true`.
      return { computedStyles: {} }
    }
    if (located.kind === 'not-rendered') {
      // In the document but absent from the layout tree — that is what `display: none`
      // and un-laid-out content look like. NOT rendered, therefore not visible.
      return { visible: false, rendered: false, inViewport: false, computedStyles: {} }
    }
    const { frame, record } = located
    const cache = visibilityCacheFor(frame)
    const visible = isGeometricallyVisible(record, frame, cache)
    const clip = visibleClipRect(record, frame)
    const reasons = record.stackingContext ? stackingContextReasons(record.styles) : undefined
    return {
      visible,
      rendered: true,
      ...(clip === undefined ? {} : { inViewport: clip !== null && intersect(record.box, clip) !== null }),
      box: { ...record.box },
      ...(record.paintOrder != null ? { paintOrder: record.paintOrder } : {}),
      stackingContext: record.stackingContext,
      ...(reasons && reasons.length ? { stackingReasons: reasons } : {}),
      computedStyles: { ...record.styles },
    }
  }

  const root: PageModelNode = {
    type: 'document',
    key: `${frameId}:0` as NodeKey,
    backendNodeId: 0,
    frameId,
    tag: '#document',
    attributes: {},
    // The synthetic document root is a projection container, not a DOM node with a box
    // (backendNodeId 0 is not a real id), so there is nothing to measure and it reports
    // no visibility rather than claiming to be visible.
    runtime: { computedStyles: {} },
    edges: {},
    children: [],
  }
  root.children = ariaTree.map((child) => mapNode(child, root.key))

  // Occlusion needs every candidate occluder in the frame (overlays are usually not in
  // the a11y tree), so it runs once per frame over the decoded snapshot and is joined
  // back onto the model nodes by backendNodeId.
  if (geometry) {
    for (const [geometryFrameId, targets] of occlusionTargets) {
      const frame = geometry.get(geometryFrameId)
      if (!frame) continue
      const occlusion = computeFrameOcclusion({
        frame,
        targets,
        visibilityCache: visibilityCacheFor(frame),
      })
      for (const [key, node] of byKey) {
        if (geometryFrameByKey.get(key) !== geometryFrameId) continue
        const result = occlusion.get(node.backendNodeId)
        if (!result) continue
        node.runtime.occluded = result.state
        node.runtime.occludedFraction = result.coveredFraction
        node.runtime.occludedBy = result.by
        node.runtime.occludedByLabels = result.labels
      }
    }
  }

  return new PageModel({ root, byKey, parentByKey, frameId, geometry, deps })
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
 * Fetch and decode the layout snapshot for a page: geometry, paint order and the
 * tracked computed styles for every laid-out node in every same-process frame, in one
 * round-trip, plus one `Page.getLayoutMetrics` for the viewport.
 *
 * `includeDOMRects` is deliberately NOT requested: `layout.bounds` (the absolute border
 * box) is the only rectangle consumed here, and offset/scroll/client rects are in
 * element-relative coordinate spaces that would have to be re-based before they could
 * be mixed with it. Asking for three unused tables per node is not free.
 */
export async function fetchPageGeometry({ cdp }: { cdp: ICDPSession }): Promise<Map<string, FrameGeometry>> {
  await cdp.send('DOM.enable')
  await cdp.send('DOMSnapshot.enable')
  const snapshot = (await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: [...PAGE_MODEL_COMPUTED_STYLES],
    includePaintOrder: true,
  })) as Protocol.DOMSnapshot.CaptureSnapshotResponse

  const metrics = (await cdp.send('Page.getLayoutMetrics')) as Protocol.Page.GetLayoutMetricsResponse
  const layoutViewport = metrics.cssLayoutViewport
  // The main frame is documents[0]; only it has published viewport metrics, so nodes in
  // child frames keep `inViewport: undefined` rather than being measured against the
  // wrong rectangle. The key must be derived exactly as the decoder derives it, including
  // its synthetic-id fallback, or the viewport would attach to nothing.
  //
  // MEASURED against Chromium 145 on a page holding one 200x150 iframe: `documents[0]` is
  // the main document (its node table holds the `IFRAME` element, the child document's
  // does not), and `Page.getLayoutMetrics` returns exactly ONE `cssLayoutViewport` —
  // 1280x720, the top-level viewport, with no per-frame variant anywhere in the response.
  // So there is no second rectangle to attach to the child even if one wanted to.
  const mainFrameId = snapshot.documents.length
    ? snapshot.strings[snapshot.documents[0].frameId] || '#unframed-document-0'
    : undefined
  const viewports: Record<string, Box> = {}
  if (mainFrameId && layoutViewport) {
    viewports[mainFrameId] = {
      x: layoutViewport.pageX,
      y: layoutViewport.pageY,
      width: layoutViewport.clientWidth,
      height: layoutViewport.clientHeight,
    }
  }

  return decodeCaptureSnapshot({ snapshot, viewports })
}

/**
 * Build a PageModel for a page: fetch the aria snapshot, the flattened DOM and the
 * layout snapshot over CDP, then delegate to the pure `buildPageModelFromRaw`.
 *
 * `rootSelector` is a **Playwright selector** and scopes what is FETCHED (it is applied
 * before any tree exists, by `page.locator`). It is a different language from
 * `query({ within })`, which is a page-path selector over the already-built tree — the
 * two used to share the name `scope`, which made one of them look like the other.
 */
export async function buildPageModel({
  page,
  cdp,
  rootSelector,
  scope,
}: {
  page: Page
  cdp: ICDPSession
  rootSelector?: string
  /** @deprecated Alias for `rootSelector` (same Playwright-selector language). */
  scope?: string
}): Promise<PageModel> {
  if (rootSelector != null && scope != null && rootSelector !== scope) {
    throw new Error(
      `buildPageModel: both \`rootSelector\` ("${rootSelector}") and the deprecated \`scope\` ("${scope}") were given ` +
        'and they disagree. Pass only `rootSelector`.',
    )
  }
  const selector = rootSelector ?? scope
  const locator = selector ? page.locator(selector) : undefined
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

  const geometry = await fetchPageGeometry({ cdp })
  const frameId = page.mainFrame().frameId()
  // The layout snapshot always contains the main document, so if it does not cover
  // `frameId` the frame tree and the snapshot disagree about this page — which
  // `buildPageModelFromRaw` rejects rather than building an unmeasured model.

  return buildPageModelFromRaw({
    ariaTree: aria.tree,
    domByBackendId,
    frameId,
    geometry,
    deps: { page, cdp },
  })
}
