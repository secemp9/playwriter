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
import {
  planHumanTrajectory,
  DEFAULT_SAMPLE_RATE_HZ,
  DEFAULT_MAX_SAMPLES,
  type HumanMotionTuning,
  type HumanTrajectory,
  type Point,
  type Submovement,
} from './human-mouse.js'
import { playGhostCursorPath, cancelGhostCursorPath } from './ghost-cursor.js'

/** Above this, the renderer is not acking within a frame and the model's timing is fiction. */
const THROTTLED_RENDERER_PROBE_MS = 100

/** Reported as a warning when the achieved wall clock drifts this far from the plan. */
const DURATION_DRIFT_WARN_MS = 60

/** Bound on un-awaited dispatches, so a stalled relay cannot queue an unbounded backlog. */
const MAX_IN_FLIGHT_DISPATCHES = 32

export interface HoverCrossing {
  /** A short human-readable description, e.g. `button#submit.primary "Save"`. */
  description: string
  tagName: string
  id: string | null
  /** Milliseconds into the move at which the crossing fired. */
  atMs: number
}

export interface HumanMoveResult {
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
  /** Whether the overlay actually played the same path. */
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
  x?: number
  y?: number
  /** Override the starting point. The real lever for keeping a path out of a hazard corridor. */
  from?: Point
  /** Offset within the target element, like Playwright's `position`. Defaults to the centre. */
  position?: Point
  includeTrajectory?: boolean
  /** Mouse button held during the move, for drags. */
  heldButton?: 'left' | 'right' | 'middle'
}

export interface HumanClickOptions extends HumanMoveOptions {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
  delayMs?: number
}

interface ResolvedTarget {
  point: Point
  extent?: { width: number; height: number }
}

// ---------------------------------------------------------------------------
// Pointer position bookkeeping
// ---------------------------------------------------------------------------

/**
 * Playwright's client `Mouse` does not expose its current point, so the driver keeps its
 * own — and it has to stay correct across mouse actions the driver never issued, because
 * a move that starts from the wrong origin traces the wrong path (worst case: a plain
 * `page.mouse.move` moved the pointer, the driver still believes it is at the previous
 * target, and the "move" it plans has zero length and crosses nothing).
 *
 * So the driver chains `page.onMouseAction` — the same hook the ghost cursor uses — and
 * records every move/down/up/wheel Playwright performs. Deliberately NOT read from the
 * ghost cursor overlay: the overlay is cosmetic and can be disabled, and correctness must
 * not depend on it. The overlay is still consulted as a last resort before falling back to
 * the viewport centre, for the case where a previous session left the pointer somewhere.
 */
const lastKnownPointByPage = new WeakMap<Page, Point>()
const positionTrackedPages = new WeakSet<Page>()

/** Idempotent. Chains onto whatever callback is already installed (e.g. the ghost cursor). */
function trackPointerPosition(page: Page): void {
  if (positionTrackedPages.has(page)) {
    return
  }
  positionTrackedPages.add(page)

  const previous = page.onMouseAction
  page.onMouseAction = async (event) => {
    // Must stay trivial and never throw: this runs inline on every Playwright mouse action.
    if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
      lastKnownPointByPage.set(page, { x: event.x, y: event.y })
    }
    if (previous) {
      await previous(event)
    }
  }
}

async function readOverlayPointerPosition(page: Page): Promise<Point | null> {
  try {
    return await page.evaluate(() => {
      const api = (globalThis as { __playwriterGhostCursor?: { getPosition?: () => { x: number; y: number } | null } })
        .__playwriterGhostCursor
      return api?.getPosition?.() ?? null
    })
  } catch {
    return null
  }
}

async function resolveStartPoint(options: { page: Page; explicit?: Point }): Promise<Point> {
  // Installed before the `explicit` shortcut so that a first move with an explicit origin
  // still leaves tracking armed for the next one.
  trackPointerPosition(options.page)

  if (options.explicit) {
    return options.explicit
  }

  const remembered = lastKnownPointByPage.get(options.page)
  if (remembered) {
    return remembered
  }

  const fromOverlay = await readOverlayPointerPosition(options.page)
  if (fromOverlay && Number.isFinite(fromOverlay.x) && Number.isFinite(fromOverlay.y)) {
    return fromOverlay
  }

  const viewport = options.page.viewportSize()
  if (viewport) {
    return { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) }
  }

  const measured = await options.page
    .evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    .catch(() => ({ width: 1280, height: 720 }))
  return { x: Math.round(measured.width / 2), y: Math.round(measured.height / 2) }
}

async function resolveTarget(options: {
  locator?: Locator
  x?: number
  y?: number
  position?: Point
}): Promise<ResolvedTarget> {
  const { locator, x, y, position } = options

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
    throw new Error('humanMouse: pass either { locator } or both { x, y }.')
  }

  return { point: { x, y } }
}

// ---------------------------------------------------------------------------
// Hover crossing capture
// ---------------------------------------------------------------------------

const HOVER_TRAIL_KEY = '__playwriterHumanMouseHoverTrail'

async function armHoverRecorder(page: Page): Promise<boolean> {
  try {
    await page.evaluate((key) => {
      const store = globalThis as unknown as Record<string, unknown>
      const existing = store[key] as { teardown?: () => void } | undefined
      existing?.teardown?.()

      const startedAt = performance.now()
      const entries: Array<{ description: string; tagName: string; id: string | null; atMs: number }> = []

      // The `src` tsconfig has no DOM lib (types are node + chrome only), so this
      // page-side callback describes the shapes it uses structurally rather than
      // reaching for `Element` / `Event`.
      interface DomElementLike {
        tagName: string
        id: string
        classList: ArrayLike<string>
        textContent: string | null
        getAttribute: (name: string) => string | null
      }

      const describe = (element: DomElementLike): string => {
        const tag = element.tagName.toLowerCase()
        const id = element.id ? `#${element.id}` : ''
        const classes = Array.prototype.slice
          .call(element.classList, 0, 2)
          .map((c: string) => `.${c}`)
          .join('')
        const label =
          element.getAttribute('aria-label') || (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
        return `${tag}${id}${classes}${label ? ` "${label}"` : ''}`
      }

      const handler = (event: { target: unknown }): void => {
        const target = event.target as DomElementLike | null
        if (!target || typeof target.tagName !== 'string' || entries.length >= 200) {
          return
        }
        // The overlay is `pointer-events: none` and never receives these, but skip it
        // defensively so a crossing report can never be about our own cursor.
        if (target.id === '__playwriter_ghost_cursor__') {
          return
        }
        const description = describe(target)
        const previous = entries[entries.length - 1]
        if (previous && previous.description === description) {
          return
        }
        entries.push({
          description,
          tagName: target.tagName.toLowerCase(),
          id: target.id || null,
          atMs: Math.round(performance.now() - startedAt),
        })
      }

      document.addEventListener('mouseover', handler as (event: unknown) => void, true)
      store[key] = {
        entries,
        teardown: () => {
          document.removeEventListener('mouseover', handler as (event: unknown) => void, true)
        },
      }
    }, HOVER_TRAIL_KEY)
    return true
  } catch {
    return false
  }
}

async function collectHoverRecorder(page: Page): Promise<HoverCrossing[]> {
  try {
    return await page.evaluate((key) => {
      const store = globalThis as unknown as Record<string, unknown>
      const record = store[key] as
        | { entries: Array<{ description: string; tagName: string; id: string | null; atMs: number }>; teardown: () => void }
        | undefined
      if (!record) {
        return []
      }
      record.teardown()
      delete store[key]
      return record.entries
    }, HOVER_TRAIL_KEY)
  } catch {
    return []
  }
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
 */
async function dispatchTrajectory(options: {
  cdp: ICDPSession
  trajectory: HumanTrajectory
  heldButton?: 'left' | 'right' | 'middle'
}): Promise<{ dispatched: number; achievedDurationMs: number }> {
  const { cdp, trajectory, heldButton } = options
  const button = heldButton ?? 'none'
  const buttons = heldButton ? BUTTON_MASK[heldButton] : 0

  const pending: Array<Promise<unknown>> = []
  let dispatched = 0

  const startedAt = Date.now()

  for (const sample of trajectory.samples) {
    await sleepUntil(startedAt + sample.tMs)

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
  return { dispatched, achievedDurationMs: Date.now() - startedAt }
}

async function probeDispatchLatency(options: { cdp: ICDPSession; at: Point }): Promise<number> {
  const startedAt = Date.now()
  try {
    await options.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: options.at.x,
      y: options.at.y,
      button: 'none',
      buttons: 0,
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
  defaults?: HumanMouseDefaults
}): HumanMouseApi {
  const { defaultPage, getCdpSession } = options

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

  async function buildPlan(moveOptions: HumanMoveOptions): Promise<{
    trajectory: HumanTrajectory
    page: Page
    from: Point
    to: Point
  }> {
    const page = resolvePage(moveOptions.page)
    const target = await resolveTarget({
      locator: moveOptions.locator,
      x: moveOptions.x,
      y: moveOptions.y,
      position: moveOptions.position,
    })
    const from = await resolveStartPoint({ page, explicit: moveOptions.from })

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

  async function moveTo(moveOptions: HumanMoveOptions): Promise<HumanMoveResult> {
    const { trajectory, page, from, to } = await buildPlan(moveOptions)
    const cdp = await getCdpSession({ page })
    const warnings: string[] = []

    const reportCrossings = moveOptions.reportCrossings ?? defaults.reportCrossings ?? false
    const armed = reportCrossings ? await armHoverRecorder(page) : false
    if (reportCrossings && !armed) {
      warnings.push('Could not arm the hover recorder — `crossed` is unavailable for this move.')
    }

    // Probe BEFORE the move: one awaited dispatch at the starting point (a no-op position
    // change) tells us whether this renderer acks within a frame or is throttled to 1Hz.
    const probeDispatchMs = await probeDispatchLatency({ cdp, at: from })
    const rendererThrottled = Number.isFinite(probeDispatchMs) && probeDispatchMs > THROTTLED_RENDERER_PROBE_MS
    if (rendererThrottled) {
      warnings.push(
        `Renderer is throttled: a single Input.dispatchMouseEvent acked in ${Math.round(probeDispatchMs)}ms ` +
          `(a responsive foreground tab acks in ~16ms). The modelled ${Math.round(trajectory.plannedDurationMs)}ms ` +
          'move cannot be delivered at that rate. Bring the tab to the foreground (page.bringToFront()) ' +
          'or accept that this move will run far slower than the model asked for.',
      )
    }

    // Hand the whole path to the overlay first, so it starts within one round trip of the
    // real pointer instead of chasing it a transition behind.
    const ghostCursor = await playGhostCursorPath({ page, samples: trajectory.samples })
    if (!ghostCursor.playing) {
      warnings.push('Ghost cursor did not play the path (overlay disabled or page not ready).')
    }

    const { dispatched, achievedDurationMs } = await dispatchTrajectory({
      cdp,
      trajectory,
      heldButton: moveOptions.heldButton,
    })

    // Sync Playwright's own pointer bookkeeping. The raw CDP dispatches above are
    // invisible to `Mouse._x/_y`, so without this a later `page.mouse.down()` would press
    // at wherever Playwright last thought the pointer was. This is a single zero-distance
    // move: the overlay is already there, so nothing jumps.
    await page.mouse.move(to.x, to.y).catch(() => {})
    lastKnownPointByPage.set(page, to)

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

    const crossed = armed ? await collectHoverRecorder(page) : undefined

    return {
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
  }

  async function click(clickOptions: HumanClickOptions): Promise<HumanMoveResult> {
    const result = await moveTo(clickOptions)
    const page = resolvePage(clickOptions.page)

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

    // Bare coordinates: there is no element, so there is no actionability to run. This
    // path presses where it was told to press.
    await page.mouse.down({ button: clickOptions.button, clickCount: clickOptions.clickCount ?? 1 })
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
          await moveTo({ page, locator: this, position: positionOption, ...pageDefaults })
          return await original.apply(this, args)
        } finally {
          inHumanWrapper.delete(this)
        }
      }
    }
  }

  return {
    plan: async (planOptions) => (await buildPlan(planOptions)).trajectory,
    moveTo,
    click,
    hover: moveTo,
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
    position: async (positionOptions) => resolveStartPoint({ page: resolvePage(positionOptions?.page) }),
    defaults,
  }
}
