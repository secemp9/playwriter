# PageModel API Reference

The PageModel fuses the ARIA snapshot, the flattened DOM, and lazy React/CSS
edges into one queryable tree. In the sandbox it is reached through the `pm`
helper (`pm.query` / `pm.anchor` / `pm.renderText` / `pm.debugMode`) and the
CSS-provenance helpers `debugStyle` / `whyOccluded`. Queries return plain,
cycle-free projection rows — never the live model.

## Types

```ts
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
import type { Page } from '@xmorse/playwright-core';
import type { Protocol } from 'devtools-protocol';
import type { ICDPSession } from './cdp-session.js';
import type { AriaSnapshotNode } from './aria-snapshot.js';
import { type NormalizedRule, type DeclRef } from './css-cascade.js';
export type NodeKey = `${string}:${number}`;
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
    x: number;
    y: number;
    width: number;
    height: number;
}
/** How a node changed between two models. A node can change in several ways at once. */
export type NodeChangeKind = 'new' | 'moved' | 'style' | 'removed' | 'hidden' | 'shown';
export interface StylePropertyChange {
    property: string;
    /** Value in the previous model. Absent when the property was not reported before. */
    from?: string;
    /** Value in this model. Absent when the property is no longer reported. */
    to?: string;
}
export interface NodeChange {
    kind: NodeChangeKind;
    /** 'moved' only — the previous and current boxes plus the per-edge delta. */
    from?: Box;
    to?: Box;
    delta?: {
        dx: number;
        dy: number;
        dw: number;
        dh: number;
    };
    /** 'style' | 'hidden' | 'shown' — exactly which tracked properties changed. */
    properties?: StylePropertyChange[];
    /** 'hidden' | 'shown' — why the node started/stopped rendering, in one phrase. */
    reason?: string;
}
/**
 * A node that existed in the previous model and is gone from this one. Removed nodes
 * have no node object to tag, so they are carried as records on the model itself —
 * dropping them would defeat the point of the diff (catching disappearing UI).
 */
export interface RemovedNodeRecord {
    key: NodeKey;
    role?: string;
    name?: string;
    tag: string;
    locator?: string;
    /** The box the node last occupied, when the previous model had measured it. */
    box?: Box;
}
export interface PageModelNode {
    type: 'document' | 'element' | 'text';
    key: NodeKey;
    backendNodeId: number;
    frameId: string;
    tag: string;
    role?: string;
    name?: string;
    attributes: Record<string, string>;
    locator?: string;
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
        visible?: boolean;
        /**
         * GROUND TRUTH. True when the node has a layout object. False means it is not
         * rendered at all — `display: none`, inside a `content-visibility: hidden` subtree,
         * or otherwise un-laid-out. Absent under exactly the same conditions as `visible`,
         * with which it is always present or absent together. A real distinction from
         * `visible`, kept separate on purpose.
         */
        rendered?: boolean;
        /**
         * INFERENCE. True when the node's box intersects the layout viewport after
         * intersecting the visible rect of its clipping (scroll-container) ancestors.
         * `undefined` when the frame's viewport is unknown. Independent of `visible`.
         */
        inViewport?: boolean;
        /** GROUND TRUTH. The absolute border box from the layout snapshot, in CSS px. */
        box?: Box;
        /**
         * GROUND TRUTH. Chromium's global paint order index. Nodes painted together share
         * an index; higher paints later, i.e. on top.
         */
        paintOrder?: number;
        /** GROUND TRUTH. Whether the node establishes its own stacking context. */
        stackingContext?: boolean;
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
        stackingReasons?: string[];
        /**
         * The computed values of `PAGE_MODEL_COMPUTED_STYLES` only. Empty when the node has
         * no layout object — that means "nothing was reported", not "no styles apply".
         */
        computedStyles: Record<string, string>;
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
        occluded?: 'partial' | 'full';
        /** Estimated fraction of this node's box covered by `occludedBy` (0..1). */
        occludedFraction?: number;
        /**
         * Keys of the covering nodes, topmost (highest paint order) first. A key is always
         * a real `${frameId}:${backendNodeId}`, but overlays frequently are not in the a11y
         * tree, so `byKey.get(...)` may not resolve one — see `occludedByLabels`.
         */
        occludedBy?: NodeKey[];
        /** `tag#id.class` for each entry of `occludedBy`, same order. */
        occludedByLabels?: string[];
        /** The dominant change vs the previous model. See `changes` for the full set. */
        changedSince?: NodeChangeKind;
        /** Every way this node changed vs the previous model, with the details. */
        changes?: NodeChange[];
    };
    edges: {
        reactFiber?: {
            componentName: string | null;
            source: unknown;
            props: unknown;
        };
        matchedRules?: NormalizedRule[];
        winnerFor?: Record<string, DeclRef>;
    };
    children: PageModelNode[];
}
/** A plain, cycle-free projection row emitted by `query`. */
export type ProjectionRow = Record<string, unknown>;
/** Projection config seam returned by `debugMode()` — flips lossy levers off. */
export interface ProjectionConfig {
    visibleOnly: boolean;
    includeAllNodes: boolean;
    styleWhitelist: string[] | null;
    dedup: boolean;
}
export interface PageModelHandle {
    key: NodeKey;
    role?: string;
    name?: string;
    tag: string;
    locator?: string;
    runtime: PageModelNode['runtime'];
    reactFiber(): Promise<{
        componentName: string | null;
        source: unknown;
        props: unknown;
    } | null>;
    styles(): Promise<unknown>;
    render(): string;
}
export interface QueryOptions {
    /**
     * A **page-path** selector (`'element#main'`, `'Interactive'`, `'*'`) naming the
     * subtree(s) to project. Not CSS, and not the same language as
     * `buildPageModel({ rootSelector })` — see the note on `rootSelector`.
     * An unmatched `within` throws: a scope is a precondition, not a filter.
     */
    within?: string;
    /** @deprecated Alias for `within` (same page-path language). Use `within`. */
    scope?: string;
    roles?: string[];
    depth?: number;
    fields?: string[];
    /**
     * Keep only nodes with `runtime.visible === true` — laid out and not hidden. A node
     * that could not be measured has no `visible` at all and is excluded, never assumed.
     */
    visibleOnly?: boolean;
    /** Keep only nodes with `runtime.inViewport === true` — a different question. */
    inViewportOnly?: boolean;
    changedSince?: boolean;
    /** Optional page-path selector (e.g. `'VisibleElement'`, `'Interactive'`) — uses page-path `query`. */
    select?: string;
}
/** Minimal DOM info needed to fuse tag/attributes onto aria nodes. */
export interface ModelDomInfo {
    nodeName: string;
    attributes: Record<string, string>;
}
interface ModelDeps {
    page?: Page;
    cdp?: ICDPSession;
}
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
export declare const PAGE_MODEL_COMPUTED_STYLES: readonly string[];
/** One laid-out node, decoded out of a `DocumentSnapshot`'s layout table. */
export interface SnapshotNodeGeometry {
    backendNodeId: number;
    /** Index into the owning document's `NodeTreeSnapshot` tables. */
    nodeIndex: number;
    /** DOM nodeType (1 = element, 3 = text). */
    nodeType: number;
    nodeName: string;
    /** `tag#id.class`, for reports about nodes that are not in the model. */
    label: string;
    box: Box;
    paintOrder?: number;
    styles: Record<string, string>;
    stackingContext: boolean;
}
/** Everything decoded for one document (= one frame) of a `captureSnapshot`. */
export interface FrameGeometry {
    frameId: string;
    /** Laid-out nodes, keyed by backendNodeId. Absent = not rendered. */
    byBackendId: Map<number, SnapshotNodeGeometry>;
    /** Laid-out nodes, keyed by their index in the document's node tree. */
    byNodeIndex: Map<number, SnapshotNodeGeometry>;
    /** Every backendNodeId in this document's node tree, laid out or not. */
    documentBackendIds: Set<number>;
    /** `NodeTreeSnapshot.parentIndex` — the ancestry table (-1 at the root). */
    parentIndex: number[];
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
    scrollOffsetX: number;
    scrollOffsetY: number;
    /**
     * The layout viewport in this document's coordinates, when known. The *layout*
     * viewport is used rather than the visual viewport because pinch-zoom is a transient
     * user gesture: `inViewport` should describe the page, not the user's current zoom.
     */
    viewport?: Box;
}
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
export declare function decodeCaptureSnapshot({ snapshot, computedStyles, viewports, into, }: {
    snapshot: Protocol.DOMSnapshot.CaptureSnapshotResponse;
    /** The property names passed as `computedStyles` to captureSnapshot, in order. */
    computedStyles?: readonly string[];
    /** frameId -> layout viewport in that frame's document coordinates. */
    viewports?: Record<string, Box>;
    /** Merge into an existing map (for OOPIF documents captured separately). */
    into?: Map<string, FrameGeometry>;
}): Map<string, FrameGeometry>;
/** Topmost-first occluders and how much of the target they cover. */
export interface OcclusionResult {
    state: 'partial' | 'full';
    /** Estimated covered fraction of the target box (0..1). */
    coveredFraction: number;
    by: NodeKey[];
    labels: string[];
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
export declare function computeFrameOcclusion({ frame, targets, visibilityCache, }: {
    frame: FrameGeometry;
    targets: SnapshotNodeGeometry[];
    visibilityCache?: Map<number, boolean>;
}): Map<number, OcclusionResult>;
/** The declared reasons a node establishes a stacking context, for reporting. */
export declare function stackingContextReasons(styles: Record<string, string>): string[];
export declare const DEFAULT_FIELDS: string[];
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
export declare const MOVED_THRESHOLD_PX = 0.5;
export declare class PageModel {
    root: PageModelNode;
    byKey: Map<NodeKey, PageModelNode>;
    parentByKey: Map<NodeKey, NodeKey>;
    frameId: string;
    /** Per-frame layout snapshot this model was fused with, when one was fetched. */
    geometry?: Map<string, FrameGeometry>;
    /** Nodes present in the previous model and gone from this one. Filled by `diffAgainst`. */
    removed: RemovedNodeRecord[];
    /** Keys of `removed`, same order — the cheap membership check. */
    removedKeys: NodeKey[];
    private deps;
    constructor(opts: {
        root: PageModelNode;
        byKey: Map<NodeKey, PageModelNode>;
        parentByKey: Map<NodeKey, NodeKey>;
        frameId: string;
        geometry?: Map<string, FrameGeometry>;
        deps?: ModelDeps;
    });
    /** Resolve a selector / backendNodeId / point to a lightweight, cycle-free handle. */
    anchor(selector: string | {
        backendNodeId: number;
    } | {
        x: number;
        y: number;
        frameId?: string;
    }): PageModelHandle | null;
    /**
     * Ground-truth point resolution: one `DOM.getNodeForLocation` hit test, then walk up
     * to the nearest ancestor the model knows. Prefer this over `anchor({x, y})` when the
     * answer has to be right — `anchor` infers the topmost node from snapshot geometry and
     * cannot see `clip-path`, rounded corners or rotated boxes.
     *
     * `point` is in document coordinates (same space as `runtime.box`); CDP wants viewport
     * coordinates, so the frame's viewport origin is subtracted here.
     */
    anchorAt(point: {
        x: number;
        y: number;
    }): Promise<PageModelHandle | null>;
    private resolveNode;
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
    private hitTestPoint;
    private makeHandle;
    /**
     * Select nodes via page-path `query`/`traverse` and project ONLY requested fields
     * into plain, cycle-free rows. This is the token-economy projection.
     */
    query(opts?: QueryOptions): ProjectionRow[];
    /**
     * Resolve `within` (or its deprecated alias `scope`) to the subtree roots to project.
     *
     * An unmatched scope THROWS. It used to fall back to the whole document, which made a
     * typo in the scope indistinguishable from "the scope matched but nothing in it passed
     * the filters" — and the wrong one of those two is a silent whole-document dump. A
     * scope is a precondition on the query, so failing it is an error, not an empty set.
     */
    private resolveScopeRoots;
    /** Indented text projection (like the aria snapshot) for compact display. */
    renderText(opts?: {
        visibleOnly?: boolean;
        inViewportOnly?: boolean;
        includeRemoved?: boolean;
    }): string;
    /** Projection config that disables lossy levers (debug/inspection mode). */
    debugMode(): ProjectionConfig;
    /**
     * Diff this model against a previous one, tagging every node with how it changed and
     * collecting the nodes that disappeared.
     *
     * A node can change in more than one way at once, so `runtime.changes` carries all of
     * them with their details and `runtime.changedSince` keeps the dominant one for
     * one-line rendering. Removals land in `this.removed` / `this.removedKeys` because a
     * removed node has no node object left to tag.
     */
    diffAgainst(prev: PageModel): void;
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
export declare function buildPageModelFromRaw({ ariaTree, domByBackendId, frameId, geometry, deps, }: {
    ariaTree: AriaSnapshotNode[];
    domByBackendId: Map<number, ModelDomInfo>;
    frameId: string;
    /** Decoded layout snapshot keyed by frameId — see `decodeCaptureSnapshot`. */
    geometry: Map<string, FrameGeometry>;
    deps?: ModelDeps;
}): PageModel;
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
export declare function fetchPageGeometry({ cdp }: {
    cdp: ICDPSession;
}): Promise<Map<string, FrameGeometry>>;
/**
 * Build a PageModel for a page: fetch the aria snapshot, the flattened DOM and the
 * layout snapshot over CDP, then delegate to the pure `buildPageModelFromRaw`.
 *
 * `rootSelector` is a **Playwright selector** and scopes what is FETCHED (it is applied
 * before any tree exists, by `page.locator`). It is a different language from
 * `query({ within })`, which is a page-path selector over the already-built tree — the
 * two used to share the name `scope`, which made one of them look like the other.
 */
export declare function buildPageModel({ page, cdp, rootSelector, scope, }: {
    page: Page;
    cdp: ICDPSession;
    rootSelector?: string;
    /** @deprecated Alias for `rootSelector` (same Playwright-selector language). */
    scope?: string;
}): Promise<PageModel>;
export {};
```

## CSS cascade types

```ts
/**
 * css-cascade.ts — Milestone 2: CSS cascade-winner provenance.
 *
 * A pure module (no CDP, no browser) that takes already-fetched matched-styles
 * data and computes the CSS cascade: for every declared property it determines
 * the winning declaration and the ordered list of losers, applying real cascade
 * order (origin/importance tier → specificity → source order).
 *
 * `computeSpecificity` uses css-tree to parse a selector list and count
 * (#id, .class/[attr]/:pseudo-class, type/::pseudo-element), taking the MAX over
 * the comma-separated selector list.
 */
/** [a, b, c] = (#id, .class/[attr]/:pseudo-class, type/::pseudo-element). */
export type Specificity = [number, number, number];
export interface StyleSourceRef {
    url: string;
    line: number;
    column: number;
}
/**
 * A rule normalized into the shape `resolveCascade` consumes. `origin` is the
 * raw CDP origin ('regular' | 'user-agent' | 'injected' | 'inspector'); `inline`
 * marks style-attribute declarations. `order` is the CDP application order
 * (higher = later = wins the source-order tiebreak). `important` holds the set
 * of property names carrying `!important` in this rule.
 */
export interface NormalizedRule {
    selector: string;
    specificity: Specificity;
    declarations: Record<string, string>;
    important: Set<string>;
    origin: string;
    source: StyleSourceRef | null;
    inline?: boolean;
    order: number;
    /** CDP stylesheet id, when known — lets callers fetch source text for code-frames. */
    styleSheetId?: string;
    /**
     * Declarations present in the rule that were NOT kept in `declarations`, as
     * `"name: value"`, with the reason. Present only when something was dropped.
     *
     * The filter itself is deliberate — a `-webkit-` prefixed property and an `initial`
     * value are both Chrome's own expansion noise rather than authored cascade input — but
     * dropping them with no trace made `declarations` read as the rule's full content.
     * Measured: a real `#wk { -webkit-line-clamp: 2; -webkit-box-orient: vertical; color:
     * red }` arrives with all three, and only `color` survived, so "why is my
     * `-webkit-line-clamp` not in the cascade" had no answer anywhere in the output.
     */
    droppedDeclarations?: string[];
}
/** A cycle-free reference to a single declaration (winner or loser). */
export interface DeclRef {
    selector: string;
    value: string;
    important: boolean;
    source: StyleSourceRef | null;
    origin: string;
}
export interface CascadeResult {
    winnerFor: Record<string, DeclRef>;
    losersFor: Record<string, DeclRef[]>;
}
/** Lexicographic compare: >0 if x is more specific than y, <0 if less, 0 equal. */
export declare function compareSpecificity(x: Specificity, y: Specificity): number;
/**
 * Compute the specificity of a selector string. For a comma-separated list the
 * MAX specificity over all selectors is returned. Parse failures yield [0,0,0].
 */
export declare function computeSpecificity(selector: string): Specificity;
/**
 * Resolve the cascade for a set of normalized rules. For every declared
 * property, returns the winning `DeclRef` plus the ordered losers (highest to
 * lowest priority among the non-winners).
 */
export declare function resolveCascade(rules: NormalizedRule[]): CascadeResult;
/**
 * Render a cascade result as a compact, human-readable report. The winning
 * declaration is marked with `>`, losers with `x`, highest to lowest priority.
 * Pure — no CDP / code-frame (that enrichment happens in the executor).
 */
export declare function formatCascadeReport(opts: {
    element?: string;
    winnerFor: Record<string, DeclRef>;
    losersFor: Record<string, DeclRef[]>;
    properties?: string[];
}): string;
```

## Examples

```ts
// ALL debug helpers below are GLOBAL VARIABLES in the sandbox.
// Call them directly — no import, no require needed.
// `{ page: state.page }` is NOT optional on any of these. Every helper that accepts an
// optional `page` falls back to the sandbox `page` global — the DEFAULT tab — so a task
// that stored its tab in `state.page` and omitted the option inspects the wrong one.
import { state, pm, queryPage, debugStyle, whyOccluded, console } from './debugger-examples-types.js'

// Example: query the page model for every interactive button (token-lean rows)
async function queryButtons() {
  // Returns plain, cycle-free projection rows — never the live model.
  const rows = await pm.query({ page: state.page, roles: ['button'] })
  for (const row of rows) {
    console.log(row.role, '=>', row.name, '@', row.locator)
  }
}

// Example: query with a page-path virtual type + custom fields
async function queryVisibleInteractive() {
  // `select` routes through page-path's query engine. The complete registered vocabulary
  // is: document, element, text, Node, VisibleElement, InViewportElement, Interactive,
  // OccludedElement, FullyOccludedElement. A name outside that list returns [].
  const rows = await pm.query({
    page: state.page,
    select: 'Interactive',
    fields: ['role', 'name', 'locator', 'attributes.data-testid'],
  })
  console.log('interactive:', rows.length)

  // `visibleOnly` keeps nodes with runtime.visible === true. A node that could not be
  // MEASURED has no `visible` at all and is excluded — absence never reads as visible.
  const shown = await pm.query({ page: state.page, visibleOnly: true, fields: ['role', 'name', 'runtime.visible'] })
  // "In the viewport" is a different question: a visible node can be scrolled out.
  const onScreen = await pm.query({ page: state.page, inViewportOnly: true, fields: ['role', 'name', 'runtime.box'] })
  console.log('visible:', shown.length, 'in viewport:', onScreen.length)
}

// Example: scope a query, at both layers. These are DIFFERENT selector languages.
async function scopedQueries() {
  // `rootSelector` is a PLAYWRIGHT selector and scopes what is FETCHED, before any tree
  // exists — so CSS and `:has-text` work here.
  const inMain = await pm.query({ page: state.page, rootSelector: 'main', roles: ['link'] })
  console.log('links inside main:', inMain.length)

  // `within` is a PAGE-PATH selector over the tree that already exists: a registered type
  // name, `Type#id`, or `Type[attr=value]` with an UNQUOTED value.
  const inCard = await pm.query({ page: state.page, within: 'element[data-testid=card]', fields: ['role', 'name'] })
  console.log('rows inside the card:', inCard.length)

  // An unmatched `within` THROWS. That is deliberate: it used to widen silently to the
  // whole document, which made a typo indistinguishable from a real empty result.
  try {
    await pm.query({ page: state.page, within: 'main' }) // there is no page-path type called `main`
  } catch (err) {
    console.log('scope precondition failed:', (err as Error).message)
  }

  // The deprecated `scope` alias means `rootSelector` on EVERY pm.* call, `pm.query`
  // included — it is never read as a query `within`. This is the same request as the
  // `rootSelector` call above.
  const alsoInMain = await pm.query({ page: state.page, scope: 'main', roles: ['link'] })
  console.log('same thing, deprecated spelling:', alsoInMain.length)
}

// Example: anchor a selector to a lightweight handle, then follow its lazy edges
async function anchorAndInspect() {
  // `pm.anchor` is NOT a CSS engine. It accepts an exact locator string as printed by
  // `snapshot` (role=…/[attr="value"]), a page-path selector (`Type[attr=value]` with an
  // UNQUOTED value, `Type#id`, a registered type, `*`), `{ backendNodeId }`, or a point.
  // CSS forms like 'button:has-text("Submit")' or '.card' never match and return null.
  const handle = await pm.anchor('role=button[name="Submit"]', { page: state.page })
  if (!handle) {
    console.log('not found')
    return
  }

  // render() is a compact one-line label for the node.
  console.log(handle.render())
  console.log('role:', handle.role, 'tag:', handle.tag)

  // `visible` is OPTIONAL. undefined means the node could not be measured (an a11y-only
  // node, user-agent shadow content) — it does NOT mean visible, and it does not mean
  // hidden either. Test for `=== true` when you need a yes.
  if (handle.runtime.visible === undefined) console.log('unmeasured — visibility unknown')
  else console.log('visible:', handle.runtime.visible, 'in viewport:', handle.runtime.inViewport)

  // Geometry is real: box, paint order, and the tracked computed styles.
  console.log('box:', handle.runtime.box, 'paintOrder:', handle.runtime.paintOrder)
  console.log('display:', handle.runtime.computedStyles['display'])

  // Lazy edges: React fiber + cascade winners are fetched only when you ask.
  const fiber = await handle.reactFiber()
  if (fiber) console.log('component:', fiber.componentName)

  const styles = await handle.styles()
  console.log('cascade winners:', styles)
}

// Example: resolve a POINT to a node — two ways, with different guarantees
async function anchorByPoint() {
  // `anchor({x, y})` INFERS the topmost node from snapshot paint order. Cheap (no extra
  // round-trip), but blind to clip-path, rounded corners and rotated boxes. Coordinates
  // are DOCUMENT coordinates — the same space as runtime.box. `frameId` picks a frame;
  // frames are never mixed, because each one's boxes are in its own coordinate space.
  const inferred = await pm.anchor({ x: 640, y: 320 }, { page: state.page })

  // `anchorAt` is the GROUND-TRUTH hit test (one DOM.getNodeForLocation), then a walk up
  // to the nearest node the model knows. Use it when the answer has to be right.
  const actual = await pm.anchorAt({ x: 640, y: 320 }, { page: state.page })

  if (inferred && actual && inferred.key !== actual.key) {
    console.log('geometry says', inferred.render(), 'but the hit test says', actual.render())
  }
}

// Example: indented text projection of the tree (like the aria snapshot, but fused)
async function renderTree() {
  // Removed nodes are listed after the tree by default — a disappearing element is
  // exactly what the diff is for. Pass includeRemoved: false to suppress them.
  const text = await pm.renderText({ page: state.page, visibleOnly: true, inViewportOnly: false, includeRemoved: true })
  console.log(text)
}

// Example: what changed since the previous call in this session
async function whatChanged() {
  // The model is diffed against the previous one for the same page, so `changedSince` and
  // `changes` carry the details: 'new' | 'moved' | 'style' | 'removed' | 'hidden' | 'shown'.
  const rows = await pm.query({ page: state.page, changedSince: true, fields: ['role', 'name', 'locator'] })
  for (const row of rows) {
    if (row.changedSince) console.log(row.role, row.name, '=>', row.changedSince, row.changes)
  }
}

// Example: flip off the lossy projection levers for a full-fidelity pass
async function inspectInDebugMode() {
  // debugMode() returns a projection config with dedup/whitelist/visibleOnly disabled.
  const config = await pm.debugMode({ page: state.page })
  console.log('debug projection config:', config)

  // queryPage is the same projection as pm.query, exposed as a top-level helper.
  const all = await queryPage({ page: state.page, visibleOnly: config.visibleOnly })
  console.log('total projected nodes:', all.length)
}

// Example: explain WHY a CSS property has its value (cascade winner + losers)
async function whyColor() {
  const loc = state.page.locator('.btn-primary')
  const report = await debugStyle({ locator: loc, property: 'color' })

  // report.text is a ready-to-read cascade explanation.
  console.log(report.text)

  const { winner, losers } = report.properties.color
  console.log('winner:', winner.selector, '=>', winner.value)
  console.log('overridden:', losers.map((l) => `${l.selector} (${l.value})`))
}

// Example: debug straight from a PageModel handle instead of a raw locator
async function debugFromHandle() {
  const handle = await pm.anchor('[data-testid="card"]', { page: state.page })
  if (!handle) return
  // debugStyle/whyOccluded accept either a { locator } or a { node } handle.
  const report = await debugStyle({ node: handle, property: 'display' })
  console.log(report.text)
}

// Example: find what is actually covering an element.
async function whyIsItHidden() {
  const loc = state.page.locator('.checkout-button')
  const info = await whyOccluded({ locator: loc })
  console.log(info.text) // reads the three evidence layers out in order

  // `measured: false` means the element could not be joined to the measured tree at all,
  // so occlusion is UNKNOWN — not "clear".
  if (!info.measured) return

  // Layer 1 — INFERENCE from paint order + bounds containment.
  if (info.occluded) {
    console.log(`${info.occluded} occlusion, ~${Math.round((info.occludedFraction ?? 0) * 100)}% covered`)
    console.log('covered by:', info.occludedByLabels, info.occludedBy)
  }

  // Layer 2 — GROUND TRUTH at the box centre. When it disagrees with layer 1, it wins.
  if (info.hitTest && !info.hitTest.isTarget) {
    console.log('a click at the centre actually hits:', info.hitTest.label)
  }

  // The inference is unreliable exactly when the painted shape is not the bounds rect.
  if (info.shapeDistortingProps.length) {
    console.log('bounds are not the paint shape:', info.shapeDistortingProps, '— trust the hit test')
  }

  // Layer 3 — Chromium's own stacking-context flag, plus the declarations explaining it.
  console.log('stacking context:', info.stackingContext, info.stackingReasons)
  console.log('position:', info.position, 'z-index:', info.zIndex)
}

// Example: find every element something is painting over, in one query
async function listOccluded() {
  // OccludedElement = partially OR fully covered. FullyOccludedElement = no visible
  // remainder at all. The two stay distinguishable: a half-covered button is a different
  // bug from an invisible one.
  const partial = await queryPage({ page: state.page, select: 'OccludedElement', fields: ['role', 'name', 'runtime.occludedFraction'] })
  const total = await queryPage({ page: state.page, select: 'FullyOccludedElement', fields: ['role', 'name', 'runtime.occludedByLabels'] })
  console.log('covered:', partial.length, 'fully hidden:', total.length)
}

export {
  queryButtons,
  queryVisibleInteractive,
  scopedQueries,
  anchorAndInspect,
  anchorByPoint,
  renderTree,
  whatChanged,
  inspectInDebugMode,
  whyColor,
  debugFromHandle,
  whyIsItHidden,
  listOccluded,
}

```