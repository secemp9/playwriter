/**
 * browser-clock.ts — the browser's clock against this process's.
 *
 * The journal holds times from two clocks. The browser stamps what it reports: `Date.now()` in the
 * frames' isolated worlds (the in-page journal's mutations, announcements, churn and value changes)
 * and `wallTime` on `Network.requestWillBeSent`. This process stamps checkpoints, the ends of inputs
 * and the arrival of every CDP event with its own `Date.now()`. They are one clock only when Chrome
 * runs on this machine: a cloud browser or a remote relay puts Chrome on another machine, whose clock
 * can be minutes off. So a browser time is never compared with one of this process's: it is converted
 * with the offset between the two clocks, measured.
 *
 * Every renderer and the browser process of one Chrome run on the browser's machine and read its wall
 * clock, so one offset holds for all of a tab's frames and sessions. It is known as an interval:
 *  - a timed round trip (this process's clock before sending and after the answer, the browser's in
 *    between) bounds it from both sides: browser − after ≤ offset ≤ browser − before;
 *  - a browser stamp that arrived bounds it from below: the stamp was taken before it arrived,
 *    browser − arrival ≤ offset.
 * The tightest bound of each side is kept; a kept bound widens with its age at RFC 5905's frequency
 * tolerance (PHI, 15 ppm) when new evidence is weighed against it. The estimate is the middle of the
 * interval. Before any round trip it is the lower bound: a browser time then converts to no earlier
 * than the moment it was taken and no later than the moment its stamp arrived. Bounds that no longer
 * overlap mean one of the clocks was set (a step): the newer evidence replaces the older.
 */

/** RFC 5905 (NTPv4) §7.3 PHI: the frequency tolerance, 15 ppm — how fast a measured offset can go stale. */
const PHI = 15e-6

interface Bound {
  /** A bound on (browser clock − this process's clock), ms. */
  value: number
  /** This process's clock when it was measured. */
  at: number
}

export class BrowserClock {
  private lower: Bound | null = null
  private upper: Bound | null = null

  /** One timed round trip: sent at `sentAt`, answered at `receivedAt` (this process's clock); the browser read `browser` in between. */
  roundTrip(sentAt: number, browser: number, receivedAt: number): void {
    const lower = { value: browser - receivedAt, at: receivedAt }
    const upper = { value: browser - sentAt, at: receivedAt }
    if (this.lower === null || lower.value >= this.aged(this.lower, receivedAt, -1)) this.lower = lower
    if (this.upper === null || upper.value <= this.aged(this.upper, receivedAt, 1)) this.upper = upper
    if (this.aged(this.lower, receivedAt, -1) > this.aged(this.upper, receivedAt, 1)) {
      this.lower = lower
      this.upper = upper
    }
  }

  /** A browser stamp `browser` that arrived at `arrivedAt` (this process's clock): it was taken before it arrived. */
  arrived(browser: number, arrivedAt: number): void {
    const lower = { value: browser - arrivedAt, at: arrivedAt }
    if (this.lower === null || lower.value >= this.aged(this.lower, arrivedAt, -1)) this.lower = lower
    if (this.upper !== null && this.aged(this.lower, arrivedAt, -1) > this.aged(this.upper, arrivedAt, 1)) this.upper = null
  }

  /** Whether anything bounds the offset yet. */
  known(): boolean {
    return this.lower !== null
  }

  /** Whether a round trip bounds the offset from above too (otherwise only stamps that arrived bound it). */
  measured(): boolean {
    return this.upper !== null
  }

  /** A browser time on this process's clock. */
  toLocal(browser: number): number {
    return browser - this.offset()
  }

  /** A time of this process's clock on the browser's. */
  toBrowser(local: number): number {
    return local + this.offset()
  }

  /** The earliest browser time `local` can be (the offset at its lower bound): nothing the browser stamped after `local` is earlier. */
  earliestBrowser(local: number): number {
    if (this.lower === null) throw new Error('browser-clock: the browser clock has not been measured yet.')
    return local + this.aged(this.lower, local, -1)
  }

  private offset(): number {
    if (this.lower === null) throw new Error('browser-clock: the browser clock has not been measured yet.')
    return this.upper === null ? this.lower.value : (this.lower.value + this.upper.value) / 2
  }

  /** `bound` at time `at`, widened by its age: downwards for a lower bound (`side` -1), upwards for an upper one (1). */
  private aged(bound: Bound, at: number, side: -1 | 1): number {
    return bound.value + side * PHI * Math.abs(at - bound.at)
  }
}
