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
