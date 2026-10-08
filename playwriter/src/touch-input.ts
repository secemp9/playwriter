/**
 * touch-input.ts — a finger on an emulated touch screen, for act on a phone or tablet preset.
 *
 * A browser started with a touch device (`browser({ action: 'new', device: 'Pixel 7' })`, a context
 * with `hasTouch`) tells pages it has a touch screen (`maxTouchPoints`, `(pointer: coarse)`, a mobile
 * user agent). A person on it taps: there is no pointer travelling over the page before the touch,
 * no hover, no wheel. The input here is `Input.dispatchTouchEvent`, which Chrome's touch emulation
 * turns into the events a real tap gives. Measured on Chrome 149, headless, Pixel 7 preset, capture
 * listeners on window:
 *
 *   tap (start, 80 ms, end)   pointerover/pointerdown (pointerType touch), touchstart, pointerup,
 *                             pointerout, touchend, then the compatibility mouseover, mousemove,
 *                             mousedown, mouseup, click (pointerType touch) — the same sequence as
 *                             Playwright's touchscreen.tap; one mousemove, after the touch.
 *   two taps 140 ms apart     two of those, then dblclick (the page has width=device-width).
 *   a press held 0.9–1.7 s    the same as a tap: click, no contextmenu. This emulation never turns a
 *                             long press into a context menu (Android Chrome does).
 *   swipe 400 px up           pointercancel once the page scrolls, touchmoves, scroll: 448 px (the
 *                             fling after the lift); 423 px when the finger slows and rests first.
 *   Input.synthesizeScrollGesture (touch)   pointer events but no scroll at all: not used.
 *   the mouse wheel           scrolls, but the page sees pointerType mouse and a mousemove first:
 *                             not what a phone sends.
 *   touch drag of a slider    pointermove (touch) along the path, the thumb follows (touch-action: none).
 *   long press + move on draggable=true   pointercancel, no dragstart: no HTML drag from touch here.
 *
 * The finger's contact is given a radius (a finger is not a 1 px point: pointer events report its
 * width and height). Every send has a deadline.
 */

import type { BrowserContext, BrowserContextOptions, Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import type { Point } from './human-mouse.js'
import { withDeadline } from './isolated-world.js'
import { pointerTrackFor } from './pointer-track.js'

const TOUCH_TIMEOUT_MS = 5000

/** Contexts created with touch emulation (`hasTouch`): their pages take a finger, not a mouse. */
const touchContexts = new WeakSet<BrowserContext>()

/** Remember that `context` was created with `options`: touch input when they emulate a touch screen. */
export function markTouchContext(context: BrowserContext, options: BrowserContextOptions): void {
  if (options.hasTouch === true) touchContexts.add(context)
}

/** Whether `page` is in a context that emulates a touch screen (a phone or tablet preset). */
export function isTouchPage(page: Page): boolean {
  return touchContexts.has(page.context())
}

/** One sample of a finger's way: `tMs` after it touched down, CSS px of the main viewport. */
export interface TouchSample {
  tMs: number
  x: number
  y: number
}

/**
 * How a finger touches. `human`: a person's timing, waited for (the waits come from the caller, so an
 * aborted call stops between events). `fast` (fast mode): nothing waits. A tap's touch and lift go at
 * once; a stroke's events go at once, at most FAST_STROKE_MOVES moves, each carrying the time a
 * person's stroke gives it (CDP `timestamp`, the stroke ending now), so Chrome's gesture detection —
 * fling velocity, the rest before the lift — reads the stroke a person makes. Measured on Chromium 145
 * (Pixel-size touch emulation, 5 runs each): a tap and a double tap sent at once gave click and
 * dblclick 5 of 5 (8–12 and 39–54 ms against 85–88 and 312 ms); a 300 px swipe sent as 3 stamped
 * moves scrolled 285 px like the paced swipe (109–112 ms against 459–478), and a 1200 px one as 5
 * moves 1185 px like it (94–95 ms against 462–479). Sent at once without the times, the swipe flung on
 * (430–459 px for 300). The times are this process's clock: a browser on another machine with a clock
 * of its own reads them shifted, which moves the whole stroke and keeps its spacing.
 */
export type TouchTiming =
  | {
      pace: 'human'
      sleep: (ms: number) => Promise<void>
      /** Told when the touch-down goes out and when Chrome confirms it, like a mouse press. */
      onPress?: (stage: 'sent' | 'acknowledged') => void
    }
  | { pace: 'fast'; onPress?: (stage: 'sent' | 'acknowledged') => void }

/** The most moves a fast stroke sends (see TouchTiming): each touchmove waits for a frame, so fewer is faster. */
const FAST_STROKE_MOVES = 3

function between(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** A finger's contact: CSS px around the point (pointer events report twice that as width/height). */
function contact(at: Point, radius: number): Protocol.Input.TouchPoint {
  return { x: at.x, y: at.y, radiusX: radius, radiusY: radius * between(0.85, 1.05), force: 1, id: 0 }
}

async function dispatch(
  cdp: ICDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  touchPoints: Protocol.Input.TouchPoint[],
  what: string,
  timestamp: number | undefined,
): Promise<void> {
  await withDeadline(cdp.send('Input.dispatchTouchEvent', { type, touchPoints, ...(timestamp !== undefined ? { timestamp } : {}) }), TOUCH_TIMEOUT_MS, what)
}

/** At most FAST_STROKE_MOVES of `moves`, evenly by index, the last one kept. */
function fewerMoves(moves: TouchSample[]): TouchSample[] {
  if (moves.length <= FAST_STROKE_MOVES) return moves
  return Array.from({ length: FAST_STROKE_MOVES }, (_, index) => moves[Math.round(((index + 1) * moves.length) / FAST_STROKE_MOVES) - 1])
}

/**
 * A finger down at the first sample, along the others, up at the last; `restMs` it stays still
 * before lifting (a finger that rests first does not fling a scroller). The page's pointer track
 * (recordings) gets the touch as a press, moves and a release. In fast mode nothing waits and the
 * events carry the stroke's times instead (TouchTiming).
 */
export async function touchStroke(cdp: ICDPSession, page: Page, samples: TouchSample[], restMs: number, timing: TouchTiming): Promise<void> {
  const [first] = samples
  if (!first) return
  const track = pointerTrackFor(page)
  const radius = between(9, 13)
  const moves = timing.pace === 'fast' ? fewerMoves(samples.slice(1)) : samples.slice(1)
  const endMs = (moves.at(-1)?.tMs ?? 0) + restMs
  // Fast: the stroke's times on the CDP clock (seconds since the epoch), ending now. A tap (no move) goes unstamped.
  const stampedFrom = timing.pace === 'fast' && moves.length > 0 ? Date.now() - endMs : null
  const stamp = (tMs: number): number | undefined => (stampedFrom === null ? undefined : (stampedFrom + tMs) / 1000)
  timing.onPress?.('sent')
  track.record({ x: first.x, y: first.y, kind: 'down', button: 'left' })
  await dispatch(cdp, 'touchStart', [contact(first, radius)], 'touching the screen', stamp(0))
  timing.onPress?.('acknowledged')
  const startedAt = Date.now()
  let last: Point = first
  for (const sample of moves) {
    if (timing.pace === 'human') {
      // Human pacing (b): the finger's way on its own clock.
      const wait = startedAt + sample.tMs - Date.now()
      if (wait > 0) await timing.sleep(wait)
    }
    track.record({ x: sample.x, y: sample.y, kind: 'move', button: 'left' })
    await dispatch(cdp, 'touchMove', [contact(sample, radius)], 'moving the finger on the screen', stamp(sample.tMs))
    last = sample
  }
  // Human pacing (b): the finger rests before it lifts.
  if (timing.pace === 'human' && restMs > 0) await timing.sleep(restMs)
  track.record({ x: last.x, y: last.y, kind: 'up', button: 'left' })
  await dispatch(cdp, 'touchEnd', [], 'lifting the finger', stamp(endMs))
}

/**
 * A person's tap at `at`: touch down, ~50–110 ms, lift. `count` 2 is a double tap (a second tap 100–180 ms
 * later, a pixel or two off). In fast mode the touches and lifts go at once (TouchTiming).
 */
export async function tap(cdp: ICDPSession, page: Page, at: Point, count: number, timing: TouchTiming): Promise<void> {
  for (let index = 0; index < count; index++) {
    // Human pacing (b): the gap between the taps of a double tap.
    if (index > 0 && timing.pace === 'human') await timing.sleep(between(100, 180))
    const point = index === 0 ? at : { x: at.x + between(-2, 2), y: at.y + between(-2, 2) }
    const rest = timing.pace === 'human' ? between(50, 110) : 0
    const strokeTiming: TouchTiming = timing.pace === 'human' ? { pace: 'human', sleep: timing.sleep, ...(index === 0 ? { onPress: timing.onPress } : {}) } : { pace: 'fast', ...(index === 0 ? { onPress: timing.onPress } : {}) }
    await touchStroke(cdp, page, [{ tMs: 0, ...point }], rest, strokeTiming)
  }
}

/**
 * A swipe that moves the finger by (dx, dy) from `from`: fast at first, slowing down, then resting
 * ~120 ms before lifting, so the scroller moves about the finger's distance (less the touch slop)
 * rather than flinging on. 16 ms apart, like a phone's touch sampling.
 */
export function swipeSamples(from: Point, dx: number, dy: number): TouchSample[] {
  const distance = Math.hypot(dx, dy)
  const durationMs = Math.min(450, Math.max(160, distance * between(0.7, 0.95)))
  const steps = Math.max(4, Math.round(durationMs / 16))
  const samples: TouchSample[] = [{ tMs: 0, x: from.x, y: from.y }]
  for (let index = 1; index <= steps; index++) {
    const eased = 1 - Math.pow(1 - index / steps, 3)
    samples.push({ tMs: (durationMs * index) / steps, x: from.x + dx * eased, y: from.y + dy * eased })
  }
  return samples
}

/**
 * The finger's move for scrolling `scroll` px (positive: down/right) from `at`: the finger moves the
 * other way, shortened so it ends inside `screen` (8 px in from its edges) and at most `maxPx` long.
 */
export function swipeFor(at: Point, axis: 'x' | 'y', scroll: number, screen: { width: number; height: number }, maxPx: number): { dx: number; dy: number } {
  const finger = -Math.sign(scroll) * Math.min(Math.abs(scroll), maxPx)
  const from = axis === 'y' ? at.y : at.x
  const size = axis === 'y' ? screen.height : screen.width
  const end = Math.max(8, Math.min(size - 8, from + finger))
  return axis === 'y' ? { dx: 0, dy: end - from } : { dx: end - from, dy: 0 }
}
