/**
 * The browser's clock against this process's, from evidence only: timed round trips bound the
 * offset from both sides, stamps that arrived bound it from below. Conversions must stay inside
 * what the evidence allows, tighten as better evidence comes, and follow a clock that was set.
 */

import { describe, expect, it } from 'vitest'
import { BrowserClock } from './browser-clock.js'

/** The browser runs 3 minutes ahead of this process. */
const OFFSET = 3 * 60_000

describe('BrowserClock', () => {
  it('a round trip puts the browser reading in the middle of the trip', () => {
    const clock = new BrowserClock()
    // Sent at 1000, answered at 1100; the browser read its clock at local 1050.
    clock.roundTrip(1000, 1050 + OFFSET, 1100)
    expect(clock.measured()).toBe(true)
    expect(clock.toLocal(1050 + OFFSET)).toBe(1050)
    expect(clock.toBrowser(2000)).toBe(2000 + OFFSET)
  })

  it('keeps the tightest bounds: a quicker round trip refines the estimate, a slower one does not loosen it', () => {
    const clock = new BrowserClock()
    // An asymmetric slow trip: the browser read at local 1010, the answer took 190ms back. The
    // middle of the trip is 90ms after the reading.
    clock.roundTrip(1000, 1010 + OFFSET, 1200)
    expect(clock.toLocal(5000 + OFFSET)).toBe(5000 + 90)
    // A 2ms trip: the error is at most 1ms.
    clock.roundTrip(3000, 3001 + OFFSET, 3002)
    expect(Math.abs(clock.toLocal(5000 + OFFSET) - 5000)).toBeLessThanOrEqual(1)
    clock.roundTrip(4000, 4400 + OFFSET, 4800)
    expect(Math.abs(clock.toLocal(5000 + OFFSET) - 5000)).toBeLessThanOrEqual(1)
  })

  it('with only stamps that arrived, a browser time converts to no earlier than it was taken and no later than it arrived', () => {
    const clock = new BrowserClock()
    // Stamped at local 1000, arrived 40ms later.
    clock.arrived(1000 + OFFSET, 1040)
    expect(clock.known()).toBe(true)
    expect(clock.measured()).toBe(false)
    expect(clock.toLocal(1000 + OFFSET)).toBe(1040)
    // A stamp that arrived after 5ms tightens it; one that took 300ms does not loosen it.
    clock.arrived(2000 + OFFSET, 2005)
    clock.arrived(3000 + OFFSET, 3300)
    expect(clock.toLocal(1000 + OFFSET)).toBe(1005)
  })

  it('combines both: the round trip bounds it above, the quickest stamp below', () => {
    const clock = new BrowserClock()
    clock.arrived(1000 + OFFSET, 1002)
    clock.roundTrip(2000, 2040 + OFFSET, 2100)
    // Offset within [OFFSET - 2, OFFSET + 40]: the middle.
    expect(clock.toLocal(5000 + OFFSET)).toBe(5000 - 19)
  })

  it('follows a clock that was set: evidence that contradicts the kept bounds replaces them', () => {
    const clock = new BrowserClock()
    clock.roundTrip(1000, 1001 + OFFSET, 1002)
    // The browser's clock is set back by 2 minutes.
    const later = OFFSET - 120_000
    clock.roundTrip(5000, 5001 + later, 5002)
    expect(clock.toLocal(6000 + later)).toBe(6000)
    // Set forward again: one stamp that arrived proves the upper bound stale.
    clock.arrived(7000 + OFFSET, 7001)
    expect(clock.measured()).toBe(false)
    expect(clock.toLocal(8000 + OFFSET)).toBe(8001)
  })

  it('an old tight bound widens with age (15 ppm): after 20 minutes a 10ms trip replaces a 2ms one', () => {
    const clock = new BrowserClock()
    clock.roundTrip(0, 1 + OFFSET, 2)
    // 1.2e6 ms later the old bounds have widened by 18ms each.
    clock.roundTrip(1_200_000, 1_200_003 + OFFSET, 1_200_010)
    expect(clock.toLocal(2_000_000 + OFFSET)).toBe(2_000_000 + 2)
  })

  it('the earliest browser time of a local instant is never after its real one', () => {
    const clock = new BrowserClock()
    clock.roundTrip(1000, 1050 + OFFSET, 1100)
    expect(clock.earliestBrowser(1050)).toBeCloseTo(1000 + OFFSET, 2)
    expect(clock.earliestBrowser(1050)).toBeLessThanOrEqual(1050 + OFFSET)
  })

  it('refuses to convert before anything was measured', () => {
    expect(() => new BrowserClock().toLocal(1)).toThrow('has not been measured yet')
  })
})
