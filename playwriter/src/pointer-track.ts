/**
 * pointer-track.ts — where the pointer really was, per page, without touching the page.
 *
 * Every position the automation dispatched is recorded here on the Node side:
 *
 *   - Playwright mouse actions (`page.mouse.*`, `locator.click()`, …) through the fork's
 *     `page.onMouseAction` hook, which fires once per move/down/up/wheel with the
 *     coordinates Playwright is about to dispatch. `pointerTrackFor(page)` installs the hook
 *     once and chains whatever callback was there before.
 *   - Raw `Input.dispatchMouseEvent` trajectories (the human-mouse driver) through
 *     `recordPath`, stamped with the times the samples were actually issued.
 *   - Anything else that dispatches raw CDP input through `record`.
 *
 * Consumers read it back by time: the CDP recorder draws the pointer into the video at
 * encode time from `between()`/`latest()`, and the human-mouse driver starts its next move
 * from `latest()`. Nothing here reads from or writes to the page, so the pointer is
 * available even though no cursor element exists in the DOM.
 *
 * Coordinates are CSS pixels in viewport space — the space `Input.dispatchMouseEvent` and
 * Playwright's mouse use. Times are epoch milliseconds (`Date.now()`).
 */

import type { Page } from '@xmorse/playwright-core'

export type PointerKind = 'move' | 'down' | 'up' | 'wheel'
export type PointerButton = 'left' | 'right' | 'middle'

export interface PointerSample {
  /** Epoch ms at which the position was dispatched. */
  t: number
  /** CSS px, viewport space. */
  x: number
  y: number
  kind: PointerKind
  /** Present on down/up (and on moves made with a button held). */
  button?: PointerButton
}

/** One knot of a dispatched trajectory; `tMs` is the offset from the trajectory's start. */
export interface PointerPathSample {
  tMs: number
  x: number
  y: number
}

/** Where a sample came from. Overlay forwarding skips `'path'`: a path is played as a whole. */
export type PointerOrigin = 'action' | 'path'

export type PointerListener = (sample: PointerSample, origin: PointerOrigin) => void

/** The read side the recorder needs; a `PointerTrack` satisfies it. */
export interface PointerTimeline {
  between(t0: number, t1: number): PointerSample[]
  latest(atOrBefore?: number): PointerSample | undefined
}

/**
 * Samples kept per page. A 60Hz trajectory produces ~60 samples per second of motion, so
 * this holds well over ten minutes of continuous movement — longer than the recorder's own
 * default cap — while bounding a page that is driven for hours. The oldest are dropped.
 */
export const POINTER_TRACK_CAPACITY = 50_000

export class PointerTrack implements PointerTimeline {
  private readonly samples: PointerSample[] = []
  private readonly listeners = new Set<PointerListener>()

  /**
   * Record one dispatched position. `t` defaults to now. Call this only for input that
   * Playwright's mouse did NOT dispatch (raw `Input.dispatchMouseEvent`): Playwright's own
   * actions are already recorded through the `onMouseAction` hook, and recording them
   * twice would double every press pulse in a recording.
   */
  record(sample: { x: number; y: number; kind: PointerKind; t?: number; button?: PointerButton }): void {
    this.insert(normalize(sample, sample.t ?? Date.now()), 'action')
  }

  /**
   * Record a dispatched trajectory. `startedAt` is the epoch ms the first sample's `tMs`
   * is measured from — pass the times the samples were really issued, not the plan, so the
   * recorded pointer follows what the page received.
   */
  recordPath(samples: PointerPathSample[], startedAt: number): void {
    if (!Number.isFinite(startedAt)) {
      throw new Error(`recordPath: startedAt must be a finite epoch ms, got ${startedAt}.`)
    }
    for (const s of samples) {
      if (!Number.isFinite(s.tMs)) {
        throw new Error(`recordPath: every sample needs a finite tMs, got ${s.tMs}.`)
      }
      this.insert(normalize({ x: s.x, y: s.y, kind: 'move' }, startedAt + s.tMs), 'path')
    }
  }

  /** Samples with `t0 <= t <= t1`, ascending by time. */
  between(t0: number, t1: number): PointerSample[] {
    if (!(t1 >= t0)) return []
    const start = this.searchIndex(t0, false)
    const out: PointerSample[] = []
    for (let i = start; i < this.samples.length && this.samples[i].t <= t1; i++) out.push({ ...this.samples[i] })
    return out
  }

  /** The last sample at or before `atOrBefore` (default: the newest), or undefined if none. */
  latest(atOrBefore: number = Infinity): PointerSample | undefined {
    const i = this.searchIndex(atOrBefore, true) - 1
    return i < 0 ? undefined : { ...this.samples[i] }
  }

  get size(): number {
    return this.samples.length
  }

  /** Called synchronously for every recorded sample. Returns the unsubscribe function. */
  onRecord(listener: PointerListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private insert(sample: PointerSample, origin: PointerOrigin): void {
    const last = this.samples[this.samples.length - 1]
    if (!last || sample.t >= last.t) {
      this.samples.push(sample)
    } else {
      // Out of order only when two producers interleave (a path recorded after a hook
      // sample that was stamped during it). Keep the array sorted; ties keep arrival order.
      this.samples.splice(this.searchIndex(sample.t, true), 0, sample)
    }
    if (this.samples.length > POINTER_TRACK_CAPACITY) {
      this.samples.splice(0, this.samples.length - POINTER_TRACK_CAPACITY)
    }
    for (const listener of this.listeners) {
      try {
        listener({ ...sample }, origin)
      } catch {
        // A consumer (the optional in-page overlay) must never break recording.
      }
    }
  }

  /**
   * Binary search: the first index whose time is past `time` — strictly past when
   * `pastEqual` is true (so equal times count as "at or before"), otherwise at-or-past.
   */
  private searchIndex(time: number, pastEqual: boolean): number {
    let lo = 0
    let hi = this.samples.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const t = this.samples[mid].t
      if (t < time || (pastEqual && t === time)) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

function normalize(
  sample: { x: number; y: number; kind: PointerKind; button?: PointerButton },
  t: number,
): PointerSample {
  if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) {
    throw new Error(`Pointer samples need finite CSS-pixel coordinates, got (${sample.x}, ${sample.y}).`)
  }
  if (!Number.isFinite(t)) throw new Error(`Pointer samples need a finite epoch-ms time, got ${t}.`)
  if (sample.kind !== 'move' && sample.kind !== 'down' && sample.kind !== 'up' && sample.kind !== 'wheel') {
    throw new Error(`Unknown pointer sample kind ${JSON.stringify(sample.kind)}; expected move, down, up or wheel.`)
  }
  return { t, x: sample.x, y: sample.y, kind: sample.kind, ...(sample.button ? { button: sample.button } : {}) }
}

interface Hooked {
  track: PointerTrack
  hook: NonNullable<Page['onMouseAction']>
  previous: Page['onMouseAction']
}

const hookedPages = new WeakMap<Page, Hooked>()

/**
 * The page's pointer track, creating it and installing the `onMouseAction` hook on first
 * use. Idempotent. The hook only records and then awaits whatever callback was installed
 * before it, so it adds no page round trip of its own.
 */
export function pointerTrackFor(page: Page): PointerTrack {
  const existing = hookedPages.get(page)
  if (existing) return existing.track

  const track = new PointerTrack()
  const previous = page.onMouseAction
  const hook: NonNullable<Page['onMouseAction']> = async (event) => {
    // Runs inline before every Playwright mouse dispatch: trivial, and never throws.
    if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
      track.record({ x: event.x, y: event.y, kind: event.type, ...(event.button !== 'none' ? { button: event.button } : {}) })
    }
    if (previous) await previous(event)
  }
  page.onMouseAction = hook
  hookedPages.set(page, { track, hook, previous })
  return track
}

/** The page's track if one was created, without installing anything. */
export function existingPointerTrack(page: Page): PointerTrack | undefined {
  return hookedPages.get(page)?.track
}

/**
 * Remove the hook and forget the track. Restores the previous callback only when our hook
 * is still the installed one — if something chained on top of it since, unhooking would
 * silently drop that newer callback, so the hook is left in place (it is harmless) and only
 * the bookkeeping is released.
 */
export function releasePointerTrack(page: Page): void {
  const hooked = hookedPages.get(page)
  if (!hooked) return
  hookedPages.delete(page)
  if (page.onMouseAction === hooked.hook) page.onMouseAction = hooked.previous
}
