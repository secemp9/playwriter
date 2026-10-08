/**
 * Drives a planned human trajectory against a real page: the CDP pointer, the ghost
 * cursor overlay, and the honest accounting of whether the modelled timing was delivered.
 *
 * THE MEASUREMENT THIS IS DESIGNED AROUND
 * ---------------------------------------
 * Measured on this machine, through the relay AND the Chrome extension, against a live
 * user profile (200-event runs, `Input.dispatchMouseEvent` on a foreground tab):
 *
 *   Runtime.evaluate            awaited   ~4.3 ms   p50
 *   Page.getLayoutMetrics       awaited   ~4.2 ms   p50
 *   Input.dispatchKeyEvent      awaited   ~4.8 ms   p50
 *   page.evaluate               awaited   ~4.7 ms   p50
 *   Input.dispatchMouseEvent    awaited   ~16.5 ms  p50   <-- one vsync frame
 *   Input.dispatchMouseEvent    issued, awaited in bulk   ~1.8 ms/event
 *
 * Two findings drive every decision below.
 *
 * (1) `Input.dispatchMouseEvent` is the ONLY command that is not ~4ms. Its ack is
 *     frame-locked: Chrome does not reply until the renderer has consumed the move, which
 *     happens on a frame boundary. So AWAITING each sample caps the sampler at exactly
 *     60Hz and hands control of the timing to vsync — the model would no longer be
 *     deciding when the pointer is where. Issuing without awaiting costs 1.8ms, leaving
 *     ~90% headroom inside a 16.7ms sample budget. Therefore: the sampler paces itself on
 *     an absolute wall clock and fires each event without awaiting it, awaiting the whole
 *     batch only at the end.
 *
 * (2) On a tab whose renderer is throttled — backgrounded window, occluded, unfocused —
 *     the same call takes ~1000 ms, because a throttled renderer only produces frames at
 *     1Hz. That is not a slow network, it is a 60x cliff, and no sample rate survives it.
 *     A 500ms move would take 30 seconds. There is no honest way to "degrade gracefully"
 *     through that, so the driver PROBES for it with a single awaited dispatch before the
 *     move and reports `rendererThrottled` plus a warning on the result. The move still
 *     runs — the caller asked for it — but nobody is told a fiction about its duration.
 *
 * SAMPLE RATE
 * -----------
 * 60Hz. Higher buys nothing real: Chrome coalesces mousemove within a frame, so samples
 * denser than the frame rate are partly merged before the page ever sees them — they cost
 * dispatch budget and produce no additional `mouseover`. Lower starts to skip small
 * elements the path crosses. 60Hz is also exactly the ack cadence measured above.
 *
 * The coalescing is real but PARTIAL, measured rather than assumed: dispatching 200
 * `Input.dispatchMouseEvent` moves back to back with no pacing (far denser than 60Hz)
 * delivered 138 `mousemove` events to a capture-phase listener on Chromium 145 — 31% were
 * merged away, not all of them. So oversampling is wasteful rather than free, which is the
 * conclusion this section rests on; it is not the stronger claim that Chrome collapses
 * everything to one event per frame.
 */

import type { Locator, Page } from '@xmorse/playwright-core'
import type { ICDPSession } from './cdp-session.js'
import { IsolatedWorld, withDeadline } from './isolated-world.js'
import type { ScreenRect } from './page-frames.js'
import {
  planHumanTrajectory,
  DEFAULT_SAMPLE_RATE_HZ,
  DEFAULT_MAX_SAMPLES,
  type HumanMotionTuning,
  type HumanTrajectory,
  type Point,
  type Submovement,
} from './human-mouse.js'
import { playGhostCursorPath, cancelGhostCursorPath, isGhostCursorShown } from './ghost-cursor.js'
import { pointerTrackFor, type PointerPathSample } from './pointer-track.js'
import { HIDDEN_TAB_EFFECT } from './tab-state.js'

/** Above this, the renderer is not acking within a frame and the model's timing is fiction. */
const THROTTLED_RENDERER_PROBE_MS = 100

/** Reported as a warning when the achieved wall clock drifts this far from the plan. */
const DURATION_DRIFT_WARN_MS = 60

/** Bound on un-awaited dispatches, so a stalled relay cannot queue an unbounded backlog. */
const MAX_IN_FLIGHT_DISPATCHES = 32

/** Reading the layout metrics for the first move's start point is one CDP round trip. */
const START_POINT_TIMEOUT_MS = 5000

export interface HoverCrossing {
  /** A short human-readable description, e.g. `button#submit.primary "Save"`. */
  description: string
  tagName: string
  id: string | null
  /** Milliseconds into the move at which the crossing fired. */
  atMs: number
}

export interface HumanMoveResult {
  /**
   * `human`: the planned path below. `fast` (the driver of a fast-mode session): one move straight
   * to `to` — no path was planned, so the Fitts and plan fields are 0, `submovements` is empty and
   * `seed` is 0; `achievedDurationMs` and `probeDispatchMs` are that one move's round trip.
   */
  pace: 'human' | 'fast'
  from: Point
  to: Point
  /** What Fitts's law asked for (ms). */
  fittsDurationMs: number
  /** What the submovement decomposition added up to (ms) — the schedule that was run. */
  plannedDurationMs: number
  /** Wall clock actually taken, measured around the dispatch loop (ms). */
  achievedDurationMs: number
  /** achieved − planned. Positive means the move ran slow. */
  durationDriftMs: number
  distancePx: number
  effectiveWidthPx: number
  indexOfDifficultyBits: number
  pathLengthPx: number
  sampleCount: number
  sampleRateHz: number
  /** True when the sample budget forced a coarser rate than requested. */
  sampleRateReduced: boolean
  dispatchedEvents: number
  submovements: Submovement[]
  seed: number
  /** Per-event ack latency measured on this page immediately before the move (ms). */
  probeDispatchMs: number
  /** True when the probe says the renderer cannot ack within a frame — see the header. */
  rendererThrottled: boolean
  /**
   * Whether the live in-page overlay played the same path. Only ever `playing: true` on a
   * page where `ghostCursor.show()` injected it; otherwise nothing is drawn in the page (a
   * CDP recording draws the pointer from the pointer track instead).
   */
  ghostCursor: { playing: boolean; durationMs: number }
  /**
   * Elements the pointer actually crossed, from real `mouseover` events captured in the
   * page. Undefined when `reportCrossings` was off. This is ground truth, not a geometric
   * guess — it is the list of things the page now believes were hovered.
   */
  crossed?: HoverCrossing[]
  /** Non-empty whenever something about this move did not match the model. */
  warnings: string[]
  /** The full plan, when `includeTrajectory` was set. Large; off by default. */
  trajectory?: HumanTrajectory
}

export interface HumanMouseDefaults {
  seed?: number
  sampleRateHz?: number
  maxSamples?: number
  tuning?: Partial<HumanMotionTuning>
  reportCrossings?: boolean
}

export interface HumanMoveOptions extends HumanMouseDefaults {
  page?: Page
  locator?: Locator
  /** A ref from observe()/find(): the element's position is read over CDP, nothing runs in the page. Its tab is the page. */
  ref?: number | string
  x?: number
  y?: number
  /** Override the starting point. The real lever for keeping a path out of a hazard corridor. */
  from?: Point
  /** Offset within the target element, like Playwright's `position`. Defaults to the centre. */
  position?: Point
  includeTrajectory?: boolean
  /**
   * Mouse button held during the move, for drags: every dispatched move (the latency probe and
   * each path sample) carries it as `button` and in the `buttons` mask. Press it with
   * `page.mouse.down({ button })` first: the move ends with Playwright's own zero-distance pointer
   * sync, which carries the buttons Playwright pressed, so `page.mouse.up()` releases at the target.
   */
  heldButton?: 'left' | 'right' | 'middle'
}

export interface HumanClickOptions extends HumanMoveOptions {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
  delayMs?: number
  /**
   * Told when the press goes out (`sent`) and when Chrome confirms the page got it
   * (`acknowledged`), so a caller whose release fails can tell a press the page received from one
   * that never reached it. Bare-coordinate and ref presses only: a locator click is one Playwright call.
   */
  onPress?: (stage: 'sent' | 'acknowledged') => void
}

interface ResolvedTarget {
  point: Point
  extent?: { width: number; height: number }
}

/** Where the element a ref names is drawn: its tab, and its content boxes in main-viewport CSS px. */
export interface RefBoxes {
  page: Page
  rects: ScreenRect[]
  /** The ref and what it is, for errors: `[12] button "Save"`. */
  label: string
}

// ---------------------------------------------------------------------------
// Pointer position bookkeeping
// ---------------------------------------------------------------------------

/**
 * Playwright's client `Mouse` does not expose its current point, and the driver has to
 * stay correct across mouse actions it never issued: a move that starts from the wrong
 * origin traces the wrong path (worst case: a plain `page.mouse.move` moved the pointer,
 * the driver still believes it is at the previous target, and the "move" it plans has zero
 * length and crosses nothing).
 *
 * So the start point comes from the page's pointer track (`pointer-track.ts`): it records
 * every move/down/up/wheel Playwright performs through `page.onMouseAction`, and every
 * trajectory this driver dispatches. Before the first move the pointer is taken to be at
 * the viewport centre; with no emulated viewport (connectOverCDP) the viewport is read
 * with `Page.getLayoutMetrics`, never from the page's own realm.
 */
async function resolveStartPoint(options: {
  page: Page
  explicit?: Point
  getCdpSession: (options: { page: Page }) => Promise<ICDPSession>
}): Promise<Point> {
  // Created before the `explicit` shortcut so that a first move with an explicit origin
  // still leaves tracking armed for the next one.
  const track = pointerTrackFor(options.page)

  if (options.explicit) {
    return options.explicit
  }

  const remembered = track.latest()
  if (remembered) {
    return { x: remembered.x, y: remembered.y }
  }

  const viewport = options.page.viewportSize()
  if (viewport) {
    return { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) }
  }

  const cdp = await options.getCdpSession({ page: options.page })
  const { cssLayoutViewport } = await withDeadline(
    cdp.send('Page.getLayoutMetrics'),
    START_POINT_TIMEOUT_MS,
    'reading the viewport size to place the pointer at its centre (Page.getLayoutMetrics)',
  )
  return { x: Math.round(cssLayoutViewport.clientWidth / 2), y: Math.round(cssLayoutViewport.clientHeight / 2) }
}

async function resolveTarget(options: {
  locator?: Locator
  ref?: RefBoxes
  x?: number
  y?: number
  position?: Point
}): Promise<ResolvedTarget> {
  const { locator, ref, x, y, position } = options

  if (ref) {
    // The largest box the element is drawn as (a wrapped link has one per line), like act's aim.
    const [box] = [...ref.rects].sort((a, b) => b.width * b.height - a.width * a.height)
    if (!box) {
      throw new Error(`humanMouse: ${ref.label} has no box on the page (hidden, or zero size). observe() shows what is visible now.`)
    }
    const point = position ? { x: box.x + position.x, y: box.y + position.y } : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    return { point, extent: { width: box.width, height: box.height } }
  }

  if (locator) {
    const box = await locator.boundingBox()
    if (!box) {
      throw new Error(
        'humanMouse: the locator has no bounding box (element is detached, hidden, or has zero size). ' +
          'Scroll it into view or wait for it before moving to it.',
      )
    }
    const point = position
      ? { x: box.x + position.x, y: box.y + position.y }
      : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    return { point, extent: { width: box.width, height: box.height } }
  }

  if (typeof x !== 'number' || typeof y !== 'number') {
    throw new Error('humanMouse: pass { ref }, { locator } or both { x, y }.')
  }

  return { point: { x, y } }
}

// ---------------------------------------------------------------------------
// Hover crossing capture
// ---------------------------------------------------------------------------

// The recorder lives in a CDP isolated world of its own, never in the page's realm: its
// listener sits on the page's real `document` (the DOM is shared, so trusted `mouseover`
// events fire it), but the listener, its closure and the global holding the trail exist
// only in a realm page scripts cannot see. The page's globals and listener list are
// untouched while crossings are recorded.

const HOVER_WORLD_NAME = '__playwriter_human_mouse__'
const HOVER_RECORDER_TIMEOUT_MS = 5000

/** World-global holding the live recorder. Exists only inside the isolated world. */
const HOVER_RECORDER_KEY = '__playwriterHoverRecorder'

const ARM_HOVER_RECORDER_SOURCE = `(() => {
  const key = ${JSON.stringify(HOVER_RECORDER_KEY)}
  const existing = globalThis[key]
  if (existing) existing.teardown()
  const startedAt = performance.now()
  const entries = []
  const describe = (element) => {
    const tag = element.tagName.toLowerCase()
    const id = element.id ? '#' + element.id : ''
    const classes = Array.prototype.slice.call(element.classList, 0, 2).map((c) => '.' + c).join('')
    const label = element.getAttribute('aria-label') || (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
    return tag + id + classes + (label ? ' "' + label + '"' : '')
  }
  const handler = (event) => {
    const target = event.target
    if (!target || typeof target.tagName !== 'string' || entries.length >= 200) return
    // The ghost cursor overlay is pointer-events: none and never receives these; skip it
    // so a crossing report can never be about our own cursor.
    if (target.id === '__playwriter_ghost_cursor__') return
    const description = describe(target)
    const previous = entries[entries.length - 1]
    if (previous && previous.description === description) return
    entries.push({
      description,
      tagName: target.tagName.toLowerCase(),
      id: target.id || null,
      atMs: Math.round(performance.now() - startedAt),
    })
  }
  document.addEventListener('mouseover', handler, true)
  globalThis[key] = {
    entries,
    teardown: () => document.removeEventListener('mouseover', handler, true),
  }
  return true
})()`

/** Returns the trail and removes the recorder, or null when this world copy never had one. */
const COLLECT_HOVER_RECORDER_SOURCE = `(() => {
  const key = ${JSON.stringify(HOVER_RECORDER_KEY)}
  const record = globalThis[key]
  if (!record) return null
  record.teardown()
  delete globalThis[key]
  return record.entries
})()`

async function armHoverRecorder(world: IsolatedWorld): Promise<number> {
  await world.evaluate<boolean>(ARM_HOVER_RECORDER_SOURCE, {
    timeoutMs: HOVER_RECORDER_TIMEOUT_MS,
    what: 'arming the hover-crossing recorder in the isolated world',
  })
  return await world.getContextId(HOVER_RECORDER_TIMEOUT_MS)
}

type HoverCollection = { kind: 'collected'; crossed: HoverCrossing[] } | { kind: 'lost' }

async function collectHoverRecorder(world: IsolatedWorld, armedContextId: number): Promise<HoverCollection> {
  const contextId = await world.getContextId(HOVER_RECORDER_TIMEOUT_MS)
  const entries = await world.evaluate<HoverCrossing[] | null>(COLLECT_HOVER_RECORDER_SOURCE, {
    timeoutMs: HOVER_RECORDER_TIMEOUT_MS,
    what: 'reading the hover-crossing trail from the isolated world',
  })
  // A navigation during the move destroys the document the recorder listened on; the world
  // is recreated empty for the new document, so the trail recorded before it is gone.
  if (contextId !== armedContextId || entries === null) {
    return { kind: 'lost' }
  }
  return { kind: 'collected', crossed: entries }
}

// ---------------------------------------------------------------------------
// The dispatch loop
// ---------------------------------------------------------------------------

const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 }

function sleepUntil(deadlineMs: number): Promise<void> {
  const remaining = deadlineMs - Date.now()
  if (remaining <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => setTimeout(resolve, remaining))
}

/**
 * Fire the trajectory at the real pointer, paced on an absolute clock.
 *
 * Deadlines are computed from a single `startedAt` rather than by accumulating sleeps, so
 * a late timer callback does not push every later sample back — the schedule self-corrects
 * instead of drifting. Events are issued without awaiting (see the header); the batch is
 * awaited once at the end so the caller's `await` still means "the browser has them".
 *
 * Returns the samples as they were really ISSUED — `tMs` is the offset from `startedAt` at
 * which each one was sent, not the planned one — so the pointer track (and any recording
 * drawn from it) follows what the page received, including a late timer.
 */
async function dispatchTrajectory(options: {
  cdp: ICDPSession
  trajectory: HumanTrajectory
  heldButton?: 'left' | 'right' | 'middle'
}): Promise<{ dispatched: number; achievedDurationMs: number; startedAt: number; issued: PointerPathSample[] }> {
  const { cdp, trajectory, heldButton } = options
  const button = heldButton ?? 'none'
  const buttons = heldButton ? BUTTON_MASK[heldButton] : 0

  const pending: Array<Promise<unknown>> = []
  let dispatched = 0
  const issued: PointerPathSample[] = []

  const startedAt = Date.now()

  for (const sample of trajectory.samples) {
    await sleepUntil(startedAt + sample.tMs)
    issued.push({ tMs: Date.now() - startedAt, x: sample.x, y: sample.y })

    const promise = cdp
      .send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: sample.x,
        y: sample.y,
        button: button as 'none' | 'left' | 'right' | 'middle',
        buttons,
      })
      .catch(() => {
        // A single dropped sample is not worth failing the move over; the count on the
        // result is what tells the caller how many actually went out.
        return null
      })
    dispatched++
    pending.push(promise)

    if (pending.length >= MAX_IN_FLIGHT_DISPATCHES) {
      await Promise.all(pending.splice(0, pending.length - MAX_IN_FLIGHT_DISPATCHES / 2))
    }
  }

  await Promise.all(pending)
  return { dispatched, achievedDurationMs: Date.now() - startedAt, startedAt, issued }
}

/**
 * One awaited mouseMoved at `at`, timed. With a held button it carries that button, like every
 * other move of a drag: a move with `buttons: 0` in the middle of a drag tells Chrome the button
 * is up, and the page sees the drag end.
 */
async function probeDispatchLatency(options: { cdp: ICDPSession; at: Point; heldButton?: 'left' | 'right' | 'middle' }): Promise<number> {
  const startedAt = Date.now()
  try {
    await options.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: options.at.x,
      y: options.at.y,
      button: options.heldButton ?? 'none',
      buttons: options.heldButton ? BUTTON_MASK[options.heldButton] : 0,
    })
  } catch {
    return Number.NaN
  }
  return Date.now() - startedAt
}

// ---------------------------------------------------------------------------
// Public driver
// ---------------------------------------------------------------------------

export interface HumanMouseApi {
  /** Plan a move without performing it. Pure — useful for asserting or inspecting a path. */
  plan: (options: HumanMoveOptions) => Promise<HumanTrajectory>
  moveTo: (options: HumanMoveOptions) => Promise<HumanMoveResult>
  click: (options: HumanClickOptions) => Promise<HumanMoveResult>
  hover: (options: HumanMoveOptions) => Promise<HumanMoveResult>
  /** Route subsequent `locator.click/dblclick/hover` on this page through human motion. */
  enable: (options?: { page?: Page } & HumanMouseDefaults) => Promise<{ enabled: true; page: string }>
  disable: (options?: { page?: Page }) => Promise<{ enabled: false }>
  isEnabled: (options?: { page?: Page }) => boolean
  /** The driver's idea of where the pointer is. */
  position: (options?: { page?: Page }) => Promise<Point>
  defaults: HumanMouseDefaults
}

export function createHumanMouseApi(options: {
  defaultPage: Page
  getCdpSession: (options: { page: Page }) => Promise<ICDPSession>
  /** Where a ref's element is drawn (read over CDP). Without it, `{ ref }` is refused. */
  resolveRef?: (ref: number | string) => Promise<RefBoxes>
  defaults?: HumanMouseDefaults
  /**
   * `human` (default): every move follows a planned human path at a person's pace. `fast` (a
   * fast-mode session): every move is one straight move to the target (see `moveStraight`); `plan`
   * still returns the human plan.
   */
  pace?: 'human' | 'fast'
}): HumanMouseApi {
  const { defaultPage, getCdpSession, resolveRef } = options
  const pace = options.pace ?? 'human'

  // The seed counter makes consecutive moves in one session differ (a user does not trace
  // the identical arc twice) while staying reproducible: pass an explicit `seed` to pin a
  // single move, or set `defaults.seed` to pin the whole sequence.
  let seedCounter = options.defaults?.seed ?? 0x5eed
  const defaults: HumanMouseDefaults = { reportCrossings: false, ...options.defaults }

  const enabledPages = new WeakSet<Page>()
  const enabledPageDefaults = new WeakMap<Page, HumanMouseDefaults>()

  const nextSeed = (explicit?: number): number => {
    if (typeof explicit === 'number') {
      return explicit
    }
    seedCounter = (seedCounter * 1664525 + 1013904223) >>> 0
    return seedCounter
  }

  const resolvePage = (page?: Page): Page => page ?? defaultPage

  // One recorder world per page, created on first use and disposed with the page.
  const hoverWorlds = new WeakMap<Page, Promise<IsolatedWorld>>()
  const hoverWorldFor = (page: Page): Promise<IsolatedWorld> => {
    const existing = hoverWorlds.get(page)
    if (existing) {
      return existing
    }
    const creating = (async () => {
      const cdp = await withDeadline(
        getCdpSession({ page }),
        HOVER_RECORDER_TIMEOUT_MS,
        'opening the CDP session for the hover-crossing recorder',
      )
      const world = new IsolatedWorld({ cdp, getFrameId: () => page.mainFrame().frameId(), worldName: HOVER_WORLD_NAME })
      page.once('close', () => world.dispose())
      return world
    })()
    hoverWorlds.set(page, creating)
    creating.catch(() => {
      if (hoverWorlds.get(page) === creating) hoverWorlds.delete(page)
    })
    return creating
  }

  /** The page, start point and target of a move, before any path is planned. */
  async function resolveMove(moveOptions: HumanMoveOptions): Promise<{ page: Page; from: Point; target: ResolvedTarget }> {
    if (moveOptions.ref !== undefined && moveOptions.locator) {
      throw new Error('humanMouse: pass { ref } or { locator }, not both.')
    }
    if (moveOptions.ref !== undefined && !resolveRef) {
      throw new Error('humanMouse: { ref } needs the page probes of an execute() call; pass { locator } or { x, y } here.')
    }
    const ref = moveOptions.ref === undefined || !resolveRef ? undefined : await resolveRef(moveOptions.ref)
    if (ref && moveOptions.page && moveOptions.page !== ref.page) {
      throw new Error(`humanMouse: ${ref.label} is in another tab than the \`page\` passed. Leave \`page\` out: a ref names its tab.`)
    }
    const page = ref ? ref.page : resolvePage(moveOptions.page)
    const target = await resolveTarget({
      locator: moveOptions.locator,
      ref,
      x: moveOptions.x,
      y: moveOptions.y,
      position: moveOptions.position,
    })
    const from = await resolveStartPoint({ page, explicit: moveOptions.from, getCdpSession })
    return { page, from, target }
  }

  async function buildPlan(moveOptions: HumanMoveOptions): Promise<{
    trajectory: HumanTrajectory
    page: Page
    from: Point
    to: Point
  }> {
    const { page, from, target } = await resolveMove(moveOptions)

    const trajectory = planHumanTrajectory({
      from,
      to: target.point,
      target: target.extent,
      seed: nextSeed(moveOptions.seed ?? defaults.seed),
      sampleRateHz: moveOptions.sampleRateHz ?? defaults.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ,
      maxSamples: moveOptions.maxSamples ?? defaults.maxSamples ?? DEFAULT_MAX_SAMPLES,
      tuning: { ...defaults.tuning, ...moveOptions.tuning },
    })

    return { trajectory, page, from, to: target.point }
  }

  /** Arms the hover-crossing recorder when the move reports crossings. */
  async function armCrossings(page: Page, moveOptions: HumanMoveOptions): Promise<{ world: IsolatedWorld; armedContextId: number } | undefined> {
    if (!(moveOptions.reportCrossings ?? defaults.reportCrossings ?? false)) return undefined
    const world = await hoverWorldFor(page)
    return { world, armedContextId: await armHoverRecorder(world) }
  }

  /** The crossings the recorder saw, or undefined (with a warning) when a navigation lost them. */
  async function collectCrossings(hover: { world: IsolatedWorld; armedContextId: number } | undefined, warnings: string[]): Promise<HoverCrossing[] | undefined> {
    if (!hover) return undefined
    const collection = await collectHoverRecorder(hover.world, hover.armedContextId)
    if (collection.kind === 'collected') return collection.crossed
    warnings.push(
      'The page navigated during the move: the hover crossings recorded on the previous document were lost ' +
        'with it, so `crossed` is unavailable for this move. Repeat the move after the navigation settles.',
    )
    return undefined
  }

  /**
   * Fast pace: one move straight to the target, no planned path and no wall-clock pacing. It is
   * Playwright's own `page.mouse.move` — one awaited `Input.dispatchMouseEvent` carrying the buttons
   * Playwright pressed — so Playwright's pointer bookkeeping and the pointer track (its
   * onMouseAction hook) follow it with no extra sync move. Its round trip is timed, so a throttled
   * renderer is still told.
   */
  async function moveStraight(moveOptions: HumanMoveOptions): Promise<{ result: HumanMoveResult; page: Page }> {
    const { page, from, target } = await resolveMove(moveOptions)
    const to = target.point
    const warnings: string[] = []
    const hover = await armCrossings(page, moveOptions)
    const ghostCursor = await playGhostCursorPath({ page, samples: [{ tMs: 0, x: to.x, y: to.y }] })
    if (isGhostCursorShown(page) && !ghostCursor.playing) {
      warnings.push('The ghost cursor overlay is shown on this page but did not play the path (page navigating or not ready).')
    }
    const startedAt = Date.now()
    await page.mouse.move(to.x, to.y)
    const achievedDurationMs = Date.now() - startedAt
    const rendererThrottled = achievedDurationMs > THROTTLED_RENDERER_PROBE_MS
    if (rendererThrottled) {
      warnings.push(
        `Renderer is throttled: one Input.dispatchMouseEvent acked in ${achievedDurationMs}ms (a tab the user can see acks in ~16ms). ` +
          `The tab is probably not visible to the user: ${HIDDEN_TAB_EFFECT}`,
      )
    }
    const crossed = await collectCrossings(hover, warnings)
    const distancePx = Math.hypot(to.x - from.x, to.y - from.y)
    const result: HumanMoveResult = {
      pace: 'fast',
      from,
      to,
      fittsDurationMs: 0,
      plannedDurationMs: 0,
      achievedDurationMs,
      durationDriftMs: achievedDurationMs,
      distancePx,
      effectiveWidthPx: 0,
      indexOfDifficultyBits: 0,
      pathLengthPx: distancePx,
      sampleCount: 1,
      sampleRateHz: 0,
      sampleRateReduced: false,
      dispatchedEvents: 1,
      submovements: [],
      seed: 0,
      probeDispatchMs: achievedDurationMs,
      rendererThrottled,
      ghostCursor,
      crossed,
      warnings,
    }
    return { result, page }
  }

  async function move(moveOptions: HumanMoveOptions): Promise<{ result: HumanMoveResult; page: Page }> {
    if (pace === 'fast') return await moveStraight(moveOptions)
    const { trajectory, page, from, to } = await buildPlan(moveOptions)
    const cdp = await getCdpSession({ page })
    const warnings: string[] = []

    const hover = await armCrossings(page, moveOptions)

    // Probe BEFORE the move: one awaited dispatch at the starting point (a no-op position
    // change) tells us whether this renderer acks within a frame or is throttled to 1Hz.
    // It is a real dispatch — with an explicit `from` it is what puts the pointer there —
    // so it goes on the track like every other one.
    const track = pointerTrackFor(page)
    track.record({ x: from.x, y: from.y, kind: 'move' })
    const probeDispatchMs = await probeDispatchLatency({ cdp, at: from, heldButton: moveOptions.heldButton })
    const rendererThrottled = Number.isFinite(probeDispatchMs) && probeDispatchMs > THROTTLED_RENDERER_PROBE_MS
    if (rendererThrottled) {
      // The same effect and fix as the HIDDEN line (tab-state.ts): a throttled renderer is almost always a hidden tab.
      warnings.push(
        `Renderer is throttled: a single Input.dispatchMouseEvent acked in ${Math.round(probeDispatchMs)}ms ` +
          `(a tab the user can see acks in ~16ms), so the modelled ${Math.round(trajectory.plannedDurationMs)}ms move will run far slower. ` +
          `The tab is probably not visible to the user: ${HIDDEN_TAB_EFFECT}`,
      )
    }

    // Hand the whole path to the live overlay first — only on a page where
    // `ghostCursor.show()` put one — so it starts within one round trip of the real pointer
    // instead of chasing it a transition behind. Never injects anything.
    const ghostCursor = await playGhostCursorPath({ page, samples: trajectory.samples })
    if (isGhostCursorShown(page) && !ghostCursor.playing) {
      warnings.push('The ghost cursor overlay is shown on this page but did not play the path (page navigating or not ready).')
    }

    const { dispatched, achievedDurationMs, startedAt, issued } = await dispatchTrajectory({
      cdp,
      trajectory,
      heldButton: moveOptions.heldButton,
    })
    track.recordPath(issued, startedAt)

    // Sync Playwright's own pointer bookkeeping. The raw CDP dispatches above are
    // invisible to `Mouse._x/_y`, so without this a later `page.mouse.down()` would press
    // at wherever Playwright last thought the pointer was. This is a single zero-distance
    // move (recorded on the track through the onMouseAction hook), so nothing jumps.
    await page.mouse.move(to.x, to.y).catch(() => {})

    const durationDriftMs = achievedDurationMs - trajectory.plannedDurationMs
    if (Math.abs(durationDriftMs) > DURATION_DRIFT_WARN_MS) {
      warnings.push(
        `Achieved ${Math.round(achievedDurationMs)}ms against a modelled ${Math.round(trajectory.plannedDurationMs)}ms ` +
          `(drift ${durationDriftMs > 0 ? '+' : ''}${Math.round(durationDriftMs)}ms).`,
      )
    }
    if (trajectory.sampleRateReduced) {
      warnings.push(
        `Sample rate reduced to ${trajectory.sampleRateHz.toFixed(1)}Hz to stay inside the sample budget. ` +
          'The velocity profile keeps its shape; it is resolved more coarsely.',
      )
    }

    const crossed = await collectCrossings(hover, warnings)

    const result: HumanMoveResult = {
      pace: 'human',
      from,
      to,
      fittsDurationMs: trajectory.fittsDurationMs,
      plannedDurationMs: trajectory.plannedDurationMs,
      achievedDurationMs,
      durationDriftMs,
      distancePx: trajectory.distancePx,
      effectiveWidthPx: trajectory.effectiveWidthPx,
      indexOfDifficultyBits: trajectory.indexOfDifficultyBits,
      pathLengthPx: trajectory.pathLengthPx,
      sampleCount: trajectory.samples.length,
      sampleRateHz: trajectory.sampleRateHz,
      sampleRateReduced: trajectory.sampleRateReduced,
      dispatchedEvents: dispatched,
      submovements: trajectory.submovements,
      seed: trajectory.seed,
      probeDispatchMs,
      rendererThrottled,
      ghostCursor,
      crossed,
      warnings,
      trajectory: moveOptions.includeTrajectory ? trajectory : undefined,
    }
    return { result, page }
  }

  async function click(clickOptions: HumanClickOptions): Promise<HumanMoveResult> {
    const { result, page } = await move(clickOptions)

    if (clickOptions.locator) {
      // Delegate the press itself to Playwright so actionability, hit-target interception
      // and the retry loop all stay intact. Playwright will perform its own move to the
      // element centre first — but the pointer is already sitting there, so that move is
      // zero-distance and fires one extra mousemove at the resting point and nothing else.
      //
      // MEASURED against Chromium 145 with capture-phase listeners on every pointer event.
      // The raw CDP pointer was parked on the button's centre (140,120), the counters
      // cleared, and then:
      //
      //     page.mouse.move(140,120)   mousemove x1 at (140,120); nothing else at all
      //     locator.click()            mousemove x1 at (140,120), then mousedown, mouseup, click
      //
      // No mouseover, mouseout or mouseenter in either case — the pointer never leaves the
      // element, so the crossing events the `crossed` report is built from are untouched
      // and the human path's hover trail is not polluted by this delegation.
      await clickOptions.locator.click({
        button: clickOptions.button,
        clickCount: clickOptions.clickCount,
        delay: clickOptions.delayMs,
        position: clickOptions.position,
      })
      return result
    }

    // Bare coordinates, or a ref (located over CDP, so no Playwright actionability runs in the
    // page): this path presses where the pointer now is.
    clickOptions.onPress?.('sent')
    await page.mouse.down({ button: clickOptions.button, clickCount: clickOptions.clickCount ?? 1 })
    clickOptions.onPress?.('acknowledged')
    if (clickOptions.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, clickOptions.delayMs))
    }
    await page.mouse.up({ button: clickOptions.button, clickCount: clickOptions.clickCount ?? 1 })
    return result
  }

  // -------------------------------------------------------------------------
  // enable() — scoped prototype patch
  // -------------------------------------------------------------------------
  //
  // `Locator.prototype` is shared by every session in this process, so patching it
  // unconditionally would silently change behaviour for unrelated sessions. Instead the
  // patch is installed once and is a no-op unless the locator's own page has been
  // registered by `enable()`. That keeps the blast radius to exactly the pages that asked
  // for it, and makes `disable()` genuinely restore the old behaviour.
  let prototypePatched = false
  const inHumanWrapper = new WeakSet<object>()

  function installLocatorPatch(sampleLocator: Locator): void {
    if (prototypePatched) {
      return
    }
    prototypePatched = true

    const prototype = Object.getPrototypeOf(sampleLocator) as Record<string, unknown>

    for (const methodName of ['click', 'dblclick', 'hover'] as const) {
      const original = prototype[methodName] as ((this: Locator, ...args: unknown[]) => Promise<void>) | undefined
      if (typeof original !== 'function') {
        continue
      }

      prototype[methodName] = async function patched(this: Locator, ...args: unknown[]): Promise<void> {
        const page = this.page()
        // Re-entrancy guard: `dblclick` is implemented on top of `click` in some paths,
        // and `humanMouse.click` calls `locator.click` itself. Only the outermost call
        // gets the human move.
        if (!enabledPages.has(page) || inHumanWrapper.has(this)) {
          return original.apply(this, args)
        }

        inHumanWrapper.add(this)
        try {
          const pageDefaults = enabledPageDefaults.get(page) ?? {}
          const positionOption = (args[0] as { position?: Point } | undefined)?.position
          await move({ page, locator: this, position: positionOption, ...pageDefaults })
          return await original.apply(this, args)
        } finally {
          inHumanWrapper.delete(this)
        }
      }
    }
  }

  return {
    plan: async (planOptions) => (await buildPlan(planOptions)).trajectory,
    moveTo: async (moveOptions) => (await move(moveOptions)).result,
    click,
    hover: async (moveOptions) => (await move(moveOptions)).result,
    enable: async (enableOptions) => {
      const page = resolvePage(enableOptions?.page)
      installLocatorPatch(page.locator('body'))
      enabledPages.add(page)
      const { page: _ignored, ...rest } = enableOptions ?? {}
      enabledPageDefaults.set(page, rest)
      return { enabled: true, page: page.url() }
    },
    disable: async (disableOptions) => {
      const page = resolvePage(disableOptions?.page)
      enabledPages.delete(page)
      enabledPageDefaults.delete(page)
      await cancelGhostCursorPath({ page })
      return { enabled: false }
    },
    isEnabled: (isEnabledOptions) => enabledPages.has(resolvePage(isEnabledOptions?.page)),
    position: async (positionOptions) => resolveStartPoint({ page: resolvePage(positionOptions?.page), getCdpSession }),
    defaults,
  }
}
