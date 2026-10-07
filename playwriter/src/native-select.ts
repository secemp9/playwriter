/**
 * Native `<select>` for act.select: what the page holds (read in the isolated world), and how a
 * person reaches an option from the keyboard, computed ahead so it can be checked: type the start
 * of its label (Chrome's type-ahead), then arrow keys for the rest.
 *
 * The model is Blink's TypeAhead (third_party/blink/renderer/core/html/forms/type_ahead.cc), which
 * both the closed select and its open list run: each typed character within a second of the last
 * one grows a buffer; the first option at or after the highlighted one (cyclically) whose label,
 * leading white space stripped and case folded, starts with the buffer is highlighted. A single
 * character searches from the option AFTER the highlighted one, and typing the same character
 * again cycles through the options starting with it. Disabled options never match (TypeAhead reads
 * them as empty labels). Arrow keys move to the next option that is neither disabled nor hidden.
 *
 * The route is a prediction, which act.select verifies against what Chrome highlights (the
 * select's accessibility value, which follows the open list's highlight) before it confirms.
 */

/** One `<option>` of a select, in `select.options` order. */
export interface SelectOptionFacts {
  /** What the list shows for it: its `label`, else its text. */
  label: string
  /** Disabled itself or through a disabled `<optgroup>`: type-ahead and arrows skip it. */
  disabled: boolean
  /** Not rendered (`hidden`, display:none): arrows skip it. */
  hidden: boolean
}

/** What SELECT_PLAN_FN reads of a native `<select>` and the wanted option. */
export interface SelectPlan {
  error?: 'gone' | 'not-select' | 'no-option' | 'disabled-option' | 'ambiguous'
  role?: string
  available?: string[]
  /** 'ambiguous': the options the wanted text matches, with their values. */
  matches?: Array<{ label: string; value: string }>
  /** The wanted option's label. */
  label?: string
  /** The wanted option's index in `select.options`. */
  index?: number
  /** The selected option's label before the change ('' when none). */
  before?: string
  /** `selectedIndex` before the change (-1: none). */
  selectedIndex?: number
  /** The wanted option is selected already. */
  alreadySelected?: boolean
  /** Every option, in order. */
  options?: SelectOptionFacts[]
  /** `multiple`, or `size > 1`: a list box drawn in the page, not a popup. */
  listBox?: boolean
  multiple?: boolean
  /** Labels of the options selected before the change. */
  selectedLabels?: string[]
}

/**
 * Native `<select>`: the one option matching `args.option` — its label, text or value exactly,
 * else the same words ignoring case and spacing — and every option's label and state, for the key
 * route. Several matches are reported, never resolved by picking the first. Reads only.
 */
export const SELECT_PLAN_FN = `function(args, el) {
  if (!el || !el.isConnected) return { error: 'gone' }
  if (el.localName !== 'select') return { error: 'not-select', role: el.getAttribute('role') || el.localName }
  const wanted = String(args.option)
  const options = Array.from(el.options)
  const labelOf = (o) => o.label || o.text
  const norm = (s) => s.trim().replace(/\\s+/g, ' ').toLowerCase()
  const exact = options.filter((o) => labelOf(o) === wanted || o.text === wanted || o.value === wanted)
  const matches = exact.length > 0 ? exact : options.filter((o) => norm(labelOf(o)) === norm(wanted))
  if (matches.length === 0) return { error: 'no-option', available: options.map(labelOf) }
  if (matches.length > 1) return { error: 'ambiguous', matches: matches.map((o) => ({ label: labelOf(o), value: o.value })) }
  const target = matches[0]
  const disabled = (o) => o.disabled || (o.parentElement && o.parentElement.localName === 'optgroup' && o.parentElement.disabled)
  if (disabled(target)) return { error: 'disabled-option', label: labelOf(target), available: options.map(labelOf) }
  const current = el.selectedIndex >= 0 ? options[el.selectedIndex] : null
  return {
    label: labelOf(target),
    index: options.indexOf(target),
    before: current ? labelOf(current) : '',
    selectedIndex: el.selectedIndex,
    alreadySelected: target.selected,
    options: options.map((o) => ({ label: labelOf(o), disabled: !!disabled(o), hidden: o.hidden || getComputedStyle(o).display === 'none' })),
    listBox: el.multiple || el.size > 1,
    multiple: el.multiple,
    selectedLabels: Array.from(el.selectedOptions).map(labelOf),
  }
}`

/** What SELECT_STATE_FN reads. */
export interface SelectState {
  /** `selectedIndex` (-1: none). */
  index: number
  /** The selected option's label ('' when none). */
  selected: string
  /** Labels of every selected option (several in a `multiple` select). */
  selectedLabels: string[]
  /** Option `args.index` is selected. */
  chosen: boolean
  /** Its list (Chrome's popup) is open. */
  open: boolean
  /** Keyboard focus is on it (through shadow roots). */
  focused: boolean
}

/** `fn({ index }, select)`: the select now (SelectState); null when it is gone. */
export const SELECT_STATE_FN = `function(args, el) {
  if (!el || !el.isConnected) return null
  const labelOf = (o) => o.label || o.text
  let active = document.activeElement
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement
  const option = el.options[args.index]
  return {
    index: el.selectedIndex,
    selected: el.selectedIndex >= 0 ? labelOf(el.options[el.selectedIndex]) : '',
    selectedLabels: Array.from(el.selectedOptions).map(labelOf),
    chosen: !!option && option.selected,
    open: el.matches(':open'),
    focused: active === el,
  }
}`

/** `fn({ index }, select)`: option number `index` as a one-element array (for a list box click). */
export const SELECT_OPTION_NODE_FN = `function(args, el) {
  if (!el || !el.isConnected) return []
  const option = el.options[args.index]
  return option ? [option] : []
}`

/** A key route to an option: the characters to type, where they leave the highlight, and the arrow presses after that. */
export interface KeyRoute {
  /** Characters typed for type-ahead ('' for none). */
  typed: string
  /** Option index highlighted once `typed` is typed (the start when nothing is typed). */
  landing: number
  /** Arrow presses from `landing` to the option: positive is ArrowDown, negative ArrowUp. */
  arrows: number
}

/** The highlight after typing `typed` from highlight `start` (-1: none), as Blink's TypeAhead moves it. */
export function typeAheadLanding(options: SelectOptionFacts[], start: number, typed: string): number {
  let highlight = start
  let buffer = ''
  let repeating = ''
  for (const char of typed) {
    buffer += char
    let prefix: string
    let offset = 1
    if (char === repeating) {
      prefix = char
    } else {
      prefix = buffer
      if (buffer.length > 1) {
        repeating = ''
        offset = 0
      } else {
        repeating = char
      }
    }
    const count = options.length
    if (count === 0) continue
    const wanted = prefix.toLowerCase()
    let index = ((highlight < 0 ? 0 : highlight) + offset) % count
    for (let tried = 0; tried < count; tried++, index = (index + 1) % count) {
      const option = options[index]
      if (!option.disabled && option.label.replace(/^\s+/, '').toLowerCase().startsWith(wanted)) {
        highlight = index
        break
      }
    }
  }
  return highlight
}

/** Arrow presses from option `from` (-1: none highlighted) to option `to`, counting only options the keys stop at. */
export function arrowPresses(options: SelectOptionFacts[], from: number, to: number): number {
  if (from === to) return 0
  const step = from < to ? 1 : -1
  let presses = 0
  for (let index = from + step; step > 0 ? index <= to : index >= to; index += step) {
    if (!options[index].disabled && !options[index].hidden) presses += step
  }
  return presses
}

/**
 * The route a person takes to option `target` from highlight `start`: type the start of its label
 * until type-ahead highlights it, or, when no prefix gets there (another option has the same label,
 * or the label starts with characters the keyboard cannot type), the prefix that leaves the fewest
 * arrow presses.
 */
export function keyRoute(options: SelectOptionFacts[], start: number, target: number): KeyRoute {
  const label = options[target].label.replace(/^\s+/, '')
  let typeable = 0
  // Playwright's keyboard types printable ASCII (its US layout) as key presses; anything else is inserted as text, which type-ahead never sees.
  while (typeable < label.length && label[typeable] >= ' ' && label[typeable] <= '~') typeable++
  let best: KeyRoute = { typed: '', landing: start, arrows: arrowPresses(options, start, target) }
  if (best.arrows === 0) return best
  for (let length = 1; length <= typeable; length++) {
    const typed = label.slice(0, length)
    const landing = typeAheadLanding(options, start, typed)
    const arrows = arrowPresses(options, landing, target)
    if (arrows === 0) return { typed, landing, arrows }
    if (Math.abs(arrows) < Math.abs(best.arrows)) best = { typed, landing, arrows }
  }
  return best
}
