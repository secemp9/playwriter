/**
 * human-actions.ts — `act.*`: one human-like input action on an element found with observe().
 *
 * Every action follows the same order, and each step exists for a failure that weak agents made
 * against real apps:
 *
 *  1. In human mode, one action per execute() call: a second input action (or raw Playwright input
 *     before it) is refused at run time, whatever way the code reached it.
 *  2. Resolve the ref in the session's RefRegistry. A stale ref is an explicit error with a
 *     suggestion and never a silent retarget. The ref names its tab: act drives that tab.
 *  3. Fresh checks: no native dialog waits for an answer; in human mode the app is not visibly busy
 *     (aria-busy, progressbar, spinner, streaming). Acting during a busy state is how replies got
 *     interrupted and messages got posted twice.
 *  4. Right before the first input: a journal checkpoint, then a fresh (quiet) observation. It is
 *     the action's "before" picture, and the ref is checked against it: an element that now reads
 *     differently from what the model was shown (a button relabelled "Unfollow", a recycled list
 *     row) is refused, not clicked (time-of-check/time-of-use).
 *  5. Read the element's live state (disabled, checked) from the accessibility tree or the DOM.
 *  6. Bring the element into view the way a person does: mouse-wheel over the scroll container that
 *     clips it, not element.scrollIntoView().
 *  7. Hit-test candidate points with DOM.getNodeForLocation. If another layer covers the element the
 *     action refuses and names the cover, instead of clicking it.
 *  8. Dispatch trusted CDP input along a human pointer path (humanMouse); type key by key with a
 *     human cadence.
 *
 * Nothing is injected into the page and nothing in it is set: reads go through CDP and the isolated
 * world, which page scripts cannot see; every change is real input (pointer, wheel, keys, files
 * chosen in the file dialog the click opened, drag events of a drag the page started).
 *
 * Elements inside iframes are acted on the same way: every read goes to the session that owns the
 * element's frame (an out-of-process iframe has its own) and its isolated world; its boxes are
 * mapped to the main viewport through the iframe's position; the iframe is scrolled into view in
 * the page first; the hit test follows input routing into the iframe and refuses when something in
 * the page around it covers it; input is dispatched on the page, which routes it into the frame.
 *
 * The settle step and the "what changed" report run in the executor after the whole execute()
 * call: the report has to cover raw Playwright input too, not only act.*.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import { tabTitle, type ICDPSession } from './cdp-session.js'
import type { IsolatedWorld } from './isolated-world.js'
import type { FrameHandle, PageFrames } from './page-frames.js'
import { isNodeGoneError, withDeadline } from './isolated-world.js'
import type { RefBinding, RefRegistry, RefTarget } from './ref-registry.js'
import type { PageWatch } from './page-watch.js'
import type { DialogController } from './dialog-controller.js'
import { chooserOpener, describeOpener, type ChooserWindow, type FileChooserGate, type FileChooserRecord } from './file-chooser-gate.js'
import type { HumanMouseApi } from './human-mouse-driver.js'
import { axStatesFromNode, type AxStates } from './ax-states.js'
import { isSecretField } from './aria-snapshot.js'
import {
  ModelFacingError,
  type BusySignal,
  type JsDialogState,
  type PolicyMode,
  type SettleResult,
  type WatchCheckpoint,
  type WatchEvents,
} from './probe-types.js'
import type { Observation, ObservationDiff } from './page-observe.js'
import { MIN_CLICKABLE_SIDE, liveContext, renderObservationDiff } from './page-observe.js'
import { CLICK_LABEL_FN } from './label-control.js'

const CDP_TIMEOUT_MS = 5000
/** How long a click on an upload control may take to open its file dialog. */
const FILE_CHOOSER_TIMEOUT_MS = 4000
/** The longest single act.wait(); longer waits are act.waitForIdle()'s job, which watches the page. */
const WAIT_CAP_MS = 30_000

/** An action the agent asked for could not be done as asked. The message is for the model: specific and actionable. */
export class ActError extends ModelFacingError {
  constructor(message: string) {
    super(message)
    this.name = 'ActError'
  }
}

export type ActKind =
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'type'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'hover'
  | 'scroll'
  | 'scrollTo'
  | 'upload'
  | 'drag'
  | 'open'
  | 'back'
  | 'spaNavigate'
  | 'dialog-accept'
  | 'dialog-dismiss'
  | 'dialog-choose-files'
  | 'switchTab'
  | 'waitForIdle'
  | 'wait'

/** Actions that send input to the app. The busy guard applies to these. */
const BUSY_GUARDED_KINDS: Partial<Record<ActKind, true>> = {
  click: true,
  dblclick: true,
  fill: true,
  type: true,
  press: true,
  select: true,
  check: true,
  uncheck: true,
  upload: true,
  drag: true,
  open: true,
  back: true,
  spaNavigate: true,
}

/** Kinds that are not an action on the page: no "before" picture, and they never count as the call's one action in human mode. */
const UNCOUNTED_KINDS: Partial<Record<ActKind, true>> = { wait: true, waitForIdle: true, switchTab: true }

/** Kinds that may run while a native dialog waits for an answer. */
const DIALOG_FREE_KINDS: Partial<Record<ActKind, true>> = { 'dialog-accept': true, 'dialog-dismiss': true, wait: true, switchTab: true }

/** Kinds that may run while a file dialog waits for an answer: the ones that answer it, and those that do not touch the page. */
const FILE_DIALOG_FREE_KINDS: Partial<Record<ActKind, true>> = {
  'dialog-accept': true,
  'dialog-dismiss': true,
  'dialog-choose-files': true,
  upload: true,
  wait: true,
  waitForIdle: true,
  switchTab: true,
}

/**
 * Kinds whose input gives the page transient user activation (a press, a click, a key), which is
 * what lets it open a file dialog. Navigation by URL or history, hovering and wheel scrolling give none.
 */
const ACTIVATING_KINDS: Partial<Record<ActKind, true>> = {
  click: true,
  dblclick: true,
  fill: true,
  type: true,
  press: true,
  select: true,
  check: true,
  uncheck: true,
  upload: true,
  drag: true,
  spaNavigate: true,
}

/** Busy signal kinds that block input in human mode (strong ones only; weak ones are reported, never block). */
export const BLOCKING_BUSY_KINDS: ReadonlySet<BusySignal['kind']> = new Set(['aria-busy', 'progressbar', 'spinner', 'dom-streaming', 'network-streaming'])

/**
 * CDP resource types the page is built from or talks to: a failure in one of these is something a
 * user can see or feel. The rest (`Other` — e.g. the browser's own favicon fetch —, Ping, Prefetch,
 * CSPViolationReport, Preflight whose real request is reported on its own) are counted, not listed.
 */
const PAGE_DEPENDENCY_TYPES: Record<string, true> = {
  Document: true,
  Stylesheet: true,
  Image: true,
  Media: true,
  Font: true,
  Script: true,
  TextTrack: true,
  XHR: true,
  Fetch: true,
  EventSource: true,
  WebSocket: true,
}

/** The element an action was done on, as the model reads it. */
export interface RecordTarget {
  ref: number
  role: string
  name: string
  context?: string
  key: string
}

export interface ActionRecord {
  kind: ActKind
  target?: RecordTarget
  /** CDP target id of the tab the action was done in. */
  targetId?: string
  /** What actually received the pointer, when a pointer was used. */
  hit?: string
  /** Typed text (masked for secrets), key, option, scroll amount, url + reason. */
  detail?: string
  ok: boolean
  error?: string
  startedAt: number
  /** When the action's last input ended: the origin the settle step measures from. */
  endedAt: number
  notes: string[]
  /** Filled in by the executor after the settle + diff: did anything visible change? */
  effect?: 'changed' | 'no-change'
  /** waitForIdle only. */
  settle?: SettleResult
  /**
   * Input actually reached the page (pointer moved, wheel, keys, files, navigation, a dialog
   * answered). An action refused before that point changed nothing, so its report is only the
   * refusal: no settle, no diff a model could mistake for the action's effect.
   */
  dispatched?: boolean
  /**
   * Data-changing requests this action caused (`POST /api/messages`): non-GET requests that started
   * between this action and the next one, filled in by the executor from the network journal. The
   * repeat guard reads it: doing the same thing again would send them again.
   */
  mutations?: string[]
  /**
   * The page right before this action's first input (a fresh observation taken at dispatch time;
   * for act.dialog.* the last full observation, since the page is frozen). Absent for waits.
   */
  before?: Observation
  /** The page's journal position right before this action's first input (taken before `before`). */
  checkpoint?: WatchCheckpoint
  /**
   * What the repeat guards compare when the action has no ref of its own: the focused element and
   * key for a press, the scroller and direction for a scroll.
   */
  repeatKey?: string
  /** scroll only: how far the scroller moved, in CSS px (0 when it did not move). */
  scrollMoved?: number
}

/** What act needs from the executor's per-page probe. The executor's PageProbe satisfies it structurally. */
export interface ActProbe {
  cdp: ICDPSession
  world: IsolatedWorld
  /** Every frame of the page: the session and isolated world each ref's node lives in, and where the frame is on screen. */
  frames: PageFrames
  watch: PageWatch
  dialogs: DialogController
  /** Every act record on this page, across execute() calls (duplicate and loop guards read it). */
  history: ActionRecord[]
  /** CDP target id of the tab. */
  targetId: string
  /** The latest observation of this page that was not taken under a native dialog (shown or quiet). */
  lastFullObservation: Observation | null
  /** The tab's file dialogs: held back while an input of ours can open one, open until answered. */
  fileChoosers: FileChooserGate
}

export interface ActDeps {
  getPage: () => Page
  /** Make `page` the controlled page (act switched to a ref's tab, or act.switchTab). */
  setPage: (page: Page) => void
  /** The open tabs in observe()'s order: index i here is tab i of its TABS list. */
  listTabs: () => Page[]
  /** The open page of a CDP target id, or null when that tab is closed. */
  pageOf: (targetId: string) => Page | null
  getProbe: (page: Page) => Promise<ActProbe>
  /** The session's refs, every tab included. */
  registry: RefRegistry
  humanMouse: HumanMouseApi
  mode: PolicyMode
  /** Aborted when the enclosing execute() call times out: no further input may be dispatched. */
  signal: AbortSignal
  /** Epoch ms when the enclosing execute() call times out. Typing that cannot fit is refused up front. */
  deadlineAt: number
  /** Session cwd, for resolving upload paths. */
  cwd: string
  /** The executor reads these after the code finished. */
  records: ActionRecord[]
  /** Raw Playwright input/navigation that reached the page in this execute() call, as short labels. */
  rawActions: string[]
  /**
   * Raised while an act method runs. The executor's raw-input tap sees every Playwright mouse
   * and keyboard call, including the ones act makes itself, and uses this to tell them apart.
   */
  activity: { depth: number }
  /** A fresh observation of the page that updates ref liveness only: it does not count as the model's look. */
  observeQuietly: (page: Page) => Promise<Observation>
}

export interface ClickOptions {
  /** Act even though the page shows a strong busy signal (only when acting during loading IS the test). */
  whileBusy?: boolean
  /** Repeat an action on the same element although its last run sent data-changing requests. */
  again?: boolean
  button?: 'left' | 'right' | 'middle'
}

export interface FillOptions {
  whileBusy?: boolean
  /** Required to type into a secret field (password, one-time code, card number) outside localhost: the user gave this secret for this site. */
  secretFromUser?: boolean
  /**
   * Insert the text in one go as IME text (Chrome's Input.insertText: `beforeinput`/`input` with
   * inputType insertText) instead of key by key. It is NOT a paste: no `paste` event fires, so an
   * app that handles pasting (rich editors, input masks, length checks) behaves differently than
   * for a person's Ctrl+V. For long text a person would not type.
   */
  paste?: boolean
}

export interface ActApi {
  click(ref: number | string, options?: ClickOptions): Promise<ActionRecord>
  dblclick(ref: number | string, options?: ClickOptions): Promise<ActionRecord>
  /**
   * Replace a field's text. Native date/time inputs take ISO text (`2024-05-01`, `13:45`,
   * `2024-05-01T13:45`, `2024-05`, `2024-W18`), typed digit by digit into the field's parts; a range
   * input takes a number, reached with the arrow keys.
   */
  fill(ref: number | string, text: string, options?: FillOptions): Promise<ActionRecord>
  type(ref: number | string, text: string, options?: FillOptions): Promise<ActionRecord>
  press(key: string, options?: { ref?: number | string; whileBusy?: boolean; again?: boolean }): Promise<ActionRecord>
  select(ref: number | string, option: string, options?: { whileBusy?: boolean }): Promise<ActionRecord>
  check(ref: number | string, options?: { whileBusy?: boolean }): Promise<ActionRecord>
  uncheck(ref: number | string, options?: { whileBusy?: boolean }): Promise<ActionRecord>
  hover(ref: number | string): Promise<ActionRecord>
  /** Without a ref: what the wheel scrolls in the middle of the screen (an app shell's list, or the page). */
  scroll(direction?: 'down' | 'up', options?: { screens?: number; ref?: number | string }): Promise<ActionRecord>
  scrollTo(ref: number | string): Promise<ActionRecord>
  upload(ref: number | string, files: string | string[], options?: { whileBusy?: boolean }): Promise<ActionRecord>
  drag(fromRef: number | string, toRef: number | string, options?: { whileBusy?: boolean }): Promise<ActionRecord>
  open(url: string, options?: { reason?: string }): Promise<ActionRecord>
  back(): Promise<ActionRecord>
  spaNavigate(pathOrUrl: string): Promise<ActionRecord>
  /** Work in tab `index` of observe()'s TABS list from now on. Not an action on the page. */
  switchTab(index: number): Promise<ActionRecord>
  waitForIdle(options?: { timeoutMs?: number; quietMs?: number }): Promise<ActionRecord>
  wait(ms: number, options?: { reason?: string }): Promise<ActionRecord>
  dialog: {
    accept(promptText?: string): Promise<ActionRecord>
    /** Answers a native dialog with Cancel, or cancels an open file dialog. */
    dismiss(): Promise<ActionRecord>
    /** Choose files (paths relative to the session cwd) in the file dialog that is open on the tab. */
    chooseFiles(files: string | string[]): Promise<ActionRecord>
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function isLoopbackHost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

export function isBlankUrl(url: string): boolean {
  return url === '' || url === 'about:blank' || url.startsWith('chrome://newtab') || url.startsWith('chrome://new-tab-page') || url.startsWith('edge://newtab')
}

function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

function describeBinding(binding: RefBinding): string {
  return `${binding.role}${binding.name ? ` "${binding.name}"` : ''}`
}

function describeTarget(target: RefTarget): string {
  return `[${target.ref}] ${describeBinding(target)}${target.context ? ` (${target.context})` : ''}`
}

function targetSummary(target: RefTarget): RecordTarget {
  return { ref: target.ref, role: target.role, name: target.name, ...(target.context !== undefined ? { context: target.context } : {}), key: target.key }
}

function maskIfSecret(text: string, secret: boolean): string {
  if (secret) return text ? '••••' : ''
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dialogNote(dialog: JsDialogState): string {
  return `a native ${dialog.type} dialog opened: "${dialog.message}" — the page is frozen until it is answered (act.dialog.accept() / act.dialog.dismiss())`
}

/** Attribute `name` of a CDP DOM node, or undefined. */
function attributeOf(node: Protocol.DOM.Node, name: string): string | undefined {
  const attributes = node.attributes ?? []
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i] === name) return attributes[i + 1]
  }
  return undefined
}

/** The nodes of `node`'s user-agent shadow tree (a native control's built-in parts), in document order. */
function userAgentParts(node: Protocol.DOM.Node): Protocol.DOM.Node[] {
  const parts: Protocol.DOM.Node[] = []
  const walk = (current: Protocol.DOM.Node): void => {
    parts.push(current)
    for (const child of current.children ?? []) walk(child)
  }
  for (const root of node.shadowRoots ?? []) {
    if (root.shadowRootType === 'user-agent') walk(root)
  }
  return parts
}

// In-world functions. They run in the isolated world as `fn(args, ...elements)` and only READ.
// An element that is gone arrives as null (or is no longer connected): they return null for it.

/** Label a node the way a person would refer to it: role/aria-label/id/class plus a little text. */
const DESCRIBE_FN = `function(_, el) {
  if (!el) return null
  const describe = (n) => {
    if (!n || n.nodeType !== 1) return n && n.nodeName ? n.nodeName.toLowerCase() : '?'
    const tag = n.tagName.toLowerCase()
    const role = n.getAttribute('role')
    const label = n.getAttribute('aria-label') || n.getAttribute('title') || ''
    const id = n.id ? '#' + n.id : ''
    const cls = typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''
    const text = (n.innerText || n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
    const head = role ? role + (label ? ' "' + label + '"' : '') : tag + id + cls
    return head + (!label && text ? ' "' + text + '"' : '')
  }
  let layer = null
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const role = n.getAttribute('role')
    const style = getComputedStyle(n)
    if (role === 'dialog' || role === 'alertdialog' || n.getAttribute('aria-modal') === 'true' || n.tagName === 'DIALOG' ||
        ((style.position === 'fixed' || style.position === 'sticky') && n !== el)) { layer = n; break }
  }
  return { node: describe(el), layer: layer && layer !== el ? describe(layer) : null }
}`

/** Is `hit` the target, inside it (composed tree), or the target's <label>? Null when the target is gone. */
const CONTAINS_FN = `function(_, target, hit) {
  if (!target || !target.isConnected) return null
  if (!hit) return false
  for (let n = hit; n; n = n.parentNode || n.host || null) { if (n === target) return true }
  if (target.labels) { for (const label of target.labels) { if (label === hit || label.contains(hit)) return true } }
  return false
}`

/** Whether the element is still in its document (a removed node can still be resolved until it is collected). */
const CONNECTED_FN = `function(_, el) { return !!el && el.isConnected }`

/** A labelable control's own disabled state (`:disabled` covers a disabled fieldset too). */
const DOM_DISABLED_FN = `function(_, el) {
  if (!el || !el.isConnected) return null
  return el.matches(':disabled')
}`

/**
 * Why an element that exists has no accessibility node, read from the DOM: inert, aria-hidden,
 * outside an open modal dialog, or not rendered.
 */
const ABSENCE_FN = `function(_, el) {
  if (!el || !el.isConnected) return null
  if (el.closest('[inert]')) return 'it is inside an inert part of the page (not interactive right now)'
  if (el.closest('[aria-hidden="true"]')) return 'it is inside an element marked aria-hidden'
  const modal = document.querySelector('dialog:modal')
  if (modal && !modal.contains(el)) return 'a modal dialog is open and blocks everything outside it'
  if (!el.checkVisibility({ visibilityProperty: true })) return 'it is not rendered (display:none, visibility:hidden, or inside something collapsed)'
  return 'Chrome lists no accessibility node for it, and nothing in the page says why'
}`

/**
 * Shared in-page helpers for wheel scrolling, written once and spliced into the functions below.
 *  - deepHit(x, y): what a pointer at (x, y) is over, descending open shadow roots.
 *  - scrollerFor(el, axis, dir): what a wheel turned over `el` scrolls. Chromium hands a wheel to
 *    the nearest ancestor that can still scroll in that direction (scroll chaining), ending at the
 *    document's scrolling element.
 *  - wheelPoint(area, intended, axis, dir): the first point of a 3×3 grid over `area` whose wheel
 *    would scroll `intended` — so the wheel never lands on a sticky header, a nested list or an
 *    overlay instead. Returns { point } or { blockedBy } naming what covers the area.
 */
const WHEEL_HELPERS = `
  const deepHit = (x, y) => {
    let el = document.elementFromPoint(x, y)
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner }
    return el
  }
  const overflowScrolls = (value) => /(auto|scroll|overlay)/.test(value)
  const scrollerFor = (el, axis, dir) => {
    const doc = document.scrollingElement || document.documentElement
    for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
      if (n === document.body || n === document.documentElement) return doc
      const s = getComputedStyle(n)
      if (axis === 'y' && overflowScrolls(s.overflowY) && n.scrollHeight > n.clientHeight + 1) {
        if (dir > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0) return n
      }
      if (axis === 'x' && overflowScrolls(s.overflowX) && n.scrollWidth > n.clientWidth + 1) {
        if (dir > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0) return n
      }
    }
    return doc
  }
  const labelOf = (n) => !n || n.nodeType !== 1 ? 'nothing' : (n.getAttribute('role') ? n.getAttribute('role') : n.tagName.toLowerCase()) + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + (n.getAttribute('aria-label') ? ' "' + n.getAttribute('aria-label') + '"' : '')
  const wheelPoint = (area, intended, axis, dir) => {
    const xs = [0.5, 0.25, 0.75], ys = [0.5, 0.25, 0.75]
    let blocker = null
    for (const fy of ys) for (const fx of xs) {
      const x = area.x + area.width * fx, y = area.y + area.height * fy
      const hit = deepHit(x, y)
      if (!hit) continue
      // A wheel over an iframe goes to the document inside it first, which this world cannot see.
      if (hit.localName === 'iframe' || hit.localName === 'frame') { if (!blocker) blocker = hit; continue }
      if (scrollerFor(hit, axis, dir) === intended) return { point: { x, y } }
      if (!blocker) blocker = hit
    }
    return { blockedBy: labelOf(blocker) }
  }
`

/**
 * Where to wheel so `el` comes into view: the innermost scroll container that clips it, or the
 * page. "In view" means at least half of the element (or half of the visible area, for an element
 * taller than that) is visible. dy/dx aim to put the element about a third of the way into the
 * visible area, the way a person scrolls to read something rather than parking it on the edge; an
 * element taller than two thirds of the area gets its top edge brought in instead. Also returns the
 * hit-tested point to wheel at (see WHEEL_HELPERS).
 */
const SCROLL_PLAN_FN = `function(_, el) {
  if (!el || !el.isConnected) return null
  ${WHEEL_HELPERS}
  const r = el.getBoundingClientRect()
  const need = (start, end, areaStart, areaEnd) => {
    const size = end - start, area = areaEnd - areaStart
    const visible = Math.min(end, areaEnd) - Math.max(start, areaStart)
    if (visible >= Math.min(size, area * 0.5) - 1) return 0
    return size > area * 0.66 ? (start - areaStart) - 16 : (start - areaStart) - area / 3
  }
  const vw = window.innerWidth, vh = window.innerHeight
  const clipToViewport = (c) => {
    const x = Math.max(c.left, 0), y = Math.max(c.top, 0)
    const right = Math.min(c.right, vw), bottom = Math.min(c.bottom, vh)
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
  }
  const plan = (scroller, area, dy, dx, label) => {
    const axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x'
    const dir = Math.sign(axis === 'y' ? dy : dx)
    return { container: area, dy, dx, label, ...wheelPoint(area, scroller, axis, dir) }
  }
  // Walk outwards. A scroller that is itself out of sight cannot be wheeled; a person first
  // scrolls what contains IT, so its rect becomes the thing to bring into view one level up.
  let target = r
  for (let n = el.parentElement || (el.getRootNode().host ?? null); n && n !== document.body && n !== document.documentElement; n = n.parentElement || (n.getRootNode().host ?? null)) {
    const s = getComputedStyle(n)
    const canY = overflowScrolls(s.overflowY) && n.scrollHeight > n.clientHeight + 1
    const canX = overflowScrolls(s.overflowX) && n.scrollWidth > n.clientWidth + 1
    if (!canY && !canX) continue
    const c = n.getBoundingClientRect()
    const dy = canY ? need(target.top, target.bottom, c.top, c.bottom) : 0
    const dx = canX ? need(target.left, target.right, c.left, c.right) : 0
    if (dy === 0 && dx === 0) continue
    const area = clipToViewport(c)
    if (area) return plan(n, area, dy, dx, labelOf(n))
    target = c
  }
  const dy = need(target.top, target.bottom, 0, vh), dx = need(target.left, target.right, 0, vw)
  if (dy === 0 && dx === 0) return { container: null, dy, dx, label: 'page' }
  return plan(document.scrollingElement || document.documentElement, { x: 0, y: 0, width: vw, height: vh }, dy, dx, 'page')
}`

/**
 * `fn({ dir, x, y })`: what a wheel turned at (x, y) of this frame's viewport (its centre when
 * absent) is over, and what Chromium's scroll chaining scrolls from there in this document — the
 * nearest ancestor that can still scroll that way, else the document's scrolling element. Returned
 * as [hit, scroller] (nodesReturnedBy); the hit tells whether the point is over an iframe.
 */
const SCROLLER_AT_POINT_FN = `function(args) {
  ${WHEEL_HELPERS}
  const hit = deepHit(args.x === undefined ? window.innerWidth / 2 : args.x, args.y === undefined ? window.innerHeight / 2 : args.y)
  return [hit, hit ? scrollerFor(hit, 'y', args.dir) : (document.scrollingElement || document.documentElement)]
}`

/**
 * Where to turn the wheel to scroll `el` vertically (the document's scrolling element, <html> or
 * <body> mean the page). `atEnd`: it cannot scroll further that way; `scrollable: false`: it does
 * not scroll at all. Null when `el` is gone.
 */
const WHEEL_POINT_FN = `function(args, el) {
  ${WHEEL_HELPERS}
  if (!el || !el.isConnected) return null
  const vw = window.innerWidth, vh = window.innerHeight
  const doc = document.scrollingElement || document.documentElement
  if (el === doc || el === document.documentElement || el === document.body) {
    const atEnd = args.dir > 0 ? doc.scrollTop + vh >= doc.scrollHeight - 1 : doc.scrollTop <= 0
    return { ...wheelPoint({ x: 0, y: 0, width: vw, height: vh }, doc, 'y', args.dir), label: 'the page', atEnd, scrollable: doc.scrollHeight > vh + 1 }
  }
  const s = getComputedStyle(el)
  const scrollable = overflowScrolls(s.overflowY) && el.scrollHeight > el.clientHeight + 1
  const atEnd = !scrollable || (args.dir > 0 ? el.scrollTop + el.clientHeight >= el.scrollHeight - 1 : el.scrollTop <= 0)
  const c = el.getBoundingClientRect()
  const x = Math.max(c.left, 0), y = Math.max(c.top, 0), right = Math.min(c.right, vw), bottom = Math.min(c.bottom, vh)
  if (right <= x || bottom <= y) return { offscreen: true, label: labelOf(el), atEnd, scrollable }
  if (atEnd) return { label: labelOf(el), atEnd, scrollable }
  return { ...wheelPoint({ x, y, width: right - x, height: bottom - y }, el, 'y', args.dir), label: labelOf(el), atEnd, scrollable }
}`

/** Vertical scroll state of `el` (the document's scrolling element, <html> or <body> mean the page), in CSS px. */
const SCROLL_OFFSET_FN = `function(_, el) {
  if (!el || !el.isConnected) return null
  const doc = document.scrollingElement || document.documentElement
  const page = el === doc || el === document.documentElement || el === document.body
  const s = page ? doc : el
  return { top: s.scrollTop, height: s.scrollHeight, client: page ? window.innerHeight : s.clientHeight }
}`

/** The deeply focused element (through open shadow roots), as a one-element array (nodesReturnedBy). */
const FOCUSED_FN = `function() {
  let active = document.activeElement
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement
  return [active]
}`

/** What SCROLL_PLAN_FN returns: where to wheel (`point`), or what is in the way (`blockedBy`). */
interface ScrollPlan {
  /** The visible area of the scroller to wheel over; null when nothing needs scrolling. */
  container: Rect | null
  dy: number
  dx: number
  label: string
  point?: Point
  blockedBy?: string
}

/** What WHEEL_POINT_FN returns. */
interface WheelAim {
  label: string
  point?: Point
  blockedBy?: string
  /** The container itself is outside the visible page. */
  offscreen?: true
  /** It cannot scroll further in the asked direction. */
  atEnd: boolean
  /** It scrolls at all (overflow that scrolls, with more content than fits). */
  scrollable: boolean
}

interface ScrollOffset {
  top: number
  height: number
  client: number
}

/** What FIELD_FN reports about a field right before and after typing into it. */
interface FieldFacts {
  tag: string
  type: string
  /** A text field act.fill/act.type type into key by key. */
  editable: boolean
  contentEditable: boolean
  /** `value` for inputs/textareas, innerText for contenteditable, null otherwise. */
  value: string | null
  /** Whether keyboard focus is in this field (deep through shadow roots). */
  focused: boolean
  /** Where focus actually is, labelled for the model. */
  activeLabel: string
  autocomplete: string
  /** Computed `-webkit-text-security` ('none' when the text is shown). */
  textSecurity: string
  disabled: boolean
  readOnly: boolean
}

/**
 * Field facts needed for typing: kind, current value, focus. Native date/time, range and colour
 * inputs are not text fields: act.fill drives each the way its own UI takes input.
 */
const FIELD_FN = `function(_, el) {
  if (!el || !el.isConnected) return null
  const active = (() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a })()
  const focused = !!active && (active === el || el.contains(active) || (el.shadowRoot && el.shadowRoot.contains(active)))
  const tag = el.tagName ? el.tagName.toLowerCase() : ''
  const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase()
  const notText = ['checkbox','radio','button','submit','reset','file','image','range','color','hidden','date','time','datetime-local','month','week']
  const editable = el.isContentEditable || tag === 'textarea' || (tag === 'input' && !notText.includes(type))
  const value = 'value' in el && typeof el.value === 'string' ? el.value : (el.isContentEditable ? el.innerText : null)
  const describe = (n) => n ? (n.tagName ? n.tagName.toLowerCase() : n.nodeName) + (n.id ? '#' + n.id : '') + (n.getAttribute && n.getAttribute('aria-label') ? ' "' + n.getAttribute('aria-label') + '"' : '') : 'nothing'
  return {
    tag, type, editable, contentEditable: !!el.isContentEditable, value, focused, activeLabel: describe(active),
    autocomplete: (el.getAttribute && el.getAttribute('autocomplete')) || '',
    textSecurity: getComputedStyle(el).webkitTextSecurity || 'none',
    disabled: !!el.disabled, readOnly: !!el.readOnly,
  }
}`

/** What a native `<select>` holds and where the wanted option is, counted the way arrow keys move. */
interface SelectPlan {
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
  /** Arrow presses from the selected option to the wanted one; disabled options are skipped, as the keys skip them. */
  steps?: number
  /** `multiple`, or `size > 1`: a list box drawn in the page, not a popup. */
  listBox?: boolean
}

/**
 * Native `<select>`: the one option matching `args.option` — its label, text or value exactly,
 * else the same words ignoring case and spacing — and how to reach it from the keyboard. Several
 * matches are reported, never resolved by picking the first. Reads only.
 */
const SELECT_PLAN_FN = `function(args, el) {
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
  const unusable = (o) => o.disabled || (o.parentElement && o.parentElement.localName === 'optgroup' && o.parentElement.disabled)
  if (unusable(target)) return { error: 'disabled-option', label: labelOf(target), available: options.map(labelOf) }
  const usable = options.filter((o) => !unusable(o))
  const current = el.selectedIndex >= 0 ? options[el.selectedIndex] : null
  const from = current ? usable.indexOf(current) : -1
  return { label: labelOf(target), index: options.indexOf(target), before: current ? labelOf(current) : '', steps: usable.indexOf(target) - from, listBox: el.multiple || el.size > 1 }
}`

/** A native `<select>` now: the selected option's index and label, and whether its popup is open. */
const SELECT_STATE_FN = `function(_args, el) {
  if (!el || !el.isConnected) return null
  return { index: el.selectedIndex, selected: el.selectedIndex >= 0 ? (el.options[el.selectedIndex].label || el.options[el.selectedIndex].text) : '', open: el.matches(':open') }
}`

/** `fn(args, select)`: option number `args.index` as a one-element array (for a list box click). */
const SELECT_OPTION_NODE_FN = `function(args, el) {
  if (!el || !el.isConnected) return []
  const option = el.options[args.index]
  return option ? [option] : []
}`

/** A native checkbox/radio's own state; null for any other element (ARIA widgets report through AX). */
const NATIVE_TOGGLE_FN = `function(_args, el) {
  if (!el || !el.isConnected || el.localName !== 'input' || (el.type !== 'checkbox' && el.type !== 'radio')) return null
  return { checked: el.checked, mixed: el.indeterminate, disabled: el.disabled }
}`

/** The file input an upload control stands for: itself, or the input its <label> is for; `multiple` of it, null when unknown before the click. */
const FILE_INPUT_FN = `function(_args, el) {
  if (!el || !el.isConnected) return null
  const input = el.localName === 'input' && el.type === 'file' ? el : (el.control && el.control.localName === 'input' && el.control.type === 'file' ? el.control : null)
  return { multiple: input ? input.multiple : null }
}`

/** Names of the files a file input holds. */
const CHOSEN_FILES_FN = `function(_args, el) {
  if (!el || !el.isConnected || !el.files) return null
  return Array.from(el.files).map((file) => file.name)
}`

/** A range input's limits and value, with HTML's defaults for absent attributes (min 0, max 100, step 1). */
const RANGE_FN = `function(_args, el) {
  if (!el || !el.isConnected) return null
  const num = (text, fallback) => { const n = parseFloat(text); return Number.isFinite(n) ? n : fallback }
  const min = num(el.min, 0)
  const max = Math.max(min, num(el.max, 100))
  const step = (el.getAttribute('step') || '').toLowerCase() === 'any' ? 'any' : (num(el.step, 1) > 0 ? num(el.step, 1) : 1)
  return { min, max, step, value: parseFloat(el.value) }
}`

/** A person's typing pace: ~70ms per key on average, longer after spaces and punctuation. */
const KEY_MEAN_MS = 70

/**
 * Chrome's ignoredReasons (Accessibility.AXNode) that mean a person cannot use the element right
 * now. The other reasons (uninteresting, presentational, label containers, empty alt/text) only
 * mean the node adds nothing to the accessibility tree; the element itself is usable.
 */
const BLOCKING_IGNORED_REASONS: Record<string, string> = {
  inertElement: 'it is inert (the page made it non-interactive)',
  inertSubtree: 'it is inside an inert part of the page (not interactive right now)',
  ariaHiddenElement: 'it is marked aria-hidden',
  ariaHiddenSubtree: 'it is inside an element marked aria-hidden',
  activeModalDialog: 'a modal dialog is open and blocks everything outside it',
  activeAriaModalDialog: 'an aria-modal dialog is open and blocks everything outside it',
  activeFullscreenElement: 'another element is fullscreen and blocks everything outside it',
  notRendered: 'it is not rendered (display:none, or not laid out)',
  notVisible: 'it is invisible (visibility:hidden)',
}

// ---------------------------------------------------------------------------
// Native date/time inputs
// ---------------------------------------------------------------------------

/** The ISO form each native date/time input's value takes (what act.fill expects). */
const DATE_INPUT_FORMS: Record<string, string> = {
  date: 'YYYY-MM-DD',
  time: 'hh:mm (or hh:mm:ss, hh:mm:ss.sss)',
  'datetime-local': 'YYYY-MM-DDThh:mm',
  month: 'YYYY-MM',
  week: 'YYYY-Www',
}

const DATE_INPUT_EXAMPLES: Record<string, string> = {
  date: '2024-05-01',
  time: '13:45',
  'datetime-local': '2024-05-01T13:45',
  month: '2024-05',
  week: '2024-W18',
}

type SegmentKind = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond' | 'ampm' | 'week'

const SEGMENT_KINDS: Record<string, SegmentKind> = {
  year: 'year',
  month: 'month',
  day: 'day',
  hour: 'hour',
  minute: 'minute',
  second: 'second',
  millisecond: 'millisecond',
  ampm: 'ampm',
  week: 'week',
}

/** The parts of an ISO date/time value, and the value Chrome serializes them to. */
interface DateValue {
  parts: Partial<Record<Exclude<SegmentKind, 'ampm'>, number>>
  /** `input.value` once these parts are entered (HTML's normalized form, as Chrome writes it). */
  normalized: string
}

/** One editable part of Chrome's segmented date/time field, from its user-agent shadow tree. */
interface DateSegment {
  backendNodeId: number
  kind: SegmentKind
  /** Chrome's own label for the part (`Month`, `Hours`, `AM/PM`). */
  label: string
  min: number
  max: number
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, '0')
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** ISO weeks in `year`: 53 when it starts on a Thursday, or on a Wednesday in a leap year. */
function isoWeeksIn(year: number): number {
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay()
  const leap = daysInMonth(year, 2) === 29
  return jan1 === 4 || (leap && jan1 === 3) ? 53 : 52
}

function parseIsoDate(text: string): DateValue['parts'] | null {
  const match = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

function parseIsoTime(text: string): DateValue['parts'] | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = match[3] === undefined ? 0 : Number(match[3])
  const millisecond = match[4] === undefined ? 0 : Number(match[4].padEnd(3, '0'))
  if (hour > 23 || minute > 59 || second > 59) return null
  return { hour, minute, second, millisecond }
}

function normalizedTime(parts: DateValue['parts']): string {
  const { hour = 0, minute = 0, second = 0, millisecond = 0 } = parts
  const head = `${pad(hour, 2)}:${pad(minute, 2)}`
  if (millisecond) return `${head}:${pad(second, 2)}.${pad(millisecond, 3)}`
  return second ? `${head}:${pad(second, 2)}` : head
}

/** Parse `text` as the ISO value of a `type` input; null when it is not one. */
function parseDateValue(type: string, text: string): DateValue | null {
  switch (type) {
    case 'date': {
      const parts = parseIsoDate(text)
      return parts && { parts, normalized: `${pad(parts.year ?? 0, 4)}-${pad(parts.month ?? 0, 2)}-${pad(parts.day ?? 0, 2)}` }
    }
    case 'time': {
      const parts = parseIsoTime(text)
      return parts && { parts, normalized: normalizedTime(parts) }
    }
    case 'datetime-local': {
      const [datePart, timePart, extra] = text.split('T')
      if (timePart === undefined || extra !== undefined) return null
      const date = parseIsoDate(datePart)
      const time = parseIsoTime(timePart)
      if (!date || !time) return null
      return {
        parts: { ...date, ...time },
        normalized: `${pad(date.year ?? 0, 4)}-${pad(date.month ?? 0, 2)}-${pad(date.day ?? 0, 2)}T${normalizedTime(time)}`,
      }
    }
    case 'month': {
      const match = /^(\d{4,6})-(\d{2})$/.exec(text)
      if (!match) return null
      const [year, month] = [Number(match[1]), Number(match[2])]
      if (year < 1 || month < 1 || month > 12) return null
      return { parts: { year, month }, normalized: `${pad(year, 4)}-${pad(month, 2)}` }
    }
    case 'week': {
      const match = /^(\d{4,6})-W(\d{2})$/.exec(text)
      if (!match) return null
      const [year, week] = [Number(match[1]), Number(match[2])]
      if (year < 1 || week < 1 || week > isoWeeksIn(year)) return null
      return { parts: { year, week }, normalized: `${pad(year, 4)}-W${pad(week, 2)}` }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

/** What an act method's body works with: the tab it acts in, that tab's probe, the record, and its resolved refs. */
interface Step {
  page: Page
  probe: ActProbe
  record: ActionRecord
  /** The refs passed to run(), resolved and checked against `before`, in the same order. */
  targets: RefTarget[]
  /** The page right before the first input (absent for waits, switchTab and dialog answers). */
  before?: Observation
}

export function createActApi(deps: ActDeps): ActApi {
  const sleep = (ms: number): Promise<void> => {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    if (deps.signal.aborted) {
      reject(new ActError('Not executed: this execute() call already timed out.'))
      return promise
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ActError('Stopped: this execute() call timed out while the action was in progress.'))
    }
    const timer = setTimeout(() => {
      deps.signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    deps.signal.addEventListener('abort', onAbort, { once: true })
    return promise
  }

  const checkAbort = (): void => {
    if (deps.signal.aborted) {
      throw new ActError('Not executed: this execute() call already timed out.')
    }
  }

  const remainingMs = (): number => deps.deadlineAt - Date.now()

  async function send<T>(cdp: ICDPSession, method: string, params: object | undefined, what: string): Promise<T> {
    return (await withDeadline(cdp.send(method as never, params as never) as Promise<unknown>, CDP_TIMEOUT_MS, what)) as T
  }

  /** `rect` of a session's coordinates (see `PageFrames.sessionBox`/`box`), in main-viewport CSS px. */
  function onScreen(rect: Rect, origin: { x: number; y: number; scale: number }): Rect {
    return { x: origin.x + rect.x * origin.scale, y: origin.y + rect.y * origin.scale, width: rect.width * origin.scale, height: rect.height * origin.scale }
  }

  /**
   * The error for a node that is gone from its document. For a ref's own node the registry marks
   * the ref gone and names the re-rendered replacement when there is exactly one; a node act
   * derived from a ref (its label, an option) only says it disappeared.
   */
  function goneError(target: RefTarget): ActError {
    const own = deps.registry.refFor(target.targetId, target.frameId, target.backendNodeId)
    if (own?.ref === target.ref) return new ActError(deps.registry.markGone(target.ref))
    return new ActError(`${describeTarget(target)} disappeared from the page while acting on it. Call observe() again.`)
  }

  /** The checkpoint of the last action that reached this page: busy signals and idleness are judged from it. */
  function lastDispatched(probe: ActProbe): ActionRecord | undefined {
    return [...probe.history].reverse().find((record) => record.dispatched && record.checkpoint !== undefined)
  }

  /**
   * The element's own node in the accessibility tree, live. Nothing is substituted: a node Chrome
   * does not list, or lists as unusable (inert, aria-hidden, behind a modal, not rendered), is an
   * error naming that cause; a node that is gone marks its ref gone.
   */
  async function liveAx(probe: ActProbe, target: RefTarget): Promise<{ role: string; name: string; states: AxStates }> {
    const frame = await probe.frames.handle(target.frameId)
    let result: Protocol.Accessibility.GetPartialAXTreeResponse
    try {
      result = await send<Protocol.Accessibility.GetPartialAXTreeResponse>(
        frame.cdp,
        'Accessibility.getPartialAXTree',
        { backendNodeId: target.backendNodeId, fetchRelatives: false },
        `reading the accessibility state of ${describeTarget(target)}`,
      )
    } catch (error) {
      if (isNodeGoneError(error)) throw goneError(target)
      throw error
    }
    const node = result.nodes.find((candidate) => candidate.backendDOMNodeId === target.backendNodeId)
    if (!node) {
      try {
        await send<Protocol.DOM.DescribeNodeResponse>(frame.cdp, 'DOM.describeNode', { backendNodeId: target.backendNodeId }, `looking up ${describeTarget(target)}`)
      } catch (error) {
        if (isNodeGoneError(error)) throw goneError(target)
        throw error
      }
      const why = await frame.world.callFunctionOnNodes<string | null>([target.backendNodeId], ABSENCE_FN, {
        what: `finding out why ${describeTarget(target)} has no accessibility node`,
      })
      if (why === null) throw goneError(target)
      throw new ActError(`Not done: ${describeTarget(target)} cannot be used right now: ${why}. observe() shows what is usable.`)
    }
    if (node.ignored) {
      const blocking = (node.ignoredReasons ?? []).map((reason) => BLOCKING_IGNORED_REASONS[reason.name]).filter((why): why is string => why !== undefined)
      if (blocking.length > 0) {
        throw new ActError(`Not done: ${describeTarget(target)} cannot be used right now: ${blocking.join('; ')}. observe() shows what is usable.`)
      }
    }
    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    const name = typeof node.name?.value === 'string' ? node.name.value : ''
    return { role, name, states: axStatesFromNode(node) ?? {} }
  }

  async function viewportRect(probe: ActProbe): Promise<Rect> {
    const metrics = await send<Protocol.Page.GetLayoutMetricsResponse>(probe.cdp, 'Page.getLayoutMetrics', undefined, 'reading the viewport size')
    return { x: 0, y: 0, width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight }
  }

  /**
   * What of the main viewport shows frame `frameId`'s content: the viewport, cut down to each
   * enclosing iframe's content box (a point outside them is on the page around the iframe).
   */
  async function visibleArea(probe: ActProbe, frameId: string): Promise<Rect> {
    let area: Rect | null = await viewportRect(probe)
    for (let id: string | null = frameId; id !== null && id !== probe.frames.mainFrameId(); id = (await probe.frames.handle(id)).parentId) {
      const box = await probe.frames.box(id)
      area = area && intersectRects(area, { x: box.x, y: box.y, width: box.width * box.scale, height: box.height * box.scale })
    }
    return area ?? { x: 0, y: 0, width: 0, height: 0 }
  }

  /** Content quads in main-viewport CSS px (for a node in an iframe too); [] when the element is in its document but has no layout box. */
  async function quadsOf(probe: ActProbe, target: RefTarget): Promise<Rect[]> {
    const frame = await probe.frames.handle(target.frameId)
    try {
      return await probe.frames.contentRects(frame, target.backendNodeId, `measuring ${describeTarget(target)}`)
    } catch (error) {
      if (isNodeGoneError(error)) throw goneError(target)
      if (!/Could not compute content quads/i.test(errorMessage(error))) throw error
      // No layout box: a removed node that is still referenced answers the same way as a
      // display:none one. Whether it is still in its document tells them apart.
      const connected = await frame.world.callFunctionOnNodes<boolean>([target.backendNodeId], CONNECTED_FN, {
        what: `checking whether ${describeTarget(target)} is still on the page`,
      })
      if (!connected) throw goneError(target)
      return []
    }
  }

  async function labelNode(probe: ActProbe, frameId: string, backendNodeId: number): Promise<string> {
    const frame = await probe.frames.handle(frameId)
    const described = await frame.world.callFunctionOnNodes<{ node: string; layer: string | null } | null>([backendNodeId], DESCRIBE_FN, {
      what: 'describing the element at the click point',
    })
    if (!described) return 'an element that is gone'
    const where = frameId === probe.frames.mainFrameId() ? '' : ` (in iframe ${await probe.frames.documentUrl(frameId)})`
    return `${described.layer ? `${described.node} in ${described.layer}` : described.node}${where}`
  }

  /** The listed `<iframe>` around `target`'s frame, by the ref the last observation gave it. */
  async function iframeAround(probe: ActProbe, target: RefTarget): Promise<RefTarget> {
    const owner = await probe.frames.owner(target.frameId)
    const listed = deps.registry.refFor(target.targetId, owner.parentId, owner.backendNodeId)
    if (!listed) throw new ActError(`The iframe ${describeTarget(target)} is in is not listed right now. Call observe() again.`)
    return listed
  }

  /** The iframe of frame `frameId` whose `<iframe>` element is node `backendNodeId` there; null when that node embeds no frame. */
  async function childFrameAt(probe: ActProbe, frameId: string, backendNodeId: number): Promise<FrameHandle | null> {
    const parent = await probe.frames.handle(frameId)
    for (const child of parent.frame.childFrames()) {
      if ((await probe.frames.owner(child.frameId())).backendNodeId === backendNodeId) return await probe.frames.handle(child.frameId())
    }
    return null
  }

  /**
   * What a pointer at `point` (main viewport) is over, as Chromium routes input: the page session's
   * hit test descends into same-process iframes by itself and stops at an out-of-process iframe's
   * element, where the hit test goes on in that frame's own session at the point in its viewport.
   */
  async function hitTest(probe: ActProbe, point: Point, what: string): Promise<{ frameId: string; backendNodeId: number }> {
    let frame: FrameHandle = probe.frames.main
    let local = point
    for (;;) {
      const location = await send<Protocol.DOM.GetNodeForLocationResponse>(
        frame.cdp,
        'DOM.getNodeForLocation',
        { x: Math.round(local.x), y: Math.round(local.y), includeUserAgentShadowDOM: false },
        what,
      )
      // Only an out-of-process iframe stops the page's hit test; a same-process one was descended already.
      const inner = await childFrameAt(probe, location.frameId, location.backendNodeId)
      if (!inner?.outOfProcess) return { frameId: location.frameId, backendNodeId: location.backendNodeId }
      const box = await probe.frames.box(inner.frameId)
      local = { x: (point.x - box.x) / box.scale, y: (point.y - box.y) / box.scale }
      frame = inner
    }
  }

  /** Where keyboard focus is: the focused element, inside the focused iframe when focus is in one. */
  async function focusedNode(probe: ActProbe): Promise<{ frameId: string; backendNodeId: number } | null> {
    let frame: FrameHandle = probe.frames.main
    for (;;) {
      const [focused] = await frame.world.nodesReturnedBy([], FOCUSED_FN, { what: 'finding where keyboard focus is' })
      if (focused === undefined || focused === null) return null
      const inner = await childFrameAt(probe, frame.frameId, focused)
      if (!inner) return { frameId: frame.frameId, backendNodeId: focused }
      frame = inner
    }
  }

  /**
   * What a wheel turned in the middle of the screen scrolls, as Chromium chains it: the scroller
   * under that point in the innermost iframe there; when it cannot move that way, the one around
   * the iframe in its parent, and so on out to the page's.
   */
  async function scrollerAtCentre(probe: ActProbe, dir: number): Promise<{ frame: FrameHandle; backendNodeId: number }> {
    const viewport = await viewportRect(probe)
    const centre = { x: viewport.width / 2, y: viewport.height / 2 }
    const chain: Array<{ frame: FrameHandle; backendNodeId: number }> = []
    let frame: FrameHandle = probe.frames.main
    let local: Point = centre
    for (;;) {
      const [hit, scroller] = await frame.world.nodesReturnedBy([], SCROLLER_AT_POINT_FN, {
        args: { dir, x: local.x, y: local.y },
        what: 'finding what the mouse wheel scrolls in the middle of the screen',
      })
      if (scroller === undefined || scroller === null) throw new ActError('The page has no document to scroll right now. Call observe() to see its state.')
      chain.push({ frame, backendNodeId: scroller })
      const inner = hit === undefined || hit === null ? null : await childFrameAt(probe, frame.frameId, hit)
      if (!inner) break
      const box = await probe.frames.box(inner.frameId)
      local = { x: (centre.x - box.x) / box.scale, y: (centre.y - box.y) / box.scale }
      frame = inner
    }
    for (const link of [...chain].reverse()) {
      const aim = await link.frame.world.callFunctionOnNodes<WheelAim | null>([link.backendNodeId], WHEEL_POINT_FN, {
        args: { dir },
        what: 'reading whether the scroll area can move',
      })
      if (aim && !aim.atEnd) return link
    }
    return chain[0]
  }

  /** Node `backendNodeId` of frame `hitFrameId` as a node of frame `frameId`: itself, the `<iframe>` there it is inside, or null when it is in neither. */
  async function asNodeOf(probe: ActProbe, hitFrameId: string, backendNodeId: number, frameId: string): Promise<number | null> {
    if (hitFrameId === frameId) return backendNodeId
    for (let id = hitFrameId; ; ) {
      const handle = await probe.frames.handle(id)
      if (handle.parentId === null) return null
      const owner = await probe.frames.owner(id)
      if (owner.parentId === frameId) return owner.backendNodeId
      id = owner.parentId
    }
  }

  /**
   * The target's position once smooth scrolling has come to rest: two equal readings 50ms apart,
   * at most ~900ms. Measuring right after a wheel event reads the start of an animation, which is
   * how a working wheel gets mistaken for one the page ignores.
   */
  async function restingPosition(probe: ActProbe, target: RefTarget): Promise<Rect | null> {
    let last: Rect | null = null
    const deadline = Date.now() + 900
    for (;;) {
      const now = (await quadsOf(probe, target))[0] ?? null
      if (!now) return null
      if (last && Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5) return now
      if (Date.now() > deadline) return now
      last = now
      await sleep(50)
    }
  }

  /**
   * Wheel until the target is in view, the way a person does: over the scroller that clips it
   * (an outer one first when that scroller is itself off-screen), at a point the wheel really
   * reaches (hit-tested, so not over a sticky header or a nested list), one flick at a time.
   * There is no programmatic scroll behind this: when the page ignores the wheel the action stops
   * and says so.
   */
  async function bringIntoView(step: Step, target: RefTarget): Promise<{ rects: Rect[]; viewport: Rect; notes: string[] }> {
    const { page, probe, record } = step
    const notes: string[] = []
    const inIframe = target.frameId !== probe.frames.mainFrameId()
    // A person first brings the iframe itself into view (scrolling the page around it), then
    // scrolls inside it.
    if (inIframe) notes.push(...(await bringIntoView(step, await iframeAround(probe, target))).notes)
    const frame = await probe.frames.handle(target.frameId)
    const scrolled = new Map<string, number>()
    let pointerAt: Point | null = null
    let idleWheels = 0
    for (let flick = 0; flick < 40; flick++) {
      checkAbort()
      const rects = await quadsOf(probe, target)
      if (rects.length === 0) {
        throw new ActError(`${describeTarget(target)} is not rendered right now (display:none, collapsed, or zero size). observe() shows what is visible.`)
      }
      const viewport = await visibleArea(probe, target.frameId)
      const plan = await frame.world.callFunctionOnNodes<ScrollPlan | null>([target.backendNodeId], SCROLL_PLAN_FN, {
        what: `planning a scroll to ${describeTarget(target)}`,
      })
      if (!plan) throw goneError(target)
      // In an iframe the plan's "page" is the iframe's own document.
      const label = inIframe && plan.label === 'page' ? 'the iframe' : plan.label
      if (Math.abs(plan.dy) < 1 && Math.abs(plan.dx) < 1) {
        if (scrolled.size > 0) {
          notes.push(`scrolled with the mouse wheel to reach it: ${[...scrolled].map(([where, px]) => `${Math.round(px)}px in ${where}`).join(', then ')}`)
        }
        return { rects, viewport, notes }
      }
      if (!plan.point) {
        throw new ActError(
          `Cannot scroll ${label} to reach ${describeTarget(target)}: wherever a person would turn the wheel over it, the pointer ` +
            `is over ${plan.blockedBy} instead. Deal with that first (observe() shows it).`,
        )
      }
      // The plan's point is in the frame's own viewport.
      const at = inIframe ? onScreen({ ...plan.point, width: 0, height: 0 }, await probe.frames.box(target.frameId)) : plan.point
      if (!pointerAt || Math.hypot(pointerAt.x - at.x, pointerAt.y - at.y) > 4) {
        record.dispatched = true
        await deps.humanMouse.moveTo({ page, x: at.x, y: at.y })
        pointerAt = { x: at.x, y: at.y }
      }
      const before = rects[0]
      const stepY = Math.sign(plan.dy) * Math.min(Math.abs(plan.dy), randomBetween(220, 460))
      const stepX = Math.sign(plan.dx) * Math.min(Math.abs(plan.dx), randomBetween(160, 320))
      record.dispatched = true
      await page.mouse.wheel(stepX, stepY)
      const after = await restingPosition(probe, target)
      if (!after) {
        throw new ActError(`${describeTarget(target)} stopped being rendered while scrolling to it. Call observe() again.`)
      }
      const moved = Math.hypot(after.x - before.x, after.y - before.y)
      if (moved < 1) {
        idleWheels += 1
        if (idleWheels >= 2) {
          throw new ActError(
            `The page did not scroll when the mouse wheel turned over ${label} (twice), so ${describeTarget(target)} stays out of view: ` +
              'the page handles the wheel itself, or that area cannot scroll further. A person would try the keyboard ' +
              "(act.press('PageDown') once focus is in that area) or find another way to it (find()).",
          )
        }
      } else {
        idleWheels = 0
        scrolled.set(label, (scrolled.get(label) ?? 0) + moved)
      }
      await sleep(randomBetween(40, 110))
    }
    throw new ActError(
      `Could not bring ${describeTarget(target)} into view after 40 wheel flicks: it keeps moving away (an infinite list or a layout that ` +
        'shifts while scrolling). find() can say where it is now; observe() shows what loaded meanwhile.',
    )
  }

  /**
   * Choose a point on `rects` (the target, or a part of it) that the target itself receives. Tries
   * the centre of the largest visible part, then four inner points. Each point is hit-tested the way
   * input is routed (through iframes), and must land on the target or inside it — in the target's
   * own document, or in an iframe within the target. Refuses with the name of the cover otherwise:
   * something in the page around an iframe, drawn over it, covers what is inside it.
   */
  async function hitPoint(probe: ActProbe, target: RefTarget, rects: Rect[], viewport: Rect): Promise<{ point: Point; hit: string }> {
    const visible = rects
      .map((r) => intersectRects(r, viewport))
      .filter((r): r is Rect => r !== null)
      .sort((a, b) => b.width * b.height - a.width * a.height)
    if (visible.length === 0) {
      throw new ActError(`${describeTarget(target)} is outside the visible page even after scrolling.`)
    }
    const box = visible[0]
    const candidates: Point[] = [
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: box.x + box.width * 0.3, y: box.y + box.height * 0.35 },
      { x: box.x + box.width * 0.7, y: box.y + box.height * 0.35 },
      { x: box.x + box.width * 0.3, y: box.y + box.height * 0.7 },
      { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 },
    ]
    const frame = await probe.frames.handle(target.frameId)
    let cover: { frameId: string; backendNodeId: number } | null = null
    for (const candidate of candidates) {
      const hit = await hitTest(probe, candidate, `hit-testing ${describeTarget(target)}`)
      const there = await asNodeOf(probe, hit.frameId, hit.backendNodeId, target.frameId)
      if (there === target.backendNodeId) {
        return { point: candidate, hit: describeTarget(target) }
      }
      if (there !== null) {
        const inside = await frame.world.callFunctionOnNodes<boolean | null>([target.backendNodeId, there], CONTAINS_FN, {
          what: 'checking which element the click point belongs to',
        })
        if (inside === true) {
          return { point: candidate, hit: describeTarget(target) }
        }
        if (inside === null) throw goneError(target)
      }
      cover ??= hit
    }
    const coverLabel = cover !== null ? await labelNode(probe, cover.frameId, cover.backendNodeId) : 'another element'
    throw new ActError(
      `Not done: ${describeTarget(target)} is covered by ${coverLabel} at every point a person could click. ` +
        'A person would first deal with what is on top (close it, accept it, or scroll it away). observe() lists the covering layer and its controls.',
    )
  }

  async function guard(probe: ActProbe, kind: ActKind, options: { whileBusy?: boolean } = {}): Promise<void> {
    checkAbort()
    const dialog = probe.dialogs.current()
    if (dialog?.handling === 'agent' && !DIALOG_FREE_KINDS[kind]) {
      throw new ActError(
        `A native ${dialog.type}("${dialog.message}") dialog is open and blocks the page. ` +
          'Handle it first, like a person would: act.dialog.accept() or act.dialog.dismiss().',
      )
    }
    if (!FILE_DIALOG_FREE_KINDS[kind]) {
      const [fileDialog] = await probe.fileChoosers.openDialogs()
      if (fileDialog) {
        const opener = chooserOpener(probe.history, fileDialog)
        throw new ActError(
          `A file dialog is open${opener ? ` (opened by ${describeOpener(opener)})` : ''} and the page waits for it, like a person facing it: ` +
            'act.dialog.chooseFiles(path) chooses the files, act.dialog.dismiss() cancels it. Nothing else on the page can be used until then.',
        )
      }
    }
    if (deps.mode === 'human' && BUSY_GUARDED_KINDS[kind] && !options.whileBusy) {
      const signals = await probe.watch.busySignals({ since: lastDispatched(probe)?.checkpoint })
      const busy = signals.filter((s) => s.strength === 'strong' && BLOCKING_BUSY_KINDS.has(s.kind))
      if (busy.length > 0) {
        throw new ActError(
          `Not done: the page is still busy (${busy.map((s) => s.label).join('; ')}). A person waits for it to finish ` +
            'before doing anything else. Call act.waitForIdle(), read what changed, then decide. ' +
            '(Only if acting during loading IS what you are testing, pass { whileBusy: true }.)',
        )
      }
    }
  }

  /** Contract: one action per execute() call in human mode, counted at run time. */
  function oneActionPerCall(kind: ActKind): void {
    if (deps.mode !== 'human' || UNCOUNTED_KINDS[kind]) return
    const first = deps.records.find((record) => record.dispatched && !UNCOUNTED_KINDS[record.kind])
    const done = first ? actionLabel(first) : deps.rawActions[0]
    if (done === undefined) return
    throw new ActError(
      `Not done: this call already performed ${done} — one action per call in human mode. Read its report, then act again in the next call.`,
    )
  }

  function signatureOf(record: ActionRecord): string {
    return `${record.kind}|${record.repeatKey ?? `${record.target?.key ?? ''}|${record.detail ?? ''}`}`
  }

  function repeatGuard(probe: ActProbe, record: ActionRecord, again: boolean | undefined): void {
    if (deps.mode !== 'human' || again || (!record.target && record.repeatKey === undefined)) return
    const mine = signatureOf(record)
    // The action that last reached the page, waiting aside. A double post is the same data-changing
    // action twice with nothing done in between; a new message typed first makes a second Send
    // legitimate, however soon it comes.
    const previous = [...probe.history].reverse().find((r) => r.dispatched && !UNCOUNTED_KINDS[r.kind])
    // Ground truth from the network journal, not a guess from the button's label: last time this
    // exact action sent requests that change data, so running it again sends them again.
    if (previous && previous.ok && signatureOf(previous) === mine && previous.mutations?.length) {
      throw new ActError(
        `Not done: your last action was this same one (${actionLabel(record)}, ${Math.round((Date.now() - previous.endedAt) / 1000)}s ago) and it sent ` +
          `${previous.mutations.join(', ')} — requests that change data. Doing it again right away sends them again (a second message, ` +
          'order or deletion). Look at what the first one did (observe(), net.requests()); if it really failed, pass { again: true }.',
      )
    }
    const lastThree = probe.history.slice(-3)
    if (lastThree.length === 3 && lastThree.every((r) => signatureOf(r) === mine && r.effect === 'no-change')) {
      throw new ActError(
        `Not done: the same action on the same element was tried 3 times and nothing visible changed each time. ` +
          'Repeating it will not help. Try something different: explain(ref) shows what the element is wired to, find() locates alternatives, or ask the user.',
      )
    }
  }

  /** A third scroll of the same scroller in the same direction after two that moved nothing. */
  function scrollRepeatGuard(probe: ActProbe, record: ActionRecord, label: string, direction: 'down' | 'up'): void {
    if (deps.mode !== 'human') return
    const recent = probe.history.filter((r) => (r.ok || r.dispatched) && !UNCOUNTED_KINDS[r.kind]).slice(-2)
    if (recent.length === 2 && recent.every((r) => r.kind === 'scroll' && r.ok && r.repeatKey === record.repeatKey && r.scrollMoved === 0)) {
      throw new ActError(
        `Not done: the last 2 scrolls of ${label} ${direction} moved 0px each — it is at its end, or the page ignores the wheel there. ` +
          'Scrolling it again will not help: read what is on screen (observe()), find() what you are looking for, or scroll another ' +
          'area (act.scroll(direction, { ref }) with a scroll area observe() lists).',
      )
    }
  }

  /** The tab `targets` live in, made the controlled one when it is not. */
  async function pageFor(targets: RefTarget[], record: ActionRecord): Promise<Page> {
    const current = deps.getPage()
    const [first] = targets
    if (!first) return current
    const other = targets.find((target) => target.targetId !== first.targetId)
    if (other) {
      throw new ActError(`Not done: [${first.ref}] and [${other.ref}] are in different tabs; a person can only do this within one tab.`)
    }
    const page = deps.pageOf(first.targetId)
    if (!page) {
      throw new ActError(`Not done: the tab of [${first.ref}] is closed. observe() the tab you are on for its refs.`)
    }
    if (page !== current) {
      await withDeadline(page.bringToFront(), CDP_TIMEOUT_MS, `bringing the tab of [${first.ref}] to the front`)
      deps.setPage(page)
      const title = await tabTitle(page).catch(
        (error: unknown) => `(title unreadable: ${errorMessage(error).split('.')[0]})`,
      )
      record.notes.push(`switched to the tab "${title}" this ref belongs to`)
    }
    return page
  }

  /**
   * The ref now, checked against what the model was shown for it (or, for a ref it was never
   * shown, what the caller resolved). `before` was just taken, so the registry is current.
   */
  function boundTarget(ref: number | string, resolved: RefTarget, before: Observation): RefTarget {
    const resolution = deps.registry.resolve(ref)
    if (!resolution.ok) throw new ActError(resolution.error)
    const target = resolution.target
    const listed = before.elements.find((element) => element.ref === target.ref) ?? before.scrollers.find((scroller) => scroller.ref === target.ref)
    if (!listed) {
      throw new ActError(`Not done: [${target.ref}] is not among what the page shows right now. Call observe() again.`)
    }
    const shown: RefBinding = target.shown ?? { role: resolved.role, name: resolved.name, ...(resolved.context !== undefined ? { context: resolved.context } : {}) }
    if (listed.role !== shown.role || listed.name !== shown.name) {
      throw new ActError(
        `Not done: [${target.ref}] now reads ${describeBinding(listed)} (you saw ${describeBinding(shown)}). ` +
          'The page changed it since your last look; observe() and decide again.',
      )
    }
    const context = liveContext(before, target.ref, shown.context)
    if (context !== shown.context) {
      const now = context === undefined ? `is no longer ${shown.context}` : `is now ${context}`
      const was = shown.context === undefined ? 'you saw it without that' : `you saw it ${shown.context}`
      throw new ActError(
        `Not done: [${target.ref}] ${describeBinding(listed)} ${now} (${was}) — the page re-used this element for other content. ` +
          'observe() and pick the one you mean.',
      )
    }
    return target
  }

  /** Run one act method: guard, take the before-picture, check the refs, perform, record (also on failure). */
  async function run(
    kind: ActKind,
    perform: (step: Step) => Promise<void>,
    options: { refs?: Array<number | string>; whileBusy?: boolean; again?: boolean; detail?: string } = {},
  ): Promise<ActionRecord> {
    const record: ActionRecord = { kind, ok: false, startedAt: Date.now(), endedAt: 0, notes: [], detail: options.detail }
    // The executor prints every record in its report; a `return await act.click(…)` must not print it twice.
    Object.defineProperty(record, Symbol.for('nodejs.util.inspect.custom'), {
      value: () => `${recordLine(record)} (details in the report above)`,
      enumerable: false,
    })
    deps.records.push(record)
    deps.activity.depth += 1
    let probe: ActProbe | null = null
    let window: ChooserWindow | undefined
    try {
      oneActionPerCall(kind)
      const refs = options.refs ?? []
      const resolved = refs.map((ref) => {
        const resolution = deps.registry.resolve(ref)
        if (!resolution.ok) throw new ActError(resolution.error)
        return resolution.target
      })
      const page = await pageFor(resolved, record)
      probe = await deps.getProbe(page)
      record.targetId = probe.targetId
      await guard(probe, kind, options)
      let before: Observation | undefined
      if ((kind === 'dialog-accept' || kind === 'dialog-dismiss') && probe.dialogs.current()) {
        // The page is frozen by the dialog: nothing new can be read from it.
        record.checkpoint = probe.watch.checkpoint()
        record.before = probe.lastFullObservation ?? undefined
      } else if (!UNCOUNTED_KINDS[kind]) {
        // Checkpoint first: whatever happens while the picture is taken belongs to this action.
        record.checkpoint = probe.watch.checkpoint()
        before = await deps.observeQuietly(page)
        record.before = before
      }
      const targets = before ? refs.map((ref, index) => boundTarget(ref, resolved[index], before)) : resolved
      if (targets[0]) record.target = targetSummary(targets[0])
      repeatGuard(probe, record, options.again)
      // Its input can open a file dialog for as long as the activation it gives lasts: the tab holds
      // file dialogs back from before the first input until then.
      if (ACTIVATING_KINDS[kind]) window = await probe.fileChoosers.open()
      await perform({ page, probe, record, targets, before })
      record.ok = true
      return record
    } catch (error) {
      record.error = errorMessage(error)
      throw error instanceof ActError ? error : new ActError(`${kind} failed: ${record.error}`)
    } finally {
      deps.activity.depth -= 1
      record.endedAt = Date.now()
      window?.close(record.dispatched ? record.endedAt : undefined)
      if (probe) {
        probe.history.push(record)
        if (probe.history.length > 200) probe.history.splice(0, probe.history.length - 200)
      }
    }
  }

  /**
   * Wait for an input dispatch, unless it opens a native dialog the agent has to answer first.
   * While confirm/prompt/beforeunload is up the renderer is frozen, so CDP does not acknowledge the
   * input event that opened it and a plain await would hang until the call times out (Playwright
   * documents the same stall for its own click). The dispatch itself already happened; its
   * acknowledgement arrives once the dialog is answered, and is left to settle on its own. A dialog
   * the policy answers by itself (an alert) closes on its own: the dispatch is waited for.
   */
  async function untilDialog<T>(probe: ActProbe, work: Promise<T>, record: ActionRecord): Promise<T | undefined> {
    let settled = false
    const finished = work.finally(() => {
      settled = true
    })
    finished.catch(() => {})
    while (!settled) {
      const dialog = probe.dialogs.current()
      if (dialog?.handling === 'agent') {
        record.notes.push(dialogNote(dialog))
        return undefined
      }
      await Promise.race([finished.then(() => undefined, () => undefined), sleep(30)])
    }
    return await work
  }

  /** The isolated world of the frame `target`'s node is in. */
  async function worldOf(probe: ActProbe, target: { frameId: string }): Promise<IsolatedWorld> {
    return (await probe.frames.handle(target.frameId)).world
  }

  /** The session that owns the frame `target`'s node is in (its backendNodeId means something only there). */
  async function cdpOf(probe: ActProbe, target: { frameId: string }): Promise<ICDPSession> {
    return (await probe.frames.handle(target.frameId)).cdp
  }

  /**
   * What a person points at to operate `target`: the element itself, or — for a control worked
   * through its label (observe() marks it `viaLabel`) — its first visible label, which HTML forwards
   * the click from.
   */
  async function pointerSurface(probe: ActProbe, target: RefTarget, record: ActionRecord): Promise<RefTarget> {
    if (!target.viaLabel) return target
    const [label] = await (await worldOf(probe, target)).nodesReturnedBy([target.backendNodeId], CLICK_LABEL_FN, {
      args: { min: MIN_CLICKABLE_SIDE },
      what: `finding the label of ${describeTarget(target)}`,
    })
    if (label === undefined || label === null) {
      throw new ActError(`${describeTarget(target)} is worked through its label, but no label of it is visible now. Call observe() again.`)
    }
    record.notes.push('the control itself is hidden; its label was used, as a person would')
    return { ...target, backendNodeId: label, role: `label of ${target.role}` }
  }

  /** Bring what a person points at for `target` into view and pick a point on it that reaches it. */
  async function aimAt(step: Step, target: RefTarget): Promise<Point> {
    const surface = await pointerSurface(step.probe, target, step.record)
    const { rects, viewport, notes } = await bringIntoView(step, surface)
    step.record.notes.push(...notes)
    const { point, hit } = await hitPoint(step.probe, surface, rects, viewport)
    step.record.hit = hit
    return point
  }

  /** Disabled right now: a control worked through its label by its own `:disabled`, anything else by its live accessibility state. */
  async function isDisabled(probe: ActProbe, target: RefTarget): Promise<boolean> {
    if (!target.viaLabel) return (await liveAx(probe, target)).states.disabled === true
    const disabled = await (await worldOf(probe, target)).callFunctionOnNodes<boolean | null>([target.backendNodeId], DOM_DISABLED_FN, {
      what: `reading whether ${describeTarget(target)} is disabled`,
    })
    if (disabled === null) throw goneError(target)
    return disabled
  }

  /** Press a mouse button at `point` (the pointer is already there), dialog-safe. */
  async function clickAt(step: Step, point: Point, clickCount: number, button: 'left' | 'right' | 'middle'): Promise<void> {
    checkAbort()
    step.record.dispatched = true
    const move = await untilDialog(
      step.probe,
      deps.humanMouse.click({ page: step.page, x: point.x, y: point.y, button, clickCount, delayMs: Math.round(randomBetween(45, 110)) }),
      step.record,
    )
    if (!move) return
    step.record.notes.push(`pointer travelled ${Math.round(move.distancePx)}px in ${Math.round(move.achievedDurationMs)}ms`)
    for (const warning of move.warnings) step.record.notes.push(warning)
  }

  async function clickTarget(step: Step, target: RefTarget, clickCount: number, button: 'left' | 'right' | 'middle'): Promise<Point> {
    if (await isDisabled(step.probe, target)) {
      throw new ActError(`Not done: ${describeTarget(target)} is disabled right now. A person cannot click it; something on the page must enable it first.`)
    }
    const point = await aimAt(step, target)
    await clickAt(step, point, clickCount, button)
    return point
  }

  /** A native checkbox/radio's own state (its truth even when it is hidden from the accessibility tree). */
  async function nativeToggle(probe: ActProbe, target: RefTarget): Promise<{ checked: boolean; mixed: boolean; disabled: boolean } | null> {
    return await (await worldOf(probe, target)).callFunctionOnNodes<{ checked: boolean; mixed: boolean; disabled: boolean } | null>([target.backendNodeId], NATIVE_TOGGLE_FN, {
      what: `reading the state of ${describeTarget(target)}`,
    })
  }

  /** Checked state as a person sees it: a native control's own `checked`, else the ARIA state. */
  async function checkedState(probe: ActProbe, target: RefTarget): Promise<{ checked: boolean | 'mixed' | undefined; role: string }> {
    const native = await nativeToggle(probe, target)
    if (native) return { checked: native.mixed ? 'mixed' : native.checked, role: target.role }
    const ax = await liveAx(probe, target)
    return { checked: ax.states.checked, role: ax.role }
  }

  async function typeHuman(page: Page, text: string): Promise<void> {
    for (const char of text) {
      checkAbort()
      await page.keyboard.type(char)
      const pause = /[\s,.;:!?]/.test(char) ? KEY_MEAN_MS * randomBetween(1.4, 2.6) : KEY_MEAN_MS * randomBetween(0.55, 1.35)
      await sleep(pause)
    }
  }

  /** Refuse key-by-key input that cannot finish at a person's pace before this call times out. */
  function refuseIfTooSlow(keys: number, what: string, alternative: string): void {
    const needed = Math.round(keys * KEY_MEAN_MS * 1.25) + 3000
    const left = remainingMs() - 6000
    if (needed > left) {
      throw new ActError(
        `${what} at a person's pace takes about ${Math.ceil(needed / 1000)}s, but this call has ${Math.max(0, Math.floor(left / 1000))}s left for it. ` +
          `Give the call a larger timeout (about ${Math.ceil((needed + 10_000) / 1000) * 1000} ms)${alternative}.`,
      )
    }
  }

  async function readField(probe: ActProbe, target: RefTarget): Promise<FieldFacts> {
    const field = await (await worldOf(probe, target)).callFunctionOnNodes<FieldFacts | null>([target.backendNodeId], FIELD_FN, {
      what: `reading the field ${describeTarget(target)}`,
    })
    if (!field) throw goneError(target)
    return field
  }

  /**
   * The field the caret is in after `target` was clicked at `point`: `target` itself, or the element
   * the page swapped in for it. Some pages replace a field on the click that focuses it, or while it
   * is typed into (Wikipedia's search box becomes a new combobox once its app has loaded, taking the
   * text so far and the caret): the node the model chose is gone and the caret blinks in its
   * replacement, where the pointer is. A person types there, and so does act, when focus is in an
   * enabled text field whose box holds the clicked point. The box, not a hit test: fields carry
   * decorations drawn over them (Wikipedia's search icon is hit, not the input).
   */
  async function fieldUnderCaret(
    step: Step,
    target: RefTarget,
    point: Point,
    when: 'when it was clicked' | 'while the text was typed',
  ): Promise<{ field: RefTarget; facts: FieldFacts }> {
    const own = await (await worldOf(step.probe, target)).callFunctionOnNodes<FieldFacts | null>([target.backendNodeId], FIELD_FN, {
      what: `reading the field ${describeTarget(target)}`,
    })
    if (own) return { field: target, facts: own }
    const typed = when === 'while the text was typed' ? 'The keys were typed, but the page replaced the field while they were. ' : ''
    const focused = await focusedNode(step.probe)
    if (!focused) throw new ActError(`${typed}${goneError(target).message}`)
    const replaced = (why: string): ActError => new ActError(`${typed}${goneError(target).message} Keyboard focus is now in ${why}.`)
    await deps.observeQuietly(step.page)
    const field = deps.registry.refFor(step.probe.targetId, focused.frameId, focused.backendNodeId)
    if (!field) throw replaced(`${await labelNode(step.probe, focused.frameId, focused.backendNodeId)}, which observe() does not list`)
    const facts = await readField(step.probe, field)
    if (!facts.editable) throw replaced(`${describeTarget(field)}, which is not a text field`)
    if (facts.disabled || facts.readOnly) throw replaced(`${describeTarget(field)}, which is ${facts.disabled ? 'disabled' : 'read-only'}`)
    const quads = await quadsOf(step.probe, field)
    if (!quads.some((quad) => point.x >= quad.x && point.x <= quad.x + quad.width && point.y >= quad.y && point.y <= quad.y + quad.height)) {
      throw replaced(`${describeTarget(field)}, away from where the pointer clicked`)
    }
    step.record.notes.push(`the page replaced [${target.ref}] ${when}; the caret is in ${describeTarget(field)} under the pointer, so the text went there`)
    return { field, facts }
  }

  /** A single-line field takes no newline: typed there it is the Enter key, which submits the form. */
  function refuseNewlineInInput(field: RefTarget, facts: FieldFacts, text: string): void {
    if (/[\r\n]/.test(text) && facts.tag === 'input') {
      throw new ActError(
        `Not done: ${describeTarget(field)} is a single-line field; a newline typed there is the Enter key, which submits its form. ` +
          "Fill it without the newline; if submitting is what you want, act.press('Enter') in the next call.",
      )
    }
  }

  /**
   * A secret goes only where the user said it may. It goes to the field's own document: an
   * iframe's site (a payment provider) when it is in one; an about:blank/srcdoc iframe has its
   * parent's origin (HTML).
   */
  async function refuseUntoldSecret(page: Page, probe: ActProbe, field: RefTarget, options: FillOptions): Promise<void> {
    if (deps.mode !== 'human' || options.secretFromUser) return
    let fieldFrameId: string | null = field.frameId
    let fieldUrl = await probe.frames.documentUrl(field.frameId)
    while (!/^https?:/i.test(fieldUrl) && (fieldFrameId = (await probe.frames.handle(fieldFrameId)).parentId) !== null) {
      fieldUrl = await probe.frames.documentUrl(fieldFrameId)
    }
    if (isLoopbackHost(fieldUrl)) return
    const host = URL.canParse(fieldUrl) ? new URL(fieldUrl).hostname : fieldUrl
    const pageHost = new URL(page.url()).hostname
    throw new ActError(
      `Stopped at a secret field (password, one-time code or card data) on ${host}${host !== pageHost ? ` (an iframe inside ${pageHost})` : ''}. ` +
        'A person would not type a secret here without being given it. ' +
        'Ask the user. If the user gave you this secret for this site, pass { secretFromUser: true }.',
    )
  }

  function isSecret(facts: FieldFacts): boolean {
    return isSecretField(facts.tag, facts.type, facts.autocomplete) || facts.textSecurity !== 'none'
  }

  /** Files to choose in a file dialog, as absolute paths (relative ones from the session cwd); each must exist. */
  function resolveFiles(files: string | string[]): string[] {
    const list = (Array.isArray(files) ? files : [files]).map((file) => path.resolve(deps.cwd, file))
    const missing = list.filter((file) => !fs.existsSync(file))
    if (missing.length > 0) throw new ActError(`File not found: ${missing.join(', ')}. Paths are relative to the session's working directory, ${deps.cwd}.`)
    return list
  }

  /** Choose `list` in an open file dialog, as a person picks files in it, and check that its input holds them. */
  async function chooseInDialog(step: Step, dialog: FileChooserRecord, list: string[]): Promise<void> {
    if (dialog.backendNodeId === undefined) {
      throw new ActError(
        "The open file picker was opened by the page's script without a file input (window.showOpenFilePicker): files cannot be chosen in it over this browser connection. act.dialog.dismiss() closes it.",
      )
    }
    if (!dialog.multiple && list.length > 1) {
      throw new ActError(
        `The file dialog takes one file only; you passed ${list.length}. It is still open: act.dialog.chooseFiles(path) with one file, or act.dialog.dismiss().`,
      )
    }
    step.record.dispatched = true
    await step.probe.fileChoosers.choose(dialog, list)
    const frame = await step.probe.frames.handle(dialog.frameId)
    const chosen = await frame.world.callFunctionOnNodes<string[] | null>([dialog.backendNodeId], CHOSEN_FILES_FN, { what: 'reading the chosen files' })
    if (!chosen || chosen.length !== list.length) {
      throw new ActError(`Chose ${list.length} file(s) in the file dialog, but its input holds ${chosen ? chosen.length : 'none'}: the page cleared or replaced it.`)
    }
    step.record.notes.push(`a file dialog (${dialog.multiple ? 'several files allowed' : 'one file'}): ${chosen.join(', ')} ${chosen.length === 1 ? 'was' : 'were'} chosen in it`)
  }

  /** The parts of Chrome's segmented date/time field, in the order the field shows them. */
  async function dateSegments(probe: ActProbe, target: RefTarget): Promise<DateSegment[]> {
    let node: Protocol.DOM.Node
    try {
      ;({ node } = await send<Protocol.DOM.DescribeNodeResponse>(
        await cdpOf(probe, target),
        'DOM.describeNode',
        { backendNodeId: target.backendNodeId, depth: -1, pierce: true },
        `reading the parts of ${describeTarget(target)}`,
      ))
    } catch (error) {
      if (isNodeGoneError(error)) throw goneError(target)
      throw error
    }
    const segments: DateSegment[] = []
    for (const part of userAgentParts(node)) {
      const pseudo = attributeOf(part, 'pseudo')
      if (attributeOf(part, 'role') !== 'spinbutton' || pseudo === undefined) continue
      const match = /^-webkit-datetime-edit-([a-z]+)-field$/.exec(pseudo)
      const kind = match ? SEGMENT_KINDS[match[1]] : undefined
      if (!kind) {
        throw new ActError(`${describeTarget(target)} has a part Chrome calls "${pseudo}", which act.fill cannot type into. Ask the user to set this field.`)
      }
      segments.push({
        backendNodeId: part.backendNodeId,
        kind,
        label: attributeOf(part, 'aria-label') ?? kind,
        min: Number(attributeOf(part, 'aria-valuemin')),
        max: Number(attributeOf(part, 'aria-valuemax')),
      })
    }
    return segments
  }

  /** Index of the part of a date/time field that has keyboard focus, -1 when none has. `cdp` owns the field's frame. */
  async function focusedSegment(cdp: ICDPSession, segments: DateSegment[]): Promise<number> {
    for (const [index, segment] of segments.entries()) {
      const { nodes } = await send<Protocol.Accessibility.GetPartialAXTreeResponse>(
        cdp,
        'Accessibility.getPartialAXTree',
        { backendNodeId: segment.backendNodeId, fetchRelatives: false },
        `reading which part of the field has focus`,
      )
      const node = nodes.find((candidate) => candidate.backendDOMNodeId === segment.backendNodeId)
      if (node && axStatesFromNode(node)?.focused) return index
    }
    return -1
  }

  /** The number a part of a date/time field holds now (its aria-valuenow), null when it is empty. `cdp` owns the field's frame. */
  async function segmentValue(cdp: ICDPSession, segment: DateSegment): Promise<number | null> {
    const { node } = await send<Protocol.DOM.DescribeNodeResponse>(cdp, 'DOM.describeNode', { backendNodeId: segment.backendNodeId }, `reading the ${segment.label} part`)
    const now = attributeOf(node, 'aria-valuenow')
    return now === undefined ? null : Number(now)
  }

  /** The number `segment` must hold for `value`; null when the field's part cannot represent it. */
  function wantedSegmentValue(segment: DateSegment, value: DateValue): number | null {
    const { parts } = value
    switch (segment.kind) {
      case 'hour': {
        const hour = parts.hour ?? 0
        if (segment.min === 1 && segment.max === 12) return hour % 12 || 12
        if (segment.min === 0 && segment.max === 11) return hour % 12
        if (segment.min === 0 && segment.max === 23) return hour
        if (segment.min === 1 && segment.max === 24) return hour || 24
        return null
      }
      // Chrome's AM/PM part: 1 is AM, 2 is PM.
      case 'ampm':
        return (parts.hour ?? 0) < 12 ? 1 : 2
      case 'second':
      case 'millisecond':
        return parts[segment.kind] ?? 0
      default:
        return parts[segment.kind] ?? null
    }
  }

  /**
   * A native date/time input, filled the way a person does in Chrome's segmented field: click its
   * first part, type each part's digits in the order the field shows them (the browser's locale
   * decides that order, so it is read from the field itself), move on with ArrowRight only where
   * Chrome did not move on by itself (a year can take more digits), and set AM/PM with the arrow
   * keys. The value read back must be the ISO value asked for; anything else fails the action.
   */
  async function fillDateField(step: Step, target: RefTarget, text: string, field: FieldFacts): Promise<void> {
    const { page, probe, record } = step
    const value = parseDateValue(field.type, text)
    if (!value) {
      throw new ActError(
        `${describeTarget(target)} is a native ${field.type} input: act.fill needs its value in ISO form ${DATE_INPUT_FORMS[field.type]} ` +
          `(e.g. "${DATE_INPUT_EXAMPLES[field.type]}"), not "${text}".`,
      )
    }
    record.detail = text
    const segments = await dateSegments(probe, target)
    const fieldCdp = await cdpOf(probe, target)
    if (segments.length === 0) {
      throw new ActError(`${describeTarget(target)} shows no editable parts in this browser, so there is nothing a person could type into. Ask the user to set it.`)
    }
    const kinds = new Set(segments.map((segment) => segment.kind))
    for (const [kind, label] of [['second', 'seconds'], ['millisecond', 'milliseconds']] as const) {
      if ((value.parts[kind] ?? 0) !== 0 && !kinds.has(kind)) {
        throw new ActError(`${describeTarget(target)} takes no ${label} (its step is coarser): fill it with "${text.replace(/:\d{2}(\.\d+)?$/, '')}".`)
      }
    }
    const plan = segments.map((segment) => {
      const wanted = wantedSegmentValue(segment, value)
      if (wanted === null) {
        throw new ActError(`${describeTarget(target)} has a ${segment.label} part (${segment.min}–${segment.max}) that "${text}" does not fill. Ask the user to set this field.`)
      }
      return { segment, wanted }
    })
    const keys = plan.reduce((sum, { segment, wanted }) => sum + (segment.kind === 'ampm' ? 2 : String(wanted).length + 2), 0)
    refuseIfTooSlow(keys, `Typing ${text} into the field's parts`, '')

    const { viewport } = await bringIntoView(step, target)
    const first: RefTarget = { ...target, backendNodeId: plan[0].segment.backendNodeId }
    const partRects = await quadsOf(probe, first)
    const { point, hit } = await hitPoint(probe, target, partRects, viewport)
    record.hit = hit
    await clickAt(step, point, 1, 'left')
    const advanced: string[] = []
    for (const [index, { segment, wanted }] of plan.entries()) {
      checkAbort()
      let focusedAt = await focusedSegment(fieldCdp, segments)
      if (index > 0 && focusedAt === index - 1) {
        // The previous part could still take digits (a year can have up to 6), so Chrome stayed
        // on it: a person moves on with the arrow key.
        await page.keyboard.press('ArrowRight')
        advanced.push(plan[index - 1].segment.label)
        focusedAt = await focusedSegment(fieldCdp, segments)
      }
      if (focusedAt !== index) {
        throw new ActError(
          `While filling ${describeTarget(target)}, the keyboard focus is not on its ${segment.label} part ` +
            `(${focusedAt === -1 ? 'it left the field' : `it is on the ${segments[focusedAt].label} part`}). observe() and check the field.`,
        )
      }
      if (segment.kind === 'ampm') {
        for (let presses = 0; presses < 2 && (await segmentValue(fieldCdp, segment)) !== wanted; presses++) {
          await page.keyboard.press('ArrowUp')
          await sleep(KEY_MEAN_MS * randomBetween(0.8, 1.6))
        }
      } else {
        await typeHuman(page, segment.kind === 'year' ? pad(wanted, 4) : pad(wanted, String(segment.max).length))
      }
      const now = await segmentValue(fieldCdp, segment)
      if (now !== wanted) {
        throw new ActError(
          `Typed into the ${segment.label} part of ${describeTarget(target)}, but it holds ${now ?? 'nothing'} instead of ${wanted}: ` +
            'the field rejected the input. observe() shows the field now.',
        )
      }
    }
    await sleep(randomBetween(80, 160))
    const after = await readField(probe, target)
    if (after.value !== value.normalized) {
      throw new ActError(`Filled the parts of ${describeTarget(target)}, but its value reads "${after.value ?? ''}" instead of "${value.normalized}": the page changed or rejected it.`)
    }
    record.notes.push(
      `typed it into the field's parts in their order (${segments.map((segment) => segment.label).join(', ')})` +
        `${advanced.length ? `, moving on with ArrowRight after ${advanced.join(', ')}` : ''}; value read back: "${after.value}"`,
    )
  }

  /**
   * A native range input: a person clicks its thumb (which does not move it) and steps it with the
   * arrow keys, after Home/End when that is shorter. The value read back must be the one asked for.
   */
  async function fillRange(step: Step, target: RefTarget, text: string): Promise<void> {
    const { page, probe, record } = step
    const wanted = Number(text)
    record.detail = text
    const { world, cdp } = await probe.frames.handle(target.frameId)
    const facts = await world.callFunctionOnNodes<{ min: number; max: number; step: number | 'any'; value: number } | null>([target.backendNodeId], RANGE_FN, {
      what: `reading the range of ${describeTarget(target)}`,
    })
    if (!facts) throw goneError(target)
    if (facts.step === 'any') {
      throw new ActError(`${describeTarget(target)} is a slider with step="any": its arrow keys move by amounts Chrome picks, so a person cannot set exactly ${text} with them. Ask the user to set it.`)
    }
    const stepSize = facts.step
    const top = facts.min + Math.floor((facts.max - facts.min) / stepSize + 1e-9) * stepSize
    const offGrid = Math.abs((wanted - facts.min) / stepSize - Math.round((wanted - facts.min) / stepSize)) > 1e-7
    if (text.trim() === '' || !Number.isFinite(wanted) || wanted < facts.min || wanted > top || offGrid) {
      throw new ActError(`${describeTarget(target)} is a slider from ${facts.min} to ${top} in steps of ${stepSize}; "${text}" is not one of its values.`)
    }
    const { rects, viewport } = await bringIntoView(step, target)
    let node: Protocol.DOM.Node
    try {
      ;({ node } = await send<Protocol.DOM.DescribeNodeResponse>(cdp, 'DOM.describeNode', { backendNodeId: target.backendNodeId, depth: -1, pierce: true }, `finding the thumb of ${describeTarget(target)}`))
    } catch (error) {
      if (isNodeGoneError(error)) throw goneError(target)
      throw error
    }
    const thumb = userAgentParts(node).find((part) => attributeOf(part, 'id') === 'thumb')
    const thumbRects = thumb ? await quadsOf(probe, { ...target, backendNodeId: thumb.backendNodeId }) : []
    if (thumbRects.length === 0) {
      throw new ActError(`${describeTarget(target)} shows no thumb to grab in this browser (${rects.length ? 'its track is drawn without one' : 'it is not drawn'}). Ask the user to set it.`)
    }
    const { point, hit } = await hitPoint(probe, target, thumbRects, viewport)
    record.hit = hit
    await clickAt(step, point, 1, 'left')
    const focused = await readField(probe, target)
    if (!focused.focused) {
      throw new ActError(`Clicked the thumb of ${describeTarget(target)} but the keyboard focus went to ${focused.activeLabel}. observe() and check what took focus.`)
    }
    const fromNow = await world.callFunctionOnNodes<{ value: number } | null>([target.backendNodeId], RANGE_FN, { what: `reading ${describeTarget(target)}` })
    if (!fromNow) throw goneError(target)
    const routes = [
      { start: null, presses: Math.round((wanted - fromNow.value) / stepSize) },
      { start: 'Home', presses: Math.round((wanted - facts.min) / stepSize) },
      { start: 'End', presses: Math.round((wanted - top) / stepSize) },
    ].sort((a, b) => Math.abs(a.presses) + (a.start ? 1 : 0) - (Math.abs(b.presses) + (b.start ? 1 : 0)))
    const route = routes[0]
    refuseIfTooSlow(Math.abs(route.presses) + 1, `Moving the slider ${Math.abs(route.presses)} steps`, '')
    if (route.start) {
      await page.keyboard.press(route.start)
      await sleep(KEY_MEAN_MS * randomBetween(0.8, 1.6))
    }
    const key = route.presses > 0 ? 'ArrowUp' : 'ArrowDown'
    for (let pressed = 0; pressed < Math.abs(route.presses); pressed++) {
      checkAbort()
      await page.keyboard.press(key)
      await sleep(KEY_MEAN_MS * randomBetween(0.55, 1.35))
    }
    const after = await world.callFunctionOnNodes<{ value: number } | null>([target.backendNodeId], RANGE_FN, { what: `reading ${describeTarget(target)}` })
    if (!after) throw goneError(target)
    if (Math.abs(after.value - wanted) > stepSize * 1e-6) {
      throw new ActError(`Moved the slider ${describeTarget(target)} with the keys, but it reads ${after.value} instead of ${wanted}: the page changed or rejected it.`)
    }
    record.notes.push(`moved the slider from ${fromNow.value} to ${after.value}${route.start ? ` (${route.start}, then` : ' ('}${Math.abs(route.presses)} × ${key})`)
  }

  async function fillOrType(ref: number | string, text: string, options: FillOptions, append: boolean): Promise<ActionRecord> {
    const kind: ActKind = append ? 'type' : 'fill'
    return run(
      kind,
      async (step) => {
        const { page, probe, record } = step
        const [target] = step.targets
        const before = await readField(probe, target)
        if (before.disabled || before.readOnly) {
          throw new ActError(`${describeTarget(target)} is ${before.disabled ? 'disabled' : 'read-only'}; a person cannot type into it.`)
        }
        if (before.tag === 'input' && DATE_INPUT_FORMS[before.type] !== undefined) {
          if (append) throw new ActError(`${describeTarget(target)} is a native ${before.type} input: set it with act.fill(${target.ref}, '${DATE_INPUT_EXAMPLES[before.type]}') (ISO form).`)
          await fillDateField(step, target, text, before)
          return
        }
        if (before.tag === 'input' && before.type === 'range') {
          if (append) throw new ActError(`${describeTarget(target)} is a slider: set it with act.fill(${target.ref}, '<number>').`)
          await fillRange(step, target, text)
          return
        }
        if (before.tag === 'input' && before.type === 'color') {
          throw new ActError(
            `${describeTarget(target)} is a colour input: choosing a colour opens Chrome's own colour picker, which is browser UI that page input ` +
              'cannot operate, so there is no way to set it the way a person would here. Ask the user to pick the colour.',
          )
        }
        if (!before.editable) {
          throw new ActError(`${describeTarget(target)} is not a text field (it is <${before.tag}${before.type ? ` type=${before.type}` : ''}>). Use act.click / act.select / act.check for it.`)
        }
        refuseNewlineInInput(target, before, text)
        const secret = isSecret(before)
        record.detail = maskIfSecret(text, secret)
        if (secret) await refuseUntoldSecret(page, probe, target, options)
        // Always a person's pace, never sped up to fit the call: if it does not fit, say so first.
        if (!options.paste) {
          refuseIfTooSlow(text.length, `Typing these ${text.length} characters`, ', or pass { paste: true } for text a person would paste rather than type')
        }
        const point = await clickTarget(step, target, 1, 'left')
        const { field, facts: focused } = await fieldUnderCaret(step, target, point, 'when it was clicked')
        let typedSecret = secret
        if (field !== target) {
          // The field the page swapped in gets the clicked one's refusals before a key reaches it.
          refuseNewlineInInput(field, focused, text)
          typedSecret = isSecret(focused)
          if (typedSecret) {
            record.detail = maskIfSecret(text, true)
            await refuseUntoldSecret(page, probe, field, options)
          }
        }
        if (!focused.focused) {
          throw new ActError(`Clicked ${describeTarget(target)} but the keyboard focus went to ${focused.activeLabel}, so typing would land there. observe() and check what took focus.`)
        }
        if (!append && focused.value) {
          await page.keyboard.press('ControlOrMeta+A')
          await sleep(randomBetween(60, 140))
          if (text.length === 0) {
            await page.keyboard.press('Backspace')
          }
          record.notes.push(`replaced the previous value ${typedSecret ? '(masked)' : `"${maskIfSecret(focused.value, false)}"`}`)
        } else if (append && focused.value) {
          await page.keyboard.press('End')
        }
        if (options.paste) {
          await page.keyboard.insertText(text)
          record.notes.push(`inserted ${text.length} characters as IME text (no paste event)`)
        } else {
          await typeHuman(page, text)
          if (typedSecret) record.notes.push('typed a secret (masked in this report)')
        }
        await sleep(randomBetween(80, 160))
        const { field: typedInto, facts: after } = await fieldUnderCaret(step, field, point, 'while the text was typed')
        if (typedInto !== field && isSecret(after) && !typedSecret) {
          // The keys ended in a secret field the page swapped in: the report must not show them.
          typedSecret = true
          record.detail = maskIfSecret(text, true)
        }
        if (after.value !== null) {
          const expected = append ? `${focused.value ?? ''}${text}` : text
          if (after.value !== expected) {
            record.notes.push(
              typedSecret
                ? 'the field value differs from what was typed (the page transformed or rejected some keys)'
                : `value read back: "${maskIfSecret(after.value, false)}" — differs from what was typed (the page transformed, limited or rejected some keys)`,
            )
          } else if (!typedSecret) {
            record.notes.push(`value read back: "${maskIfSecret(after.value, false)}"`)
          }
        }
      },
      { refs: [ref], whileBusy: options.whileBusy },
    )
  }

  async function setChecked(ref: number | string, wanted: boolean, options: { whileBusy?: boolean }): Promise<ActionRecord> {
    return run(
      wanted ? 'check' : 'uncheck',
      async (step) => {
        const [target] = step.targets
        const state = await checkedState(step.probe, target)
        if (state.checked === undefined) {
          throw new ActError(`${describeTarget(target)} has no checked state (role ${state.role}). Use act.click for it.`)
        }
        if (state.checked === wanted) {
          step.record.notes.push(`already ${wanted ? 'checked' : 'unchecked'}; nothing to do`)
          return
        }
        await clickTarget(step, target, 1, 'left')
        const deadline = Date.now() + 1200
        while (Date.now() < deadline) {
          await sleep(100)
          const now = await checkedState(step.probe, target)
          if (now.checked === wanted) {
            step.record.notes.push(`now ${wanted ? 'checked' : 'unchecked'}`)
            return
          }
        }
        throw new ActError(
          `Clicked ${describeTarget(target)} but it is still ${wanted ? 'unchecked' : 'checked'}: the click did not toggle it ` +
            '(a label or handler may intercept it, or the app rejected the change). explain(ref) shows what it is wired to.',
        )
      },
      { refs: [ref], whileBusy: options.whileBusy },
    )
  }

  /** Vertical scroll offset of node `scrollerId` (in the frame of `world`) once smooth scrolling has come to rest. */
  async function restingOffset(world: IsolatedWorld, scrollerId: number, gone: () => ActError): Promise<ScrollOffset> {
    const read = async (): Promise<ScrollOffset> => {
      const offset = await world.callFunctionOnNodes<ScrollOffset | null>([scrollerId], SCROLL_OFFSET_FN, { what: 'reading the scroll position' })
      if (!offset) throw gone()
      return offset
    }
    let last = await read()
    const deadline = Date.now() + 900
    while (Date.now() < deadline) {
      await sleep(50)
      const now = await read()
      if (Math.abs(now.top - last.top) < 0.5) return now
      last = now
    }
    return last
  }

  /**
   * Turn the wheel over a scroller: `container` (a ref), or — without one — what Chromium's scroll
   * chaining scrolls from the middle of the screen, which in an app shell is its main list, not the
   * document, and over an iframe is what scrolls inside it. The scroller's own offset is measured
   * before and after.
   */
  async function scrollBy(step: Step, direction: 'down' | 'up', screens: number, container: RefTarget | undefined): Promise<void> {
    const { page, probe, record } = step
    const dir = direction === 'down' ? 1 : -1
    let scrollerId: number
    let scrollerRef: RefTarget | null
    let frame: FrameHandle
    if (container) {
      scrollerId = container.backendNodeId
      scrollerRef = container
      frame = await probe.frames.handle(container.frameId)
    } else {
      const found = await scrollerAtCentre(probe, dir)
      scrollerId = found.backendNodeId
      frame = found.frame
      scrollerRef = deps.registry.refFor(probe.targetId, frame.frameId, found.backendNodeId)
      if (scrollerRef) record.target = targetSummary(scrollerRef)
    }
    const inIframe = frame.frameId !== probe.frames.mainFrameId()
    const goneScroller = (): ActError =>
      container ? goneError(container) : new ActError('The scroll area in the middle of the screen disappeared while scrolling it. Call observe() again.')
    const aim = await frame.world.callFunctionOnNodes<WheelAim | null>([scrollerId], WHEEL_POINT_FN, {
      args: { dir },
      what: 'finding where to turn the mouse wheel',
    })
    if (!aim) throw goneScroller()
    // In an iframe the aim is in the iframe's own viewport, and "the page" is the iframe's document.
    const point = aim.point && inIframe ? onScreen({ ...aim.point, width: 0, height: 0 }, await probe.frames.box(frame.frameId)) : aim.point
    const label = scrollerRef
      ? describeTarget(scrollerRef)
      : inIframe && aim.label === 'the page'
        ? `the page inside iframe ${await probe.frames.documentUrl(frame.frameId)}`
        : aim.label
    record.detail = `${direction} ${screens} screen${screens === 1 ? '' : 's'} over ${label}`
    record.repeatKey = `${scrollerRef?.key ?? `${step.before?.documentId ?? page.url()}:${frame.frameId}:node${scrollerId}`}|${direction}`
    scrollRepeatGuard(probe, record, label, direction)
    const area = inIframe ? await visibleArea(probe, frame.frameId) : null
    const outside = point && area ? point.x < area.x || point.y < area.y || point.x > area.x + area.width || point.y > area.y + area.height : false
    if ((aim.offscreen || outside) && container) {
      throw new ActError(`${describeTarget(container)} is outside the visible page; bring it into view first (act.scrollTo(${container.ref})), then scroll it.`)
    }
    if (container && aim.atEnd) {
      // A wheel over a scroll area at its end chains to what contains it: the page would move, not this.
      record.scrollMoved = 0
      record.notes.push(
        aim.scrollable
          ? `nothing to scroll: ${label} is already at the ${dir > 0 ? 'bottom' : 'top'} (a wheel over it would scroll what contains it instead)`
          : `nothing to scroll: ${label} does not scroll (its content fits)`,
      )
      return
    }
    if (!point) {
      throw new ActError(
        `Cannot scroll ${label}: wherever a person would turn the wheel over it, ` +
          `the pointer is over ${aim.blockedBy} instead, which scrolls something else or nothing. Deal with that first (observe() shows it).`,
      )
    }
    const before = await restingOffset(frame.world, scrollerId, goneScroller)
    record.dispatched = true
    await deps.humanMouse.moveTo({ page, x: point.x, y: point.y })
    const total = Math.max(40, screens * before.client) * dir
    let done = 0
    while (Math.abs(done) < Math.abs(total)) {
      checkAbort()
      const flick = Math.sign(total) * Math.min(Math.abs(total) - Math.abs(done), randomBetween(180, 420))
      await page.mouse.wheel(0, flick)
      done += flick
      await sleep(randomBetween(70, 150))
    }
    const after = await restingOffset(frame.world, scrollerId, goneScroller)
    const moved = after.top - before.top
    record.scrollMoved = Math.round(Math.abs(moved))
    const remaining = dir > 0 ? after.height - after.top - after.client : after.top
    const where = `${(Math.max(0, remaining) / after.client).toFixed(1)} screens ${dir > 0 ? 'below' : 'above'}`
    if (Math.abs(moved) < 1) {
      record.scrollMoved = 0
      record.notes.push(
        remaining >= 1
          ? `nothing moved although ${label} has more ${dir > 0 ? 'below' : 'above'} (${where}): the page handles the mouse wheel itself here`
          : container
            ? `nothing moved: ${label} is at the ${dir > 0 ? 'bottom' : 'top'}`
            : `nothing moved: nothing in the middle of the screen can scroll further ${direction} (${label} and every scroll area there are at the ${dir > 0 ? 'bottom' : 'top'})`,
      )
    } else {
      record.notes.push(`scrolled ${label} ${Math.round(Math.abs(moved))}px; ${where}`)
    }
  }

  const api: ActApi = {
    click: (ref, options = {}) =>
      run(
        'click',
        async (step) => {
          await clickTarget(step, step.targets[0], 1, options.button ?? 'left')
        },
        { refs: [ref], whileBusy: options.whileBusy, again: options.again },
      ),
    dblclick: (ref, options = {}) =>
      run(
        'dblclick',
        async (step) => {
          await clickTarget(step, step.targets[0], 2, options.button ?? 'left')
        },
        { refs: [ref], whileBusy: options.whileBusy, again: options.again },
      ),
    fill: (ref, text, options = {}) => fillOrType(ref, String(text), options, false),
    type: (ref, text, options = {}) => fillOrType(ref, String(text), options, true),
    press: (key, options = {}) =>
      run(
        'press',
        async (step) => {
          const { page, probe, record } = step
          const [target] = step.targets
          if (target) {
            await clickTarget(step, target, 1, 'left')
          } else {
            // The key goes where focus is: that element is what this press acts on, for the
            // double-submit guard as much as for a click.
            const focusedAt = await focusedNode(probe)
            const focused = focusedAt === null ? null : deps.registry.refFor(probe.targetId, focusedAt.frameId, focusedAt.backendNodeId)
            if (focused) record.notes.push(`focus was in ${describeTarget(focused)}`)
            record.repeatKey = `${focused?.key ?? `${step.before?.documentId ?? page.url()}:${focusedAt ? `${focusedAt.frameId}:node${focusedAt.backendNodeId}` : 'node none'}`}|${key}`
            repeatGuard(probe, record, options.again)
          }
          record.dispatched = true
          await untilDialog(probe, page.keyboard.press(key), record)
        },
        { refs: options.ref !== undefined ? [options.ref] : [], whileBusy: options.whileBusy, again: options.again, detail: key },
      ),
    select: (ref, option, options = {}) =>
      run(
        'select',
        async (step) => {
          const { page, probe, record } = step
          const [target] = step.targets
          const world = await worldOf(probe, target)
          const plan = await world.callFunctionOnNodes<SelectPlan>([target.backendNodeId], SELECT_PLAN_FN, {
            args: { option },
            what: `finding "${option}" in ${describeTarget(target)}`,
          })
          if (plan.error === 'gone') throw goneError(target)
          if (plan.error === 'not-select') {
            throw new ActError(
              `${describeTarget(target)} is not a native <select> (it is ${plan.role}). Open it the way a person does: act.click(${target.ref}), ` +
                'then click the option you want from the next observe().',
            )
          }
          if (plan.error === 'ambiguous') {
            const matches = (plan.matches ?? []).map((match) => `"${match.label}" (value ${match.value})`).join(', ')
            throw new ActError(`"${option}" matches ${plan.matches?.length ?? 0} options of ${describeTarget(target)}: ${matches}. Pass the exact label or value.`)
          }
          const available = (plan.available ?? []).map((label) => `"${label}"`).join(', ')
          if (plan.error === 'no-option') {
            throw new ActError(`${describeTarget(target)} has no option "${option}". Its options: ${available}.`)
          }
          if (plan.error === 'disabled-option') {
            throw new ActError(`"${plan.label}" in ${describeTarget(target)} is disabled: a person cannot choose it. Its options: ${available}.`)
          }
          const label = plan.label ?? option
          const index = plan.index ?? -1
          record.detail = `"${label}"`
          if (plan.steps === 0) {
            record.notes.push(`"${label}" was already selected; nothing to do`)
            return
          }
          const readState = async (): Promise<{ index: number; selected: string; open: boolean }> => {
            const state = await world.callFunctionOnNodes<{ index: number; selected: string; open: boolean } | null>([target.backendNodeId], SELECT_STATE_FN, {
              what: `reading ${describeTarget(target)}`,
            })
            if (!state) throw goneError(target)
            return state
          }
          if (plan.listBox) {
            // A list box draws its options in the page: a person clicks the one they want.
            const [optionNode] = await world.nodesReturnedBy([target.backendNodeId], SELECT_OPTION_NODE_FN, {
              args: { index },
              what: `finding the option "${label}" in ${describeTarget(target)}`,
            })
            if (optionNode === undefined || optionNode === null) {
              throw new ActError(`${describeTarget(target)} lost its option "${label}" while choosing it. Call observe() again.`)
            }
            await clickTarget(step, { ...target, backendNodeId: optionNode, role: 'option', name: label, viaLabel: undefined }, 1, 'left')
          } else {
            // A person clicks the select, which opens its list, then moves to the option with the arrow
            // keys and confirms with Enter; Chrome fires the trusted input and change itself.
            await clickTarget(step, target, 1, 'left')
            await sleep(randomBetween(120, 220))
            const { open } = await readState()
            const key = (plan.steps ?? 0) > 0 ? 'ArrowDown' : 'ArrowUp'
            for (let pressed = 0; pressed < Math.abs(plan.steps ?? 0); pressed++) {
              checkAbort()
              await page.keyboard.press(key)
              await sleep(randomBetween(90, 180))
            }
            // Arrows in the open list only move the highlight; Enter chooses. A closed, focused select
            // changes with each arrow already.
            if (open) await untilDialog(probe, page.keyboard.press('Enter'), record)
          }
          await sleep(randomBetween(80, 140))
          const after = await readState()
          if (after.index !== index) {
            throw new ActError(`Chose "${label}" in ${describeTarget(target)} but it shows "${after.selected}": the page rejected or reset the choice. observe() shows the page now.`)
          }
          record.notes.push(`selected "${label}" (was "${plan.before}")`)
        },
        { refs: [ref], whileBusy: options.whileBusy, detail: `"${option}"` },
      ),
    check: (ref, options = {}) => setChecked(ref, true, options),
    uncheck: (ref, options = {}) => setChecked(ref, false, options),
    hover: (ref) =>
      run(
        'hover',
        async (step) => {
          const point = await aimAt(step, step.targets[0])
          step.record.dispatched = true
          await deps.humanMouse.moveTo({ page: step.page, x: point.x, y: point.y })
        },
        { refs: [ref] },
      ),
    scroll: (direction = 'down', options = {}) =>
      run(
        'scroll',
        async (step) => {
          const screens = options.screens ?? 0.8
          if (!(screens > 0 && screens <= 10)) {
            throw new ActError('scroll: screens must be between 0 and 10.')
          }
          await scrollBy(step, direction, screens, step.targets[0])
        },
        { refs: options.ref !== undefined ? [options.ref] : [] },
      ),
    scrollTo: (ref) =>
      run(
        'scrollTo',
        async (step) => {
          const { notes } = await bringIntoView(step, await pointerSurface(step.probe, step.targets[0], step.record))
          step.record.notes.push(...(notes.length ? notes : ['already in view']))
        },
        { refs: [ref] },
      ),
    upload: (ref, files, options = {}) =>
      run(
        'upload',
        async (step) => {
          const { probe, record } = step
          const [target] = step.targets
          const list = resolveFiles(files)
          record.detail = list.map((file) => path.basename(file)).join(', ')
          const frame = await probe.frames.handle(target.frameId)
          const input = await frame.world.callFunctionOnNodes<{ multiple: boolean | null } | null>([target.backendNodeId], FILE_INPUT_FN, {
            what: `reading what ${describeTarget(target)} uploads`,
          })
          if (!input) throw goneError(target)
          if (list.length > 1 && input.multiple === false) {
            throw new ActError(`${describeTarget(target)} takes one file (its file input has no \`multiple\`); you passed ${list.length}. Upload one file.`)
          }
          // A file dialog this control opened is still waiting: a person chooses in it rather than
          // clicking again. Any other open file dialog is in the way first, as it would be for them.
          const [open] = await probe.fileChoosers.openDialogs()
          if (open) {
            const opener = chooserOpener(probe.history, open)
            const ours = (open.backendNodeId === target.backendNodeId && open.frameId === target.frameId) || opener?.target?.ref === target.ref
            if (!ours) {
              throw new ActError(
                `A file dialog is open${opener ? ` (opened by ${describeOpener(opener)})` : ''}: a person answers it before clicking anything else. ` +
                  'act.dialog.chooseFiles(path) chooses its files, act.dialog.dismiss() cancels it.',
              )
            }
            await chooseInDialog(step, open, list)
            record.notes.push(`answered the file dialog ${describeTarget(target)} had already opened — no second click`)
            return
          }
          // The way a person attaches a file: click the control, then choose the files in the dialog
          // that opens. run() has the tab holding file dialogs back from before the click, in every
          // renderer (an out-of-process iframe opens its own); the gate records the one that opens.
          const clickedAt = Date.now()
          await clickTarget(step, target, 1, 'left')
          // A message box the click opened comes first: a file dialog can only follow its answer.
          const stop = new AbortController()
          const timer = setTimeout(() => stop.abort(), FILE_CHOOSER_TIMEOUT_MS)
          const offDialog = probe.dialogs.onChange((dialog) => {
            if (dialog?.handling === 'agent') stop.abort()
          })
          if (probe.dialogs.current()?.handling === 'agent') stop.abort()
          let opened: FileChooserRecord | null
          try {
            opened = await probe.fileChoosers.next(clickedAt, stop.signal)
          } finally {
            clearTimeout(timer)
            offDialog()
          }
          checkAbort()
          const dialog = probe.dialogs.current()
          if (!opened && dialog?.handling === 'agent') {
            throw new ActError(
              `Clicked ${describeTarget(target)} and a native ${dialog.type}("${dialog.message}") opened before any file dialog. Answer it ` +
                '(act.dialog.accept() or act.dialog.dismiss()); a file dialog that opens after it is in that report, and act.dialog.chooseFiles(path) chooses its files.',
            )
          }
          if (!opened) {
            throw new ActError(`Clicked ${describeTarget(target)} but no file dialog opened within ${FILE_CHOOSER_TIMEOUT_MS / 1000}s. It is not an upload control; observe() for the real one.`)
          }
          if (opened.toCode) record.notes.push("your page.on('filechooser') listener was handed the same dialog")
          await chooseInDialog(step, opened, list)
        },
        { refs: [ref], whileBusy: options.whileBusy },
      ),
    drag: (fromRef, toRef, options = {}) =>
      run(
        'drag',
        async (step) => {
          const { page, probe, record } = step
          const [from, to] = step.targets
          record.detail = `onto ${describeTarget(to)}`
          const fromPoint = await aimAt(step, from)
          record.dispatched = true
          await deps.humanMouse.moveTo({ page, x: fromPoint.x, y: fromPoint.y })
          // An HTML drag (draggable=true, links, images) is intercepted the way Playwright's
          // crDragDrop does: Chrome hands over the drag data instead of running a native drag loop
          // (which headless and CDP input cannot drive), and the data is dropped with Chrome's drag
          // events. Measured on Chromium: Chrome reports the drag only to the session the press and
          // the held-button moves are dispatched on, so all of them go through probe.cdp here, along
          // the human path humanMouse plans (its own moveTo would first send a button-less move).
          let dragData: Protocol.Input.DragData | null = null
          const onIntercepted = (event: Protocol.Input.DragInterceptedEvent): void => {
            dragData = event.data
          }
          let pressed = false
          let at = fromPoint
          try {
            probe.cdp.on('Input.dragIntercepted', onIntercepted)
            let toPoint: Point
            try {
              await send(probe.cdp, 'Input.setInterceptDrags', { enabled: true }, 'arming drag interception')
              await send(probe.cdp, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 }, 'pressing the mouse button')
              pressed = true
              await sleep(randomBetween(120, 220))
              const toSurface = await pointerSurface(probe, to, record)
              const toRects = await quadsOf(probe, toSurface)
              const viewport = await visibleArea(probe, toSurface.frameId)
              if (!toRects.some((rect) => intersectRects(rect, viewport) !== null)) {
                throw new ActError(`${describeTarget(to)} is not visible while dragging; bring both into view first.`)
              }
              ;({ point: toPoint } = await hitPoint(probe, toSurface, toRects, viewport))
              const trajectory = await deps.humanMouse.plan({ page, from: at, x: toPoint.x, y: toPoint.y })
              const startedAt = Date.now()
              for (const sample of trajectory.samples) {
                checkAbort()
                const wait = startedAt + sample.tMs - Date.now()
                if (wait > 0) await sleep(wait)
                await send(probe.cdp, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: sample.x, y: sample.y, button: 'left', buttons: 1 }, 'moving the pointer with the button held')
                at = { x: sample.x, y: sample.y }
              }
              await send(probe.cdp, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: toPoint.x, y: toPoint.y, button: 'left', buttons: 1 }, 'moving the pointer with the button held')
              at = toPoint
              await sleep(randomBetween(80, 160))
            } finally {
              probe.cdp.off('Input.dragIntercepted', onIntercepted)
              await send(probe.cdp, 'Input.setInterceptDrags', { enabled: false }, 'disarming drag interception')
            }
            const data: Protocol.Input.DragData | null = dragData
            if (data) {
              for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
                await untilDialog(probe, send(probe.cdp, 'Input.dispatchDragEvent', { type, x: toPoint.x, y: toPoint.y, data }, `dispatching ${type}`), record)
              }
              record.notes.push('the page started an HTML drag: its drag data was dropped on the target with drag events')
            }
          } finally {
            if (pressed) {
              await untilDialog(
                probe,
                send(probe.cdp, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 }, 'releasing the mouse button'),
                record,
              )
            }
          }
        },
        { refs: [fromRef, toRef], whileBusy: options.whileBusy },
      ),
    open: (url, options = {}) =>
      run(
        'open',
        async ({ page, probe, record }) => {
          const current = page.url()
          if (deps.mode === 'human' && !isBlankUrl(current) && !options.reason) {
            throw new ActError(
              `Refused: act.open would reload the whole document (${current} → ${url}); client caches and in-memory state are wiped, which a person ` +
                'clicking around never does. Navigate like a user: act.click(ref) on the link (observe() shows links), or act.spaNavigate(path). ' +
                "If a full load is genuinely what you are testing, pass { reason: '…' }.",
            )
          }
          record.detail = options.reason ? `${url} (reason: ${options.reason})` : url
          record.dispatched = true
          const response = await untilDialog(
            probe,
            page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, Math.min(30_000, remainingMs() - 4000)) }),
            record,
          )
          if (response && response.status() >= 400) {
            record.notes.push(`the server answered HTTP ${response.status()}`)
          }
        },
        { detail: url },
      ),
    back: () =>
      run('back', async ({ probe, record }) => {
        const history = await send<Protocol.Page.GetNavigationHistoryResponse>(probe.cdp, 'Page.getNavigationHistory', undefined, "reading this tab's history")
        if (history.currentIndex === 0) {
          throw new ActError('Nothing to go back to: this tab has no earlier page in its history.')
        }
        const from = history.entries[history.currentIndex]
        const to = history.entries[history.currentIndex - 1]
        record.detail = `to ${shortUrl(to.url)}`
        record.dispatched = true
        await untilDialog(probe, send(probe.cdp, 'Page.navigateToHistoryEntry', { entryId: to.id }, 'going back'), record)
        const deadline = Date.now() + Math.max(1000, Math.min(10_000, remainingMs() - 4000))
        for (;;) {
          const dialog = probe.dialogs.current()
          if (dialog?.handling === 'agent') {
            // A beforeunload holds the navigation until it is answered: that is the outcome to report.
            if (!record.notes.includes(dialogNote(dialog))) record.notes.push(dialogNote(dialog))
            return
          }
          const now = await send<Protocol.Page.GetNavigationHistoryResponse>(probe.cdp, 'Page.getNavigationHistory', undefined, "reading this tab's history")
          if (now.entries[now.currentIndex]?.id !== from.id) break
          if (Date.now() > deadline) {
            throw new ActError(`Went back from ${shortUrl(from.url)}, but the tab is still on it: the page refused or held the navigation. observe() shows the page now.`)
          }
          await sleep(50)
        }
        const sameDocument = URL.canParse(from.url) && URL.canParse(to.url) && new URL(from.url).href.split('#')[0] === new URL(to.url).href.split('#')[0]
        record.notes.push(
          sameDocument
            ? `went back to ${shortUrl(to.url)} (same page, only the #fragment differs)`
            : `went back to ${shortUrl(to.url)} — the NAV line says whether it is a new document, an in-app route or a restored page`,
        )
      }),
    spaNavigate: (pathOrUrl) =>
      run(
        'spaNavigate',
        async (step) => {
          const { page, record } = step
          const here = new URL(page.url())
          const target = new URL(pathOrUrl, here)
          if (target.origin !== here.origin) {
            throw new ActError(
              `${target.href} is on another site (${target.origin}); an in-app route stays on ${here.origin}. ` +
                'A person goes there by typing the address — a full load: act.open(url, { reason }).',
            )
          }
          // The way a person does it: the page's own link to that route, found in the picture taken
          // right before this action (so the link is exactly what is on the page now).
          const observation = step.before
          const link = observation?.elements.find(
            (element) =>
              element.role === 'link' &&
              element.href !== undefined &&
              new URL(element.href, observation.url).href === target.href &&
              element.visibility !== 'hidden' &&
              element.visibility !== 'unknown',
          )
          if (!link) {
            throw new ActError(
              `No link to ${target.pathname}${target.search}${target.hash} is on the page. A person would reach it through the UI — find() a menu ` +
                'or link that leads there — or type the address, which is a full load: act.open(url, { reason }).',
            )
          }
          const resolution = deps.registry.resolve(link.ref)
          if (!resolution.ok) throw new ActError(resolution.error)
          record.target = targetSummary(resolution.target)
          await clickTarget(step, resolution.target, 1, 'left')
          record.notes.push(`clicked the page's own link to it`)
        },
        { detail: pathOrUrl },
      ),
    switchTab: (index) =>
      run('switchTab', async ({ record }) => {
        const tabs = deps.listTabs()
        if (!Number.isInteger(index) || index < 0 || index >= tabs.length) {
          throw new ActError(`There is no tab ${index}: the open tabs are 0–${tabs.length - 1} (observe() lists them under TABS).`)
        }
        const page = tabs[index]
        await withDeadline(page.bringToFront(), CDP_TIMEOUT_MS, `bringing tab ${index} to the front`)
        deps.setPage(page)
        record.targetId = (await deps.getProbe(page)).targetId
        const title = await tabTitle(page).catch(
          (error: unknown) => `(title unreadable: ${errorMessage(error).split('.')[0]})`,
        )
        record.detail = `tab ${index} "${title}" ${page.url()}`
      }),
    waitForIdle: (options = {}) =>
      run('waitForIdle', async ({ probe, record }) => {
        const cap = Math.max(1000, Math.min(options.timeoutMs ?? 60_000, remainingMs() - 5000))
        const last = lastDispatched(probe)
        const result = await probe.watch.waitForIdle({ timeoutMs: cap, quietMs: options.quietMs, since: last?.checkpoint, origin: last?.endedAt })
        record.settle = result
        record.detail = `${Math.round(result.waitedMs)}ms`
        if (!result.settled) {
          record.notes.push(`still not idle after ${Math.round(result.waitedMs)}ms (${result.reason})`)
          if (cap < (options.timeoutMs ?? 60_000)) {
            record.notes.push(`capped at ${cap}ms by this call's timeout; pass a larger execute timeout to wait longer`)
          }
        }
      }),
    wait: (ms, options = {}) =>
      run('wait', async ({ record }) => {
        if (!Number.isFinite(ms) || ms < 0) {
          throw new ActError(`wait: ms must be a number of milliseconds ≥ 0 (got ${String(ms)}).`)
        }
        const left = Math.max(0, Math.round(remainingMs() - 3000))
        const capped = Math.min(ms, WAIT_CAP_MS, left)
        const startedAt = Date.now()
        await sleep(capped)
        const waited = Date.now() - startedAt
        const reason = capped === ms ? null : capped === left ? `this execute() call had ${left}ms left before its timeout` : `act.wait waits at most ${WAIT_CAP_MS / 1000}s; act.waitForIdle() waits for the page`
        record.detail = `${reason ? `requested ${ms}ms, waited ${waited}ms (capped at ${capped}ms: ${reason})` : `${waited}ms`}${options.reason ? ` (${options.reason})` : ''}`
      }),
    dialog: {
      accept: (promptText) =>
        run('dialog-accept', async ({ probe, record }) => {
          if (!probe.dialogs.current() && (await probe.fileChoosers.openDialogs()).length > 0) {
            throw new ActError('The open dialog is a file dialog: act.dialog.chooseFiles(path) chooses its files, act.dialog.dismiss() cancels it.')
          }
          record.dispatched = true
          const state = await probe.dialogs.accept(promptText)
          record.detail = `${state.type}("${state.message}")${promptText !== undefined ? ` with "${promptText}"` : ''}`
        }),
      dismiss: () =>
        run('dialog-dismiss', async ({ probe, record }) => {
          // A message box is in front of everything; without one, the file dialog that waits is the one cancelled.
          const [fileDialog] = probe.dialogs.current() ? [] : await probe.fileChoosers.openDialogs()
          if (fileDialog) {
            const opener = chooserOpener(probe.history, fileDialog)
            record.dispatched = true
            probe.fileChoosers.cancel(fileDialog)
            record.detail = `file dialog${opener ? ` opened by ${describeOpener(opener)}` : ''}`
            record.notes.push('cancelled — Chrome sends the page no cancel event for a file dialog it held back, so the page is not told')
            return
          }
          record.dispatched = true
          const state = await probe.dialogs.dismiss()
          record.detail = `${state.type}("${state.message}")`
        }),
      chooseFiles: (files) =>
        run('dialog-choose-files', async (step) => {
          const [fileDialog] = await step.probe.fileChoosers.openDialogs()
          if (!fileDialog) {
            throw new ActError('No file dialog is open on this tab. act.upload(ref, path) clicks an upload control and chooses the files in the dialog it opens.')
          }
          const list = resolveFiles(files)
          step.record.detail = list.map((file) => path.basename(file)).join(', ')
          await chooseInDialog(step, fileDialog, list)
        }),
    },
  }
  return api
}

// ---------------------------------------------------------------------------
// The report printed after every execute() call that acted or waited
// ---------------------------------------------------------------------------

export interface ActionReportInput {
  records: ActionRecord[]
  /** Raw Playwright input seen during the call (via the channel tap), as short labels. */
  rawInputs: string[]
  settle: SettleResult | null
  /** Why there is no settle result although input was dispatched. */
  settleError?: string
  events: WatchEvents | null
  /** Why the page's event journal could not be read. */
  eventsError?: string
  after: Observation | null
  /** Why the page could not be observed after the action. */
  afterError?: string
  diff: ObservationDiff | null
  /** Tabs this page opened during the call, with their index in observe()'s TABS list (null: closed again). */
  newTabs: Array<{ title: string; url: string; index: number | null }>
  /** Download lines, formatted by the executor. */
  downloads: string[]
  /** File dialog lines (each one opened since the last report, and why a tab could not hold them back), formatted by the executor. */
  fileDialogs: string[]
  /** Did anything change (measured by the executor)? Undefined when it could not be measured. */
  changed?: boolean
  maxChars?: number
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // The hash is kept: hash routers (`#/active`) put the whole route there.
    const tail = `${parsed.pathname}${parsed.search}${parsed.hash}`
    return tail.length > 80 ? `${tail.slice(0, 77)}…` : tail
  } catch {
    return url.length > 80 ? `${url.slice(0, 77)}…` : url
  }
}

/** `click [12] button "Send" detail`: what an action was, without its outcome. */
function actionLabel(record: ActionRecord): string {
  const target = record.target ? ` [${record.target.ref}] ${record.target.role}${record.target.name ? ` "${record.target.name}"` : ''}${record.target.context ? ` (${record.target.context})` : ''}` : ''
  return `${record.kind}${target}${record.detail ? ` ${record.detail}` : ''}`
}

function recordLine(record: ActionRecord): string {
  if (record.endedAt === 0) {
    return `… ${actionLabel(record)}\n        STILL RUNNING when this call ended — it did not finish; do not assume it took effect`
  }
  const head = `${record.ok ? '✓' : '✗'} ${actionLabel(record)}`
  return record.ok ? head : `${head}\n        FAILED: ${record.error}`
}

/** Identical new items appearing together: the double-post symptom. */
function duplicateWarnings(after: Observation | null): string[] {
  if (!after) return []
  const counts = new Map<string, number>()
  for (const block of after.text) {
    if (!block.isNew || block.text.length < 4) continue
    const key = `${block.role} "${block.text}"`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const element of after.elements) {
    if (!element.isNew || !element.name || element.role === 'clickable') continue
    if (!['article', 'listitem', 'row', 'comment'].includes(element.role)) continue
    const key = `${element.role} "${element.name}"`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([key, n]) => `⚠ possible duplicate: ${n} identical new ${key} appeared — was something submitted twice?`)
}

/** Console errors and LIVE announcements listed in full up to this many (latest first kept), with a count of the rest. */
const REPORT_LIST_MAX = 5
const LIVE_LIST_MAX = 8

function settleLine(settle: SettleResult): string {
  if (settle.settled) return `SETTLED ${Math.round(settle.waitedMs)}ms — page content and network went quiet`
  if (settle.reason === 'js-dialog') return 'NOT SETTLED — a native dialog is blocking the page'
  if (settle.reason === 'page-closed') return 'NOT SETTLED — the page was closed'
  const pending = settle.pendingRequests.slice(0, 4).map((r) => `${r.method} ${shortUrl(r.url)} (${(r.ageMs / 1000).toFixed(1)}s)`)
  const more = settle.pendingRequests.length - pending.length
  const parts = [
    pending.length ? `waiting on ${pending.join(', ')}${more > 0 ? ` +${more} more` : ''}` : '',
    settle.domChangingIn ? `content still changing in ${settle.domChangingIn}` : '',
  ].filter(Boolean)
  return `NOT SETTLED after ${Math.round(settle.waitedMs)}ms${parts.length ? ` — ${parts.join(' · ')}` : ''}`
}

function navLine(nav: WatchEvents['navigations'][number]): string {
  if (nav.kind === 'restored') {
    return `NAV     back/forward cache → ${nav.url} (the earlier document restored as it was left: in-memory app state and caches preserved)`
  }
  if (nav.kind === 'cross-document') {
    return `NAV     NEW DOCUMENT → ${nav.url} (full load: client-side caches and in-memory app state were reset)`
  }
  return `NAV     in-app route → ${shortUrl(nav.url)} (same document, no reload)`
}

/**
 * The report: every safety line first (actions, settle, navigation, dialogs, tabs, downloads, file
 * choosers, duplicates, busy, errors, live announcements), never cut; then what changed, trimmed to
 * the budget that is left.
 */
export function renderActionReport(input: ActionReportInput): string {
  const lines: string[] = []
  for (const record of input.records) {
    lines.push(`ACTION  ${recordLine(record)}`)
    if (record.hit && record.target && !record.hit.startsWith(`[${record.target.ref}]`)) {
      lines.push(`        hit: ${record.hit}`)
    }
    for (const note of record.notes) lines.push(`        · ${note}`)
  }
  for (const raw of input.rawInputs) {
    lines.push(`ACTION  (raw Playwright) ${raw} — no human pointer path, busy check or cover check; prefer act.* with refs from observe()`)
  }

  if (input.settle) lines.push(settleLine(input.settle))
  else if (input.settleError) lines.push(`NOT SETTLED — ${input.settleError}`)

  const events = input.events
  if (input.eventsError) lines.push(`EVENTS UNAVAILABLE — ${input.eventsError}`)
  if (events) {
    for (const nav of events.navigations) lines.push(navLine(nav))
    for (const dialog of events.dialogs) {
      if (!dialog.outcome) {
        lines.push(`DIALOG  ${dialog.type}("${dialog.message}") is OPEN and blocks the page → act.dialog.accept() or act.dialog.dismiss()`)
      } else {
        lines.push(`DIALOG  ${dialog.type}("${dialog.message}") was shown and ${dialog.outcome === 'auto-accepted' ? 'accepted automatically' : dialog.outcome}`)
      }
    }
  }
  for (const tab of input.newTabs) {
    lines.push(
      tab.index === null
        ? `TAB     a new tab opened by this page and closed again: "${tab.title}" ${tab.url}`
        : `TAB     a new tab opened by this page: "${tab.title}" ${tab.url} — act.switchTab(${tab.index}) to work in it`,
    )
  }
  for (const download of input.downloads) lines.push(`DOWNLOAD ${download}`)
  for (const dialog of input.fileDialogs) lines.push(`FILE DIALOG ${dialog}`)
  lines.push(...duplicateWarnings(input.after))

  // Only what a person would read as "still working". Content that changed a moment ago is the
  // settle step's business (and is in SETTLED / NOT SETTLED above), not a reason to wait.
  const busy = input.after?.busy.filter((s) => s.strength === 'strong' && BLOCKING_BUSY_KINDS.has(s.kind)) ?? []
  if (busy.length) {
    lines.push(`BUSY    ${busy.map((s) => s.label).join(' · ')} — the app is still working; act.waitForIdle() before the next action`)
  }

  if (events) {
    const errors: string[] = []
    const consoleErrors = events.console.filter((c) => c.level !== 'warning')
    if (consoleErrors.length > REPORT_LIST_MAX) errors.push(`+${consoleErrors.length - REPORT_LIST_MAX} more console errors before these — getLatestLogs()`)
    for (const entry of consoleErrors.slice(-REPORT_LIST_MAX)) {
      errors.push(`${entry.level === 'exception' ? 'uncaught' : 'console.error'}: ${entry.text.slice(0, 160)}${entry.location ? ` (${entry.location})` : ''}`)
    }
    // Listed: failures of what the page is built from or talks to. Counted (never dropped):
    // everything else — the browser's own favicon fetch, pings/beacons, prefetches, reports.
    const isDependency = (request: WatchEvents['failedRequests'][number]): boolean =>
      request.resourceType !== undefined && PAGE_DEPENDENCY_TYPES[request.resourceType] === true
    const listed = events.failedRequests.filter(isDependency)
    const others = events.failedRequests.filter((request) => !isDependency(request))
    for (const request of listed.slice(-REPORT_LIST_MAX)) {
      errors.push(request.failed ? `request failed ${request.method} ${shortUrl(request.url)}: ${request.failed} (${request.id})` : `HTTP ${request.status} ${request.method} ${shortUrl(request.url)} (${request.id})`)
    }
    if (listed.length > REPORT_LIST_MAX) errors.push(`+${listed.length - REPORT_LIST_MAX} more failed requests — net.requests({ failedOnly: true })`)
    if (others.length) {
      const types = [...new Set(others.map((request) => request.resourceType ?? 'type not reported'))].join(', ')
      errors.push(`+ ${others.length} failed request(s) the page does not render from (${types}) — net.requests({ failedOnly: true })`)
    }
    if (errors.length) lines.push(`ERRORS  ${errors.join('\n        ')}`)
    if (events.dropped?.length) {
      lines.push(`⚠ JOURNAL overflowed (${events.dropped.join(', ')}): entries were dropped before they could be read — what is listed for them is a lower bound`)
    }
    // What the page announced in its live regions since the action (the journal records what was
    // added to a region), including announcements already gone again.
    const live = events.live
    if (live.length > LIVE_LIST_MAX) lines.push(`LIVE    +${live.length - LIVE_LIST_MAX} earlier announcements`)
    for (const item of live.slice(-LIVE_LIST_MAX)) {
      lines.push(`LIVE    ${item.role} "${item.text}"${item.transient ? ' (shown briefly, already gone)' : ''}`)
    }
  }

  const head = lines.join('\n')
  const tail: string[] = []
  if (input.afterError) {
    tail.push(`AFTER-STATE UNAVAILABLE — ${input.afterError}`)
  } else if (input.diff) {
    // Only the diff is trimmed: it gets what the lines above left of the budget (and always room for its headline).
    const budget = Math.max(400, (input.maxChars ?? 5000) - head.length - 1)
    const diffText = renderObservationDiff(input.diff, { maxChars: budget })
    if (diffText) tail.push(diffText)
  }
  if (input.changed === false) {
    tail.push(
      'NO VISIBLE CHANGE — the page looks the same as before. Do not assume it worked: check observe(), ' +
        'explain(ref) to see what the element is wired to, or getLatestLogs().',
    )
  }
  return [head, ...tail].filter(Boolean).join('\n')
}
