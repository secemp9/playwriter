/**
 * Blocks of a rich text editor (a contenteditable: a plain one, ProseMirror, Lexical, …) for
 * act.type: which block an element is in, where the end of its last line is drawn (to click
 * there, as a person puts the caret after a paragraph's last word), and which block holds the
 * caret. Isolated world; reads only (a Range is created to measure text, never attached).
 *
 * Measured on Chrome 149 (lab keyboard.html): Ctrl+End puts the caret at the end of the whole
 * editor, so "append to paragraph 2" typed into paragraph 3; a click on the right half of a
 * line's last character puts the caret after it.
 */

/** `fn(_, el)` → [editing host, block]: the outermost element of `el`'s contenteditable run, and the nearest block-level element from `el` up to it (the host itself when there is none). Empty when `el` is not editable content or is gone. */
export const EDITOR_PARTS_FN = `function(_, el) {
  if (!el || !el.isConnected || !el.isContentEditable) return []
  let host = el
  while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement
  const inline = (n) => { const d = getComputedStyle(n).display; return d === 'contents' || d.startsWith('inline') }
  let block = el
  while (block !== host && inline(block)) block = block.parentElement
  return [host, block]
}`

/** What EDITOR_BLOCK_FN reads. */
export interface EditorBlockFacts {
  /** How a person names it: its kind and its number among the editor's blocks of that kind ("paragraph 2", "list item 3"); "the editor" for the host. */
  label: string
  /**
   * Where to click to put the caret after its last character: CSS px from its border box's top
   * left, on the right half of that character (the left half for right-to-left text); for a block
   * with no text, on its first line. Null when nothing of it is drawn.
   */
  end: { x: number; y: number } | null
  /** Keyboard focus is on the editing host (deep through shadow roots). */
  hostFocused: boolean
}

/** `fn(_, block, host)` → EditorBlockFacts; null when either is gone. */
export const EDITOR_BLOCK_FN = `function(_, block, host) {
  if (!block || !block.isConnected || !host || !host.isConnected) return null
  const kinds = { p: 'paragraph', li: 'list item', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    td: 'cell', th: 'header cell', blockquote: 'quote', pre: 'code block', dt: 'term', dd: 'definition', figcaption: 'caption' }
  const tag = block.localName
  const label = block === host ? 'the editor' : (kinds[tag] || tag) + ' ' + (Array.from(host.querySelectorAll(tag)).indexOf(block) + 1)
  const box = block.getBoundingClientRect()
  let last = null
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.data.trim() !== '' && n.parentElement && n.parentElement.checkVisibility()) last = n
  }
  let end = null
  if (last) {
    const length = last.data.replace(/\\s+$/, '').length
    const code = last.data.charCodeAt(length - 1)
    const range = document.createRange()
    range.setStart(last, length - (code >= 0xdc00 && code <= 0xdfff && length > 1 ? 2 : 1))
    range.setEnd(last, length)
    const rects = range.getClientRects()
    const r = rects[rects.length - 1]
    if (r && r.width > 0) {
      const rtl = getComputedStyle(last.parentElement).direction === 'rtl'
      end = { x: (rtl ? r.left + Math.min(1, r.width / 2) : r.right - Math.min(1, r.width / 2)) - box.left, y: r.top + r.height / 2 - box.top }
    }
  } else if (box.width > 0 && box.height > 0) {
    const line = parseFloat(getComputedStyle(block).lineHeight)
    end = { x: Math.min(4, box.width / 2), y: Math.min(box.height / 2, Number.isFinite(line) ? line / 2 : box.height / 2) }
  }
  let active = document.activeElement
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement
  return { label, end, hostFocused: active === host }
}`

/** `fn(_, host)` → [block]: the block of the editor `host` the caret (the selection's focus) is in, the host itself when it is in no block; empty when the selection is not in the editor. */
export const EDITOR_CARET_BLOCK_FN = `function(_, host) {
  if (!host || !host.isConnected) return []
  const root = host.getRootNode()
  const selection = root.getSelection ? root.getSelection() : getSelection()
  if (!selection || selection.rangeCount === 0 || !selection.focusNode || !host.contains(selection.focusNode)) return []
  const inline = (n) => { const d = getComputedStyle(n).display; return d === 'contents' || d.startsWith('inline') }
  let block = selection.focusNode.nodeType === 1 ? selection.focusNode : selection.focusNode.parentElement
  while (block && block !== host && inline(block)) block = block.parentElement
  return [block || host]
}`
