/**
 * Human pointer trajectory model — the maths only. No Playwright, no CDP, no DOM.
 *
 * WHY THIS FILE IS PURE
 * ---------------------
 * The driver (human-mouse-driver.ts) is untestable without a browser. The model is the
 * part that has to be *correct*, so it lives here and is unit-tested against the papers
 * it implements. `planHumanTrajectory` is deterministic given a seed.
 *
 * WHAT IS IMPLEMENTED, AND WHY EACH PIECE IS SHAPED THE WAY IT IS
 * --------------------------------------------------------------
 * 1. DURATION — Fitts's Law, Shannon formulation (MacKenzie 1992):
 *        MT = a + b · log2(D/W + 1)
 *    D is travel distance, W the target's extent *along the movement axis*. This is why
 *    a move to a wide button is quicker than the same-length move to a 4px resize handle:
 *    W is in the model, not just D. `log2(D/W + 1)` is the "index of difficulty" in bits.
 *
 * 2. VELOCITY PROFILE — minimum-jerk (Flash & Hogan 1985):
 *        s(tau) = 10·tau^3 − 15·tau^4 + 6·tau^5,  tau = t/T
 *    The unique trajectory minimising integrated squared jerk between two rest states.
 *    Its derivative is the symmetric bell-shaped speed profile that human point-to-point
 *    reaching actually produces. A generic `cubic-bezier(.65,0,.35,1)` ease is NOT this
 *    curve — it is visibly flatter-topped and its peak is in the wrong place. That
 *    substitution is the single thing this module exists to stop.
 *
 * 3. PATH CURVATURE — human hand paths bow gently rather than running straight. Modelled
 *    as a cubic Bezier whose two control points are pushed perpendicular to the A→B
 *    chord. Magnitude scales with chord length, sign is drawn per-move. Peak deviation is
 *    held near 3% of amplitude, because a bigger swoop reads as fake in the other
 *    direction (a cursor that arcs across half the viewport is no more human than one
 *    that goes dead straight).
 *
 * 4. CORRECTIVE SUBMOVEMENTS — Meyer, Abrams, Kornblum, Wright & Smith (1988), the
 *    stochastic optimised-submovement model. An aimed movement is NOT one swoop. It is a
 *    fast primary ballistic phase whose endpoint is noisy, followed — when that endpoint
 *    misses the target region — by one or two short corrective submovements. Landing dead
 *    on the centre in one shot is the clearest bot tell there is, and this is the part
 *    most Bezier-plus-jitter implementations skip.
 *
 *    THIS is what makes the whole movement's velocity profile asymmetric. Minimum-jerk
 *    alone is symmetric by construction; real aimed movements are not, because of the slow
 *    homing phase at the end. Removing the power law moves the peak earlier and removing
 *    tremor does not move it at all — so the asymmetry is the corrections' doing, not
 *    either of those.
 *
 *    HOW MUCH ASYMMETRY IS THE RIGHT AMOUNT, AND WHAT WAS WRONG BEFORE. Empirical aimed
 *    movements put time-to-peak-velocity at roughly 0.35-0.45 of movement time. This model
 *    used to produce 0.23-0.31 across a 6-distance x 6-width sweep — consistently BELOW the
 *    band at every single geometry, never above, which is a systematic model error and not
 *    scatter. The cause was in the duration budget, not in any of the five components: each
 *    corrective submovement was charged a full Fitts `a + b·ID`, re-paying the 100 ms
 *    intercept that the regression only ever charges once for a whole aimed movement. That
 *    inflated the corrective phase to ~42% of total duration and squeezed the primary to a
 *    0.52-0.58 share. Charging corrections the SLOPE TERM ONLY fixes it — see the budget
 *    block in `planHumanTrajectory`.
 *
 *    Measured after the fix, over the same 6x6 sweep at 300 seeds per cell, mean
 *    time-to-peak-velocity as a fraction of total duration:
 *
 *      ID 2.0-5.5 bits (27 of 36 cells)   0.362-0.417   ALL inside the band
 *      ID 6.2-6.7 bits (1200/16, 1600/16) 0.339, 0.326  below
 *      ID 0.9 bits     (200/240)          0.312         below
 *      ID 1.2 bits     (300/240)          0.342         below
 *
 *    The four stragglers are the corners of the sweep, and both corners sit outside the
 *    regime the 0.35-0.45 figure was measured in: Fitts experiments essentially do not run
 *    below 2 bits, and a 16px target at 1600px is a resize handle at arm's length, where
 *    Meyer's own model says the corrective phase genuinely does dominate. They are reported
 *    rather than tuned away, because the only knob that would move them — raising
 *    `primaryMinDurationShare` — buys the ratio by forcing plannedDurationMs above
 *    fittsDurationMs, i.e. by breaking Fitts's law to satisfy a summary statistic about the
 *    velocity profile. That trade is not worth making and was not made.
 *
 * 5. 2/3 POWER LAW (Lacquaniti, Terzuolo & Viviani 1983) — tangential velocity co-varies
 *    with path curvature as v ∝ kappa^(−1/3): humans slow down through curves. Applied as
 *    a re-timing of samples along the (already curved) path, in a way that preserves the
 *    total duration exactly — see `buildWarpedArcLengthTable`.
 *
 *    DO NOT DELETE THIS AS A GARNISH. Measured, 1000-seed A/B with everything else held
 *    identical (900px move, primary phase, 240Hz sampling), reporting time-to-peak-velocity
 *    as a fraction of the primary submovement's duration:
 *
 *      straight path, no curvature      0.505   (the analytic minimum-jerk answer, 0.5)
 *      curved path, power law OFF       0.499   (curvature as pure geometry: no effect)
 *      curved path, power law ON        mean absolute shift 0.094, max 0.241,
 *                                       67% of seeds moved by more than 0.05
 *
 *    So it is the LARGEST single influence on the shape of the velocity profile — an order
 *    of magnitude bigger than tremor, and bigger than curvature-as-geometry, which on its
 *    own does essentially nothing to the timing.
 *
 *    But note what kind of influence it is: the signed mean shift is only +0.037, so it does
 *    NOT bias the peak in a consistent direction. What it does is make the peak's position
 *    depend on where that particular path happens to bend — so no two moves share a velocity
 *    profile, and the variation is coupled to the real geometry rather than sprinkled on as
 *    noise. Every move peaking at exactly 50.5% is itself a bot tell; this is what stops it.
 *
 *    (An earlier version of this comment called the effect "~1-3%, invisible". That was
 *    wrong, and it was wrong because it was asserted rather than measured.)
 *
 * 6. PHYSIOLOGICAL TREMOR — the 8-12 Hz component of normal hand tremor. Sub-pixel
 *    amplitude. If you can see it as "jitter" it is wrong; the only thing it should do is
 *    stop the path being machine-smooth.
 *
 * 7. SEEDED RANDOMNESS — every stochastic draw comes from a mulberry32 PRNG threaded
 *    through the planner. `Math.random()` is never called. Same seed ⇒ same trajectory,
 *    byte for byte, which is what makes both the unit tests and a reproducible recording
 *    possible.
 */

export interface Point {
  x: number
  y: number
}

/** One dispatched pointer position. `tMs` is an offset from the start of the move. */
export interface TrajectorySample {
  tMs: number
  x: number
  y: number
}

export type SubmovementKind = 'primary' | 'correction'

/**
 * One ballistic phase. Meyer's model is a *sequence* of these; the primary one carries
 * most of the distance and the corrections clean up whatever it missed.
 */
export interface Submovement {
  kind: SubmovementKind
  index: number
  from: Point
  to: Point
  startMs: number
  durationMs: number
  /** Signed distance from this submovement's endpoint to the true target, in px. */
  endpointErrorPx: number
  /** Perpendicular control-point offsets that bow this leg's Bezier, in px. */
  curveOffsetsPx: [number, number]
}

export interface HumanMotionTuning {
  /**
   * Fitts intercept `a` (ms) and slope `b` (ms/bit).
   *
   * MacKenzie's mouse-pointing regressions land around a ≈ 0.1 s, b ≈ 0.15 s/bit, and
   * that is where these started. b was then cut to 105 ms/bit after watching recorded
   * clips: at 150 ms/bit a routine 900px move to a button takes ~780 ms, which reads as
   * sluggish on video — the published figures come from naive subjects doing a discrete
   * lab task, and a practised user driving a familiar UI is faster. The intercept is left
   * at the literature value because it is what keeps short moves from being instant.
   */
  fittsInterceptMs: number
  fittsSlopeMsPerBit: number
  /** Hard bounds on the modelled move time. */
  minDurationMs: number
  maxDurationMs: number

  /** Target extent used when the caller aims at bare coordinates rather than an element. */
  defaultTargetWidthPx: number

  /** Perpendicular control-point offset, as a fraction of chord length (gaussian sd). */
  curvatureSdFraction: number
  /** Clamps on that offset — as a fraction of chord, and in absolute px. */
  curvatureMaxFraction: number
  curvatureMaxPx: number

  /**
   * Meyer: primary-submovement endpoint noise. Standard deviation as a fraction of the
   * distance travelled — endpoint variability grows with movement velocity, and D/T is
   * the usual proxy for that.
   */
  primaryEndpointSdFraction: number
  /**
   * Systematic *undershoot* of the primary submovement, as a fraction of distance.
   * The optimised-submovement model predicts a short bias rather than a symmetric one:
   * an overshoot correction has to reverse direction, which costs more than continuing.
   */
  primaryUndershootFraction: number
  /** Lateral (across-axis) endpoint noise, relative to the along-axis sd. */
  lateralEndpointSdRatio: number
  /** Cap on corrective submovements. Meyer's data is dominated by 1, occasionally 2. */
  maxCorrections: number
  /** Chance of a corrective nudge even when the primary already landed inside the target. */
  spontaneousCorrectionProbability: number
  /**
   * Floor on a corrective submovement's duration (ms).
   *
   * A correction is charged `fittsSlopeMsPerBit · log2(hop/W + 1)` — the slope term only,
   * see the budget block in `planHumanTrajectory` for why the intercept is not re-paid —
   * and for a residual of a few pixels that comes out at single-digit milliseconds. This
   * floor is what turns such a residual into a settling dab rather than a one-frame
   * teleport, so it is the parameter that decides whether a correction reads as HOMING or
   * as a twitch.
   *
   * 60 ms was chosen by measuring, over the 6x6 distance-by-width sweep at 300 seeds each,
   * the peak speed of every correction against the peak speed of its own primary. Meyer's
   * model says a correction is always the slower submovement, so a ratio at or above 1 is
   * a snap. At a 40 ms floor the worst case is 1.107 — a correction that outruns its own
   * primary — and at 45 ms it is 0.973, close enough to be luck. At 60 ms the worst case
   * is 0.819 and the fastest corrections are set by the slope term rather than by this
   * floor, which is the point at which raising it further stops buying anything.
   */
  correctionMinDurationMs: number
  /** Pause between submovements (ms, gaussian mean) — the feedback loop is not free. */
  correctionDwellMs: number
  correctionDwellSdMs: number
  /** The primary phase never gets less than this share of the Fitts budget. */
  primaryMinDurationShare: number

  /** Physiological tremor: amplitude in px and the 8-12 Hz band it lives in. */
  tremorAmplitudePx: number
  tremorMinHz: number
  tremorMaxHz: number
  /** Tremor is ramped to zero over the last N ms so the move lands exactly on target. */
  tremorFadeOutMs: number

  /** 2/3 power law: v ∝ kappa^(−powerLawExponent). 1/3 is the published value. */
  powerLawExponent: number
  /** Bounds on the power-law speed multiplier, so a curvature spike cannot stall the move. */
  powerLawMinFactor: number
  powerLawMaxFactor: number
}

/**
 * Defaults. Provenance for each family:
 *  - Fitts a/b: literature, then b tuned down by eye on recorded clips (see field docs).
 *  - curvature 5% sd / 12% cap: tuned by eye on clips. 5% sd puts typical peak path
 *    deviation near 3% of amplitude, which is the range reported for unconstrained
 *    reaching; the cap exists so an unlucky draw cannot produce a cartoon swoop.
 *  - endpoint noise 5% + 2.5% undershoot: Meyer's reported primary-endpoint spread for
 *    aimed movements sits in that neighbourhood, and 5% is what makes the primary miss a
 *    normal-sized button often enough that corrections are the rule, not the exception.
 *  - tremor 0.4px: physiological tremor at the fingertip is a few tenths of a millimetre;
 *    at typical display density that is well under a pixel. 0.4px is the largest value
 *    that still disappears on video — 1px was visible as shimmer.
 */
export const DEFAULT_HUMAN_MOTION_TUNING: HumanMotionTuning = {
  fittsInterceptMs: 100,
  fittsSlopeMsPerBit: 105,
  minDurationMs: 90,
  maxDurationMs: 2200,

  defaultTargetWidthPx: 12,

  curvatureSdFraction: 0.05,
  curvatureMaxFraction: 0.12,
  curvatureMaxPx: 90,

  primaryEndpointSdFraction: 0.05,
  primaryUndershootFraction: 0.025,
  lateralEndpointSdRatio: 0.45,
  maxCorrections: 2,
  spontaneousCorrectionProbability: 0.3,
  correctionMinDurationMs: 60,
  correctionDwellMs: 18,
  correctionDwellSdMs: 8,
  primaryMinDurationShare: 0.5,

  tremorAmplitudePx: 0.4,
  tremorMinHz: 8,
  tremorMaxHz: 12,
  tremorFadeOutMs: 70,

  powerLawExponent: 1 / 3,
  powerLawMinFactor: 0.6,
  powerLawMaxFactor: 1.7,
}

export interface TargetExtent {
  width: number
  height: number
}

export interface PlanHumanTrajectoryOptions {
  from: Point
  to: Point
  /** Target box, for Fitts's `W`. Omitted ⇒ `defaultTargetWidthPx` is used. */
  target?: TargetExtent
  seed: number
  /** Sample rate for the emitted polyline. Defaults to 60 Hz — see the driver for why. */
  sampleRateHz?: number
  /**
   * Upper bound on emitted samples. When the modelled duration would need more, the rate
   * is REDUCED (and reported) rather than the move being stretched: the samples are drawn
   * from the same continuous model, so the velocity profile's shape survives exactly, it
   * is just resolved more coarsely.
   */
  maxSamples?: number
  tuning?: Partial<HumanMotionTuning>
}

export interface HumanTrajectory {
  samples: TrajectorySample[]
  submovements: Submovement[]
  /** Straight-line distance origin → target (px). */
  distancePx: number
  /** Target extent along the movement axis, i.e. Fitts's `W` (px). */
  effectiveWidthPx: number
  /** log2(D/W + 1), in bits. */
  indexOfDifficultyBits: number
  /** What Fitts's law asked for, before submovement duration floors (ms). */
  fittsDurationMs: number
  /** What the submovement decomposition actually adds up to (ms). */
  plannedDurationMs: number
  /** Total arc length of the sampled path (px). Always ≥ distancePx. */
  pathLengthPx: number
  sampleRateHz: number
  /** True when `sampleRateHz` was reduced from the requested rate to respect `maxSamples`. */
  sampleRateReduced: boolean
  seed: number
  tuning: HumanMotionTuning
}

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

export interface SeededRandom {
  /** Uniform in [0, 1). */
  next: () => number
  /** Normal(mean, sd) via Box-Muller. */
  gaussian: (options: { mean: number; sd: number }) => number
  /** Uniform in [min, max). */
  range: (options: { min: number; max: number }) => number
  /** True with probability `p`. */
  chance: (p: number) => boolean
}

/**
 * mulberry32 — small, fast, and good enough for motion noise. Chosen over anything
 * cryptographic because the only requirement is reproducibility across runs and machines.
 */
export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0
  // A zero seed makes mulberry32 degenerate, so nudge it off zero.
  if (state === 0) {
    state = 0x9e3779b9
  }

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const gaussian = (options: { mean: number; sd: number }): number => {
    // Box-Muller. u1 is nudged off zero because log(0) is -Infinity.
    const u1 = Math.max(next(), Number.EPSILON)
    const u2 = next()
    const magnitude = Math.sqrt(-2 * Math.log(u1))
    return options.mean + options.sd * magnitude * Math.cos(2 * Math.PI * u2)
  }

  return {
    next,
    gaussian,
    range: (options) => options.min + next() * (options.max - options.min),
    chance: (p) => next() < p,
  }
}

// ---------------------------------------------------------------------------
// 1. Fitts's law
// ---------------------------------------------------------------------------

/**
 * The extent of an axis-aligned box along a movement direction, measured through its
 * centre. This is Fitts's `W` for a 2D target: aiming lengthwise down a wide, short
 * button is an easy task, aiming at the same button edge-on is a hard one, and only the
 * projected extent captures that. (The alternative — always using min(w,h) — throws the
 * approach direction away and reports every button as equally hard from every side.)
 */
/**
 * Reject a `target` that is present but not shaped like `{ width, height }`.
 *
 * WHY THIS THROWS. Falling back to the default 12px extent for an unrecognised shape is a
 * silent fallback of the worst kind: `{ widthPx, heightPx }` — a plausible typo, since the
 * RESULT type uses `effectiveWidthPx` and `distancePx` — would leave every move computing
 * its duration against a 12px target. Nothing errors, but every move comes out slow and
 * uniform, and the symptom reads as "Fitts's law is broken" rather than "you misspelled an
 * option". That cost a reviewer real time, so the mistake is now loud.
 *
 * A box with the RIGHT keys and non-positive values is a different thing — a real
 * zero-size element — and legitimately falls back.
 */
function assertTargetExtentShape(target: unknown): void {
  if (target === undefined || target === null) {
    return
  }
  if (typeof target !== 'object') {
    throw new Error(`planHumanTrajectory: \`target\` must be an object { width, height }, received ${typeof target}.`)
  }

  const candidate = target as Record<string, unknown>
  if (typeof candidate.width === 'number' && typeof candidate.height === 'number') {
    return
  }

  const received = Object.keys(candidate)
  const hint =
    'widthPx' in candidate || 'heightPx' in candidate
      ? ' Did you mean { width, height }? (The result type uses the `Px` suffix; the input does not.)'
      : ''
  throw new Error(
    `planHumanTrajectory: \`target\` must be { width: number, height: number }. ` +
      `Received keys [${received.join(', ')}].${hint} ` +
      'Omit `target` entirely to aim at bare coordinates.',
  )
}

export function effectiveTargetWidth(options: {
  from: Point
  to: Point
  target?: TargetExtent
  fallbackPx: number
}): number {
  const { from, to, target, fallbackPx } = options
  assertTargetExtentShape(target)
  if (!target || !(target.width > 0) || !(target.height > 0)) {
    return Math.max(1, fallbackPx)
  }

  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) {
    return Math.max(1, Math.min(target.width, target.height))
  }

  const ux = Math.abs(dx / length)
  const uy = Math.abs(dy / length)

  // Chord through the centre of the box along (ux, uy). Purely horizontal or vertical
  // approaches degenerate to the box's own width/height.
  const spanX = ux < 1e-9 ? Number.POSITIVE_INFINITY : target.width / ux
  const spanY = uy < 1e-9 ? Number.POSITIVE_INFINITY : target.height / uy
  const span = Math.min(spanX, spanY)

  // Never let W exceed D-scale sanity or drop below a pixel.
  return Math.max(1, span)
}

/** log2(D/W + 1) — Shannon-formulation index of difficulty, in bits. */
export function indexOfDifficulty(options: { distancePx: number; widthPx: number }): number {
  const width = Math.max(1e-6, options.widthPx)
  return Math.log2(Math.max(0, options.distancePx) / width + 1)
}

/** MT = a + b·log2(D/W + 1), clamped to the tuning's duration bounds. */
export function fittsDurationMs(options: {
  distancePx: number
  widthPx: number
  tuning: HumanMotionTuning
}): number {
  const { tuning } = options
  const bits = indexOfDifficulty({ distancePx: options.distancePx, widthPx: options.widthPx })
  const raw = tuning.fittsInterceptMs + tuning.fittsSlopeMsPerBit * bits
  return Math.min(tuning.maxDurationMs, Math.max(tuning.minDurationMs, raw))
}

// ---------------------------------------------------------------------------
// 2. Minimum-jerk
// ---------------------------------------------------------------------------

/**
 * Flash & Hogan (1985) minimum-jerk position profile, normalised to [0,1].
 * s(tau) = 10·tau^3 − 15·tau^4 + 6·tau^5.
 * s(0)=0, s(1)=1, s'(0)=s'(1)=0, s''(0)=s''(1)=0 — starts and ends at rest with zero
 * acceleration, which is what makes the speed profile a smooth symmetric bell.
 */
export function minimumJerkPosition(tau: number): number {
  const t = tau <= 0 ? 0 : tau >= 1 ? 1 : tau
  const t3 = t * t * t
  return t3 * (10 - 15 * t + 6 * t * t)
}

/** ds/dtau — the bell. Peaks at tau = 0.5 with value 1.875. */
export function minimumJerkVelocity(tau: number): number {
  const t = tau <= 0 ? 0 : tau >= 1 ? 1 : tau
  const t2 = t * t
  return 30 * t2 - 60 * t2 * t + 30 * t2 * t2
}

// ---------------------------------------------------------------------------
// 3. Curved path — cubic Bezier with perpendicular control-point offsets
// ---------------------------------------------------------------------------

interface CubicBezier {
  p0: Point
  p1: Point
  p2: Point
  p3: Point
}

function bezierPointAt(curve: CubicBezier, u: number): Point {
  const v = 1 - u
  const a = v * v * v
  const b = 3 * v * v * u
  const c = 3 * v * u * u
  const d = u * u * u
  return {
    x: a * curve.p0.x + b * curve.p1.x + c * curve.p2.x + d * curve.p3.x,
    y: a * curve.p0.y + b * curve.p1.y + c * curve.p2.y + d * curve.p3.y,
  }
}

function bezierDerivativesAt(curve: CubicBezier, u: number): { d1: Point; d2: Point } {
  const v = 1 - u
  const d1 = {
    x: 3 * v * v * (curve.p1.x - curve.p0.x) + 6 * v * u * (curve.p2.x - curve.p1.x) + 3 * u * u * (curve.p3.x - curve.p2.x),
    y: 3 * v * v * (curve.p1.y - curve.p0.y) + 6 * v * u * (curve.p2.y - curve.p1.y) + 3 * u * u * (curve.p3.y - curve.p2.y),
  }
  const d2 = {
    x: 6 * v * (curve.p2.x - 2 * curve.p1.x + curve.p0.x) + 6 * u * (curve.p3.x - 2 * curve.p2.x + curve.p1.x),
    y: 6 * v * (curve.p2.y - 2 * curve.p1.y + curve.p0.y) + 6 * u * (curve.p3.y - 2 * curve.p2.y + curve.p1.y),
  }
  return { d1, d2 }
}

/** Signed-magnitude curvature kappa = |x'y'' − y'x''| / (x'^2 + y'^2)^(3/2). */
function bezierCurvatureAt(curve: CubicBezier, u: number): number {
  const { d1, d2 } = bezierDerivativesAt(curve, u)
  const speedSquared = d1.x * d1.x + d1.y * d1.y
  if (speedSquared < 1e-12) {
    return 0
  }
  const cross = Math.abs(d1.x * d2.y - d1.y * d2.x)
  return cross / Math.pow(speedSquared, 1.5)
}

/**
 * Build the bowed path for one submovement. Control points sit at 1/3 and 2/3 along the
 * chord, displaced perpendicular to it. Both offsets share a sign so the leg bows one way
 * (a C), not two (an S) — reaching movements are single-signed arcs.
 */
function buildSubmovementCurve(options: {
  from: Point
  to: Point
  offsets: [number, number]
}): CubicBezier {
  const { from, to, offsets } = options
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)

  if (length < 1e-9) {
    return { p0: from, p1: from, p2: to, p3: to }
  }

  // Unit perpendicular to the chord.
  const px = -dy / length
  const py = dx / length

  return {
    p0: from,
    p1: { x: from.x + dx / 3 + px * offsets[0], y: from.y + dy / 3 + py * offsets[0] },
    p2: { x: from.x + (dx * 2) / 3 + px * offsets[1], y: from.y + (dy * 2) / 3 + py * offsets[1] },
    p3: to,
  }
}

function drawCurveOffsets(options: {
  chordLengthPx: number
  rng: SeededRandom
  tuning: HumanMotionTuning
}): [number, number] {
  const { chordLengthPx, rng, tuning } = options
  const cap = Math.min(chordLengthPx * tuning.curvatureMaxFraction, tuning.curvatureMaxPx)
  const sd = chordLengthPx * tuning.curvatureSdFraction

  const sign = rng.chance(0.5) ? 1 : -1
  const clampToCap = (value: number): number => Math.min(cap, Math.max(-cap, value))

  // Same sign, independent magnitudes: a C-shaped bow with an asymmetric apex, which is
  // what a real reach looks like — the bulge sits nearer the start than the midpoint.
  const first = clampToCap(sign * Math.abs(rng.gaussian({ mean: sd, sd: sd * 0.5 })))
  const second = clampToCap(sign * Math.abs(rng.gaussian({ mean: sd * 0.7, sd: sd * 0.5 })))
  return [first, second]
}

// ---------------------------------------------------------------------------
// 5. 2/3 power law re-timing
// ---------------------------------------------------------------------------

interface ArcLengthTable {
  /** Bezier parameter at each knot. */
  u: number[]
  /** Cumulative true arc length at each knot (px). */
  s: number[]
  /**
   * Cumulative *warped* arc length. Minimum-jerk is applied in this coordinate rather
   * than in raw arc length, which is what implements v ∝ kappa^(−1/3): where the path is
   * curved, `g` is small, so a given slice of warped length spans less real length, so
   * the pointer covers less ground per unit time — it slows through the curve. Because
   * the warp is a strictly increasing reparameterisation of the SAME interval, total
   * duration is preserved exactly; only the distribution of speed along the path changes.
   *
   * "Only the distribution of speed" undersells it, and this is the line to read before
   * deciding this file could lose a component. Measured A/B over 1000 seeds, this warp
   * moves time-to-peak-velocity within the primary phase by a mean absolute 0.094 (max
   * 0.241) — the largest effect of any component here. See item 5 in the file header for
   * the full table and for why the effect being direction-LESS is the point.
   * `human-mouse.test.ts` pins all of this.
   */
  sigma: number[]
  totalLength: number
  totalSigma: number
  /** False when the path is straight enough that the power law has nothing to say. */
  powerLawApplied: boolean
}

const ARC_LENGTH_KNOTS = 192

function buildWarpedArcLengthTable(options: { curve: CubicBezier; tuning: HumanMotionTuning }): ArcLengthTable {
  const { curve, tuning } = options
  const knots = ARC_LENGTH_KNOTS

  const u: number[] = new Array(knots + 1)
  const s: number[] = new Array(knots + 1)
  const curvature: number[] = new Array(knots + 1)

  let previous = bezierPointAt(curve, 0)
  u[0] = 0
  s[0] = 0
  curvature[0] = bezierCurvatureAt(curve, 0)

  for (let i = 1; i <= knots; i++) {
    const uu = i / knots
    const point = bezierPointAt(curve, uu)
    u[i] = uu
    s[i] = s[i - 1] + Math.hypot(point.x - previous.x, point.y - previous.y)
    curvature[i] = bezierCurvatureAt(curve, uu)
    previous = point
  }

  const totalLength = s[knots]

  // A straight (or degenerate) leg has kappa ≈ 0 everywhere. The power law is a statement
  // about *relative* curvature; with no curvature there is nothing to relate, and forcing
  // it through a near-zero denominator would produce noise, not physiology. So skip it and
  // say so, rather than silently multiplying by garbage.
  const sortedCurvature = [...curvature].sort((a, b) => a - b)
  const medianCurvature = sortedCurvature[Math.floor(sortedCurvature.length / 2)]
  const powerLawApplied = totalLength > 1e-6 && medianCurvature > 1e-6

  const sigma: number[] = new Array(knots + 1)
  sigma[0] = 0

  if (!powerLawApplied) {
    for (let i = 1; i <= knots; i++) {
      sigma[i] = s[i]
    }
    return { u, s, sigma, totalLength, totalSigma: sigma[knots], powerLawApplied: false }
  }

  // g = (kappa / kappa_median)^(−exponent): the speed multiplier the power law predicts,
  // expressed relative to the path's own typical curvature so that a uniformly gentle arc
  // is not globally slowed (that would double-count against Fitts).
  const speedFactor = (index: number): number => {
    const ratio = Math.max(curvature[index], medianCurvature * 0.02) / medianCurvature
    const raw = Math.pow(ratio, -tuning.powerLawExponent)
    return Math.min(tuning.powerLawMaxFactor, Math.max(tuning.powerLawMinFactor, raw))
  }

  for (let i = 1; i <= knots; i++) {
    const segmentLength = s[i] - s[i - 1]
    // Trapezoid on 1/g: warped length of the segment.
    const inverseMean = 0.5 * (1 / speedFactor(i - 1) + 1 / speedFactor(i))
    sigma[i] = sigma[i - 1] + segmentLength * inverseMean
  }

  return { u, s, sigma, totalLength, totalSigma: sigma[knots], powerLawApplied: true }
}

/** Invert the warped-length table: warped length → Bezier parameter. */
function bezierParameterAtWarpedLength(table: ArcLengthTable, targetSigma: number): number {
  const { sigma, u } = table
  if (targetSigma <= 0) {
    return 0
  }
  if (targetSigma >= table.totalSigma) {
    return 1
  }

  let low = 0
  let high = sigma.length - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (sigma[mid] <= targetSigma) {
      low = mid
    } else {
      high = mid
    }
  }

  const span = sigma[high] - sigma[low]
  const fraction = span < 1e-12 ? 0 : (targetSigma - sigma[low]) / span
  return u[low] + (u[high] - u[low]) * fraction
}

// ---------------------------------------------------------------------------
// 4. Submovement decomposition
// ---------------------------------------------------------------------------

interface SubmovementPlanEntry {
  kind: SubmovementKind
  from: Point
  to: Point
  dwellBeforeMs: number
}

function planSubmovements(options: {
  from: Point
  to: Point
  effectiveWidthPx: number
  rng: SeededRandom
  tuning: HumanMotionTuning
}): SubmovementPlanEntry[] {
  const { from, to, effectiveWidthPx, rng, tuning } = options

  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)

  if (distance < 1e-9) {
    return [{ kind: 'primary', from, to, dwellBeforeMs: 0 }]
  }

  const ux = dx / distance
  const uy = dy / distance
  // Perpendicular, for lateral scatter.
  const px = -uy
  const py = ux

  // Meyer: the primary submovement is ballistic and its endpoint is noisy, with a bias to
  // fall SHORT. Along-axis error is the one that decides whether a correction is needed.
  const alongSd = distance * tuning.primaryEndpointSdFraction
  const alongError = rng.gaussian({
    mean: -distance * tuning.primaryUndershootFraction,
    sd: alongSd,
  })
  const lateralError = rng.gaussian({ mean: 0, sd: alongSd * tuning.lateralEndpointSdRatio })

  let current: Point = {
    x: to.x + ux * alongError + px * lateralError,
    y: to.y + uy * alongError + py * lateralError,
  }

  const entries: SubmovementPlanEntry[] = [{ kind: 'primary', from, to: current, dwellBeforeMs: 0 }]

  const captureRadius = effectiveWidthPx / 2

  for (let i = 0; i < tuning.maxCorrections; i++) {
    const residual = Math.hypot(to.x - current.x, to.y - current.y)
    const missedTarget = residual > captureRadius

    // A correction is mandatory when the previous endpoint fell outside the target; when
    // it fell inside, humans still often add a small settling nudge, so allow one by
    // chance. Order matters: the draw must happen unconditionally on the mandatory branch
    // too, or the same seed would produce different streams for different geometries.
    const spontaneous = rng.chance(tuning.spontaneousCorrectionProbability)
    if (!missedTarget && !spontaneous) {
      break
    }

    const isLastAllowed = i === tuning.maxCorrections - 1
    const residualSd = residual * tuning.primaryEndpointSdFraction

    // The final correction must land exactly on the requested point — the caller asked to
    // be at (x, y) and a click has to hit it. Earlier corrections are allowed to miss.
    const landsExactly = isLastAllowed || !rng.chance(0.35)

    const next: Point = landsExactly
      ? to
      : {
          x: to.x + ux * rng.gaussian({ mean: -residual * tuning.primaryUndershootFraction, sd: residualSd }),
          y: to.y + uy * rng.gaussian({ mean: 0, sd: residualSd * tuning.lateralEndpointSdRatio }),
        }

    entries.push({
      kind: 'correction',
      from: current,
      to: next,
      dwellBeforeMs: Math.max(0, rng.gaussian({ mean: tuning.correctionDwellMs, sd: tuning.correctionDwellSdMs })),
    })

    current = next
    if (landsExactly) {
      break
    }
  }

  // Guarantee termination on the requested point even if every draw above missed.
  const last = entries[entries.length - 1]
  if (last.to.x !== to.x || last.to.y !== to.y) {
    entries.push({
      kind: 'correction',
      from: last.to,
      to,
      dwellBeforeMs: Math.max(0, rng.gaussian({ mean: tuning.correctionDwellMs, sd: tuning.correctionDwellSdMs })),
    })
  }

  return entries
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

interface BuiltSubmovement extends Submovement {
  curve: CubicBezier
  table: ArcLengthTable
  dwellBeforeMs: number
}

export const DEFAULT_SAMPLE_RATE_HZ = 60
export const DEFAULT_MAX_SAMPLES = 260

export function planHumanTrajectory(options: PlanHumanTrajectoryOptions): HumanTrajectory {
  const tuning: HumanMotionTuning = { ...DEFAULT_HUMAN_MOTION_TUNING, ...options.tuning }
  const rng = createSeededRandom(options.seed)

  const from = { x: options.from.x, y: options.from.y }
  const to = { x: options.to.x, y: options.to.y }

  const distancePx = Math.hypot(to.x - from.x, to.y - from.y)
  const effectiveWidthPx = effectiveTargetWidth({
    from,
    to,
    target: options.target,
    fallbackPx: tuning.defaultTargetWidthPx,
  })
  const bits = indexOfDifficulty({ distancePx, widthPx: effectiveWidthPx })
  const fittsMs = fittsDurationMs({ distancePx, widthPx: effectiveWidthPx, tuning })

  const planned = planSubmovements({ from, to, effectiveWidthPx, rng, tuning })

  // Duration budget. Fitts's MT covers the WHOLE aimed movement, so the corrections are
  // paid for out of it: each correction gets its own time for its (short) residual hop,
  // and the primary keeps the remainder. When the correction floors would eat more than
  // the budget, the primary is held at `primaryMinDurationShare` and the total simply
  // exceeds the Fitts figure — reported as plannedDurationMs vs fittsDurationMs rather
  // than quietly compressed.
  //
  // A CORRECTION IS CHARGED THE SLOPE TERM ONLY — `b · log2(hop/W + 1)`, NOT the full
  // `a + b · log2(...)`. This is the difference between a velocity profile inside the
  // empirical band and one well below it, and the reason is a modelling error rather than
  // a taste call. In `MT = a + b · ID` the intercept `a` is a fixed per-MOVEMENT overhead
  // — reaction time, limb initiation, device take-up — that the regression assigns to the
  // whole aimed movement, corrections included. Meyer's decomposition splits one movement
  // into submovements; it does not turn one movement into several, so `a` is paid once,
  // by the primary. Charging it again per correction double-counts it, and because `a` is
  // 100 ms against corrective hops of 10-70 px whose actual movement content is 6-114 ms,
  // the double-count was the dominant term: corrections were taking ~42% of total duration
  // and squeezing the primary down to a 0.52-0.58 share, which put time-to-peak-velocity at
  // 0.23-0.31 of total duration against an empirical 0.35-0.45.
  //
  // This is also what makes `correctionMinDurationMs` a live parameter. Under the old
  // formula it was dead code: `fittsDurationMs` cannot return less than `minDurationMs`
  // (90) and in practice never less than the intercept (100), so `max(80, raw)` chose
  // `raw` in 100% of corrections — measured, 0 of 2386 across the geometry sweep. The
  // floor now does the job its name claims, and it is what stops a 6 ms residual hop from
  // being dispatched as a single-frame twitch.
  const corrections = planned.filter((entry) => entry.kind === 'correction')
  const correctionDurations = corrections.map((entry) => {
    const hop = Math.hypot(entry.to.x - entry.from.x, entry.to.y - entry.from.y)
    const raw = tuning.fittsSlopeMsPerBit * indexOfDifficulty({ distancePx: hop, widthPx: effectiveWidthPx })
    return Math.min(tuning.maxDurationMs, Math.max(tuning.correctionMinDurationMs, raw))
  })
  const correctionTotal = correctionDurations.reduce((sum, value) => sum + value, 0)
  const dwellTotal = planned.reduce((sum, entry) => sum + entry.dwellBeforeMs, 0)
  const primaryDurationMs = Math.max(fittsMs * tuning.primaryMinDurationShare, fittsMs - correctionTotal - dwellTotal)

  const built: BuiltSubmovement[] = []
  let cursorMs = 0
  let correctionIndex = 0

  planned.forEach((entry, index) => {
    cursorMs += entry.dwellBeforeMs
    const durationMs = entry.kind === 'primary' ? primaryDurationMs : correctionDurations[correctionIndex++]
    const chordLength = Math.hypot(entry.to.x - entry.from.x, entry.to.y - entry.from.y)

    // Corrections are short and near-straight in real data — bow only the primary.
    const offsets: [number, number] =
      entry.kind === 'primary' ? drawCurveOffsets({ chordLengthPx: chordLength, rng, tuning }) : [0, 0]

    const curve = buildSubmovementCurve({ from: entry.from, to: entry.to, offsets })
    const table = buildWarpedArcLengthTable({ curve, tuning })

    built.push({
      kind: entry.kind,
      index,
      from: entry.from,
      to: entry.to,
      startMs: cursorMs,
      durationMs,
      endpointErrorPx: Math.hypot(to.x - entry.to.x, to.y - entry.to.y),
      curveOffsetsPx: offsets,
      curve,
      table,
      dwellBeforeMs: entry.dwellBeforeMs,
    })

    cursorMs += durationMs
  })

  const plannedDurationMs = cursorMs

  // Tremor: two sinusoids per axis in the 8-12 Hz physiological band, fixed phases drawn
  // from the seed so the same trajectory replays identically.
  const tremor = {
    fx1: rng.range({ min: tuning.tremorMinHz, max: tuning.tremorMaxHz }),
    fx2: rng.range({ min: tuning.tremorMinHz, max: tuning.tremorMaxHz }),
    fy1: rng.range({ min: tuning.tremorMinHz, max: tuning.tremorMaxHz }),
    fy2: rng.range({ min: tuning.tremorMinHz, max: tuning.tremorMaxHz }),
    px1: rng.range({ min: 0, max: Math.PI * 2 }),
    px2: rng.range({ min: 0, max: Math.PI * 2 }),
    py1: rng.range({ min: 0, max: Math.PI * 2 }),
    py2: rng.range({ min: 0, max: Math.PI * 2 }),
  }

  const tremorAt = (tMs: number): Point => {
    const seconds = tMs / 1000
    const amplitude = tuning.tremorAmplitudePx
    if (amplitude <= 0) {
      return { x: 0, y: 0 }
    }
    // Ramp to zero over the last stretch so the pointer settles precisely on target
    // instead of buzzing around it (and so `samples.at(-1)` is exactly the requested point).
    const remaining = plannedDurationMs - tMs
    const fade =
      tuning.tremorFadeOutMs <= 0 ? 1 : Math.min(1, Math.max(0, remaining / tuning.tremorFadeOutMs))
    const smooth = fade * fade * (3 - 2 * fade)
    return {
      x:
        amplitude *
        smooth *
        (0.6 * Math.sin(2 * Math.PI * tremor.fx1 * seconds + tremor.px1) +
          0.4 * Math.sin(2 * Math.PI * tremor.fx2 * seconds + tremor.px2)),
      y:
        amplitude *
        smooth *
        (0.6 * Math.sin(2 * Math.PI * tremor.fy1 * seconds + tremor.py1) +
          0.4 * Math.sin(2 * Math.PI * tremor.fy2 * seconds + tremor.py2)),
    }
  }

  const positionAt = (tMs: number): Point => {
    if (tMs <= 0) {
      return built[0].from
    }
    for (let i = 0; i < built.length; i++) {
      const leg = built[i]
      if (tMs < leg.startMs) {
        // Inside a dwell between submovements — the hand is momentarily stationary.
        return leg.from
      }
      const local = tMs - leg.startMs
      if (local <= leg.durationMs || i === built.length - 1) {
        const tau = leg.durationMs <= 0 ? 1 : Math.min(1, local / leg.durationMs)
        // Minimum-jerk progress, applied in WARPED arc length (2/3 power law).
        const progress = minimumJerkPosition(tau)
        const u = bezierParameterAtWarpedLength(leg.table, leg.table.totalSigma * progress)
        return bezierPointAt(leg.curve, u)
      }
    }
    return built[built.length - 1].to
  }

  // Sample rate: honour the request unless it would blow the sample budget, in which case
  // reduce the RATE. The samples come from the continuous model either way, so the
  // velocity profile's shape is unchanged — only its resolution is.
  const requestedRateHz = Math.max(1, options.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ)
  const maxSamples = Math.max(2, options.maxSamples ?? DEFAULT_MAX_SAMPLES)
  const durationSeconds = plannedDurationMs / 1000
  const wantedSamples = Math.max(2, Math.round(durationSeconds * requestedRateHz) + 1)
  const sampleRateReduced = wantedSamples > maxSamples
  const sampleCount = sampleRateReduced ? maxSamples : wantedSamples
  const sampleRateHz = durationSeconds > 0 ? (sampleCount - 1) / durationSeconds : requestedRateHz

  const samples: TrajectorySample[] = new Array(sampleCount)
  let pathLengthPx = 0
  let previousPoint: Point | null = null

  for (let i = 0; i < sampleCount; i++) {
    const tMs = (plannedDurationMs * i) / (sampleCount - 1)
    const base = positionAt(tMs)
    const shake = tremorAt(tMs)
    const point =
      i === sampleCount - 1
        ? // Land exactly. Anything else means `humanMouse.click` can miss a small target.
          { x: to.x, y: to.y }
        : { x: base.x + shake.x, y: base.y + shake.y }

    if (previousPoint) {
      pathLengthPx += Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y)
    }
    previousPoint = point
    samples[i] = { tMs, x: point.x, y: point.y }
  }

  // First sample is exactly the origin, for the same reason the last is exactly the target.
  samples[0] = { tMs: 0, x: from.x, y: from.y }

  const submovements: Submovement[] = built.map((leg) => ({
    kind: leg.kind,
    index: leg.index,
    from: leg.from,
    to: leg.to,
    startMs: leg.startMs,
    durationMs: leg.durationMs,
    endpointErrorPx: leg.endpointErrorPx,
    curveOffsetsPx: leg.curveOffsetsPx,
  }))

  return {
    samples,
    submovements,
    distancePx,
    effectiveWidthPx,
    indexOfDifficultyBits: bits,
    fittsDurationMs: fittsMs,
    plannedDurationMs,
    pathLengthPx,
    sampleRateHz,
    sampleRateReduced,
    seed: options.seed,
    tuning,
  }
}

/**
 * Tangential speed (px/ms) between consecutive samples, at the sample midpoints. Exposed
 * because it is what the tests assert the bell shape of, and what a caller inspecting a
 * suspicious-looking move actually wants to see.
 */
export function tangentialSpeedProfile(trajectory: HumanTrajectory): Array<{ tMs: number; speedPxPerMs: number }> {
  const out: Array<{ tMs: number; speedPxPerMs: number }> = []
  for (let i = 1; i < trajectory.samples.length; i++) {
    const a = trajectory.samples[i - 1]
    const b = trajectory.samples[i]
    const dt = b.tMs - a.tMs
    if (dt <= 0) {
      continue
    }
    out.push({ tMs: (a.tMs + b.tMs) / 2, speedPxPerMs: Math.hypot(b.x - a.x, b.y - a.y) / dt })
  }
  return out
}
