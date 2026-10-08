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
import type { BusyRead, PageWatch } from './page-watch.js'
import { dialogAnswerText, dialogLabel, type BeforeUnloadPolicy, type DialogController, type DialogPolicySettings } from './dialog-controller.js'
import { chooserOpener, describeOpener, type ChooserWindow, type FileChooserGate, type FileChooserRecord } from './file-chooser-gate.js'
import type { HumanMouseApi, HumanMoveResult } from './human-mouse-driver.js'
import { minimumJerkPosition } from './human-mouse.js'
import { isTouchPage, swipeFor, swipeSamples, tap, touchStroke } from './touch-input.js'
import { axStatesFromNode, type AxStates } from './ax-states.js'
import { isSecretField } from './aria-snapshot.js'
import { colourChooserNotOpened, type TabVisibility } from './tab-state.js'
import {
  ModelFacingError,
  type BusySignal,
  type JsDialogState,
  type PendingRequest,
  type PolicyMode,
  type SettleResult,
  type WatchCheckpoint,
  type WatchEvents,
} from './probe-types.js'
import type { Observation, ObservationDiff, ObservedElement, SemanticContainer, TextBlock } from './page-observe.js'
import { MIN_CLICKABLE_SIDE, SCROLL_ORIGIN_JS, describeIframe, iframeRef, liveContext, renderObservationDiff } from './page-observe.js'
import { CLICK_LABEL_FN } from './label-control.js'
import { EDITOR_BLOCK_FN, EDITOR_CARET_BLOCK_FN, EDITOR_PARTS_FN, type EditorBlockFacts } from './editor-block.js'
import { REACHES_TARGET_FN } from './composed-hit.js'
import { matchSpaLink, routeOf, type SpaLink } from './spa-link.js'
import { SELECT_OPTION_NODE_FN, SELECT_PLAN_FN, SELECT_STATE_FN, arrowPresses, keyRoute, type SelectPlan, type SelectState } from './native-select.js'
import { replacedCrashOf } from './page-crash.js'

const CDP_TIMEOUT_MS = 5000
/** How long a click on an upload control may take to open its file dialog. */
const FILE_CHOOSER_TIMEOUT_MS = 4000
/** The longest single act.wait(); longer waits are act.waitForIdle()'s job, which watches the page. */
const WAIT_CAP_MS = 30_000
/**
 * How long a tab's close is waited for after an input Chrome never confirmed: the page closes a
 * moment after the input event it closed itself in answer to.
 */
const CLOSE_AFTER_INPUT_MS = 1000
/**
 * How an input a debugger cut (debugger-cut.ts) stopped is told: the tab did not close, and the
 * executor's DEBUGGER CUT line, first in the call's output, says why and what to do.
 */
const CUT_OFF = 'Chrome took the debugger off this tab (DEBUGGER CUT above; the tab is still open)'
/** What tells what an input a debugger cut stopped did: its tab is still there to read. */
const LOOK_AFTER_CUT = 'observe() shows what it did once the tab is back.'

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
  | 'reload'
  | 'back'
  | 'spaNavigate'
  | 'dialog-accept'
  | 'dialog-dismiss'
  | 'dialog-choose-files'
  /** act.dialog.policy: the session's answer to confirm/prompt (and, explicitly, beforeunload) dialogs. A setting, not input. */
  | 'dialog-policy'
  | 'switchTab'
  | 'waitForIdle'
  | 'wait'
  /** webmcp.invoke: a page-provided WebMCP tool run through Chrome's WebMCP CDP domain (webmcp.ts). */
  | 'webmcp'

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
  reload: true,
  back: true,
  spaNavigate: true,
}

/** Kinds that are not an action on the page: no "before" picture, and they never count as the call's one action in human mode. */
export const UNCOUNTED_KINDS: Partial<Record<ActKind, true>> = { wait: true, waitForIdle: true, switchTab: true, 'dialog-policy': true }

/** Kinds that may run while a native dialog waits for an answer. */
const DIALOG_FREE_KINDS: Partial<Record<ActKind, true>> = { 'dialog-accept': true, 'dialog-dismiss': true, 'dialog-policy': true, wait: true, switchTab: true }

/** Kinds that may run while a file dialog waits for an answer: the ones that answer it, and those that do not touch the page. */
const FILE_DIALOG_FREE_KINDS: Partial<Record<ActKind, true>> = {
  'dialog-accept': true,
  'dialog-dismiss': true,
  'dialog-choose-files': true,
  'dialog-policy': true,
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
export const BLOCKING_BUSY_KINDS: ReadonlySet<BusySignal['kind']> = new Set(['aria-busy', 'progressbar', 'spinner', 'skeleton', 'dom-streaming', 'network-streaming'])

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
   * The tab closed in answer to this action's own input: Chrome confirmed the press (a mouse button,
   * a key), then the tab closed during or right after the release, whose confirmation was lost with
   * it. For a click, a key press or a drag the closing is the action's effect.
   */
  closedTab?: boolean
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
  /**
   * A fresh observation of the page that updates ref liveness only: it does not count as the model's
   * look. `known`: the busy read just made since the same last action (the busy guard's), not read again.
   */
  observeQuietly: (page: Page, known?: BusyRead) => Promise<Observation>
  /** Set the session dialog policy on every tab (open now or opened later); returns the policy now in force. */
  setDialogPolicy: (
    policy: 'accept' | 'dismiss' | 'pending',
    options: { beforeunload?: BeforeUnloadPolicy; promptText?: string },
  ) => DialogPolicySettings
  /** Whether the user can see the tab, as the extension reads it (never rejects); null for a launched browser. */
  tabVisibility: (probe: ActProbe) => Promise<TabVisibility | null>
  /**
   * `page`, which closed during an input, belongs to a tab that is still open: Chrome only took the
   * debugger off it (debugger-cut.ts). Waits, within the call's time, for the relay to say which;
   * false for a tab that really closed, and always in a launched browser.
   */
  debuggerCut: (page: Page) => Promise<boolean>
}

export interface ClickOptions {
  /** Act even though the page shows a strong busy signal (only when acting during loading IS the test). */
  whileBusy?: boolean
  /** Repeat an action on the same element although its last run sent data-changing requests. */
  again?: boolean
  /**
   * The mouse button: 'right' opens the page's context menu (a trusted `contextmenu` fires at the
   * point), 'middle' is the wheel button (on a link: open it in a new tab).
   */
  button?: 'left' | 'right' | 'middle'
}

export interface DragOptions {
  whileBusy?: boolean
  /**
   * 'human' (default): a person's curved path with an overshoot and corrections; it starts and ends
   * exactly at the two points, but the way between them is longer than the straight distance.
   * 'straight': the pointer moves along the straight line between the two points at a person's
   * pace (slow start and end), for a drawn line or anywhere the way itself matters.
   */
  path?: 'human' | 'straight'
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
  /**
   * The key a line break in `text` is typed as, in a field that takes several lines (a textarea
   * or contenteditable). Apps disagree: in a chat composer Enter sends the message and Shift+Enter
   * starts a new line; in a plain text area or a code editor Enter starts a new line. Required for
   * text with a line break typed key by key there: act never guesses it. Not with `paste`, which
   * types no keys.
   */
  newline?: 'Enter' | 'Shift+Enter'
  /**
   * act.type only: `'caret'` types where the caret already is (after a point click,
   * `act.click({ ref, x, y })`, or arrow keys), instead of clicking the field and putting the
   * caret after its text. Refused when keyboard focus is not in the field.
   */
  at?: 'caret'
}

/**
 * On a page that emulates a touch screen (a phone or tablet preset of a new browser) a finger does the
 * pointer's work (touch-input.ts): click is a tap, dblclick a double tap, drag a finger drag, scroll and
 * scrolling into view are swipes; hover and right/middle clicks are refused with the reason.
 */
export interface ActApi {
  /** Click `target`: a ref (a point of the element that receives the pointer) or `{ ref, x, y }`, exactly that point of the element. */
  click(target: number | string | ElementPoint, options?: ClickOptions): Promise<ActionRecord>
  dblclick(target: number | string | ElementPoint, options?: ClickOptions): Promise<ActionRecord>
  /**
   * Replace a field's text. Native date/time inputs take ISO text (`2024-05-01`, `13:45`,
   * `2024-05-01T13:45`, `2024-05`, `2024-W18`), typed digit by digit into the field's parts; a range
   * input takes a number, reached with the arrow keys; a colour input takes `#rrggbb`, typed into
   * the hex field of Chrome's colour chooser.
   */
  fill(ref: number | string, text: string, options?: FillOptions): Promise<ActionRecord>
  type(ref: number | string, text: string, options?: FillOptions): Promise<ActionRecord>
  press(key: string, options?: { ref?: number | string; whileBusy?: boolean; again?: boolean }): Promise<ActionRecord>
  select(ref: number | string, option: string, options?: { whileBusy?: boolean }): Promise<ActionRecord>
  check(ref: number | string, options?: { whileBusy?: boolean }): Promise<ActionRecord>
  uncheck(ref: number | string, options?: { whileBusy?: boolean }): Promise<ActionRecord>
  hover(target: number | string | ElementPoint): Promise<ActionRecord>
  /**
   * Turn the mouse wheel: 'down'/'up', or 'right'/'left' (horizontal wheel deltas, as a trackpad or
   * tilt wheel sends) for a carousel or wide table. Without a ref: what the wheel scrolls that way in
   * the middle of the screen (an app shell's list, or the page).
   */
  scroll(direction?: ScrollDirection, options?: { screens?: number; ref?: number | string }): Promise<ActionRecord>
  scrollTo(ref: number | string): Promise<ActionRecord>
  upload(ref: number | string, files: string | string[], options?: { whileBusy?: boolean }): Promise<ActionRecord>
  /**
   * Press on `from`, move with the button held, release on `to`. Each end is a ref (a point on the
   * element that receives the pointer) or an `ElementPoint`, an exact point of an element: a stroke
   * on a canvas, a position on a custom slider's track, a map pan.
   */
  drag(from: number | string | ElementPoint, to: number | string | ElementPoint, options?: DragOptions): Promise<ActionRecord>
  open(url: string, options?: { reason?: string }): Promise<ActionRecord>
  /** Reload the tab like F5. On the tab that replaced a crashed one (PAGE RECOVERED), load the page that crashed. */
  reload(options?: { reason?: string }): Promise<ActionRecord>
  back(): Promise<ActionRecord>
  spaNavigate(pathOrUrl: string): Promise<ActionRecord>
  /**
   * Work in another tab from now on: its index in observe()'s TABS list, or text of its title or
   * URL (case-insensitive) that only one tab has. Not an action on the page.
   */
  switchTab(indexOrText: number | string): Promise<ActionRecord>
  waitForIdle(options?: { timeoutMs?: number; quietMs?: number }): Promise<ActionRecord>
  wait(ms: number, options?: { reason?: string }): Promise<ActionRecord>
  dialog: {
    accept(promptText?: string): Promise<ActionRecord>
    /** Answers a native dialog with Cancel, or cancels an open file dialog. */
    dismiss(): Promise<ActionRecord>
    /** Choose files (paths relative to the session cwd) in the file dialog that is open on the tab. */
    chooseFiles(files: string | string[]): Promise<ActionRecord>
    /**
     * The session's answer to confirm and prompt dialogs, on every tab, from now on: 'accept'
     * (a prompt gets `promptText`, else its own default), 'dismiss', or 'ask' (the default: they
     * stay open for act.dialog.accept()/dismiss()). A "Leave site?" (beforeunload) is answered only
     * by its own `beforeunload` setting: 'leave', 'stay', or 'ask' (the default). Alerts are always
     * acknowledged. Each answer is stated in the report. A setting, not an action on the page.
     */
    policy(
      policy: 'accept' | 'dismiss' | 'ask',
      options?: { beforeunload?: BeforeUnloadPolicy; promptText?: string },
    ): Promise<ActionRecord>
  }
}

/**
 * A point of an element for act.click/dblclick/hover/drag: `x`/`y` are CSS px from the top-left
 * corner of the element's border box as laid out (before any CSS transform; a rotated, scaled or
 * tilted element is mapped through its transform). x runs from 0 up to, not including, the box's
 * width, and y from 0 up to, not including, its height: the far edges are outside the element.
 */
export interface ElementPoint {
  ref: number | string
  x: number
  y: number
}

/**
 * A pointer target as the model's (untyped) code passed it: a ref, or a ref and a point of its
 * element. `what` names the argument in a refusal (`act.drag: from`), `nothing` ends it.
 */
function pointerTarget(end: unknown, what: string, nothing: string): { ref: number | string; offset?: Point } {
  if (typeof end === 'number' || typeof end === 'string') return { ref: end }
  if (typeof end !== 'object' || end === null || !('ref' in end) || (typeof end.ref !== 'number' && typeof end.ref !== 'string')) {
    throw new ActError(
      `${what} must be a ref (12 or 'e3') or { ref, x, y } with x/y in CSS px from the element's top-left corner ` +
        `(got ${typeof end === 'object' && end !== null ? JSON.stringify(end) : String(end)}). ${nothing}`,
    )
  }
  const x = 'x' in end ? end.x : undefined
  const y = 'y' in end ? end.y : undefined
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ActError(
      `${what} { ref: ${JSON.stringify(end.ref)}, x: ${String(x)}, y: ${String(y)} }: x and y must be finite numbers, CSS px from ` +
        `the element's top-left corner. ${nothing}`,
    )
  }
  return { ref: end.ref, offset: { x, y } }
}

/** The mouse button of a click as the model's (untyped) code passed it. */
function clickButton(button: unknown, method: string): 'left' | 'right' | 'middle' {
  if (button === undefined) return 'left'
  if (button === 'left' || button === 'right' || button === 'middle') return button
  throw new ActError(`act.${method}: button must be 'left', 'right' or 'middle' (got ${JSON.stringify(button)}). Nothing was clicked.`)
}

/** What a pointer action's report line adds after its target: the point of the element, the button when not the left one. */
function pointerDetail(offset: Point | undefined, button: 'left' | 'right' | 'middle'): string | undefined {
  const parts = [offset ? `at (${offset.x}, ${offset.y})` : '', button === 'left' ? '' : `with the ${button} button`].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : undefined
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

/**
 * Typed text or a value for the report: masked when secret, else cut at 80 with each line break shown
 * as ⏎, the notation of every report line (page-observe's `quote`), so it stays on its line.
 */
function maskIfSecret(text: string, secret: boolean): string {
  if (secret) return text ? '••••' : ''
  const shown = text.replace(/\r\n|\r|\n|\u2028|\u2029/g, '⏎')
  return shown.length > 80 ? `${shown.slice(0, 77)}…` : shown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** How far an input's press got: sent to Chrome, then confirmed by it (the page received it). */
type PressStage = 'not sent' | 'sent' | 'acknowledged'

/** `page`'s tab is closed now, or closes within CLOSE_AFTER_INPUT_MS. */
async function closesSoon(page: Page): Promise<boolean> {
  if (page.isClosed()) return true
  const closed = Promise.withResolvers<boolean>()
  const onClose = (): void => closed.resolve(true)
  page.once('close', onClose)
  const timer = setTimeout(() => closed.resolve(page.isClosed()), CLOSE_AFTER_INPUT_MS)
  try {
    return await closed.promise
  } finally {
    clearTimeout(timer)
    page.off('close', onClose)
  }
}

/** `Shift+Tab` → its keys, split the way Playwright's keyboard.press splits them (a lone or last `+` is the key `+`). */
function keyTokens(key: string): string[] {
  const tokens: string[] = []
  let building = ''
  for (const char of key) {
    if (char === '+' && building) {
      tokens.push(building)
      building = ''
    } else {
      building += char
    }
  }
  tokens.push(building)
  return tokens
}

function dialogNote(dialog: JsDialogState): string {
  return `a native ${dialogLabel(dialog)} dialog opened — the page is frozen until it is answered (act.dialog.accept() / act.dialog.dismiss())`
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
 *  - fromLeft(n) and the rest of SCROLL_ORIGIN_JS (page-observe.ts): how far `n` is scrolled from
 *    its left edge, where its horizontal scrolling starts, and which `<body>` is the viewport's.
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
  ${SCROLL_ORIGIN_JS}
  const scrollerFor = (el, axis, dir) => {
    const doc = document.scrollingElement || document.documentElement
    for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
      if (n === document.body || n === document.documentElement) return doc
      const s = getComputedStyle(n)
      if (axis === 'y' && overflowScrolls(s.overflowY) && n.scrollHeight > n.clientHeight + 1) {
        if (dir > 0 ? fromTop(n) + n.clientHeight < n.scrollHeight - 1 : fromTop(n) > 0) return n
      }
      if (axis === 'x' && overflowScrolls(s.overflowX) && n.scrollWidth > n.clientWidth + 1) {
        if (dir > 0 ? fromLeft(n) + n.clientWidth < n.scrollWidth - 1 : fromLeft(n) > 0) return n
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
 *
 * Scrolling only goes as far as it can: dy/dx are cut to what each scroller has left to scroll, so
 * at the end of a list or of the page the plan settles for the part of the element already in view
 * (`atEnd` says the page could not go further). An element in a layer fixed to the window
 * (position: fixed, itself or an ancestor) does not move when the page scrolls: only the scrollers
 * inside that layer are wheeled, judged by the part of them inside the window, and `pinnedIn` names
 * the layer.
 *
 * `fn({ spot }, el)`: bring point `spot` of `el` (in this frame's viewport) into view instead: a
 * fingertip-sized square around it, all of it inside the visible area — as far as scrolling can
 * bring it in. At each level only the part of the square inside the scroller's content (or the
 * document) counts: a point by the edge of a canvas that fills the page, or at the end of a
 * list, is in view once the point itself is, though its square sticks out where nothing scrolls.
 */
const SCROLL_PLAN_FN = `function(args, el) {
  if (!el || !el.isConnected) return null
  ${WHEEL_HELPERS}
  const spot = args && args.spot
  const r = spot ? { top: spot.y - 12, bottom: spot.y + 12, left: spot.x - 12, right: spot.x + 12 } : el.getBoundingClientRect()
  // \`rect\` cut to the content of scroller \`n\` (the document's scrolling element for the page), in viewport px.
  const reachable = (rect, n, page) => {
    if (!spot) return rect
    const c = page ? { top: 0, left: 0 } : n.getBoundingClientRect()
    const top = c.top + (page ? 0 : n.clientTop) - n.scrollTop, left = c.left + (page ? 0 : n.clientLeft) - fromLeft(n)
    return { top: Math.max(rect.top, top), bottom: Math.min(rect.bottom, top + n.scrollHeight), left: Math.max(rect.left, left), right: Math.min(rect.right, left + n.scrollWidth) }
  }
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
  // \`d\` px of scrolling for scroller \`n\` along \`axis\` (positive: down/right), cut to what it has left; 0 when it is at that end.
  const room = (n, d, axis) => {
    if (d === 0) return 0
    const at = axis === 'y' ? fromTop(n) : fromLeft(n)
    const max = axis === 'y' ? n.scrollHeight - n.clientHeight : n.scrollWidth - n.clientWidth
    const cut = d > 0 ? Math.min(d, max - at) : Math.max(d, -at)
    return Math.abs(cut) < 1 ? 0 : cut
  }
  const up = (n) => n.parentElement || (n.getRootNode().host ?? null)
  // The layer fixed to the window that el is in (el itself or an ancestor): no scroller outside it moves el.
  let layer = null
  for (let n = el; n && n !== document.documentElement; n = up(n)) if (getComputedStyle(n).position === 'fixed') { layer = n; break }
  const beyond = layer ? up(layer) : null
  const plan = (scroller, area, dy, dx, label) => {
    const axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x'
    const dir = Math.sign(axis === 'y' ? dy : dx)
    return { container: area, dy, dx, label, ...wheelPoint(area, scroller, axis, dir) }
  }
  // Walk outwards. A scroller that is itself out of sight cannot be wheeled; a person first
  // scrolls what contains IT, so its rect becomes the thing to bring into view one level up.
  let target = r
  for (let n = up(el); n && n !== document.body && n !== document.documentElement; n = up(n)) {
    if (layer && n === beyond) break
    const s = getComputedStyle(n)
    const canY = overflowScrolls(s.overflowY) && n.scrollHeight > n.clientHeight + 1
    const canX = overflowScrolls(s.overflowX) && n.scrollWidth > n.clientWidth + 1
    if (!canY && !canX) continue
    const c = n.getBoundingClientRect()
    const area = clipToViewport(c)
    // In a fixed layer only the part of the scroller inside the window counts: nothing brings the rest in.
    if (layer && !area) { target = c; continue }
    const box = layer ? { top: area.y, bottom: area.y + area.height, left: area.x, right: area.x + area.width } : c
    target = reachable(target, n, false)
    const dy = canY ? room(n, need(target.top, target.bottom, box.top, box.bottom), 'y') : 0
    const dx = canX ? room(n, need(target.left, target.right, box.left, box.right), 'x') : 0
    if (dy === 0 && dx === 0) continue
    if (area) return plan(n, area, dy, dx, labelOf(n))
    target = c
  }
  if (layer) return { container: null, dy: 0, dx: 0, label: 'page', pinnedIn: labelOf(layer) }
  const page = document.scrollingElement || document.documentElement
  target = reachable(target, page, true)
  const wantY = need(target.top, target.bottom, 0, vh), wantX = need(target.left, target.right, 0, vw)
  const dy = room(page, wantY, 'y'), dx = room(page, wantX, 'x')
  if (dy === 0 && dx === 0) return { container: null, dy, dx, label: 'page', atEnd: wantY !== 0 || wantX !== 0 }
  return plan(page, { x: 0, y: 0, width: vw, height: vh }, dy, dx, 'page')
}`

/**
 * `fn({ axis, dir, x, y })`: what a wheel turned at (x, y) of this frame's viewport (its centre
 * when absent) is over, and what Chromium's scroll chaining scrolls from there in this document
 * along `axis` — the nearest ancestor that can still scroll that way, else the document's
 * scrolling element. Returned as [hit, scroller] (nodesReturnedBy); the hit tells whether the
 * point is over an iframe.
 */
const SCROLLER_AT_POINT_FN = `function(args) {
  ${WHEEL_HELPERS}
  const hit = deepHit(args.x === undefined ? window.innerWidth / 2 : args.x, args.y === undefined ? window.innerHeight / 2 : args.y)
  return [hit, hit ? scrollerFor(hit, args.axis, args.dir) : (document.scrollingElement || document.documentElement)]
}`

/**
 * `fn({ axis, dir }, el)`: where to turn the wheel to scroll `el` along `axis` ('y' up/down, 'x'
 * sideways; the document's scrolling element, <html> or <body> mean the page). `atEnd`: it cannot
 * scroll further that way; `scrollable: false`: it does not scroll on that axis at all;
 * `otherWay`: it scrolls on the other axis instead (a carousel asked to scroll down), and can
 * still move that way along it (1: down/right, -1: up/left). Null when `el` is gone.
 */
const WHEEL_POINT_FN = `function(args, el) {
  ${WHEEL_HELPERS}
  if (!el || !el.isConnected) return null
  const vw = window.innerWidth, vh = window.innerHeight
  const doc = document.scrollingElement || document.documentElement
  const y = args.axis === 'y'
  if (el === doc || el === document.documentElement || el === document.body) {
    const at = y ? fromTop(doc) : fromLeft(doc), size = y ? doc.scrollHeight : doc.scrollWidth, client = y ? vh : doc.clientWidth
    const atEnd = args.dir > 0 ? at + client >= size - 1 : at <= 0
    return { ...wheelPoint({ x: 0, y: 0, width: vw, height: vh }, doc, args.axis, args.dir), label: 'the page', atEnd, scrollable: size > client + 1 }
  }
  const s = getComputedStyle(el)
  const along = (vertical) => vertical
    ? { at: fromTop(el), size: el.scrollHeight, client: el.clientHeight, overflow: s.overflowY }
    : { at: fromLeft(el), size: el.scrollWidth, client: el.clientWidth, overflow: s.overflowX }
  const own = along(y)
  const scrollable = overflowScrolls(own.overflow) && own.size > own.client + 1
  const atEnd = !scrollable || (args.dir > 0 ? own.at + own.client >= own.size - 1 : own.at <= 0)
  const c = el.getBoundingClientRect()
  const left = Math.max(c.left, 0), top = Math.max(c.top, 0), right = Math.min(c.right, vw), bottom = Math.min(c.bottom, vh)
  if (right <= left || bottom <= top) return { offscreen: true, label: labelOf(el), atEnd, scrollable }
  if (atEnd) {
    const other = along(!y)
    const otherScrolls = !scrollable && overflowScrolls(other.overflow) && other.size > other.client + 1
    return { label: labelOf(el), atEnd, scrollable, ...(otherScrolls ? { otherWay: other.at + other.client < other.size - 1 ? 1 : -1 } : {}) }
  }
  return { ...wheelPoint({ x: left, y: top, width: right - left, height: bottom - top }, el, args.axis, args.dir), label: labelOf(el), atEnd, scrollable }
}`

/**
 * `fn({ axis }, el)`: the scroll state of `el` along `axis` (the document's scrolling element,
 * <html> or <body> mean the page), in CSS px: `raw` is Chrome's scrollTop/scrollLeft, which moves
 * only when it scrolls; `at` is how far it is from its top or left edge, which for an area that
 * starts at its bottom or right edge also grows when content is added above it or on its left.
 */
const SCROLL_OFFSET_FN = `function(args, el) {
  if (!el || !el.isConnected) return null
  ${SCROLL_ORIGIN_JS}
  const doc = document.scrollingElement || document.documentElement
  const page = el === doc || el === document.documentElement || el === document.body
  const s = page ? doc : el
  if (args.axis === 'y') return { at: fromTop(s), raw: s.scrollTop, size: s.scrollHeight, client: page ? window.innerHeight : s.clientHeight }
  return { at: fromLeft(s), raw: s.scrollLeft, size: s.scrollWidth, client: s.clientWidth }
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
  /** The layer fixed to the window the element is in, when it is in one: page scrolling does not move it. */
  pinnedIn?: string
  /** The page had to scroll further to show the element, but it is already at that end. */
  atEnd?: boolean
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
  /** It scrolls on that axis at all (overflow that scrolls, with more content than fits). */
  scrollable: boolean
  /** It scrolls on the other axis instead, and can still move this way along it (1: down/right, -1: up/left). */
  otherWay?: 1 | -1
}

/** A scroller's state along one axis (SCROLL_OFFSET_FN), in CSS px. */
interface ScrollOffset {
  /** How far it is from its top or left edge. */
  at: number
  /** Chrome's scrollTop or scrollLeft: changes only when it scrolls. */
  raw: number
  /** scrollHeight or scrollWidth. */
  size: number
  /** What is visible of it on that axis. */
  client: number
}

/** Which way act.scroll turns the wheel: up/down along 'y', left/right along 'x'. */
export type ScrollDirection = 'down' | 'up' | 'right' | 'left'

const SCROLL_DIRECTIONS: Record<ScrollDirection, { axis: 'x' | 'y'; dir: 1 | -1 }> = {
  down: { axis: 'y', dir: 1 },
  up: { axis: 'y', dir: -1 },
  right: { axis: 'x', dir: 1 },
  left: { axis: 'x', dir: -1 },
}

/** What FIELD_FN reports about a field right before and after typing into it. */
interface FieldFacts {
  tag: string
  type: string
  /** A text field act.fill/act.type type into key by key. */
  editable: boolean
  contentEditable: boolean
  /**
   * `value` for inputs/textareas; for contenteditable its text line by line as a person reads it
   * (see FIELD_FN); null otherwise.
   */
  value: string | null
  /**
   * Where the selection is in the field's text: whether its start is at the very start, its end at
   * the very end, and whether it is a caret. Null when the field exposes none to read (an email or
   * number input has no selectionStart; a contenteditable with no selection range).
   */
  selection: { atStart: boolean; atEnd: boolean; collapsed: boolean } | null
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
 *
 * A contenteditable's value is its text line by line, the way a person reads it: a block
 * (paragraph, div, list item) or a <br> starts a new line, except a <br> that ends its block (it
 * only holds an empty last line open), and the non-breaking spaces an editor stores for typed
 * spaces read as spaces. innerText does not: it counts a paragraph's margins as a blank line and
 * that <br> as one more, so "Line 1⏎Line 2" typed into a paragraph editor reads back as
 * "Line 1⏎⏎Line 2". A collapsible space at the end of a line is dropped, as innerText and the
 * screen do (indented markup: "<p>⏎  Dear Ann,⏎</p>" reads "Dear Ann,"). The selection is judged on
 * the same lines: a caret is at the end when no line or text follows it.
 */
const FIELD_FN = `function(_, el) {
  if (!el || !el.isConnected) return null
  const active = (() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a })()
  const focused = !!active && (active === el || el.contains(active) || (el.shadowRoot && el.shadowRoot.contains(active)))
  const tag = el.tagName ? el.tagName.toLowerCase() : ''
  const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase()
  const notText = ['checkbox','radio','button','submit','reset','file','image','range','color','hidden','date','time','datetime-local','month','week']
  const editable = el.isContentEditable || tag === 'textarea' || (tag === 'input' && !notText.includes(type))
  // With \`stop\` ({ node, offset }, a selection boundary in DOM terms), the text before that point only.
  const linesOf = (root, stop) => {
    // \`pending\`: a collapsible space shown only if more text follows on its line.
    let out = '', atLineStart = true, owe = false, started = false, done = false, pending = ''
    const isBlock = (n) => { const d = getComputedStyle(n).display; return d !== 'contents' && !d.startsWith('inline') }
    // Collapsible white space (white-space normal, nowrap, pre-line) reads as one space, none at a line start or end.
    const collapses = (n) => ['normal', 'nowrap', 'pre-line'].includes(getComputedStyle(n.parentNode).whiteSpace)
    const collapse = (n, data) => { const ws = getComputedStyle(n.parentNode).whiteSpace; return ws === 'pre-line' ? data.replace(/[ \\t]+/g, ' ') : collapses(n) ? data.replace(/[ \\t\\n\\r\\f]+/g, ' ') : data }
    const shown = (n) => n.nodeType === 3 ? (collapses(n) ? !/^ ?$/.test(collapse(n, n.data)) : n.data !== '') : n.nodeType === 1 && n.localName !== 'script' && n.localName !== 'style' && getComputedStyle(n).display !== 'none'
    const endsBlock = (br) => {
      for (let n = br; ; n = n.parentNode) {
        for (let next = n.nextSibling; next; next = next.nextSibling) if (shown(next)) return false
        if (!n.parentNode || n.parentNode === root || isBlock(n.parentNode)) return true
      }
    }
    const walk = (node) => {
      const children = node.childNodes
      for (let i = 0; i < children.length; i++) {
        if (stop && stop.node === node && stop.offset === i) { done = true; return }
        const child = children[i]
        if (child.nodeType === 3) {
          const cut = !!stop && stop.node === child
          const collapsible = collapses(child)
          let text = collapse(child, cut ? child.data.slice(0, stop.offset) : child.data)
          if (collapsible && (atLineStart || pending)) text = text.replace(/^ +/, '')
          let tail = ''
          if (collapsible && text.endsWith(' ')) { tail = ' '; text = text.replace(/ +$/, '') }
          if (text !== '') {
            if (owe) { out += '\\n'; owe = false }
            out += pending + text.replace(/\\u00a0/g, ' ')
            pending = ''
            atLineStart = out.endsWith('\\n')
            started = true
          }
          if (tail && !atLineStart) pending = tail
          if (cut) { done = true; return }
          continue
        }
        if (!shown(child)) continue
        if (child.localName === 'br') {
          if (owe) { out += '\\n'; owe = false }
          if (!endsBlock(child)) out += '\\n'
          atLineStart = true
          started = true
          pending = ''
          continue
        }
        const block = isBlock(child)
        if (block) pending = ''
        if (block && !atLineStart) { owe = true; atLineStart = true }
        walk(child)
        if (done) return
        if (block && started) { owe = true; atLineStart = true; pending = '' }
      }
      if (stop && stop.node === node) done = true
    }
    walk(root)
    // A boundary right after a finished block is on the line that block's end opens.
    if (done && owe) out += '\\n'
    return out
  }
  const value = 'value' in el && typeof el.value === 'string' ? el.value : (el.isContentEditable ? linesOf(el) : null)
  const selection = (() => {
    if (typeof el.selectionStart === 'number' && typeof el.value === 'string') {
      return { atStart: el.selectionStart === 0, atEnd: el.selectionEnd === el.value.length, collapsed: el.selectionStart === el.selectionEnd }
    }
    if (!el.isContentEditable) return null
    const root = el.getRootNode()
    const sel = root.getSelection ? root.getSelection() : getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return { atStart: false, atEnd: false, collapsed: range.collapsed }
    return {
      atStart: linesOf(el, { node: range.startContainer, offset: range.startOffset }) === '',
      // Past the last block (an editor's select-all, or Chrome's Ctrl+End after a final <hr>) reads as the
      // line that block's end opens, value + newline: nothing shown comes after it.
      atEnd: [value, value + '\\n'].includes(linesOf(el, { node: range.endContainer, offset: range.endOffset })),
      collapsed: range.collapsed,
    }
  })()
  const describe = (n) => n ? (n.tagName ? n.tagName.toLowerCase() : n.nodeName) + (n.id ? '#' + n.id : '') + (n.getAttribute && n.getAttribute('aria-label') ? ' "' + n.getAttribute('aria-label') + '"' : '') : 'nothing'
  return {
    tag, type, editable, contentEditable: !!el.isContentEditable, value, selection, focused, activeLabel: describe(active),
    autocomplete: (el.getAttribute && el.getAttribute('autocomplete')) || '',
    textSecurity: getComputedStyle(el).webkitTextSecurity || 'none',
    disabled: !!el.disabled, readOnly: !!el.readOnly,
  }
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

/**
 * A colour input's value (`#rrggbb`), whether it has a `list` (Chrome then opens its swatch popup,
 * color_suggestion_picker.js, instead of the colour chooser, color_picker.js), and whether its
 * chooser is open: Chrome sets `:open` on the input exactly while it is (measured on Chrome 133,
 * headless and headed, for inputs that are display:none, visibility:hidden or aria-hidden too).
 */
const COLOUR_INPUT_FN = `function(_args, el) {
  if (!el || !el.isConnected) return null
  return { value: el.value, swatches: el.hasAttribute('list'), open: el.matches(':open') }
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
   * `DOM.getNodeForLocation` takes the point in DOCUMENT coordinates of the session's root frame
   * (Chromium maps it with DocumentToFrame): the viewport point plus how far that document is
   * scrolled. Measured: on a page scrolled 720px, (100, 100) answers "No node found at given
   * location" and (100, 820) answers the element drawn at (100, 100).
   */
  async function hitTest(probe: ActProbe, point: Point, what: string): Promise<{ frameId: string; backendNodeId: number }> {
    let frame: FrameHandle = probe.frames.main
    let local = point
    for (;;) {
      const scrolled = await frame.world.evaluate<Point>('({ x: scrollX, y: scrollY })', { what: `reading how far the page is scrolled, ${what}` })
      const location = await send<Protocol.DOM.GetNodeForLocationResponse>(
        frame.cdp,
        'DOM.getNodeForLocation',
        { x: Math.round(local.x + scrolled.x), y: Math.round(local.y + scrolled.y), includeUserAgentShadowDOM: false },
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
   * What a wheel turned in the middle of the screen scrolls along `axis`, as Chromium chains it:
   * the scroller under that point in the innermost iframe there; when it cannot move that way, the
   * one around the iframe in its parent, and so on out to the page's.
   */
  async function scrollerAtCentre(probe: ActProbe, axis: 'x' | 'y', dir: number): Promise<{ frame: FrameHandle; backendNodeId: number }> {
    const viewport = await viewportRect(probe)
    const centre = { x: viewport.width / 2, y: viewport.height / 2 }
    const chain: Array<{ frame: FrameHandle; backendNodeId: number }> = []
    let frame: FrameHandle = probe.frames.main
    let local: Point = centre
    for (;;) {
      const [hit, scroller] = await frame.world.nodesReturnedBy([], SCROLLER_AT_POINT_FN, {
        args: { axis, dir, x: local.x, y: local.y },
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
        args: { axis, dir },
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
   * A finger swipe from `at` (a point over the scroller the input reaches) that scrolls about
   * (scrollX, scrollY) px, positive down/right: the finger moves the other way, at most `limit` px
   * and 60% of the screen, never off it (touch-input.ts). What really moved is the caller's to measure.
   */
  async function swipe(step: Step, at: Point, scrollX: number, scrollY: number, limit = Infinity): Promise<void> {
    const screen = step.page.viewportSize() ?? (await visibleArea(step.probe, step.probe.frames.mainFrameId()))
    const { dx } = swipeFor(at, 'x', scrollX, screen, Math.min(limit, screen.width * 0.6))
    const { dy } = swipeFor(at, 'y', scrollY, screen, Math.min(limit, screen.height * 0.6))
    await untilDialog(step.probe, touchStroke(step.probe.cdp, step.page, swipeSamples(at, dx, dy), randomBetween(100, 160), { sleep }), step.record)
  }

  /** Nothing of `target` a person could point at is inside `viewport`: its box (or the point `offset` of it), else null. */
  async function outOfView(probe: ActProbe, target: RefTarget, offset: Point | undefined, rects: Rect[], viewport: Rect): Promise<Rect | null> {
    if (offset) {
      const at = (await borderBox(probe, target)).at(offset)
      const inside = at.x >= viewport.x && at.x < viewport.x + viewport.width && at.y >= viewport.y && at.y < viewport.y + viewport.height
      return inside ? null : { ...at, width: 0, height: 0 }
    }
    return rects.some((rect) => intersectRects(rect, viewport) !== null) ? null : rects[0]
  }

  /**
   * Wheel until the target is in view, the way a person does: over the scroller that clips it
   * (an outer one first when that scroller is itself off-screen), at a point the wheel really
   * reaches (hit-tested, so not over a sticky header or a nested list), one flick at a time.
   * There is no programmatic scroll behind this. Where scrolling cannot go further (the end of the
   * page or list, a layer fixed to the window, a page that ignores the wheel) the part of the
   * target already in view is used, as a person points at what they see; only when none of it is
   * in view does the action stop, saying why. With `offset` (CSS px in the target's border box, see
   * `borderBox`) it is that point of the target that is brought into view.
   */
  async function bringIntoView(step: Step, target: RefTarget, offset?: Point): Promise<{ rects: Rect[]; viewport: Rect; notes: string[] }> {
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
    const what = offset ? `(${offset.x}, ${offset.y}) of ${describeTarget(target)}` : describeTarget(target)
    // Nothing of the target a person could point at is inside `viewport`: its box (or the chosen point of it), else null.
    const outOfSight = (rects: Rect[], viewport: Rect): Promise<Rect | null> => outOfView(probe, target, offset, rects, viewport)
    const reached = (rects: Rect[], viewport: Rect): { rects: Rect[]; viewport: Rect; notes: string[] } => {
      if (scrolled.size > 0) {
        notes.push(`scrolled with ${isTouchPage(page) ? 'finger swipes' : 'the mouse wheel'} to reach it: ${[...scrolled].map(([where, px]) => `${Math.round(px)}px in ${where}`).join(', then ')}`)
      }
      return { rects, viewport, notes }
    }
    for (let flick = 0; flick < 40; flick++) {
      checkAbort()
      const rects = await quadsOf(probe, target)
      if (rects.length === 0) {
        throw new ActError(`${describeTarget(target)} is not rendered right now (display:none, collapsed, or zero size). observe() shows what is visible.`)
      }
      const viewport = await visibleArea(probe, target.frameId)
      // The point, re-measured each flick, in the frame's own viewport, where the plan measures.
      let spot: Point | undefined
      if (offset) {
        const at = (await borderBox(probe, target)).at(offset)
        const box = await probe.frames.box(target.frameId)
        spot = { x: (at.x - box.x) / box.scale, y: (at.y - box.y) / box.scale }
      }
      const plan = await frame.world.callFunctionOnNodes<ScrollPlan | null>([target.backendNodeId], SCROLL_PLAN_FN, {
        args: spot ? { spot } : undefined,
        what: `planning a scroll to ${describeTarget(target)}`,
      })
      if (!plan) throw goneError(target)
      // In an iframe the plan's "page" is the iframe's own document.
      const label = inIframe && plan.label === 'page' ? 'the iframe' : plan.label
      if (Math.abs(plan.dy) < 1 && Math.abs(plan.dx) < 1) {
        // Scrolling cannot go further. Some of the target in view is enough: a person points at that part.
        const box = plan.pinnedIn || plan.atEnd ? await outOfSight(rects, viewport) : null
        if (!box) return reached(rects, viewport)
        const where =
          box.y >= viewport.y + viewport.height ? 'below' : box.y + box.height <= viewport.y ? 'above' : box.x >= viewport.x + viewport.width ? 'right of' : 'left of'
        throw new ActError(
          plan.pinnedIn
            ? `Not done: ${what} is ${where} the visible part of the page, and no scrolling brings it in: it is inside ${plan.pinnedIn}, ` +
                'a layer fixed to the window (position: fixed) that stays put when the page scrolls. Nothing was done. A person could not ' +
                'reach it with the mouse either; a larger window would show it, or the keyboard may reach it where the page supports that.'
            : `Not done: ${what} is ${where} the visible part of ${label}, and ${label} is already scrolled as far as it goes that way, ` +
                'so no part of it can be brought into view. Nothing was done. find() or observe() shows where it is.',
        )
      }
      if (!plan.point) {
        throw new ActError(
          `Cannot scroll ${label} to reach ${describeTarget(target)}: wherever a person would turn the wheel over it, the pointer ` +
            `is over ${plan.blockedBy} instead. Deal with that first (observe() shows it).`,
        )
      }
      // The plan's point is in the frame's own viewport.
      const at = inIframe ? onScreen({ ...plan.point, width: 0, height: 0 }, await probe.frames.box(target.frameId)) : plan.point
      const before = rects[0]
      const stepY = Math.sign(plan.dy) * Math.min(Math.abs(plan.dy), randomBetween(220, 460))
      const stepX = Math.sign(plan.dx) * Math.min(Math.abs(plan.dx), randomBetween(160, 320))
      record.dispatched = true
      if (isTouchPage(page)) {
        // A touch screen has no wheel and no pointer over the page: a person swipes from that point.
        await swipe(step, at, stepX, stepY)
      } else {
        if (!pointerAt || Math.hypot(pointerAt.x - at.x, pointerAt.y - at.y) > 4) {
          await deps.humanMouse.moveTo({ page, x: at.x, y: at.y })
          pointerAt = { x: at.x, y: at.y }
        }
        await page.mouse.wheel(stepX, stepY)
      }
      const after = await restingPosition(probe, target)
      if (!after) {
        throw new ActError(`${describeTarget(target)} stopped being rendered while scrolling to it. Call observe() again.`)
      }
      const moved = Math.hypot(after.x - before.x, after.y - before.y)
      if (moved < 1) {
        idleWheels += 1
        if (idleWheels >= 2) {
          const now = await quadsOf(probe, target)
          const area = await visibleArea(probe, target.frameId)
          if (now.length > 0 && (await outOfSight(now, area)) === null) {
            notes.push(`the mouse wheel did not move ${label} any further (twice), so only part of it is in view: aimed at that part`)
            return reached(now, area)
          }
          throw new ActError(
            `The page did not scroll when the mouse wheel turned over ${label} (twice), and no part of ${what} is in view: ` +
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
    let cover: { hit: { frameId: string; backendNodeId: number }; point: Point } | null = null
    for (const candidate of candidates) {
      const over = await coverAt(probe, target, candidate)
      if (over === null) return { point: candidate, hit: describeTarget(target) }
      cover ??= { hit: over, point: candidate }
    }
    const coverLabel = cover !== null ? await labelNode(probe, cover.hit.frameId, cover.hit.backendNodeId) : 'another element'
    throw new ActError(
      `Not done: ${describeTarget(target)} is covered by ${coverLabel} at every point a person could click. ` +
        'A person would first deal with what is on top (close it, accept it, or scroll it away). observe() lists the covering layer and its controls.' +
        // As a point target's refusal: the centre, as a point of what covers it, when that has a ref.
        (cover !== null ? await coverSpot(probe, cover.hit, cover.point) : ''),
    )
  }

  /**
   * What a pointer at `point` is over instead of `target`, hit-tested the way input is routed
   * (through iframes); null when it reaches the target: the target itself or something inside it,
   * in the target's own document or in an iframe within the target, or content slotted into it —
   * including the label text its own shadow host slots in, for which the hit test names the host
   * (see REACHES_TARGET_FN).
   */
  async function coverAt(probe: ActProbe, target: RefTarget, point: Point): Promise<{ frameId: string; backendNodeId: number } | null> {
    const { hit, reaches } = await reachAt(probe, target, point)
    return reaches ? null : hit
  }

  /** The element a pointer at `point` is over, hit-tested the way input is routed, and whether that is `target` or inside it (see coverAt). */
  async function reachAt(probe: ActProbe, target: RefTarget, point: Point): Promise<{ hit: { frameId: string; backendNodeId: number }; reaches: boolean }> {
    const hit = await hitTest(probe, point, `hit-testing ${describeTarget(target)}`)
    const there = await asNodeOf(probe, hit.frameId, hit.backendNodeId, target.frameId)
    if (there === target.backendNodeId) return { hit, reaches: true }
    if (there === null) return { hit, reaches: false }
    // The point in the target frame's own viewport, where the slotted text's boxes are measured.
    const box = target.frameId === probe.frames.mainFrameId() ? null : await probe.frames.box(target.frameId)
    const local = box ? { x: (point.x - box.x) / box.scale, y: (point.y - box.y) / box.scale } : point
    const inside = await (await worldOf(probe, target)).callFunctionOnNodes<boolean | null>([target.backendNodeId, there], REACHES_TARGET_FN, {
      args: local,
      what: 'checking which element the click point belongs to',
    })
    if (inside === null) throw goneError(target)
    return { hit, reaches: inside }
  }

  /**
   * `target`'s border box as `DOM.getBoxModel` gives it: its size as laid out (CSS px, before any
   * transform), and where a point of it (CSS px from its top-left corner) is on the screen (main
   * viewport), through the four corners where the box is drawn — so a rotated, scaled, skewed or
   * perspective-tilted element maps right.
   */
  async function borderBox(probe: ActProbe, target: RefTarget): Promise<{ width: number; height: number; at: (offset: Point) => Point; offsetOf: (point: Point) => Point | null }> {
    const frame = await probe.frames.handle(target.frameId)
    let model: Protocol.DOM.BoxModel
    try {
      ;({ model } = await send<Protocol.DOM.GetBoxModelResponse>(frame.cdp, 'DOM.getBoxModel', { backendNodeId: target.backendNodeId }, `measuring ${describeTarget(target)}`))
    } catch (error) {
      if (isNodeGoneError(error)) throw goneError(target)
      if (!/Could not compute box model/i.test(errorMessage(error))) throw error
      // No layout box: quadsOf tells a removed node (gone) from an unrendered one.
      await quadsOf(probe, target)
      throw new ActError(`${describeTarget(target)} is not rendered right now (display:none, collapsed, or zero size). observe() shows what is visible.`)
    }
    const origin = await probe.frames.sessionBox(frame)
    const [p0, p1, p2, p3] = [0, 2, 4, 6].map((i): Point => ({ x: origin.x + model.border[i] * origin.scale, y: origin.y + model.border[i + 1] * origin.scale }))
    const { width, height } = model
    // The projective map from the unit square to the drawn corners (0,0)→p0, (1,0)→p1, (1,1)→p2,
    // (0,1)→p3 (Heckbert, "Fundamentals of Texture Mapping", 1989): exact for any planar transform,
    // perspective and 3D included; for a parallelogram (any 2D transform) g = h = 0 and it is affine.
    const sx = p0.x - p1.x + p2.x - p3.x
    const sy = p0.y - p1.y + p2.y - p3.y
    const det = (p1.x - p2.x) * (p3.y - p2.y) - (p3.x - p2.x) * (p1.y - p2.y)
    const g = det === 0 ? 0 : (sx * (p3.y - p2.y) - (p3.x - p2.x) * sy) / det
    const h = det === 0 ? 0 : ((p1.x - p2.x) * sy - sx * (p1.y - p2.y)) / det
    return {
      width,
      height,
      at: ({ x, y }) => {
        const u = width > 0 ? x / width : 0
        const v = height > 0 ? y / height : 0
        const w = g * u + h * v + 1
        return {
          x: ((p1.x - p0.x + g * p1.x) * u + (p3.x - p0.x + h * p3.x) * v + p0.x) / w,
          y: ((p1.y - p0.y + g * p1.y) * u + (p3.y - p0.y + h * p3.y) * v + p0.y) / w,
        }
      },
      // The inverse map: solve at(offset) = point for u, v (two linear equations once multiplied by w).
      offsetOf: ({ x, y }) => {
        const a = p1.x - p0.x + g * p1.x
        const b = p3.x - p0.x + h * p3.x
        const c = p1.y - p0.y + g * p1.y
        const d = p3.y - p0.y + h * p3.y
        const [a1, b1, r1] = [a - x * g, b - x * h, x - p0.x]
        const [a2, b2, r2] = [c - y * g, d - y * h, y - p0.y]
        const den = a1 * b2 - b1 * a2
        if (den === 0) return null
        return { x: ((r1 * b2 - b1 * r2) / den) * width, y: ((a1 * r2 - r1 * a2) / den) * height }
      },
    }
  }

  /**
   * Point `offset` of `target` on the screen, checked the way a click point is, but exactly there:
   * inside what of the page is visible (`outOfView` is the refusal when it is not), and reaching the
   * target (refuses naming what covers it, and — when that has a ref — the same spot as a point of it).
   * `hit` is the element the pointer is over there: the target or something inside it.
   */
  async function pointOn(probe: ActProbe, target: RefTarget, offset: Point, viewport: Rect, outOfView: string): Promise<{ point: Point; hit: { frameId: string; backendNodeId: number } }> {
    const point = (await borderBox(probe, target)).at(offset)
    if (point.x < viewport.x || point.x >= viewport.x + viewport.width || point.y < viewport.y || point.y >= viewport.y + viewport.height) {
      throw new ActError(outOfView)
    }
    const { hit, reaches } = await reachAt(probe, target, point)
    if (!reaches) {
      throw new ActError(
        `Not done: at (${offset.x}, ${offset.y}) ${describeTarget(target)} is covered by ${await labelNode(probe, hit.frameId, hit.backendNodeId)}. ` +
          'A person would first deal with what is on top (close it, accept it, or scroll it away), or pick a point that is not covered. observe() lists the covering layer and its controls.' +
          (await coverSpot(probe, hit, point)),
      )
    }
    return { point, hit }
  }

  /**
   * The covered spot as a point of what covers it, when that has a ref: what a person pressing
   * there really presses (a modal's backdrop, a banner). Empty when the cover has no ref.
   */
  async function coverSpot(probe: ActProbe, cover: { frameId: string; backendNodeId: number }, point: Point): Promise<string> {
    const coverTarget = deps.registry.refFor(probe.targetId, cover.frameId, cover.backendNodeId)
    if (coverTarget === null) return ''
    const box = await borderBox(probe, coverTarget)
    const offset = box.offsetOf(point)
    if (offset === null) return ''
    const spot = { x: Math.round(offset.x * 10) / 10, y: Math.round(offset.y * 10) / 10 }
    if (!(spot.x >= 0 && spot.x < box.width && spot.y >= 0 && spot.y < box.height)) return ''
    return ` To press that spot anyway (it lands on what is on top): { ref: ${coverTarget.ref}, x: ${spot.x}, y: ${spot.y} }.`
  }

  /** Refuse what the page's state forbids now. Returns the busy read it made (human mode's busy guard), for the before-picture. */
  async function guard(probe: ActProbe, kind: ActKind, options: { whileBusy?: boolean } = {}): Promise<BusyRead | undefined> {
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
      const read = await probe.watch.readBusy({ since: lastDispatched(probe)?.checkpoint })
      const busy = read.signals.filter((s) => s.strength === 'strong' && BLOCKING_BUSY_KINDS.has(s.kind))
      if (busy.length > 0) {
        throw new ActError(
          `Not done: the page is still busy (${busy.map((s) => s.label).join('; ')}). A person waits for it to finish ` +
            'before doing anything else. Call act.waitForIdle(), read what changed, then decide. ' +
            '(Only if acting during loading IS what you are testing, pass { whileBusy: true }.)',
        )
      }
      return read
    }
    return undefined
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
  function scrollRepeatGuard(probe: ActProbe, record: ActionRecord, label: string, direction: ScrollDirection): void {
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
      // A ref find() gave to an element observe() does not list (a query matched it): checked live in run().
      if (deps.registry.isAdopted(target.ref)) return target
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
      // The busy read the guard just made is the before-picture's: nothing ran in between.
      const busyRead = await guard(probe, kind, options)
      let before: Observation | undefined
      if ((kind === 'dialog-accept' || kind === 'dialog-dismiss') && probe.dialogs.current()) {
        // The page is frozen by the dialog: nothing new can be read from it.
        record.checkpoint = probe.watch.checkpoint()
        record.before = probe.lastFullObservation ?? undefined
      } else if (!UNCOUNTED_KINDS[kind]) {
        // Checkpoint first: whatever happens while the picture is taken belongs to this action.
        record.checkpoint = probe.watch.checkpoint()
        before = await deps.observeQuietly(page, busyRead)
        record.before = before
      }
      const targets = before ? refs.map((ref, index) => boundTarget(ref, resolved[index], before)) : resolved
      for (const target of before ? targets : []) {
        if (!deps.registry.isAdopted(target.ref) || !target.shown) continue
        const live = await liveAx(probe, target)
        if (live.role !== target.shown.role || live.name !== target.shown.name) {
          throw new ActError(
            `Not done: [${target.ref}] now reads ${describeBinding(live)} (you saw ${describeBinding(target.shown)}). ` +
              'The page changed it since your last look; find() it again and decide.',
          )
        }
      }
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

  /**
   * Bring what a person points at for `target` into view and pick a point on it that reaches it;
   * with `offset` (a point of `target`'s border box the model chose), bring that point into view
   * and aim exactly there.
   */
  async function aimAt(step: Step, target: RefTarget, offset?: Point): Promise<Point> {
    const surface = offset ? target : await pointerSurface(step.probe, target, step.record)
    const { rects, viewport, notes } = await bringIntoView(step, surface, offset)
    step.record.notes.push(...notes)
    if (offset) {
      const outOfView = `(${offset.x}, ${offset.y}) of ${describeTarget(target)} is outside the visible page even after scrolling.`
      const { point, hit } = await pointOn(step.probe, target, offset, viewport, outOfView)
      step.record.hit = describeTarget(target)
      step.record.notes.push(
        `pointer at (${offset.x}, ${offset.y}) of [${target.ref}] = (${Math.round(point.x * 10) / 10}, ${Math.round(point.y * 10) / 10}) in the viewport, over ${await labelNode(step.probe, hit.frameId, hit.backendNodeId)}`,
      )
      return point
    }
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

  /**
   * The tab closed in answer to `input`, an input of `step` whose press Chrome confirmed. When that
   * input is the action itself (a click, a key press, a drag's drop or release), the closing is its
   * effect; any other action stops there and says so.
   *
   * A debugger cut (debugger-cut.ts) closes the page but not its tab: Chrome only took the debugger off
   * it, and the executor takes the tab back. Nothing closed then: the input went through whole
   * (`unconfirmed` null), or the page got its press and `unconfirmed` says what Chrome did not confirm —
   * the tab is there to look at, so nothing is left untellable.
   */
  async function closedByOwnInput(step: Step, input: string, isAction: boolean, unconfirmed: string | null): Promise<void> {
    if (await deps.debuggerCut(step.page)) {
      if (unconfirmed !== null) throw new ActError(`Not finished: ${CUT_OFF} during ${input}: ${unconfirmed}. ${LOOK_AFTER_CUT}`)
      if (!isAction) throw new ActError(`Not finished: ${CUT_OFF} right after ${input}: the rest of this ${step.record.kind} was not done. ${LOOK_AFTER_CUT}`)
      step.record.notes.push(`right after ${input}, ${CUT_OFF}`)
      return
    }
    step.record.closedTab = true
    if (!isAction) throw new ActError(`${input} closed the tab (the page closed itself in response): the rest of this ${step.record.kind} was not done.`)
  }

  /**
   * Press a mouse button at `point` (the pointer is already there), dialog-safe — or, on a page
   * that emulates a touch screen (a phone preset), tap there with a finger: no pointer travels
   * before the touch (touch-input.ts). A page that closes its tab in answer to the press or the
   * release takes Chrome's confirmation of the release with it: once the press was confirmed, that
   * closing is what the click did, not a failure. A debugger cut is no close (closedByOwnInput).
   */
  async function clickAt(step: Step, point: Point, clickCount: number, button: 'left' | 'right' | 'middle'): Promise<void> {
    checkAbort()
    const { page, record } = step
    record.dispatched = true
    const press: { stage: PressStage } = { stage: 'not sent' }
    const onPress = (stage: 'sent' | 'acknowledged'): void => {
      // The pointer's travel does not wait for a tab that closes under it: a press that went out
      // after the close never reached the page.
      if (stage === 'acknowledged' || !page.isClosed()) press.stage = stage
    }
    const touch = isTouchPage(page)
    const clicking: Promise<HumanMoveResult | null> = touch
      ? tap(step.probe.cdp, page, point, clickCount, { sleep, onPress }).then(() => null)
      : deps.humanMouse.click({ page, x: point.x, y: point.y, button, clickCount, delayMs: Math.round(randomBetween(45, 110)), onPress })
    const input = `the ${clickCount === 2 ? `double ${touch ? 'tap' : 'click'}` : touch ? 'tap' : 'click'}${record.hit ? ` on ${record.hit}` : ''}`
    const isAction = record.kind === 'click' || record.kind === 'dblclick'
    let move: HumanMoveResult | null | undefined
    try {
      move = await untilDialog(step.probe, clicking, record)
    } catch (error) {
      // A press that went out and failed is waited on for the close; anything before it is decided now.
      if (!(press.stage === 'not sent' ? page.isClosed() : await closesSoon(page))) throw error
      if (press.stage !== 'acknowledged' && (await deps.debuggerCut(page))) {
        throw new ActError(
          press.stage === 'not sent'
            ? `Not done: ${CUT_OFF} before the ${touch ? 'finger touched the screen' : 'mouse button was pressed'}; nothing was ${touch ? 'tapped' : 'clicked'}.`
            : `Not finished: ${CUT_OFF} while the ${touch ? 'finger touched the screen' : 'mouse button was being pressed'}: Chrome did not confirm the ` +
                `${touch ? 'touch' : 'press'}, and the ${touch ? 'finger never lifted' : 'button was never released'}, so the page got no ` +
                `${touch ? 'tap' : 'click'} — at most the ${touch ? 'touch' : 'press'}. ${LOOK_AFTER_CUT}`,
        )
      }
      if (press.stage === 'not sent') {
        throw new ActError(
          touch
            ? 'Not done: the tab closed before the finger touched the screen; nothing was tapped.'
            : 'Not done: the tab closed before the mouse button was pressed (while the pointer moved to it); nothing was clicked.',
        )
      }
      if (press.stage === 'sent') {
        throw new ActError(
          `The tab closed while the ${touch ? 'finger touched the screen' : 'mouse button was being pressed'}: Chrome closed it before confirming the ${touch ? 'touch' : 'press'}, so whether the page got it cannot be told.`,
        )
      }
      await closedByOwnInput(step, input, isAction, touch ? 'the page got the touch, and Chrome did not confirm the lift' : 'the page got the press, and Chrome did not confirm the release')
      return
    }
    if (touch) {
      record.notes.push(`${clickCount === 2 ? 'double-tapped' : 'tapped'} with a finger (touch screen: nothing moved over the page before the touch)`)
    } else if (move) {
      record.notes.push(`pointer travelled ${Math.round(move.distancePx)}px in ${Math.round(move.achievedDurationMs)}ms`)
      for (const warning of move.warnings) record.notes.push(warning)
    }
    if (page.isClosed()) await closedByOwnInput(step, input, isAction, null)
  }

  async function clickTarget(step: Step, target: RefTarget, clickCount: number, button: 'left' | 'right' | 'middle', offset?: Point): Promise<Point> {
    if (button !== 'left' && isTouchPage(step.page)) {
      throw new ActError(
        button === 'right'
          ? 'Not done: this browser emulates a touch screen (a phone or tablet preset), which has no right button. On Android Chrome a long press opens ' +
              "the context menu, but Chrome's touch emulation never turns one into a contextmenu event (measured: a 1.7 s press gives the page a plain " +
              'click), so it cannot be done here. Nothing was tapped. To test the context menu, use a browser without a device preset.'
          : 'Not done: this browser emulates a touch screen (a phone or tablet preset), which has no middle button. On a phone a link opens in a new tab ' +
              'from its long-press menu, which Chrome\'s touch emulation does not show. Nothing was tapped.',
      )
    }
    if (await isDisabled(step.probe, target)) {
      throw new ActError(`Not done: ${describeTarget(target)} is disabled right now. A person cannot click it; something on the page must enable it first.`)
    }
    if (offset) await checkOffset(step.probe, target, offset, 'Nothing was clicked.')
    const point = await aimAt(step, target, offset)
    await clickAt(step, point, clickCount, button)
    return point
  }

  /** Refuse a point the model chose outside `target`'s border box (or on a control that has no box of its own). */
  async function checkOffset(probe: ActProbe, target: RefTarget, offset: Point, nothing: string): Promise<void> {
    if (target.viaLabel) {
      throw new ActError(
        `Not done: ${describeTarget(target)} is hidden and worked through its label, so it has no box of its own to point into. ` +
          `Use [${target.ref}] itself, without x/y. ${nothing}`,
      )
    }
    const box = await borderBox(probe, target)
    const width = Math.round(box.width * 10) / 10
    const height = Math.round(box.height * 10) / 10
    if (offset.x < 0 || offset.x >= box.width || offset.y < 0 || offset.y >= box.height) {
      throw new ActError(
        `Not done: ${describeTarget(target)} is ${width}×${height} px: x must be from 0 up to, not including, ${width}, and y from 0 up to, ` +
          `not including, ${height} (got ${offset.x}, ${offset.y}), CSS px from its top-left corner. ${nothing}`,
      )
    }
  }

  /** Where a drag ends: `offset` of `to` (the model's point), or a point of `to` that receives the pointer. Both must be visible now. */
  async function dragEndPoint(probe: ActProbe, to: RefTarget, offset: Point | undefined, record: ActionRecord): Promise<Point> {
    if (offset) {
      const outOfView = `(${offset.x}, ${offset.y}) of ${describeTarget(to)} is not visible while dragging; bring both points into view first.`
      return (await pointOn(probe, to, offset, await visibleArea(probe, to.frameId), outOfView)).point
    }
    const toSurface = await pointerSurface(probe, to, record)
    const toRects = await quadsOf(probe, toSurface)
    const viewport = await visibleArea(probe, toSurface.frameId)
    if (!toRects.some((rect) => intersectRects(rect, viewport) !== null)) {
      throw new ActError(`${describeTarget(to)} is not visible while dragging; bring both into view first.`)
    }
    return (await hitPoint(probe, toSurface, toRects, viewport)).point
  }

  /**
   * The way of a drag from `from` to `to`, timed: the human plan gives a person's pace either way;
   * 'straight' keeps its timing and puts every sample on the straight line, at the minimum-jerk
   * fraction of the way for its time. Ends exactly at `to`.
   */
  async function dragSamples(page: Page, from: Point, to: Point, path: 'human' | 'straight'): Promise<Array<{ tMs: number; x: number; y: number }>> {
    const trajectory = await deps.humanMouse.plan({ page, from, x: to.x, y: to.y })
    const endMs = trajectory.samples.at(-1)?.tMs ?? 0
    const samples =
      path === 'straight'
        ? trajectory.samples.map((sample) => {
            const s = minimumJerkPosition(endMs > 0 ? sample.tMs / endMs : 1)
            return { tMs: sample.tMs, x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s }
          })
        : trajectory.samples
    return [...samples, { tMs: endMs, x: to.x, y: to.y }]
  }

  /** The report's line for a drag's way, `travelled` px along it. */
  function dragPathNote(path: 'human' | 'straight', held: string, travelled: number, distance: number): string {
    return path === 'straight'
      ? `${held} path: a straight line of ${Math.round(distance)} px`
      : `${held} path: ${Math.round(travelled)} px of a person's curved path for ${Math.round(distance)} px between the two points; ` +
          "where the way itself counts (a drawn line), pass { path: 'straight' }"
  }

  /**
   * A drag on a touch screen: the finger touches `fromPoint`, rests ~0.1 s, slides along the way to
   * `to` and lifts there (touch-input.ts) — no pointer travels to it first. Chrome's touch emulation
   * starts no HTML drag (draggable=true) from a touch; pointer- and touch-driven ones (sliders,
   * sortable lists, maps, canvases) get the finger's pointermove/touchmove events.
   */
  async function touchDrag(step: Step, fromPoint: Point, to: RefTarget, toOffset: Point | undefined, path: 'human' | 'straight'): Promise<void> {
    const { page, probe, record } = step
    const toPoint = await dragEndPoint(probe, to, toOffset, record)
    const way = await dragSamples(page, fromPoint, toPoint, path)
    const hold = randomBetween(90, 160)
    const samples = [{ tMs: 0, ...fromPoint }, ...way.filter((sample) => sample.tMs > 0).map((sample) => ({ ...sample, tMs: sample.tMs + hold }))]
    let travelled = 0
    samples.forEach((sample, index) => {
      if (index > 0) travelled += Math.hypot(sample.x - samples[index - 1].x, sample.y - samples[index - 1].y)
    })
    try {
      await untilDialog(probe, touchStroke(probe.cdp, page, samples, randomBetween(80, 160), { sleep }), record)
    } catch (error) {
      if (!(await closesSoon(page))) throw error
      await closedByOwnInput(step, 'the touch drag', true, 'Chrome did not confirm all of the stroke (the touch, the slide and the lift)')
      return
    }
    if (page.isClosed()) await closedByOwnInput(step, 'the touch drag', true, null)
    record.notes.push(dragPathNote(path, 'finger (touch screen)', travelled, Math.hypot(toPoint.x - fromPoint.x, toPoint.y - fromPoint.y)))
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

  /** A line break as text holds it: `\r\n`, `\r` or `\n`, each one key when typed. */
  const LINE_BREAK = /\r\n|\r|\n/

  /**
   * Type `text` at a person's pace, each line break as the `newline` key. Never a line break as a
   * character: Playwright's keyboard types `\n` and `\r` as Enter, which a chat composer takes as
   * "send". refuseUnsaidNewline has made sure `newline` is given whenever the text has one.
   */
  async function typeLines(page: Page, text: string, newline: FillOptions['newline']): Promise<void> {
    const [first, ...rest] = text.split(LINE_BREAK)
    await typeHuman(page, first)
    for (const line of rest) {
      if (newline === undefined) throw new ActError('A line break reached the keyboard without a newline key to type it as; the text after it was not typed.')
      checkAbort()
      await page.keyboard.press(newline, { delay: Math.round(randomBetween(40, 90)) })
      await sleep(KEY_MEAN_MS * randomBetween(1.4, 2.6))
      await typeHuman(page, line)
    }
  }

  /**
   * Select a field's whole text, or put the caret after it, with the chord a person uses on the
   * platform of the browser being driven: Ctrl+A / Ctrl+End, or ⌘A / ⌘↓ on macOS (End only
   * scrolls there). Returns the chord's name.
   *
   * Chrome on macOS runs these chords only as the editing commands its own key handling derives
   * from them (Blink's key table binds neither there), so the key events carry those commands, the
   * way Playwright's keyboard sends `macEditingCommands`. Playwright decides "macOS" from the user
   * agent the connection's Browser.getVersion reports (an extension older than the relay still
   * answers with the relay's own name), and resolves `ControlOrMeta` from this process's platform,
   * which is not the browser's when the browser runs on another machine. So the platform is read
   * here from the page's own user agent, with Playwright's test ("Macintosh"), and the keys are
   * dispatched with their commands directly.
   */
  async function pressEditingChord(probe: ActProbe, action: 'select all' | 'end of text'): Promise<string> {
    checkAbort()
    const userAgent = await probe.frames.main.world.evaluate<string>('navigator.userAgent', { what: "reading the browser's platform from its user agent" })
    const mac = userAgent.includes('Macintosh')
    const modifier = mac ? { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, mask: 4, label: '⌘' } : { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, mask: 2, label: 'Ctrl+' }
    const key =
      action === 'select all'
        ? { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, label: 'A' }
        : mac
          ? { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, label: '↓' }
          : { key: 'End', code: 'End', windowsVirtualKeyCode: 35, label: 'End' }
    const commands = mac ? [action === 'select all' ? 'selectAll' : 'moveToEndOfDocument'] : []
    const held = { key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.windowsVirtualKeyCode, location: 1 }
    const pressed = { key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode }
    const chord = `${modifier.label}${key.label}`
    await send(probe.cdp, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: modifier.mask, ...held }, `pressing ${chord}`)
    await sleep(randomBetween(30, 70))
    await send(probe.cdp, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: modifier.mask, ...pressed, commands }, `pressing ${chord}`)
    await sleep(randomBetween(40, 90))
    await send(probe.cdp, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: modifier.mask, ...pressed }, `releasing ${chord}`)
    await send(probe.cdp, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, ...held }, `releasing ${chord}`)
    return chord
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
   * In a field that takes several lines, the key for a new line is the app's to decide: a chat
   * composer sends on Enter and starts a new line on Shift+Enter; a plain text area or a code
   * editor starts one on Enter. Typed key by key, text with a line break needs `newline` to say
   * which; act never guesses (a wrong Enter sends half a message, irreversibly).
   */
  function refuseUnsaidNewline(kind: 'fill' | 'type', field: RefTarget, facts: FieldFacts, text: string, options: FillOptions): void {
    if (options.paste || options.newline !== undefined || facts.tag === 'input') return
    const breaks = text.split(LINE_BREAK).length - 1
    if (breaks === 0) return
    throw new ActError(
      `Not done: the text has ${breaks} line break${breaks === 1 ? '' : 's'} and ${describeTarget(field)} takes several lines, where the key for a new line ` +
        'depends on the app: in a chat composer Enter sends the message and Shift+Enter starts a new line; in a plain text area or a code editor Enter ' +
        `starts a new line. Say which: act.${kind}(${field.ref}, text, { newline: 'Shift+Enter' }), or { newline: 'Enter' }, or { paste: true }, which ` +
        'inserts the text, line breaks included, without key events. Nothing was typed.',
    )
  }

  /** `newline` checked at run time (the model's code is untyped): one of the two keys, and never with `paste`. */
  function refuseBadNewlineOption(kind: 'fill' | 'type', options: FillOptions): void {
    const newline: unknown = options.newline
    if (newline === undefined) return
    if (newline !== 'Enter' && newline !== 'Shift+Enter') {
      throw new ActError(`${kind}: newline must be 'Enter' or 'Shift+Enter' (got ${JSON.stringify(newline)}). Nothing was typed.`)
    }
    if (options.paste) {
      throw new ActError(
        `${kind}: { newline } and { paste: true } contradict each other: paste types no keys, so no line break is typed as a key. ` +
          'Pass newline to type the text key by key, or paste to insert it. Nothing was typed.',
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

  /**
   * A native colour input, set the way a keyboard user does in Chrome's colour chooser (a Blink
   * page popup, color_picker.js). Chrome sends the page's keys to an open popup
   * (WebFrameWidgetImpl::HandleKeyEvent), so after a real click opens it: Shift+Tab wraps focus to
   * its format switch (the last of its controls), ArrowUp switches the switch from RGB (where it
   * always starts) to hex, Shift+Tab goes back into the hex field (focusing it selects its text),
   * the colour is typed, Enter closes the chooser. Each key in the hex field sets the input (an
   * `input` event), closing it fires `change`. Measured on Chrome 133, headless and headed.
   *
   * Whether the chooser is open is the input's `:open` state, read in the isolated world before
   * every key: Chrome sets it exactly while the chooser is open (ColorInputType::OpenPopupView /
   * DidEndChooser), for an input hidden from view or from the accessibility tree too. A key sent
   * after the chooser closed would act on the page, so none is. A native dialog the page opens on
   * the click or on an `input` event freezes the page: nothing more is sent or read.
   *
   * A chooser already open (from an act.click on the input) is cancelled first with Escape, as a
   * person would: which of its controls has focus is unknown, so the keys would not reach the hex
   * field. Then the steps above.
   *
   * The value read back must be the one asked for; when it is not, Escape cancels the chooser (the
   * first press puts back the colour it opened with, the next closes it).
   */
  async function fillColour(step: Step, target: RefTarget, text: string): Promise<void> {
    const { page, probe, record } = step
    if (!/^#[0-9a-f]{6}$/i.test(text)) {
      throw new ActError(
        `${describeTarget(target)} is a colour input: give the colour as #rrggbb, six hex digits (e.g. act.fill(${target.ref}, '#3366cc')); "${text}" is not in that form.`,
      )
    }
    const wanted = text.toLowerCase()
    record.detail = wanted
    const world = await worldOf(probe, target)
    const sent: string[] = []
    /** Refuse to go on while a native dialog freezes the page: nothing in it can be read or used until it is answered. */
    const stopIfDialog = (): void => {
      const dialog = probe.dialogs.current()
      if (dialog?.handling !== 'agent') return
      throw new ActError(
        `${sent.length ? `Choosing ${wanted} in Chrome's colour chooser for ${describeTarget(target)} (keys sent: ${sent.join(' ')})` : `Clicked ${describeTarget(target)}`}, ` +
          `and a native ${dialog.type}("${dialog.message}") opened: the page is frozen until it is answered. Answer it (act.dialog.accept() or ` +
          `act.dialog.dismiss()); observe() then shows what the colour input reads and whether its chooser is still open.`,
      )
    }
    const readColour = async (): Promise<{ value: string; swatches: boolean; open: boolean }> => {
      stopIfDialog()
      const facts = await world.callFunctionOnNodes<{ value: string; swatches: boolean; open: boolean } | null>([target.backendNodeId], COLOUR_INPUT_FN, {
        what: `reading ${describeTarget(target)}`,
      })
      if (!facts) throw goneError(target)
      return facts
    }
    /** Read until the chooser is open (`wanted`) or closed, or `ms` have passed: the last reading. */
    const readWhen = async (open: boolean, ms: number): Promise<{ value: string; swatches: boolean; open: boolean }> => {
      const deadline = Date.now() + ms
      for (;;) {
        const facts = await readColour()
        if (facts.open === open || Date.now() > deadline) return facts
        await sleep(50)
      }
    }
    /** One key to the open chooser, at a person's pace; refused once it has closed, since the key would act on the page. */
    const pressInChooser = async (key: string, pause: number): Promise<void> => {
      checkAbort()
      const now = await readColour()
      if (!now.open) {
        throw new ActError(
          `Chrome's colour chooser for ${describeTarget(target)} closed before act.fill was done (keys sent to it: ${sent.length ? sent.join(' ') : 'none'}). ` +
            `No more keys were sent: they would act on the page. The input reads ${now.value}. If the chooser closed while a key was on its way, that ` +
            'key reached the page: observe() shows what it did.',
        )
      }
      await untilDialog(probe, key.length === 1 ? page.keyboard.type(key) : page.keyboard.press(key), record)
      sent.push(key)
      stopIfDialog()
      await sleep(pause)
    }
    let before = await readColour()
    if (before.swatches) {
      // Measured on Chrome 133: ArrowDown focuses a swatch, but Enter and Space then do nothing,
      // and a click where the popup is goes to the page and closes it, choosing nothing.
      throw new ActError(
        `${describeTarget(target)} is a colour input with suggested colours (a list): Chrome opens its swatch popup for it, not the colour chooser. ` +
          'From the keyboard that popup takes only the arrow keys and Escape — its script cancels every other key, so neither Enter nor Space picks a ' +
          'swatch or "Other…" — and a click on it reaches the page instead, which closes it. A person can only choose there with the mouse ' +
          'inside the popup, which page input cannot reach: ask the user to pick the colour.',
      )
    }
    if (before.open) {
      // Which of its controls has focus is unknown, so the keys below would not reach the hex field.
      // Start from a closed chooser, the way a person cancels it: Escape puts back the colour it
      // opened with (it stays open when that changed something), the next Escape closes it.
      const shown = before.value
      record.dispatched = true
      let escapes = 0
      while (before.open) {
        if (escapes === 2) {
          throw new ActError(
            `Chrome's colour chooser for ${describeTarget(target)} was open and is still open after Escape twice, showing ${before.value}; keys go to it ` +
              `rather than the page. act.press('Enter') closes it keeping ${before.value}.`,
          )
        }
        checkAbort()
        await untilDialog(probe, page.keyboard.press('Escape'), record)
        sent.push('Escape')
        escapes += 1
        stopIfDialog()
        await sleep(randomBetween(150, 260))
        before = await readColour()
      }
      record.notes.push(
        `its colour chooser was already open, showing ${shown}: cancelled it with Escape (${escapes === 1 ? 'once' : 'twice'}), which left ${before.value}`,
      )
    }
    if (before.value === wanted) {
      record.notes.push(`${wanted} was already chosen; nothing to do`)
      return
    }
    refuseIfTooSlow(wanted.length + 4, `Choosing ${wanted} in the colour chooser`, '')
    await clickTarget(step, target, 1, 'left')
    const opened = await readWhen(true, 1000)
    if (!opened.open) {
      throw new ActError(
        colourChooserNotOpened({ target: describeTarget(target), ref: target.ref, value: opened.value, visibility: await deps.tabVisibility(probe) }),
      )
    }
    // A person takes in the chooser before reaching for the keys; its script is up by then too.
    await sleep(randomBetween(450, 800))
    for (const key of ['Shift+Tab', 'ArrowUp', 'Shift+Tab']) await pressInChooser(key, KEY_MEAN_MS * randomBetween(1.2, 2.2))
    for (const char of wanted) await pressInChooser(char, KEY_MEAN_MS * randomBetween(0.55, 1.35))
    await sleep(randomBetween(80, 160))
    const typed = await readColour()
    if (typed.value !== wanted) {
      let escapes = 0
      for (let now = typed; now.open && escapes < 2; now = await readColour()) {
        await untilDialog(probe, page.keyboard.press('Escape'), record)
        sent.push('Escape')
        escapes += 1
        stopIfDialog()
        await sleep(randomBetween(150, 260))
      }
      const now = await readColour()
      const cancelled =
        escapes === 0
          ? 'The chooser had already closed, so no Escape was sent.'
          : now.open
            ? `Pressed Escape ${escapes} times, but the chooser is still open: act.press('Escape') closes it.`
            : `Cancelled it with Escape (${escapes === 1 ? 'once' : 'twice'}).`
      throw new ActError(
        `Typed ${wanted} where the hex field of Chrome's colour chooser for ${describeTarget(target)} should be, but the input reads ${typed.value}: ` +
          `the chooser did not take it there. ${cancelled} The input reads ${now.value}. Ask the user to pick the colour.`,
      )
    }
    // The page may close the chooser itself once the colour is typed (a re-render on `input`). Enter
    // would then reach the page: submit its form, or reopen the chooser on the focused input.
    const beforeEnter = await readColour()
    if (beforeEnter.open) {
      await untilDialog(probe, page.keyboard.press('Enter'), record)
      sent.push('Enter')
      // A dialog the page opened on `change` waits for the agent; nothing in the page can be read
      // until it is answered, and the report names it.
      if (probe.dialogs.current()?.handling === 'agent') return
    }
    const after = await readWhen(false, 1000)
    if (after.open) {
      throw new ActError(
        `${describeTarget(target)} reads ${after.value}, but Chrome's colour chooser is still open after Enter, and keys go to it rather than the page. ` +
          `act.press('Enter') closes it keeping ${after.value}; Escape would put back ${before.value} first (a second Escape closes it).`,
      )
    }
    if (after.value !== wanted) {
      throw new ActError(`Chose ${wanted} in the colour chooser of ${describeTarget(target)}, but once it closed the input reads ${after.value}: the page changed or rejected it.`)
    }
    record.notes.push(
      `chose it in Chrome's colour chooser: Shift+Tab to its format switch, ArrowUp to hex, Shift+Tab into the hex field, typed ${wanted}, ` +
        `${beforeEnter.open ? 'Enter' : 'and the page closed the chooser itself, so no Enter was sent'}; value read back: "${after.value}"`,
    )
  }

  /** The editing host around `target` and the block `target` is in (EDITOR_PARTS_FN); null when `target` is not editable content. */
  async function editorParts(probe: ActProbe, target: RefTarget): Promise<{ host: number; block: number } | null> {
    const [host, block] = await (await worldOf(probe, target)).nodesReturnedBy([target.backendNodeId], EDITOR_PARTS_FN, {
      what: `finding the editor around ${describeTarget(target)}`,
    })
    return typeof host === 'number' && typeof block === 'number' ? { host, block } : null
  }

  /** EDITOR_BLOCK_FN of `block` in the editor `host` (nodes of `target`'s frame). */
  async function editorBlock(probe: ActProbe, target: RefTarget, block: number, host: number): Promise<EditorBlockFacts> {
    const facts = await (await worldOf(probe, target)).callFunctionOnNodes<EditorBlockFacts | null>([block, host], EDITOR_BLOCK_FN, {
      what: `reading the block of ${describeTarget(target)} in its editor`,
    })
    if (!facts) throw goneError(target)
    return facts
  }

  /**
   * The report line for the block of editor `host` the caret is in now, with its whole text as a
   * person reads it (FIELD_FN's lines): `~ paragraph 2 "…"`. Null when the caret is not in it.
   */
  async function caretBlockLine(probe: ActProbe, target: RefTarget, host: number): Promise<string | null> {
    const world = await worldOf(probe, target)
    const [block] = await world.nodesReturnedBy([host], EDITOR_CARET_BLOCK_FN, { what: 'finding the block the caret is in' })
    if (typeof block !== 'number') return null
    const facts = await world.callFunctionOnNodes<EditorBlockFacts | null>([block, host], EDITOR_BLOCK_FN, { what: 'naming the block the caret is in' })
    const lines = await world.callFunctionOnNodes<FieldFacts | null>([block], FIELD_FN, { what: 'reading the block the caret is in' })
    if (!facts || !lines || lines.value === null) return null
    return `~ ${facts.label} "${lines.value}"`
  }

  /**
   * Put the caret at the end of the block `editor.block` of a rich editor, as a person does: a
   * click on the right half of its last character (Ctrl+End would go to the end of the whole
   * editor), then a check that the selection is a caret at the block's end and focus is in the
   * editor. Returns the block as the field typed into.
   */
  async function caretAtBlockEnd(step: Step, target: RefTarget, editor: { host: number; block: number }): Promise<{ field: RefTarget; facts: FieldFacts }> {
    const { probe, record } = step
    const block: RefTarget = editor.block === target.backendNodeId ? target : { ...target, backendNodeId: editor.block, viaLabel: undefined }
    const facts = await editorBlock(probe, target, editor.block, editor.host)
    if (!facts.end) {
      throw new ActError(`${facts.label} of the editor (${describeTarget(target)}) is not drawn right now, so a person cannot click into it. observe() shows the editor.`)
    }
    const point = await aimAt(step, block, facts.end)
    await clickAt(step, point, 1, 'left')
    await sleep(randomBetween(60, 140))
    const now = await editorBlock(probe, target, editor.block, editor.host)
    const field = await readField(probe, block)
    if (!now.hostFocused || !field.selection || !field.selection.collapsed || !field.selection.atEnd) {
      throw new ActError(
        `Not done: clicked after the last character of ${facts.label} (${describeTarget(target)}), but ` +
          `${now.hostFocused ? 'the caret is not at its end (the page put it elsewhere)' : `keyboard focus went to ${field.activeLabel}`}. Nothing was typed. ` +
          `Put the caret there another way (act.click({ ref: ${target.ref}, x, y }) or the End key), then act.type(${target.ref}, text, { at: 'caret' }).`,
      )
    }
    record.notes.push(`put the caret at the end of ${facts.label} with a click after its last character`)
    return { field: block, facts: field }
  }

  /** { at: 'caret' }: keyboard focus must be in `target` (a field, or the editor it belongs to) and its caret or selection there. */
  async function caretWhereItIs(step: Step, target: RefTarget, editor: { host: number; block: number } | null, before: FieldFacts): Promise<void> {
    const { probe, record } = step
    const inEditor = editor ? (await editorBlock(probe, target, editor.block, editor.host)).hostFocused : false
    const caretIn = editor ? inEditor && (await caretBlockLine(probe, target, editor.host)) !== null : before.focused
    if (!caretIn) {
      throw new ActError(
        `Not done: the caret is not in ${describeTarget(target)} (keyboard focus is in ${before.activeLabel}). Put it where the text goes first — ` +
          `act.click(${target.ref}), or act.click({ ref: ${target.ref}, x, y }) at the spot — then act.type(${target.ref}, text, { at: 'caret' }). Nothing was typed.`,
      )
    }
    record.notes.push('typed where the caret was')
  }

  async function fillOrType(ref: number | string, text: string, options: FillOptions, append: boolean): Promise<ActionRecord> {
    const kind = append ? 'type' : 'fill'
    return run(
      kind,
      async (step) => {
        const { page, probe, record } = step
        const [target] = step.targets
        refuseBadNewlineOption(kind, options)
        const at: unknown = options.at
        if (at !== undefined && (at !== 'caret' || !append)) {
          throw new ActError(
            append
              ? `{ at: ${JSON.stringify(at)} } is not an option of act.type: { at: 'caret' } types where the caret is. Nothing was typed.`
              : "act.fill replaces the whole text; { at: 'caret' } is for act.type. Nothing was typed.",
          )
        }
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
          if (append) throw new ActError(`${describeTarget(target)} is a colour input: set it with act.fill(${target.ref}, '#rrggbb').`)
          await fillColour(step, target, text)
          return
        }
        if (!before.editable) {
          throw new ActError(`${describeTarget(target)} is not a text field (it is <${before.tag}${before.type ? ` type=${before.type}` : ''}>). Use act.click / act.select / act.check for it.`)
        }
        refuseNewlineInInput(target, before, text)
        refuseUnsaidNewline(kind, target, before, text, options)
        const secret = isSecret(before)
        record.detail = maskIfSecret(text, secret)
        if (secret) await refuseUntoldSecret(page, probe, target, options)
        // What the field holds once typed: a line break is one key, and fields hold it as \n.
        const typed = text.split(LINE_BREAK).join('\n')
        const lineBreaks = typed.split('\n').length - 1
        // Always a person's pace, never sped up to fit the call: if it does not fit, say so first.
        if (!options.paste) {
          refuseIfTooSlow(typed.length, `Typing these ${typed.length} characters`, ', or pass { paste: true } for text a person would paste rather than type')
        }
        // Where the keys go: where the caret is ({ at: 'caret' }); the end of the block of a rich
        // editor the ref is in (a click after its last character); else the clicked field, its text
        // then selected (fill) or the caret put after it (type).
        const editor = before.contentEditable ? await editorParts(probe, target) : null
        let point: Point | null = null
        let field = target
        let focused = before
        const placed = at === 'caret' || (append && editor !== null && editor.block !== editor.host)
        if (at === 'caret') {
          record.dispatched = true
          await caretWhereItIs(step, target, editor, before)
        } else if (placed && editor) {
          ;({ field, facts: focused } = await caretAtBlockEnd(step, target, editor))
        } else {
          point = await clickTarget(step, target, 1, 'left')
          ;({ field, facts: focused } = await fieldUnderCaret(step, target, point, 'when it was clicked'))
        }
        let typedSecret = secret
        if (field !== target && !placed) {
          // The field the page swapped in gets the clicked one's refusals before a key reaches it.
          refuseNewlineInInput(field, focused, text)
          refuseUnsaidNewline(kind, field, focused, text, options)
          typedSecret = isSecret(focused)
          if (typedSecret) {
            record.detail = maskIfSecret(text, true)
            await refuseUntoldSecret(page, probe, field, options)
          }
        }
        if (!placed && !focused.focused) {
          throw new ActError(`Clicked ${describeTarget(target)} but the keyboard focus went to ${focused.activeLabel}, so typing would land there. observe() and check what took focus.`)
        }
        if (!append && focused.value) {
          const chord = await pressEditingChord(probe, 'select all')
          await sleep(randomBetween(60, 140))
          const selected = (await readField(probe, field)).selection
          if (selected && !(selected.atStart && selected.atEnd)) {
            throw new ActError(
              `Not done: pressed ${chord} in ${describeTarget(field)} to select its text for replacing, but not all of it is selected (the page handles ` +
                `that key itself), so typing would not replace it. Nothing was typed. Clear it the way the page offers (observe() lists a clear button), or ` +
                `act.type(${field.ref}, text) to add to it.`,
            )
          }
          if (text.length === 0) {
            await page.keyboard.press('Backspace')
          }
          record.notes.push(`replaced the previous value ${typedSecret ? '(masked)' : `"${maskIfSecret(focused.value, false)}"`}`)
        } else if (append && !placed && focused.value) {
          // End only reaches the end of the clicked line in a text area or editor; this reaches the end of the text.
          const chord = await pressEditingChord(probe, 'end of text')
          await sleep(randomBetween(40, 90))
          const caret = (await readField(probe, field)).selection
          if (caret && !(caret.collapsed && caret.atEnd)) {
            throw new ActError(
              `Not done: pressed ${chord} in ${describeTarget(field)} to put the caret after its text, but the caret is not at the end (the page moved ` +
                `it or handles that key itself), so the text would land in the middle. Nothing was typed. act.fill(${field.ref}, …) with the whole text ` +
                'replaces it instead.',
            )
          }
          record.notes.push(`put the caret after the text with ${chord}`)
        }
        if (options.paste) {
          await page.keyboard.insertText(typed)
          record.notes.push(`inserted ${typed.length} characters as IME text (no paste event)`)
        } else {
          await typeLines(page, text, options.newline)
          if (lineBreaks > 0) record.notes.push(`typed ${lineBreaks} line break${lineBreaks === 1 ? '' : 's'} as ${options.newline}`)
          if (typedSecret) record.notes.push('typed a secret (masked in this report)')
        }
        await sleep(randomBetween(80, 160))
        let after: FieldFacts | null
        if (point) {
          const read = await fieldUnderCaret(step, field, point, 'while the text was typed')
          after = read.facts
          if (read.field !== field && isSecret(after) && !typedSecret) {
            // The keys ended in a secret field the page swapped in: the report must not show them.
            typedSecret = true
            record.detail = maskIfSecret(text, true)
          }
        } else {
          // An editor may re-render the block it typed into: the caret's block is reported below.
          after = await (await worldOf(probe, field)).callFunctionOnNodes<FieldFacts | null>([field.backendNodeId], FIELD_FN, { what: `reading ${describeTarget(field)}` })
        }
        const caretLine = editor ? await caretBlockLine(probe, target, editor.host) : null
        if (after && after.value !== null) {
          // At the caret, where in the text it was typed is the page's, so no value is predicted.
          const expected = at === 'caret' ? null : append ? `${focused.value ?? ''}${typed}` : typed
          if (expected !== null && after.value !== expected) {
            record.notes.push(
              typedSecret
                ? 'the field value differs from what was typed (the page transformed or rejected some keys)'
                : `value read back: "${maskIfSecret(after.value, false)}" — differs from what was typed (the page transformed, limited or rejected some keys)`,
            )
          } else if (!typedSecret && !(placed && caretLine)) {
            record.notes.push(`value read back: "${maskIfSecret(after.value, false)}"`)
          }
        }
        if (caretLine) record.notes.push(`typed into ${caretLine.slice(2)}`)
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

  /** Scroll state of node `scrollerId` (in the frame of `world`) along `axis`, once smooth scrolling has come to rest (its raw offset still). */
  async function restingOffset(world: IsolatedWorld, scrollerId: number, axis: 'x' | 'y', gone: () => ActError): Promise<ScrollOffset> {
    const read = async (): Promise<ScrollOffset> => {
      const offset = await world.callFunctionOnNodes<ScrollOffset | null>([scrollerId], SCROLL_OFFSET_FN, { args: { axis }, what: 'reading the scroll position' })
      if (!offset) throw gone()
      return offset
    }
    let last = await read()
    const deadline = Date.now() + 900
    while (Date.now() < deadline) {
      await sleep(50)
      const now = await read()
      if (Math.abs(now.raw - last.raw) < 0.5) return now
      last = now
    }
    return last
  }

  /**
   * Turn the wheel over a scroller: `container` (a ref), or — without one — what Chromium's scroll
   * chaining scrolls from the middle of the screen, which in an app shell is its main list, not the
   * document, and over an iframe is what scrolls inside it. Left and right turn it sideways with
   * horizontal wheel deltas (a trackpad's or tilt wheel's), which Chrome scrolls a carousel with
   * (measured on Chrome 133, headless and headed; so does Shift+wheel). The scroller's own offset
   * is measured before and after.
   *
   * The wheel turns only as far as the scroller can still move (its scrollTop/scrollLeft against
   * its scrollHeight/scrollWidth): what a wheel turns beyond a scroll area's edge chains to what
   * contains it, and the page moved instead (lab: a chat log asked for 10 screens moved 980px, the
   * page 1300px more). A container that is off-screen is first brought into view, as a person
   * scrolls the page to the area before wheeling over it; the report says so.
   */
  async function scrollBy(step: Step, direction: ScrollDirection, screens: number, container: RefTarget | undefined): Promise<void> {
    const { page, probe, record } = step
    const { axis, dir } = SCROLL_DIRECTIONS[direction]
    const words =
      axis === 'y'
        ? { more: dir > 0 ? 'below' : 'above', end: dir > 0 ? 'bottom' : 'top' }
        : { more: dir > 0 ? 'to the right' : 'to the left', end: dir > 0 ? 'right end' : 'left end' }
    let scrollerId: number
    let scrollerRef: RefTarget | null
    let frame: FrameHandle
    if (container) {
      scrollerId = container.backendNodeId
      scrollerRef = container
      frame = await probe.frames.handle(container.frameId)
    } else {
      const found = await scrollerAtCentre(probe, axis, dir)
      scrollerId = found.backendNodeId
      frame = found.frame
      scrollerRef = deps.registry.refFor(probe.targetId, frame.frameId, found.backendNodeId)
      if (scrollerRef) record.target = targetSummary(scrollerRef)
    }
    const inIframe = frame.frameId !== probe.frames.mainFrameId()
    const goneScroller = (): ActError =>
      container ? goneError(container) : new ActError('The scroll area in the middle of the screen disappeared while scrolling it. Call observe() again.')
    const aimWheel = async (): Promise<{ aim: WheelAim; point: Point | undefined; outside: boolean }> => {
      const aim = await frame.world.callFunctionOnNodes<WheelAim | null>([scrollerId], WHEEL_POINT_FN, {
        args: { axis, dir },
        what: 'finding where to turn the mouse wheel',
      })
      if (!aim) throw goneScroller()
      // In an iframe the aim is in the iframe's own viewport, and "the page" is the iframe's document.
      const point = aim.point && inIframe ? onScreen({ ...aim.point, width: 0, height: 0 }, await probe.frames.box(frame.frameId)) : aim.point
      const area = inIframe ? await visibleArea(probe, frame.frameId) : null
      const outside = point && area ? point.x < area.x || point.y < area.y || point.x > area.x + area.width || point.y > area.y + area.height : false
      return { aim, point, outside }
    }
    let { aim, point, outside } = await aimWheel()
    const label = scrollerRef
      ? describeTarget(scrollerRef)
      : inIframe && aim.label === 'the page'
        ? `the page inside iframe ${await probe.frames.documentUrl(frame.frameId)}`
        : aim.label
    record.detail = `${direction} ${screens} screen${screens === 1 ? '' : 's'} over ${label}`
    record.repeatKey = `${scrollerRef?.key ?? `${step.before?.documentId ?? page.url()}:${frame.frameId}:node${scrollerId}`}|${direction}`
    scrollRepeatGuard(probe, record, label, direction)
    if ((aim.offscreen || outside) && container) {
      const { notes } = await bringIntoView(step, container)
      record.notes.push(`brought ${label} into view first${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`)
      ;({ aim, point, outside } = await aimWheel())
      if (aim.offscreen || outside) {
        throw new ActError(`${describeTarget(container)} is still outside the visible page after scrolling to it, so the wheel cannot be turned over it. observe() shows where it is.`)
      }
    }
    if (container && aim.atEnd) {
      // A wheel over a scroll area at its end chains to what contains it: the page would move, not this.
      record.scrollMoved = 0
      record.notes.push(
        aim.scrollable
          ? `nothing to scroll: ${label} is already at the ${words.end} (a wheel over it would scroll what contains it instead)`
          : aim.otherWay !== undefined
            ? `nothing to scroll: ${label} does not scroll ${axis === 'y' ? 'up or down; it scrolls sideways' : 'sideways; it scrolls up and down'} ` +
              `(act.scroll('${axis === 'y' ? (aim.otherWay > 0 ? 'right' : 'left') : aim.otherWay > 0 ? 'down' : 'up'}', { ref: ${container.ref} }))`
            : `nothing to scroll: ${label} does not scroll${axis === 'x' ? ' sideways' : ''} (its content fits)`,
      )
      return
    }
    if (!point) {
      throw new ActError(
        `Cannot scroll ${label}: wherever a person would turn the wheel over it, ` +
          `the pointer is over ${aim.blockedBy} instead, which scrolls something else or nothing. Deal with that first (observe() shows it).`,
      )
    }
    const before = await restingOffset(frame.world, scrollerId, axis, goneScroller)
    const requested = Math.max(40, screens * before.client)
    // As far as it can still move: a wheel beyond its edge would scroll what contains it.
    const room = Math.max(0, Math.floor(dir > 0 ? before.size - before.at - before.client : before.at))
    const total = Math.min(requested, room) * dir
    const touch = isTouchPage(page)
    if (total !== 0) record.dispatched = true
    if (touch && total !== 0) {
      // A phone has no wheel: a person swipes over the area, measured after each swipe (the touch
      // slop and a little fling make the distance a swipe scrolls vary). Each starts at the aimed
      // point and moves at most 45% of the area, so the finger stays on it.
      let progress = 0
      let idle = 0
      for (let swipes = 0; swipes < 40 && idle < 2 && Math.abs(total) - Math.abs(progress) > 16; swipes++) {
        checkAbort()
        const flick = Math.sign(total) * Math.min(Math.abs(total) - Math.abs(progress), randomBetween(180, 420))
        await swipe(step, point, axis === 'x' ? flick : 0, axis === 'y' ? flick : 0, before.client * 0.45)
        const now = (await restingOffset(frame.world, scrollerId, axis, goneScroller)).raw - before.raw
        idle = Math.abs(now - progress) < 1 ? idle + 1 : 0
        progress = now
        await sleep(randomBetween(70, 150))
      }
    } else if (total !== 0) {
      await deps.humanMouse.moveTo({ page, x: point.x, y: point.y })
      let done = 0
      while (Math.abs(done) < Math.abs(total)) {
        checkAbort()
        const flick = Math.sign(total) * Math.min(Math.abs(total) - Math.abs(done), randomBetween(180, 420))
        if (axis === 'y') await page.mouse.wheel(0, flick)
        else await page.mouse.wheel(flick, 0)
        done += flick
        await sleep(randomBetween(70, 150))
      }
    }
    const after = await restingOffset(frame.world, scrollerId, axis, goneScroller)
    // Chrome's own offset: the distance from the top or left edge of an area that starts at its
    // bottom or right edge also grows when the page adds content there while it scrolls (a chat
    // log loading older messages).
    const moved = after.raw - before.raw
    record.scrollMoved = Math.round(Math.abs(moved))
    const remaining = dir > 0 ? after.size - after.at - after.client : after.at
    const where = `${(Math.max(0, remaining) / after.client).toFixed(1)} screens ${words.more}`
    if (Math.abs(moved) < 1) {
      record.scrollMoved = 0
      record.notes.push(
        remaining >= 1
          ? `nothing moved although ${label} has more ${words.more} (${where}): the page handles ${touch ? 'touch swipes' : 'the mouse wheel'} itself here`
          : container
            ? `nothing moved: ${label} is at the ${words.end}`
            : `nothing moved: nothing in the middle of the screen can scroll further ${direction} (${label} and every scroll area there are at the ${words.end})`,
      )
    } else if (room <= requested && remaining < 1) {
      record.notes.push(`reached the ${words.end} of ${label} after ${Math.round(Math.abs(moved))}px`)
    } else {
      record.notes.push(`scrolled ${label} ${Math.round(Math.abs(moved))}px${axis === 'x' ? ` ${words.more}` : ''}; ${where}`)
    }
  }

  /**
   * Press an arrow key `presses` times (positive: ↓, negative: ↑) the way a person does: a few taps,
   * or the key held down for many (the first press, the keyboard's repeat delay, then auto-repeated
   * presses at its ~30 per second). False when a native dialog the page opened stopped the keys.
   */
  async function pressArrows(step: Step, presses: number): Promise<boolean> {
    const { page, probe, record } = step
    const key = presses > 0 ? 'ArrowDown' : 'ArrowUp'
    const count = Math.abs(presses)
    if (count <= 6) {
      for (let pressed = 0; pressed < count; pressed++) {
        checkAbort()
        await untilDialog(probe, page.keyboard.press(key, { delay: Math.round(randomBetween(40, 80)) }), record)
        if (probe.dialogs.current()?.handling === 'agent') return false
        await sleep(randomBetween(90, 180))
      }
      return true
    }
    try {
      for (let pressed = 0; pressed < count; pressed++) {
        checkAbort()
        await untilDialog(probe, page.keyboard.down(key), record)
        if (probe.dialogs.current()?.handling === 'agent') return false
        await sleep(pressed === 0 ? randomBetween(380, 520) : randomBetween(30, 38))
      }
    } finally {
      if (probe.dialogs.current()?.handling !== 'agent') await page.keyboard.up(key)
    }
    return true
  }

  /** `${n} × ↓` for a note; '' for none. */
  function arrowsNote(presses: number): string {
    return presses === 0 ? '' : `${Math.abs(presses)} × ${presses > 0 ? '↓' : '↑'}`
  }

  /**
   * The option a native drop-down select shows as chosen or, while its list is open, highlighted:
   * Chrome's accessibility value of the select follows the open list's highlight (measured on
   * Chrome 149 and 151, headless and headed). Null when Chrome reports none.
   */
  async function selectShows(probe: ActProbe, target: RefTarget): Promise<string | null> {
    const result = await send<Protocol.Accessibility.GetPartialAXTreeResponse>(
      await cdpOf(probe, target),
      'Accessibility.getPartialAXTree',
      { backendNodeId: target.backendNodeId, fetchRelatives: false },
      `reading which option ${describeTarget(target)} highlights`,
    )
    const value = result.nodes.find((node) => node.backendDOMNodeId === target.backendNodeId)?.value?.value
    return typeof value === 'string' ? value : null
  }

  /**
   * Choose option `plan.index` of a native drop-down select the way a person does with Chrome's
   * list: click the select (its list opens), type the start of the option's label (type-ahead),
   * arrow keys for the rest, check that the list highlights it, then Enter — one change event.
   * Measured on Chrome 149: keys reach the open list (the page sees no keydown), the select's
   * selectedIndex stays until Enter. Arrowing through a 200-option list one key at a time took
   * 28–31 s; in a real Chrome the button release of the opening click can land in the list and
   * choose a row by itself. When the list is not open after the click (that release chose a row,
   * or the click closed a list the model had opened), the select keeps focus, closed, and the same
   * keys change it directly on Windows and Linux, each read back exactly.
   */
  async function chooseInMenuList(step: Step, target: RefTarget, plan: SelectPlan, readState: () => Promise<SelectState>): Promise<void> {
    const { page, probe, record } = step
    const options = plan.options ?? []
    const index = plan.index ?? -1
    const label = plan.label ?? ''
    let state = await readState()
    if (state.open) {
      record.notes.push('its list was open already')
    } else {
      await clickTarget(step, target, 1, 'left')
      await sleep(randomBetween(120, 220))
      state = await readState()
      if (state.index !== plan.selectedIndex) {
        record.notes.push(`the click itself chose "${state.selected}": Chrome took the button release as a choice in the list it opened`)
      }
    }
    record.dispatched = true
    if (state.open) {
      const route = keyRoute(options, state.index, index)
      await typeHuman(page, route.typed)
      if (!(await pressArrows(step, route.arrows))) return
      let shown = await selectShows(probe, target)
      let arrows = route.arrows
      // The highlight is elsewhere: where, exactly, when that label is one option's only.
      const at = options.flatMap((candidate, i) => (candidate.label === shown ? [i] : []))
      if (shown !== label && at.length === 1) {
        const fix = arrowPresses(options, at[0], index)
        if (!(await pressArrows(step, fix))) return
        arrows += fix
        shown = await selectShows(probe, target)
      }
      const how = [route.typed ? `typed "${route.typed}"` : '', arrowsNote(arrows)].filter(Boolean).join(', then ')
      if (shown !== label) {
        await page.keyboard.press('Escape')
        throw new ActError(
          `Not done: ${how || 'nothing typed'} in the open list of ${describeTarget(target)}, but it highlights ` +
            `${shown === null ? 'no option' : `"${shown}"`} instead of "${label}". Escape closed the list; nothing was chosen. ` +
            `act.click(${target.ref}) opens the list; observe() then lists its options.`,
        )
      }
      record.notes.push(`${how || 'it was highlighted'} in its open list, then Enter`)
      await untilDialog(probe, page.keyboard.press('Enter'), record)
      return
    }
    if (!state.focused) {
      throw new ActError(
        `Not done: clicked ${describeTarget(target)}, but its list did not open and keyboard focus is not on it, so keys would go elsewhere. observe() shows what took focus.`,
      )
    }
    const userAgent = await probe.frames.main.world.evaluate<string>('navigator.userAgent', { what: "reading the browser's platform from its user agent" })
    if (userAgent.includes('Macintosh')) {
      throw new ActError(
        `Not done: clicked ${describeTarget(target)}, but its list did not open. On macOS the arrow keys of a closed select open its list instead of ` +
          `changing it; act.click(${target.ref}) opens it, then act.select(${target.ref}, …) chooses in it.`,
      )
    }
    // A closed select changes with every key (each one fires input and change): typed first, the rest by arrows from where it really is.
    const route = keyRoute(options, state.index, index)
    for (const char of route.typed) {
      checkAbort()
      await untilDialog(probe, page.keyboard.type(char), record)
      if (probe.dialogs.current()?.handling === 'agent') return
      await sleep(KEY_MEAN_MS * randomBetween(0.55, 1.35))
    }
    state = await readState()
    const arrows = arrowPresses(options, state.index, index)
    if (!(await pressArrows(step, arrows))) return
    const how = [route.typed ? `typed "${route.typed}"` : '', arrowsNote(arrows)].filter(Boolean).join(', then ')
    record.notes.push(`its list was closed, so the keys chose on the select itself: ${how}`)
  }

  /**
   * After choosing `label` (option `index`): watch the select for half a second, as a person glances
   * at it. Chrome applies the choice at once; a page that refuses it puts its own value back — which
   * is said only when the choice was seen taken and then undone.
   */
  async function confirmChoice(step: Step, target: RefTarget, plan: SelectPlan, readState: () => Promise<SelectState>, how: string): Promise<void> {
    const { probe, record } = step
    const label = plan.label ?? ''
    const watchedFrom = Date.now()
    let seenAt: number | null = null
    let after: SelectState
    for (;;) {
      // A native dialog the change opened freezes the page: the report names it, nothing more is read.
      if (probe.dialogs.current()?.handling === 'agent') return
      after = await readState()
      if (after.chosen) seenAt ??= Date.now()
      if (Date.now() - watchedFrom >= 500) break
      await sleep(50)
    }
    if (!after.chosen) {
      if (seenAt !== null) {
        throw new ActError(
          `Chose "${label}" in ${describeTarget(target)}: it showed "${label}", then the page changed it back to "${after.selected}" ` +
            `(within ${Date.now() - seenAt}ms). The page refuses that choice; observe() may show why.`,
        )
      }
      throw new ActError(
        `${how} "${label}" in ${describeTarget(target)}, but it shows "${after.selected}" and did not show "${label}" in the ${Date.now() - watchedFrom}ms ` +
          'it was watched. Whether Chrome did not take it or the page put its value back at once cannot be told from outside; observe() shows the page now.',
      )
    }
    record.notes.push(
      plan.multiple
        ? `selected "${label}"; now selected: ${after.selectedLabels.map((selected) => `"${selected}"`).join(', ')}`
        : `selected "${label}" (was "${plan.before}")`,
    )
  }

  const api: ActApi = {
    click: (targetArg, options = {}) => {
      // The model's code is untyped: a malformed target or button is refused before anything runs.
      const end = pointerTarget(targetArg, 'act.click: the target', 'Nothing was clicked.')
      const button = clickButton(options.button, 'click')
      return run(
        'click',
        async (step) => {
          await clickTarget(step, step.targets[0], 1, button, end.offset)
        },
        { refs: [end.ref], whileBusy: options.whileBusy, again: options.again, detail: pointerDetail(end.offset, button) },
      )
    },
    dblclick: (targetArg, options = {}) => {
      const end = pointerTarget(targetArg, 'act.dblclick: the target', 'Nothing was clicked.')
      const button = clickButton(options.button, 'dblclick')
      return run(
        'dblclick',
        async (step) => {
          await clickTarget(step, step.targets[0], 2, button, end.offset)
        },
        { refs: [end.ref], whileBusy: options.whileBusy, again: options.again, detail: pointerDetail(end.offset, button) },
      )
    },
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
          // One key event at a time, as Playwright's keyboard.press sends them (modifiers down, the key
          // down and up, modifiers up): a tab the page closes in answer to the key is told from one
          // closed before the key reached it by whether Chrome confirmed the key-down.
          const tokens = keyTokens(key)
          const main = tokens[tokens.length - 1]
          const modifiers = tokens.slice(0, -1)
          const press: { stage: PressStage } = { stage: 'not sent' }
          const keys = async (): Promise<void> => {
            for (const modifier of modifiers) await page.keyboard.down(modifier)
            if (!page.isClosed()) press.stage = 'sent'
            await page.keyboard.down(main)
            press.stage = 'acknowledged'
            await page.keyboard.up(main)
            for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier)
          }
          try {
            await untilDialog(probe, keys(), record)
          } catch (error) {
            if (!(press.stage === 'not sent' ? page.isClosed() : await closesSoon(page))) throw error
            if (press.stage !== 'acknowledged' && (await deps.debuggerCut(page))) {
              throw new ActError(
                press.stage === 'not sent'
                  ? `Not done: ${CUT_OFF} before the key ${key} was pressed; the key did not reach the page.`
                  : `Not finished: ${CUT_OFF} while the key ${key} was being pressed: Chrome did not confirm it, and it was never released, so the page got at most its keydown. ${LOOK_AFTER_CUT}`,
              )
            }
            if (press.stage === 'not sent') throw new ActError(`Not done: the tab closed before the key ${key} was pressed; no key reached the page.`)
            if (press.stage === 'sent') {
              throw new ActError(`The tab closed while the key ${key} was being pressed: Chrome closed it before confirming the key, so whether the page got it cannot be told.`)
            }
            await closedByOwnInput(step, `the key ${key}`, true, 'the page got its keydown, and Chrome did not confirm its keyup')
            return
          }
          if (page.isClosed()) await closedByOwnInput(step, `the key ${key}`, true, null)
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
          if (plan.alreadySelected) {
            record.notes.push(`"${label}" was already selected; nothing to do`)
            return
          }
          const readState = async (): Promise<SelectState> => {
            const state = await world.callFunctionOnNodes<SelectState | null>([target.backendNodeId], SELECT_STATE_FN, {
              args: { index },
              what: `reading ${describeTarget(target)}`,
            })
            if (!state) throw goneError(target)
            return state
          }
          if (!plan.listBox) {
            await chooseInMenuList(step, target, plan, readState)
            await confirmChoice(step, target, plan, readState, 'Pressed Enter on')
            return
          }
          // A list box draws its options in the page: a person clicks the one they want, holding
          // Ctrl (⌘ on macOS) to add it to what a multiple list box has selected already.
          const [optionNode] = await world.nodesReturnedBy([target.backendNodeId], SELECT_OPTION_NODE_FN, {
            args: { index },
            what: `finding the option "${label}" in ${describeTarget(target)}`,
          })
          if (optionNode === undefined || optionNode === null) {
            throw new ActError(`${describeTarget(target)} lost its option "${label}" while choosing it. Call observe() again.`)
          }
          const optionTarget: RefTarget = { ...target, backendNodeId: optionNode, role: 'option', name: label, viaLabel: undefined }
          const adding = plan.multiple === true && (plan.selectedLabels ?? []).length > 0
          if (!adding) {
            await clickTarget(step, optionTarget, 1, 'left')
          } else {
            // Aimed (and wheeled into view) before the key goes down: Ctrl with the wheel zooms.
            const point = await aimAt(step, optionTarget)
            const userAgent = await probe.frames.main.world.evaluate<string>('navigator.userAgent', { what: "reading the browser's platform from its user agent" })
            const modifier = userAgent.includes('Macintosh') ? 'Meta' : 'Control'
            record.dispatched = true
            await page.keyboard.down(modifier)
            try {
              await sleep(randomBetween(60, 140))
              await clickAt(step, point, 1, 'left')
            } finally {
              await page.keyboard.up(modifier)
            }
            record.notes.push(`held ${modifier === 'Meta' ? '⌘' : 'Ctrl'} to add it to the options already selected`)
          }
          await confirmChoice(step, target, plan, readState, 'Clicked')
        },
        { refs: [ref], whileBusy: options.whileBusy, detail: `"${option}"` },
      ),
    check: (ref, options = {}) => setChecked(ref, true, options),
    uncheck: (ref, options = {}) => setChecked(ref, false, options),
    hover: (targetArg) => {
      const end = pointerTarget(targetArg, 'act.hover: the target', 'The pointer was not moved.')
      return run(
        'hover',
        async (step) => {
          if (isTouchPage(step.page)) {
            throw new ActError(
              `Not done: this browser emulates a touch screen (a phone or tablet preset), and a finger does not hover: nothing is over the page ` +
                `until it touches it. On a phone a hover menu or tooltip opens with a tap — act.click(${JSON.stringify(end.ref)}) — which also ` +
                'gives the page mouseover/mouseenter, as Chrome does for a real tap. The pointer was not moved.',
            )
          }
          if (end.offset) await checkOffset(step.probe, step.targets[0], end.offset, 'The pointer was not moved.')
          const point = await aimAt(step, step.targets[0], end.offset)
          step.record.dispatched = true
          await deps.humanMouse.moveTo({ page: step.page, x: point.x, y: point.y })
        },
        { refs: [end.ref], detail: pointerDetail(end.offset, 'left') },
      )
    },
    scroll: (direction = 'down', options = {}) =>
      run(
        'scroll',
        async (step) => {
          // The model's code is untyped: anything else would silently scroll some other way.
          if (!Object.hasOwn(SCROLL_DIRECTIONS, direction)) {
            throw new ActError(`scroll: direction must be 'down', 'up', 'right' or 'left' (got ${JSON.stringify(direction)}).`)
          }
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
    drag: (fromArg, toArg, options = {}) => {
      // The model's code is untyped: a malformed end is refused before anything runs.
      const fromEnd = pointerTarget(fromArg, 'act.drag: from', 'Nothing was dragged.')
      const toEnd = pointerTarget(toArg, 'act.drag: to', 'Nothing was dragged.')
      const path = options.path ?? 'human'
      if (path !== 'human' && path !== 'straight') {
        throw new ActError(`act.drag: path must be 'human' or 'straight' (got ${JSON.stringify(path)}). Nothing was dragged.`)
      }
      return run(
        'drag',
        async (step) => {
          const { page, probe, record } = step
          const [from, to] = step.targets
          const pointIn = (offset: Point, target: RefTarget): string => `(${offset.x}, ${offset.y}) in ${describeTarget(target)}`
          const onto = toEnd.offset ? pointIn(toEnd.offset, to) : describeTarget(to)
          record.detail = fromEnd.offset ? `from ${pointIn(fromEnd.offset, from)} ${toEnd.offset ? 'to' : 'onto'} ${onto}` : `onto ${onto}`
          if (path === 'straight') record.detail += ' along a straight line'
          for (const { target, offset } of [{ target: from, offset: fromEnd.offset }, { target: to, offset: toEnd.offset }]) {
            if (offset) await checkOffset(probe, target, offset, 'Nothing was dragged.')
          }
          // Both ends in view before the press, as a person scrolls before dragging: the start, then the end.
          // A scroll stops as soon as its point shows, at the edge it came in from, so the end of a drag just
          // past its start can still be out of view after the start's scroll alone (seen: the start at y 706
          // of the viewport, the end 20 px below it, under the bottom edge).
          if (fromEnd.offset || !from.viaLabel) record.notes.push(...(await bringIntoView(step, from, fromEnd.offset)).notes)
          if (toEnd.offset || !to.viaLabel) {
            const end = await bringIntoView(step, to, toEnd.offset)
            record.notes.push(...end.notes.map((note) => `for the end of the drag: ${note}`))
            if (end.notes.length > 0 && (await outOfView(probe, from, fromEnd.offset, await quadsOf(probe, from), await visibleArea(probe, from.frameId))) !== null) {
              throw new ActError(
                `Not done: the start (${fromEnd.offset ? pointIn(fromEnd.offset, from) : describeTarget(from)}) and the end (${onto}) of this drag do not ` +
                  'fit on the screen together: scrolling to the end moved the start out of view. Nothing was dragged: a person cannot hold the button ' +
                  'from one to the other without the page scrolling on the way, which act.drag does not do. A larger window would show both (ask the user).',
              )
            }
          }
          const fromPoint = await aimAt(step, from, fromEnd.offset)
          record.dispatched = true
          if (isTouchPage(page)) {
            await touchDrag(step, fromPoint, to, toEnd.offset, path)
            return
          }
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
          // Set once every input before the drop and the release went through: a tab closing with
          // either of them (Chrome confirmed the press) closed in answer to it, which is the drag's effect.
          let releasing = false
          const closingInput = async (input: Promise<unknown>, what: string): Promise<void> => {
            try {
              await input
            } catch (error) {
              if (!(await closesSoon(page))) throw error
              await closedByOwnInput(step, what, true, `Chrome did not confirm ${what}`)
              return
            }
            if (page.isClosed()) await closedByOwnInput(step, what, true, null)
          }
          let at = fromPoint
          try {
            probe.cdp.on('Input.dragIntercepted', onIntercepted)
            let toPoint: Point
            try {
              await send(probe.cdp, 'Input.setInterceptDrags', { enabled: true }, 'arming drag interception')
              await send(probe.cdp, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 }, 'pressing the mouse button')
              pressed = true
              await sleep(randomBetween(120, 220))
              toPoint = await dragEndPoint(probe, to, toEnd.offset, record)
              const start = at
              const samples = await dragSamples(page, start, toPoint, path)
              let travelled = 0
              const startedAt = Date.now()
              for (const sample of samples) {
                checkAbort()
                const wait = startedAt + sample.tMs - Date.now()
                if (wait > 0) await sleep(wait)
                await send(probe.cdp, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: sample.x, y: sample.y, button: 'left', buttons: 1 }, 'moving the pointer with the button held')
                travelled += Math.hypot(sample.x - at.x, sample.y - at.y)
                at = { x: sample.x, y: sample.y }
              }
              record.notes.push(dragPathNote(path, 'held-button', travelled, Math.hypot(toPoint.x - start.x, toPoint.y - start.y)))
              at = toPoint
              await sleep(randomBetween(80, 160))
            } finally {
              probe.cdp.off('Input.dragIntercepted', onIntercepted)
              await send(probe.cdp, 'Input.setInterceptDrags', { enabled: false }, 'disarming drag interception')
            }
            const data: Protocol.Input.DragData | null = dragData
            if (data) {
              for (const type of ['dragEnter', 'dragOver'] as const) {
                await untilDialog(probe, send(probe.cdp, 'Input.dispatchDragEvent', { type, x: toPoint.x, y: toPoint.y, data }, `dispatching ${type}`), record)
              }
              releasing = true
              await closingInput(untilDialog(probe, send(probe.cdp, 'Input.dispatchDragEvent', { type: 'drop', x: toPoint.x, y: toPoint.y, data }, 'dispatching drop'), record), 'the drop')
              record.notes.push('the page started an HTML drag: its drag data was dropped on the target with drag events')
            }
            releasing = true
          } finally {
            // A page Chrome took the debugger off (debugger-cut.ts) takes nothing more, not even the release.
            if (pressed && !record.closedTab && !page.isClosed()) {
              const released = untilDialog(
                probe,
                send(probe.cdp, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 }, 'releasing the mouse button'),
                record,
              )
              if (releasing) await closingInput(released, 'the release')
              else await released
            }
          }
        },
        { refs: [fromEnd.ref, toEnd.ref], whileBusy: options.whileBusy },
      )
    },
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
    reload: (options = {}) =>
      run('reload', async ({ page, probe, record }) => {
        const timeout = Math.max(1000, Math.min(30_000, remainingMs() - 4000))
        const current = page.url()
        // The new tab that replaced a crashed one is still blank: reloading it means loading what crashed.
        const crashed = isBlankUrl(current) ? replacedCrashOf(page) : null
        if (crashed) {
          record.detail = `${crashed.url} (the page that crashed)`
          record.dispatched = true
          const response = await untilDialog(probe, page.goto(crashed.url, { waitUntil: 'domcontentloaded', timeout }), record)
          if (response && response.status() >= 400) record.notes.push(`the server answered HTTP ${response.status()}`)
          return
        }
        if (deps.mode === 'human' && !isBlankUrl(current) && !options.reason) {
          throw new ActError(
            `Refused: act.reload would reload the whole document (${current}); client caches and in-memory state are wiped, which a person ` +
              "clicking around never does. If a reload is genuinely what you are testing, pass { reason: '…' }.",
          )
        }
        record.detail = options.reason ? `${current} (reason: ${options.reason})` : current
        record.dispatched = true
        const response = await untilDialog(probe, page.reload({ waitUntil: 'domcontentloaded', timeout }), record)
        if (response && response.status() >= 400) record.notes.push(`the server answered HTTP ${response.status()}`)
      }),
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
          // right before this action (so the link is exactly what is on the page now). Matched by
          // path: apps carry state in their links' query strings (see matchSpaLink).
          const observation = step.before
          const links: SpaLink[] = (observation?.elements ?? []).flatMap((element) =>
            element.role === 'link' && element.href !== undefined && element.visibility !== 'hidden' && element.visibility !== 'unknown'
              ? [{ ref: element.ref, name: element.name, href: element.href, inView: element.visibility === 'in-view' }]
              : [],
          )
          const base = new URL(observation?.url ?? page.url())
          const listed = (link: SpaLink): string => `[${link.ref}] link "${link.name}" → ${routeOf(new URL(link.href, base))}`
          const match = matchSpaLink(pathOrUrl, base, links)
          if (match.kind === 'ambiguous') {
            throw new ActError(
              `${match.links.length} links on the page lead to ${routeOf(target)} with different addresses: ${match.links.map(listed).join(', ')}. ` +
                `Pass the one you mean in full (act.spaNavigate('${routeOf(new URL(match.links[0].href, base))}')), or act.click(ref) on it.`,
            )
          }
          if (match.kind === 'none') {
            const inApp = [...new Set(links.flatMap((link) => {
              const url = new URL(link.href, base)
              return url.origin === here.origin ? [routeOf(url)] : []
            }))]
            const shown = inApp.slice(0, 25).join(', ')
            const more = inApp.length > 25 ? ` (+${inApp.length - 25} more; observe() lists every link)` : ''
            throw new ActError(
              `No link to ${routeOf(target)} is on the page${inApp.length > 0 ? `; its in-app links lead to ${shown}${more}` : ' (it has no in-app links)'}. ` +
                'A person would reach it through the UI — find() a menu or link that leads there — or type the address, which is a full load: act.open(url, { reason }).',
            )
          }
          const resolution = deps.registry.resolve(match.link.ref)
          if (!resolution.ok) throw new ActError(resolution.error)
          record.target = targetSummary(resolution.target)
          await clickTarget(step, resolution.target, 1, 'left')
          record.notes.push(
            `clicked the page's own link ${listed(match.link)}${match.exact ? '' : ` (matched by its path; ${routeOf(target)} was asked)`}`,
          )
        },
        { detail: pathOrUrl },
      ),
    switchTab: (indexOrText) =>
      run('switchTab', async ({ record }) => {
        const tabs = deps.listTabs()
        let index: number
        if (typeof indexOrText === 'string') {
          const needle = indexOrText.trim().toLowerCase()
          if (needle === '') throw new ActError('act.switchTab(text) takes text of the tab’s title or URL; it got an empty string.')
          const titles = await Promise.all(
            tabs.map((tab) => tabTitle(tab).catch((error: unknown) => `(title unreadable: ${errorMessage(error).split('.')[0]})`)),
          )
          const listing = (indexes: number[]): string => indexes.map((i) => `${i}: "${titles[i]}" ${tabs[i].url()}`).join(' · ')
          const matches = tabs.flatMap((tab, i) => (titles[i].toLowerCase().includes(needle) || tab.url().toLowerCase().includes(needle) ? [i] : []))
          if (matches.length !== 1) {
            throw new ActError(
              matches.length === 0
                ? `No open tab has "${indexOrText}" in its title or URL. The open tabs: ${listing(tabs.map((_, i) => i))}. Pass an index, or text only one of them has.`
                : `${matches.length} tabs have "${indexOrText}" in their title or URL: ${listing(matches)}. Pass the index of the one you mean, or text only it has.`,
            )
          }
          index = matches[0]
        } else {
          if (!Number.isInteger(indexOrText) || indexOrText < 0 || indexOrText >= tabs.length) {
            throw new ActError(`There is no tab ${indexOrText}: the open tabs are 0–${tabs.length - 1} (observe() lists them under TABS).`)
          }
          index = indexOrText
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
          record.detail = `${dialogLabel(state)}${state.promptText !== undefined ? ` with "${state.promptText}"` : ''}`
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
          record.detail = dialogLabel(state)
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
      policy: (policy, options = {}) =>
        run('dialog-policy', async ({ probe, record }) => {
          if (policy !== 'accept' && policy !== 'dismiss' && policy !== 'ask') {
            throw new ActError(`act.dialog.policy takes 'accept', 'dismiss' or 'ask' (got ${JSON.stringify(policy)}).`)
          }
          const { beforeunload, promptText } = options
          if (beforeunload !== undefined && beforeunload !== 'ask' && beforeunload !== 'leave' && beforeunload !== 'stay') {
            throw new ActError(`act.dialog.policy's beforeunload takes 'ask', 'leave' or 'stay' (got ${JSON.stringify(beforeunload)}).`)
          }
          if (promptText !== undefined && policy !== 'accept') {
            throw new ActError(`promptText is the text prompts are accepted with: it needs act.dialog.policy('accept', { promptText }), not '${policy}'.`)
          }
          // A dialog waiting for the agent right now is answered by the new policy: that answer is
          // this call's effect, reported like act.dialog.accept()'s.
          const waiting = probe.dialogs.current()
          if (waiting?.handling === 'agent') {
            record.checkpoint = probe.watch.checkpoint()
            record.before = probe.lastFullObservation ?? undefined
          }
          const settings = deps.setDialogPolicy(policy === 'ask' ? 'pending' : policy, options)
          const confirmPrompt =
            settings.policy === 'pending'
              ? 'ask'
              : settings.policy === 'accept'
                ? `accept${settings.promptText !== undefined ? ` (prompts with "${settings.promptText}")` : ' (prompts with their default)'}`
                : 'dismiss'
          record.detail = `confirm/prompt: ${confirmPrompt} · beforeunload: ${settings.beforeunload} · alert: acknowledged — on every tab from now on`
          if (waiting?.handling === 'agent' && probe.dialogs.current()?.handling !== 'agent') {
            record.dispatched = true
            record.notes.push(`answers the ${dialogLabel(waiting)} dialog that is open now`)
          }
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
  /**
   * Tabs this page opened during the call, with their index in observe()'s TABS list (null: closed
   * again) and how Chrome opened them (`opened`: a popup window or a tab; undefined when the opener
   * reported no request for it).
   */
  newTabs: Array<{ title: string; url: string; index: number | null; opened?: { popup: boolean; features: string[] } }>
  /** Download lines, formatted by the executor. */
  downloads: string[]
  /** File dialog lines (each one opened since the last report, and why a tab could not hold them back), formatted by the executor. */
  fileDialogs: string[]
  /** Did anything change (measured by the executor)? Undefined when it could not be measured. */
  changed?: boolean
  /** Layout-shift lines, formatted by the executor (perf.ts layoutShiftLines). */
  shifts?: string[]
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
  if (!record.ok) return `${head}\n        FAILED: ${record.error}`
  return record.closedTab ? `${head} — the tab closed (the page closed itself in response)` : head
}

/**
 * Identical new items appearing together in one container (a list, a log, a table): the
 * double-post symptom. "New" is what the diff found added once re-renders are paired off (a table
 * re-rendered with the same rows added nothing); without a diff, what the model was not shown yet.
 * Three tables each showing "(empty)" are three containers, not a duplicate.
 */
function duplicateWarnings(after: Observation | null, diff: ObservationDiff | null): string[] {
  if (!after) return []
  const texts: TextBlock[] = diff ? diff.textAdded : after.text.filter((block) => block.isNew)
  const elements: ObservedElement[] = diff ? diff.added : after.elements.filter((element) => element.isNew)
  const counts = new Map<string, { what: string; container?: SemanticContainer; n: number }>()
  const count = (what: string, container: SemanticContainer | undefined): void => {
    const key = `${container?.key ?? ''}\u0000${what}`
    const entry = counts.get(key)
    if (entry) entry.n++
    else counts.set(key, { what, ...(container ? { container } : {}), n: 1 })
  }
  for (const block of texts) {
    if (block.text.length < 4) continue
    count(`${block.role} "${block.text}"`, block.container)
  }
  for (const element of elements) {
    if (!element.name || element.role === 'clickable') continue
    if (!['article', 'listitem', 'row', 'comment'].includes(element.role)) continue
    count(`${element.role} "${element.name}"`, element.container)
  }
  return [...counts.values()]
    .filter(({ n }) => n >= 2)
    .map(({ what, container, n }) => `⚠ possible duplicate: ${n} identical new ${what} appeared${container ? ` in ${container.label}` : ''} — was something submitted twice?`)
}

/** Console errors and LIVE announcements listed in full up to this many (latest first kept), with a count of the rest. */
const REPORT_LIST_MAX = 5
const LIVE_LIST_MAX = 8

/**
 * An iframe's document request as the settle line names it: the iframe by its ref in the picture after
 * the action, the document's address (its site tells iframes apart; only a long query is cut), and
 * what Chrome reported of it so far.
 */
function iframeDocumentText(request: PendingRequest, after: Observation | null): string {
  const iframe = request.iframe === undefined ? 'an iframe' : describeIframe(after, request.iframe)
  let url = request.url
  try {
    const parsed = new URL(request.url)
    const query = `${parsed.search}${parsed.hash}`
    url = `${parsed.origin}${parsed.pathname}${query.length > 40 ? `${query.slice(0, 39)}…` : query}`
  } catch {
    url = request.url.length > 160 ? `${request.url.slice(0, 159)}…` : request.url
  }
  const waited = `${(request.ageMs / 1000).toFixed(1)}s`
  return `${iframe}'s document ${url} — ${request.answered ? `its content is still arriving after ${waited}` : `Chrome has not delivered it after ${waited}`}`
}

function settleLine(settle: SettleResult, after: Observation | null): string {
  // What the page showed as loading while the settle step waited (skeletons, an aria-busy region, a
  // spinner): the reason it took that long, and what came before the content now shown.
  const meanwhile = settle.busyWhileSettling?.length
    ? `\n        busy while it settled, gone now: ${settle.busyWhileSettling.map((seen) => `${seen.label} (seen ${(seen.seenMs / 1000).toFixed(1)}s)`).join(' · ')}`
    : ''
  // Iframes whose documents Chrome had not delivered when the rest went quiet: not waited for.
  const iframes = settle.iframeDocuments ?? []
  const shownIframes = iframes.slice(0, 3).map((request) => iframeDocumentText(request, after))
  const otherIframes = iframes.slice(3).map((request) => (request.iframe === undefined ? '(an iframe not listed)' : iframeRef(after, request.iframe)))
  const notWaited = iframes.length
    ? `\n        not waited for: ${iframes.length === 1 ? 'an iframe still loading its document' : `${iframes.length} iframes still loading their documents`} — ${shownIframes.join(' · ')}${otherIframes.length ? ` · +${otherIframes.length} more: ${otherIframes.join(' ')}` : ''}`
    : ''
  if (settle.settled) return `SETTLED ${Math.round(settle.waitedMs)}ms — page content and network went quiet${notWaited}${meanwhile}`
  if (settle.reason === 'js-dialog') return 'NOT SETTLED — a native dialog is blocking the page'
  if (settle.reason === 'page-closed') return 'NOT SETTLED — the page was closed'
  const pending = settle.pendingRequests
    .slice(0, 4)
    .map((r) => (r.iframe !== undefined ? iframeDocumentText(r, after) : `${r.method} ${shortUrl(r.url)} (${(r.ageMs / 1000).toFixed(1)}s)`))
  const more = settle.pendingRequests.length - pending.length
  const parts = [
    pending.length ? `waiting on ${pending.join(', ')}${more > 0 ? ` +${more} more` : ''}` : '',
    settle.domChangingIn ? `content still changing in ${settle.domChangingIn}` : '',
  ].filter(Boolean)
  return `NOT SETTLED after ${Math.round(settle.waitedMs)}ms${parts.length ? ` — ${parts.join(' · ')}` : ''}${notWaited}${meanwhile}`
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
 * The line for a call after which the page looks as before. A wait acts on nothing, so a call that
 * only waited did not "fail to work": it says how long it waited and that nothing changed meanwhile.
 */
function noChangeLine(input: ActionReportInput): string {
  const waitsOnly =
    input.records.length > 0 && input.rawInputs.length === 0 && input.records.every((record) => record.kind === 'wait' || record.kind === 'waitForIdle')
  if (!waitsOnly) {
    return (
      'NO VISIBLE CHANGE — the page looks the same as before. Do not assume it worked: check observe(), ' +
      'explain(ref) to see what the element is wired to, or getLatestLogs().'
    )
  }
  const waits = input.records.map((record) => {
    const waited = `waited ${record.detail ?? ''}`.trim()
    if (record.kind === 'wait') return waited
    return record.settle?.settled ? `${waited}; the page was quiet` : `${waited}; the page was still busy`
  })
  return (
    `NOTHING CHANGED WHILE WAITING — ${waits.join(', then ')}; the page looks as it did before the wait. ` +
    'A wait does nothing to the page, so this says nothing about earlier actions: what they did is already on the page (observe() or find() shows it).'
  )
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

  if (input.settle) lines.push(settleLine(input.settle, input.after))
  else if (input.settleError) lines.push(`NOT SETTLED — ${input.settleError}`)

  const events = input.events
  if (input.eventsError) lines.push(`EVENTS UNAVAILABLE — ${input.eventsError}`)
  if (events) {
    for (const nav of events.navigations) lines.push(navLine(nav))
    for (const dialog of events.dialogs) {
      if (dialog.closedAt === undefined) {
        lines.push(
          dialog.handling === 'agent'
            ? `DIALOG  ${dialogLabel(dialog)} is OPEN and blocks the page → act.dialog.accept() or act.dialog.dismiss()`
            : `DIALOG  ${dialogLabel(dialog)} is open and being answered by ${dialog.type === 'alert' ? 'the session (alerts are acknowledged)' : 'the session dialog policy'}`,
        )
      } else {
        lines.push(`DIALOG  ${dialogLabel(dialog)} — ${dialogAnswerText(dialog)}`)
      }
    }
  }
  for (const tab of input.newTabs) {
    const what = !tab.opened
      ? 'a new tab or window opened by this page (this tab reported no window.open or link request for it, so which of the two is unknown)'
      : tab.opened.popup
        ? `a popup window opened by this page (window.open with window features ${tab.opened.features.join(', ') || 'none'})`
        : 'a new tab opened by this page'
    const label = tab.opened?.popup ? 'POPUP  ' : 'TAB    '
    lines.push(
      tab.index === null
        ? `${label} ${what}, closed again: "${tab.title}" ${tab.url}`
        : `${label} ${what}: "${tab.title}" ${tab.url} — act.switchTab(${tab.index}) to work in it`,
    )
  }
  lines.push(...(input.after?.tabNotes ?? []))
  for (const download of input.downloads) lines.push(`DOWNLOAD ${download}`)
  for (const dialog of input.fileDialogs) lines.push(`FILE DIALOG ${dialog}`)
  lines.push(...duplicateWarnings(input.after, input.diff))

  // Only what a person would read as "still working". Content that changed a moment ago is the
  // settle step's business (and is in SETTLED / NOT SETTLED above), not a reason to wait.
  const busy = input.after?.busy.filter((s) => s.strength === 'strong' && BLOCKING_BUSY_KINDS.has(s.kind)) ?? []
  if (busy.length) {
    lines.push(`BUSY    ${busy.map((s) => s.label).join(' · ')} — the app is still working; act.waitForIdle() before the next action`)
  }
  // Content that moved by itself (layout shifts without recent input), placed among the refs.
  for (const shift of input.shifts ?? []) lines.push(`SHIFT   ${shift}`)

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
      errors.push(request.failed !== undefined ? `request failed ${request.method} ${shortUrl(request.url)}: ${request.failed} (${request.id})` : `HTTP ${request.status} ${request.method} ${shortUrl(request.url)} (${request.id})`)
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
      // A line break the region shows is ⏎, as on every report line.
      lines.push(`LIVE    ${item.role} "${item.text.replace(/\n/g, '⏎')}"${item.transient ? ' (shown briefly, already gone)' : ''}`)
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
    tail.push(noChangeLine(input))
  }
  return [head, ...tail].filter(Boolean).join('\n')
}
