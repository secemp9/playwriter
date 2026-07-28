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
import type { Page } from '@xmorse/playwright-core';
import type { ICDPSession } from './cdp-session.js';
import type { AriaSnapshotNode } from './aria-snapshot.js';
import { type NormalizedRule, type DeclRef } from './css-cascade.js';
export type NodeKey = `${string}:${number}`;
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
        visible: boolean;
        box?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        computedStyles: Record<string, string>;
        changedSince?: 'new' | 'moved' | 'style' | 'removed';
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
    scope?: string;
    roles?: string[];
    depth?: number;
    fields?: string[];
    visibleOnly?: boolean;
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
export declare const DEFAULT_FIELDS: string[];
export declare class PageModel {
    root: PageModelNode;
    byKey: Map<NodeKey, PageModelNode>;
    parentByKey: Map<NodeKey, NodeKey>;
    frameId: string;
    private deps;
    constructor(opts: {
        root: PageModelNode;
        byKey: Map<NodeKey, PageModelNode>;
        parentByKey: Map<NodeKey, NodeKey>;
        frameId: string;
        deps?: ModelDeps;
    });
    /** Resolve a selector / backendNodeId / point to a lightweight, cycle-free handle. */
    anchor(selector: string | {
        backendNodeId: number;
    } | {
        x: number;
        y: number;
    }): PageModelHandle | null;
    private resolveNode;
    private makeHandle;
    /**
     * Select nodes via page-path `query`/`traverse` and project ONLY requested fields
     * into plain, cycle-free rows. This is the token-economy projection.
     */
    query(opts?: QueryOptions): ProjectionRow[];
    private resolveScopeRoot;
    /** Indented text projection (like the aria snapshot) for compact display. */
    renderText(opts?: {
        visibleOnly?: boolean;
    }): string;
    /** Projection config that disables lossy levers (debug/inspection mode). */
    debugMode(): ProjectionConfig;
    /** Mark nodes whose key is absent in `prev` as `changedSince: 'new'`. */
    diffAgainst(prev: PageModel): void;
}
/**
 * Pure fuse/project: build a PageModel from already-fetched raw inputs. No CDP,
 * no page — safe to unit-test. `buildPageModel` wraps this after fetching.
 */
export declare function buildPageModelFromRaw({ ariaTree, domByBackendId, frameId, deps, }: {
    ariaTree: AriaSnapshotNode[];
    domByBackendId: Map<number, ModelDomInfo>;
    frameId: string;
    deps?: ModelDeps;
}): PageModel;
/**
 * Build a PageModel for a page: fetch the aria snapshot + flattened DOM over CDP,
 * then delegate to the pure `buildPageModelFromRaw`. Main frame only for M1, but
 * the `(frameId, backendNodeId)` keying keeps OOPIF support additive.
 */
export declare function buildPageModel({ page, cdp, scope, }: {
    page: Page;
    cdp: ICDPSession;
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
import { page, pm, queryPage, debugStyle, whyOccluded, console } from './debugger-examples-types.js'

// Example: query the page model for every interactive button (token-lean rows)
async function queryButtons() {
  // Returns plain, cycle-free projection rows — never the live model.
  const rows = await pm.query({ roles: ['button'] })
  for (const row of rows) {
    console.log(row.role, '=>', row.name, '@', row.locator)
  }
}

// Example: query with a page-path virtual type + custom fields
async function queryVisibleInteractive() {
  // `select` routes through page-path's query engine (VisibleElement, Interactive, …).
  const rows = await pm.query({
    select: 'Interactive',
    visibleOnly: true,
    fields: ['role', 'name', 'locator', 'runtime.visible'],
  })
  console.log('interactive+visible:', rows.length)
}

// Example: anchor a selector to a lightweight handle, then follow its lazy edges
async function anchorAndInspect() {
  const handle = await pm.anchor('button:has-text("Submit")')
  if (!handle) {
    console.log('not found')
    return
  }

  // render() is a compact one-line label for the node.
  console.log(handle.render())
  console.log('role:', handle.role, 'tag:', handle.tag, 'visible:', handle.runtime.visible)

  // Lazy edges: React fiber + cascade winners are fetched only when you ask.
  const fiber = await handle.reactFiber()
  if (fiber) console.log('component:', fiber.componentName)

  const styles = await handle.styles()
  console.log('cascade winners:', styles)
}

// Example: indented text projection of the tree (like the aria snapshot, but fused)
async function renderTree() {
  const text = await pm.renderText({ visibleOnly: true })
  console.log(text)
}

// Example: flip off the lossy projection levers for a full-fidelity pass
async function inspectInDebugMode() {
  // debugMode() returns a projection config with dedup/whitelist/visibleOnly disabled.
  const config = await pm.debugMode()
  console.log('debug projection config:', config)

  // queryPage is the same projection as pm.query, exposed as a top-level helper.
  const all = await queryPage({ visibleOnly: config.visibleOnly })
  console.log('total projected nodes:', all.length)
}

// Example: explain WHY a CSS property has its value (cascade winner + losers)
async function whyColor() {
  const loc = page.locator('.btn-primary')
  const report = await debugStyle({ locator: loc, property: 'color' })

  // report.text is a ready-to-read cascade explanation.
  console.log(report.text)

  const { winner, losers } = report.properties.color
  console.log('winner:', winner.selector, '=>', winner.value)
  console.log('overridden:', losers.map((l) => `${l.selector} (${l.value})`))
}

// Example: debug straight from a PageModel handle instead of a raw locator
async function debugFromHandle() {
  const handle = await pm.anchor('.card')
  if (!handle) return
  // debugStyle/whyOccluded accept either a { locator } or a { node } handle.
  const report = await debugStyle({ node: handle, property: 'display' })
  console.log(report.text)
}

// Example: inspect stacking-context inputs when an element looks occluded
async function whyIsItHidden() {
  const loc = page.locator('.modal')
  const info = await whyOccluded({ locator: loc })
  console.log('position:', info.position, 'z-index:', info.zIndex)
  console.log('creates own stacking context:', info.createsStackingContext)
  console.log(info.text)
}

export {
  queryButtons,
  queryVisibleInteractive,
  anchorAndInspect,
  renderTree,
  inspectInDebugMode,
  whyColor,
  debugFromHandle,
  whyIsItHidden,
}

```