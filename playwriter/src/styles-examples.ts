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
