# Styles API Reference

The getStylesForLocator function inspects CSS styles applied to an element, similar to browser DevTools "Styles" panel.

## Types

```ts
import type { ICDPSession } from './cdp-session.js';
import type { Locator } from '@xmorse/playwright-core';
import type { Protocol } from 'devtools-protocol';
import { type NormalizedRule } from './css-cascade.js';
export interface StyleSource {
    url: string;
    line: number;
    column: number;
}
export type StyleDeclarations = Record<string, string>;
export interface StyleRule {
    selector: string;
    source: StyleSource | null;
    origin: 'regular' | 'user-agent' | 'injected' | 'inspector';
    declarations: StyleDeclarations;
    inheritedFrom: string | null;
    /**
     * Declarations the rule DOES contain that `declarations` does not, as
     * `"name: value — reason"`. Present only when something was dropped.
     *
     * `initial` values and `-webkit-` prefixed properties are filtered out on purpose, but
     * silently: `declarations` looked like the rule's whole content, so a real
     * `-webkit-line-clamp: 2` that Chrome does report simply had no representation
     * anywhere in the result.
     */
    droppedDeclarations?: string[];
}
export interface StylesResult {
    element: string;
    inlineStyle: StyleDeclarations | null;
    rules: StyleRule[];
}
/**
 * One tree the element path passes through. `enter` says how the tree is entered from
 * the previous hop: `document` = the top-level document, `frame` = the content document
 * of the iframe element the previous hop resolved, `shadow` = the shadow root of the
 * host element the previous hop resolved. `path` is the chain of 0-based *element*
 * child indexes to follow inside that tree.
 */
export interface ElementPathHop {
    enter: 'document' | 'shadow' | 'frame';
    path: number[];
}
export interface ElementPathResult {
    hops: ElementPathHop[];
    /** Lowercased tag name of the target, used to verify the walk landed on it. */
    tagName: string;
    /** Set when the path cannot be expressed, e.g. a detached or cross-origin element. */
    error?: string;
}
/**
 * Compute an element's exact position in its tree, as index paths split at shadow-root
 * and iframe boundaries.
 *
 * This runs IN THE PAGE (it is stringified by `evaluate`), so it must stay entirely
 * self-contained: no imports, no closure over module scope, no TypeScript-only syntax
 * that would not survive `String(fn)`.
 *
 * This is identity, not geometry: the walk starts at the element itself, so nothing that
 * happens to be painted on top of it can change the answer.
 */
export declare function computeElementPath(element: any): ElementPathResult;
/**
 * Resolve a locator to the CDP node it actually points at.
 *
 * Why not `DOM.getNodeForLocation`: that returns the TOPMOST node at a screen point, so
 * anything covering the element — a modal, a sticky header, or just a child span holding
 * the label — silently resolves to a *different* node, and every rule, cascade winner
 * and source location reported afterwards then belongs to the wrong element. MEASURED
 * against Chromium 145: over two absolutely-positioned 200x200 divs stacked at the same
 * origin, `getNodeForLocation({x:50,y:50})` returns the LATER-painted one (`#over`), never
 * the one underneath. That is the exact failure `debugStyle` exists to diagnose, so
 * identity is resolved through the element's own node instead: the page reports the
 * element's index path, and the path is walked over one pierced `DOM.getDocument` tree.
 * The final node's tag name is verified against the page's, so a DOM mutation racing the
 * walk fails loudly instead of answering about a neighbour.
 *
 * `DOM.getDocument` doubles as the priming call CDP requires before FRONTEND node ids can
 * be handed out on a fresh session — measured: `DOM.pushNodesByBackendIdsToFrontend` on a
 * session with `DOM.enable` but no `DOM.getDocument` is rejected with "Document needs to
 * be requested first" — which is why both style entry points share this helper rather than
 * each remembering to prime. (`DOM.getNodeForLocation` is NOT subject to that rule: the
 * same measurement had it answer with no `DOM.getDocument` and indeed with no `DOM.enable`
 * at all. It returns a backendNodeId, not a frontend one.)
 */
export declare function resolveElementNode({ locator, cdp, }: {
    locator: Locator;
    cdp: ICDPSession;
}): Promise<{
    nodeId: number;
    backendNodeId: number;
    node: Protocol.DOM.Node;
}>;
export declare function getStylesForLocator({ locator, cdp: cdpSession, includeUserAgentStyles, }: {
    locator: Locator;
    cdp: ICDPSession;
    includeUserAgentStyles?: boolean;
}): Promise<StylesResult>;
/**
 * Convert a raw CDP `CSS.getMatchedStylesForNode` response into the
 * `NormalizedRule[]` shape `resolveCascade` (css-cascade.ts) expects. Pure and
 * synchronous: directly-matched rules first (in CDP application order), then the
 * inline style (ranked last). Inherited rules are intentionally excluded — under
 * the real cascade, inheritance only applies when nothing directly declares the
 * property, so mixing inherited declarations into the same specificity sort would
 * be incorrect. Preserves `source {url,line,column}`, `origin`, and `!important`
 * flags. `order` is the CDP order (later = wins the source-order tiebreak).
 */
export declare function normalizeMatchedStyles(matchedStyles: any): NormalizedRule[];
/**
 * Fetch and normalize the matched styles for a locator's element, returning the
 * `NormalizedRule[]` ready for `resolveCascade` plus the element's backendNodeId
 * and the raw CDP response (for callers that want stylesheet text / code-frames).
 * Additive helper — does not affect `getStylesForLocator`.
 */
export declare function fetchNormalizedStyles({ locator, cdp, }: {
    locator: Locator;
    cdp: ICDPSession;
}): Promise<{
    backendNodeId: number;
    nodeId: number;
    rules: NormalizedRule[];
    matchedStyles: any;
}>;
export declare function formatStylesAsText(styles: StylesResult): string;
```

## Examples

```ts
// `state.page` is the tab this session owns. The bare `page` global is the DEFAULT tab,
// which is very often not the one you navigated — see "working with pages" in skill.md.
import { state, getStylesForLocator, formatStylesAsText, debugStyle, whyOccluded, console } from './debugger-examples-types.js'

// Example: Get styles for an element and display them
async function getElementStyles() {
  const loc = state.page.locator('.my-button')
  const styles = await getStylesForLocator({ locator: loc })
  console.log(formatStylesAsText(styles))
}

// Example: Inspect computed styles for a specific element
async function inspectButtonStyles() {
  const button = state.page.getByRole('button', { name: 'Submit' })
  const styles = await getStylesForLocator({ locator: button })

  console.log('Element:', styles.element)

  if (styles.inlineStyle) {
    console.log('Inline styles:', styles.inlineStyle)
  }

  for (const rule of styles.rules) {
    console.log(`${rule.selector}: ${JSON.stringify(rule.declarations)}`)
    if (rule.source) {
      console.log(`  Source: ${rule.source.url}:${rule.source.line}`)
    }
  }
}

// Example: Include browser default (user-agent) styles
async function getStylesWithUserAgent() {
  const loc = state.page.locator('input[type="text"]')
  const styles = await getStylesForLocator({
    locator: loc,
    includeUserAgentStyles: true,
  })
  console.log(formatStylesAsText(styles))
}

// Example: Find where a CSS property is defined
async function findPropertySource() {
  const loc = state.page.locator('.card')
  const styles = await getStylesForLocator({ locator: loc })

  const backgroundRule = styles.rules.find((r) => 'background-color' in r.declarations)
  if (backgroundRule) {
    console.log('background-color defined by:', backgroundRule.selector)
    if (backgroundRule.source) {
      console.log(`  at ${backgroundRule.source.url}:${backgroundRule.source.line}`)
    }
  }
}

// Example: Check inherited styles
async function checkInheritedStyles() {
  const loc = state.page.locator('.nested-text')
  const styles = await getStylesForLocator({ locator: loc })

  const inheritedRules = styles.rules.filter((r) => r.inheritedFrom)
  for (const rule of inheritedRules) {
    console.log(`Inherited from ${rule.inheritedFrom}: ${rule.selector}`)
    console.log('  Properties:', rule.declarations)
  }
}

// Example: Compare styles between two elements
async function compareStyles() {
  const primary = await getStylesForLocator({ locator: state.page.locator('.btn-primary') })
  const secondary = await getStylesForLocator({ locator: state.page.locator('.btn-secondary') })

  console.log('Primary button:')
  console.log(formatStylesAsText(primary))

  console.log('Secondary button:')
  console.log(formatStylesAsText(secondary))
}

// Example: Debug WHY a property has the value it does (cascade winner + losers)
async function debugWinningColor() {
  const loc = state.page.locator('.btn-primary')
  // Pass a specific property to see the winner and every overridden declaration.
  const report = await debugStyle({ locator: loc, property: 'color' })

  // `report.text` is a ready-to-read cascade explanation:
  //   color:
  //     > .btn-primary.active { color: white } /* app.css:42:2 */
  //     x .btn-primary        { color: blue }  /* app.css:30:2 */
  console.log(report.text)

  // `report.properties` is the structured form (winner + ordered losers per prop).
  const { winner, losers } = report.properties.color
  console.log('winner:', winner.selector, '=>', winner.value)
  console.log('overridden:', losers.map((l) => `${l.selector} (${l.value})`))
}

// Example: See every contested property at once (no property filter)
async function debugAllContestedProps() {
  const loc = state.page.locator('.card')
  const report = await debugStyle({ locator: loc })
  console.log(report.text)
}

// Example: Debug a node handle from the PageModel instead of a raw locator
async function debugFromNode(node: unknown) {
  const report = await debugStyle({ node, property: 'display' })
  console.log(report.text)
}

// Example: Inspect stacking context and find what is actually covering an element
async function inspectStacking() {
  const loc = state.page.locator('.modal')
  const info = await whyOccluded({ locator: loc })

  console.log('position:', info.position, 'z-index:', info.zIndex)
  // GROUND TRUTH from the layout tree (null when the node was not measured), plus the
  // declarations that explain it. The declarations never decide the flag.
  console.log('establishes a stacking context:', info.stackingContext, info.stackingReasons)

  // INFERENCE from paint order + bounds: who is painting over this, and how much.
  console.log('occluded:', info.occluded, 'by:', info.occludedByLabels, 'fraction:', info.occludedFraction)
  // GROUND TRUTH tiebreak at the box centre. When the two disagree, this one wins.
  if (info.hitTest && !info.hitTest.isTarget) console.log('a click actually hits:', info.hitTest.label)

  console.log(info.text)
}

export {
  getElementStyles,
  inspectButtonStyles,
  getStylesWithUserAgent,
  findPropertySource,
  checkInheritedStyles,
  compareStyles,
  debugWinningColor,
  debugAllContestedProps,
  debugFromNode,
  inspectStacking,
}

```