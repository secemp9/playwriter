/**
 * The visual oracle: what the burned-in overlay looks like, on pages chosen to break it.
 *
 * Every scene here is a real Chromium render, encoded through the real `encodeFrames`, and
 * every scene is encoded FOUR times from those same frames — page alone, page + captions,
 * page + chips, page + both — so each layer's pixels are known by difference rather than
 * guessed at by position or brightness. See `video-invariants.ts` for why that matters.
 *
 * The suite is arranged in two halves and the second half is the one that makes the first
 * half mean anything:
 *
 *   - `describe('scenes')` asserts the invariants hold on eight pages at two frame heights;
 *   - `describe('a deliberately broken render')` breaks each invariant ON PURPOSE and shows
 *     it going red, then shows the shipped renderer passing the same check on the same
 *     page. `splitBands` shipped because it was green from the day it was written and
 *     nobody ever made it fail.
 *
 * GOLDEN REFERENCES live in `test/video-golden/`. Regenerate them with
 *
 *     UPDATE_VIDEO_GOLDEN=1 pnpm exec vitest run src/cdp-screencast-visual.test.ts
 *
 * and LOOK at the PNGs before committing them. A missing reference is a failure, never a
 * pass — see `compareGoldenFrame`.
 *
 * THE "Clickkout" CLASS — overlay text landing beside page text so the composite reads as a
 * word that is in NEITHER layer — is covered here for BOTH layers, by two different rules.
 *
 * For the CAPTION it is now a question about REGIONS: the caption is drawn in a strip
 * appended below the page, so `mergeShieldFindings` asserts simply that no caption ink falls
 * inside the page region. No shared scanline, no adjacency, no merge, whatever the page says.
 * The break test below patches the shipped ASS so the caption is measured against the page
 * instead of the strip — which is exactly the geometry that shipped — and watches it go red
 * on `dense-12px` at 480x320.
 *
 * The CHIPS cannot use that rule, because they deliberately stay on the page — see
 * `chipStripMetrics` — so `chipMergeShieldFindings` asserts a weaker three-part one: the
 * plate is opaque, it runs to the frame edge it is anchored to, and it clears the ink by a
 * MEASURED distance inboard. Two proofs and a number; `chipStripMetrics` says how the number
 * was measured and where it stops being a proof. Its break test reverts the strip to the
 * geometry that shipped — margins on both sides, 2px of padding, a 0.65 box — and watches
 * both halves go red.
 *
 * Neither shield replaces looking, and looking has its own harness:
 *
 *     pnpm exec vite-node scripts/render-visual-frames.ts
 *
 * which renders this same scene/size matrix (shared via `video-scenes.ts`, so the two can
 * never drift) through the shipped encoder and writes the meaningful frames to
 * `tmp/visual-frames/`. Its header carries the per-frame checklist. Run it and open every
 * PNG after any change to how the overlay is drawn — a green suite here is not a substitute.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildCues,
  buildEncodeArgs,
  buildInputChips,
  captionStripMetrics,
  chipStripMetrics,
  defaultOutlineWidth,
  encodeFrames,
  formatAss,
  renderedCaptionLines,
  resolveCaptionColors,
  type CaptionOptions,
  type CaptionStripMetrics,
  type InputOverlayOptions,
  type StampedCaption,
  type StampedInput,
} from './cdp-screencast.js'
import {
  chipMergeShieldFindings,
  compareGoldenFrame,
  contrastFindings,
  counterFindings,
  describeFindings,
  disjointFindings,
  edgeClipFindings,
  goldenUpdateRequested,
  mergeShieldFindings,
  occlusionFindings,
  singleRowFindings,
  subordinateFindings,
  type Finding,
} from './video-invariants.js'
import {
  CAPTION_TEXT,
  SCENE_FPS,
  SCENE_FRAME_INTERVAL_MS,
  VISUAL_SCENES,
  captionStamp,
  captureSceneFrames,
  chipEvents,
  inputStamp,
  sizesForScene,
  type Scene,
} from './video-scenes.js'
import { OVERLAY_MASK_THRESHOLD, colorMask, maskBBox, maskUnion, openVideo, overlayMask, type DecodedVideo } from './video-probe.js'
import { getChromium } from './playwright-import.js'
import type { Browser } from '@xmorse/playwright-core'

const GOLDEN_DIR = path.resolve(import.meta.dirname, '..', 'test', 'video-golden')

let tmpRoot: string
let browser: Browser

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-visual-test-'))
  fs.mkdirSync(GOLDEN_DIR, { recursive: true })
  browser = await (await getChromium()).launch({ headless: true })
}, 180000)

afterAll(async (suite) => {
  await browser?.close()
  // Every failure message here names a PNG and tells you to look at it — that affordance is
  // what found all four visual defects this codebase has shipped. Deleting the directory on
  // a FAILING run makes those paths dangle, so the one time the evidence matters is the one
  // time it is gone. Measured: after a deliberate break, the exact path the message pointed
  // at did not exist. Keep the whole tree whenever anything failed; PLAYWRITER_KEEP_VISUAL_TMP
  // additionally keeps it on a green run, for looking at output that nobody asserted on.
  const failed = suite.tasks.some((t) => t.result?.state === 'fail')
  if (failed || process.env.PLAYWRITER_KEEP_VISUAL_TMP) {
    console.log(`visual test frames kept at ${tmpRoot}`)
    return
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function run(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (c) => (stderr += c.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

/* ------------------------------------------------------------- the encode rig */

/**
 * The scene/size matrix and the capture rig live in `video-scenes.ts`.
 *
 * Shared, not copied, with `scripts/render-visual-frames.ts` — the harness a human uses to
 * look for the merge class this suite structurally cannot see. Two copies of eight HTML
 * strings would drift, and the moment they drifted the pictures would stop being evidence
 * about the pages these assertions run on.
 */

interface Variants {
  /** The page, encoded exactly as the recorder encodes it, with no dialogue drawn. */
  plate: DecodedVideo
  /** The page with every layer burned in: what a viewer sees. */
  composite: DecodedVideo
  /** The same ASS over a flat plate — exact geometry, see `encodeVariants`. */
  flatPlate: DecodedVideo
  /** The caption GLYPHS alone. */
  captionOnly: DecodedVideo
  /** The chip strip AS DRAWN: the opaque merge plate with its letters on it. */
  chipsOnly: DecodedVideo
  /** The chip GLYPHS alone, with the plate made transparent — see `transparentChipBox`. */
  chipInkOnly: DecodedVideo
  /**
   * The letterbox this scene was encoded with. Every variant shares it, so all six clips
   * are the same shape and the differential is the overlay and nothing else. `pageHeight`
   * is the boundary `mergeShieldFindings` is asked about.
   */
  strip: CaptionStripMetrics
  dumpDir: string
}

/** The two dialogue layers `formatAss` emits, keyed by the Layer field it writes. */
type AssLayer = 'caption' | 'chips'

/**
 * The same ASS with the chip plate made invisible, so the strip's GLYPHS can be measured
 * apart from the plate they sit on.
 *
 * The caption gets that split for free: its band is a separate dialogue on its own layer, so
 * `keep()` can simply drop it. A chip's plate is the BorderStyle-3 box of the same dialogue
 * that draws its letters, and there is no layer to filter on.
 *
 * Splitting it by COLOUR instead was tried and is wrong in a way worth recording, because the
 * failure looked exactly like a real defect: the box's own antialiased boundary is neither the
 * box colour nor the text colour, so "the footprint minus the box colour" classified the
 * plate's outermost column as INK — and the invariant then correctly reported that there was
 * no plate outboard of that "ink". A one-pixel classification error read as a merge.
 *
 * Changing only the ALPHA of OutlineColour and BackColour cannot do that. Every field libass
 * lays out from — Fontsize, BorderStyle, Outline, Alignment, the margins — is untouched, so
 * the glyphs land in exactly the same pixels; the box is simply not painted. Style fields
 * after `Style: Input,` are Fontname(0), Fontsize(1), PrimaryColour(2), SecondaryColour(3),
 * OutlineColour(4), BackColour(5), so four are skipped to reach the pair being cleared.
 */
function transparentChipBox(assText: string): string {
  return assText.replace(/^(Style: Input,(?:[^,]*,){4})[^,]*,[^,]*(,.*)$/m, '$1&HFF000000,&HFF000000$2')
}

/**
 * Encode the scene, and encode the overlay's GEOMETRY separately over a flat plate.
 *
 * The first attempt at this differenced the page-plus-caption encode against the
 * page-alone encode, and it does not work, for two reasons that are both worth recording:
 *
 *   1. **The layout is not the same.** `formatAss` lifts the chip strip by the height of
 *      the caption block, so an encode built with the chips but WITHOUT the cues puts the
 *      strip somewhere the composite never had it. Differencing that against the plate
 *      yields a chip mask for a layout that was never rendered — and it silently passes
 *      disjointness, because the strip it measured was hugging the bottom edge on its own.
 *      Every variant here is therefore derived from ONE `formatAss` output by removing
 *      dialogue lines, so the `[V4+ Styles]` block — and every margin in it — is identical
 *      across all four.
 *
 *   2. **Two lossy encodes of different content diverge outside the overlay.** Adding a
 *      caption changes x264's rate allocation for the whole frame, and on a page with
 *      sharp horizontal edges the residual lands right on those edges: measured, a chip
 *      mask taken this way picked up the underline of a heading 145px wide and 267px away
 *      from any chip. Over a FLAT plate that cannot happen — encoding a constant frame
 *      twice is bit-exact (measured: max delta 0) — so the mask is the overlay and nothing
 *      else.
 *
 * Geometry does not depend on the page: libass positions everything from the ASS and
 * PlayRes alone. So the flat renders give pixel-exact masks for the geometric invariants,
 * and the real composite is kept for the questions that are genuinely about the page —
 * contrast and occlusion.
 */
async function encodeVariants(
  name: string,
  jpegs: Buffer[],
  cues: StampedCaption[],
  events: StampedInput[],
  size: { width: number; height: number },
  captionOptions?: CaptionOptions,
  inputOverlayOptions?: InputOverlayOptions,
): Promise<Variants> {
  const frames = jpegs.map((data, i) => ({ data, offsetMs: i * SCENE_FRAME_INTERVAL_MS }))
  const durationMs = jpegs.length * SCENE_FRAME_INTERVAL_MS
  const frameOffsetsMs = frames.map((f) => f.offsetMs)
  const built = buildCues({ captions: cues, frameOffsetsMs, durationMs, options: captionOptions })
  const chips = buildInputChips({ events, frameOffsetsMs, durationMs, options: inputOverlayOptions, video: size })

  const dumpDir = path.join(tmpRoot, name)
  fs.mkdirSync(dumpDir, { recursive: true })

  // ONE ass file. Every variant is this file with some dialogue lines removed. The two
  // layers are told apart by the Layer field: 0 caption, 1 chips. A line that is not a
  // dialogue at all — the styles, the headers — belongs to every variant.
  const ass = formatAss(
    built.cues,
    size,
    captionOptions,
    chips.segments.length > 0 ? { segments: chips.segments, options: inputOverlayOptions } : undefined,
  )
  const keep = (...layers: AssLayer[]) =>
    ass.text
      .split('\n')
      .filter((line) => {
        if (line.startsWith('Dialogue: 0,')) return layers.includes('caption')
        if (line.startsWith('Dialogue: 1,')) return layers.includes('chips')
        return true
      })
      .join('\n')

  const flat = await flatFrames(size, jpegs.length)
  // The SAME letterbox for every variant, taken from the one `formatAss` call above. If the
  // plate were padded differently from the composite they would not be the same shape and
  // `overlayMask` would refuse to difference them — which is the loud failure. The quiet one
  // it also prevents: a strip sized from a subset of the cues would move the caption.
  const enc = (label: string, src: Buffer[], text: string) => encodeAssText(label, src, text, ass.strip)
  return {
    plate: await enc(`${name}/plate`, jpegs, keep()),
    composite: await enc(`${name}/composite`, jpegs, keep('caption', 'chips')),
    flatPlate: await enc(`${name}/flat-plate`, flat, keep()),
    captionOnly: await enc(`${name}/flat-caption`, flat, keep('caption')),
    chipsOnly: await enc(`${name}/flat-chips`, flat, keep('chips')),
    chipInkOnly: await enc(`${name}/flat-chip-ink`, flat, transparentChipBox(keep('chips'))),
    strip: ass.strip,
    dumpDir,
  }
}

/**
 * The flat plate the geometry is measured against, as JPEG frames.
 *
 * IT USED TO BE MID-GREY AND THAT WAS A LATENT BUG IN THE INSTRUMENT. Mid-grey was chosen
 * because both a white fill and a black outline leave a mark on it, which is true and is
 * still required. What it missed is that the chip is white lettering on a black plate, so
 * EVERY antialiased pixel along a chip glyph's edge is a grey — and one of those greys is
 * the plate colour. Such a pixel differs from the flat plate by nothing and drops out of the
 * differential, leaving a one-pixel hole in the middle of an opaque plate, which the chip
 * merge shield correctly reports as "page visible beside chip ink".
 *
 * MEASURED, on `solid-white-large` — a page with no ink anywhere near the chips — at
 * x=1194, y=683: the chip render reads [96,96,96] against a flat plate of [128,128,128], a
 * delta of exactly 32 against a threshold of 32. Its neighbours read 115, 123, 128 and 40.
 * A single antialias pixel, reported as a merge on four separate scenes at 1280x720.
 *
 * THE FIX IS TO GET THE INSTRUMENT OFF THE LINE IT IS MEASURING. Every blend of white and
 * black is a neutral grey, so any grey plate can be hit by one; a saturated colour cannot
 * be, because it is not on that line at all. For a plate `c` the closest grey is at the
 * midpoint of its extreme channels, so the guaranteed separation is
 * `(max(c) - min(c)) / 2` — here `(192 - 48) / 2 = 72`, comfortably above the 32 threshold
 * and above the 36 of real codec bleed measured elsewhere in this suite.
 *
 * It still satisfies the original requirement, and by a wide margin: 207 from white and 192
 * from black, so both the fill and the outline leave a mark.
 */
const FLAT_PLATE_COLOR = '0x3070C0'
const flatCache = new Map<string, Buffer[]>()
async function flatFrames(size: { width: number; height: number }, count: number): Promise<Buffer[]> {
  const key = `${size.width}x${size.height}`
  if (!flatCache.has(key)) {
    const f = path.join(tmpRoot, `flat-${key}.jpg`)
    const r = await run('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${FLAT_PLATE_COLOR}:s=${key}`, '-frames:v', '1', '-q:v', '2', f,
    ])
    if (r.code !== 0) throw new Error(r.stderr)
    flatCache.set(key, [fs.readFileSync(f)])
  }
  const one = flatCache.get(key)![0]
  return Array.from({ length: count }, () => one)
}

/**
 * Encode one hand-written ASS file over the same frames.
 *
 * Only for the deliberate-break demonstrations, and deliberately routed through the real
 * `buildEncodeArgs` so that "broken" means one style field changed and nothing else. This
 * is how a regression that has already been FIXED can still be shown to be caught.
 */
async function encodeAssText(
  name: string,
  jpegs: Buffer[],
  assText: string,
  /**
   * The letterbox to pad with. It must be the SAME for every variant of one scene, or the
   * clips come out different shapes and the differential is meaningless — so it is threaded
   * explicitly rather than recomputed, and it comes from the single `formatAss` call whose
   * output these variants are filtered copies of.
   */
  strip?: CaptionStripMetrics,
): Promise<DecodedVideo> {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  const lines: string[] = []
  jpegs.forEach((data, i) => {
    const f = path.join(dir, `f${String(i).padStart(6, '0')}.jpg`)
    fs.writeFileSync(f, data)
    lines.push(`file '${f}'`, `duration ${(SCENE_FRAME_INTERVAL_MS / 1000).toFixed(3)}`)
  })
  lines.push(`file '${path.join(dir, `f${String(jpegs.length - 1).padStart(6, '0')}.jpg`)}'`)
  const listFile = path.join(dir, 'frames.txt')
  fs.writeFileSync(listFile, lines.join('\n'))
  const assPath = path.join(dir, 'patched.ass')
  fs.writeFileSync(assPath, assText, 'utf8')
  const out = path.join(dir, 'patched.mp4')
  const r = await run('ffmpeg', [
    '-v', 'error',
    ...buildEncodeArgs({ listFile, outputPath: out, fps: SCENE_FPS, burnAssPath: assPath, strip }),
  ])
  if (r.code !== 0) throw new Error(r.stderr)
  return openVideo(out)
}

/** Every frame's overlay mask for one variant, so an invariant can sweep the whole clip. */
function masksForEveryFrame(overlay: DecodedVideo, plate: DecodedVideo): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let f = 0; f < overlay.frameCount; f++) out.push(overlayMask(overlay, plate, f))
  return out
}

/** The frame in the middle of the window where both layers are up. */
function busiestFrame(masks: Uint8Array[]): number {
  let best = 0
  let bestArea = -1
  masks.forEach((m, i) => {
    let a = 0
    for (let p = 0; p < m.length; p++) a += m[p]
    if (a > bestArea) {
      bestArea = a
      best = i
    }
  })
  return best
}

/**
 * The caption style `formatAss` will resolve for a PAGE of this height, at the defaults.
 *
 * The page, not the encoded frame — `captionStripMetrics` derives the face from the page so
 * the strip cannot feed its own input, and this has to ask the same question the same way.
 *
 * The colours come from `resolveCaptionColors` rather than from literals here, because
 * `outlineColor` now DEFAULTS to `stripColor`: a hardcoded '#000000' would hand
 * `counterFindings` a black outline the renderer never draws, and it would measure the
 * counters of a style nobody ships.
 */
function styleOf(pageHeight: number, options?: CaptionOptions) {
  const m = captionStripMetrics({ width: 640, height: pageHeight }, 0, options)
  return {
    fontName: options?.fontName ?? 'DejaVu Sans',
    fontSize: m.fontSize,
    outline: m.outline,
    shadow: m.shadow,
    textColor: m.textColor,
    outlineColor: m.outlineColor,
  }
}

/* ------------------------------------------------------------------ the scenes */

describe('scenes: the invariants hold on eight pages at two frame heights', () => {
  for (const scene of VISUAL_SCENES) {
    for (const size of sizesForScene(scene)) {
      const id = `${scene.name}-${size.label}`

      it(`${id} (${size.width}x${size.height})`, async () => {
        const jpegs = await captureSceneFrames(browser, scene, size.width, size.height, 10)
        const v = await encodeVariants(
          id,
          jpegs,
          [captionStamp(CAPTION_TEXT, 400)],
          chipEvents(),
          { width: size.width, height: size.height },
        )

        const captionMasks = masksForEveryFrame(v.captionOnly, v.flatPlate)
        const chipMasks = masksForEveryFrame(v.chipsOnly, v.flatPlate)
        // The chip GLYPHS, without the plate they sit on — the chip half of the same split
        // `keep()` already gives the caption for free.
        const chipInk = masksForEveryFrame(v.chipInkOnly, v.flatPlate)
        const overlayMasks = captionMasks.map((m, i) => maskUnion(m, chipMasks[i]))
        const frame = busiestFrame(overlayMasks)

        // The letterbox is real and the page is the top of it. Asserted before anything else
        // reads a mask, because every invariant below is stated against this boundary and a
        // frame that was not actually padded would make all of them vacuous.
        expect(v.strip.height, `${id}: a captioned clip must have a strip`).toBeGreaterThan(0)
        expect(v.composite.height, `${id}: the frame is the page plus the strip`).toBe(v.strip.videoHeight)
        expect(v.strip.pageHeight, `${id}: the page area is the captured frame`).toBe(size.height)
        expect(v.composite.height % 2, `${id}: yuv420p needs an even height`).toBe(0)
        expect(v.composite.width % 2, `${id}: yuv420p needs an even width`).toBe(0)

        const findings: Finding[] = []

        // 1. The two layers never share a pixel, in ANY frame.
        findings.push(...(await disjointFindings(captionMasks, chipMasks, v.composite, v.dumpDir)))

        // 2. Nothing is clipped at a frame edge. Asked of the caption's glyphs, and of the
        //    chip's GLYPHS rather than its footprint: the chip plate reaches its anchored
        //    edge deliberately, which is the entire point of invariant 9, so asking this of
        //    the footprint would be asserting against the fix. The caption has no such
        //    exemption any more — the band that used to reach both side edges is gone, so
        //    its ink and its footprint are the same thing.
        findings.push(...(await edgeClipFindings(captionMasks, v.composite, v.dumpDir, 'caption')))
        findings.push(...(await edgeClipFindings(chipInk, v.composite, v.dumpDir, 'chip strip')))

        // 3. A chip row is one line.
        const chipFace = Math.max(10, Math.round((size.height * 2.4) / 100))
        findings.push(...(await singleRowFindings(chipMasks, v.composite, v.dumpDir, chipFace + 2 * Math.max(2, Math.round(chipFace / 6)))))

        // 4. Glyph ink has local contrast against what is immediately behind it.
        //    The FILL, not the whole footprint: the footprint includes the outline, and
        //    averaging fill and outline together produces a mean that matches neither.
        //    Read at the RESOLVED text colour, which is now black on a light strip.
        const captionFill = colorMask(v.composite, frame, captionMasks[frame], resolveCaptionColors().text)
        findings.push(...(await contrastFindings(v.composite, frame, captionFill, v.dumpDir, 'caption')))

        // 5. Counters survive: the smudge class, measured topologically on the resolved style.
        findings.push(...(await counterFindings(styleOf(size.height), v.dumpDir)))

        /**
         * 6. The chips stay subordinate to the caption — LETTERING against LETTERING.
         *
         * It used to compare the chip's whole footprint, plate included, against the
         * caption's. That worked only while the caption's footprint was inflated by a black
         * outline drawn over the page; with the strip the outline is the strip's own colour
         * and draws nothing, so the caption's footprint IS its ink and the comparison became
         * a chip's opaque plate against a caption's bare glyphs. MEASURED at 480x320 with a
         * one-word cue, that reads 1.00 for the shipped renderer — the plate padding alone
         * putting it at the limit, while the chip's letters are visibly smaller.
         *
         * Comparing the chip's INK instead measures what the invariant's own message claims:
         * the chip face is 2.4% of the page height against the caption's 5%. The plate's
         * padding is chrome that exists for the merge guarantee, not lettering.
         *
         * The band is MEASURED and wider than the one it replaces. Chip ink over caption ink:
         *
         *     one-word cue @480x320   0.64      dense-12px @480x320    0.23
         *     solid-dark  @480x320    0.23      solid-dark @1280x720   0.18
         *     portrait    @390x844    0.08      a 9% chip face         1.79
         *
         * 0.9 sits 1.4x above the worst the defaults produce and 2x below the break — against
         * the old pairing, where the worst default was already 1.00 and the break 2.79.
         */
        findings.push(...subordinateFindings(captionMasks[frame], chipInk[frame], v.composite, frame, 0.9))

        // 7. The overlay does not cover what the action changed. The caption cannot fail this
        //    any more — it is not on the page — so what this now guards is the chips, which
        //    still are. That is a genuine narrowing and not a loss: the case it used to catch
        //    for the caption was the band burying the subject, and there is no band.
        if (scene.actionFrames?.length) {
          findings.push(...(await occlusionFindings(v.plate, v.composite, overlayMasks, scene.actionFrames, v.dumpDir)))
        }

        // 8. The merge shield: no caption ink anywhere in the page region, so no page glyph
        //    can share a scanline with a caption glyph and fabricate a third word. This is
        //    the "Clickkout" class, and the strip is what turns it from a question about
        //    words into a question about two disjoint regions.
        findings.push(...(await mergeShieldFindings(captionMasks, v.composite, v.dumpDir, v.strip.pageHeight)))

        /**
         * 8b. The other half of the same change, and the one the merge shield does NOT say.
         *
         * The merge shield reads the FLAT differential, so it proves where libass put the
         * caption. It cannot see the page at all. This reads the REAL composite against the
         * REAL plate, on every frame, and asserts that inside the page region nothing changed
         * except under the chips — which is the actual claim being made about this renderer:
         * the page area of every frame is the pixels the page showed.
         *
         * Bounded by the chip bounding box rather than by the chip mask, because x264 rings a
         * couple of pixels around a hard-edged plate and that ringing is the codec, not the
         * page being altered. A whole-page change — a dim, a rescale, a one-pixel shift from
         * padding in the wrong order — lands far outside that box and cannot hide in it.
         *
         * IT IS TWO BOUNDS, BOTH MEASURED, BECAUSE ONE CANNOT DO THE JOB. The composite and
         * the plate are two separate LOSSY encodes of the same page, so they differ slightly
         * even where nothing was drawn: adding a subtitle changes x264's rate allocation and
         * the residual lands on the page's own high-contrast edges. That noise is irreducible
         * — there is no way to ask "is the page byte-identical" through two h264 encodes — so
         * the question has to be asked as "is anything here louder than the codec".
         *
         * Swept over the whole page region of every frame of all 15 scene/size combinations:
         *
         *     checkout-top-left @480x320   worst delta 58   worst frame 0.2998% over 32
         *     checkout-top-left @1280x720  worst delta 58   worst frame 0.1369% over 32
         *     dense-12px @480x320          worst delta 36   worst frame 0.0013% over 32
         *     edge-hugging @480x320        worst delta 35   worst frame 0.0013% over 32
         *     every other combination      worst delta 1-15 worst frame 0.0000% over 32
         *
         * `checkout-top-left` is the outlier because it is the only scene with a large
         * saturated block — a dark-blue header carrying white text — and those edges are
         * where x264 puts its residual. Nothing anywhere in the matrix reaches 64.
         *
         *   - the MAX bound catches anything DRAWN on the page. A caption glyph is black on
         *     whatever the page is; on this matrix that is a delta of 200-255, four times the
         *     bound. This is the bound that goes red if the strip is ever composited instead
         *     of appended.
         *   - the FRACTION bound catches anything done to the page AS A WHOLE — a dim, a
         *     rescale, a one-pixel shift from padding in the wrong order — which need not
         *     move any single pixel far but must move a great many. 1% is triple the worst
         *     observed 0.2998%, and a whole-page operation moves tens of percent.
         */
        const PAGE_MAX_DELTA = 64
        const PAGE_MAX_DIFFERING_FRACTION = 0.01
        for (let f = 0; f < v.composite.frameCount; f++) {
          const chipBox = maskBBox(chipMasks[Math.min(f, chipMasks.length - 1)], v.composite.width, v.composite.height)
          let loud = 0
          let noisy = 0
          let considered = 0
          let worst = 0
          let worstAt = ''
          for (let y = 0; y < v.strip.pageHeight; y++) {
            for (let x = 0; x < v.composite.width; x++) {
              if (chipBox && x >= chipBox.x0 - 2 && x <= chipBox.x1 + 2 && y >= chipBox.y0 - 2 && y <= chipBox.y1 + 2) continue
              considered++
              const o = f * v.composite.frameBytes + (y * v.composite.width + x) * 3
              const d = Math.max(
                Math.abs(v.composite.rgb[o] - v.plate.rgb[o]),
                Math.abs(v.composite.rgb[o + 1] - v.plate.rgb[o + 1]),
                Math.abs(v.composite.rgb[o + 2] - v.plate.rgb[o + 2]),
              )
              if (d > worst) {
                worst = d
                worstAt = `(${x}, ${y})`
              }
              if (d > OVERLAY_MASK_THRESHOLD) noisy++
              if (d > PAGE_MAX_DELTA) loud++
            }
          }
          const where = `${id}: frame ${f}, worst delta ${worst} at ${worstAt}`
          expect(
            loud,
            `${where} — ${loud} page pixel(s) outside the chip plate differ by more than ${PAGE_MAX_DELTA}/255. ` +
              'Something is being DRAWN on the page; the caption belongs in the strip appended below it.',
          ).toBe(0)
          expect(
            noisy / considered,
            `${where} — ${((noisy / considered) * 100).toFixed(4)}% of page pixels differ at all. Codec residual is ` +
              'measured under 0.3%; this much means the page as a whole was altered.',
          ).toBeLessThan(PAGE_MAX_DIFFERING_FRACTION)
        }

        // 9. The chip merge shield, which is the same class under a weaker rule because the
        //    chips deliberately stay on the page. The plate is opaque, it reaches the frame
        //    edge it is anchored to, and it clears the ink by the measured merge distance
        //    inboard. The required distance comes from the shipped metrics rather than from a
        //    number retyped here, so the assertion cannot drift away from what is drawn — and
        //    it is still a real check, because what it is verifying is that libass actually
        //    delivered the geometry the hard spaces asked for.
        const chip = chipStripMetrics(size)
        expect(chip.clearPx, `${id}: the plate must claim at least the measured merge distance`).toBeGreaterThanOrEqual(
          chip.requiredClearPx,
        )
        findings.push(
          ...(await chipMergeShieldFindings(chipInk, chipMasks, v.composite, v.dumpDir, {
            requiredClearPx: chip.requiredClearPx,
            boxColor: [0, 0, 0],
          })),
        )

        expect(describeFindings(findings), `${id}\n${describeFindings(findings)}`).toBe('')
      }, 180000)
    }
  }
})

/* ------------------------------------------------------------ golden frames */

describe('golden frames', () => {
  // Only the small height, and only the scenes whose reference PNG stays small: the point
  // of a golden is that a human reviews the diff, and a 1280x720 reference of a dense text
  // wall is neither reviewable nor worth its bytes. The invariants above cover every scene
  // at both heights; these pin the exact appearance of the styling.
  for (const name of ['solid-white', 'solid-dark', 'mid-grey', 'checkout-top-left']) {
    it(`${name} matches its committed reference`, async () => {
      const scene = VISUAL_SCENES.find((s) => s.name === name)!
      const size = { width: 480, height: 320 }
      const jpegs = await captureSceneFrames(browser, scene, size.width, size.height, 8)
      const v = await encodeVariants(`golden-${name}`, jpegs, [captionStamp(CAPTION_TEXT, 400)], chipEvents(), size)
      // A frame with BOTH layers up: a golden that pinned a caption-only frame would not
      // notice the chip strip moving.
      const capM = masksForEveryFrame(v.captionOnly, v.flatPlate)
      const chipM = masksForEveryFrame(v.chipsOnly, v.flatPlate)
      const frame = busiestFrame(capM.map((m, i) => maskUnion(m, chipM[i])))
      const result = await compareGoldenFrame(v.composite, frame, path.join(GOLDEN_DIR, `${name}.png`), v.dumpDir)
      expect(result.message ?? '', result.message ?? '').toBe('')
      expect(result.ok).toBe(true)
    }, 180000)
  }

  it('FAILS rather than passes when the reference is missing', async () => {
    const size = { width: 480, height: 320 }
    const jpegs = await captureSceneFrames(browser, VISUAL_SCENES[1], size.width, size.height, 4)
    const v = await encodeVariants('golden-absent', jpegs, [captionStamp('anything', 0)], [], size)
    const absent = path.join(tmpRoot, 'no-such-reference.png')
    expect(fs.existsSync(absent)).toBe(false)
    const result = await compareGoldenFrame(v.composite, 0, absent, v.dumpDir)
    // The single most important property of this harness: an empty fixtures directory
    // must not turn every golden test green at once.
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/does not exist. This is a FAILURE and not a pass/)
    expect(result.message).toMatch(/UPDATE_VIDEO_GOLDEN=1/)
  }, 180000)
})

/* ------------------------------------------- proving each invariant can fail */

describe('a deliberately broken render: every invariant is shown to go red', () => {
  const size = { width: 480, height: 320 }

  it('counters: an outline at 1/8 of the font size closes them, and the check says so', async () => {
    const dir = path.join(tmpRoot, 'break-counters')
    fs.mkdirSync(dir, { recursive: true })
    const fontSize = Math.max(16, Math.round((size.height * 5) / 100))
    expect(fontSize).toBe(16)

    // BROKEN: outline 2 at fontSize 16 is a ratio of 1/8, which is EXACTLY what
    // `Math.max(2, round(fontSize / 16))` produced on any frame 320px tall or shorter.
    // Measured counter survival at that ratio is 0%.
    const brokenFindings = await counterFindings(styleOf(size.height, { outlineWidth: 2 }), dir)
    expect(brokenFindings.length, 'a 1/8 outline must be reported as a smudge').toBeGreaterThan(0)
    expect(brokenFindings[0].message).toMatch(/reads as a smudge/)
    expect(brokenFindings[0].pngPath).toBeTruthy()

    // RESTORED: the shipped default at this size is 1/16, where the measurement says the
    // worst counter keeps 17% of its area.
    expect(defaultOutlineWidth(fontSize)).toBe(1)
    expect(await counterFindings(styleOf(size.height), dir)).toEqual([])

    // And the whole reason the floor was the bug: the old rule is above 1/16 for every
    // caption face below 32px, which is every frame below 640px tall.
    for (const fs2 of [16, 20, 24, 28]) {
      expect(Math.max(2, Math.round(fs2 / 16)) / fs2, `old rule at fontSize ${fs2}`).toBeGreaterThan(1 / 16)
      expect(defaultOutlineWidth(fs2) / fs2, `new rule at fontSize ${fs2}`).toBeLessThanOrEqual(1 / 16)
    }
  }, 180000)

  it('contrast: text with hue but no lightness separation from its strip is caught per glyph', async () => {
    const jpegs = await captureSceneFrames(browser, VISUAL_SCENES[0], size.width, size.height, 4) // solid white
    /**
     * The FILL, not the whole footprint — which is what `contrastFindings` documents and
     * what the scene loop above has always passed it. Passing the raw footprint used to
     * work by accident when the page behind the caption was white and the outline black;
     * it stopped working the moment the caption got a controlled background, because the
     * footprint's mean is a blend of fill and outline and matches neither.
     *
     * WHAT THIS BREAKS IS NOW A DIFFERENT THING, and it has to be, because the defect the
     * old version staged cannot happen any more. It used to be "a near-white outline on a
     * white page", i.e. the outline failing at its job of separating white text from an
     * arbitrary page. There is no arbitrary page behind the caption now — there is the
     * strip — so the way to make a caption unreadable is to put it a shade off ITS OWN
     * STRIP. That is the live failure mode, and it is the one a caller can actually reach
     * by setting `textColor` without thinking about `stripColor`.
     *
     * THE BROKEN COLOUR IS A TINT, NOT A GREY, and that is forced by the instrument rather
     * than chosen for flavour. Three constants have to be threaded at once:
     *
     *     > 24   `MIN_COLOR_SEPARATION`, or `validateVisualOptions` throws and nothing renders
     *     > 32   `OVERLAY_MASK_THRESHOLD`, or the clean-plate differential cannot SEE the
     *            caption, the glyph mask comes back empty, and the check passes VACUOUSLY
     *            with zero glyphs to judge
     *     < 40   `MIN_GLYPH_CONTRAST`, which is a LUMA distance — or the caption is legible
     *            and there is nothing to catch
     *
     * The first two are per-channel distances and the third is a luma distance, so no grey
     * can satisfy all three with any margin: for a grey the two distances are the same
     * number, leaving a window of 32 to 40. `#C8C8C8` at 32 rendered an empty mask; `#C4C4C4`
     * at 36 rendered strokes so thin after antialiasing that no component reached the 12px
     * floor `contrastFindings` applies. Both passed by measuring nothing.
     *
     * `#E8B4E8` on the `#E8E8E8` default strip separates the two: 52 per channel, so the
     * mask sees solid glyph cores, but luma 201 against the strip's 232 — a difference of 31,
     * under the floor. It is also the realistic version of this mistake, and the reason the
     * floor is expressed in luma at all: a pastel tint that differs plenty in HUE and barely
     * at all in LIGHTNESS is the classic unreadable-text bug, and it is invisible to every
     * check that compares colours channel by channel.
     */
    const fillOf = (v: Variants, frame: number, hex: string) =>
      colorMask(v.composite, frame, overlayMask(v.captionOnly, v.flatPlate, frame), hex)

    // BROKEN: a tint that differs from the strip in hue but not in lightness. Encodes
    // cleanly, caption is on screen, and there is simply nothing to read.
    const broken = await encodeVariants('break-contrast', jpegs, [captionStamp(CAPTION_TEXT, 0)], [], size, {
      textColor: '#E8B4E8',
    })
    const brokenFindings = await contrastFindings(broken.composite, 2, fillOf(broken, 2, '#E8B4E8'), broken.dumpDir, 'caption')
    expect(brokenFindings.length, 'text with no luma separation from its own strip must fail contrast').toBeGreaterThan(0)
    expect(brokenFindings[0].pngPath).toBeTruthy()

    // RESTORED: the default black on the default strip, same page.
    const fixed = await encodeVariants('break-contrast-fixed', jpegs, [captionStamp(CAPTION_TEXT, 0)], [], size)
    expect(
      await contrastFindings(fixed.composite, 2, fillOf(fixed, 2, resolveCaptionColors().text), fixed.dumpDir, 'caption'),
    ).toEqual([])
  }, 180000)

  it('single row: a label of Ws beats CHIP_CHAR_WIDTH_RATIO and libass wraps the strip', async () => {
    const jpegs = await captureSceneFrames(browser, VISUAL_SCENES[1], size.width, size.height, 4)
    // BROKEN, and broken for a MEASURED reason: the row budget assumes 0.58 of the font
    // size per character, and a 'W' measures 0.846. At 480x320 the chip face is 10px and
    // the budget is 79 characters, but 79 Ws are 668px across a usable 460px — so a row
    // that the budget calls acceptable overflows the frame and libass wraps it.
    // Spaces matter: WrapStyle 0 cannot break inside a word, so an unbroken run of Ws
    // overflows the frame instead of wrapping — which is the EDGE CLIP invariant, not this
    // one. Groups of four keep it wrappable while staying just as wide.
    const wideLabel = Array.from({ length: 14 }, () => 'WWWW').join(' ')
    const opts: InputOverlayOptions = { maxLabelChars: 80, maxVisible: 1 }
    const broken = await encodeVariants('break-row', jpegs, [], [inputStamp(wideLabel, 0)], size, undefined, opts)
    const chipFace = Math.max(10, Math.round((size.height * 2.4) / 100))
    const lineH = chipFace + 2 * Math.max(2, Math.round(chipFace / 6))
    const brokenMasks = masksForEveryFrame(broken.chipsOnly, broken.flatPlate)
    const brokenFindings = await singleRowFindings(brokenMasks, broken.composite, broken.dumpDir, lineH)
    expect(brokenFindings.length, 'an over-wide row must be reported as more than one line').toBeGreaterThan(0)
    expect(brokenFindings[0].message).toMatch(/libass wrapped/)

    // RESTORED: an ordinary chip vocabulary, whose measured advance is 0.41-0.46.
    const fixed = await encodeVariants('break-row-fixed', jpegs, [], chipEvents(), size)
    const fixedMasks = masksForEveryFrame(fixed.chipsOnly, fixed.flatPlate)
    expect(await singleRowFindings(fixedMasks, fixed.composite, fixed.dumpDir, lineH)).toEqual([])
  }, 180000)

  it('subordinate: a chip face larger than the caption face is caught', async () => {
    const jpegs = await captureSceneFrames(browser, VISUAL_SCENES[1], size.width, size.height, 4)
    // Chip INK against caption ink, matching the scene loop — see invariant 6 there for the
    // measurements that set the 0.9 limit and for why the chip's plate is not the subject.
    const broken = await encodeVariants('break-subordinate', jpegs, [captionStamp('caption', 0)], [inputStamp('chip', 0)], size, undefined, {
      fontSizePct: 9,
    })
    const capM = overlayMask(broken.captionOnly, broken.flatPlate, 2)
    const chipM = overlayMask(broken.chipInkOnly, broken.flatPlate, 2)
    const brokenFindings = subordinateFindings(capM, chipM, broken.composite, 2, 0.9)
    // MEASURED: a 9% chip face reads 1.79 of the caption's ink height against a 0.9 limit.
    expect(brokenFindings.length, 'a 9% chip face against a 5% caption face must be reported').toBeGreaterThan(0)

    const fixed = await encodeVariants('break-subordinate-fixed', jpegs, [captionStamp('caption', 0)], [inputStamp('chip', 0)], size)
    const fCap = overlayMask(fixed.captionOnly, fixed.flatPlate, 2)
    const fChip = overlayMask(fixed.chipInkOnly, fixed.flatPlate, 2)
    // MEASURED: the shipped defaults read 0.64 on this same one-word cue.
    expect(subordinateFindings(fCap, fChip, fixed.composite, 2, 0.9)).toEqual([])
  }, 180000)

  it('edge clip: an unbreakable token wider than the frame runs off both sides', async () => {
    const jpegs = await captureSceneFrames(browser, VISUAL_SCENES[1], size.width, size.height, 4)
    // A single token with no spaces cannot be word-wrapped, so libass draws it off the
    // frame rather than breaking it. `maxCharsPerLine` high enough that OUR wrapper does
    // not break it either, which is the real-world shape of a long URL in a caption.
    const co: CaptionOptions = { maxCharsPerLine: 400, fontSizePct: 9 }
    const broken = await encodeVariants('break-edge', jpegs, [captionStamp('A'.repeat(90), 0)], [], size, co)
    const masks = masksForEveryFrame(broken.captionOnly, broken.flatPlate)
    const brokenFindings = await edgeClipFindings(masks, broken.composite, broken.dumpDir, 'caption')
    expect(brokenFindings.length, 'a caption wider than the frame must be reported as clipped').toBeGreaterThan(0)
    expect(brokenFindings[0].message).toMatch(/reaches the .* edge/)

    const fixed = await encodeVariants('break-edge-fixed', jpegs, [captionStamp(CAPTION_TEXT, 0)], [], size)
    const fixedMasks = masksForEveryFrame(fixed.captionOnly, fixed.flatPlate)
    expect(await edgeClipFindings(fixedMasks, fixed.composite, fixed.dumpDir, 'caption')).toEqual([])
  }, 180000)

  it('occlusion: chips in the corner the action happens in are caught', async () => {
    const scene: Scene = {
      name: 'top-left-action',
      html:
        '<body style="margin:0;background:#ffffff;font-family:DejaVu Sans,sans-serif">' +
        '<div id="t" style="position:absolute;top:4px;left:4px;width:200px;height:40px;background:#ffffff"></div></body>',
      // The subject of the action is a block in the top-left, exactly where a `top-left`
      // strip goes.
      mutate: (i) => (i >= 3 ? 'document.getElementById("t").style.background = "#c02020"' : ''),
    }
    const jpegs = await captureSceneFrames(browser, scene, size.width, size.height, 8)
    const broken = await encodeVariants('break-occlusion', jpegs, [], [inputStamp('Click', 0)], size, undefined, {
      position: 'top-left',
      marginPct: 1,
    })
    const brokenMasks = masksForEveryFrame(broken.chipsOnly, broken.flatPlate)
    const brokenFindings = await occlusionFindings(broken.plate, broken.composite, brokenMasks, [3], broken.dumpDir)
    expect(brokenFindings.length, 'a chip over the region that just changed must be reported').toBeGreaterThan(0)
    expect(brokenFindings[0].pngPath).toBeTruthy()

    // RESTORED: the shipped default corner, on the identical page and the identical action.
    const fixed = await encodeVariants('break-occlusion-fixed', jpegs, [], [inputStamp('Click', 0)], size)
    const fixedMasks = masksForEveryFrame(fixed.chipsOnly, fixed.flatPlate)
    expect(await occlusionFindings(fixed.plate, fixed.composite, fixedMasks, [3], fixed.dumpDir)).toEqual([])
  }, 180000)

  it('disjointness: a chip MarginV that forgets the strip lands in the narration', async () => {
    /**
     * The portrait frame, because that is where the caption block is tallest: our wrapper
     * wraps at 42 CHARACTERS and libass wraps at PIXELS, so at 390x844 a full source line
     * becomes three rendered ones and the strip is three lines deep. A chip that ignores the
     * strip therefore lands squarely in it rather than grazing it.
     */
    const size390 = { width: 390, height: 844 }
    const scene = VISUAL_SCENES.find((s) => s.name === 'portrait')!
    const jpegs = await captureSceneFrames(browser, scene, size390.width, size390.height, 6)
    const co: CaptionOptions = {}
    const cues = [captionStamp(CAPTION_TEXT, 0, co)]
    const probe = captionStripMetrics(size390, 0, co)
    const marginH = Math.max(8, Math.round(size390.width * 0.05))

    // The arithmetic first, so the render is confirming something already known.
    const sourceLines = cues[0].text.split('\n').length
    const drawnLines = renderedCaptionLines(cues[0].text, size390.width - 2 * marginH, probe.fontSize)
    expect(drawnLines).toBeGreaterThan(sourceLines * 2)

    const frames = jpegs.map((data, i) => ({ data, offsetMs: i * SCENE_FRAME_INTERVAL_MS }))
    const durationMs = jpegs.length * SCENE_FRAME_INTERVAL_MS
    const frameOffsetsMs = frames.map((f) => f.offsetMs)
    const built = buildCues({ captions: cues, frameOffsetsMs, durationMs, options: co })
    const chips = buildInputChips({ events: [inputStamp('Click', 0)], frameOffsetsMs, durationMs, video: size390 })
    const shipped = formatAss(built.cues, size390, co, { segments: chips.segments })
    expect(shipped.strip.height).toBeGreaterThan(0)

    /**
     * BROKEN: the Input style's MarginV reverted to the bare chip margin.
     *
     * That is the exact mistake this change can introduce and nothing else would catch:
     * `MarginV` on a bottom alignment measures from the FRAME's bottom edge, and the frame
     * now ends below the strip rather than below the page. Omit `+ strip.height` and the
     * chips are drawn `chipMargin` above the bottom of the STRIP — i.e. on top of the
     * narration — while every other number in the file stays correct.
     */
    const chipMargin = chipStripMetrics(size390).margin
    // Style fields after `Style: Input,` are Fontname(0) .. MarginL(18), MarginR(19),
    // MarginV(20), Encoding(21) — so 20 fields are skipped before the one being reverted.
    const brokenAss = shipped.text.replace(/^(Style: Input,(?:[^,]*,){20})(\d+)(,\d+)$/m, `$1${chipMargin}$3`)
    expect(brokenAss, 'the Input MarginV must actually have been replaced').not.toBe(shipped.text)

    const strip = shipped.strip
    const brokenComposite = await encodeAssText('break-disjoint', jpegs, brokenAss, strip)
    const captionOnlyAss = brokenAss.split('\n').filter((l) => !l.startsWith('Dialogue: 1,')).join('\n')
    const chipsOnlyBrokenAss = brokenAss.split('\n').filter((l) => !l.startsWith('Dialogue: 0,')).join('\n')
    const brokenChipsOnly = await encodeAssText('break-disjoint-chips', jpegs, chipsOnlyBrokenAss, strip)
    const captionOnly = await encodeAssText('break-disjoint-caption', jpegs, captionOnlyAss, strip)

    const plateDir = path.join(tmpRoot, 'break-disjoint-plate')
    fs.mkdirSync(plateDir, { recursive: true })
    const plateAss = brokenAss.split('\n').filter((l) => !l.startsWith('Dialogue: ')).join('\n')
    const plate = await encodeAssText('break-disjoint-plate-clip', jpegs, plateAss, strip)
    void plateDir

    const capMasks = masksForEveryFrame(captionOnly, plate)
    const chipMasks = masksForEveryFrame(brokenChipsOnly, plate)
    const brokenFindings = await disjointFindings(capMasks, chipMasks, brokenComposite, tmpRoot)
    expect(
      brokenFindings.length,
      'a chip MarginV measured from the frame bottom without the strip must land on the caption',
    ).toBeGreaterThan(0)
    expect(brokenFindings[0].message).toMatch(/carry BOTH the caption and a chip/)

    // RESTORED: the shipped offset, same page, same caption, same chip.
    const fixed = await encodeVariants('break-disjoint-fixed', jpegs, cues, [inputStamp('Click', 0)], size390, co)
    const fixedCap = masksForEveryFrame(fixed.captionOnly, fixed.flatPlate)
    const fixedChip = masksForEveryFrame(fixed.chipsOnly, fixed.flatPlate)
    expect(await disjointFindings(fixedCap, fixedChip, fixed.composite, fixed.dumpDir)).toEqual([])
  }, 300000)

  it('merge shield: a caption drawn on the page instead of the strip goes red on dense-12px', async () => {
    const scene = VISUAL_SCENES.find((s) => s.name === 'dense-12px')!
    const jpegs = await captureSceneFrames(browser, scene, size.width, size.height, 6)
    const cues = buildCues({
      captions: [captionStamp(CAPTION_TEXT, 0)],
      frameOffsetsMs: jpegs.map((_, i) => i * SCENE_FRAME_INTERVAL_MS),
      durationMs: jpegs.length * SCENE_FRAME_INTERVAL_MS,
    })
    const shipped = formatAss(cues.cues, size)
    const strip = shipped.strip

    /**
     * BROKEN, and broken the way it SHIPPED rather than in some invented way.
     *
     * The frame is still letterboxed — the pad filter is untouched — but the caption's
     * `MarginV` is raised so the block is drawn where it used to be: over the page, a little
     * above its bottom edge, exactly as it was when the recorder composited captions onto
     * the picture. `marginBottomPct` defaulted to 6% of the frame, so that is the number
     * reinstated here.
     *
     * MEASURED on this exact scene and size back when that was the shipped geometry: the
     * caption's first line ended in `charge`, the page row it crossed resumed with the
     * surviving `s` of `keeps`, there was no gap at all between them at 10x, and the frame
     * read `two charges going past the fold` — a word in NEITHER layer, with both layers
     * individually perfect and every mask-based check green.
     *
     * Style fields after `Style: Default,` are Fontname(0) .. MarginL(18), MarginR(19),
     * MarginV(20), Encoding(21) — so 20 fields are skipped to reach the one being reverted.
     */
    const oldMarginV = Math.max(4, Math.round((strip.videoHeight * 6) / 100)) + strip.height
    const brokenAss = shipped.text.replace(/^(Style: Default,(?:[^,]*,){20})(\d+)(,\d+)$/m, `$1${oldMarginV}$3`)
    expect(brokenAss, 'the Default MarginV must actually have been replaced').not.toBe(shipped.text)

    const flat = await flatFrames(size, jpegs.length)
    const stripDialogue = (t: string) => t.split('\n').filter((l) => !l.startsWith('Dialogue: ')).join('\n')
    const brokenComposite = await encodeAssText('break-merge', jpegs, brokenAss, strip)
    const brokenFlatCaption = await encodeAssText('break-merge-flat', flat, brokenAss, strip)
    const brokenFlatPlate = await encodeAssText('break-merge-flat-plate', flat, stripDialogue(brokenAss), strip)
    const brokenInk = masksForEveryFrame(brokenFlatCaption, brokenFlatPlate)

    const brokenFindings = await mergeShieldFindings(brokenInk, brokenComposite, tmpRoot, strip.pageHeight)
    expect(brokenFindings.length, 'a caption drawn on the page must be reported').toBeGreaterThan(0)
    expect(brokenFindings[0].invariant).toBe('no caption ink falls inside the page region')
    expect(brokenFindings[0].message).toMatch(/became `charges`/)
    expect(brokenFindings[0].pngPath).toBeTruthy()

    // RESTORED: the shipped geometry, same page, same caption, same frame size, same strip.
    const fixed = await encodeVariants('break-merge-fixed', jpegs, [captionStamp(CAPTION_TEXT, 0)], [], size)
    const ink = masksForEveryFrame(fixed.captionOnly, fixed.flatPlate)
    expect(await mergeShieldFindings(ink, fixed.composite, fixed.dumpDir, fixed.strip.pageHeight)).toEqual([])
    // …and the caption really is on screen, so the pass above is not the vacuous one a
    // renderer that drew nothing at all would also earn.
    expect(ink.some((m) => m.some((p) => p !== 0)), 'the restored caption must actually be drawn').toBe(true)
  }, 180000)

  it('chip merge shield: the strip geometry that shipped goes red on both halves', async () => {
    const scene = VISUAL_SCENES.find((s) => s.name === 'dense-12px')!
    const jpegs = await captureSceneFrames(browser, scene, size.width, size.height, 6)
    const chip = chipStripMetrics(size)
    const spec = { requiredClearPx: chip.requiredClearPx, boxColor: [0, 0, 0] as [number, number, number] }

    /* --- half one: the clearance, broken back to the geometry that really shipped --- */

    // Built by PATCHING the shipped ASS rather than by inventing a broken one, so "broken"
    // means exactly two things and nothing else: the anchored margin goes back from 0 to
    // chipMargin, which pulls the plate off the frame edge, and the hard-space runs are
    // stripped, which drops the inboard clearance back to the 2px of box padding that was
    // measured insufficient.
    const frames = jpegs.map((data, i) => ({ data, offsetMs: i * SCENE_FRAME_INTERVAL_MS }))
    const durationMs = jpegs.length * SCENE_FRAME_INTERVAL_MS
    const frameOffsetsMs = frames.map((f) => f.offsetMs)
    const chips = buildInputChips({ events: chipEvents(), frameOffsetsMs, durationMs, video: size })
    const shipped = formatAss([], size, undefined, { segments: chips.segments })
    // Style fields after `Style: Input,` are Fontname(0) .. MarginL(18), MarginR(19),
    // MarginV(20), Encoding(21) — so 18 are skipped to reach the pair being reverted.
    const brokenAss = shipped.text
      .replace(/^(Style: Input,(?:[^,]*,){18})\d+,\d+(,.*)$/m, `$1${chip.margin},${chip.margin}$2`)
      .replace(/^Dialogue: 1,.*$/gm, (line) => line.replace(/\\h/g, ''))
    expect(brokenAss, 'the Input margins must actually have been reverted').not.toBe(shipped.text)
    expect(brokenAss, 'the hard-space padding must actually have been stripped').not.toMatch(/^Dialogue: 1,.*\\h/m)

    const flat = await flatFrames(size, jpegs.length)
    const stripDialogue = (t: string) => t.split('\n').filter((l) => !l.startsWith('Dialogue: ')).join('\n')
    const brokenComposite = await encodeAssText('break-chipmerge', jpegs, brokenAss)
    const brokenChipsFlat = await encodeAssText('break-chipmerge-chips', flat, brokenAss)
    const brokenInkFlat = await encodeAssText('break-chipmerge-ink', flat, transparentChipBox(brokenAss))
    const brokenFlatPlate = await encodeAssText('break-chipmerge-plate', flat, stripDialogue(brokenAss))
    const brokenChipMasks = masksForEveryFrame(brokenChipsFlat, brokenFlatPlate)
    const brokenInk = masksForEveryFrame(brokenInkFlat, brokenFlatPlate)
    const brokenDir = path.join(tmpRoot, 'break-chipmerge')
    const brokenFindings = await chipMergeShieldFindings(brokenInk, brokenChipMasks, brokenComposite, brokenDir, spec)
    // MEASURED when this test was written: "worst on row 302, inboard/left, with only 2px of
    // clear plate", which is the padding the shipped strip really had, against a 3px figure
    // already known to fail.
    expect(brokenFindings.length, '2px of box padding must be reported as too little clearance').toBeGreaterThan(0)
    expect(brokenFindings[0].message).toMatch(/of clear plate/)
    expect(brokenFindings[0].pngPath).toBeTruthy()

    /* --- half two: the opacity, broken back to the 0.65 box that really shipped --- */

    // dense-12px is white to all four edges, so a translucent box has page under every pixel
    // of it. On `solid-dark` the same box would pass, correctly: nothing shows through a
    // black box on a black page.
    const seeThrough = await encodeVariants('break-chipopacity', jpegs, [], chipEvents(), size, undefined, {
      boxOpacity: 0.65,
    })
    const stMasks = masksForEveryFrame(seeThrough.chipsOnly, seeThrough.flatPlate)
    const stFindings = await chipMergeShieldFindings(
      masksForEveryFrame(seeThrough.chipInkOnly, seeThrough.flatPlate),
      stMasks,
      seeThrough.composite,
      seeThrough.dumpDir,
      spec,
    )
    // MEASURED: 124 plate pixels at a worst channel delta of 103, against a 32 tolerance.
    expect(stFindings.some((f) => /showing THROUGH/.test(f.message)), 'a 0.65 box over a white page must be reported').toBe(true)

    /* --- RESTORED: the shipped strip, same page, same chips, same frame size --- */

    const fixedStrip = await encodeVariants('break-chipmerge-fixed', jpegs, [], chipEvents(), size)
    const fixedMasks = masksForEveryFrame(fixedStrip.chipsOnly, fixedStrip.flatPlate)
    expect(
      await chipMergeShieldFindings(
        masksForEveryFrame(fixedStrip.chipInkOnly, fixedStrip.flatPlate),
        fixedMasks,
        fixedStrip.composite,
        fixedStrip.dumpDir,
        spec,
      ),
    ).toEqual([])
  }, 300000)

  it('golden: a frame rendered with different options fails against the committed reference', async () => {
    if (goldenUpdateRequested()) return
    const size2 = { width: 480, height: 320 }
    const jpegs = await captureSceneFrames(browser, VISUAL_SCENES[1], size2.width, size2.height, 8)
    // Same scene as the committed `solid-dark` golden, one option changed — and one that
    // changes PIXELS rather than DIMENSIONS. A different `fontSizePct` would resize the
    // strip and `compareGoldenFrame` would report the size mismatch instead, which is a
    // different message and a weaker demonstration: the per-pixel comparison would never
    // have run.
    const broken = await encodeVariants('break-golden', jpegs, [captionStamp(CAPTION_TEXT, 400)], chipEvents(), size2, {
      stripColor: '#C4C4C4',
    })
    const capM = masksForEveryFrame(broken.captionOnly, broken.flatPlate)
    const chipM = masksForEveryFrame(broken.chipsOnly, broken.flatPlate)
    const frame = busiestFrame(capM.map((m, i) => maskUnion(m, chipM[i])))
    const result = await compareGoldenFrame(broken.composite, frame, path.join(GOLDEN_DIR, 'solid-dark.png'), broken.dumpDir)
    expect(result.ok, 'moving the caption must not match the committed reference').toBe(false)
    expect(result.message).toMatch(/% of pixels differ/)
    expect(result.diffPng).toBeTruthy()
  }, 180000)
})
