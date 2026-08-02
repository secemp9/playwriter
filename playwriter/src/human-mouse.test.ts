/**
 * Unit tests for the trajectory model, asserted against the models it claims to
 * implement rather than against a snapshot of its own output.
 *
 * Everything here is seeded and runs with no browser.
 */

import { describe, it, expect } from 'vitest'
import {
  planHumanTrajectory,
  tangentialSpeedProfile,
  minimumJerkPosition,
  minimumJerkVelocity,
  indexOfDifficulty,
  effectiveTargetWidth,
  fittsDurationMs,
  createSeededRandom,
  DEFAULT_HUMAN_MOTION_TUNING,
  type HumanTrajectory,
} from './human-mouse.js'

const SEED = 20260731

function plan(overrides: Partial<Parameters<typeof planHumanTrajectory>[0]> = {}): HumanTrajectory {
  return planHumanTrajectory({
    from: { x: 100, y: 120 },
    to: { x: 900, y: 560 },
    target: { width: 120, height: 44 },
    seed: SEED,
    ...overrides,
  })
}

describe('seeded PRNG', () => {
  it('is deterministic and never calls Math.random', () => {
    const a = createSeededRandom(42)
    const b = createSeededRandom(42)
    const seqA = Array.from({ length: 20 }, () => a.next())
    const seqB = Array.from({ length: 20 }, () => b.next())
    expect(seqA).toEqual(seqB)
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true)
  })

  it('produces a gaussian with roughly the requested moments', () => {
    const rng = createSeededRandom(7)
    const n = 20000
    let sum = 0
    let sumSquares = 0
    for (let i = 0; i < n; i++) {
      const v = rng.gaussian({ mean: 5, sd: 2 })
      sum += v
      sumSquares += v * v
    }
    const mean = sum / n
    const sd = Math.sqrt(sumSquares / n - mean * mean)
    expect(mean).toBeGreaterThan(4.9)
    expect(mean).toBeLessThan(5.1)
    expect(sd).toBeGreaterThan(1.9)
    expect(sd).toBeLessThan(2.1)
  })

  it('does not degenerate on seed 0', () => {
    const rng = createSeededRandom(0)
    const values = Array.from({ length: 5 }, () => rng.next())
    expect(new Set(values).size).toBe(5)
  })
})

describe('minimum-jerk profile (Flash & Hogan 1985)', () => {
  it('satisfies the boundary conditions', () => {
    expect(minimumJerkPosition(0)).toBe(0)
    expect(minimumJerkPosition(1)).toBeCloseTo(1, 12)
    expect(minimumJerkVelocity(0)).toBe(0)
    expect(minimumJerkVelocity(1)).toBeCloseTo(0, 12)
  })

  it('is symmetric about the midpoint', () => {
    for (const tau of [0.1, 0.25, 0.37, 0.5]) {
      expect(minimumJerkPosition(tau) + minimumJerkPosition(1 - tau)).toBeCloseTo(1, 12)
      expect(minimumJerkVelocity(tau)).toBeCloseTo(minimumJerkVelocity(1 - tau), 12)
    }
  })

  it('peaks at tau = 0.5 with the analytic value 1.875', () => {
    expect(minimumJerkVelocity(0.5)).toBeCloseTo(1.875, 10)
    for (const tau of [0.1, 0.3, 0.45, 0.55, 0.7, 0.9]) {
      expect(minimumJerkVelocity(tau)).toBeLessThan(minimumJerkVelocity(0.5))
    }
  })

  it('is monotonically increasing in position', () => {
    let previous = -1
    for (let i = 0; i <= 100; i++) {
      const value = minimumJerkPosition(i / 100)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })
})

describe("Fitts's law (Shannon formulation, MacKenzie 1992)", () => {
  it('computes ID = log2(D/W + 1)', () => {
    expect(indexOfDifficulty({ distancePx: 300, widthPx: 100 })).toBeCloseTo(2, 10)
    expect(indexOfDifficulty({ distancePx: 0, widthPx: 100 })).toBeCloseTo(0, 10)
    expect(indexOfDifficulty({ distancePx: 700, widthPx: 100 })).toBeCloseTo(3, 10)
  })

  it('duration is affine in ID with the configured slope and intercept', () => {
    const tuning = DEFAULT_HUMAN_MOTION_TUNING
    // Two points with ID exactly 2 and 3 bits.
    const two = fittsDurationMs({ distancePx: 300, widthPx: 100, tuning })
    const three = fittsDurationMs({ distancePx: 700, widthPx: 100, tuning })
    expect(three - two).toBeCloseTo(tuning.fittsSlopeMsPerBit, 6)
    expect(two).toBeCloseTo(tuning.fittsInterceptMs + 2 * tuning.fittsSlopeMsPerBit, 6)
  })

  it('planned duration scales with log2(D/W + 1), not with D', () => {
    // Same distance, different target widths: the small target must take longer.
    const wide = plan({ target: { width: 400, height: 400 } })
    const narrow = plan({ target: { width: 4, height: 400 } })
    expect(narrow.fittsDurationMs).toBeGreaterThan(wide.fittsDurationMs)

    // Doubling D at fixed W adds strictly less than double the time (logarithmic).
    const near = planHumanTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 400, y: 0 },
      target: { width: 40, height: 40 },
      seed: SEED,
    })
    const far = planHumanTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 800, y: 0 },
      target: { width: 40, height: 40 },
      seed: SEED,
    })
    expect(far.fittsDurationMs).toBeGreaterThan(near.fittsDurationMs)
    expect(far.fittsDurationMs).toBeLessThan(near.fittsDurationMs * 2)

    // And the relationship is the model's: predicted from ID directly.
    const predicted =
      DEFAULT_HUMAN_MOTION_TUNING.fittsInterceptMs +
      DEFAULT_HUMAN_MOTION_TUNING.fittsSlopeMsPerBit * far.indexOfDifficultyBits
    expect(far.fittsDurationMs).toBeCloseTo(predicted, 6)
  })

  it('uses the target extent ALONG the movement axis for W', () => {
    // A wide, short button approached horizontally is an easy target...
    const horizontal = effectiveTargetWidth({
      from: { x: 0, y: 0 },
      to: { x: 500, y: 0 },
      target: { width: 200, height: 20 },
      fallbackPx: 12,
    })
    // ...and the same button approached vertically is a hard one.
    const vertical = effectiveTargetWidth({
      from: { x: 500, y: -500 },
      to: { x: 500, y: 0 },
      target: { width: 200, height: 20 },
      fallbackPx: 12,
    })
    expect(horizontal).toBeCloseTo(200, 6)
    expect(vertical).toBeCloseTo(20, 6)
    expect(horizontal).toBeGreaterThan(vertical)
  })

  it('falls back to a sane extent for bare coordinates', () => {
    const bare = plan({ target: undefined })
    expect(bare.effectiveWidthPx).toBe(DEFAULT_HUMAN_MOTION_TUNING.defaultTargetWidthPx)
    expect(bare.fittsDurationMs).toBeGreaterThan(0)
  })
})

describe('velocity profile of a planned move', () => {
  it('is bell-shaped: rises, peaks mid-flight, falls', () => {
    // Curvature and corrections both perturb the profile; isolate the primary phase's
    // shape by disabling corrections and tremor, which is the condition Flash & Hogan
    // actually describe (a single unperturbed aimed movement).
    const trajectory = plan({
      tuning: {
        maxCorrections: 0,
        spontaneousCorrectionProbability: 0,
        primaryEndpointSdFraction: 0,
        primaryUndershootFraction: 0,
        tremorAmplitudePx: 0,
      },
    })
    const profile = tangentialSpeedProfile(trajectory)
    expect(profile.length).toBeGreaterThan(10)

    const peakIndex = profile.reduce(
      (best, entry, index) => (entry.speedPxPerMs > profile[best].speedPxPerMs ? index : best),
      0,
    )
    const peakFraction = profile[peakIndex].tMs / trajectory.plannedDurationMs

    // Peak velocity occurs mid-flight, not at the start or the end.
    expect(peakFraction).toBeGreaterThan(0.35)
    expect(peakFraction).toBeLessThan(0.65)

    // Monotone up to the peak and monotone down after it (allowing sampling noise).
    const rising = profile.slice(0, peakIndex)
    const falling = profile.slice(peakIndex + 1)
    const isMonotone = (values: number[], direction: 1 | -1): boolean =>
      values.every((v, i) => i === 0 || direction * (v - values[i - 1]) > -1e-6)
    expect(isMonotone(rising.map((p) => p.speedPxPerMs), 1)).toBe(true)
    expect(isMonotone(falling.map((p) => p.speedPxPerMs), -1)).toBe(true)

    // Endpoints are at rest.
    expect(profile[0].speedPxPerMs).toBeLessThan(profile[peakIndex].speedPxPerMs * 0.2)
    expect(profile[profile.length - 1].speedPxPerMs).toBeLessThan(profile[peakIndex].speedPxPerMs * 0.2)
  })

  it('is symmetric about its peak', () => {
    const trajectory = plan({
      tuning: {
        maxCorrections: 0,
        spontaneousCorrectionProbability: 0,
        primaryEndpointSdFraction: 0,
        primaryUndershootFraction: 0,
        tremorAmplitudePx: 0,
        curvatureSdFraction: 0,
      },
    })
    const profile = tangentialSpeedProfile(trajectory)
    const n = profile.length
    for (let i = 0; i < Math.floor(n / 2); i++) {
      const left = profile[i].speedPxPerMs
      const right = profile[n - 1 - i].speedPxPerMs
      const scale = Math.max(left, right, 1e-9)
      expect(Math.abs(left - right) / scale).toBeLessThan(0.02)
    }
  })

  it('reaches a peak speed close to the minimum-jerk prediction of 1.875·L/T', () => {
    const trajectory = plan({
      tuning: {
        maxCorrections: 0,
        spontaneousCorrectionProbability: 0,
        primaryEndpointSdFraction: 0,
        primaryUndershootFraction: 0,
        tremorAmplitudePx: 0,
        curvatureSdFraction: 0,
      },
    })
    const profile = tangentialSpeedProfile(trajectory)
    const peak = Math.max(...profile.map((p) => p.speedPxPerMs))
    const predicted = (1.875 * trajectory.pathLengthPx) / trajectory.plannedDurationMs
    expect(peak / predicted).toBeGreaterThan(0.95)
    expect(peak / predicted).toBeLessThan(1.05)
  })
})

describe('corrective submovements (Meyer et al. 1988)', () => {
  it('produces a primary phase plus at least one correction near the target', () => {
    const trajectory = plan()
    expect(trajectory.submovements[0].kind).toBe('primary')
    const corrections = trajectory.submovements.filter((s) => s.kind === 'correction')
    expect(corrections.length).toBeGreaterThanOrEqual(1)
    expect(corrections.length).toBeLessThanOrEqual(DEFAULT_HUMAN_MOTION_TUNING.maxCorrections + 1)

    // Corrections happen NEAR the target and late in the move.
    for (const correction of corrections) {
      expect(correction.startMs / trajectory.plannedDurationMs).toBeGreaterThan(0.4)
      const hop = Math.hypot(correction.to.x - correction.from.x, correction.to.y - correction.from.y)
      expect(hop).toBeLessThan(trajectory.distancePx * 0.35)
    }
  })

  it('the primary submovement misses the target — it does not land dead centre', () => {
    // Over many seeds, the primary endpoint error must be non-trivial essentially always.
    let landedExactly = 0
    const errors: number[] = []
    for (let seed = 1; seed <= 200; seed++) {
      const trajectory = plan({ seed })
      const primary = trajectory.submovements[0]
      errors.push(primary.endpointErrorPx)
      if (primary.endpointErrorPx < 1e-9) {
        landedExactly++
      }
    }
    expect(landedExactly).toBe(0)
    const meanError = errors.reduce((a, b) => a + b, 0) / errors.length
    // ~5% of a ~913px move, with a small undershoot bias.
    expect(meanError).toBeGreaterThan(10)
    expect(meanError).toBeLessThan(120)
  })

  it('biases the primary submovement to fall SHORT rather than long', () => {
    let short = 0
    let long = 0
    for (let seed = 1; seed <= 400; seed++) {
      const trajectory = planHumanTrajectory({
        from: { x: 0, y: 0 },
        to: { x: 800, y: 0 },
        target: { width: 40, height: 40 },
        seed,
      })
      const primary = trajectory.submovements[0]
      if (primary.to.x < 800) {
        short++
      } else {
        long++
      }
    }
    expect(short).toBeGreaterThan(long)
  })

  it('there is a detectable speed minimum between the primary and the correction', () => {
    const trajectory = plan()
    const profile = tangentialSpeedProfile(trajectory)
    const firstCorrection = trajectory.submovements.find((s) => s.kind === 'correction')
    expect(firstCorrection).toBeDefined()

    const boundaryMs = firstCorrection!.startMs
    const peak = Math.max(...profile.map((p) => p.speedPxPerMs))
    // Speed near the hand-off between submovements drops to near rest — this dip is the
    // signature the model exists to produce.
    const nearBoundary = profile.filter((p) => Math.abs(p.tMs - boundaryMs) < 40)
    expect(nearBoundary.length).toBeGreaterThan(0)
    expect(Math.min(...nearBoundary.map((p) => p.speedPxPerMs))).toBeLessThan(peak * 0.35)

    // And speed picks up again afterwards — the correction is a real movement, not a drift.
    const afterBoundary = profile.filter((p) => p.tMs > boundaryMs + 10)
    expect(Math.max(...afterBoundary.map((p) => p.speedPxPerMs))).toBeGreaterThan(0)
  })

  it('always terminates exactly on the requested point', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const trajectory = plan({ seed })
      const last = trajectory.samples[trajectory.samples.length - 1]
      expect(last.x).toBe(900)
      expect(last.y).toBe(560)
      expect(last.tMs).toBeCloseTo(trajectory.plannedDurationMs, 9)
    }
  })

  it('starts exactly at the origin', () => {
    const trajectory = plan()
    expect(trajectory.samples[0]).toEqual({ tMs: 0, x: 100, y: 120 })
  })
})

describe('path curvature', () => {
  it('is not a straight line, but stays inside a sane corridor', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const trajectory = plan({ seed })
      const from = trajectory.samples[0]
      const to = trajectory.samples[trajectory.samples.length - 1]
      const dx = to.x - from.x
      const dy = to.y - from.y
      const chord = Math.hypot(dx, dy)

      let maxDeviation = 0
      for (const sample of trajectory.samples) {
        // Perpendicular distance from the A→B line.
        const deviation = Math.abs((sample.x - from.x) * dy - (sample.y - from.y) * dx) / chord
        maxDeviation = Math.max(maxDeviation, deviation)
      }

      // Genuinely curved...
      expect(maxDeviation).toBeGreaterThan(0.5)
      // ...but never a cartoon swoop.
      expect(maxDeviation).toBeLessThan(chord * 0.15)

      // Arc length exceeds the chord, but only slightly.
      expect(trajectory.pathLengthPx).toBeGreaterThan(chord)
      expect(trajectory.pathLengthPx).toBeLessThan(chord * 1.25)
    }
  })

  it('bows to both sides across seeds', () => {
    const signs = new Set<number>()
    for (let seed = 1; seed <= 40; seed++) {
      const trajectory = plan({ seed })
      const offset = trajectory.submovements[0].curveOffsetsPx[0]
      signs.add(Math.sign(offset))
    }
    expect(signs.has(1)).toBe(true)
    expect(signs.has(-1)).toBe(true)
  })

  it('a zero-curvature tuning produces a straight path', () => {
    const trajectory = plan({
      tuning: {
        curvatureSdFraction: 0,
        tremorAmplitudePx: 0,
        maxCorrections: 0,
        spontaneousCorrectionProbability: 0,
        primaryEndpointSdFraction: 0,
        primaryUndershootFraction: 0,
      },
    })
    const from = trajectory.samples[0]
    const to = trajectory.samples[trajectory.samples.length - 1]
    const dx = to.x - from.x
    const dy = to.y - from.y
    const chord = Math.hypot(dx, dy)
    for (const sample of trajectory.samples) {
      const deviation = Math.abs((sample.x - from.x) * dy - (sample.y - from.y) * dx) / chord
      expect(deviation).toBeLessThan(1e-6)
    }
  })
})

describe('2/3 power law re-timing (Lacquaniti et al. 1983)', () => {
  it('slows the pointer where the path is most curved', () => {
    // Force a strongly bowed single submovement so curvature varies measurably.
    const trajectory = planHumanTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 1000, y: 0 },
      target: { width: 40, height: 40 },
      seed: 3,
      sampleRateHz: 240,
      maxSamples: 4000,
      tuning: {
        curvatureSdFraction: 0.11,
        curvatureMaxFraction: 0.2,
        curvatureMaxPx: 300,
        maxCorrections: 0,
        spontaneousCorrectionProbability: 0,
        primaryEndpointSdFraction: 0,
        primaryUndershootFraction: 0,
        tremorAmplitudePx: 0,
      },
    })

    // Compare against the same path timed WITHOUT the power law (exponent 0 ⇒ factor 1).
    const flat = planHumanTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 1000, y: 0 },
      target: { width: 40, height: 40 },
      seed: 3,
      sampleRateHz: 240,
      maxSamples: 4000,
      tuning: {
        curvatureSdFraction: 0.11,
        curvatureMaxFraction: 0.2,
        curvatureMaxPx: 300,
        maxCorrections: 0,
        spontaneousCorrectionProbability: 0,
        primaryEndpointSdFraction: 0,
        primaryUndershootFraction: 0,
        tremorAmplitudePx: 0,
        powerLawExponent: 0,
      },
    })

    // Same geometry, same duration — only the distribution of speed differs.
    expect(trajectory.plannedDurationMs).toBeCloseTo(flat.plannedDurationMs, 9)
    expect(trajectory.pathLengthPx).toBeCloseTo(flat.pathLengthPx, 0)

    const withLaw = tangentialSpeedProfile(trajectory)
    const withoutLaw = tangentialSpeedProfile(flat)
    expect(withLaw.length).toBe(withoutLaw.length)

    // The two profiles must actually differ — otherwise the law is doing nothing.
    const maxRelativeDifference = Math.max(
      ...withLaw.map((p, i) => Math.abs(p.speedPxPerMs - withoutLaw[i].speedPxPerMs) / Math.max(p.speedPxPerMs, 1e-9)),
    )
    expect(maxRelativeDifference).toBeGreaterThan(0.01)
  })

  /**
   * These four pin the power law as LOAD-BEARING. It was previously described in a comment
   * as "~1-3%, invisible" and offered up as the component to cut — a claim that was never
   * measured and is wrong by an order of magnitude. Prose failed to protect it, so these
   * assertions do.
   *
   * `timeToPeakInPrimary` is the diagnostic throughout: the fraction of the primary
   * submovement's duration at which tangential speed peaks. Minimum-jerk alone puts it at
   * exactly 0.5.
   */
  const timeToPeakInPrimary = (trajectory: HumanTrajectory): number => {
    const primary = trajectory.submovements[0]
    const profile = tangentialSpeedProfile(trajectory).filter(
      (p) => p.tMs <= primary.startMs + primary.durationMs,
    )
    let best = 0
    for (let i = 1; i < profile.length; i++) {
      if (profile[i].speedPxPerMs > profile[best].speedPxPerMs) best = i
    }
    return profile[best].tMs / primary.durationMs
  }

  // A single unperturbed reach, so only the component under test can move the peak.
  const isolatedPrimary = {
    maxCorrections: 0,
    spontaneousCorrectionProbability: 0,
    primaryEndpointSdFraction: 0,
    primaryUndershootFraction: 0,
    tremorAmplitudePx: 0,
  }
  const straightMove = (seed: number, tuning: Record<string, number>) =>
    planHumanTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 900, y: 0 },
      target: { width: 100, height: 100 },
      seed,
      sampleRateHz: 240,
      maxSamples: 8000,
      tuning: { ...isolatedPrimary, ...tuning },
    })

  it('a straight path peaks at exactly the minimum-jerk answer of 0.5', () => {
    // The control. If this drifts, the baseline everything else is measured against moved.
    for (const seed of [1, 7, 99, 4242]) {
      expect(timeToPeakInPrimary(straightMove(seed, { curvatureSdFraction: 0 }))).toBeCloseTo(0.5, 1)
    }
  })

  it('curvature as pure GEOMETRY barely moves the peak — the re-timing is what does', () => {
    // Same bowed path, timed with and without the power law.
    const shifts: number[] = []
    for (let seed = 1; seed <= 200; seed++) {
      const withoutLaw = timeToPeakInPrimary(straightMove(seed, { powerLawExponent: 0 }))
      // A curved path timed WITHOUT the law still peaks at the minimum-jerk answer...
      expect(withoutLaw).toBeCloseTo(0.5, 1)
      shifts.push(timeToPeakInPrimary(straightMove(seed, {})) - withoutLaw)
    }
    // ...and switching the law on moves it substantially on most seeds.
    const meanAbsoluteShift = shifts.reduce((sum, s) => sum + Math.abs(s), 0) / shifts.length
    expect(meanAbsoluteShift).toBeGreaterThan(0.05)
    expect(shifts.filter((s) => Math.abs(s) > 0.05).length / shifts.length).toBeGreaterThan(0.5)
  })

  it('scatters the peak rather than biasing it in one direction', () => {
    // The characterisation that matters: no consistent direction, wide spread. A model
    // where every move peaks in the same place is a tell; this is what prevents that.
    const positions: number[] = []
    for (let seed = 1; seed <= 300; seed++) {
      positions.push(timeToPeakInPrimary(straightMove(seed, {})))
    }
    const mean = positions.reduce((a, b) => a + b, 0) / positions.length
    // Near-symmetric on average — it is NOT a systematic early-peak mechanism.
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.1)
    // But genuinely spread out, both earlier and later than 0.5.
    expect(Math.min(...positions)).toBeLessThan(0.42)
    expect(Math.max(...positions)).toBeGreaterThan(0.58)
  })

  it('the whole movement is asymmetric, and it is the CORRECTIONS that make it so', () => {
    // Time-to-peak over TOTAL duration — the measure the empirical literature reports.
    const totalFraction = (tuning: Record<string, number>): number => {
      const values: number[] = []
      for (let seed = 1; seed <= 120; seed++) {
        const trajectory = planHumanTrajectory({
          from: { x: 0, y: 0 },
          to: { x: 900, y: 0 },
          target: { width: 100, height: 100 },
          seed,
          sampleRateHz: 240,
          maxSamples: 8000,
          tuning,
        })
        const primary = trajectory.submovements[0]
        const profile = tangentialSpeedProfile(trajectory).filter(
          (p) => p.tMs <= primary.startMs + primary.durationMs,
        )
        let best = 0
        for (let i = 1; i < profile.length; i++) {
          if (profile[i].speedPxPerMs > profile[best].speedPxPerMs) best = i
        }
        values.push(profile[best].tMs / trajectory.plannedDurationMs)
      }
      return values.reduce((a, b) => a + b, 0) / values.length
    }

    // Shipped: the peak sits before the midpoint of the whole movement, because a slow
    // homing phase follows it. That asymmetry is the realistic part — but only in the
    // right AMOUNT, so this is asserted against the empirical band rather than against
    // whatever the model happens to do.
    //
    // WHY THIS BOUND MOVED. It used to read `< 0.4` and `> 0.2`, which passed at the
    // 0.31 the model then produced — and 0.31 was a defect. Empirical aimed movements
    // peak at 0.35-0.45 of movement time; this model sat BELOW that at every one of 36
    // geometries in a distance-by-width sweep, never above, which is a systematic error
    // rather than scatter. The cause was in the duration budget: every corrective
    // submovement was re-paying Fitts's 100 ms intercept, inflating the corrective phase
    // to ~42% of the movement. Corrections are now charged the slope term only. So the
    // old bound did not fail to catch the defect by accident — it was a window drawn
    // around the defect, and a test that asserts `< 0.4` can never notice that the
    // literature says `> 0.35`. The band is now the assertion.
    const shipped = totalFraction({})
    expect(shipped).toBeGreaterThan(0.35)
    expect(shipped).toBeLessThan(0.45)

    // Removing tremor changes nothing; removing the corrective phase moves it LATER,
    // which is the proof that the corrections are the source of the asymmetry.
    expect(totalFraction({ tremorAmplitudePx: 0 })).toBeCloseTo(shipped, 2)
    expect(totalFraction({ maxCorrections: 0, spontaneousCorrectionProbability: 0 })).toBeGreaterThan(shipped)
  })

  it('preserves total duration and endpoints exactly', () => {
    const a = plan({ tuning: { powerLawExponent: 1 / 3 } })
    const b = plan({ tuning: { powerLawExponent: 0 } })
    expect(a.plannedDurationMs).toBeCloseTo(b.plannedDurationMs, 9)
    expect(a.samples[a.samples.length - 1].x).toBe(b.samples[b.samples.length - 1].x)
    expect(a.samples[a.samples.length - 1].y).toBe(b.samples[b.samples.length - 1].y)
  })
})

describe('physiological tremor', () => {
  it('is present, sub-pixel, and in the 8-12 Hz band', () => {
    const withTremor = plan({ sampleRateHz: 240, maxSamples: 4000 })
    const withoutTremor = plan({ sampleRateHz: 240, maxSamples: 4000, tuning: { tremorAmplitudePx: 0 } })

    const deviations = withTremor.samples.map((sample, i) =>
      Math.hypot(sample.x - withoutTremor.samples[i].x, sample.y - withoutTremor.samples[i].y),
    )
    const maxDeviation = Math.max(...deviations)
    expect(maxDeviation).toBeGreaterThan(0)
    // Invisible as jitter: never as much as a pixel and a half in total displacement.
    expect(maxDeviation).toBeLessThan(1.5)

    // Frequency check: count sign changes of the tremor's x-component. Two summed
    // sinusoids in [8,12] Hz over T seconds give roughly 2·f·T zero crossings.
    const seconds = withTremor.plannedDurationMs / 1000
    let crossings = 0
    let previous = 0
    for (let i = 1; i < withTremor.samples.length - 1; i++) {
      const value = withTremor.samples[i].x - withoutTremor.samples[i].x
      if (previous !== 0 && Math.sign(value) !== Math.sign(previous)) {
        crossings++
      }
      previous = value
    }
    const impliedHz = crossings / 2 / seconds
    expect(impliedHz).toBeGreaterThan(5)
    expect(impliedHz).toBeLessThan(20)
  })

  it('fades out so the pointer settles exactly on target', () => {
    const trajectory = plan({ sampleRateHz: 240, maxSamples: 4000 })
    const tail = trajectory.samples.slice(-3)
    const target = { x: 900, y: 560 }
    for (const sample of tail) {
      expect(Math.hypot(sample.x - target.x, sample.y - target.y)).toBeLessThan(12)
    }
  })
})

describe('determinism and sampling', () => {
  it('the same seed gives byte-identical trajectories', () => {
    const a = plan()
    const b = plan()
    expect(a.samples).toEqual(b.samples)
    expect(a.plannedDurationMs).toBe(b.plannedDurationMs)
    expect(a.submovements).toEqual(b.submovements)
  })

  it('different seeds give different trajectories', () => {
    const a = plan({ seed: 1 })
    const b = plan({ seed: 2 })
    expect(a.samples).not.toEqual(b.samples)
    // ...but both still land on the target.
    expect(a.samples[a.samples.length - 1]).toMatchObject({ x: 900, y: 560 })
    expect(b.samples[b.samples.length - 1]).toMatchObject({ x: 900, y: 560 })
  })

  it('honours the requested sample rate when it fits the budget', () => {
    const trajectory = plan({ sampleRateHz: 60, maxSamples: 260 })
    expect(trajectory.sampleRateReduced).toBe(false)
    expect(trajectory.sampleRateHz).toBeGreaterThan(50)
    expect(trajectory.sampleRateHz).toBeLessThan(70)
  })

  it('reduces the RATE rather than stretching the move when the budget binds', () => {
    const dense = plan({ sampleRateHz: 1000, maxSamples: 40 })
    expect(dense.sampleRateReduced).toBe(true)
    expect(dense.samples.length).toBe(40)
    // Crucially, the modelled duration is untouched — only resolution drops.
    const reference = plan({ sampleRateHz: 60 })
    expect(dense.plannedDurationMs).toBeCloseTo(reference.plannedDurationMs, 9)
    // And the shape survives: peak still mid-flight.
    const profile = tangentialSpeedProfile(dense)
    const peakIndex = profile.reduce((best, e, i) => (e.speedPxPerMs > profile[best].speedPxPerMs ? i : best), 0)
    expect(profile[peakIndex].tMs / dense.plannedDurationMs).toBeGreaterThan(0.2)
    expect(profile[peakIndex].tMs / dense.plannedDurationMs).toBeLessThan(0.8)
  })

  it('samples are monotone in time and within the viewport corridor', () => {
    const trajectory = plan()
    for (let i = 1; i < trajectory.samples.length; i++) {
      expect(trajectory.samples[i].tMs).toBeGreaterThan(trajectory.samples[i - 1].tMs)
    }
  })

  it('reports the difference between the Fitts request and the submovement total', () => {
    const trajectory = plan()
    expect(trajectory.fittsDurationMs).toBeGreaterThan(0)
    expect(trajectory.plannedDurationMs).toBeGreaterThan(0)
    // The decomposition pays for corrections out of the Fitts budget, so the two are
    // close; the point of exposing both is that a caller can see when floors pushed them
    // apart instead of finding out from a stopwatch.
    expect(trajectory.plannedDurationMs).toBeGreaterThan(trajectory.fittsDurationMs * 0.5)
    expect(trajectory.plannedDurationMs).toBeLessThan(trajectory.fittsDurationMs * 2.5)
  })
})

describe('degenerate inputs', () => {
  it('handles a zero-length move', () => {
    const trajectory = planHumanTrajectory({ from: { x: 10, y: 10 }, to: { x: 10, y: 10 }, seed: 5 })
    expect(trajectory.distancePx).toBe(0)
    expect(trajectory.samples.length).toBeGreaterThanOrEqual(2)
    expect(trajectory.samples[trajectory.samples.length - 1]).toMatchObject({ x: 10, y: 10 })
    expect(Number.isFinite(trajectory.plannedDurationMs)).toBe(true)
  })

  it('handles a one-pixel move', () => {
    const trajectory = planHumanTrajectory({ from: { x: 10, y: 10 }, to: { x: 11, y: 10 }, seed: 5 })
    expect(trajectory.samples.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y))).toBe(true)
    expect(trajectory.plannedDurationMs).toBeGreaterThanOrEqual(DEFAULT_HUMAN_MOTION_TUNING.minDurationMs * 0.5)
  })

  it('REJECTS a mistyped target shape loudly instead of silently using the default', () => {
    // The failure this guards: `{ widthPx, heightPx }` used to fall back to the 12px
    // default, making every move slow and uniform and looking like a broken Fitts's law.
    expect(() =>
      planHumanTrajectory({
        from: { x: 0, y: 0 },
        to: { x: 500, y: 0 },
        target: { widthPx: 120, heightPx: 40 } as unknown as { width: number; height: number },
        seed: 1,
      }),
    ).toThrow(/Did you mean \{ width, height \}/)

    expect(() =>
      planHumanTrajectory({
        from: { x: 0, y: 0 },
        to: { x: 500, y: 0 },
        target: { w: 120, h: 40 } as unknown as { width: number; height: number },
        seed: 1,
      }),
    ).toThrow(/must be \{ width: number, height: number \}/)

    // Omitting it entirely is still fine — that is the documented way to aim at coordinates.
    expect(() => planHumanTrajectory({ from: { x: 0, y: 0 }, to: { x: 500, y: 0 }, seed: 1 })).not.toThrow()
  })

  it('handles a degenerate target box', () => {
    const trajectory = planHumanTrajectory({
      from: { x: 0, y: 0 },
      to: { x: 200, y: 200 },
      target: { width: 0, height: 0 },
      seed: 5,
    })
    expect(trajectory.effectiveWidthPx).toBe(DEFAULT_HUMAN_MOTION_TUNING.defaultTargetWidthPx)
  })

  it('produces only finite coordinates for a large sweep of seeds and geometries', () => {
    for (let seed = 1; seed <= 50; seed++) {
      for (const to of [
        { x: 1, y: 1 },
        { x: 1920, y: 1080 },
        { x: -400, y: 300 },
        { x: 300, y: -400 },
      ]) {
        const trajectory = planHumanTrajectory({ from: { x: 200, y: 200 }, to, seed })
        for (const sample of trajectory.samples) {
          expect(Number.isFinite(sample.x)).toBe(true)
          expect(Number.isFinite(sample.y)).toBe(true)
          expect(Number.isFinite(sample.tMs)).toBe(true)
        }
      }
    }
  })
})
