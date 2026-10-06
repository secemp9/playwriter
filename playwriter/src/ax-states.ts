/**
 * ax-states.ts — the element states a sighted person reads off a control at a glance
 * (ticked, greyed out, open, focused, required, invalid…), taken from Chromium's
 * accessibility tree instead of guessed from markup.
 *
 * Why the AX tree and not DOM attributes: the browser has already resolved the
 * precedence (native `checked` vs `aria-checked`, `disabled` inherited from a
 * `<fieldset disabled>`, `indeterminate` set from script, focus inside a shadow root),
 * and a text-only model has no other way to know that a checkbox is ticked or that a
 * button is disabled. The snapshot used to print none of this.
 *
 * MEASURED against Chromium 145 (`Accessibility.getFullAXTree`), which is what the
 * parsing below follows:
 *  - property names are `focused, disabled, required, readonly, busy, modal,
 *    multiselectable, checked, pressed, selected, expanded, invalid, level, valuetext,
 *    hasPopup` — note `hasPopup` is camel-cased on the wire.
 *  - boolean properties arrive as JSON booleans and are reported even when false
 *    (`readonly=false`, `required=false` on every text field), so only `true` is a state.
 *  - `checked`/`pressed` are TRISTATE strings: `"true" | "false" | "mixed"` (an
 *    `indeterminate` checkbox reports `"mixed"`); an unticked checkbox reports
 *    `checked="false"`, a toggle button that is off reports `pressed="false"`.
 *  - `invalid` is a string token, `"false"` on every valid field.
 *  - the document node (`RootWebArea`) reports `focused=true` whenever the page has
 *    focus; that is not an element state and is dropped here.
 */

import type { Protocol } from 'devtools-protocol'

export interface AxStates {
  focused?: true
  disabled?: true
  required?: true
  readonly?: true
  busy?: true
  modal?: true
  multiselectable?: true
  checked?: boolean | 'mixed'
  pressed?: boolean | 'mixed'
  selected?: boolean
  expanded?: boolean
  /** true, or the aria-invalid token ('grammar' | 'spelling') */
  invalid?: true | string
  /** Hierarchy level Chromium reports (headings, tree items, treegrid rows, list items); printed only for {@link LEVEL_ROLES}. */
  level?: number
  /** aria-valuetext / slider text */
  valueText?: string
  /** menu | listbox | dialog | tree | grid */
  haspopup?: string
  /** A text field that takes several lines (`<textarea>`, `aria-multiline`): Enter types a newline there instead of submitting. */
  multiline?: true
  /** aria-valuemin / aria-valuemax (sliders, spinbuttons, progress, native range/number inputs). */
  valueMin?: number
  valueMax?: number
  /** aria-autocomplete: `list` | `inline` | `both` — typing offers suggestions. */
  autocomplete?: string
  /** backendNodeId of the active descendant: the option Enter picks in a combobox/listbox. */
  activeDescendant?: number
  /** backendNodeIds of the elements that hold the error message of an invalid field (aria-errormessage). */
  errorMessage?: number[]
  /** The accessible description (aria-describedby, title, …): help or error text tied to the control. */
  description?: string
}

const DOCUMENT_ROLES: Record<string, true> = { rootwebarea: true, webarea: true }

/** Roles whose `checked === false` is a real, visible state ("unticked"), not an absent one. */
const CHECKABLE_ROLES: Record<string, true> = {
  checkbox: true,
  radio: true,
  switch: true,
  menuitemcheckbox: true,
  menuitemradio: true,
}

/**
 * Roles whose `level` is a position a person reads (heading rank, depth in a tree or a treegrid).
 * Chromium also reports `level` on every list item (its list nesting depth), which the indentation
 * of the snapshot already shows.
 */
const LEVEL_ROLES: Record<string, true> = {
  heading: true,
  treeitem: true,
  row: true,
}

function isTrue(raw: unknown): boolean {
  return raw === true || raw === 'true'
}

function tristate(raw: unknown): boolean | 'mixed' | undefined {
  if (raw === true || raw === 'true') return true
  if (raw === false || raw === 'false') return false
  if (raw === 'mixed') return 'mixed'
  return undefined
}

/**
 * The states that apply to one AX node, or `undefined` when none does. Only states
 * Chromium actually reported are set — an absent key means "not reported", which for
 * `checked` on a non-checkable role is not the same as "unchecked".
 */
export function axStatesFromNode(node: Protocol.Accessibility.AXNode): AxStates | undefined {
  const properties = node.properties ?? []
  const role = String(node.role?.value ?? '').toLowerCase()
  const states: AxStates = {}
  let any = false
  const description = node.description?.value
  if (typeof description === 'string' && description.trim() !== '') {
    states.description = description.trim()
    any = true
  }
  for (const property of properties) {
    const raw = property.value?.value
    switch (property.name as string) {
      case 'focused':
        if (isTrue(raw) && !DOCUMENT_ROLES[role]) {
          states.focused = true
          any = true
        }
        break
      case 'disabled':
      case 'required':
      case 'readonly':
      case 'busy':
      case 'modal':
      case 'multiselectable':
        if (isTrue(raw)) {
          states[property.name as 'disabled' | 'required' | 'readonly' | 'busy' | 'modal' | 'multiselectable'] = true
          any = true
        }
        break
      case 'checked':
      case 'pressed': {
        const value = tristate(raw)
        if (value !== undefined) {
          states[property.name as 'checked' | 'pressed'] = value
          any = true
        }
        break
      }
      case 'selected':
      case 'expanded':
        if (typeof raw === 'boolean' || raw === 'true' || raw === 'false') {
          states[property.name as 'selected' | 'expanded'] = isTrue(raw)
          any = true
        }
        break
      case 'invalid':
        if (raw === true || raw === 'true') {
          states.invalid = true
          any = true
        } else if (typeof raw === 'string' && raw !== '' && raw !== 'false') {
          states.invalid = raw
          any = true
        }
        break
      case 'level':
        if (typeof raw === 'number' && Number.isFinite(raw)) {
          states.level = raw
          any = true
        }
        break
      case 'valuetext':
        if (typeof raw === 'string' && raw !== '') {
          states.valueText = raw
          any = true
        }
        break
      case 'hasPopup':
      case 'haspopup':
        if (typeof raw === 'string' && raw !== '' && raw !== 'false') {
          states.haspopup = raw
          any = true
        }
        break
      case 'multiline':
        if (isTrue(raw)) {
          states.multiline = true
          any = true
        }
        break
      case 'valuemin':
      case 'valuemax':
        if (typeof raw === 'number' && Number.isFinite(raw)) {
          states[property.name === 'valuemin' ? 'valueMin' : 'valueMax'] = raw
          any = true
        }
        break
      case 'autocomplete':
        if (typeof raw === 'string' && raw !== '' && raw !== 'none') {
          states.autocomplete = raw
          any = true
        }
        break
      case 'activedescendant': {
        const id = property.value?.relatedNodes?.find((related) => related.backendDOMNodeId !== undefined)?.backendDOMNodeId
        if (id !== undefined) {
          states.activeDescendant = id
          any = true
        }
        break
      }
      case 'errormessage': {
        const ids = (property.value?.relatedNodes ?? []).flatMap((related) => (related.backendDOMNodeId !== undefined ? [related.backendDOMNodeId] : []))
        if (ids.length > 0) {
          states.errorMessage = ids
          any = true
        }
        break
      }
    }
  }
  return any ? states : undefined
}

/**
 * Render states as bracketed tokens, leading space included: `' [checked] [disabled]'`,
 * `''` when there is nothing to say. Order is fixed (focus, then the "what does it
 * show" states, then the "can I use it" states) so two renderings of the same element
 * diff cleanly.
 *
 * Silences on purpose, because a token on every row is noise a weak model has to wade
 * through: `selected=false` (every unselected tab/option), `pressed`/`checked` false on
 * roles where false is not a visible state, and `haspopup` on a combobox (every
 * `<select>` reports `menu`; the role already says it opens a list), and `level` outside
 * {@link LEVEL_ROLES}.
 */
export function formatAxStates(states: AxStates | undefined, role: string): string {
  if (!states) return ''
  const tokens: string[] = []
  if (states.focused) tokens.push('focused')
  if (states.checked === true) tokens.push('checked')
  else if (states.checked === 'mixed') tokens.push('mixed')
  else if (states.checked === false && CHECKABLE_ROLES[role]) tokens.push('unchecked')
  if (states.pressed === true) tokens.push('pressed')
  else if (states.pressed === 'mixed') tokens.push('pressed=mixed')
  else if (states.pressed === false) tokens.push('not pressed')
  if (states.selected === true) tokens.push('selected')
  if (states.expanded === true) tokens.push('expanded')
  else if (states.expanded === false) tokens.push('collapsed')
  if (states.disabled) tokens.push('disabled')
  if (states.readonly) tokens.push('readonly')
  if (states.required) tokens.push('required')
  if (states.invalid === true) tokens.push('invalid')
  else if (typeof states.invalid === 'string') tokens.push(`invalid=${states.invalid}`)
  if (states.busy) tokens.push('busy')
  if (states.modal) tokens.push('modal')
  if (states.multiselectable) tokens.push('multiselectable')
  if (states.haspopup && role !== 'combobox') tokens.push(`haspopup=${states.haspopup}`)
  if (states.level !== undefined && LEVEL_ROLES[role]) tokens.push(`level=${states.level}`)
  if (states.valueText !== undefined) tokens.push(`valuetext="${states.valueText.replace(/"/g, '\\"')}"`)
  return tokens.map((token) => ` [${token}]`).join('')
}
