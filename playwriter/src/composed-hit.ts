/**
 * Whether a hit-tested node is a click on a target element, across shadow boundaries. Isolated
 * world; reads only.
 *
 * `DOM.getNodeForLocation` answers with an element: over text it names the text's DOM parent.
 * Text a shadow host slots into a button inside its own shadow tree (`<mdn-button>Run</mdn-button>`
 * whose shadow tree is `<button><slot></slot></button>`) is drawn inside the button, and a click
 * on it reaches the button (the event's path runs through the slot), yet the hit test names the
 * host. Measured on Chrome 149: the centre of such a button hit-tests to the host, its padding to
 * the button, for open and closed shadow roots alike. So the host does not cover the button there,
 * and neither does an element of the host's light DOM slotted into it.
 */

/**
 * `fn({ x?, y? }, target, hit)` → true when `hit` reaches `target`: it is `target`, inside it
 * (composed tree: through shadow roots, open or closed), slotted into it (flat tree: assigned,
 * flattened, to a `<slot>` in `target`'s subtree), the shadow host whose slotted text under
 * (x, y) — in the frame's viewport — is drawn inside `target`, or `target`'s `<label>`. False
 * otherwise; null when `target` is gone. Slots are found from `target`'s side
 * (`assignedNodes`), since `assignedSlot` hides a closed shadow root's slots.
 */
export const REACHES_TARGET_FN = `function(args, target, hit) {
  if (!target || !target.isConnected) return null
  if (!hit) return false
  for (let n = hit; n; n = n.parentNode || n.host || null) { if (n === target) return true }
  if (target.labels) { for (const label of target.labels) { if (label === hit || label.contains(hit)) return true } }
  const slots = target.localName === 'slot' ? [target, ...target.querySelectorAll('slot')] : [...target.querySelectorAll('slot')]
  if (slots.length === 0) return false
  const slotted = new Set(slots.flatMap((slot) => slot.assignedNodes({ flatten: true })))
  for (let n = hit; n; n = n.parentNode || n.host || null) { if (slotted.has(n)) return true }
  if (!args || typeof args.x !== 'number' || typeof args.y !== 'number') return false
  for (const node of slotted) {
    if (node.nodeType !== 3 || node.parentNode !== hit) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    for (const r of range.getClientRects()) {
      if (args.x >= r.left && args.x <= r.right && args.y >= r.top && args.y <= r.bottom) return true
    }
  }
  return false
}`
