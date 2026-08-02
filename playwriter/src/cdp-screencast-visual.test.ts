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
 * word that is in NEITHER layer — is covered here FOR THE CAPTION AND NOT FOR THE CHIPS.
 * It became coverable when `captionOptions.backdrop` turned it from a question about words
 * into a question about scanlines: `mergeShieldFindings` asserts that every row carrying
 * caption ink is opaque overlay from one edge of the frame to the other, which is precisely
 * the condition under which no page glyph can sit beside a caption glyph. The break test
 * below turns the band off on `dense-12px` at 480x320 and watches it go red on the frame
 * that really shipped.
 *
 * The chip strip has no band and is NOT held to that, so a chip can still merge with page
 * text and nothing here will say so. That remainder is a LOOKING step, and it has its own
 * harness:
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
  captionBlockHeightPx,
  defaultOutlineWidth,
  encodeFrames,
  formatAss,
  renderedCaptionLines,
  type CaptionOptions,
  type InputOverlayOptions,
  type StampedCaption,
  type StampedInput,
} from './cdp-screencast.js'
import {
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
import { colorMask, maskUnion, openVideo, overlayMask, type DecodedVideo } from './video-probe.js'
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
  /** The caption GLYPHS alone, without their band, so glyph geometry stays measurable. */
  captionOnly: DecodedVideo
  /** The full-width opaque band behind the caption, alone. */
  backdropOnly: DecodedVideo
  chipsOnly: DecodedVideo
  dumpDir: string
}

/** The three dialogue layers `formatAss` emits, keyed by the Layer field it writes. */
type AssLayer = 'backdrop' | 'caption' | 'chips'

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

  // ONE ass file. Every variant is this file with some dialogue lines removed. The three
  // layers are told apart by the Layer field: -1 backdrop, 0 caption, 1 chips. A line that
  // is not a dialogue at all — the styles, the headers — belongs to every variant.
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
        if (line.startsWith('Dialogue: -1,')) return layers.includes('backdrop')
        if (line.startsWith('Dialogue: 0,')) return layers.includes('caption')
        if (line.startsWith('Dialogue: 1,')) return layers.includes('chips')
        return true
      })
      .join('\n')

  const flat = await flatFrames(size, jpegs.length)
  return {
    plate: await encodeAssText(`${name}/plate`, jpegs, keep()),
    composite: await encodeAssText(`${name}/composite`, jpegs, keep('backdrop', 'caption', 'chips')),
    flatPlate: await encodeAssText(`${name}/flat-plate`, flat, keep()),
    // The glyphs WITHOUT their band. libass positions a dialogue from the ASS alone, so the
    // glyphs land in exactly the same pixels either way; leaving the band out keeps this
    // mask the caption's ink rather than a rectangle, which is what the edge-clip, contrast
    // and subordination questions are actually about.
    captionOnly: await encodeAssText(`${name}/flat-caption`, flat, keep('caption')),
    backdropOnly: await encodeAssText(`${name}/flat-backdrop`, flat, keep('backdrop')),
    chipsOnly: await encodeAssText(`${name}/flat-chips`, flat, keep('chips')),
    dumpDir,
  }
}

/**
 * The flat plate the geometry is measured against, as JPEG frames.
 *
 * Mid-grey, because it is the only background on which BOTH a white fill and a black
 * outline leave a mark — and the differential has to see the overlay's whole footprint,
 * not just the half of it that happens to contrast with the page.
 */
const flatCache = new Map<string, Buffer[]>()
async function flatFrames(size: { width: number; height: number }, count: number): Promise<Buffer[]> {
  const key = `${size.width}x${size.height}`
  if (!flatCache.has(key)) {
    const f = path.join(tmpRoot, `flat-${key}.jpg`)
    const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=${key}`, '-frames:v', '1', '-q:v', '2', f])
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
async function encodeAssText(name: string, jpegs: Buffer[], assText: string): Promise<DecodedVideo> {
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
  const r = await run('ffmpeg', ['-v', 'error', ...buildEncodeArgs({ listFile, outputPath: out, fps: SCENE_FPS, burnAssPath: assPath })])
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

/** The caption style `formatAss` will resolve for a frame of this height, at the defaults. */
function styleOf(height: number, options?: CaptionOptions) {
  const fontSize = Math.max(16, Math.round((height * (options?.fontSizePct ?? 5)) / 100))
  return {
    fontName: options?.fontName ?? 'DejaVu Sans',
    fontSize,
    outline: options?.outlineWidth ?? defaultOutlineWidth(fontSize),
    shadow: options?.shadow ?? 1,
    textColor: options?.textColor ?? '#FFFFFF',
    outlineColor: options?.outlineColor ?? '#000000',
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
        const backdropMasks = masksForEveryFrame(v.backdropOnly, v.flatPlate)
        const chipMasks = masksForEveryFrame(v.chipsOnly, v.flatPlate)
        // The caption AS DRAWN: its glyphs plus the band they sit on. The chips have to
        // clear the band, not merely the letters, and the band is what occludes the page.
        const captionLayerMasks = captionMasks.map((m, i) => maskUnion(m, backdropMasks[i]))
        // Frame choice stays on the INK, so the busiest frame is still the one with the most
        // caption and chips on it rather than any frame the constant-area band happens to be
        // up for.
        const bothMasks = captionMasks.map((m, i) => maskUnion(m, chipMasks[i]))
        const overlayMasks = captionLayerMasks.map((m, i) => maskUnion(m, chipMasks[i]))
        const frame = busiestFrame(bothMasks)

        const findings: Finding[] = []

        // 1. The two layers never share a pixel, in ANY frame — band included.
        findings.push(...(await disjointFindings(captionLayerMasks, chipMasks, v.composite, v.dumpDir)))

        // 2. Nothing is clipped at a frame edge. Asked of the GLYPHS: the band reaches both
        //    side edges deliberately, which is the entire point of it (see invariant 8).
        findings.push(...(await edgeClipFindings(captionMasks, v.composite, v.dumpDir, 'caption')))
        findings.push(...(await edgeClipFindings(chipMasks, v.composite, v.dumpDir, 'chip strip')))

        // 3. A chip row is one line.
        const chipFace = Math.max(10, Math.round((size.height * 2.4) / 100))
        findings.push(...(await singleRowFindings(chipMasks, v.composite, v.dumpDir, chipFace + 2 * Math.max(2, Math.round(chipFace / 6)))))

        // 4. Glyph ink has local contrast against what is immediately behind it.
        //    The FILL, not the whole footprint: the footprint includes the black outline,
        //    and averaging fill and outline together on a dark page produces a mean that
        //    matches the page and reports every legible caption as invisible.
        const captionFill = colorMask(v.composite, frame, captionMasks[frame], '#FFFFFF')
        findings.push(...(await contrastFindings(v.composite, frame, captionFill, v.dumpDir, 'caption')))

        // 5. Counters survive: the smudge class, measured topologically on the resolved style.
        findings.push(...(await counterFindings(styleOf(size.height), v.dumpDir)))

        // 6. The chips stay subordinate to the caption.
        //    MEASURED rather than assumed: the intended face ratio is 2.4%/5% = 0.48, but
        //    at H=320 BOTH floors bind (chip 10px against caption 16px = 0.63) and the
        //    chip's opaque box adds twice its padding on top, so the rendered strip is
        //    0.82 of the caption block there against 0.64 at H=720. 0.9 is above the
        //    worst case the defaults can produce and far below the 2.3 that a chip face
        //    larger than the caption face produces.
        findings.push(...subordinateFindings(captionMasks[frame], chipMasks[frame], v.composite, frame, 0.9))

        // 7. The overlay does not cover what the action changed — and the band is part of
        //    the overlay, so a band that solved the merge by burying the subject fails here.
        if (scene.actionFrames?.length) {
          findings.push(...(await occlusionFindings(v.plate, v.composite, overlayMasks, scene.actionFrames, v.dumpDir)))
        }

        // 8. The merge shield: no page pixel is left on a row that carries caption ink, so
        //    no page glyph can sit beside a caption glyph and fabricate a third word. This
        //    is the "Clickkout" class, and it is here rather than in the looking harness only
        //    because captionOptions.backdrop made it a geometric property.
        findings.push(...(await mergeShieldFindings(captionMasks, captionLayerMasks, v.composite, v.dumpDir)))

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

  it('contrast: a near-white outline on a white page is caught per glyph', async () => {
    const jpegs = await captureSceneFrames(browser, VISUAL_SCENES[0], size.width, size.height, 4) // solid white
    /**
     * The FILL, not the whole footprint — which is what `contrastFindings` documents and
     * what the scene loop above has always passed it. This test used to pass the raw
     * footprint and got away with it only because the page behind it was white: the
     * footprint of a 16px face with a 1px outline is mostly OUTLINE, so its mean luma is
     * ~51-65 against a white surround of 255, and the contrast came out ~190.
     *
     * `captionOptions.backdrop` ended that, and rightly. The caption now sits on a black
     * band, so the surround is ~9-16 and the footprint's own mean is still 51-65: MEASURED
     * contrast 35-55, and one component under the 40 floor — for a caption that is white on
     * black and about as legible as text can be. That is precisely the failure mode the
     * invariant's own comment warns about ("averaging fill and outline together on a dark
     * page produces a mean that matches the page and reports every legible caption as
     * invisible"), arriving here because the band makes every page a dark page.
     *
     * So this measures the fill. The broken half below still goes red, and for a sharper
     * reason than before: the band is painted from `outlineColor`, so a near-white outline
     * now means a near-white BAND behind near-white text.
     */
    const fillOf = (v: Variants, frame: number) =>
      colorMask(v.composite, frame, overlayMask(v.captionOnly, v.flatPlate, frame), '#FFFFFF')

    // BROKEN: white text with a barely-darker outline, on a white page. It encodes cleanly
    // and the caption is on screen; there is simply nothing to see.
    const broken = await encodeVariants('break-contrast', jpegs, [captionStamp(CAPTION_TEXT, 0)], [], size, {
      textColor: '#FFFFFF',
      outlineColor: '#DCDCDC',
    })
    const brokenFindings = await contrastFindings(broken.composite, 2, fillOf(broken, 2), broken.dumpDir, 'caption')
    expect(brokenFindings.length, 'a near-white outline on a white page must fail contrast').toBeGreaterThan(0)
    expect(brokenFindings[0].pngPath).toBeTruthy()

    // RESTORED: the default black outline, on the same white page.
    const fixed = await encodeVariants('break-contrast-fixed', jpegs, [captionStamp(CAPTION_TEXT, 0)], [], size)
    expect(await contrastFindings(fixed.composite, 2, fillOf(fixed, 2), fixed.dumpDir, 'caption')).toEqual([])
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
    const broken = await encodeVariants('break-subordinate', jpegs, [captionStamp('caption', 0)], [inputStamp('chip', 0)], size, undefined, {
      fontSizePct: 9,
    })
    const capM = overlayMask(broken.captionOnly, broken.flatPlate, 2)
    const chipM = overlayMask(broken.chipsOnly, broken.flatPlate, 2)
    const brokenFindings = subordinateFindings(capM, chipM, broken.composite, 2, 0.9)
    expect(brokenFindings.length, 'a 9% chip face against a 5% caption face must be reported').toBeGreaterThan(0)

    const fixed = await encodeVariants('break-subordinate-fixed', jpegs, [captionStamp('caption', 0)], [inputStamp('chip', 0)], size)
    const fCap = overlayMask(fixed.captionOnly, fixed.flatPlate, 2)
    const fChip = overlayMask(fixed.chipsOnly, fixed.flatPlate, 2)
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

  it('disjointness: the pre-fix source-line reserve collides on a portrait frame', async () => {
    const size390 = { width: 390, height: 844 }
    const scene = VISUAL_SCENES.find((s) => s.name === 'portrait')!
    const jpegs = await captureSceneFrames(browser, scene, size390.width, size390.height, 6)
    const co: CaptionOptions = {}
    const cues = [captionStamp(CAPTION_TEXT, 0, co)]
    const fontSize = Math.max(16, Math.round((size390.height * 5) / 100))
    const marginH = Math.max(8, Math.round(size390.width * 0.05))

    // The arithmetic first, so the render is confirming something already known.
    const sourceLines = cues[0].text.split('\n').length
    const drawnLines = renderedCaptionLines(cues[0].text, size390.width - 2 * marginH, fontSize)
    expect(drawnLines).toBeGreaterThan(sourceLines * 2)

    const frames = jpegs.map((data, i) => ({ data, offsetMs: i * SCENE_FRAME_INTERVAL_MS }))
    const durationMs = jpegs.length * SCENE_FRAME_INTERVAL_MS
    const frameOffsetsMs = frames.map((f) => f.offsetMs)
    const built = buildCues({ captions: cues, frameOffsetsMs, durationMs, options: co })
    const chips = buildInputChips({ events: [inputStamp('Click', 0)], frameOffsetsMs, durationMs, video: size390 })
    const shipped = formatAss(built.cues, size390, co, { segments: chips.segments })

    // BROKEN: the Input style's MarginV reverted to what counting SOURCE lines produced.
    const outline = defaultOutlineWidth(fontSize)
    const chipSize = Math.max(10, Math.round((size390.height * 2.4) / 100))
    const marginV = Math.max(4, Math.round((size390.height * 6) / 100))
    const oldReserve = marginV + captionBlockHeightPx(sourceLines, fontSize, outline, 1) + Math.max(4, Math.round(chipSize * 0.7))
    // Style fields after `Style: Input,` are Fontname(0) .. MarginL(18), MarginR(19),
    // MarginV(20), Encoding(21) — so 20 fields are skipped before the one being reverted.
    const brokenAss = shipped.text.replace(/^(Style: Input,(?:[^,]*,){20})(\d+)(,\d+)$/m, `$1${oldReserve}$3`)
    expect(brokenAss, 'the Input MarginV must actually have been replaced').not.toBe(shipped.text)

    const brokenComposite = await encodeAssText('break-disjoint', jpegs, brokenAss)
    const captionOnlyAss = formatAss(built.cues, size390, co)
    // Both the glyphs AND their band come out of the chips-only render: leaving the band in
    // would put it in both masks, and the collision this test claims to demonstrate would be
    // the band overlapping itself rather than a chip landing on the narration.
    const chipsOnlyBrokenAss = brokenAss
      .split('\n')
      .filter((l) => !l.startsWith('Dialogue: 0,') && !l.startsWith('Dialogue: -1,'))
      .join('\n')
    const brokenChipsOnly = await encodeAssText('break-disjoint-chips', jpegs, chipsOnlyBrokenAss)
    const captionOnly = await encodeAssText('break-disjoint-caption', jpegs, captionOnlyAss.text)

    const plateDir = path.join(tmpRoot, 'break-disjoint-plate')
    fs.mkdirSync(plateDir, { recursive: true })
    await encodeFrames({
      frames,
      outputPath: path.join(plateDir, 'plate.mp4'),
      fps: SCENE_FPS,
      durationMs,
      captions: [],
      inputSegments: [],
      videoSize: size390,
    })
    const plate = await openVideo(path.join(plateDir, 'plate.mp4'))

    const capMasks = masksForEveryFrame(captionOnly, plate)
    const chipMasks = masksForEveryFrame(brokenChipsOnly, plate)
    const brokenFindings = await disjointFindings(capMasks, chipMasks, brokenComposite, plateDir)
    expect(
      brokenFindings.length,
      'reserving only the SOURCE line count on a 390x844 frame must put the chips through the caption',
    ).toBeGreaterThan(0)
    expect(brokenFindings[0].message).toMatch(/carry BOTH the caption and a chip/)

    // RESTORED: the shipped reserve, same page, same caption, same chip.
    const fixed = await encodeVariants('break-disjoint-fixed', jpegs, cues, [inputStamp('Click', 0)], size390, co)
    const fixedCap = masksForEveryFrame(fixed.captionOnly, fixed.flatPlate)
    const fixedChip = masksForEveryFrame(fixed.chipsOnly, fixed.flatPlate)
    expect(await disjointFindings(fixedCap, fixedChip, fixed.composite, fixed.dumpDir)).toEqual([])
  }, 300000)

  it('merge shield: backdrop:false reinstates the exact defect on dense-12px, and it goes red', async () => {
    const scene = VISUAL_SCENES.find((s) => s.name === 'dense-12px')!
    const jpegs = await captureSceneFrames(browser, scene, size.width, size.height, 6)

    // BROKEN, and broken the way it SHIPPED rather than in some invented way: an outlined
    // caption with no band, over a page that is 12px text to all four edges. Measured on
    // this exact scene and size before the band existed — the caption's first line ended in
    // `charge`, the page row it crossed resumed with the surviving `s` of `keeps`, there was
    // no gap at all between them at 10x, and the frame read `two charges going past the
    // fold`: a word in NEITHER layer, with both layers individually perfect.
    const broken = await encodeVariants('break-merge', jpegs, [captionStamp(CAPTION_TEXT, 0)], [], size, {
      backdrop: false,
    })
    const brokenInk = masksForEveryFrame(broken.captionOnly, broken.flatPlate)
    const brokenBand = masksForEveryFrame(broken.backdropOnly, broken.flatPlate)
    expect(brokenBand.every((m) => m.every((v) => v === 0)), 'backdrop:false must draw no band at all').toBe(true)
    const brokenFindings = await mergeShieldFindings(
      brokenInk,
      brokenInk.map((m, i) => maskUnion(m, brokenBand[i])),
      broken.composite,
      broken.dumpDir,
    )
    expect(brokenFindings.length, 'a caption with no band leaves the page on its own scanlines').toBeGreaterThan(0)
    expect(brokenFindings[0].message).toMatch(/became `charges`/)
    expect(brokenFindings[0].pngPath).toBeTruthy()

    // RESTORED: the shipped default, same page, same caption, same frame size.
    const fixed = await encodeVariants('break-merge-fixed', jpegs, [captionStamp(CAPTION_TEXT, 0)], [], size)
    const ink = masksForEveryFrame(fixed.captionOnly, fixed.flatPlate)
    const band = masksForEveryFrame(fixed.backdropOnly, fixed.flatPlate)
    expect(
      await mergeShieldFindings(ink, ink.map((m, i) => maskUnion(m, band[i])), fixed.composite, fixed.dumpDir),
    ).toEqual([])
  }, 180000)

  it('golden: a frame rendered with different options fails against the committed reference', async () => {
    if (goldenUpdateRequested()) return
    const size2 = { width: 480, height: 320 }
    const jpegs = await captureSceneFrames(browser, VISUAL_SCENES[1], size2.width, size2.height, 8)
    // Same scene as the committed `solid-dark` golden, one option changed.
    const broken = await encodeVariants('break-golden', jpegs, [captionStamp(CAPTION_TEXT, 400)], chipEvents(), size2, {
      marginBottomPct: 12,
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
