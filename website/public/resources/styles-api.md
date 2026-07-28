# Styles API Reference

The getStylesForLocator function inspects CSS styles applied to an element, similar to browser DevTools "Styles" panel.

## Types

```ts
import type { ICDPSession } from './cdp-session.js';
import type { Locator } from '@xmorse/playwright-core';
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
}
export interface StylesResult {
    element: string;
    inlineStyle: StyleDeclarations | null;
    rules: StyleRule[];
}
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
import { page, getStylesForLocator, formatStylesAsText, debugStyle, whyOccluded, console } from './debugger-examples-types.js'

// Example: Get styles for an element and display them
async function getElementStyles() {
  const loc = page.locator('.my-button')
  const styles = await getStylesForLocator({ locator: loc })
  console.log(formatStylesAsText(styles))
}

// Example: Inspect computed styles for a specific element
async function inspectButtonStyles() {
  const button = page.getByRole('button', { name: 'Submit' })
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
  const loc = page.locator('input[type="text"]')
  const styles = await getStylesForLocator({
    locator: loc,
    includeUserAgentStyles: true,
  })
  console.log(formatStylesAsText(styles))
}

// Example: Find where a CSS property is defined
async function findPropertySource() {
  const loc = page.locator('.card')
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
  const loc = page.locator('.nested-text')
  const styles = await getStylesForLocator({ locator: loc })

  const inheritedRules = styles.rules.filter((r) => r.inheritedFrom)
  for (const rule of inheritedRules) {
    console.log(`Inherited from ${rule.inheritedFrom}: ${rule.selector}`)
    console.log('  Properties:', rule.declarations)
  }
}

// Example: Compare styles between two elements
async function compareStyles() {
  const primary = await getStylesForLocator({ locator: page.locator('.btn-primary') })
  const secondary = await getStylesForLocator({ locator: page.locator('.btn-secondary') })

  console.log('Primary button:')
  console.log(formatStylesAsText(primary))

  console.log('Secondary button:')
  console.log(formatStylesAsText(secondary))
}

// Example: Debug WHY a property has the value it does (cascade winner + losers)
async function debugWinningColor() {
  const loc = page.locator('.btn-primary')
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
  const loc = page.locator('.card')
  const report = await debugStyle({ locator: loc })
  console.log(report.text)
}

// Example: Debug a node handle from the PageModel instead of a raw locator
async function debugFromNode(node: unknown) {
  const report = await debugStyle({ node, property: 'display' })
  console.log(report.text)
}

// Example: Inspect stacking-context inputs when an element appears occluded
async function inspectStacking() {
  const loc = page.locator('.modal')
  const info = await whyOccluded({ locator: loc })

  console.log('position:', info.position, 'z-index:', info.zIndex)
  console.log('creates its own stacking context:', info.createsStackingContext)
  console.log(info.text)
  // info.occludedBy is null for now — paint-order hit-testing lands in a later milestone.
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