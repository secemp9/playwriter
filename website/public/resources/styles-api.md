# Styles API Reference

The getStylesForLocator function inspects CSS styles applied to an element, similar to browser DevTools "Styles" panel.

## Types

```ts
import type { ICDPSession } from './cdp-session.js';
import type { ElementTarget } from './element-resolve.js';
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
 * What to read styles for: an element (Locator, ElementHandle, or resolved from a ref), or a node of
 * `cdp`'s own document by backend id (a page-model node, which was read through that session).
 */
export type StylesTarget = ElementTarget | {
    sessionBackendNodeId: number;
};
/**
 * Resolve a style target to the CDP node it actually points at, as a FRONTEND node id on the page
 * session (what `CSS.getMatchedStylesForNode` takes). A `sessionBackendNodeId` target is already
 * that node: it is only described and pushed.
 *
 * Identity comes from `resolveElement` (element-resolve.ts): the element's own index path,
 * walked in an isolated world — never `DOM.getNodeForLocation`, which returns the TOPMOST node
 * at a point, so anything covering the element (a modal, a sticky header, a child span holding
 * the label) would silently answer about a different node. MEASURED against Chromium 145: over
 * two absolutely-positioned 200x200 divs stacked at the same origin,
 * `getNodeForLocation({x:50,y:50})` returns the LATER-painted one (`#over`), never the one
 * underneath — the exact failure `debugStyle` exists to diagnose.
 *
 * `DOM.getDocument` is the priming call CDP requires before FRONTEND node ids can be handed out
 * on a fresh session — measured: `DOM.pushNodesByBackendIdsToFrontend` on a session with
 * `DOM.enable` but no `DOM.getDocument` is rejected with "Document needs to be requested first" —
 * which is why both style entry points share this helper rather than each remembering to prime.
 */
export declare function resolveElementNode({ locator, cdp, }: {
    locator: StylesTarget;
    cdp: ICDPSession;
}): Promise<{
    nodeId: number;
    backendNodeId: number;
    node: Protocol.DOM.Node;
}>;
export declare function getStylesForLocator({ locator, cdp: cdpSession, includeUserAgentStyles, }: {
    locator: ElementTarget;
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
    locator: StylesTarget;
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