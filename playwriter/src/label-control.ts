/**
 * label-control.ts — controls a person operates through their `<label>`.
 *
 * The pattern is everywhere: a native checkbox or radio is hidden (`display: none`, 1×1 px with a
 * clip, or moved off its label) and its `<label>` is what is drawn and clicked — TodoMVC's "Mark
 * all as complete" chevron, every CSS-framework toggle and file "Upload" button. HTML defines the
 * label's activation behaviour: a click on the label is a click on its labeled control. So the
 * control is listed with its label's place on screen, and act clicks the label.
 *
 * The functions below run in the isolated world and only read: `label.control` and `control.labels`
 * are the HTML-defined associations (`for=` within the same tree, else the first labelable
 * descendant), not a guess from proximity.
 */

/**
 * A control a pointer can operate on its own: laid out at a usable size, not visibility-hidden and
 * taking pointer events. Whether anything is drawn there is judged separately, from pixels.
 */
const OPERABLE_SOURCE = `function operable(el, min) {
  const rect = el.getBoundingClientRect()
  if (rect.width < min || rect.height < min) return false
  const style = getComputedStyle(el)
  return style.visibility === 'visible' && style.pointerEvents !== 'none'
}`

export interface LabeledControlFacts {
  tag: string
  /** `type` of an `<input>`/`<button>`, '' otherwise. */
  type: string
  /** Native checkbox/radio state; null for other controls. */
  checked: boolean | null
  mixed: boolean
  disabled: boolean
  /** The control could be operated by pointer on its own. */
  operable: boolean
  /** The control has a layout box at all (`display: none` has none). */
  rendered: boolean
  /** The label's visible text. */
  text: string
  /** The control's own `aria-label`, which names it over the label text. */
  ariaLabel: string
}

/** `fn(args, ...labels)`: for each label, its control's facts, or null when it labels nothing. */
export const LABEL_FACTS_FN = `function (args, ...labels) {
  ${OPERABLE_SOURCE}
  return labels.map((label) => {
    const control = label && label.control
    if (!control) return null
    const type = typeof control.type === 'string' ? control.type.toLowerCase() : ''
    const toggles = control.localName === 'input' && (type === 'checkbox' || type === 'radio')
    return {
      tag: control.localName,
      type,
      checked: toggles ? control.checked === true : null,
      mixed: toggles && control.indeterminate === true,
      disabled: control.disabled === true,
      operable: operable(control, args.min),
      rendered: control.getClientRects().length > 0,
      text: (label.innerText || label.textContent || '').replace(/\\s+/g, ' ').trim(),
      ariaLabel: control.getAttribute('aria-label') || '',
    }
  })
}`

/** `fn(args, ...labels)`: each label's control node (null when it labels nothing). */
export const LABEL_CONTROLS_FN = `function (_args, ...labels) {
  return labels.map((label) => (label && label.control) || null)
}`

/**
 * `fn(args, control)`: the label to click for a control a person operates through it — its first
 * label that is rendered, visible and takes pointer events — as a one-element array, or empty.
 */
export const CLICK_LABEL_FN = `function (args, control) {
  ${OPERABLE_SOURCE}
  if (!control || !control.labels) return []
  for (const label of control.labels) {
    if (label.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && operable(label, args.min)) return [label]
  }
  return []
}`

/**
 * The role Chromium's accessibility tree gives a native control (lower-cased, as observe() reads
 * AX roles): `ax_node_object.cc` maps date → "date", datetime-local/month/week → "dateTime",
 * time → "inputTime" and color → "colorWell".
 */
export function roleOfControl(facts: Pick<LabeledControlFacts, 'tag' | 'type'>): string {
  switch (facts.tag) {
    case 'select':
      return 'combobox'
    case 'textarea':
      return 'textbox'
    case 'button':
      return 'button'
    case 'meter':
      return 'meter'
    case 'progress':
      return 'progressbar'
    case 'output':
      return 'status'
    case 'input':
      switch (facts.type) {
        case 'checkbox':
          return 'checkbox'
        case 'radio':
          return 'radio'
        case 'range':
          return 'slider'
        case 'number':
          return 'spinbutton'
        case 'button':
        case 'submit':
        case 'reset':
        case 'image':
        case 'file':
          return 'button'
        case 'color':
          return 'colorwell'
        case 'date':
          return 'date'
        case 'datetime-local':
        case 'month':
        case 'week':
          return 'datetime'
        case 'time':
          return 'inputtime'
        case 'search':
          return 'searchbox'
        default:
          return 'textbox'
      }
    default:
      return facts.tag
  }
}
