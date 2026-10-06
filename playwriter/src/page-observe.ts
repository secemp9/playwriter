/**
 * page-observe.ts — what a careful person sees on the page right now, as text.
 *
 * A model without vision used to read the page through `snapshot()`: a full AX tree
 * with no element states, no notion of the viewport, nothing about what covers what,
 * refs renumbered on every call, and a hard cut at 10k characters. It could not tell a
 * ticked checkbox from an unticked one, a button under a cookie banner from a usable
 * one, or the reply that just streamed in from the rest of the page.
 *
 * `observePage` builds one `Observation` from CDP truth only — the PageModel (AX tree
 * fused with `DOMSnapshot.captureSnapshot` geometry, paint order and occlusion), the AX
 * states, DOMSnapshot's `isClickable`, and, for in-view images, a read-only look at
 * `complete`/`naturalWidth` from the isolated world. Nothing is written to the page.
 *
 * Every element gets a stable ref from the `RefRegistry`, a `Visibility`, the landmark
 * it is in, and — only when its role+name repeats — the context that tells the copies
 * apart. `renderObservation` prints it viewport-first within a hard character budget;
 * `diffObservations`/`renderObservationDiff` say what changed after an action;
 * `findInObservation` searches everything, off-screen included, and says where each
 * match is.
 *
 * Every frame is observed: an iframe is listed as an element of the page around it
 * (`[7] iframe "Secure card payment" — 4 controls`) and its content follows it, read through the
 * session that owns the frame (an out-of-process iframe has its own) and placed in main-document
 * coordinates, so visibility, covering and refs work the same inside and outside iframes.
 */

import type { Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import { ModelFacingError, type BusySignal, type JsDialogState } from './probe-types.js'
import { isNodeGoneError, withDeadline, type IsolatedWorld } from './isolated-world.js'
import type { FrameBox, FrameEntry, PageFrames, UnreadableFrame } from './page-frames.js'
import { formatAxStates, type AxStates } from './ax-states.js'
import { getAriaSnapshot, isSecretField } from './aria-snapshot.js'
import {
  buildPageModelFromRaw,
  computeFrameOcclusion,
  coveredFraction,
  fetchPageGeometry,
  measureLaidOutRecord,
  nodeVisibleText,
  visibleClipRect,
  type Box,
  type FrameGeometry,
  type ModelDomInfo,
  type NodeKey,
  type PageModel,
  type PageModelNode,
  type SnapshotNodeGeometry,
} from './page-model.js'
import type { RefRegistry } from './ref-registry.js'
import { decodePng } from './png-pixels.js'
import { LABEL_CONTROLS_FN, LABEL_FACTS_FN, roleOfControl, type LabeledControlFacts } from './label-control.js'

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type Visibility =
  | 'in-view'
  | 'partly-covered'
  | 'covered'
  | 'above'
  | 'below'
  | 'left'
  | 'right'
  | 'clipped'
  | 'hidden'
  | 'unknown'

export interface ObservedElement {
  ref: number
  key: NodeKey
  backendNodeId: number
  /** The frame the element is in (the main frame's id, or an iframe's). */
  frameId: string
  /** AX role, or 'clickable' for a non-semantic element with a click listener */
  role: string
  name: string
  tag: string
  states?: AxStates
  value?: string
  href?: string
  /** nearest landmark, e.g. 'navigation "Main"', 'main', 'dialog "Cookie consent"' */
  region?: string
  /** only when role+name repeats: 'in listitem "Logitech M185"' / 'under heading "Reviews"' / 'after "Width"' / '2nd of 3' */
  context?: string
  /**
   * The context observe would give this element of each kind, whether or not its role+name
   * repeats right now (`liveContext` compares what the model was shown with it).
   */
  contextBasis?: { container?: string; heading?: string; caption?: string }
  visibility: Visibility
  coveredBy?: string
  coveredFraction?: number
  /** document CSS px (PageModel Box) */
  box?: Box
  image?: { loaded: boolean; broken: boolean; naturalWidth: number; naturalHeight: number; src?: string }
  /** The model has not been shown this element yet, while it was shown this document before. */
  isNew?: boolean
  /** `tag#id.class` of a non-semantic clickable — the only handle a person has on it. */
  cssLabel?: string
  /**
   * The control itself is fully transparent but laid out and clickable, with its look drawn by
   * styling around it — the custom checkbox/radio/file input pattern (TodoMVC's `.toggle` is
   * `opacity: 0` over a drawn circle). A person clicks it all the time; calling it hidden would
   * make a text-only model believe there is nothing to click.
   */
  transparent?: true
  /**
   * Operated through its `<label>`: the control itself is hidden or too small to hit (a hidden
   * native checkbox under a drawn label), so it is listed where its label is, and act clicks the
   * label — HTML forwards a label click to its control.
   */
  viaLabel?: true
  /**
   * A native drop-down `<select>`: its choices, in order. Its popup options are not listed as refs
   * of their own (a person only reaches them by opening it): `act.select(ref, label)` chooses one.
   */
  options?: Array<{ label: string; disabled?: true }>
  /** What a native input takes, from its attributes: the facts a person reads off the field. */
  widget?: WidgetFacts
  /**
   * This element is an `<iframe>`/`<frame>`: the frame it shows. Its content is listed after it
   * (each item inside has this element's ref in `inside`), or `unread` says why it is not.
   */
  frame?: {
    frameId: string
    /** The address of the document it shows. */
    url: string
    /** Listed elements inside it, nested iframes' included. */
    controls: number
    /** The `loaderId` of the document it shows, when that document was read. */
    documentId?: string
    unread?: string
  }
  /** Text of the element(s) an invalid field names as its error message (aria-errormessage). */
  errorText?: string
  /** Ref of the active descendant (the option Enter picks), when it is listed. */
  activeRef?: number
  /**
   * Ref of the scroll area (see `Observation.scrollers`) that brings the element into view: the
   * nearest it sits in that scrolls up and down when it is above or below, sideways when it is off
   * to the left or right; else the nearest of any kind.
   */
  scroller?: number
  /** Refs of the listed elements (and the modal) that contain this one, nearest first. Drives `scope`. */
  inside?: number[]
  /** Inside the modal layer that currently takes the input (see `Observation.modal`). */
  inModal?: true
  /** Document-order position, shared with `TextBlock.order`, so the two lists can be interleaved. */
  order: number
}

/** Attributes of a native `<input>`/`<select>`/`<textarea>` that say what it accepts (and, for a colour input, whether its chooser is open). */
export interface WidgetFacts {
  /** `type` of an `<input>` ('' for none). */
  type: string
  min?: string
  max?: string
  step?: string
  placeholder?: string
  pattern?: string
  multiple?: true
  accept?: string
  maxLength?: number
  /** A colour input with a `list`: Chrome opens its swatch popup for it instead of the full colour chooser. */
  swatches?: true
  /** A colour input whose chooser (Chrome's page popup) is open now: keys go to the chooser, not the page. Read live (`:open`). */
  chooserOpen?: true
}

/**
 * An element whose own content scrolls (overflow auto/scroll/overlay with more content than
 * fits), vertically, horizontally or both: an app shell's message list, a sidebar, a code panel,
 * a carousel. It has a ref, so `act.scroll(dir, { ref })` and `observe({ scope })` work on it.
 */
export interface ObservedScroller {
  ref: number
  key: NodeKey
  backendNodeId: number
  /** AX role of the scroll area, or 'scroll area' when the accessibility tree does not list it. */
  role: string
  /** Its accessible name, or `tag#id.class` when it has none. */
  name: string
  /** It scrolls up and down: overflow-y lets it, and its content is taller than its box. */
  vertical: boolean
  /** It scrolls sideways (a carousel, a wide table): overflow-x lets it, and its content is wider than its box. */
  horizontal: boolean
  /** Chrome's scrollTop: moves only when the area scrolls; 0 or negative for an area that starts at its bottom (a `column-reverse` chat log). */
  scrollTop: number
  /** How far it is scrolled from its top edge (0: at the top). */
  scrolledFromTop: number
  scrollHeight: number
  clientHeight: number
  screensAbove: number
  screensBelow: number
  /** Chrome's scrollLeft: moves only when the area scrolls; 0 or negative for an area that starts at its right edge (right-to-left, vertical-rl). */
  scrollLeft: number
  /** How far it is scrolled from its left edge (0: at the left edge). */
  scrolledFromLeft: number
  scrollWidth: number
  clientWidth: number
  /** Screens of its own width to its left and right edges. */
  screensLeft: number
  screensRight: number
  visibility: Visibility
  box?: Box
}

/** A live region (status, alert, log, marquee, timer, `aria-live`): the page announces changes in it. */
export interface LiveRegion {
  key: NodeKey
  /** `status`, `alert`, `log`, … or `aria-live=polite` for an element with no role. */
  role: string
  name: string
  /** Everything it says now, in full. Its text blocks are listed in `Observation.text` as well. */
  text: string
  /** Its last text block: what was added or rewritten most recently in a log, the whole message of a status. */
  latest: string
}

/**
 * Something listed before in this document that this observation does not list, though it is still
 * in the DOM: hidden (not rendered, a closed menu) or inert (behind a modal dialog, `inert`,
 * `aria-hidden`). Decided from the DOMSnapshot node table and the AX tree's `ignoredReasons`.
 */
export interface AbsentItem {
  key: NodeKey
  ref?: number
  reason: 'hidden' | 'inert'
  /** For the model, naming the fix: `its button [30] "File" is collapsed — open it first (act.click(30))`. */
  why: string
}

export interface TextBlock {
  key: NodeKey
  /** The frame the text is in (the main frame's id, or an iframe's). */
  frameId: string
  role: string
  /** The block's whole text; renderers cut it, with a "(+N chars)" marker. */
  text: string
  level?: number
  region?: string
  visibility: Visibility
  isNew?: boolean
  inside?: number[]
  inModal?: true
  /** The live region it is in (`log "Conversation"`): the page announces changes here. */
  live?: string
  /** Ref of the scroll area that brings it into view (as `ObservedElement.scroller`). */
  scroller?: number
  order: number
  box?: Box
}

export interface Observation {
  takenAt: number
  url: string
  /** CDP target id of the tab observed. */
  targetId: string
  /** Undefined while a native dialog freezes the page: nothing can be read then. */
  title?: string
  /** Main-frame loaderId. Undefined only while a native dialog freezes a tab that was never read before. */
  documentId?: string
  /** Undefined while a native dialog freezes the page. */
  viewport?: { width: number; height: number }
  /** The document's own scroll. Undefined while a native dialog freezes the page. */
  scroll?: { y: number; maxY: number; screensAbove: number; screensBelow: number }
  /** Inner scroll areas, in document order (the document's own scroll is `scroll`). */
  scrollers: ObservedScroller[]
  /** ref of the focused element when it is listed */
  focused?: number
  modal?: { ref?: number; role: string; name: string }
  busy: BusySignal[]
  jsDialog?: JsDialogState | null
  /**
   * File dialogs open on the tab, oldest first: held back by Chrome, waiting for an answer the way a
   * native one waits for a person. The page behind them stays readable but cannot be used.
   */
  fileDialogs?: Array<{ openedBy?: string; multiple: boolean; fillable: boolean }>
  live: LiveRegion[]
  /** DOM order, ALL elements (in view and off-screen) */
  elements: ObservedElement[]
  /** DOM order */
  text: TextBlock[]
  /** Listed in this document before, still in its DOM, not usable now (see `AbsentItem`). */
  absent: AbsentItem[]
  counts: { interactive: number; inView: number; above: number; below: number }
  tabs?: Array<{ index: number; title: string; url: string; controlled: boolean }>
  /** Every frame of the tab, the main one included, and how many had their content read. */
  frames: { total: number; observed: number }
}

export interface ObserveOptions {
  scope?: number
  all?: boolean
  maxChars?: number
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Roles a person can operate. `disclosuretriangle` is Chromium's role for `<summary>`
 * (measured on Chromium 145), which is clickable but in no ARIA list. `date`, `datetime`,
 * `inputtime` and `colorwell` are Chromium's roles for native date, datetime-local/month/week,
 * time and colour inputs (`ax_node_object.cc`).
 */
const INTERACTIVE_ROLES: Record<string, true> = {
  button: true,
  link: true,
  textbox: true,
  searchbox: true,
  combobox: true,
  listbox: true,
  option: true,
  checkbox: true,
  radio: true,
  switch: true,
  slider: true,
  spinbutton: true,
  tab: true,
  menuitem: true,
  menuitemcheckbox: true,
  menuitemradio: true,
  treeitem: true,
  disclosuretriangle: true,
  date: true,
  datetime: true,
  inputtime: true,
  colorwell: true,
}

/** Chromium 145 reports `<img>` as role `image`; ARIA (and older Chromium) say `img`. */
const IMAGE_ROLES: Record<string, true> = { img: true, image: true }

/** Landmarks always name a region; `form`/`region` only when named (unnamed ones are just markup). */
const LANDMARK_ROLES: Record<string, 'always' | 'named'> = {
  banner: 'always',
  navigation: 'always',
  main: 'always',
  complementary: 'always',
  contentinfo: 'always',
  search: 'always',
  dialog: 'always',
  alertdialog: 'always',
  form: 'named',
  region: 'named',
}

/** Containers that tell two same-named controls apart ("Edit" in row "Alice" vs row "Bob"). */
const CONTEXT_ROLES: Record<string, true> = {
  listitem: true,
  row: true,
  layouttablerow: true,
  article: true,
  group: true,
  region: true,
  cell: true,
  gridcell: true,
  layouttablecell: true,
  dialog: true,
  alertdialog: true,
  form: true,
}

const CELL_ROLES: Record<string, true> = {
  cell: true,
  gridcell: true,
  columnheader: true,
  rowheader: true,
  layouttablecell: true,
}

/**
 * Regions whose changes the page announces (ARIA live regions by role; `aria-live` on any
 * element is the other way to make one). Their text stays body text like any other — a chat
 * transcript in a `log` is the page's content — and the region is listed on its own LIVE line.
 */
const LIVE_ROLES: Record<string, true> = { status: true, alert: true, log: true, marquee: true, timer: true }

/** Block-level text containers whose text is read as one unit. */
const BLOCK_TEXT_ROLES: Record<string, true> = {
  paragraph: true,
  listitem: true,
  row: true,
  layouttablerow: true,
  blockquote: true,
  caption: true,
}

/** Characters of a text block, live region or value printed before the cut; the full text is kept and searched. */
const TEXT_SHOWN_CHARS = 160
/** Options of a drop-down printed inline; the rest are counted (find() searches all of them). */
const MAX_OPTIONS_SHOWN = 12
const NAME_MAX_CHARS = 80
const CONTEXT_MAX_CHARS = 50
/** A covered share at or above this makes an in-view element `partly-covered`. */
const PARTLY_COVERED_FRACTION = 0.25
/** Smallest target a person aims a pointer at (CSS px per side): smaller is decoration or a hit-slop sliver. */
export const MIN_CLICKABLE_SIDE = 8
/**
 * A click listener on a node this large (share of the viewport area) that contains other
 * controls is a delegation root, not a target: React attaches every listener to its root
 * container (MEASURED: DOMSnapshot reports React 19's `#root` as clickable), and a
 * "click outside to close" backdrop looks the same.
 */
const DELEGATION_ROOT_VIEWPORT_SHARE = 0.5
/** How much text around a find() match is printed on each side. */
const FIND_CONTEXT_CHARS = 60
/** Times observe() rebuilds when the document changes while it is being read. */
const MAX_OBSERVE_ATTEMPTS = 3
/** Modal by backdrop: this share of in-view controls covered by one layer that spans this much of the viewport. */
const BACKDROP_COVERED_SHARE = 0.6
const BACKDROP_VIEWPORT_SHARE = 0.5
const MODEL_TIMEOUT_MS = 20000
const PROBE_TIMEOUT_MS = 3000
/** Band of page around a transparent control's box that its pixels are compared with (CSS px). */
const TRANSPARENT_RING_PX = 2

// ---------------------------------------------------------------------------
// observePage
// ---------------------------------------------------------------------------

/** The subset of PageModel runtime facts visibility is decided from. */
interface Measured {
  visible?: boolean
  inViewport?: boolean
  box?: Box
  occluded?: 'partial' | 'full'
  occludedFraction?: number
  occludedBy?: NodeKey[]
  occludedByLabels?: string[]
  /** Interactive, laid out, own opacity 0, still taking pointer events: see `ObservedElement.transparent`. */
  transparent?: true
}

interface Candidate {
  key: NodeKey
  /** The frame the element is in. */
  frameId: string
  backendNodeId: number
  role: string
  name: string
  tag: string
  states?: AxStates
  value?: string
  href?: string
  cssLabel?: string
  order: number
  nodeIndex?: number
  measured: Measured
  /** The element's own model node, or for a clickable the nearest model ancestor. */
  anchor?: PageModelNode
  anchorIsSelf: boolean
  context?: string
  contextBasis: { container?: string; heading?: string; caption?: string }
  /** A clickable whose whole visible text fits in its name: text blocks inside it would only repeat it. */
  fullyNamed?: boolean
  viaLabel?: true
  options?: Array<{ label: string; disabled?: true }>
  widget?: WidgetFacts
  /** An `<iframe>`: the frame it shows, and why its content is not listed, or the document that is. */
  frame?: { frameId: string; url: string; unread?: string; documentId?: string }
}

interface TextCandidate {
  key: NodeKey
  frameId: string
  role: string
  text: string
  level?: number
  order: number
  nodeIndex?: number
  measured: Measured
  anchor: PageModelNode
}

function classifyVisibility(measured: Measured, viewport: Box | undefined): Visibility {
  if (measured.visible === undefined) return 'unknown'
  if (!measured.visible && !measured.transparent) return 'hidden'
  if (measured.inViewport === undefined || !measured.box || !viewport) return 'unknown'
  if (measured.inViewport) {
    if (measured.occluded === 'full') return 'covered'
    if ((measured.occludedFraction ?? 0) >= PARTLY_COVERED_FRACTION) return 'partly-covered'
    return 'in-view'
  }
  const box = measured.box
  const overlapsViewport =
    box.x < viewport.x + viewport.width &&
    box.x + box.width > viewport.x &&
    box.y < viewport.y + viewport.height &&
    box.y + box.height > viewport.y
  // Inside the viewport rectangle yet not in view: a scroll container (or an
  // overflow-clipping ancestor) has it scrolled out of its own visible rect.
  if (overlapsViewport) return 'clipped'
  if (box.y + box.height <= viewport.y) return 'above'
  if (box.y >= viewport.y + viewport.height) return 'below'
  if (box.x + box.width <= viewport.x) return 'left'
  return 'right'
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`
}

function cssLabelOf(record: SnapshotNodeGeometry): string {
  const attributes = record.attributes ?? {}
  let label = record.nodeName.toLowerCase()
  if (attributes.id) label += `#${attributes.id}`
  const classes = (attributes.class ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
  if (classes.length) label += `.${classes.join('.')}`
  return truncate(label, 48)
}

function modelName(node: PageModelNode): string {
  return node.axName ?? node.name ?? ''
}

/** Containers that hold blocks of their own: a row or list item that contains one is a layout wrapper, not one line of text. */
const NESTED_BLOCK_ROLES: Record<string, true> = {
  ...BLOCK_TEXT_ROLES,
  heading: true,
  list: true,
  table: true,
  layouttable: true,
  grid: true,
  treegrid: true,
}

/**
 * Whether a block container holds other blocks. Hacker News is one big layout table
 * whose outer row contains every comment; reading that row as one 160-character line
 * would swallow the whole thread, so only innermost blocks are read as units.
 */
function containsBlock(node: PageModelNode): boolean {
  for (const child of node.children) {
    const role = child.role ?? ''
    if (NESTED_BLOCK_ROLES[role]) return true
    if (INTERACTIVE_ROLES[role] || IMAGE_ROLES[role]) continue
    if (containsBlock(child)) return true
  }
  return false
}

/**
 * Text of a model subtree as a person reads it: static text and the names of inline
 * links (prose links are part of the sentence), skipping other controls and images,
 * whose labels are listed as elements in their own right, and the text of a control's
 * `<label>` (or `aria-labelledby` target), which is that control's name on its own line. With
 * `includeLinks: false` the link names are left out too — what is left is the block's own words.
 */
function gatherText(node: PageModelNode, max: number, includeLinks = true): string {
  const pieces: string[] = []
  let length = 0
  const visit = (current: PageModelNode): void => {
    if (length >= max) return
    if (current !== node && current.labels !== undefined && node.labels === undefined) return
    const role = current.role ?? ''
    if (role === 'link' && !includeLinks && current !== node) return
    if (role === 'text' || role === 'link' || role === 'heading') {
      const text = modelName(current)
      if (text) {
        pieces.push(text)
        length += text.length + 1
      }
      if (role !== 'heading' || text) return
    }
    if (current !== node && (INTERACTIVE_ROLES[role] || IMAGE_ROLES[role])) return
    for (const child of current.children) visit(child)
  }
  visit(node)
  return truncate(pieces.join(' '), max)
}

/** The choices of a native drop-down, from its accessibility subtree (the popup's options), in order. */
function nativeSelectOptions(select: PageModelNode): Array<{ label: string; disabled?: true }> {
  const options: Array<{ label: string; disabled?: true }> = []
  const walk = (node: PageModelNode): void => {
    for (const child of node.children) {
      if (child.role === 'option') options.push({ label: modelName(child), ...(child.states?.disabled ? { disabled: true as const } : {}) })
      else walk(child)
    }
  }
  walk(select)
  return options
}

function measuredFromRuntime(node: PageModelNode): Measured {
  const runtime = node.runtime
  const styles = runtime.computedStyles
  const transparent =
    runtime.visible === false &&
    runtime.rendered === true &&
    INTERACTIVE_ROLES[node.role ?? ''] === true &&
    runtime.box !== undefined &&
    runtime.box.width >= MIN_CLICKABLE_SIDE &&
    runtime.box.height >= MIN_CLICKABLE_SIDE &&
    Number.parseFloat(styles.opacity ?? '1') === 0 &&
    styles['pointer-events'] !== 'none' &&
    styles.visibility !== 'hidden' &&
    styles.visibility !== 'collapse'
  return {
    visible: runtime.visible,
    inViewport: runtime.inViewport,
    box: runtime.box,
    occluded: runtime.occluded,
    occludedFraction: runtime.occludedFraction,
    occludedBy: runtime.occludedBy,
    occludedByLabels: runtime.occludedByLabels,
    ...(transparent ? { transparent: true as const } : {}),
  }
}

/**
 * Fully transparent controls with nothing drawn where they sit, judged from the pixels a person
 * sees. A custom checkbox draws its look there (TodoMVC's circle, a styled square under it); an
 * opacity-0 button over bare page background shows nothing to see or aim at. Drawn: the pixels
 * inside the box are not all one colour, or that colour is not the one around it.
 *
 * One capture of the visible viewport serves every control, mapped to CSS pixels by its own size
 * against the window's (`devicePixelRatio` does not say how Chrome scales captures: measured 1.25
 * with a capture at 1×). A clipped capture is not used: Chrome takes it by moving its emulated
 * viewport, and two in flight returned each other's region (measured). Not judged: controls whose
 * box and band are not wholly on screen; every control of a tab that is not visible (it renders no
 * frames, so a capture would block until someone looks at it); a pinch-zoomed page.
 */
async function undrawnTransparentControls(cdp: ICDPSession, world: IsolatedWorld, candidates: Candidate[]): Promise<Set<NodeKey>> {
  const band = TRANSPARENT_RING_PX
  const undrawn = new Set<NodeKey>()
  const transparent = candidates.filter((candidate) => candidate.measured.transparent && candidate.measured.box)
  if (transparent.length === 0) return undrawn
  const view = await world.evaluate<{ visible: boolean; width: number; height: number; x: number; y: number; zoomed: boolean }>(
    "({ visible: document.visibilityState === 'visible', width: innerWidth, height: innerHeight, x: scrollX, y: scrollY, zoomed: !!visualViewport && visualViewport.scale !== 1 })",
    { what: 'reading the window size, scroll position and visibility' },
  )
  if (!view.visible || view.zoomed) return undrawn
  const judged: Array<{ key: NodeKey; box: Box }> = []
  for (const candidate of transparent) {
    const box = candidate.measured.box
    if (!box) continue
    const onScreen =
      box.x - band >= view.x &&
      box.y - band >= view.y &&
      box.x + box.width + band <= view.x + view.width &&
      box.y + box.height + band <= view.y + view.height
    if (onScreen) judged.push({ key: candidate.key, box })
  }
  if (judged.length === 0) return undrawn
  const shot = await withDeadline(
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    PROBE_TIMEOUT_MS,
    'capturing the viewport to see what is drawn under transparent controls',
  )
  const image = decodePng(Buffer.from(shot.data, 'base64'))
  const perCssX = image.width / view.width
  const perCssY = image.height / view.height
  for (const { key, box } of judged) {
    const left = Math.max(0, Math.floor((box.x - band - view.x) * perCssX))
    const top = Math.max(0, Math.floor((box.y - band - view.y) * perCssY))
    const right = Math.min(image.width, Math.ceil((box.x + box.width + band - view.x) * perCssX))
    const bottom = Math.min(image.height, Math.ceil((box.y + box.height + band - view.y) * perCssY))
    const inside = new Set<number>()
    const around = new Map<number, number>()
    for (let y = top; y < bottom; y++) {
      const cssY = view.y + (y + 0.5) / perCssY
      for (let x = left; x < right; x++) {
        const cssX = view.x + (x + 0.5) / perCssX
        const at = (y * image.width + x) * image.channels
        const color = (image.data[at] << 16) | (image.data[at + 1] << 8) | image.data[at + 2]
        if (cssX >= box.x && cssX < box.x + box.width && cssY >= box.y && cssY < box.y + box.height) inside.add(color)
        else around.set(color, (around.get(color) ?? 0) + 1)
      }
    }
    let dominant = -1
    let most = -1
    for (const [color, count] of around) {
      if (count > most) {
        dominant = color
        most = count
      }
    }
    if (inside.size === 1 && inside.has(dominant)) undrawn.add(key)
  }
  return undrawn
}

function isDialogOpen(jsDialog: JsDialogState | null | undefined): jsDialog is JsDialogState {
  return !!jsDialog && jsDialog.outcome === undefined && jsDialog.closedAt === undefined
}

/** `fn(args, ...fields)`: each field's computed `-webkit-text-security` (null for a node that is gone). */
const TEXT_SECURITY_FN = `function (_args, ...fields) {
  return fields.map((el) => (el ? getComputedStyle(el).getPropertyValue('-webkit-text-security') || 'none' : null))
}`

/**
 * In-page helpers that say where a scroller's scrolling starts on each axis, spliced into the
 * functions that read scroll state here and in human-actions.ts (one source, so the two agree).
 * From Chromium 133's source, and measured on it:
 *  - viewportBody(): the `<body>` whose style Blink gives the viewport — its writing-mode and
 *    direction always, its overflow when `<html>`'s is visible on both axes — or null when there is
 *    no `<body>` child of `<html>`, or `<html>` or `<body>` is not laid out or has containment
 *    (StyleResolver::PropagateStyleToViewport, ShouldStopBodyPropagation).
 *  - scrollsViewport(n): `n` is that `<body>` and its overflow is the viewport's: it is not a
 *    scroll container itself, and its scrollLeft/scrollTop read 0 whatever the page's scroll.
 *  - origin(n): whether `n`'s scrolling starts at its bottom (`top`: its content overflows
 *    upwards) and at its right edge (`left`). Chrome's scrollTop/scrollLeft are 0 there and go
 *    negative upwards/leftwards. Content overflows towards the logical end sides (LayoutBox::
 *    HasTopOverflow/HasLeftOverflow); a flex container swaps the main axis's for a reversed
 *    direction and the cross axis's for wrap-reverse (LayoutFlexibleBox's GetOverflowConverter):
 *    a `flex-direction: column-reverse` chat log starts at its bottom, a `row-reverse` strip at its
 *    right. Writing mode and direction map the sides: right-to-left horizontal text and
 *    vertical-rl/sideways-rl blocks start at the right; vertical text with direction rtl, and
 *    sideways-lr text with direction ltr, at the bottom. For the document's scrolling element the
 *    viewport's style decides (the viewport is no flex container).
 *  - fromTop(n), fromLeft(n): how far `n` is scrolled from its top and left edges.
 */
export const SCROLL_ORIGIN_JS = `
  let viewportBodyFound
  const viewportBody = () => {
    if (viewportBodyFound !== undefined) return viewportBodyFound
    const html = document.documentElement
    const body = html instanceof HTMLHtmlElement ? Array.prototype.find.call(html.children, (child) => child instanceof HTMLBodyElement) : undefined
    const stops = (n) => {
      const s = getComputedStyle(n)
      return s.display === 'none' || s.display === 'contents' || s.contain !== 'none' || s.containerType !== 'normal' || s.contentVisibility !== 'visible'
    }
    viewportBodyFound = body && !stops(html) && !stops(body) ? body : null
    return viewportBodyFound
  }
  const scrollsViewport = (n) => {
    if (n !== viewportBody()) return false
    const s = getComputedStyle(document.documentElement)
    return s.overflowX === 'visible' && s.overflowY === 'visible'
  }
  const origin = (n) => {
    const page = n === (document.scrollingElement || document.documentElement)
    const s = getComputedStyle(page ? viewportBody() || document.documentElement : n)
    // Whether content overflows at the inline-start, inline-end, block-start and block-end sides.
    let is = false, ie = true, bs = false, be = true
    const webkitBox = s.display === '-webkit-box' || s.display === '-webkit-inline-box'
    if (!page && (webkitBox || s.display === 'flex' || s.display === 'inline-flex')) {
      const column = webkitBox ? s.getPropertyValue('-webkit-box-orient') === 'vertical' : s.flexDirection.startsWith('column')
      const reverse = webkitBox ? s.getPropertyValue('-webkit-box-direction') === 'reverse' : s.flexDirection.endsWith('-reverse')
      const wrapReverse = s.flexWrap === 'wrap-reverse'
      if (column ? reverse : wrapReverse) [bs, be] = [be, bs]
      if (column ? wrapReverse : reverse) [is, ie] = [ie, is]
    }
    const rtl = s.direction === 'rtl'
    switch (s.writingMode) {
      case 'vertical-rl':
      case 'sideways-rl':
        return { top: rtl ? ie : is, left: be }
      case 'vertical-lr':
        return { top: rtl ? ie : is, left: bs }
      case 'sideways-lr':
        return { top: rtl ? is : ie, left: bs }
      default:
        return { top: bs, left: rtl ? ie : is }
    }
  }
  const fromTop = (n) => (origin(n).top ? n.scrollHeight - n.clientHeight + n.scrollTop : n.scrollTop)
  const fromLeft = (n) => (origin(n).left ? n.scrollWidth - n.clientWidth + n.scrollLeft : n.scrollLeft)
`

/**
 * `fn(args, ...elements)`: each element's own scroll state on both axes, or null for a node that
 * is gone, is the document's scrolling element (the page's own scroll is read from the layout
 * metrics), or is a `<body>` whose overflow is the viewport's (SCROLL_ORIGIN_JS). `scrollTop` and
 * `scrollLeft` are Chrome's own, which move only when the area scrolls; `top` and `left` are how
 * far it is scrolled from its top and left edges, which also change when content is added on that
 * side of an area that starts at its bottom or right (SCROLL_ORIGIN_JS's origin).
 */
const SCROLL_METRICS_FN = `function (_args, ...elements) {
  ${SCROLL_ORIGIN_JS}
  const root = document.scrollingElement || document.documentElement
  return elements.map((el) => {
    if (!el || el === root || scrollsViewport(el)) return null
    return {
      top: fromTop(el), scrollTop: el.scrollTop, height: el.scrollHeight, client: el.clientHeight,
      left: fromLeft(el), scrollLeft: el.scrollLeft, width: el.scrollWidth, clientWidth: el.clientWidth,
    }
  })
}`

/**
 * `fn(args, ...elements)`: for each hidden element, the control a person uses to show it, or null:
 * the `<summary>` of a closed `<details>`, the element whose `popovertarget` names a closed
 * popover, or the collapsed (`aria-expanded="false"`) element whose `aria-controls`/`aria-owns`
 * names a container of it. Reads only.
 */
const OPENER_FN = `function (_args, ...elements) {
  const parentOf = (n) => n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null)
  const openerOf = (el) => {
    if (!el) return null
    for (let n = parentOf(el); n; n = parentOf(n)) {
      if (n.localName === 'details' && !n.open) return n.querySelector(':scope > summary')
      if (!n.id) continue
      const root = n.getRootNode()
      const id = CSS.escape(n.id)
      if (n.hasAttribute('popover') && !n.matches(':popover-open')) {
        const invoker = root.querySelector('[popovertarget="' + id + '"]')
        if (invoker) return invoker
      }
      const opener = root.querySelector('[aria-expanded="false"][aria-controls~="' + id + '"], [aria-expanded="false"][aria-owns~="' + id + '"]')
      if (opener) return opener
    }
    return null
  }
  return elements.map(openerOf)
}`

/** AX `ignoredReasons` that mean "rendered, but the page has made it unusable right now". */
const INERT_REASONS: Record<string, 'modal' | 'inert' | 'aria-hidden'> = {
  activeModalDialog: 'modal',
  inertElement: 'inert',
  inertSubtree: 'inert',
  ariaHiddenElement: 'aria-hidden',
  ariaHiddenSubtree: 'aria-hidden',
}

/** What an `<input>`, `<select>` or `<textarea>` accepts, from its attributes; undefined for other tags. */
function widgetOf(tag: string, attributes: Record<string, string>): WidgetFacts | undefined {
  if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return undefined
  const maxLength = Number.parseInt(attributes.maxlength ?? '', 10)
  return {
    type: tag === 'input' ? (attributes.type ?? '').toLowerCase() : '',
    ...(attributes.min !== undefined ? { min: attributes.min } : {}),
    ...(attributes.max !== undefined ? { max: attributes.max } : {}),
    ...(attributes.step !== undefined ? { step: attributes.step } : {}),
    ...(attributes.placeholder ? { placeholder: attributes.placeholder } : {}),
    ...(attributes.pattern ? { pattern: attributes.pattern } : {}),
    ...(attributes.multiple !== undefined ? { multiple: true as const } : {}),
    ...(attributes.accept ? { accept: attributes.accept } : {}),
    ...(tag === 'input' && (attributes.type ?? '').toLowerCase() === 'color' && attributes.list !== undefined ? { swatches: true as const } : {}),
    ...(Number.isFinite(maxLength) && maxLength >= 0 ? { maxLength } : {}),
  }
}

/** A text block or listed element that vanished from the listing: its key and the node it names. */
interface Vanished {
  key: NodeKey
  backendNodeId: number
  ref?: number
}

/**
 * Of the items that vanished from the listing, the ones still in the document, and why they are
 * not listed: not rendered/visible (`hidden`, with the control that shows it when there is one),
 * or excluded from the accessibility tree by the page (`inert`: behind a modal dialog, `inert`,
 * `aria-hidden`). Items whose node left the document are really gone and are not returned; so are
 * nodes that are rendered and in the accessibility tree (they changed into something not listed).
 */
async function classifyVanished({
  cdp,
  world,
  frame,
  vanished,
  refByBackendId,
  elementByRef,
  modalLabel,
}: {
  cdp: ICDPSession
  world: IsolatedWorld
  frame: FrameGeometry
  vanished: Vanished[]
  refByBackendId: Map<number, number>
  elementByRef: Map<number, { role: string; name: string }>
  modalLabel: string | undefined
}): Promise<AbsentItem[]> {
  const cache = new Map<number, boolean>()
  const hidden: Vanished[] = []
  const rendered: Vanished[] = []
  for (const item of vanished) {
    if (!frame.documentBackendIds.has(item.backendNodeId)) continue
    const record = frame.byBackendId.get(item.backendNodeId)
    if (record && measureLaidOutRecord(record, frame, cache).visible) rendered.push(item)
    else hidden.push(item)
  }
  const absent: AbsentItem[] = []
  const ignoredReasons = await Promise.all(
    rendered.map(async (item) => {
      const { nodes } = await withDeadline(
        cdp.send('Accessibility.getPartialAXTree', { backendNodeId: item.backendNodeId, fetchRelatives: false }),
        PROBE_TIMEOUT_MS,
        `reading why node ${item.backendNodeId} left the accessibility tree (Accessibility.getPartialAXTree)`,
      ).catch((error: unknown) => {
        // Removed between the snapshot and this read: it is gone, which is what not listing it says.
        if (isNodeGoneError(error)) return { nodes: [] }
        throw error
      })
      const node = nodes.find((candidate) => candidate.backendDOMNodeId === item.backendNodeId)
      return node?.ignored ? (node.ignoredReasons ?? []).map((reason) => reason.name) : []
    }),
  )
  rendered.forEach((item, index) => {
    const kinds = new Set(ignoredReasons[index].flatMap((reason) => (INERT_REASONS[reason] ? [INERT_REASONS[reason]] : [])))
    if (kinds.size === 0) return
    const why = kinds.has('modal')
      ? `it is behind the modal ${modalLabel ?? 'dialog'} — answer or close that first`
      : kinds.has('inert')
        ? 'it is in a part of the page marked inert (disabled while something else is open) — finish or close what is open first'
        : 'the page hides it from assistive technology (aria-hidden) right now, usually because something is open over it — close that first'
    absent.push({ key: item.key, ...(item.ref !== undefined ? { ref: item.ref } : {}), reason: 'inert', why })
  })
  const hiddenRefs = hidden.filter((item) => item.ref !== undefined)
  const openers =
    hiddenRefs.length > 0
      ? await world.nodesReturnedBy(
          hiddenRefs.map((item) => item.backendNodeId),
          OPENER_FN,
          { timeoutMs: PROBE_TIMEOUT_MS, what: 'finding what shows the hidden controls (a closed menu, details or popover)' },
        )
      : []
  const openerOf = new Map(hiddenRefs.map((item, index) => [item.key, openers[index] ?? null]))
  for (const item of hidden) {
    const openerId = openerOf.get(item.key) ?? null
    const openerRef = openerId !== null ? refByBackendId.get(openerId) : undefined
    const opener = openerRef !== undefined ? elementByRef.get(openerRef) : undefined
    const why =
      opener && openerRef !== undefined
        ? `its ${opener.role} [${openerRef}]${opener.name ? ` "${truncate(opener.name, CONTEXT_MAX_CHARS)}"` : ''} is collapsed — open it first (act.click(${openerRef}))`
        : openerId !== null
          ? 'it sits in a collapsed section whose opener is not listed right now — find() what opens it'
          : 'it is not rendered or not visible right now (a closed menu, a collapsed or inactive section)'
    absent.push({ key: item.key, ...(item.ref !== undefined ? { ref: item.ref } : {}), reason: 'hidden', why })
  }
  return absent
}

/** What observePage reads besides the page itself. */
export interface ObservePageOptions {
  page: Page
  /** The page's frames: the page session (`frames.cdp`), and each frame's session and isolated world. */
  frames: PageFrames
  /** The session's ref registry (one for every tab). */
  registry: RefRegistry
  /** CDP target id of the tab. */
  targetId: string
  /**
   * The observation is rendered to the model: the refs' shown bindings become what it lists,
   * and `isNew` ("new since your last look") is measured against it from then on.
   */
  shown: boolean
  /** The latest observation of this tab, shown or not: what it listed and this one does not is classified (hidden, inert or gone). */
  previous?: Observation | null
  busy?: BusySignal[]
  jsDialog?: JsDialogState | null
  tabs?: Observation['tabs']
  options?: ObserveOptions
}

/** One frame whose content is observed: its layout (in main-document coordinates), its model, and where it sits. */
interface FrameRead {
  entry: FrameEntry
  /** The frame's layout snapshot with every box in MAIN-document CSS px (see `placeFrameGeometry`). */
  frame: FrameGeometry
  model: PageModel
  /** The `<iframe>` element that embeds it, in the parent frame. Absent for the main frame. */
  owner?: { parentId: string; key: NodeKey; backendNodeId: number; record: SnapshotNodeGeometry }
  /** Document-order position of each embedding `<iframe>` in its parent, outermost first: sorts the frame into the page. */
  path: number[]
}

/** An iframe whose content is not listed. `ownerId` (in the parent frame) is known when its parent was read. */
interface FrameNotRead {
  frameId: string
  parentId: string | null
  url: string
  ownerId?: number
  reason: string
}

/** What one renderer session holds: one layout snapshot and one DOM read cover every document it hosts. */
interface SessionRead {
  raw: Map<string, FrameGeometry>
  dom: Map<number, ModelDomInfo>
  /** The documents of this session that are observed, placed in main-document coordinates; what its models are built from. */
  placed: Map<string, FrameGeometry>
}

/** `frameId` and `backendNodeId` of a model key (`${frameId}:${backendNodeId}`). */
function splitKey(key: NodeKey): { frameId: string; backendNodeId: number } {
  const at = key.lastIndexOf(':')
  return { frameId: key.slice(0, at), backendNodeId: Number(key.slice(at + 1)) }
}

/** Lexicographic order of two sort paths; a path that is a prefix of the other comes first (an `<iframe>` before its content). */
function comparePaths(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

/**
 * A frame's layout snapshot moved into MAIN-document CSS px, the space every observed box is in.
 * DOMSnapshot reports each document in its own coordinates (measured: a button at y=60 inside an
 * iframe whose content box starts at y=132 reads y=60), so a box is taken out of the frame's
 * scroll, scaled by any transform on the iframe, and placed at the iframe's content box. The
 * frame's viewport becomes the part of that content box the iframe itself shows in its parent
 * (`ownerClip`: the parent's viewport and clipping ancestors): what is scrolled out inside the
 * frame, or cut off around the iframe, is not in view.
 */
function placeFrameGeometry(raw: FrameGeometry, box: FrameBox, mainScroll: { x: number; y: number }, ownerClip: Box | null | undefined): FrameGeometry {
  const originX = box.x + mainScroll.x
  const originY = box.y + mainScroll.y
  const placed = new Map<SnapshotNodeGeometry, SnapshotNodeGeometry>()
  const place = (record: SnapshotNodeGeometry): SnapshotNodeGeometry => {
    let moved = placed.get(record)
    if (!moved) {
      moved = {
        ...record,
        box: {
          x: originX + (record.box.x - raw.scrollOffsetX) * box.scale,
          y: originY + (record.box.y - raw.scrollOffsetY) * box.scale,
          width: record.box.width * box.scale,
          height: record.box.height * box.scale,
        },
      }
      placed.set(record, moved)
    }
    return moved
  }
  const byNodeIndex = new Map([...raw.byNodeIndex].map(([index, record]) => [index, place(record)]))
  const byBackendId = new Map([...raw.byBackendId].map(([id, record]) => [id, place(record)]))
  const shown = { x: originX, y: originY, width: box.width * box.scale, height: box.height * box.scale }
  let viewport: Box | undefined
  if (ownerClip !== undefined) {
    const x = Math.max(shown.x, ownerClip?.x ?? shown.x)
    const y = Math.max(shown.y, ownerClip?.y ?? shown.y)
    const right = ownerClip ? Math.min(shown.x + shown.width, ownerClip.x + ownerClip.width) : x
    const bottom = ownerClip ? Math.min(shown.y + shown.height, ownerClip.y + ownerClip.height) : y
    // Nothing of the iframe is visible: an empty viewport, so nothing inside is in view.
    viewport = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
  }
  return { ...raw, byNodeIndex, byBackendId, ...(viewport ? { viewport } : { viewport: undefined }) }
}

/**
 * Read every frame of the page: one layout snapshot and one DOM read per renderer session, one
 * accessibility tree per frame, each frame's boxes placed in main-document coordinates. The main
 * frame must be read; an iframe that cannot be (hidden, still loading, removed meanwhile, rotated)
 * is returned in `notRead` with why.
 */
async function readFrames({
  page,
  frames,
  listing,
  mainScroll,
}: {
  page: Page
  frames: PageFrames
  listing: { frames: FrameEntry[]; unreadable: UnreadableFrame[] }
  mainScroll: { x: number; y: number }
}): Promise<{ reads: Map<string, FrameRead>; notRead: FrameNotRead[] }> {
  const notRead: FrameNotRead[] = listing.unreadable.map((frame) => ({ frameId: frame.frameId, parentId: frame.parentId, url: frame.url, reason: frame.reason }))
  const sessions = new Map<ICDPSession, Promise<SessionRead>>()
  const sessionRead = (cdp: ICDPSession): Promise<SessionRead> => {
    let reading = sessions.get(cdp)
    if (!reading) {
      reading = Promise.all([
        fetchPageGeometry({ cdp }),
        withDeadline(cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true }), PROBE_TIMEOUT_MS, 'reading the DOM (DOM.getFlattenedDocument)'),
      ]).then(([raw, { nodes }]) => {
        const dom = new Map<number, ModelDomInfo>()
        for (const node of nodes) {
          const attributes: Record<string, string> = {}
          for (let i = 0; i + 1 < (node.attributes?.length ?? 0); i += 2) attributes[node.attributes![i]] = node.attributes![i + 1]
          dom.set(node.backendNodeId, { nodeName: node.nodeName, attributes })
        }
        return { raw, dom, placed: new Map<string, FrameGeometry>() }
      })
      sessions.set(cdp, reading)
    }
    return reading
  }
  for (const entry of listing.frames) void sessionRead(entry.cdp).catch(() => {})

  const placed = new Map<string, Omit<FrameRead, 'model'>>()
  const cache = new Map<string, Map<number, boolean>>()
  for (const entry of listing.frames) {
    if (entry.parentId === null) {
      const session = await sessionRead(entry.cdp)
      const frame = session.raw.get(entry.frameId)
      if (!frame) {
        throw new Error(`The layout snapshot has no document for the main frame ${entry.frameId} (it holds ${[...session.raw.keys()].join(', ') || 'nothing'}).`)
      }
      session.placed.set(entry.frameId, frame)
      placed.set(entry.frameId, { entry, frame, path: [] })
      continue
    }
    const parent = placed.get(entry.parentId)
    if (!parent) {
      notRead.push({ frameId: entry.frameId, parentId: entry.parentId, url: entry.url, reason: 'the iframe around it is not read' })
      continue
    }
    let ownerId: number | undefined
    try {
      const owner = await frames.owner(entry.frameId)
      ownerId = owner.backendNodeId
      const record = parent.frame.byBackendId.get(owner.backendNodeId)
      let parentCache = cache.get(entry.parentId)
      if (!parentCache) cache.set(entry.parentId, (parentCache = new Map()))
      if (!record || !measureLaidOutRecord(record, parent.frame, parentCache).visible) {
        notRead.push({ frameId: entry.frameId, parentId: entry.parentId, url: entry.url, ownerId, reason: 'the iframe is hidden, so nothing in it can be seen or used' })
        continue
      }
      const session = await sessionRead(entry.cdp)
      const raw = session.raw.get(entry.frameId)
      if (!raw) {
        notRead.push({ frameId: entry.frameId, parentId: entry.parentId, url: entry.url, ownerId, reason: 'its document is not laid out yet (still loading)' })
        continue
      }
      const box = await frames.box(entry.frameId)
      const frame = placeFrameGeometry(raw, box, mainScroll, visibleClipRect(record, parent.frame))
      session.placed.set(entry.frameId, frame)
      placed.set(entry.frameId, {
        entry,
        frame,
        owner: { parentId: entry.parentId, key: `${entry.parentId}:${owner.backendNodeId}` as NodeKey, backendNodeId: owner.backendNodeId, record },
        path: [...parent.path, record.nodeIndex],
      })
    } catch (error) {
      const reason = frameReadFailure(entry, error)
      notRead.push({ frameId: entry.frameId, parentId: entry.parentId, url: entry.url, ...(ownerId !== undefined ? { ownerId } : {}), reason })
    }
  }

  const reads = new Map<string, FrameRead>()
  await Promise.all(
    [...placed.values()].map(async (item) => {
      const { entry } = item
      try {
        const session = await sessionRead(entry.cdp)
        const aria = await getAriaSnapshot({ page, ...(entry.parentId === null ? {} : { frame: entry.frame }), cdp: entry.cdp })
        const model = buildPageModelFromRaw({ ariaTree: aria.tree, domByBackendId: session.dom, frameId: entry.frameId, geometry: session.placed, deps: { page, cdp: entry.cdp } })
        reads.set(entry.frameId, { ...item, model })
      } catch (error) {
        if (entry.parentId === null) throw error
        notRead.push({ frameId: entry.frameId, parentId: entry.parentId, url: entry.url, ...(item.owner ? { ownerId: item.owner.backendNodeId } : {}), reason: frameReadFailure(entry, error) })
      }
    }),
  )
  // A frame whose parent could not be read has no place in the page to be shown at.
  for (const [frameId, read] of reads) {
    if (!read.owner || reads.has(read.owner.parentId)) continue
    reads.delete(frameId)
    notRead.push({ frameId, parentId: read.owner.parentId, url: read.entry.url, reason: 'the iframe around it is not read' })
  }
  return { reads, notRead }
}

/**
 * Why an iframe could not be read, for the model. The frame going away while it was read is the
 * one expected cause; a model-facing refusal (a rotated iframe) keeps its words; anything else is
 * not the frame's fault and propagates.
 */
function frameReadFailure(entry: FrameEntry, error: unknown): string {
  if (entry.frame.isDetached() || isNodeGoneError(error)) return 'it was removed from the page while being read'
  if (error instanceof ModelFacingError) return error.message
  const message = error instanceof Error ? error.message : String(error)
  if (/Frame with the given frameId is not found|No frame for given id found|Execution context was destroyed|Cannot find context with specified id/i.test(message)) {
    return 'it loaded a new document while being read'
  }
  throw error
}

/**
 * Occlusion across frame boundaries. A frame paints as part of its `<iframe>` element, so what in
 * an ancestor document paints over that element (by the ancestor's paint order) paints over
 * everything inside the frame; per-document paint orders are not comparable with each other
 * (measured: each document numbers its own). The cover is added to what covers the item inside
 * its own document, ancestors' layers first (they are on top), and the covered share is the exact
 * union of all of them.
 */
function occludeAcrossFrames(read: FrameRead, reads: Map<string, FrameRead>, items: Array<{ measured: Measured }>): void {
  if (!read.owner) return
  const targets = items.filter((item) => item.measured.box && item.measured.visible)
  if (targets.length === 0) return
  const cuts = targets.map(() => [] as Array<{ key: NodeKey; label: string; box: Box }>)
  for (let level: FrameRead | undefined = read; level?.owner; level = reads.get(level.owner.parentId)) {
    const parent = reads.get(level.owner.parentId)
    if (!parent) break
    const owner = level.owner.record
    // The item, standing in the parent document as the <iframe> it is drawn in.
    const stand = targets.map((item, index) => ({ ...owner, backendNodeId: -1 - index, box: item.measured.box! }))
    const result = computeFrameOcclusion({ frame: parent.frame, targets: stand })
    stand.forEach((target, index) => {
      const covered = result.get(target.backendNodeId)
      if (!covered) return
      covered.by.forEach((key, k) => {
        const record = parent.frame.byBackendId.get(splitKey(key).backendNodeId)
        if (record) cuts[index].push({ key, label: covered.labels[k], box: record.box })
      })
    })
  }
  targets.forEach((item, index) => {
    if (cuts[index].length === 0) return
    const measured = item.measured
    const own = (measured.occludedBy ?? []).flatMap((key, k) => {
      const record = read.frame.byBackendId.get(splitKey(key).backendNodeId)
      return record ? [{ key, label: measured.occludedByLabels?.[k] ?? record.label, box: record.box }] : []
    })
    const all = [...cuts[index], ...own]
    const fraction = coveredFraction(measured.box!, all.map((cut) => cut.box))
    if (fraction <= 0) return
    measured.occluded = fraction >= 1 ? 'full' : 'partial'
    measured.occludedFraction = fraction
    measured.occludedBy = all.map((cut) => cut.key)
    measured.occludedByLabels = all.map((cut) => cut.label)
  })
}

/**
 * Observe the page and every iframe in it. Read-only: CDP Accessibility/DOM/DOMSnapshot/Page reads
 * (on the session that owns each frame) plus isolated-world reads in each frame (image load state,
 * field text security, scroll offsets, what shows a hidden control).
 *
 * An iframe is listed as an element of its parent (`[7] iframe "Secure card payment" — 4 controls`)
 * with its content after it, in page order: its controls get refs like any other, their boxes are
 * in main-document coordinates, and what in the parent covers the iframe covers them. An iframe
 * whose content cannot be read says why on its line (hidden, still loading, removed meanwhile).
 *
 * While a native JS dialog is open the renderer answers none of those, so nothing is
 * probed: the observation carries the dialog and nothing else — no title, viewport or scroll,
 * which cannot be read — and refs are left as they were (the page cannot have changed while
 * frozen).
 *
 * The documents are read before and after the page model is built; when a navigation committed in
 * between, the model mixes two documents and is built again.
 *
 * `options.options` (scope/all/maxChars) shapes the RENDERING only: an observation
 * always holds every element and text block, because the next diff and `find` need
 * the whole page, so pass the same options on to `renderObservation`.
 */
export async function observePage(options: ObservePageOptions): Promise<Observation> {
  const { page, frames, registry, targetId } = options
  const cdp = frames.cdp
  const world = frames.main.world
  const busy = options.busy ?? []

  if (isDialogOpen(options.jsDialog)) {
    // The last document observed is the one the dialog belongs to: a frozen page cannot
    // navigate, and a beforeunload dialog is raised by the document being left.
    const documentId = registry.documentId(targetId) ?? options.previous?.documentId
    return {
      takenAt: Date.now(),
      url: page.url(),
      targetId,
      ...(documentId !== undefined ? { documentId } : {}),
      scrollers: [],
      busy,
      jsDialog: options.jsDialog,
      live: [],
      elements: [],
      text: [],
      absent: [],
      counts: { interactive: 0, inView: 0, above: 0, below: 0 },
      ...(options.tabs ? { tabs: options.tabs } : {}),
      frames: { total: page.frames().length, observed: 0 },
    }
  }

  type PageRead = {
    listing: { frames: FrameEntry[]; unreadable: UnreadableFrame[] }
    metrics: Protocol.Page.GetLayoutMetricsResponse
    title: string
    reads: Map<string, FrameRead>
    notRead: FrameNotRead[]
  }
  let read: PageRead | undefined
  for (let attempt = 1; !read; attempt++) {
    const [listing, metrics, title] = await Promise.all([
      frames.list(),
      withDeadline(cdp.send('Page.getLayoutMetrics'), PROBE_TIMEOUT_MS, 'reading the layout metrics (Page.getLayoutMetrics)'),
      // In the isolated world: Playwright's page.title() would run in the page as a user gesture and give it user activation.
      frames.main.world.evaluate<string>('document.title', { timeoutMs: PROBE_TIMEOUT_MS, what: 'reading the document title' }),
    ])
    const mainEntry = listing.frames[0]
    if (!mainEntry || mainEntry.parentId !== null) {
      const problem = listing.unreadable.find((frame) => frame.parentId === null)
      throw new ModelFacingError(`The page cannot be read: ${problem?.reason ?? 'its main frame is not attached'}.`)
    }
    const { reads, notRead } = await withDeadline(
      readFrames({ page, frames, listing, mainScroll: { x: metrics.cssLayoutViewport.pageX, y: metrics.cssLayoutViewport.pageY } }),
      MODEL_TIMEOUT_MS,
      'reading the page and its iframes (Accessibility.getFullAXTree + DOMSnapshot.captureSnapshot per frame)',
    )
    const after = await frames.list()
    const afterMain = after.frames[0]
    if (afterMain && afterMain.parentId === null && afterMain.loaderId === mainEntry.loaderId) {
      // An iframe that loaded another document meanwhile was read half in each: read the page
      // again; on the last attempt that frame alone is reported unread.
      const now = new Map(after.frames.map((frame) => [frame.frameId, frame.loaderId]))
      const moved = [...reads.values()].filter((frameRead) => now.get(frameRead.entry.frameId) !== frameRead.entry.loaderId)
      if (moved.length === 0 || attempt === MAX_OBSERVE_ATTEMPTS) {
        for (const frameRead of moved) {
          if (frameRead.entry.parentId === null) continue
          reads.delete(frameRead.entry.frameId)
          notRead.push({
            frameId: frameRead.entry.frameId,
            parentId: frameRead.entry.parentId,
            url: frameRead.entry.url,
            ...(frameRead.owner ? { ownerId: frameRead.owner.backendNodeId } : {}),
            reason: 'it keeps loading new documents (observe() again once it settles)',
          })
        }
        read = { listing, metrics, title, reads, notRead }
      }
    } else if (attempt === MAX_OBSERVE_ATTEMPTS) {
      throw new ModelFacingError(
        `The page loaded a new document while it was being read, ${MAX_OBSERVE_ATTEMPTS} times in a row (now ${page.url()}): ` +
          'it is still navigating (a redirect chain or a reload loop). Call act.waitForIdle(), then observe() again.',
      )
    }
  }
  const { listing, metrics, title, reads, notRead } = read
  const mainRead = reads.get(listing.frames[0].frameId)!
  const mainFrameId = mainRead.entry.frameId
  const documentId = mainRead.entry.loaderId
  const url = mainRead.entry.url
  const mainFrame = mainRead.frame

  const layoutViewport = metrics.cssLayoutViewport
  const viewportHeight = layoutViewport.clientHeight
  const scrollY = layoutViewport.pageY
  const maxY = Math.max(0, metrics.cssContentSize.height - viewportHeight)
  const screens = (px: number, per: number): number => (per > 0 ? Math.round((px / per) * 10) / 10 : 0)
  const viewport = mainFrame.viewport

  // ---- per frame: what it lists ------------------------------------------------------
  const candidates: Candidate[] = []
  const texts: TextCandidate[] = []
  const liveRegions: LiveRegionCandidate[] = []
  const nodeIndexes = new Map<string, Map<number, number>>()
  let modalDialog: PageModelNode | undefined
  for (const frameRead of reads.values()) {
    const collected = collectCandidates({ model: frameRead.model, frame: frameRead.frame, viewport: frameRead.frame.viewport })
    nodeIndexes.set(frameRead.entry.frameId, collected.nodeIndexByBackendId)
    // A modal dialog inside an iframe blocks that iframe's document, not the page around it.
    if (frameRead === mainRead && collected.modalDialog) modalDialog = collected.modalDialog
    await addLabelOperatedControls({ world: frameRead.entry.world, model: frameRead.model, frame: frameRead.frame, candidates: collected.elements })
    await maskSecretValues(frameRead.entry.world, collected.elements)
    await markOpenColourChoosers(frameRead.entry.world, collected.elements)
    occludeAcrossFrames(frameRead, reads, [...collected.elements, ...collected.texts])
    candidates.push(...collected.elements)
    texts.push(...collected.texts)
    liveRegions.push(...collected.liveRegions)
  }

  // ---- iframes: each listed in its parent, with its content after it -------------------
  const frameCandidates = new Map<string, Candidate>()
  const childFrames = [
    ...[...reads.values()].flatMap((frameRead) => (frameRead.owner ? [{ frameId: frameRead.entry.frameId, parentId: frameRead.owner.parentId, ownerId: frameRead.owner.backendNodeId, url: frameRead.entry.url, read: frameRead }] : [])),
    ...notRead.flatMap((frame) => (frame.parentId !== null && frame.ownerId !== undefined ? [{ frameId: frame.frameId, parentId: frame.parentId, ownerId: frame.ownerId, url: frame.url, unread: frame.reason }] : [])),
  ]
  for (const child of childFrames) {
    const parent = reads.get(child.parentId)
    if (!parent) continue
    const key = `${child.parentId}:${child.ownerId}` as NodeKey
    const node = parent.model.byKey.get(key)
    const record = parent.frame.byBackendId.get(child.ownerId)
    const nodeIndex = record?.nodeIndex ?? parent.frame.nodeBackendIds?.indexOf(child.ownerId) ?? -1
    // Not in the parent's node table: the <iframe> was removed after the snapshot.
    if (nodeIndex < 0) continue
    let measured: Measured
    if (node) measured = measuredFromRuntime(node)
    else if (record) {
      const covered = computeFrameOcclusion({ frame: parent.frame, targets: [record] }).get(record.backendNodeId)
      measured = {
        ...measureLaidOutRecord(record, parent.frame, new Map()),
        box: { ...record.box },
        ...(covered ? { occluded: covered.state, occludedFraction: covered.coveredFraction, occludedBy: covered.by, occludedByLabels: covered.labels } : {}),
      }
    } else measured = { visible: false }
    if (record) occludeAcrossFrames(parent, reads, [{ measured }])
    const attributes = record?.attributes ?? node?.attributes ?? {}
    // What a person calls the iframe: its accessible name (from title or aria-label), else its address.
    const name = (node ? modelName(node) : '') || attributes['aria-label'] || attributes.title || child.url
    const existing = candidates.find((candidate) => candidate.key === key)
    const candidate: Candidate = existing ?? {
      key,
      frameId: child.parentId,
      backendNodeId: child.ownerId,
      role: 'iframe',
      name: '',
      tag: (record?.nodeName ?? 'iframe').toLowerCase(),
      order: nodeIndex,
      nodeIndex,
      measured,
      ...(node ? { anchor: node } : {}),
      anchorIsSelf: node !== undefined,
      contextBasis: {},
    }
    candidate.role = 'iframe'
    candidate.name = name.replace(/\s+/g, ' ').trim()
    candidate.frame = { frameId: child.frameId, url: child.url, ...('unread' in child ? { unread: child.unread } : { documentId: child.read.entry.loaderId }) }
    if (!existing) candidates.push(candidate)
    frameCandidates.set(child.frameId, candidate)
  }

  // ---- one order for the whole page: each iframe's content right after the iframe --------
  const pathOf = (frameId: string): number[] => reads.get(frameId)?.path ?? []
  const ordered = [
    ...candidates.map((item) => ({ item, path: [...pathOf(item.frameId), item.order] })),
    ...texts.map((item) => ({ item, path: [...pathOf(item.frameId), item.order] })),
  ].sort((a, b) => comparePaths(a.path, b.path))
  ordered.forEach(({ item }, index) => {
    item.order = index
  })
  candidates.sort((a, b) => a.order - b.order)
  texts.sort((a, b) => a.order - b.order)

  // A fully transparent control counts as visible only when something is drawn where it sits.
  const undrawn = await undrawnTransparentControls(cdp, world, candidates)
  for (const candidate of candidates) if (undrawn.has(candidate.key)) delete candidate.measured.transparent

  // ---- visibility, modal, region, context ------------------------------------------
  const visibilityOf = new Map<NodeKey, Visibility>()
  for (const candidate of candidates) visibilityOf.set(candidate.key, classifyVisibility(candidate.measured, viewport))
  const nodeOf = (key: NodeKey): PageModelNode | undefined => reads.get(splitKey(key).frameId)?.model.byKey.get(key)
  const recordOf = (key: NodeKey): SnapshotNodeGeometry | undefined => {
    const { frameId, backendNodeId } = splitKey(key)
    return reads.get(frameId)?.frame.byBackendId.get(backendNodeId)
  }

  /** Model keys of the node's ancestors, nearest first, through the `<iframe>` into the parent document. */
  const ancestorsOf = (frameId: string, nodeIndex: number | undefined, anchor: PageModelNode | undefined, self: boolean): NodeKey[] => {
    const frameRead = reads.get(frameId)
    if (!frameRead) return []
    const result: NodeKey[] = []
    const { frame, model } = frameRead
    if (nodeIndex !== undefined && frame.nodeBackendIds) {
      let current = frame.parentIndex[nodeIndex] ?? -1
      while (current >= 0) {
        result.push(`${frameId}:${frame.nodeBackendIds[current]}` as NodeKey)
        current = frame.parentIndex[current] ?? -1
      }
    } else {
      let key: NodeKey | undefined = anchor ? (self ? model.parentByKey.get(anchor.key) : anchor.key) : undefined
      while (key) {
        if (model.byKey.has(key)) result.push(key)
        key = model.parentByKey.get(key)
      }
    }
    if (frameRead.owner) result.push(frameRead.owner.key, ...ancestorsOf(frameRead.owner.parentId, frameRead.owner.record.nodeIndex, undefined, true))
    return result
  }

  // Modal: an open AX modal dialog, else a backdrop covering most of what is in view.
  let modal: { key?: NodeKey; backendNodeId?: number; role: string; name: string; contains: (ancestors: NodeKey[], key: NodeKey) => boolean } | undefined
  if (modalDialog) {
    const dialogKey = modalDialog.key
    modal = {
      key: dialogKey,
      backendNodeId: modalDialog.backendNodeId,
      role: modalDialog.role ?? 'dialog',
      // An unnamed dialog is still named by what it says: "Send me an email reminder…".
      name: modelName(modalDialog) || gatherText(modalDialog, CONTEXT_MAX_CHARS),
      contains: (ancestors) => ancestors.includes(dialogKey),
    }
  } else if (viewport) {
    const inView = candidates.filter((c) => {
      const v = visibilityOf.get(c.key)
      return v === 'in-view' || v === 'partly-covered' || v === 'covered'
    })
    const covered = inView.filter((c) => {
      const v = visibilityOf.get(c.key)
      return v === 'covered' || v === 'partly-covered'
    })
    if (inView.length >= 3 && covered.length / inView.length >= BACKDROP_COVERED_SHARE) {
      const tally = new Map<NodeKey, { count: number; label: string }>()
      for (const c of covered) {
        const top = c.measured.occludedBy?.[0]
        if (!top) continue
        const entry = tally.get(top) ?? { count: 0, label: c.measured.occludedByLabels?.[0] ?? top }
        entry.count++
        tally.set(top, entry)
      }
      let best: [NodeKey, { count: number; label: string }] | undefined
      for (const entry of tally) if (!best || entry[1].count > best[1].count) best = entry
      const coverRecord = best ? recordOf(best[0]) : undefined
      if (best && coverRecord && coverRecord.box.width * coverRecord.box.height >= BACKDROP_VIEWPORT_SHARE * viewport.width * viewport.height) {
        const coverKey = best[0]
        const coverNode = nodeOf(coverKey)
        const coverFrame = [...frameCandidates.values()].find((candidate) => candidate.key === coverKey)
        modal = {
          role: coverFrame ? 'iframe' : 'overlay',
          name: coverFrame ? coverFrame.name : coverNode?.role && modelName(coverNode) ? `${coverNode.role} "${modelName(coverNode)}"` : best[1].label,
          // A backdrop has no subtree of its own; what it leaves usable is what is in
          // view and not covered by it.
          contains: (_ancestors, key) => {
            const v = visibilityOf.get(key)
            const candidate = candidates.find((c) => c.key === key)
            return (v === 'in-view' || v === 'partly-covered') && !(candidate?.measured.occludedBy ?? []).includes(coverKey)
          },
        }
      }
    }
  }

  const regionCache = new Map<NodeKey, string | undefined>()
  /** The nearest landmark around the node within its own document. */
  const regionOf = (node: PageModelNode | undefined): string | undefined => {
    if (!node) return undefined
    if (regionCache.has(node.key)) return regionCache.get(node.key)
    const model = reads.get(node.frameId)?.model
    if (!model) return undefined
    const chain: NodeKey[] = []
    let key: NodeKey | undefined = node.key
    let found: string | undefined
    while (key) {
      if (regionCache.has(key)) {
        found = regionCache.get(key)
        break
      }
      chain.push(key)
      const current = model.byKey.get(key)
      const kind = current?.role ? LANDMARK_ROLES[current.role] : undefined
      if (current && kind) {
        const name = modelName(current)
        if (kind === 'always' || name) {
          found = name ? `${current.role} "${truncate(name, CONTEXT_MAX_CHARS)}"` : current.role
          break
        }
      }
      key = model.parentByKey.get(key)
    }
    for (const k of chain) regionCache.set(k, found)
    return found
  }

  assignContexts({
    candidates,
    texts,
    models: new Map([...reads].map(([frameId, frameRead]) => [frameId, frameRead.model])),
    iframeNames: new Map([...frameCandidates].map(([frameId, candidate]) => [frameId, candidate.name])),
  })

  // ---- scroll areas ------------------------------------------------------------------
  const scrollAreas: ScrollArea[] = []
  for (const frameRead of reads.values()) scrollAreas.push(...(await findScrollAreas({ world: frameRead.entry.world, frame: frameRead.frame, model: frameRead.model })))

  // ---- refs --------------------------------------------------------------------------
  const observation = registry.begin(targetId, documentId)
  const documentShown = registry.documentShown(targetId, documentId)
  const frameDocumentOf = (frameId: string): string => reads.get(frameId)!.entry.loaderId
  const refByKey = new Map<NodeKey, number>()
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))
  for (const candidate of candidates) {
    const ref = observation.assign({
      nodeKey: candidate.key,
      frameId: candidate.frameId,
      frameDocumentId: frameDocumentOf(candidate.frameId),
      backendNodeId: candidate.backendNodeId,
      role: candidate.role,
      name: candidate.name,
      ...(candidate.context ? { context: candidate.context } : {}),
      ...(candidate.viaLabel ? { viaLabel: true as const } : {}),
    })
    refByKey.set(candidate.key, ref)
  }
  let modalRef: number | undefined
  if (modalDialog) {
    modalRef = observation.assign({
      nodeKey: modalDialog.key,
      frameId: mainFrameId,
      frameDocumentId: documentId,
      backendNodeId: modalDialog.backendNodeId,
      role: modalDialog.role ?? 'dialog',
      name: modelName(modalDialog),
    })
    refByKey.set(modalDialog.key, modalRef)
  }
  const scrollers: ObservedScroller[] = scrollAreas.map((area) => {
    // A scroll area that is also a listed control (a listbox, a textarea) keeps that control's binding.
    const listed = candidateByKey.get(area.key)
    const role = listed?.role ?? area.role
    const name = listed?.name ?? area.name
    const ref =
      refByKey.get(area.key) ??
      observation.assign({ nodeKey: area.key, frameId: area.frameId, frameDocumentId: frameDocumentOf(area.frameId), backendNodeId: area.backendNodeId, role, name })
    refByKey.set(area.key, ref)
    return {
      ref,
      key: area.key,
      backendNodeId: area.backendNodeId,
      role,
      name,
      vertical: area.vertical,
      horizontal: area.horizontal,
      scrollTop: area.scrollTop,
      scrolledFromTop: area.top,
      scrollHeight: area.height,
      clientHeight: area.client,
      screensAbove: screens(area.top, area.client),
      screensBelow: screens(Math.max(0, area.height - area.client - area.top), area.client),
      scrollLeft: area.scrollLeft,
      scrolledFromLeft: area.left,
      scrollWidth: area.width,
      clientWidth: area.clientWidth,
      screensLeft: screens(area.left, area.clientWidth),
      screensRight: screens(Math.max(0, area.width - area.clientWidth - area.left), area.clientWidth),
      visibility: classifyVisibility(area.measured, viewport),
      ...(area.measured.box ? { box: area.measured.box } : {}),
    }
  })
  const areaByKey = new Map(scrollAreas.map((area) => [area.key, area]))
  /**
   * The scroll area that scrolls an item with `visibility` into view: for one above or below, the
   * nearest that scrolls vertically; off to the left or right, the nearest that scrolls sideways;
   * otherwise the nearest of any kind. A carousel around an item below the screen is not what
   * brings it up.
   */
  const scrollerOf = (ancestors: NodeKey[], visibility: Visibility): number | undefined => {
    const scrolls = (area: ScrollArea): boolean =>
      visibility === 'above' || visibility === 'below' ? area.vertical : visibility === 'left' || visibility === 'right' ? area.horizontal : true
    const key = ancestors.find((ancestor) => {
      const area = areaByKey.get(ancestor)
      return area !== undefined && scrolls(area)
    })
    return key === undefined ? undefined : refByKey.get(key)
  }

  // ---- elements ----------------------------------------------------------------------
  const textOf = (frameId: string, backendNodeId: number): string => {
    const frameRead = reads.get(frameId)
    if (!frameRead) return ''
    const node = frameRead.model.byKey.get(`${frameId}:${backendNodeId}` as NodeKey)
    const fromModel = node ? gatherText(node, Number.POSITIVE_INFINITY) || modelName(node) : ''
    if (fromModel) return fromModel
    const nodeIndex = nodeIndexes.get(frameId)?.get(backendNodeId)
    return nodeIndex === undefined ? '' : nodeVisibleText(frameRead.frame, nodeIndex, Number.POSITIVE_INFINITY)
  }
  /** What covers an element, as the model reads it: a listed iframe by its line, else the cover's role and name, else its tag. */
  const coverLabel = (key: NodeKey, fallback: string | undefined): string | undefined => {
    const frameCover = candidateByKey.get(key)
    if (frameCover?.frame) return `iframe ${quote(frameCover.name, CONTEXT_MAX_CHARS)} [${refByKey.get(key)}]`
    const coverNode = nodeOf(key)
    const coverName = coverNode ? modelName(coverNode) : ''
    return coverNode?.role && coverName ? `${coverNode.role} "${truncate(coverName, CONTEXT_MAX_CHARS)}"` : fallback
  }
  const elements: ObservedElement[] = candidates.map((candidate) => {
    const visibility = visibilityOf.get(candidate.key) ?? 'unknown'
    const ancestors = ancestorsOf(candidate.frameId, candidate.nodeIndex, candidate.anchor, candidate.anchorIsSelf)
    const inside = ancestors.map((key) => refByKey.get(key)).filter((ref): ref is number => ref !== undefined)
    let coveredBy: string | undefined
    if ((visibility === 'covered' || visibility === 'partly-covered') && candidate.measured.occludedBy?.length) {
      coveredBy = coverLabel(candidate.measured.occludedBy[0], candidate.measured.occludedByLabels?.[0])
    }
    const errorText = candidate.states?.errorMessage?.map((id) => textOf(candidate.frameId, id)).filter(Boolean).join(' ')
    const activeRef = candidate.states?.activeDescendant !== undefined ? refByKey.get(`${candidate.frameId}:${candidate.states.activeDescendant}` as NodeKey) : undefined
    const ref = refByKey.get(candidate.key)!
    const scroller = scrollerOf(ancestors, visibility)
    const region = regionOf(candidate.anchor)
    return {
      ref,
      key: candidate.key,
      backendNodeId: candidate.backendNodeId,
      frameId: candidate.frameId,
      role: candidate.role,
      name: candidate.name,
      tag: candidate.tag,
      ...(candidate.states ? { states: candidate.states } : {}),
      ...(candidate.value !== undefined ? { value: candidate.value } : {}),
      ...(candidate.href !== undefined ? { href: candidate.href } : {}),
      ...(region ? { region } : {}),
      ...(candidate.context ? { context: candidate.context } : {}),
      contextBasis: candidate.contextBasis,
      visibility,
      ...(coveredBy ? { coveredBy } : {}),
      ...(coveredBy && candidate.measured.occludedFraction !== undefined ? { coveredFraction: candidate.measured.occludedFraction } : {}),
      ...(candidate.measured.box ? { box: candidate.measured.box } : {}),
      ...(candidate.measured.transparent ? { transparent: true as const } : {}),
      ...(candidate.viaLabel ? { viaLabel: true as const } : {}),
      ...(candidate.options ? { options: candidate.options } : {}),
      ...(candidate.widget ? { widget: candidate.widget } : {}),
      ...(candidate.frame ? { frame: { ...candidate.frame, controls: 0 } } : {}),
      ...(errorText ? { errorText } : {}),
      ...(activeRef !== undefined ? { activeRef } : {}),
      ...(documentShown && !registry.wasShown(targetId, documentId, candidate.key) ? { isNew: true } : {}),
      ...(candidate.cssLabel ? { cssLabel: candidate.cssLabel } : {}),
      ...(scroller !== undefined && scroller !== ref ? { scroller } : {}),
      ...(inside.length ? { inside } : {}),
      ...(modal && modal.contains(ancestors, candidate.key) ? { inModal: true as const } : {}),
      order: candidate.order,
    }
  })
  for (const element of elements) {
    if (element.frame) element.frame.controls = elements.filter((other) => !other.frame && other.inside?.includes(element.ref)).length
  }

  // ---- images (each frame's isolated world, read-only) --------------------------------
  const imageTargets = elements.filter(
    (e) => IMAGE_ROLES[e.role] && e.tag === 'img' && (e.visibility === 'in-view' || e.visibility === 'partly-covered' || e.visibility === 'covered'),
  )
  for (const frameRead of reads.values()) {
    const inFrame = imageTargets.filter((element) => element.frameId === frameRead.entry.frameId)
    if (inFrame.length === 0) continue
    const states = await frameRead.entry.world.callFunctionOnNodes<Array<{ complete: boolean; naturalWidth: number; naturalHeight: number; src: string } | null>>(
      inFrame.map((e) => e.backendNodeId),
      `function (args, ...images) {
        return images.map(function (img) {
          if (!img || typeof img.complete !== 'boolean') return null
          return { complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, src: img.currentSrc || img.src || '' }
        })
      }`,
      { timeoutMs: PROBE_TIMEOUT_MS, what: 'reading image load state (complete/naturalWidth) in the isolated world' },
    )
    inFrame.forEach((element, index) => {
      const state = states[index]
      if (!state) return
      const src = state.src.startsWith('data:') ? `${state.src.slice(0, state.src.indexOf(',') + 1)}…` : truncate(state.src, 120)
      element.image = {
        loaded: state.complete && state.naturalWidth > 0,
        broken: state.complete && state.naturalWidth === 0,
        naturalWidth: state.naturalWidth,
        naturalHeight: state.naturalHeight,
        ...(src ? { src } : {}),
      }
    })
  }

  // ---- text blocks and live regions --------------------------------------------------
  const clickableFullyNamed = new Set<NodeKey>()
  for (const candidate of candidates) if (candidate.fullyNamed) clickableFullyNamed.add(candidate.key)
  const liveByKey = new Map(liveRegions.map((region) => [region.key, region]))
  const liveTexts = new Map<NodeKey, string[]>()
  const text: TextBlock[] = []
  for (const block of texts) {
    const ancestors = ancestorsOf(block.frameId, block.nodeIndex, block.anchor, true)
    if (ancestors.some((key) => clickableFullyNamed.has(key))) continue
    const inside = ancestors.map((key) => refByKey.get(key)).filter((ref): ref is number => ref !== undefined)
    const region = regionOf(block.anchor)
    const liveKey = [block.anchor.key, ...ancestors].find((key) => liveByKey.has(key))
    const liveRegion = liveKey !== undefined ? liveByKey.get(liveKey) : undefined
    if (liveKey !== undefined) liveTexts.set(liveKey, [...(liveTexts.get(liveKey) ?? []), block.text])
    const visibility = classifyVisibility(block.measured, viewport)
    const scroller = scrollerOf(ancestors, visibility)
    text.push({
      key: block.key,
      frameId: block.frameId,
      role: block.role,
      text: block.text,
      ...(block.level !== undefined ? { level: block.level } : {}),
      ...(region ? { region } : {}),
      visibility,
      ...(documentShown && !registry.wasShown(targetId, documentId, `${block.key}\u0000${block.text}`) ? { isNew: true } : {}),
      ...(inside.length ? { inside } : {}),
      ...(modal && modal.contains(ancestors, block.key) ? { inModal: true as const } : {}),
      ...(liveRegion ? { live: `${liveRegion.role}${liveRegion.name ? ` "${truncate(liveRegion.name, CONTEXT_MAX_CHARS)}"` : ''}` } : {}),
      ...(scroller !== undefined ? { scroller } : {}),
      order: block.order,
      ...(block.measured.box ? { box: block.measured.box } : {}),
    })
  }
  const live: LiveRegion[] = liveRegions.map((region) => {
    const blocks = liveTexts.get(region.key) ?? []
    return { key: region.key, role: region.role, name: region.name, text: blocks.join(' '), latest: blocks.at(-1) ?? '' }
  })

  // ---- what vanished: gone, hidden or inert ------------------------------------------
  // Only items of a document read now can be classified; an iframe that loaded another document
  // took its old nodes with it (its backend ids can be reused by the new one).
  const vanished: Vanished[] = observation
    .unseen()
    .filter((target) => reads.get(target.frameId)?.entry.loaderId === target.frameDocumentId)
    .map((target) => ({ key: target.nodeKey, backendNodeId: target.backendNodeId, ref: target.ref }))
  const previous = options.previous && options.previous.targetId === targetId && options.previous.documentId === documentId ? options.previous : null
  if (previous) {
    const listedTexts = new Set(text.map((block) => block.key))
    const previousDocuments = new Map(previous.elements.flatMap((element) => (element.frame?.documentId ? [[element.frame.frameId, element.frame.documentId] as const] : [])))
    for (const block of previous.text) {
      if (listedTexts.has(block.key)) continue
      const frameRead = reads.get(block.frameId)
      const sameDocument = block.frameId === mainFrameId || previousDocuments.get(block.frameId) === frameRead?.entry.loaderId
      if (frameRead && sameDocument) vanished.push({ key: block.key, backendNodeId: splitKey(block.key).backendNodeId })
    }
  }
  const modalLabel = modal ? `${modal.role}${modal.name ? ` "${truncate(modal.name, CONTEXT_MAX_CHARS)}"` : ''}${modalRef !== undefined ? ` [${modalRef}]` : ''}` : undefined
  const elementByRef = new Map(elements.map((element) => [element.ref, element]))
  const absent: AbsentItem[] = []
  for (const frameRead of reads.values()) {
    const frameId = frameRead.entry.frameId
    const inFrame = vanished.filter((item) => splitKey(item.key).frameId === frameId)
    if (inFrame.length === 0) continue
    const refByBackendId = new Map(
      [...refByKey].flatMap(([key, ref]) => {
        const split = splitKey(key)
        return split.frameId === frameId ? [[split.backendNodeId, ref] as const] : []
      }),
    )
    absent.push(
      ...(await classifyVanished({ cdp: frameRead.entry.cdp, world: frameRead.entry.world, frame: frameRead.frame, vanished: inFrame, refByBackendId, elementByRef, modalLabel })),
    )
  }
  observation.commit({
    absent: new Map(absent.flatMap((item) => (item.ref !== undefined ? [[item.ref, { reason: item.reason, why: item.why }] as const] : []))),
    shown: options.shown,
    frameDocuments: new Map(listing.frames.map((frame) => [frame.frameId, frame.loaderId])),
    textKeys: text.map((block) => `${block.key}\u0000${block.text}`),
  })

  const focusedElement = elements.find((e) => e.states?.focused && !e.frame)
  const counts = { interactive: 0, inView: 0, above: 0, below: 0 }
  for (const element of elements) {
    if (element.frame) continue
    counts.interactive++
    if (element.visibility === 'in-view' || element.visibility === 'partly-covered' || element.visibility === 'covered') counts.inView++
    else if (element.visibility === 'above') counts.above++
    else if (element.visibility === 'below') counts.below++
  }

  return {
    takenAt: Date.now(),
    url,
    targetId,
    title,
    documentId,
    viewport: { width: layoutViewport.clientWidth, height: viewportHeight },
    scroll: { y: scrollY, maxY, screensAbove: screens(scrollY, viewportHeight), screensBelow: screens(Math.max(0, maxY - scrollY), viewportHeight) },
    scrollers,
    ...(focusedElement ? { focused: focusedElement.ref } : {}),
    ...(modal ? { modal: { ...(modalRef !== undefined ? { ref: modalRef } : {}), role: modal.role, name: modal.name } } : {}),
    busy,
    jsDialog: options.jsDialog ?? null,
    live,
    elements,
    text,
    absent,
    counts,
    ...(options.tabs ? { tabs: options.tabs } : {}),
    frames: { total: listing.frames.length + listing.unreadable.length, observed: reads.size },
  }
}

/**
 * A field that holds a secret shows its value as `••••`: `type=password`, a secret `autocomplete`
 * token (one-time code, card security code…), or bullets drawn by `-webkit-text-security` — the
 * CVV/PIN pattern on `type=tel`/`text` fields — read from the computed style in the isolated world.
 * A value whose element cannot be checked (no DOM attributes, or gone) is masked too.
 */
async function maskSecretValues(world: IsolatedWorld, candidates: Candidate[]): Promise<void> {
  const toCheck: Candidate[] = []
  for (const candidate of candidates) {
    if (candidate.value === undefined || candidate.value === '••••') continue
    const attributes = candidate.anchorIsSelf ? candidate.anchor?.attributes : undefined
    if (!attributes || isSecretField(candidate.tag, attributes.type, attributes.autocomplete)) candidate.value = '••••'
    else toCheck.push(candidate)
  }
  if (toCheck.length === 0) return
  const security = await world.callFunctionOnNodes<Array<string | null>>(
    toCheck.map((candidate) => candidate.backendNodeId),
    TEXT_SECURITY_FN,
    { timeoutMs: PROBE_TIMEOUT_MS, what: 'reading whether fields draw their text as bullets (-webkit-text-security)' },
  )
  toCheck.forEach((candidate, index) => {
    if (security[index] !== 'none') candidate.value = '••••'
  })
}

/** `fn(args, ...inputs)`: whether each colour input's chooser is open (`:open`, set by Chrome exactly while it is). */
const CHOOSER_OPEN_FN = `function (_args, ...inputs) {
  return inputs.map((el) => !!el && el.matches(':open'))
}`

/**
 * Mark colour inputs whose chooser is open. The chooser is Chrome's page popup: while it is open,
 * keys go to it instead of the page, and its own controls are not the page's (aria-snapshot.ts
 * leaves them out), so the input's line is where a person's view of it goes.
 */
async function markOpenColourChoosers(world: IsolatedWorld, candidates: Candidate[]): Promise<void> {
  const colours = candidates.filter((candidate) => candidate.widget?.type === 'color')
  if (colours.length === 0) return
  const open = await world.callFunctionOnNodes<boolean[]>(
    colours.map((candidate) => candidate.backendNodeId),
    CHOOSER_OPEN_FN,
    { timeoutMs: PROBE_TIMEOUT_MS, what: "reading whether a colour input's chooser is open" },
  )
  colours.forEach((candidate, index) => {
    if (open[index] && candidate.widget) candidate.widget = { ...candidate.widget, chooserOpen: true }
  })
}

/** An element whose own content scrolls vertically, horizontally or both, with its scroll state. */
interface ScrollArea {
  key: NodeKey
  frameId: string
  backendNodeId: number
  role: string
  name: string
  measured: Measured
  vertical: boolean
  horizontal: boolean
  /** Scrolled this far from its top edge (see SCROLL_METRICS_FN). */
  top: number
  /** Chrome's own scrollTop. */
  scrollTop: number
  height: number
  client: number
  /** Scrolled this far from its left edge (see SCROLL_METRICS_FN). */
  left: number
  /** Chrome's own scrollLeft. */
  scrollLeft: number
  width: number
  clientWidth: number
}

const SCROLLING_OVERFLOW = /^(auto|scroll|overlay)$/

/**
 * Scroll areas: laid-out, visible elements that scroll on an axis whose computed overflow lets
 * them (`overflow-y`/`overflow-x` auto/scroll/overlay, from the layout snapshot) and whose content
 * is taller or wider than their box on that axis (scrollHeight vs clientHeight, scrollWidth vs
 * clientWidth, read in the isolated world). A horizontal-only one is a carousel or a wide table.
 * The document's own scroller is the page's scroll, not one of these.
 */
async function findScrollAreas({ world, frame, model }: { world: IsolatedWorld; frame: FrameGeometry; model: PageModel }): Promise<ScrollArea[]> {
  const cache = new Map<number, boolean>()
  const records = [...frame.byNodeIndex.values()]
    .filter(
      (record) =>
        record.nodeType === 1 &&
        (SCROLLING_OVERFLOW.test(record.styles['overflow-y'] ?? '') || SCROLLING_OVERFLOW.test(record.styles['overflow-x'] ?? '')) &&
        measureLaidOutRecord(record, frame, cache).visible,
    )
    .sort((a, b) => a.nodeIndex - b.nodeIndex)
  if (records.length === 0) return []
  const metrics = await world.callFunctionOnNodes<
    Array<{ top: number; scrollTop: number; height: number; client: number; left: number; scrollLeft: number; width: number; clientWidth: number } | null>
  >(
    records.map((record) => record.backendNodeId),
    SCROLL_METRICS_FN,
    { timeoutMs: PROBE_TIMEOUT_MS, what: 'reading the scroll state of scrollable areas' },
  )
  const areas: ScrollArea[] = []
  records.forEach((record, index) => {
    const metric = metrics[index]
    if (!metric) return
    const vertical = SCROLLING_OVERFLOW.test(record.styles['overflow-y'] ?? '') && metric.height > metric.client + 1
    const horizontal = SCROLLING_OVERFLOW.test(record.styles['overflow-x'] ?? '') && metric.width > metric.clientWidth + 1
    if (!vertical && !horizontal) return
    const key = `${frame.frameId}:${record.backendNodeId}` as NodeKey
    const node = model.byKey.get(key)
    const role = node?.role && node.role !== 'generic' && node.role !== 'none' ? node.role : 'scroll area'
    const { visible, inViewport } = measureLaidOutRecord(record, frame, cache)
    areas.push({
      key,
      frameId: frame.frameId,
      backendNodeId: record.backendNodeId,
      role,
      name: (node && modelName(node)) || cssLabelOf(record),
      measured: { visible, ...(inViewport !== undefined ? { inViewport } : {}), box: { ...record.box } },
      vertical,
      horizontal,
      top: metric.top,
      scrollTop: metric.scrollTop,
      height: metric.height,
      client: metric.client,
      left: metric.left,
      scrollLeft: metric.scrollLeft,
      width: metric.width,
      clientWidth: metric.clientWidth,
    })
  })
  return areas
}

/**
 * The context of listed element `ref` as observe() computes it, in the same kind as `shown` (the
 * context the model was shown): `in row "…"` → its container now, `under heading "…"` → its
 * heading now, an ordinal → its position among the elements with the same role and name now. With
 * no `shown`, the context observe prints for it now. Undefined when it has none of that kind, or
 * is not listed.
 */
export function liveContext(observation: Observation, ref: number, shown: string | undefined): string | undefined {
  const element = observation.elements.find((candidate) => candidate.ref === ref)
  if (!element) return undefined
  if (shown === undefined) return element.context
  if (shown.startsWith('in ')) return element.contextBasis?.container
  if (shown.startsWith('under heading ')) return element.contextBasis?.heading
  if (shown.startsWith('after ')) return element.contextBasis?.caption
  const same = observation.elements.filter((candidate) => candidate.role === element.role && candidate.name === element.name)
  return same.length > 1 ? `${ordinal(same.indexOf(element) + 1)} of ${same.length}` : undefined
}

// ---------------------------------------------------------------------------
// Collection (pure over the PageModel)
// ---------------------------------------------------------------------------

/** A live region found while collecting: an AX live role, or an element with `aria-live` that is not `off`. */
interface LiveRegionCandidate {
  key: NodeKey
  backendNodeId: number
  role: string
  name: string
}

/**
 * Walk the PageModel once and collect: interactive AX elements and images, text blocks (whole —
 * renderers cut them), live regions and the topmost open modal dialog; then add the non-semantic
 * click targets and `aria-live` containers from the layout snapshot. Everything comes out in
 * document order. A live region's text is collected as text blocks like any other text.
 */
function collectCandidates({
  model,
  frame,
  viewport,
}: {
  model: PageModel
  frame: FrameGeometry | undefined
  viewport: Box | undefined
}): {
  elements: Candidate[]
  texts: TextCandidate[]
  liveRegions: LiveRegionCandidate[]
  modalDialog?: PageModelNode
  nodeIndexByBackendId: Map<number, number>
} {
  const nodeIndexByBackendId = new Map<number, number>()
  frame?.nodeBackendIds?.forEach((id, index) => {
    if (!nodeIndexByBackendId.has(id)) nodeIndexByBackendId.set(id, index)
  })

  const elements: Candidate[] = []
  const texts: TextCandidate[] = []
  const liveRegions: LiveRegionCandidate[] = []
  const listedIds = new Set<number>()
  let modalDialog: PageModelNode | undefined
  // Nodes the snapshot could not place get an order just after the previous one, so
  // they stay where the AX tree put them.
  let lastOrder = -1
  const orderOf = (backendNodeId: number): { order: number; nodeIndex?: number } => {
    const nodeIndex = nodeIndexByBackendId.get(backendNodeId)
    if (nodeIndex === undefined) {
      lastOrder += 0.001
      return { order: lastOrder }
    }
    lastOrder = nodeIndex
    return { order: nodeIndex, nodeIndex }
  }

  let pendingText: TextCandidate | null = null
  let pendingBlockKey: number | null = null
  const flushText = (): void => {
    // A run with no letter or digit ("|", ",", "·") is layout punctuation between links, not
    // something to read.
    if (pendingText && /[\p{L}\p{N}]/u.test(pendingText.text)) {
      pendingText.text = pendingText.text.replace(/\s+/g, ' ').trim()
      texts.push(pendingText)
    }
    pendingText = null
    pendingBlockKey = null
  }
  /** The nearest non-inline ancestor element: two text runs in it read as one line of prose. */
  const blockContainerOf = (nodeIndex: number | undefined): number | null => {
    if (nodeIndex === undefined || !frame) return null
    let current = frame.parentIndex[nodeIndex] ?? -1
    while (current >= 0) {
      const record = frame.byNodeIndex.get(current)
      const display = record?.styles['display']
      if (record && display && !display.startsWith('inline') && display !== 'contents') return current
      current = frame.parentIndex[current] ?? -1
    }
    return null
  }

  const visit = (node: PageModelNode, flags: { inControl: boolean; inBlock: boolean }): void => {
    const role = node.role ?? ''
    const real = model.byKey.has(node.key)
    const placed = real ? orderOf(node.backendNodeId) : undefined

    if (real && (role === 'dialog' || role === 'alertdialog') && node.states?.modal && node.runtime.visible === true) {
      const best = modalDialog?.runtime.paintOrder ?? -1
      if (!modalDialog || (node.runtime.paintOrder ?? -1) >= best) modalDialog = node
    }

    if (real && !flags.inControl && LIVE_ROLES[role] && node.runtime.visible === true) {
      // Its text starts a new block: words inside the region and before it are not one sentence.
      flushText()
      liveRegions.push({ key: node.key, backendNodeId: node.backendNodeId, role, name: modelName(node) })
    }

    const isInteractive = INTERACTIVE_ROLES[role] === true
    const isImage = IMAGE_ROLES[role] === true
    if (real && placed && (isInteractive || isImage)) {
      flushText()
      listedIds.add(node.backendNodeId)
      const nativeDropDown = role === 'combobox' && node.tag === 'select'
      const widget = widgetOf(node.tag, node.attributes)
      elements.push({
        key: node.key,
        frameId: node.frameId,
        backendNodeId: node.backendNodeId,
        role,
        name: modelName(node).replace(/\s+/g, ' ').trim(),
        tag: node.tag,
        ...(node.states ? { states: node.states } : {}),
        ...(node.value !== undefined ? { value: node.value } : {}),
        ...(role === 'link' && node.attributes.href !== undefined ? { href: node.attributes.href } : {}),
        ...(nativeDropDown ? { options: nativeSelectOptions(node) } : {}),
        ...(widget ? { widget } : {}),
        order: placed.order,
        ...(placed.nodeIndex !== undefined ? { nodeIndex: placed.nodeIndex } : {}),
        measured: measuredFromRuntime(node),
        anchor: node,
        anchorIsSelf: true,
        contextBasis: {},
      })
      // Its popup options are part of it, not controls of their own.
      if (nativeDropDown) return
    }

    const childFlags = {
      inControl: flags.inControl || isInteractive || isImage,
      inBlock: flags.inBlock,
    }
    if (real && placed && !childFlags.inControl && !flags.inBlock) {
      if (role === 'heading') {
        flushText()
        const headingText = modelName(node) || gatherText(node, Number.POSITIVE_INFINITY)
        if (headingText) {
          texts.push({
            key: node.key,
            frameId: node.frameId,
            role,
            text: headingText.replace(/\s+/g, ' ').trim(),
            ...(node.states?.level !== undefined ? { level: node.states.level } : {}),
            order: placed.order,
            ...(placed.nodeIndex !== undefined ? { nodeIndex: placed.nodeIndex } : {}),
            measured: measuredFromRuntime(node),
            anchor: node,
          })
        }
        childFlags.inBlock = true
      } else if (BLOCK_TEXT_ROLES[role] && !containsBlock(node)) {
        flushText()
        const isRow = role === 'row' || role === 'layouttablerow'
        const blockText = isRow
          ? node.children
              .filter((child) => CELL_ROLES[child.role ?? ''])
              // gatherText first: Chromium's own cell name glues inline runs together
              // ("Hacker Newsnew | past"), the gathered text keeps them apart.
              .map((cell) => gatherText(cell, Number.POSITIVE_INFINITY) || modelName(cell))
              .filter(Boolean)
              .join(' | ')
          : // A block whose only words are its links' names ("All", "Active" in a filter list)
            // would repeat the link lines right below it.
            gatherText(node, Number.POSITIVE_INFINITY, false)
            ? gatherText(node, Number.POSITIVE_INFINITY)
            : ''
        if (blockText) {
          texts.push({
            key: node.key,
            frameId: node.frameId,
            role,
            text: blockText.replace(/\s+/g, ' ').trim(),
            order: placed.order,
            ...(placed.nodeIndex !== undefined ? { nodeIndex: placed.nodeIndex } : {}),
            measured: measuredFromRuntime(node),
            anchor: node,
          })
        }
        childFlags.inBlock = true
      } else if (role === 'text') {
        // A control's label: its words are the control's name, on the control's own line.
        if (node.labels !== undefined) return
        const textValue = modelName(node)
        const container = blockContainerOf(placed.nodeIndex)
        if (pendingText && container !== null && container === pendingBlockKey) {
          pendingText.text += ` ${textValue}`
        } else {
          flushText()
          pendingText = {
            key: node.key,
            frameId: node.frameId,
            role: 'text',
            text: textValue,
            order: placed.order,
            ...(placed.nodeIndex !== undefined ? { nodeIndex: placed.nodeIndex } : {}),
            measured: measuredFromRuntime(node),
            anchor: node,
          }
          pendingBlockKey = container
        }
        return
      }
    }
    for (const child of node.children) visit(child, childFlags)
    // Nor are the words inside it and the words right after it.
    if (real && !flags.inControl && LIVE_ROLES[role] && node.runtime.visible === true) flushText()
  }
  for (const child of model.root.children) visit(child, { inControl: false, inBlock: false })
  flushText()

  if (frame) {
    collectClickables({ model, frame, viewport, listedIds, elements, liveRegions })
    elements.sort((a, b) => a.order - b.order)
  }
  return { elements, texts, liveRegions, nodeIndexByBackendId, ...(modalDialog ? { modalDialog } : {}) }
}

/**
 * Controls a person operates through their `<label>` (see label-control.ts). A listed control that
 * cannot be operated on its own — too small to hit, or hidden with nothing drawn where it is —
 * takes its label's place on screen; a control the accessibility tree leaves out (`display: none`)
 * is added from its label. Either way it is marked `viaLabel`, and act clicks the label. A control
 * with several labels is placed at the first rendered one, in document order.
 */
async function addLabelOperatedControls({
  world,
  model,
  frame,
  candidates,
}: {
  world: IsolatedWorld
  model: PageModel
  frame: FrameGeometry
  candidates: Candidate[]
}): Promise<void> {
  const cache = new Map<number, boolean>()
  const labels = [...frame.byNodeIndex.values()]
    .filter(
      (record) =>
        record.nodeType === 1 &&
        record.nodeName === 'LABEL' &&
        record.box.width >= MIN_CLICKABLE_SIDE &&
        record.box.height >= MIN_CLICKABLE_SIDE &&
        measureLaidOutRecord(record, frame, cache).visible,
    )
    .sort((a, b) => a.nodeIndex - b.nodeIndex)
  if (labels.length === 0) return
  const facts = await world.callFunctionOnNodes<Array<LabeledControlFacts | null>>(
    labels.map((label) => label.backendNodeId),
    LABEL_FACTS_FN,
    { args: { min: MIN_CLICKABLE_SIDE }, what: 'reading the controls the labels on the page belong to' },
  )
  const labelled = labels.flatMap((label, index) => {
    const fact = facts[index]
    return fact ? [{ label, facts: fact }] : []
  })
  if (labelled.length === 0) return
  const controlIds = await world.nodesReturnedBy(
    labelled.map(({ label }) => label.backendNodeId),
    LABEL_CONTROLS_FN,
    { what: 'identifying the controls the labels belong to' },
  )
  const listed = new Map(candidates.map((candidate) => [candidate.backendNodeId, candidate]))
  const seen = new Set<number>()
  const standIns: Array<{ label: SnapshotNodeGeometry; facts: LabeledControlFacts; controlId: number }> = []
  labelled.forEach(({ label, facts: fact }, index) => {
    const controlId = controlIds[index]
    if (controlId === null || seen.has(controlId)) return
    seen.add(controlId)
    const existing = listed.get(controlId)
    const hiddenWhereItIs = existing !== undefined && existing.measured.visible === false && !existing.measured.transparent
    if (fact.operable && !hiddenWhereItIs) return
    standIns.push({ label, facts: fact, controlId })
  })
  if (standIns.length === 0) return
  const occlusion = computeFrameOcclusion({ frame, targets: standIns.map(({ label }) => label), visibilityCache: cache })
  const nodeBackendIds = frame.nodeBackendIds ?? []
  for (const { label, facts: fact, controlId } of standIns) {
    const { visible, inViewport } = measureLaidOutRecord(label, frame, cache)
    const covered = occlusion.get(label.backendNodeId)
    const measured: Measured = {
      visible,
      ...(inViewport !== undefined ? { inViewport } : {}),
      box: { ...label.box },
      ...(covered
        ? { occluded: covered.state, occludedFraction: covered.coveredFraction, occludedBy: covered.by, occludedByLabels: covered.labels }
        : {}),
    }
    const name = (fact.ariaLabel || fact.text).replace(/\s+/g, ' ').trim()
    const existing = listed.get(controlId)
    if (existing) {
      existing.measured = measured
      existing.viaLabel = true
      if (!existing.name) existing.name = name
      continue
    }
    let anchor: PageModelNode | undefined
    let current = label.nodeIndex
    while (current >= 0 && !anchor) {
      anchor = model.byKey.get(`${frame.frameId}:${nodeBackendIds[current]}` as NodeKey)
      current = frame.parentIndex[current] ?? -1
    }
    const states: AxStates = {
      ...(fact.checked !== null ? { checked: fact.mixed ? ('mixed' as const) : fact.checked } : {}),
      ...(fact.disabled ? { disabled: true as const } : {}),
    }
    candidates.push({
      key: `${model.frameId}:${controlId}` as NodeKey,
      frameId: model.frameId,
      backendNodeId: controlId,
      role: roleOfControl(fact),
      name,
      tag: fact.tag,
      // What it takes (a file input under its drawn label is an upload control), as for any native input.
      ...(fact.tag === 'input' ? { widget: { type: fact.type } } : {}),
      ...(Object.keys(states).length > 0 ? { states } : {}),
      order: label.nodeIndex,
      nodeIndex: label.nodeIndex,
      measured,
      ...(anchor ? { anchor } : {}),
      anchorIsSelf: false,
      viaLabel: true,
      contextBasis: {},
    })
  }
  candidates.sort((a, b) => a.order - b.order)
}

/**
 * Non-semantic click targets: laid-out, visible elements of at least 8×8 px that
 * DOMSnapshot reports `isClickable` and the AX tree does not already list — the
 * `<div onClick>` cards a React app is full of and a text-only model otherwise cannot
 * find. Also the live regions made with `aria-live` on an element the AX filter drops as an
 * unnamed `generic` (their text is collected as body text like any other).
 *
 * Skipped: `html`/`body`; `<label>` (a click there is forwarded to its control, which
 * is listed); delegation roots (large, and containing other controls); and anything
 * inside an element already listed — the click target is the outer one.
 */
function collectClickables({
  model,
  frame,
  viewport,
  listedIds,
  elements,
  liveRegions,
}: {
  model: PageModel
  frame: FrameGeometry
  viewport: Box | undefined
  listedIds: Set<number>
  elements: Candidate[]
  liveRegions: LiveRegionCandidate[]
}): void {
  const cache = new Map<number, boolean>()
  const nodeBackendIds = frame.nodeBackendIds ?? []
  const viewportArea = viewport ? viewport.width * viewport.height : Number.POSITIVE_INFINITY

  const liveIds = new Set(liveRegions.map((region) => region.backendNodeId))
  const candidates: SnapshotNodeGeometry[] = []
  const records = [...frame.byNodeIndex.values()].sort((a, b) => a.nodeIndex - b.nodeIndex)
  for (const record of records) {
    if (record.nodeType !== 1) continue
    const live = record.attributes?.['aria-live']
    if (live && live !== 'off' && !liveIds.has(record.backendNodeId) && measureLaidOutRecord(record, frame, cache).visible) {
      liveIds.add(record.backendNodeId)
      const key = `${frame.frameId}:${record.backendNodeId}` as NodeKey
      const node = model.byKey.get(key)
      liveRegions.push({
        key,
        backendNodeId: record.backendNodeId,
        role: record.attributes?.role || `aria-live=${live}`,
        name: (node && modelName(node)) || record.attributes?.['aria-label'] || '',
      })
    }
    if (!record.isClickable) continue
    const tag = record.nodeName.toLowerCase()
    if (tag === 'html' || tag === 'body' || tag === 'label') continue
    if (listedIds.has(record.backendNodeId)) continue
    if (record.box.width < MIN_CLICKABLE_SIDE || record.box.height < MIN_CLICKABLE_SIDE) continue
    if (!measureLaidOutRecord(record, frame, cache).visible) continue
    candidates.push(record)
  }
  if (candidates.length === 0) return

  const isAncestorOf = (ancestorIndex: number, nodeIndex: number): boolean => {
    let current = frame.parentIndex[nodeIndex] ?? -1
    while (current >= 0) {
      if (current === ancestorIndex) return true
      current = frame.parentIndex[current] ?? -1
    }
    return false
  }
  const listedNodeIndexes: number[] = []
  for (const element of elements) if (element.nodeIndex !== undefined) listedNodeIndexes.push(element.nodeIndex)

  const kept = new Set<number>()
  const keptRecords: SnapshotNodeGeometry[] = []
  for (const record of candidates) {
    const area = record.box.width * record.box.height
    if (area >= DELEGATION_ROOT_VIEWPORT_SHARE * viewportArea) {
      const containsControls =
        listedNodeIndexes.some((index) => isAncestorOf(record.nodeIndex, index)) ||
        candidates.some((other) => other !== record && isAncestorOf(record.nodeIndex, other.nodeIndex))
      if (containsControls) continue
    }
    let current = frame.parentIndex[record.nodeIndex] ?? -1
    let nested = false
    while (current >= 0) {
      const id = nodeBackendIds[current]
      if (listedIds.has(id) || kept.has(current)) {
        nested = true
        break
      }
      current = frame.parentIndex[current] ?? -1
    }
    if (nested) continue
    kept.add(record.nodeIndex)
    keptRecords.push(record)
  }
  if (keptRecords.length === 0) return

  const occlusion = computeFrameOcclusion({ frame, targets: keptRecords, visibilityCache: cache })
  for (const record of keptRecords) {
    const { visible, inViewport } = measureLaidOutRecord(record, frame, cache)
    const covered = occlusion.get(record.backendNodeId)
    let anchor: PageModelNode | undefined
    let current = record.nodeIndex
    while (current >= 0 && !anchor) {
      anchor = model.byKey.get(`${frame.frameId}:${nodeBackendIds[current]}` as NodeKey)
      current = frame.parentIndex[current] ?? -1
    }
    const attributes = record.attributes ?? {}
    const visibleText = nodeVisibleText(frame, record.nodeIndex, Number.POSITIVE_INFINITY)
    const name = visibleText || attributes['aria-label'] || attributes.title || ''
    elements.push({
      key: `${model.frameId}:${record.backendNodeId}` as NodeKey,
      frameId: model.frameId,
      backendNodeId: record.backendNodeId,
      role: 'clickable',
      name: name.replace(/\s+/g, ' ').trim(),
      tag: record.nodeName.toLowerCase(),
      cssLabel: cssLabelOf(record),
      order: record.nodeIndex,
      nodeIndex: record.nodeIndex,
      measured: {
        visible,
        ...(inViewport !== undefined ? { inViewport } : {}),
        box: { ...record.box },
        ...(covered
          ? { occluded: covered.state, occludedFraction: covered.coveredFraction, occludedBy: covered.by, occludedByLabels: covered.labels }
          : {}),
      },
      ...(anchor ? { anchor } : {}),
      anchorIsSelf: anchor?.backendNodeId === record.backendNodeId,
      fullyNamed: visibleText.length <= NAME_MAX_CHARS,
      contextBasis: {},
    })
  }
}

/**
 * Context only where it is needed: for each role+name that appears more than once, the
 * nearest named container (listitem/row/article/group/region/cell/dialog/form) that
 * tells the copies apart — for an element in an iframe with none inside it, the iframe —
 * else the nearest preceding heading, else the text right before it (the caption a person
 * reads above a group: "Text", then Small / Standard / Large), else an ordinal. Every element
 * also gets its `contextBasis` (each of those contexts, repeated or not), which is what act
 * compares with the context the model was shown. `models` and `iframeNames` are keyed by frame id.
 */
function assignContexts({
  candidates,
  texts,
  models,
  iframeNames,
}: {
  candidates: Candidate[]
  texts: TextCandidate[]
  models: Map<string, PageModel>
  iframeNames: Map<string, string>
}): void {
  const groups = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const id = `${candidate.role}\u0000${candidate.name}`
    const group = groups.get(id)
    if (group) group.push(candidate)
    else groups.set(id, [candidate])
  }

  const headings = texts.filter((t) => t.role === 'heading').sort((a, b) => a.order - b.order)
  const headingBefore = (order: number): string | undefined => {
    let found: string | undefined
    for (const heading of headings) {
      if (heading.order >= order) break
      found = heading.text
    }
    return found
  }

  /**
   * What names `container` for `element`: its own name, a row's first other cell, else the first
   * readable text inside, or the name of a control of another kind (a todo row's checkbox "Buy
   * milk" for its Delete button). A peer's words are skipped there: they name that peer, not the
   * container (the "Small" label of the radio beside "Standard", the "Edit" of the button beside
   * "Delete"). A link stays readable: a title or author link is what identifies its item.
   */
  const containerLabel = (container: PageModelNode, candidate: Candidate): string | undefined => {
    const element = candidate.anchorIsSelf ? candidate.anchor : undefined
    const role = container.role ?? ''
    const own = (CELL_ROLES[role] && gatherText(container, CONTEXT_MAX_CHARS)) || modelName(container)
    if (role === 'row' || role === 'layouttablerow') {
      // Chromium names a row after ALL its cells ("Alice Edit"): the first cell that is
      // not the control itself identifies the row better.
      for (const cell of container.children) {
        const cellName = gatherText(cell, CONTEXT_MAX_CHARS) || modelName(cell)
        if (cellName && cellName !== candidate.name) return truncate(cellName, CONTEXT_MAX_CHARS)
      }
    }
    if (own && own !== candidate.name) return truncate(own, CONTEXT_MAX_CHARS)
    // Unnamed list items and articles: the first readable text or other-kind control inside
    // that is not the control's own label.
    let found: string | undefined
    const visit = (node: PageModelNode): void => {
      if (found || node === element) return
      const nodeRole = node.role ?? ''
      if (node !== container && (node.labels === candidate.role || (nodeRole === candidate.role && nodeRole !== 'link'))) return
      const name = modelName(node)
      if (name && name !== candidate.name && (nodeRole === 'text' || nodeRole === 'heading' || CELL_ROLES[nodeRole] || INTERACTIVE_ROLES[nodeRole])) {
        found = truncate(name, CONTEXT_MAX_CHARS)
        return
      }
      for (const child of node.children) visit(child)
    }
    visit(container)
    return found
  }

  // Visible texts in reading order: the caption before an element is the last of them that
  // precedes it in its own document and is not a block it sits in.
  const shownTexts = texts.filter((text) => text.measured.visible === true)
  const captionBefore = (candidate: Candidate): string | undefined => {
    const model = models.get(candidate.frameId)
    const around = new Set<NodeKey>()
    for (let key: NodeKey | undefined = candidate.anchor?.key; key !== undefined; key = model?.parentByKey.get(key)) around.add(key)
    let low = 0
    let high = shownTexts.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (shownTexts[middle].order < candidate.order) low = middle + 1
      else high = middle
    }
    for (let index = low - 1; index >= 0; index--) {
      const text = shownTexts[index]
      if (text.frameId === candidate.frameId && !around.has(text.anchor.key)) return text.text
    }
    return undefined
  }

  const containerContextOf = (candidate: Candidate): string | undefined => {
    const model = models.get(candidate.frameId)
    let key: NodeKey | undefined = !candidate.anchor || !model ? undefined : candidate.anchorIsSelf ? model.parentByKey.get(candidate.anchor.key) : candidate.anchor.key
    while (key && model) {
      const node = model.byKey.get(key)
      if (node && CONTEXT_ROLES[node.role ?? '']) {
        const label = containerLabel(node, candidate)
        // Chromium's layout-table roles read as plain rows/cells to a person.
        if (label) return `in ${(node.role ?? '').replace(/^layouttable/, '')} "${label}"`
      }
      key = model.parentByKey.get(key)
    }
    const iframeName = iframeNames.get(candidate.frameId)
    return iframeName ? `in iframe "${truncate(iframeName, CONTEXT_MAX_CHARS)}"` : undefined
  }
  for (const candidate of candidates) {
    const heading = headingBefore(candidate.order)
    const container = containerContextOf(candidate)
    const caption = captionBefore(candidate)
    candidate.contextBasis = {
      ...(container ? { container } : {}),
      ...(heading ? { heading: `under heading "${truncate(heading, CONTEXT_MAX_CHARS)}"` } : {}),
      ...(caption ? { caption: `after "${truncate(caption, CONTEXT_MAX_CHARS)}"` } : {}),
    }
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue
    const containerContext = group.map((candidate) => candidate.contextBasis.container)
    const headingContext = group.map((candidate) => candidate.contextBasis.heading)
    const captionContext = group.map((candidate) => candidate.contextBasis.caption)
    const unique = (values: Array<string | undefined>, index: number): boolean =>
      values[index] !== undefined && values.filter((v) => v === values[index]).length === 1
    group.forEach((candidate, index) => {
      if (unique(containerContext, index)) candidate.context = containerContext[index]
      else if (unique(headingContext, index)) candidate.context = headingContext[index]
      else if (unique(captionContext, index)) candidate.context = captionContext[index]
      else candidate.context = `${ordinal(index + 1)} of ${group.length}`
    })
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ON_SCREEN: Record<string, true> = { 'in-view': true, 'partly-covered': true, covered: true }

/**
 * Text for the model, quoted. Whitespace is collapsed and a longer text is cut at `max` with how
 * much was left out — `"Free shipping on orders over…" (+212 chars)` — so a reader knows there is
 * more (find() searches the whole text).
 */
export function quote(text: string, max = NAME_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return `"${clean.replace(/"/g, '\\"')}"`
  return `"${clean.slice(0, max - 1).replace(/"/g, '\\"')}…" (+${clean.length - max + 1} chars)`
}

/** The ISO form a native date/time input's value takes, which act.fill expects. */
const DATE_VALUE_FORMS: Record<string, string> = {
  date: 'YYYY-MM-DD',
  'datetime-local': 'YYYY-MM-DDThh:mm',
  month: 'YYYY-MM',
  week: 'YYYY-Www',
  time: 'hh:mm',
}

/** What a field takes and says about itself beyond its states: range, format, constraints, error, description. */
function describeField(element: ObservedElement, line: string): string {
  const states = element.states
  const widget = element.widget
  const parts: string[] = []
  if (states?.multiline) parts.push('[multiline]')
  const min = states?.valueMin ?? widget?.min
  const max = states?.valueMax ?? widget?.max
  if (min !== undefined || max !== undefined) {
    parts.push(`[range ${min ?? '…'}–${max ?? '…'}${widget?.step !== undefined ? ` step ${widget.step}` : ''}]`)
  }
  if (states?.autocomplete) parts.push(`[autocomplete=${states.autocomplete}]`)
  if (element.activeRef !== undefined) parts.push(`[active=[${element.activeRef}]]`)
  if (widget) {
    const form = DATE_VALUE_FORMS[widget.type]
    if (form) parts.push(`(takes ${form}: act.fill(${element.ref}, "${form}"))`)
    // A file input reads as a button ("Choose File"): say what clicking it opens and how to answer.
    else if (widget.type === 'file') parts.push(`(file input: its click opens a file dialog — act.upload(${element.ref}, path))`)
    // A colour input's value is #rrggbb; act.fill sets it through Chrome's chooser, except the
    // swatch popup a `list` brings up, which takes no choice from the keyboard.
    else if (widget.type === 'color') {
      if (widget.chooserOpen && widget.swatches) {
        parts.push("(its swatch popup is open, and keys go to it, not the page: act.press('Escape') closes it; choosing in it needs the user)")
      } else if (widget.chooserOpen) {
        // color_picker.js: Enter closes it; Escape puts back the colour it opened with, or closes it when that is still the colour.
        parts.push(
          `(Chrome's colour chooser is open, and keys go to it, not the page: act.fill(${element.ref}, "#rrggbb") chooses a colour; act.press('Enter') ` +
            "closes it keeping the colour it shows; act.press('Escape') puts back the colour it opened with, and closes it once that colour is back)",
        )
      } else {
        parts.push(widget.swatches ? '(colour input with suggested swatches: act.fill cannot choose in its popup — ask the user)' : `(takes #rrggbb: act.fill(${element.ref}, "#rrggbb"))`)
      }
    }
    // A text field's type (email, tel, url, password) is not in its role; other roles say it already.
    else if (element.role === 'textbox' && widget.type && widget.type !== 'text') parts.push(`type=${widget.type}`)
    if (widget.placeholder && widget.placeholder !== element.name && !element.value) parts.push(`placeholder ${quote(widget.placeholder, 40)}`)
    if (widget.pattern) parts.push(`pattern ${quote(widget.pattern, 40)}`)
    if (widget.maxLength !== undefined) parts.push(`max ${widget.maxLength} chars`)
    if (widget.accept) parts.push(`accepts ${quote(widget.accept, 40)}`)
    if (widget.multiple) parts.push('multiple')
  }
  if (element.errorText) parts.push(`error ${quote(element.errorText, TEXT_SHOWN_CHARS)}`)
  if (states?.description && states.description !== element.name && states.description !== element.errorText) {
    parts.push(`description ${quote(states.description, TEXT_SHOWN_CHARS)}`)
  }
  return parts.length > 0 ? `${line} ${parts.join(' ')}` : line
}

function shortHref(href: string, pageUrl: string): string {
  if (/^javascript:/i.test(href)) return ''
  try {
    const target = new URL(href, pageUrl)
    const base = new URL(pageUrl)
    if (target.origin === base.origin) return truncate(`${target.pathname}${target.search}${target.hash}`, 80)
    return truncate(target.href, 80)
  } catch {
    return truncate(href, 80)
  }
}

function describeElement(element: ObservedElement, obs: Observation): string {
  const role = element.role === 'clickable' ? `clickable ${element.cssLabel ?? element.tag}` : element.role
  let line = `${element.isNew ? '*' : ''}[${element.ref}] ${role}`
  if (element.name) line += ` ${quote(element.name)}`
  line += formatAxStates(element.states, element.role)
  if (element.value !== undefined) line += ` = ${quote(element.value, 60)}`
  line = describeField(element, line)
  if (element.href !== undefined) {
    // Relative links resolve against the element's own document: an iframe's, when it is in one.
    const base = obs.elements.find((candidate) => candidate.frame?.frameId === element.frameId)?.frame?.url ?? obs.url
    const href = shortHref(element.href, base)
    if (href) line += ` → ${href}`
  }
  if (element.frame) {
    const { controls, unread } = element.frame
    line += unread ? ` — not read: ${unread}` : ` — ${controls} control${controls === 1 ? '' : 's'}`
  }
  if (element.context) line += ` (${element.context})`
  if (element.image) {
    if (element.image.broken) line += ' BROKEN (did not load)'
    else if (!element.image.loaded) line += ' (not loaded yet)'
  }
  if (element.options) {
    const shown = element.options.slice(0, MAX_OPTIONS_SHOWN).map((option) => (option.disabled ? `${option.label} (disabled)` : option.label))
    const more = element.options.length - shown.length
    line += ` (options: ${shown.join(' · ')}${more > 0 ? ` · +${more} more — find() searches them` : ''})`
  }
  if (element.transparent) line += ' (transparent control: its look is drawn by the styling around it; clicking it works)'
  if (element.viaLabel) line += ' (hidden control worked through its label: act on this ref and the label is clicked)'
  return line
}

function coverNote(element: ObservedElement): string {
  const pct = element.coveredFraction !== undefined ? ` (${Math.round(element.coveredFraction * 100)}%)` : ''
  if (element.visibility === 'covered') return ` covered by ${element.coveredBy ?? 'another element'}${pct} — a click would hit that instead`
  if (element.visibility === 'partly-covered') return ` partly covered by ${element.coveredBy ?? 'another element'}${pct}`
  return ''
}

/** Screens from the top of the viewport to `box` (document px); negative is above. */
function screensFromTop(box: Box | undefined, obs: Observation): number | undefined {
  if (!box || !obs.viewport || !obs.scroll || obs.viewport.height <= 0) return undefined
  return Math.round(((box.y - obs.scroll.y) / obs.viewport.height) * 10) / 10
}

/** `[57] list "Inbox"` for a scroll area ref. */
function scrollerLabel(obs: Observation, ref: number): string {
  const scroller = obs.scrollers.find((candidate) => candidate.ref === ref)
  return scroller ? `[${ref}] ${scroller.role} ${quote(scroller.name, 40)}` : `[${ref}]`
}

const SCROLLED_OUT: Partial<Record<Visibility, true>> = { above: true, below: true, clipped: true, left: true, right: true }

/**
 * Out of sight inside a scroll area, which is what scrolls it into view, not the page. `scroller`
 * is already the area that scrolls on the axis it is hidden along (observePage's scrollerOf).
 */
function inScroller(item: { visibility: Visibility; scroller?: number }): boolean {
  return item.scroller !== undefined && SCROLLED_OUT[item.visibility] === true
}

/** Where an element is, in words a person would use, with what to do about it. */
function describeWhere(item: { visibility: Visibility; box?: Box; coveredBy?: string; scroller?: number }, obs: Observation): string {
  const distance = screensFromTop(item.box, obs)
  if (item.scroller !== undefined && inScroller(item)) {
    return `inside ${scrollerLabel(obs, item.scroller)}, scrolled out of sight (act.scrollTo(ref), or act.scroll(dir, { ref: ${item.scroller} }))`
  }
  switch (item.visibility) {
    case 'in-view':
      return 'in view'
    case 'partly-covered':
      return `in view, partly covered by ${item.coveredBy ?? 'another element'}`
    case 'covered':
      return `in view but covered by ${item.coveredBy ?? 'another element'}`
    case 'above':
      return `above, ${distance !== undefined ? `${Math.abs(distance)} screens up` : 'off-screen'} (scroll up)`
    case 'below':
      return `below, ${distance !== undefined ? `${distance} screens down` : 'off-screen'} (scroll down)`
    case 'left':
      return 'off to the left (scroll horizontally)'
    case 'right':
      return 'off to the right (scroll horizontally)'
    case 'clipped':
      return 'cut off by a container around it (act.scrollTo(ref) brings it into view when that container scrolls)'
    case 'hidden':
      return 'hidden (not visible right now)'
    case 'unknown':
      return 'position unknown (not measured)'
  }
}

function describeText(block: TextBlock): string {
  const prefix = block.isNew ? '*' : ''
  if (block.role === 'heading') return `${prefix}heading ${quote(block.text, TEXT_SHOWN_CHARS)}${block.level !== undefined ? ` [level=${block.level}]` : ''}`
  const label = block.role === 'listitem' ? 'item' : block.role === 'row' || block.role === 'layouttablerow' ? 'row' : 'text'
  return `${prefix}${label}: ${quote(block.text, TEXT_SHOWN_CHARS)}`
}

/** Pixels a scroll area still hides past each edge (0 at that edge; ≤ 1 counts as at it, as Chrome rounds). */
function hiddenPx(scroller: ObservedScroller): { above: number; below: number; left: number; right: number } {
  return {
    above: scroller.scrolledFromTop,
    below: scroller.scrollHeight - scroller.clientHeight - scroller.scrolledFromTop,
    left: scroller.scrolledFromLeft,
    right: scroller.scrollWidth - scroller.clientWidth - scroller.scrolledFromLeft,
  }
}

/**
 * An amount a scroll area hides past one edge: screens of the area (one decimal), or pixels when
 * that rounds to 0 — an area that scrolls 14px is not "0 screens" from its end. `unit` false leaves
 * the unit implied by the amount before it (`2 screens above, 3 below`).
 */
function hiddenAmount(screens: number, px: number, unit: boolean): string {
  if (screens > 0) return unit ? `${screens} screens` : `${screens}`
  return `${Math.round(px)}px`
}

/**
 * Where a scroll area is scrolled to, on each axis it scrolls: `top, 3.2 screens below`,
 * `left edge, 2.5 screens to the right`, or both joined by `; `. Which edge it is at is decided in
 * pixels, never from the rounded screens: 10px from the bottom is not the bottom.
 */
function scrollPosition(scroller: ObservedScroller): string {
  const hidden = hiddenPx(scroller)
  const parts: string[] = []
  if (scroller.vertical) {
    if (hidden.above <= 1) parts.push(`top, ${hiddenAmount(scroller.screensBelow, hidden.below, true)} below`)
    else if (hidden.below <= 1) parts.push(`bottom, ${hiddenAmount(scroller.screensAbove, hidden.above, true)} above`)
    else {
      const above = hiddenAmount(scroller.screensAbove, hidden.above, true)
      parts.push(`${above} above, ${hiddenAmount(scroller.screensBelow, hidden.below, !above.endsWith('screens'))} below`)
    }
  }
  if (scroller.horizontal) {
    if (hidden.left <= 1) parts.push(`left edge, ${hiddenAmount(scroller.screensRight, hidden.right, true)} to the right`)
    else if (hidden.right <= 1) parts.push(`right edge, ${hiddenAmount(scroller.screensLeft, hidden.left, true)} to the left`)
    else {
      const left = hiddenAmount(scroller.screensLeft, hidden.left, true)
      parts.push(`${left} to the left, ${hiddenAmount(scroller.screensRight, hidden.right, !left.endsWith('screens'))} to the right`)
    }
  }
  return parts.join('; ')
}

type ScrollDirection = 'up' | 'down' | 'left' | 'right'

/**
 * Which way to turn a scroll area to bring what it hides into view: towards the side most of its
 * hidden items are on — by each item's box against the area's, or by the side of the viewport it is
 * off to when either has no box — and between equal counts, towards the side that hides more
 * pixels. Only sides of an axis the area scrolls on count.
 */
function insideDirection(scroller: ObservedScroller, items: Array<{ box?: Box; visibility: Visibility }>): ScrollDirection {
  const allowed: ScrollDirection[] = [...(scroller.vertical ? (['up', 'down'] as const) : []), ...(scroller.horizontal ? (['left', 'right'] as const) : [])]
  const votes: Record<ScrollDirection, number> = { up: 0, down: 0, left: 0, right: 0 }
  const area = scroller.box
  for (const item of items) {
    const box = item.box
    const sides: ScrollDirection[] =
      area && box
        ? [
            ...(box.y + box.height <= area.y ? (['up'] as const) : []),
            ...(box.y >= area.y + area.height ? (['down'] as const) : []),
            ...(box.x + box.width <= area.x ? (['left'] as const) : []),
            ...(box.x >= area.x + area.width ? (['right'] as const) : []),
          ]
        : item.visibility === 'above'
          ? ['up']
          : item.visibility === 'below'
            ? ['down']
            : item.visibility === 'left' || item.visibility === 'right'
              ? [item.visibility]
              : []
    for (const side of sides) votes[side]++
  }
  const hidden = hiddenPx(scroller)
  const hiddenOn: Record<ScrollDirection, number> = { up: hidden.above, down: hidden.below, left: hidden.left, right: hidden.right }
  return allowed.reduce((best, side) =>
    votes[side] > votes[best] || (votes[side] === votes[best] && hiddenOn[side] > hiddenOn[best]) ? side : best,
  )
}

/** One scroll area as a person sees it: `[57] list "Inbox" — top, 3.2 screens below`. */
function describeScroller(scroller: ObservedScroller): string {
  return `[${scroller.ref}] ${scroller.role} ${quote(scroller.name, 40)} — ${scrollPosition(scroller)}`
}

function pageHeader(obs: Observation): string[] {
  const parts = [obs.title === undefined ? '(title not readable while the dialog is open)' : obs.title || '(untitled)', obs.url]
  const lines = [`PAGE  ${parts.join(' · ')}`]
  const tabs = obs.tabs
  if (tabs && tabs.length > 1) {
    const list = tabs.map((tab) => `${tab.index}: ${quote(tab.title, 40)}${tab.controlled ? ' (controlled)' : ''}`)
    lines.push(`TABS  ${list.join(' · ')} — act.switchTab(n) works in another`)
  }
  if (!obs.scroll || !obs.viewport) {
    lines.push('      viewport and scroll position not readable while the dialog is open')
  } else {
    const scroll = obs.scroll
    const inView = obs.scrollers.filter((scroller) => ON_SCREEN[scroller.visibility])
    let where: string
    if (scroll.maxY <= 1) where = inView.length > 0 ? 'the page itself does not scroll' : 'the whole page fits on screen'
    else if (scroll.y <= 1) where = `top of page, ${scroll.screensBelow} screens below`
    else if (scroll.y >= scroll.maxY - 1) where = `bottom of page, ${scroll.screensAbove} screens above`
    else where = `${scroll.screensAbove} screens above, ${scroll.screensBelow} below`
    lines.push(`      viewport ${obs.viewport.width}×${obs.viewport.height} · ${where}`)
    for (const scroller of inView) lines.push(`SCROLL ${describeScroller(scroller)} (act.scroll(dir, { ref: ${scroller.ref} }))`)
  }
  if (obs.viewport && obs.frames.total > obs.frames.observed) {
    const missing = obs.frames.total - obs.frames.observed
    const iframes = obs.frames.total - 1
    lines.push(
      `      ${missing} of ${iframes} iframe${iframes === 1 ? '' : 's'} not read — each one's line says why (observe({ all: true }) lists hidden ones too)`,
    )
  }
  return lines
}

/**
 * Fit `head`, `body` and `tail` into `maxChars`. Body lines are dropped from the end
 * first (the viewport comes first, so what is cut is the least relevant), and the cut is
 * always announced on its own line — never a line cut in half.
 */
function fitToBudget(head: string[], body: string[], tail: string[], maxChars: number, hint: string): string {
  const size = (lines: string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0)
  const all = [...head, ...body, ...tail]
  if (size(all) <= maxChars) return all.join('\n')
  const fixed = size(head) + size(tail)
  const kept: string[] = []
  let used = fixed + 120
  for (const line of body) {
    if (used + line.length + 1 > maxChars) break
    kept.push(line)
    used += line.length + 1
  }
  const dropped = body.length - kept.length
  const cutLine = `… truncated: ${dropped} more line${dropped === 1 ? '' : 's'} not shown (${maxChars} char budget) — ${hint}`
  if (fixed + cutLine.length + 1 <= maxChars) return [...head, ...kept, cutLine, ...tail].join('\n')
  // Even the fixed parts do not fit: keep whole lines from the top.
  const out: string[] = []
  let total = cutLine.length + 1
  for (const line of all) {
    if (total + line.length + 1 > maxChars) break
    out.push(line)
    total += line.length + 1
  }
  return [...out, `… truncated: ${all.length - out.length} more lines not shown (${maxChars} char budget) — ${hint}`].join('\n')
}

export function renderObservation(obs: Observation, options: { all?: boolean; maxChars?: number; scope?: number } = {}): string {
  const maxChars = options.maxChars ?? 6000
  const head = pageHeader(obs)

  if (isDialogOpen(obs.jsDialog)) {
    const dialog = obs.jsDialog
    head.push(
      `DIALOG native ${dialog.type} ${quote(dialog.message, 300)}${dialog.defaultValue !== undefined ? ` (default ${quote(dialog.defaultValue, 60)})` : ''}`,
      '      The page is frozen until it is answered: act.dialog.accept() or act.dialog.dismiss().',
      '      Nothing else on the page can be read or used while it is open.',
    )
    return fitToBudget(head, [], [], maxChars, 'answer the dialog first')
  }

  for (const dialog of obs.fileDialogs ?? []) {
    const opened = dialog.openedBy ? `, opened by ${dialog.openedBy}` : ''
    head.push(
      dialog.fillable
        ? `FILE DIALOG open${opened} (${dialog.multiple ? 'several files allowed' : 'one file'}) — act.dialog.chooseFiles(path) chooses the files, act.dialog.dismiss() cancels it.`
        : `FILE DIALOG open${opened}: a picker the page's script opened without a file input — files cannot be chosen in it over this connection; act.dialog.dismiss() closes it.`,
      '      The page below waits for it and cannot be used until it is answered.',
    )
  }

  for (const signal of obs.busy) {
    head.push(signal.strength === 'strong' ? `BUSY  ${signal.label} (wait before acting)` : `BUSY? ${signal.label} (weak signal; may be idle)`)
  }

  let elements = obs.elements
  let texts = obs.text
  const scope = options.scope
  if (scope !== undefined) {
    const root = elements.find((e) => e.ref === scope)
    const area = root ? undefined : obs.scrollers.find((scroller) => scroller.ref === scope)
    if (!root && !area && obs.modal?.ref !== scope) {
      head.push(`SCOPE [${scope}] is not on this page (call observe() without scope to see current refs)`)
      return fitToBudget(head, [], [], maxChars, 'use find(text)')
    }
    elements = elements.filter((e) => e.ref === scope || e.inside?.includes(scope))
    texts = texts.filter((t) => t.inside?.includes(scope))
    const what = root
      ? `${root.role === 'clickable' ? `clickable ${root.cssLabel ?? root.tag}` : root.role}${root.name ? ` ${quote(root.name)}` : ''}`
      : area
        ? `${area.role} ${quote(area.name)}`
        : `${obs.modal?.role} ${quote(obs.modal?.name ?? '')}`
    head.push(`SCOPE only inside [${scope}] ${what}`)
  }

  const body: string[] = []
  // An iframe's content is printed under the iframe's own line, one step further in.
  const iframeOf = new Map(obs.elements.flatMap((e) => (e.frame ? [[e.frame.frameId, e] as const] : [])))
  const depthOf = (frameId: string): number => {
    let depth = 0
    for (let owner = iframeOf.get(frameId); owner; owner = iframeOf.get(owner.frameId)) depth++
    return depth
  }
  const indentOf = (frameId: string): number => {
    const owner = iframeOf.get(frameId)
    return owner ? indentOf(owner.frameId) + (owner.region ? 2 : 0) + 2 : 0
  }
  const modal = obs.modal
  if (modal) {
    const modalItems = [
      ...elements
        .filter((e) => e.inModal)
        .map((e) => ({
          order: e.order,
          line: `  ${'  '.repeat(depthOf(e.frameId))}${describeElement(e, obs)}${ON_SCREEN[e.visibility] ? coverNote(e) : ` — ${describeWhere(e, obs)}`}`,
        })),
      ...texts
        .filter((t) => t.inModal && ON_SCREEN[t.visibility])
        .map((t) => ({ order: t.order, line: `  ${'  '.repeat(depthOf(t.frameId))}${describeText(t)}` })),
    ].sort((a, b) => a.order - b.order)
    body.push(`MODAL ${modal.role}${modal.name ? ` ${quote(modal.name)}` : ''}${modal.ref !== undefined ? ` [${modal.ref}]` : ''} — only its controls work right now:`)
    if (!elements.some((e) => e.inModal)) body.push('  (no controls listed inside it)')
    for (const item of modalItems) body.push(item.line)
  }
  const focused = obs.focused !== undefined ? elements.find((e) => e.ref === obs.focused) : undefined
  if (focused) body.push(`FOCUS ${describeElement(focused, obs)}`)
  for (const live of obs.live) {
    if (!live.text) continue
    const label = `${live.role}${live.name ? ` ${quote(live.name, 40)}` : ''}`
    body.push(live.latest === live.text ? `LIVE  ${label}: ${quote(live.text, TEXT_SHOWN_CHARS)}` : `LIVE  ${label} — latest: ${quote(live.latest, TEXT_SHOWN_CHARS)}`)
  }

  type Item = { order: number; region?: string; indent: number; line: string }
  const items: Item[] = []
  for (const element of elements) {
    if (!ON_SCREEN[element.visibility] || (modal && element.inModal)) continue
    const behind = modal && !element.inModal ? ' (behind the modal)' : coverNote(element)
    items.push({ order: element.order, region: element.region, indent: indentOf(element.frameId), line: `${describeElement(element, obs)}${behind}` })
  }
  for (const block of texts) {
    if (!ON_SCREEN[block.visibility] || (modal && block.inModal)) continue
    items.push({ order: block.order, region: block.region, indent: indentOf(block.frameId), line: describeText(block) })
  }
  items.sort((a, b) => a.order - b.order)
  body.push(scope !== undefined ? 'IN VIEW (inside the scope)' : 'IN VIEW')
  if (items.length === 0) body.push('  (nothing readable in the viewport)')
  let current: { region: string | undefined; indent: number } | null = null
  for (const item of items) {
    if (!current || item.region !== current.region || item.indent !== current.indent) {
      if (item.region) body.push(`${' '.repeat(item.indent)}${item.region}`)
      current = { region: item.region, indent: item.indent }
    }
    body.push(`${' '.repeat(item.indent + (item.region ? 2 : 0))}${item.line}`)
  }

  const tail: string[] = []
  const offscreen = (visibility: Visibility): ObservedElement[] =>
    elements.filter((e) => e.visibility === visibility && !inScroller(e) && !(modal && e.inModal))
  /** Off-screen lists print no nesting: an item in an iframe names it instead. */
  const inIframe = (item: { frameId: string }): string => {
    const owner = iframeOf.get(item.frameId)
    return owner ? ` · in iframe [${owner.ref}]` : ''
  }
  type Listed = { order: number; region?: string; line: string }
  const headingsWhere = (visibility: Visibility): string[] =>
    texts
      .filter((t) => t.role === 'heading' && t.visibility === visibility && !inScroller(t))
      .slice(0, 4)
      .map((t, index) => {
        const distance = screensFromTop(t.box, obs)
        const shown = distance === undefined ? '' : visibility === 'above' ? `${Math.abs(distance)}` : `${distance}`
        const unit = index === 0 ? ` screens ${visibility === 'above' ? 'up' : 'down'}` : ''
        return `${quote(t.text, 40)}${shown ? ` (${shown}${unit})` : ''}`
      })
  const scrolledAway = new Map<number, { elements: ObservedElement[]; texts: TextBlock[] }>()
  for (const element of elements) {
    if (!inScroller(element) || (modal && element.inModal) || element.scroller === undefined) continue
    const entry = scrolledAway.get(element.scroller) ?? { elements: [], texts: [] }
    entry.elements.push(element)
    scrolledAway.set(element.scroller, entry)
  }
  for (const block of texts) {
    if (!inScroller(block) || (modal && block.inModal) || block.scroller === undefined) continue
    const entry = scrolledAway.get(block.scroller) ?? { elements: [], texts: [] }
    entry.texts.push(block)
    scrolledAway.set(block.scroller, entry)
  }

  if (options.all) {
    const sections: Array<[Visibility, string]> = [
      ['above', 'ABOVE (scroll up to reach)'],
      ['below', 'BELOW (scroll down to reach)'],
      ['clipped', 'CLIPPED (cut off by a container around them; act.scrollTo(ref) when it scrolls)'],
      ['left', 'LEFT (scroll horizontally)'],
      ['right', 'RIGHT (scroll horizontally)'],
      ['hidden', 'HIDDEN (not visible; cannot be used now)'],
      ['unknown', 'UNMEASURED (position unknown)'],
    ]
    for (const [visibility, title] of sections) {
      const list = offscreen(visibility)
      const blocks =
        visibility === 'hidden' || visibility === 'unknown' ? [] : texts.filter((t) => t.visibility === visibility && !inScroller(t) && !(modal && t.inModal))
      if (list.length === 0 && blocks.length === 0) continue
      body.push(title)
      const merged: Listed[] = [
        ...list.map((e) => {
          const distance = screensFromTop(e.box, obs)
          const suffix = (visibility === 'above' || visibility === 'below') && distance !== undefined ? ` (${Math.abs(distance)} screens ${visibility === 'above' ? 'up' : 'down'})` : ''
          return { order: e.order, region: e.region, line: `${describeElement(e, obs)}${suffix}${modal ? ' (behind the modal)' : ''}${inIframe(e)}` }
        }),
        ...blocks.map((t) => ({ order: t.order, region: t.region, line: `${describeText(t)}${inIframe(t)}` })),
      ].sort((a, b) => a.order - b.order)
      for (const item of merged) body.push(`  ${item.line}${item.region ? `  — ${item.region}` : ''}`)
    }
    for (const [ref, away] of scrolledAway) {
      body.push(`INSIDE ${scrollerLabel(obs, ref)}, scrolled out of sight (act.scroll(dir, { ref: ${ref} }) or act.scrollTo(ref))`)
      const merged: Listed[] = [
        ...away.elements.map((e) => ({ order: e.order, line: `${describeElement(e, obs)}${modal ? ' (behind the modal)' : ''}${inIframe(e)}` })),
        ...away.texts.map((t) => ({ order: t.order, line: `${describeText(t)}${inIframe(t)}` })),
      ].sort((a, b) => a.order - b.order)
      for (const item of merged) body.push(`  ${item.line}`)
    }
  } else {
    for (const [visibility, label] of [['above', 'ABOVE'], ['below', 'BELOW']] as const) {
      const list = offscreen(visibility).filter((e) => !e.frame)
      const headings = headingsWhere(visibility)
      if (list.length === 0 && headings.length === 0) continue
      const parts = [`${list.length} more control${list.length === 1 ? '' : 's'}`]
      if (headings.length) parts.push(`headings: ${headings.join(', ')}`)
      tail.push(`${label}  ${parts.join(' · ')}`)
    }
    for (const [ref, away] of scrolledAway) {
      const scroller = obs.scrollers.find((candidate) => candidate.ref === ref)
      const count = away.elements.filter((e) => !e.frame).length
      const dir = scroller ? insideDirection(scroller, [...away.elements, ...away.texts]) : undefined
      tail.push(
        `INSIDE ${scroller ? describeScroller(scroller) : `[${ref}]`}: ${count} more control${count === 1 ? '' : 's'} and ` +
          `${away.texts.length} text block${away.texts.length === 1 ? '' : 's'} out of sight${dir ? ` — act.scroll('${dir}', { ref: ${ref} })` : ''}`,
      )
    }
    const clipped = offscreen('clipped').filter((e) => !e.frame)
    if (clipped.length) {
      const sample = clipped.slice(0, 3).map((e) => `[${e.ref}] ${e.role}${e.name ? ` ${quote(e.name, 30)}` : ''}`)
      tail.push(`CLIPPED ${clipped.length} control${clipped.length === 1 ? '' : 's'} cut off by a container around them: ${sample.join(', ')}${clipped.length > 3 ? `, +${clipped.length - 3} more` : ''}`)
    }
    const sideways = offscreen('left').filter((e) => !e.frame).length + offscreen('right').filter((e) => !e.frame).length
    if (sideways) tail.push(`SIDEWAYS ${sideways} control${sideways === 1 ? '' : 's'} off to the left/right`)
    if (tail.length) tail.push('      observe({ all: true }) lists them; find("text") searches everything')
  }
  const anyNew = elements.some((e) => e.isNew) || texts.some((t) => t.isNew)
  if (anyNew) tail.push('* = new since your last observe')
  return fitToBudget(head, body, tail, maxChars, 'use observe({ scope: ref }) or find("text")')
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type ElementChange =
  | { kind: 'states'; from: string; to: string }
  | { kind: 'value'; from?: string; to?: string }
  | { kind: 'name'; from: string; to: string }
  | { kind: 'visibility'; from: Visibility; to: Visibility }

export interface ObservationDiff {
  /** The main frame loaded another document: refs, elements and text are not comparable. */
  newDocument: boolean
  url?: { from: string; to: string }
  title?: { from: string; to: string }
  added: ObservedElement[]
  removed: ObservedElement[]
  changed: Array<{ element: ObservedElement; changes: ElementChange[] }>
  textAdded: TextBlock[]
  textRemoved: TextBlock[]
  textChanged: Array<{ from: TextBlock; to: TextBlock }>
  focus?: { from?: ObservedElement; to?: ObservedElement }
  modalOpened?: NonNullable<Observation['modal']>
  modalClosed?: NonNullable<Observation['modal']>
  jsDialogOpened?: JsDialogState
  jsDialogClosed?: JsDialogState
  scrolled?: { fromY: number; toY: number }
  /**
   * Scroll areas whose own offset moved (an inner list, a sidebar, a carousel), with where each
   * was: `fromTop` Chrome's scrollTop, `fromLeft` its scrollLeft when it moved sideways.
   */
  scrolledAreas: Array<{ scroller: ObservedScroller; fromTop: number; fromLeft?: number }>
  /**
   * This many listed controls and text blocks went inert while staying in the document — the
   * accessibility tree says why (behind a modal dialog, `inert`, `aria-hidden`) — or went under a
   * modal's backdrop. They are counted, not listed as gone. Elements that left the document are
   * listed as removed, modal or not.
   */
  behindModal?: number
  /** This many controls and text blocks came back from being inert or behind a backdrop. */
  backFromModal?: number
  /** The observation after — for headers (title, url, counts) when rendering. */
  after: Observation
}

/** The visibility distinctions a diff reports: hidden↔shown and covered↔uncovered, not scrolling. */
function visibilityClass(visibility: Visibility): 'hidden' | 'covered' | 'in-view' | 'offscreen' | 'unknown' {
  if (visibility === 'hidden') return 'hidden'
  if (visibility === 'covered' || visibility === 'partly-covered') return 'covered'
  if (visibility === 'in-view') return 'in-view'
  if (visibility === 'unknown') return 'unknown'
  return 'offscreen'
}

/** The states a diff compares: the AX states but focus, and a colour input's open chooser (keys go to it then). */
function statesWithoutFocus(element: ObservedElement): string {
  const chooser = element.widget?.chooserOpen ? '[chooser open]' : ''
  if (!element.states) return chooser
  const { focused: _focused, ...rest } = element.states
  return [formatAxStates(rest, element.role).trim(), chooser].filter(Boolean).join(' ')
}

/**
 * What changed between two observations of the same tab. Whether something that is no longer
 * listed is gone, hidden or inert comes from `after.absent` (DOM presence + the accessibility
 * tree's ignored reasons), and whether something listed again had been inert from
 * `before.absent` — never inferred from a modal opening or closing.
 */
export function diffObservations(before: Observation, after: Observation): ObservationDiff {
  const diff: ObservationDiff = {
    newDocument: before.documentId !== undefined && after.documentId !== undefined && before.documentId !== after.documentId,
    added: [],
    removed: [],
    changed: [],
    textAdded: [],
    textRemoved: [],
    textChanged: [],
    scrolledAreas: [],
    after,
  }
  if (before.url !== after.url) diff.url = { from: before.url, to: after.url }
  if (before.title !== undefined && after.title !== undefined && before.title !== after.title) diff.title = { from: before.title, to: after.title }
  const dialogBefore = isDialogOpen(before.jsDialog) ? before.jsDialog : undefined
  const dialogAfter = isDialogOpen(after.jsDialog) ? after.jsDialog : undefined
  if (dialogAfter && dialogAfter.openedAt !== dialogBefore?.openedAt) diff.jsDialogOpened = dialogAfter
  if (dialogBefore && dialogBefore.openedAt !== dialogAfter?.openedAt) diff.jsDialogClosed = dialogBefore
  if (diff.newDocument || dialogAfter || dialogBefore) return diff

  const modalId = (m: Observation['modal']): string => (m ? `${m.ref ?? ''}\u0000${m.role}\u0000${m.name}` : '')
  if (modalId(before.modal) !== modalId(after.modal)) {
    if (after.modal) diff.modalOpened = after.modal
    if (before.modal) diff.modalClosed = before.modal
  }
  if (before.scroll && after.scroll && Math.abs(before.scroll.y - after.scroll.y) >= 1) diff.scrolled = { fromY: before.scroll.y, toY: after.scroll.y }
  const scrollersBefore = new Map(before.scrollers.map((scroller) => [scroller.key, scroller]))
  for (const scroller of after.scrollers) {
    const old = scrollersBefore.get(scroller.key)
    // Sideways only for an area that scrolls sideways, by Chrome's own scrollLeft: the distance from
    // the left edge of a right-to-left area also grows when content is added on its left.
    const sideways = old !== undefined && (old.horizontal || scroller.horizontal) && Math.abs(old.scrollLeft - scroller.scrollLeft) >= 1
    if (old && (Math.abs(old.scrollTop - scroller.scrollTop) >= 1 || sideways)) {
      diff.scrolledAreas.push({ scroller, fromTop: old.scrollTop, ...(sideways ? { fromLeft: old.scrollLeft } : {}) })
    }
  }

  const absentBefore = new Map(before.absent.map((item) => [item.key, item]))
  const absentAfter = new Map(after.absent.map((item) => [item.key, item]))
  let behind = 0
  let back = 0

  const beforeByKey = new Map(before.elements.map((e) => [e.key, e]))
  const afterKeys = new Set(after.elements.map((e) => e.key))
  for (const element of after.elements) {
    const old = beforeByKey.get(element.key)
    if (!old) {
      const was = absentBefore.get(element.key)
      if (was?.reason === 'inert') back++
      else if (was?.reason === 'hidden') diff.changed.push({ element, changes: [{ kind: 'visibility', from: 'hidden', to: element.visibility }] })
      else diff.added.push(element)
      continue
    }
    const changes: ElementChange[] = []
    const fromStates = statesWithoutFocus(old)
    const toStates = statesWithoutFocus(element)
    if (fromStates !== toStates) changes.push({ kind: 'states', from: fromStates, to: toStates })
    if (old.value !== element.value) changes.push({ kind: 'value', from: old.value, to: element.value })
    if (old.name !== element.name) changes.push({ kind: 'name', from: old.name, to: element.name })
    const fromClass = visibilityClass(old.visibility)
    const toClass = visibilityClass(element.visibility)
    const reportable =
      fromClass !== toClass &&
      fromClass !== 'unknown' &&
      toClass !== 'unknown' &&
      (fromClass === 'hidden' || toClass === 'hidden' || fromClass === 'covered' || toClass === 'covered')
    // Under a modal's backdrop now, or out from under it: counted with the modal, not listed.
    const underBackdrop = !!diff.modalOpened && !element.inModal && toClass === 'covered'
    const outFromBackdrop = !!diff.modalClosed && fromClass === 'covered'
    if (reportable && underBackdrop) behind++
    else if (reportable && outFromBackdrop) back++
    else if (reportable) changes.push({ kind: 'visibility', from: old.visibility, to: element.visibility })
    if (changes.length) diff.changed.push({ element, changes })
  }
  for (const element of before.elements) {
    if (afterKeys.has(element.key)) continue
    const now = absentAfter.get(element.key)
    if (now?.reason === 'inert') behind++
    else if (now?.reason === 'hidden') diff.changed.push({ element, changes: [{ kind: 'visibility', from: element.visibility, to: 'hidden' }] })
    else diff.removed.push(element)
  }

  // Text that appears hidden, or goes away while it was hidden, is no change a person notices;
  // text that changed in place is reported whatever its visibility.
  const textBefore = new Map(before.text.map((t) => [t.key, t]))
  const textAfterKeys = new Set(after.text.map((t) => t.key))
  for (const block of after.text) {
    const old = textBefore.get(block.key)
    if (old) {
      if (old.text !== block.text) diff.textChanged.push({ from: old, to: block })
    } else if (absentBefore.get(block.key)?.reason === 'inert') back++
    else if (block.visibility !== 'hidden') diff.textAdded.push(block)
  }
  for (const block of before.text) {
    if (textAfterKeys.has(block.key) || block.visibility === 'hidden') continue
    if (absentAfter.get(block.key)?.reason === 'inert') behind++
    else diff.textRemoved.push(block)
  }

  if (before.focused !== after.focused) {
    const from = before.focused !== undefined ? before.elements.find((e) => e.ref === before.focused) : undefined
    const to = after.focused !== undefined ? after.elements.find((e) => e.ref === after.focused) : undefined
    if (from || to) diff.focus = { ...(from ? { from } : {}), ...(to ? { to } : {}) }
  }
  if (behind > 0) diff.behindModal = behind
  if (back > 0) diff.backFromModal = back
  return diff
}

function shortElement(element: ObservedElement): string {
  const role = element.role === 'clickable' ? `clickable ${element.cssLabel ?? element.tag}` : element.role
  return `[${element.ref}] ${role}${element.name ? ` ${quote(element.name)}` : ''}${element.context ? ` (${element.context})` : ''}`
}

/** A text block that changed in place: how it grew (a streamed reply), or what it was. */
function describeTextChange(from: TextBlock, to: TextBlock): string {
  const now = to.text
  const was = from.text
  const live = to.live ? ` — in live region ${to.live}` : ''
  if (now.length > was.length && now.startsWith(was)) {
    const added = now.slice(was.length)
    const label = to.role === 'heading' ? 'heading' : to.role === 'listitem' ? 'item' : to.role === 'row' || to.role === 'layouttablerow' ? 'row' : 'text'
    const tail = added.length > TEXT_SHOWN_CHARS ? `…${added.slice(-(TEXT_SHOWN_CHARS - 1))}` : added
    return `~ ${label} grew by ${added.length} chars: ${quote(tail, TEXT_SHOWN_CHARS)} (now ${now.length} chars)${live}`
  }
  return `~ ${describeText({ ...to, isNew: false })} (was ${quote(was, 60)})${live}`
}

export function renderObservationDiff(diff: ObservationDiff, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? 4000
  const head: string[] = []
  const after = diff.after
  if (diff.jsDialogOpened) {
    head.push(`DIALOG opened: native ${diff.jsDialogOpened.type} ${quote(diff.jsDialogOpened.message, 300)} — the page is frozen until it is answered (act.dialog.accept() / act.dialog.dismiss())`)
  }
  if (diff.jsDialogClosed) head.push(`DIALOG closed: ${diff.jsDialogClosed.type} ${quote(diff.jsDialogClosed.message, 80)}${diff.jsDialogClosed.outcome ? ` (${diff.jsDialogClosed.outcome})` : ''}`)
  if (diff.newDocument) {
    head.push(
      `NEW DOCUMENT ${quote(after.title || '(untitled)')} · ${after.url} — the page loaded a new document; every earlier ref is gone. ` +
        `${after.counts.interactive} controls, ${after.counts.inView} in view.`,
    )
    return fitToBudget(head, [], [], maxChars, 'call observe()')
  }
  if (diff.url) head.push(`URL   ${diff.url.from} → ${diff.url.to} (same document: an in-page route change)`)
  if (diff.title) head.push(`TITLE ${quote(diff.title.from)} → ${quote(diff.title.to)}`)
  if (diff.modalOpened) head.push(`MODAL opened: ${diff.modalOpened.role}${diff.modalOpened.name ? ` ${quote(diff.modalOpened.name)}` : ''} — only its controls work now`)
  if (diff.modalClosed && !diff.modalOpened) head.push(`MODAL closed: ${diff.modalClosed.role}${diff.modalClosed.name ? ` ${quote(diff.modalClosed.name)}` : ''}`)
  if (diff.behindModal) head.push(`      ${diff.behindModal} controls and text blocks are now inert or behind it (still on the page, not gone) — observe() lists what works`)
  if (diff.backFromModal) head.push(`      ${diff.backFromModal} controls and text blocks are usable again (same refs as before)`)
  if (diff.focus) {
    head.push(`FOCUS ${diff.focus.from ? shortElement(diff.focus.from) : '(nothing listed)'} → ${diff.focus.to ? shortElement(diff.focus.to) : '(nothing listed)'}`)
  }
  if (diff.scrolled) head.push(`SCROLL page y ${Math.round(diff.scrolled.fromY)} → ${Math.round(diff.scrolled.toY)}`)
  for (const { scroller, fromTop, fromLeft } of diff.scrolledAreas) {
    const moves: string[] = []
    if (Math.abs(fromTop - scroller.scrollTop) >= 1) moves.push(`${Math.round(fromTop)} → ${Math.round(scroller.scrollTop)}px`)
    if (fromLeft !== undefined) moves.push(`sideways ${Math.round(fromLeft)} → ${Math.round(scroller.scrollLeft)}px`)
    head.push(`SCROLL [${scroller.ref}] ${scroller.role} ${quote(scroller.name, 40)} ${moves.join(', ')} (now ${scrollPosition(scroller)})`)
  }

  const absentAfter = new Map(after.absent.map((item) => [item.key, item]))
  const body: string[] = []
  type Line = { order: number; line: string }
  const lines: Line[] = []
  const liveNote = (block: TextBlock): string => (block.live ? ` — in live region ${block.live}` : '')
  for (const element of diff.added) lines.push({ order: element.order, line: `+ ${describeElement({ ...element, isNew: false }, after)} — ${describeWhere(element, after)}` })
  for (const element of diff.removed) lines.push({ order: element.order, line: `- ${shortElement(element)} (gone)` })
  for (const { element, changes } of diff.changed) {
    const parts = changes.map((change) => {
      switch (change.kind) {
        case 'states':
          return `${change.from || '(no state)'} → ${change.to || '(no state)'}`
        case 'value':
          return `value ${change.from !== undefined ? quote(change.from, 40) : '""'} → ${change.to !== undefined ? quote(change.to, 60) : '""'}`
        case 'name':
          return `name ${quote(change.from, 40)} → ${quote(change.to, 40)}`
        case 'visibility': {
          const fromClass = visibilityClass(change.from)
          const toClass = visibilityClass(change.to)
          if (toClass === 'hidden') {
            const why = absentAfter.get(element.key)?.why
            return why ? `now hidden: ${why}` : 'now hidden'
          }
          if (fromClass === 'hidden') return `now shown (${describeWhere(element, after)})`
          if (toClass === 'covered') return `now ${change.to === 'covered' ? 'covered' : 'partly covered'} by ${element.coveredBy ?? 'another element'}`
          return 'no longer covered'
        }
      }
    })
    lines.push({ order: element.order, line: `~ ${shortElement(element)}: ${parts.join('; ')}` })
  }
  for (const block of diff.textAdded) {
    lines.push({ order: block.order, line: `+ ${describeText({ ...block, isNew: false })}${ON_SCREEN[block.visibility] ? '' : ` — ${describeWhere(block, after)}`}${liveNote(block)}` })
  }
  for (const { from, to } of diff.textChanged) lines.push({ order: to.order, line: describeTextChange(from, to) })
  for (const block of diff.textRemoved) {
    const hidden = absentAfter.get(block.key)?.reason === 'hidden'
    lines.push({ order: block.order, line: `- ${describeText({ ...block, isNew: false })}${hidden ? ' (now hidden)' : ''}` })
  }
  lines.sort((a, b) => a.order - b.order)
  for (const { line } of lines) body.push(line)

  if (head.length === 0 && body.length === 0) return ''
  return fitToBudget(head, body, [], maxChars, 'call observe() for the full page')
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

/** The part of `text` around the first query term, with how much was left out on each side. */
function excerpt(text: string, terms: string[]): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= TEXT_SHOWN_CHARS) return quote(clean, TEXT_SHOWN_CHARS)
  const lower = clean.toLowerCase()
  const at = Math.max(0, lower.indexOf(terms[0]))
  const start = Math.max(0, at - FIND_CONTEXT_CHARS)
  const end = Math.min(clean.length, at + terms[0].length + FIND_CONTEXT_CHARS)
  const before = start > 0 ? `(${start} chars before) ` : ''
  const after = end < clean.length ? ` (+${clean.length - end} chars)` : ''
  return `${before}"${start > 0 ? '…' : ''}${clean.slice(start, end).replace(/"/g, '\\"')}${end < clean.length ? '…' : ''}"${after}`
}

/**
 * The page's own words in a repeated control's context: `under heading "Shipping address"` →
 * `Shipping address`. The context is one of `assignContexts`' templates — `in <role> "…"`,
 * `under heading "…"`, `after "…"`, `<ordinal> of <n>` — whose framing words are observe()'s, not
 * the page's, so find() must not match them (find("head") matched every control under a heading).
 * The framing holds no quote, so the first and last quotes delimit the page's words exactly.
 */
function contextWords(context: string | undefined): string | undefined {
  if (context === undefined) return undefined
  const open = context.indexOf('"')
  const close = context.lastIndexOf('"')
  return open !== -1 && close > open ? context.slice(open + 1, close) : undefined
}

export function findInObservation(obs: Observation, query: string, options: { limit?: number } = {}): string {
  const limit = options.limit ?? 20
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return 'find(): the query is empty — pass the words you are looking for, e.g. find("checkout").'
  const matches = (haystack: Array<string | undefined>): boolean => {
    const text = haystack.filter(Boolean).join(' ').replace(/\s+/g, ' ').toLowerCase()
    return terms.every((term) => text.includes(term))
  }
  const lines: string[] = []
  let total = 0
  const iframeRefOf = new Map(obs.elements.flatMap((e) => (e.frame ? [[e.frame.frameId, e.ref] as const] : [])))
  const inIframe = (item: { frameId: string }): string => (iframeRefOf.has(item.frameId) ? ` · in iframe [${iframeRefOf.get(item.frameId)}]` : '')
  for (const element of obs.elements) {
    const role = element.role === 'clickable' ? `clickable ${element.cssLabel ?? element.tag}` : element.role
    const behind = obs.modal && !element.inModal ? ' (behind the modal)' : ''
    if (matches([role, element.name, element.value, element.href, contextWords(element.context), element.region])) {
      total++
      if (lines.length < limit) {
        const nameExcerpt = element.name.length > NAME_MAX_CHARS && matches([element.name]) ? ` — name ${excerpt(element.name, terms)}` : ''
        lines.push(`  ${describeElement({ ...element, isNew: false }, obs)}${nameExcerpt} — ${describeWhere(element, obs)}${behind}${element.region ? ` · ${element.region}` : ''}${inIframe(element)}`)
      }
      continue
    }
    // A drop-down's choices are searched as what they are: options of that control.
    const options = (element.options ?? []).filter((option) => matches([option.label]))
    if (options.length === 0) continue
    total += options.length
    for (const option of options) {
      if (lines.length >= limit) break
      lines.push(
        `  option ${quote(option.label)}${option.disabled ? ' (disabled)' : ''} of [${element.ref}] ${element.role}${element.name ? ` ${quote(element.name)}` : ''} — ` +
          `act.select(${element.ref}, ${quote(option.label)}) · ${describeWhere(element, obs)}${behind}`,
      )
    }
  }
  for (const block of obs.text) {
    if (!matches([block.text])) continue
    total++
    if (lines.length >= limit) continue
    const label = block.role === 'heading' ? 'heading' : block.role === 'listitem' ? 'item' : block.role === 'row' || block.role === 'layouttablerow' ? 'row' : 'text'
    lines.push(`  ${label}: ${excerpt(block.text, terms)} — ${describeWhere(block, obs)}${block.region ? ` · ${block.region}` : ''}${block.live ? ` · live region ${block.live}` : ''}${inIframe(block)}`)
  }
  if (total === 0) {
    return `No match for ${quote(query)} among the ${obs.elements.length} controls and ${obs.text.length} text blocks observe() lists on this page (off-screen ones included; whole texts searched).`
  }
  const header = `${total} match${total === 1 ? '' : 'es'} for ${quote(query)}:`
  const more = total > lines.length ? [`  … ${total - lines.length} more not shown (find(query, { limit }) to see more)`] : []
  return [header, ...lines, ...more].join('\n')
}
