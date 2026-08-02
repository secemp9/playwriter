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
