/**
 * video-invariants.ts — the properties a burned-in overlay has to have, checked on pixels.
 *
 * Four visual defects shipped before this existed, and every one of them was found by a
 * human looking at a frame rather than by a check going red:
 *
 *   1. a caption outline heavy enough that the letters read as a smudge;
 *   2. a chip landing on a heading so the frame read "Clickkout";
 *   3. chips covering the input being typed into;
 *   4. a three-caption clip 2.25 seconds long.
 *
 * (4) is a timing property and `buildCues` reports it. (1) and (3) are geometry, topology
 * and legibility, and they are what this file is for. (2) IS here now, for the caption
 * layer, and only because the renderer changed; the bottom of this comment says exactly how
 * far that goes and where it stops.
 *
 * THE CENTRAL IDEA is the clean plate. Every scene is encoded FOUR times from the same
 * frames through the same encoder, differing only in which dialogue lines the ASS file
 * carries: the page alone, the page plus captions, the page plus chips, and the page plus
 * both. Differencing any of the last three against the first gives exactly the pixels that
 * layer drew — no brightness threshold, no assumption about the page being dark, and no
 * guessing which half of the frame a component belongs to. Disjointness is then a question
 * about two known masks rather than an inference from row occupancy, which is how the
 * previous guard managed to pass a genuine 21-row overlap.
 *
 * (2) COULD NOT BE CHECKED AT ALL UNTIL THE RENDERER MADE IT CHECKABLE. Overlay text
 * merging with page text FABRICATES a word rather than destroying one: every pixel we drew
 * is exactly where we meant to draw it, the page is untouched, and so every check confined
 * to the overlay's own masks is green on exactly the frame the defect is in. Nothing about
 * "is our layer correct" can see it.
 *
 * It used to be attacked as an OCR-against-OCR comparison through an external OCR binary,
 * and that was DELETED rather than kept, because it could not run on the case it existed
 * for. MEASURED, on a white page with the default styling: the composite came back as
 * `chang paty nequeststangsbothpsugcceed` and the caption-alone render of the SAME text as
 * `chcdng ones posts charge raquesiss both suacasd` — 0 of 7 tokens recovered from either
 * side, different garbage each time, while being plainly legible to a person. White fill
 * with a thin black outline over white is an outline font, and there is nothing in it for
 * an OCR engine to threshold. An oracle that is blind on its own subject is not an oracle.
 *
 * What changed is that reading the composite is no longer the only way in. A merged token
 * needs two glyph runs SIDE BY SIDE ON SHARED SCANLINES; that is the whole mechanism, and
 * it is a statement about geometry, not about words. `captionOptions.backdrop` puts a
 * full-frame-width opaque band behind every cue, so on the caption's rows there is no page
 * pixel left to be beside — and `mergeShieldFindings` below asserts precisely that, on
 * pixels, from the same clean-plate differential everything else here uses. It goes red the
 * instant the band stops spanning the frame, which is the only way the property can be
 * lost.
 *
 * THE CHIPS ARE COVERED TOO NOW, BY A DIFFERENT AND WEAKER RULE. They cannot use the
 * caption's, because a full-width bar behind a corner HUD would be a worse artifact than the
 * defect it prevents. `chipMergeShieldFindings` asserts instead that the plate is opaque
 * (nothing under it survives), that it runs to the frame edge it is anchored to (nothing
 * beside it on that side exists), and that it extends a MEASURED clear distance inboard.
 * The first two are proofs; the third is a number, and the number has a page-face ceiling
 * above which it stops being one — stated at `chipStripMetrics` and not glossed over,
 * because on a row carrying chip ink either the whole row is overlay or some page pixel is
 * on it, and there is no third option short of the bar.
 *
 * SO LOOKING IS STILL A STEP, and it is a real step rather than an aspiration:
 *
 *     pnpm exec vite-node scripts/render-visual-frames.ts
 *
 * renders every canonical scene at every height through the shipped encoder and writes the
 * meaningful frames to `tmp/visual-frames/`, printing the caption text and chip labels that
 * belong in each one. The per-frame checklist — legibility, overlap, occlusion, clipping,
 * and the merge question — is in that script's header. Run it and open the PNGs after any
 * change to how the overlay is drawn.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  type Component,
  type DecodedVideo,
  type Rect,
  colorMask,
  connectedComponents,
  enclosedHoles,
  maskArea,
  maskBBox,
  maskIntersection,
  writeMaskOverlayPng,
  writeRgbPng,
} from './video-probe.js'

/**
 * One thing that is wrong with a frame, in the terms a person would use to look for it.
 *
 * `pngPath` is not optional decoration. It is the affordance that found all four shipped
 * defects, and a finding without one is a number nobody can act on.
 */
export interface Finding {
  invariant: string
  frame: number
  message: string
  pngPath?: string
}

function run(bin: string, args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => err.push(c))
    proc.on('error', (e) => reject(new Error(`${bin} failed to spawn (is it installed?): ${e.message}`)))
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }))
  })
}

/* ------------------------------------------------------------------- geometry */

/**
 * The caption and the chips must not share a single pixel, in any frame.
 *
 * Two-dimensional and exhaustive, because the failure it replaces was neither. Sweeps
 * every frame and reports the FIRST offender rather than sampling a hand-picked index —
 * the previous suite asserted on frame 15 of a 40-frame clip, so a collision that only
 * happened while three chips were up had a two-in-three chance of never being looked at.
 */
export async function disjointFindings(
  captionMasks: Uint8Array[],
  chipMasks: Uint8Array[],
  composite: DecodedVideo,
  dumpDir: string,
): Promise<Finding[]> {
  const findings: Finding[] = []
  const n = Math.min(captionMasks.length, chipMasks.length)
  for (let f = 0; f < n; f++) {
    const shared = maskIntersection(captionMasks[f], chipMasks[f])
    if (shared.length === 0) continue
    const both = new Uint8Array(captionMasks[f].length)
    for (const p of shared) both[p] = 1
    const box = maskBBox(both, composite.width, composite.height)
    const png = await writeMaskOverlayPng(
      composite,
      f,
      [
        { mask: captionMasks[f], color: [0, 96, 255] },
        { mask: chipMasks[f], color: [255, 220, 0] },
        { mask: both, color: [255, 0, 0] },
      ],
      path.join(dumpDir, `disjoint-frame-${f}.png`),
    )
    findings.push({
      invariant: 'caption and chips are disjoint in 2D',
      frame: f,
      message:
        `${shared.length} pixel(s) carry BOTH the caption and a chip, inside ` +
        `x ${box!.x0}..${box!.x1}, y ${box!.y0}..${box!.y1}. The chip strip is lifted clear of the caption by ` +
        'reserving the caption block height in formatAss; a collision means that reserve is short — most often ' +
        'because the caption wrapped to more RENDERED lines than its source text has (see renderedCaptionLines).',
      pngPath: png,
    })
    break
  }
  return findings
}

/**
 * No page pixel shares a scanline with caption ink — the merge class, as geometry.
 *
 * THIS IS THE ONE THE "Clickkout" CLASS WAS SUPPOSED TO BE UNCHECKABLE. It is checkable
 * because the mechanism is not linguistic. A composite reads as a word that is in neither
 * layer only when two glyph runs sit SIDE BY SIDE on the rows they share: `charge` ending
 * at x=362 and the page's `s` beginning at x=363 on the same baseline is `charges`. Two
 * glyphs on different rows are two words however close they are, and two glyphs on the same
 * rows with the whole frame width of opaque band between them are not adjacent at all.
 *
 * So the property is: **every scanline that carries caption ink is covered by the caption
 * layer across the entire width of the frame.** Under it, a page pixel horizontally
 * adjacent to a caption glyph does not exist — not "is unlikely", does not exist — and no
 * merge can be manufactured no matter what the page says. `captionOptions.backdrop` is what
 * makes it true; this is what makes it CHECKED.
 *
 * Both masks come from the flat-plate differential, not from the real scene, for the same
 * reason the geometric invariants do: libass positions everything from the ASS and PlayRes
 * alone, so the flat render gives the layout exactly, with no page content to be mistaken
 * for overlay. `ink` is the caption's glyph layer; `layer` is that plus the band.
 *
 * The CHIP strip is held to a different rule, for a reason rather than out of laziness: it
 * cannot span the frame, so "no page pixel on the row" is not available to it. See
 * `chipMergeShieldFindings`.
 */
export async function mergeShieldFindings(
  ink: Uint8Array[],
  layer: Uint8Array[],
  composite: DecodedVideo,
  dumpDir: string,
): Promise<Finding[]> {
  const { width, height } = composite
  const n = Math.min(ink.length, layer.length)
  for (let f = 0; f < n; f++) {
    const exposed = new Uint8Array(width * height)
    let exposedCount = 0
    let firstRow = -1
    for (let y = 0; y < height; y++) {
      let inked = false
      for (let x = 0; x < width; x++) {
        if (ink[f][y * width + x]) {
          inked = true
          break
        }
      }
      if (!inked) continue
      for (let x = 0; x < width; x++) {
        const p = y * width + x
        if (layer[f][p]) continue
        exposed[p] = 1
        exposedCount++
        if (firstRow < 0) firstRow = y
      }
    }
    if (exposedCount === 0) continue
    const box = maskBBox(exposed, width, height)!
    const png = await writeMaskOverlayPng(
      composite,
      f,
      [
        { mask: layer[f], color: [0, 96, 255] },
        { mask: exposed, color: [255, 0, 0] },
      ],
      path.join(dumpDir, `merge-shield-frame-${f}.png`),
    )
    return [{
      invariant: 'no page pixel shares a scanline with caption ink',
      frame: f,
      message:
        `${exposedCount} pixel(s) of the page are still visible on rows that carry caption ink — first at row ` +
        `${firstRow}, across x ${box.x0}..${box.x1}, y ${box.y0}..${box.y1} (red). A page glyph there sits on the ` +
        'same baseline as a caption glyph with nothing between them, which is how `charge` plus a surviving `s` ' +
        'became `charges`: a word in NEITHER layer, with both layers individually perfect. The fix is not to move ' +
        'the caption — on a page that is text to all four edges there is nowhere to move it — it is for ' +
        'captionOptions.backdrop to span the FULL frame width behind every cue. Check that it is on, and that ' +
        'captionBackdropRect still returns x0 = 0 and x1 = the frame width.',
      pngPath: png,
    }]
  }
  return []
}

/**
 * How far inside its own boundary — and away from the ink — the plate is read for opacity.
 *
 * 3, because two was measured not to be enough. At 2 the check fired on frames rendered with
 * a FULLY OPAQUE box: 4 pixels of the plate's antialiased left edge on the portrait frame at
 * a delta of 125, and a handful of x264 ringing pixels beside glyph stems at 34-41. Neither
 * is the page surviving; both are the renderer and the codec drawing the boundary they are
 * supposed to draw.
 */
const PLATE_INTERIOR_INSET = 3

/** What `chipMergeShieldFindings` is measuring against. */
export interface ChipShieldSpec {
  /** Opaque plate required inboard of the ink, in px. From `chipStripMetrics`. */
  requiredClearPx: number
  /** The chip box colour. Every plate pixel in the composite must BE this. */
  boxColor: [number, number, number]
  /**
   * Per-channel slack when comparing a plate pixel to the box colour.
   *
   * 32, the same figure `OVERLAY_MASK_THRESHOLD` is set from and for the same reason: two
   * x264 encodes of the same content differ by up to 24 on a real capture and by 0 on a flat
   * one. The failure it has to catch is far larger — MEASURED, a 0.65-opacity black box over
   * the white `dense-12px` page reads a worst delta of 103.
   */
  colorTolerance?: number
}

/**
 * The same class for the CHIPS, which need a different formulation and get a weaker one.
 *
 * The caption's rule — every scanline carrying its ink is overlay from edge to edge — is
 * available to the caption only because its band spans the frame. A full-width bar behind a
 * corner HUD would be a worse artifact than the defect it prevents, so the chips cannot have
 * it, and there is no way to dress that up: **on a row carrying chip ink, either the whole row
 * is overlay or some page pixel is on it at some distance, and whether that distance reads as
 * a word break is perceptual.** There is no third option. So what is asserted here is three
 * properties, two of which are proofs and one of which is a measured number:
 *
 *   1. **UNDER the plate.** Every plate pixel in the COMPOSITE is the box colour, so no page
 *      pixel inside the plate survived. This is what a translucent box loses: at 0.65 the
 *      page shows through at a third of its contrast and composites with the chip's own
 *      letters, which is a merge at zero separation. Checked on the composite and not on the
 *      flat differential, because the flat plate has no page in it to show through.
 *
 *   2. **OUTBOARD of the ink.** The plate is allowed to run to a frame edge, and where it
 *      does, that side needs no clearance at all: there is no page pixel beyond the edge.
 *      The check spends its clearance budget walking outward and simply stops when it reaches
 *      x = 0 or x = width - 1, which is exactly how the caption's band terminates too.
 *
 *   3. **INBOARD of the ink.** `requiredClearPx` pixels of plate between the chip's ink and
 *      the first page pixel, on EVERY row the ink occupies. `chipStripMetrics` in
 *      `cdp-screencast.ts` carries the measurement that sets the number and the page face
 *      above which it stops being a proof.
 *
 * Per ROW rather than per bounding box, and that distinction matters: a box-level check is
 * satisfied by clearance beside the widest row, and the row that merges is whichever one the
 * page's baseline happens to cross.
 *
 * `ink` must be the glyph pixels and `layer` the whole footprint (glyphs plus plate); both
 * come from the flat-plate differential so the geometry is exact.
 */
export async function chipMergeShieldFindings(
  ink: Uint8Array[],
  layer: Uint8Array[],
  composite: DecodedVideo,
  dumpDir: string,
  { requiredClearPx, boxColor, colorTolerance = 32 }: ChipShieldSpec,
): Promise<Finding[]> {
  const { width, height } = composite
  const n = Math.min(ink.length, layer.length, composite.frameCount)
  const findings: Finding[] = []

  for (let f = 0; f < n && findings.length === 0; f++) {
    const box = maskBBox(layer[f], width, height)
    if (!box) continue
    const exposed = new Uint8Array(width * height)
    let exposedCount = 0
    // The WORST row, not the first one found. A check that reported the first would name a
    // row with 10px of clearance while a row with 2px went unmentioned, and 2px is the case.
    let worstRow = -1
    let worstSide = ''
    let worstGap = requiredClearPx

    for (let y = box.y0; y <= box.y1; y++) {
      let xL = -1
      let xR = -1
      for (let x = box.x0; x <= box.x1; x++) {
        if (!ink[f][y * width + x]) continue
        if (xL < 0) xL = x
        xR = x
      }
      if (xL < 0) continue
      // Walk outward from the ink. A pixel that is plate is fine; running off the frame is
      // fine and is the stronger of the two outcomes; anything else is page beside a glyph.
      for (const [dir, from] of [[-1, xL], [1, xR]] as const) {
        for (let k = 1; k <= requiredClearPx; k++) {
          const x = from + dir * k
          if (x < 0 || x >= width) break
          if (layer[f][y * width + x]) continue
          exposed[y * width + x] = 1
          exposedCount++
          if (k - 1 < worstGap) {
            worstGap = k - 1
            worstRow = y
            worstSide = dir < 0 ? 'inboard/left' : 'inboard/right'
          }
        }
      }
    }

    if (exposedCount === 0) continue
    const eb = maskBBox(exposed, width, height)!
    findings.push({
      invariant: 'the chip plate clears the chip ink by the measured merge distance',
      frame: f,
      message:
        `${exposedCount} pixel(s) of the page sit within ${requiredClearPx}px of chip ink with no plate between ` +
        `them — worst on row ${worstRow}, ${worstSide}, with only ${worstGap}px of clear plate; the exposure spans ` +
        `x ${eb.x0}..${eb.x1}, y ${eb.y0}..${eb.y1} (red). A page glyph that close to a chip glyph on the same rows ` +
        'reads as one word with it: MEASURED, two runs fuse below about twice the page\'s own inter-word gap, and ' +
        '3px is the `charge` + `s` = `charges` case. The clearance comes from the hard-space padding and the zero ' +
        'anchored margin in formatAss — check that the Input style still has 0 on its anchored side and that the ' +
        'Dialogue: 1 lines still carry their \\h runs.',
      pngPath: await writeMaskOverlayPng(
        composite,
        f,
        [
          { mask: layer[f], color: [255, 220, 0] },
          { mask: exposed, color: [255, 0, 0] },
        ],
        path.join(dumpDir, `chip-merge-shield-frame-${f}.png`),
      ),
    })
  }

  /**
   * The plate is opaque: nothing of the page survives inside it.
   *
   * Read on the INTERIOR of the plate, `PLATE_INTERIOR_INSET` px in from its own boundary and
   * away from the ink, and both exclusions are for antialiasing rather than for convenience.
   * The plate's outermost pixels are a blend of the box colour and the page — MEASURED at a
   * delta of 125 on the portrait frame with the box fully opaque — and a glyph's edge blends
   * towards the text colour, with x264 ringing carrying that a couple of pixels further. Both
   * are the renderer drawing exactly what it should; neither is the page surviving.
   *
   * That leaves a real region to test rather than a token one, because the merge plate is now
   * mostly padding: at the smallest supported face the hard-space runs alone are 16px wide
   * against a 2px box padding, so the interior is the great majority of the plate. And
   * opacity is a property of the whole box, not of one pixel of it — a translucent plate is
   * translucent everywhere — so a subset that large cannot miss it.
   */
  for (let f = 0; f < n && findings.length < 2; f++) {
    const box = maskBBox(layer[f], width, height)
    if (!box) continue
    const seeThrough = new Uint8Array(width * height)
    let count = 0
    let worst = 0
    const clearOf = (mask: Uint8Array, x: number, y: number, r: number, want: 0 | 1): boolean => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ny = y + dy
          const nx = x + dx
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) return false
          if ((mask[ny * width + nx] ? 1 : 0) !== want) return false
        }
      }
      return true
    }
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        const p = y * width + x
        if (!layer[f][p]) continue
        // Inside the plate's boundary, and clear of the ink.
        if (!clearOf(layer[f], x, y, PLATE_INTERIOR_INSET, 1)) continue
        if (!clearOf(ink[f], x, y, PLATE_INTERIOR_INSET, 0)) continue
        const [r, g, b] = composite.pixel(f, x, y)
        const d = Math.max(Math.abs(r - boxColor[0]), Math.abs(g - boxColor[1]), Math.abs(b - boxColor[2]))
        if (d <= colorTolerance) continue
        if (d > worst) worst = d
        seeThrough[p] = 1
        count++
      }
    }
    if (count === 0) continue
    const sb = maskBBox(seeThrough, width, height)!
    findings.push({
      invariant: 'the chip plate is opaque',
      frame: f,
      message:
        `${count} pixel(s) inside the chip plate are not the box colour in the composite — worst channel delta ` +
        `${worst}/255 against a tolerance of ${colorTolerance}, spanning x ${sb.x0}..${sb.x1}, y ${sb.y0}..${sb.y1} ` +
        '(red). The page is showing THROUGH the plate, so a page glyph is compositing with the chip\'s own letters ' +
        'at zero separation — the original `Clickkout` was a chip over a word, not beside one. Raise ' +
        'inputOverlayOptions.boxOpacity back to 1; MEASURED, at 0.65 a black box over the white dense-12px page ' +
        'reads a worst delta of 103 rather than 0.',
      pngPath: await writeMaskOverlayPng(
        composite,
        f,
        [{ mask: seeThrough, color: [255, 0, 0] }],
        path.join(dumpDir, `chip-opacity-frame-${f}.png`),
      ),
    })
    break
  }

  return findings
}

/**
 * Nothing is clipped at a frame edge, and nothing is drawn outside one.
 *
 * "Outside" is not directly observable — a pixel off the frame leaves no trace — so the
 * observable proxy is ink in the outermost row or column, which is what a clipped glyph
 * always leaves behind. libass silently draws off the edge rather than reflowing, so a
 * margin computed against the wrong PlayRes fails exactly this way and no other.
 */
export async function edgeClipFindings(
  masks: Uint8Array[],
  composite: DecodedVideo,
  dumpDir: string,
  label: string,
): Promise<Finding[]> {
  const { width, height } = composite
  for (let f = 0; f < masks.length; f++) {
    const m = masks[f]
    const touched: string[] = []
    for (let x = 0; x < width; x++) {
      if (m[x]) { touched.push('top'); break }
    }
    for (let x = 0; x < width; x++) {
      if (m[(height - 1) * width + x]) { touched.push('bottom'); break }
    }
    for (let y = 0; y < height; y++) {
      if (m[y * width]) { touched.push('left'); break }
    }
    for (let y = 0; y < height; y++) {
      if (m[y * width + width - 1]) { touched.push('right'); break }
    }
    if (touched.length === 0) continue
    const png = await writeMaskOverlayPng(composite, f, [{ mask: m, color: [255, 0, 0] }], path.join(dumpDir, `clipped-${label}-frame-${f}.png`))
    return [{
      invariant: `${label} is not clipped at a frame edge`,
      frame: f,
      message:
        `The ${label} reaches the ${touched.join(' and ')} edge of the ${width}x${height} frame, so part of it is ` +
        'cut off. Every margin here is a percentage of the frame, floored at a few pixels, so this means the ' +
        'style was laid out against a different size than it was drawn at — check that PlayRes matches the frame.',
      pngPath: png,
    }]
  }
  return []
}

/**
 * A chip ROW occupies exactly one line.
 *
 * The whole justification for `'row'` being the default is that it costs the page one line
 * of height however many chips are up. libass re-wraps a dialogue that does not fit the
 * frame width, so an over-wide row silently becomes two lines and grows UPWARD into the
 * gap the caption reserve just paid for — which is the same collision as the disjointness
 * failure, arriving from the other direction.
 */
export async function singleRowFindings(
  chipMasks: Uint8Array[],
  composite: DecodedVideo,
  dumpDir: string,
  chipLineHeightPx: number,
): Promise<Finding[]> {
  for (let f = 0; f < chipMasks.length; f++) {
    const box = maskBBox(chipMasks[f], composite.width, composite.height)
    if (!box) continue
    // A second line costs a full line pitch. Allowing 1.6x absorbs the box padding and the
    // descenders of a tall label without reaching the 2.0x a genuine second line costs.
    if (box.height <= chipLineHeightPx * 1.6) continue
    const png = await writeMaskOverlayPng(composite, f, [{ mask: chipMasks[f], color: [255, 220, 0] }], path.join(dumpDir, `chip-rows-frame-${f}.png`))
    return [{
      invariant: 'a chip row renders as exactly one line',
      frame: f,
      message:
        `The chip strip is ${box.height}px tall where one line is about ${chipLineHeightPx}px, so libass wrapped ` +
        'the row. The row-width budget in buildInputChips is meant to retire the oldest chip before this can ' +
        'happen; it is computed from CHIP_CHAR_WIDTH_RATIO, which is an advance estimate and can be beaten by an ' +
        'unusually wide label (measured: W is 0.85 of the font size against the constant 0.58).',
      pngPath: png,
    }]
  }
  return []
}

/** The chip strip stays visually subordinate to the caption. */
export function subordinateFindings(
  captionMask: Uint8Array,
  chipMask: Uint8Array,
  video: DecodedVideo,
  frame: number,
  maxHeightRatio: number,
): Finding[] {
  const cap = maskBBox(captionMask, video.width, video.height)
  const chip = maskBBox(chipMask, video.width, video.height)
  if (!cap || !chip) return []
  const ratio = chip.height / cap.height
  if (ratio <= maxHeightRatio) return []
  return [{
    invariant: 'font sizes stay subordinate',
    frame,
    message:
      `The chip strip is ${chip.height}px tall against the caption's ${cap.height}px (${ratio.toFixed(2)}x, limit ` +
      `${maxHeightRatio}). At the defaults the chip face is 2.4% of the frame height and the caption face is 5%, ` +
      'so a chip that reads as tall as a caption reads as a second subtitle rather than as an HUD.',
  }]
}

/* ------------------------------------------------------------------ occlusion */

/**
 * The overlay must not cover the part of the PAGE that just changed.
 *
 * This is defect (3) — chips over the input being typed into — stated as a property. The
 * region that changed between the frame before an action and the frame after it is, by
 * construction, the thing the clip exists to show: the field that took the text, the button
 * that depressed, the row that appeared. Computed on the clean PLATE, so the overlay's own
 * appearance cannot be mistaken for the subject moving.
 */
export async function occlusionFindings(
  plate: DecodedVideo,
  composite: DecodedVideo,
  overlayMasks: Uint8Array[],
  actionFrames: number[],
  dumpDir: string,
  { lookAround = 2, minChangedArea = 64, changeThreshold = 40 }: { lookAround?: number; minChangedArea?: number; changeThreshold?: number } = {},
): Promise<Finding[]> {
  const findings: Finding[] = []
  const { width, height } = plate
  for (const f of actionFrames) {
    const before = Math.max(0, f - lookAround)
    const after = Math.min(plate.frameCount - 1, f + lookAround)
    if (before === after) continue
    const changed = new Uint8Array(width * height)
    const b0 = before * plate.frameBytes
    const a0 = after * plate.frameBytes
    for (let p = 0; p < width * height; p++) {
      const i = p * 3
      const d = Math.max(
        Math.abs(plate.rgb[b0 + i] - plate.rgb[a0 + i]),
        Math.abs(plate.rgb[b0 + i + 1] - plate.rgb[a0 + i + 1]),
        Math.abs(plate.rgb[b0 + i + 2] - plate.rgb[a0 + i + 2]),
      )
      if (d > changeThreshold) changed[p] = 1
    }
    // Only substantial regions are "the subject"; a handful of scattered pixels is the
    // page's own antialiasing shifting, and treating that as the subject would make this
    // fire on every frame of any page with a caret in it.
    const subjects = connectedComponents(changed, width, height, { minArea: minChangedArea })
    if (subjects.length === 0) continue
    const subjectMask = new Uint8Array(width * height)
    for (const s of subjects) for (const p of s.pixels) subjectMask[p] = 1

    const overlay = overlayMasks[Math.min(f, overlayMasks.length - 1)]
    const shared = maskIntersection(subjectMask, overlay)
    if (shared.length === 0) continue
    const both = new Uint8Array(width * height)
    for (const p of shared) both[p] = 1
    const png = await writeMaskOverlayPng(
      composite,
      f,
      [
        { mask: subjectMask, color: [0, 255, 0] },
        { mask: overlay, color: [255, 220, 0] },
        { mask: both, color: [255, 0, 0] },
      ],
      path.join(dumpDir, `occlusion-frame-${f}.png`),
    )
    findings.push({
      invariant: 'the overlay does not cover the subject of the action',
      frame: f,
      message:
        `${shared.length} pixel(s) of the overlay sit on top of the region of the page that changed between ` +
        `frames ${before} and ${after} — the thing this action was recorded to show. Green is the subject, ` +
        'yellow the overlay, red the collision. Move the overlay with inputOverlayOptions.position, or record ' +
        'the action somewhere the corner is empty.',
      pngPath: png,
    })
  }
  return findings
}

/* ---------------------------------------------------------------- legibility */

/**
 * Smallest luma separation between a glyph's fill and what immediately surrounds it.
 *
 * Per GLYPH, not per frame, and that distinction is the reason this exists: a caption laid
 * across a photograph is perfectly legible over the dark half and invisible over the light
 * half, and any frame-wide average calls that fine.
 *
 * "What surrounds it" is read from the COMPOSITE, not the plate, because the outline is
 * what is supposed to be providing the contrast. White text on a white page with a black
 * outline has zero contrast against the page and is entirely readable; the same text with
 * no outline is not. Only the composite can tell those apart.
 *
 * 40/255 is the floor. Chosen against the default styling rather than from a perception
 * model: white-on-black is 255, and the pair this refuses is one where the fill and its
 * immediate surround have collapsed to within 15% of the range.
 */
export const MIN_GLYPH_CONTRAST = 40

export async function contrastFindings(
  composite: DecodedVideo,
  frame: number,
  glyphMask: Uint8Array,
  dumpDir: string,
  label: string,
  minContrast = MIN_GLYPH_CONTRAST,
): Promise<Finding[]> {
  const { width, height } = composite
  const glyphs = connectedComponents(glyphMask, width, height, { minArea: 12 })
  const failed: Component[] = []
  let worst = { contrast: Infinity, bbox: null as Rect | null }
  for (const g of glyphs) {
    let fillSum = 0
    for (const p of g.pixels) fillSum += composite.luma(frame, p % width, (p - (p % width)) / width)
    const fill = fillSum / g.pixels.length

    // The ring immediately outside the glyph, two pixels deep: the outline where there is
    // one, the page where there is not.
    let ringSum = 0
    let ringN = 0
    const inGlyph = new Set<number>(Array.from(g.pixels))
    for (let y = Math.max(0, g.bbox.y0 - 2); y <= Math.min(height - 1, g.bbox.y1 + 2); y++) {
      for (let x = Math.max(0, g.bbox.x0 - 2); x <= Math.min(width - 1, g.bbox.x1 + 2); x++) {
        const p = y * width + x
        if (inGlyph.has(p) || glyphMask[p]) continue
        ringSum += composite.luma(frame, x, y)
        ringN++
      }
    }
    if (ringN === 0) continue
    const contrast = Math.abs(fill - ringSum / ringN)
    if (contrast < worst.contrast) worst = { contrast, bbox: g.bbox }
    if (contrast < minContrast) failed.push(g)
  }
  if (failed.length === 0) return []
  const failMask = new Uint8Array(width * height)
  for (const g of failed) for (const p of g.pixels) failMask[p] = 1
  const png = await writeMaskOverlayPng(composite, frame, [{ mask: failMask, color: [255, 0, 0] }], path.join(dumpDir, `contrast-${label}-frame-${frame}.png`))
  return [{
    invariant: `${label} glyphs have local contrast against what is behind them`,
    frame,
    message:
      `${failed.length} of ${glyphs.length} glyph region(s) separate from their immediate surround by less than ` +
      `${minContrast}/255; the worst is ${worst.contrast.toFixed(1)} at x ${worst.bbox?.x0}..${worst.bbox?.x1}, ` +
      `y ${worst.bbox?.y0}..${worst.bbox?.y1}. The outline exists to guarantee this over an arbitrary page — ` +
      'check captionOptions.outlineColor against textColor, and against the page underneath.',
    pngPath: png,
  }]
}

/**
 * Fraction of its open area the counter of `o` must keep before the text reads as a smudge.
 *
 * MEASURED, and gated on `o` alone for a reason that only showed up once the numbers were
 * in. Across `e g o a p b`, the counter of `o` is the only one that behaves like a signal:
 * it is large, round, and strictly monotone in the outline-to-font-size ratio —
 *
 *     1/24 -> 47%    1/16 -> 31-33%    1/12 -> 18%    1/8 -> 0%
 *     1/20 -> 36%    1/14 -> 21%       1/10 ->  5%
 *
 * — whereas `a` has a small, awkward aperture that quantises to a handful of pixels and
 * jumps around non-monotonically (54% at fontSize 24, 5% at 28, 7% at 32, 17% at 40, all
 * at the same outline). Gating on the worst of the six therefore fired on fontSize 36 with
 * a 2px outline, which is 1/18 — a ratio the same measurement shows is fine, and which
 * looks fine when rendered and examined. The others are still measured and reported,
 * because they are useful context in a failure; they just do not decide it.
 *
 * 25% sits between the tightest ratio the shipped rule can produce (1/16, at 31%) and the
 * first ratio that is genuinely degraded (1/14, at 21%).
 *
 * Unlike any measure of ink, brightness or area, this moves the RIGHT way: a smudge adds
 * ink while destroying legibility, so an ink-based check reads a smudged caption as a
 * stronger one.
 */
export const MIN_COUNTER_SURVIVAL = 0.25

/** The glyph the gate is read from. Round, large-countered, and monotone in the ratio. */
const COUNTER_GATE_GLYPH = 'o'

/** Measured and reported for context in a failure; only `o` decides the verdict. */
const COUNTER_PROBE_GLYPHS = [...'egoapb']

/**
 * Whether this STYLE keeps its glyph counters open, measured on a controlled probe.
 *
 * A style-level property checked on a style-level render, and not — as was tried first —
 * by counting holes in the caption as it sits on the scene. That does not work, for two
 * reasons both worth recording so it is not attempted again:
 *
 *   - On a DARK page a black outline is invisible, so it contributes nothing to the
 *     clean-plate differential and the hole count is identical at outline 1 and outline 3
 *     (measured: 22 holes at every outline). That is not a blind spot in the measurement,
 *     it is the truth — a black outline on a black page cannot close anything — but it
 *     means the scene cannot exercise the property.
 *   - On a LIGHT page the differential is full of enclosed slivers between neighbouring
 *     glyphs, and they swamp the counters: a 21-counter caption measured 58-73 holes, and
 *     the count moved by less than 10% between an outline that is fine and one that is a
 *     smudge.
 *
 * Rendering the six glyphs on their own, over a mid-grey plate that shows both the fill
 * and the outline, separates the two bands by a factor of five.
 */
export async function counterFindings(
  style: { fontName: string; fontSize: number; outline: number; shadow: number; textColor: string; outlineColor: string },
  dumpDir: string,
  minSurvival = MIN_COUNTER_SURVIVAL,
): Promise<Finding[]> {
  const worst: Array<{ glyph: string; survival: number; open: number; closed: number }> = []
  for (const glyph of COUNTER_PROBE_GLYPHS) {
    const open = await probeCounterArea({ ...style, outline: 0, shadow: 0 }, glyph)
    const drawn = await probeCounterArea({ ...style, shadow: 0 }, glyph)
    if (open <= 0) continue
    worst.push({ glyph, survival: drawn / open, open, closed: drawn })
  }
  const gate = worst.find((w) => w.glyph === COUNTER_GATE_GLYPH)
  if (!gate || gate.survival >= minSurvival) return []
  worst.sort((a, b) => a.survival - b.survival)

  const ratio = style.outline > 0 ? `1/${(style.fontSize / style.outline).toFixed(1)}` : 'none'
  return [{
    invariant: 'glyph counters survive',
    frame: -1,
    message:
      `At fontSize ${style.fontSize} with a ${style.outline}px outline (${ratio} of the font size) the counter of ` +
      `'${COUNTER_GATE_GLYPH}' keeps only ${(gate.survival * 100).toFixed(0)}% of its open area ` +
      `(${gate.closed}px of ${gate.open}px, floor ${(minSurvival * 100).toFixed(0)}%). The letters fill in ` +
      'and the text reads as a smudge. Measured: the ratio must stay at or under 1/16; 1/12 already loses two ' +
      'thirds of the counter and 1/8 closes it completely. See defaultOutlineWidth — and note that any check ' +
      `counting ink gets BRIGHTER as this gets worse. All probe glyphs: ` +
      `${worst.map((w) => `${w.glyph} ${(w.survival * 100).toFixed(0)}%`).join(', ')}.`,
    pngPath: await writeCounterProbeSheet(style, dumpDir),
  }]
}

/** Render one glyph and return the area of the background it still encloses. */
async function probeCounterArea(
  style: { fontName: string; fontSize: number; outline: number; shadow: number; textColor: string; outlineColor: string },
  glyph: string,
): Promise<number> {
  const W = Math.max(120, style.fontSize * 6)
  const H = Math.max(100, style.fontSize * 5)
  const rgb = await renderProbe(style, glyph, W, H)
  const plate = await renderProbe(style, '', W, H)
  const mask = new Uint8Array(W * H)
  for (let p = 0; p < W * H; p++) {
    const i = p * 3
    const d = Math.max(Math.abs(rgb[i] - plate[i]), Math.abs(rgb[i + 1] - plate[i + 1]), Math.abs(rgb[i + 2] - plate[i + 2]))
    if (d > 8) mask[p] = 1
  }
  const holes = enclosedHoles(mask, W, H, 1)
  return holes.length ? holes[0] : 0
}

function assColorFor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`counter probe needs #RRGGBB, got ${JSON.stringify(hex)}`)
  const [r, g, b] = [0, 2, 4].map((i) => m[1].slice(i, i + 2).toUpperCase())
  return `&H00${b}${g}${r}`
}

/**
 * A single centred glyph over a mid-grey plate.
 *
 * Mid-grey because it is the only background on which BOTH the fill and the outline are
 * visible — on black a black outline leaves no trace, on white a white fill leaves none —
 * and the counter question is exactly "does the outline reach across the fill".
 */
async function renderProbe(
  style: { fontName: string; fontSize: number; outline: number; shadow: number; textColor: string; outlineColor: string },
  text: string,
  W: number,
  H: number,
): Promise<Buffer> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-counter-'))
  try {
    const ass = path.join(tmp, 'p.ass')
    fs.writeFileSync(
      ass,
      [
        '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2',
        'ScaledBorderAndShadow: yes', '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: P,${style.fontName},${style.fontSize},${assColorFor(style.textColor)},${assColorFor(style.textColor)},` +
          `${assColorFor(style.outlineColor)},${assColorFor(style.outlineColor)},0,0,0,0,100,100,0,0,1,${style.outline},${style.shadow},5,10,10,10,1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        `Dialogue: 0,0:00:00.00,0:00:09.00,P,,0,0,0,,${text}`,
        '',
      ].join('\n'),
      'utf8',
    )
    const r = await run('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}`, '-frames:v', '1',
      '-vf', `subtitles=${ass}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ])
    if (r.code !== 0) throw new Error(`ffmpeg failed rendering a counter probe:\n${r.stderr}`)
    return r.stdout
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** The probe word at the failing style, so the smudge can be looked at rather than argued about. */
async function writeCounterProbeSheet(
  style: { fontName: string; fontSize: number; outline: number; shadow: number; textColor: string; outlineColor: string },
  dumpDir: string,
): Promise<string> {
  const W = Math.max(240, style.fontSize * 14)
  const H = Math.max(80, style.fontSize * 4)
  const rgb = await renderProbe(style, 'egoapb 80', W, H)
  return writeRgbPng(rgb, W, H, path.join(dumpDir, `counters-fs${style.fontSize}-out${style.outline}.png`))
}

/* ------------------------------------------------------------- golden frames */

/**
 * How far a frame may drift from its committed reference.
 *
 * MEASURED, in both directions, so the band is known to be a band rather than a hope.
 *
 * The floor: encoding byte-identical input twice through the exact `buildEncodeArgs`
 * command line produces BIT-IDENTICAL output — mp4s of the same size and the same bytes,
 * and rgb24 decodes with a per-pixel delta of 0 across all 21 frames. That held at default
 * threading and at `-threads 1`, and with the subtitle filter in the chain as well as
 * without. So the noise floor is exactly zero on this machine, and any tolerance above
 * zero is headroom for a different ffmpeg build rather than for this one.
 *
 * The ceiling: the SMALLEST change worth catching is a one-pixel shift of the caption,
 * which alters 3.47% of the decoded bytes with a maximum channel delta of 253. A one-step
 * outline change alters 3.35% at a maximum of 247.
 *
 * So: a pixel counts as different when a channel moves by more than 8/255, and a frame
 * fails when more than 0.5% of its pixels do. That is strictly above a measured floor of
 * zero and roughly seven times below the weakest signal it has to catch.
 */
export const GOLDEN_CHANNEL_TOLERANCE = 8
export const GOLDEN_MAX_DIFFERING_FRACTION = 0.005

/** Set `UPDATE_VIDEO_GOLDEN=1` to rewrite the references from the current renderer. */
export function goldenUpdateRequested(): boolean {
  return process.env.UPDATE_VIDEO_GOLDEN === '1'
}

export interface GoldenResult {
  ok: boolean
  wrote?: string
  message?: string
  actualPng?: string
  diffPng?: string
}

/**
 * Compare one frame against a committed PNG.
 *
 * FAILS when the reference is missing. That is the whole design constraint: a golden
 * harness that treats an absent reference as a pass is a harness that goes green the first
 * time somebody deletes the fixtures directory, and it goes green for every scene at once,
 * which is precisely when nobody is looking.
 */
export async function compareGoldenFrame(
  video: DecodedVideo,
  frame: number,
  referencePng: string,
  dumpDir: string,
): Promise<GoldenResult> {
  const base = frame * video.frameBytes
  const actual = video.rgb.subarray(base, base + video.frameBytes)

  if (goldenUpdateRequested()) {
    await writeRgbPng(actual, video.width, video.height, referencePng)
    return { ok: true, wrote: referencePng }
  }
  if (!fs.existsSync(referencePng)) {
    return {
      ok: false,
      message:
        `The golden reference ${referencePng} does not exist. This is a FAILURE and not a pass: a missing ` +
        'reference means nothing is being compared. Regenerate the references with\n' +
        '    UPDATE_VIDEO_GOLDEN=1 pnpm exec vitest run src/cdp-screencast-visual.test.ts\n' +
        'and commit the PNGs, after looking at them.',
    }
  }
  const decoded = await run('ffmpeg', ['-v', 'error', '-i', referencePng, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  if (decoded.code !== 0) return { ok: false, message: `Could not decode the golden reference ${referencePng}:\n${decoded.stderr}` }
  if (decoded.stdout.length !== actual.length) {
    return {
      ok: false,
      message:
        `The golden reference ${referencePng} decodes to ${decoded.stdout.length} bytes but this frame is ` +
        `${actual.length} (${video.width}x${video.height}). The render changed size, which no per-pixel ` +
        'tolerance can express. Look at the frame, then regenerate with UPDATE_VIDEO_GOLDEN=1.',
    }
  }

  const { width, height } = video
  const diff = Buffer.alloc(width * height * 3)
  let differing = 0
  let maxDelta = 0
  for (let p = 0; p < width * height; p++) {
    const i = p * 3
    const d = Math.max(
      Math.abs(actual[i] - decoded.stdout[i]),
      Math.abs(actual[i + 1] - decoded.stdout[i + 1]),
      Math.abs(actual[i + 2] - decoded.stdout[i + 2]),
    )
    if (d > maxDelta) maxDelta = d
    if (d > GOLDEN_CHANNEL_TOLERANCE) {
      differing++
      diff[i] = 255
    } else {
      // Keep the unchanged picture visible underneath, dimmed, so the diff reads as a
      // location and not as a constellation.
      diff[i] = diff[i + 1] = diff[i + 2] = Math.round(actual[i] / 3)
    }
  }
  const fraction = differing / (width * height)
  if (fraction <= GOLDEN_MAX_DIFFERING_FRACTION) return { ok: true }

  const actualPng = await writeRgbPng(actual, width, height, path.join(dumpDir, `${path.basename(referencePng, '.png')}-actual.png`))
  const diffPng = await writeRgbPng(diff, width, height, path.join(dumpDir, `${path.basename(referencePng, '.png')}-diff.png`))
  return {
    ok: false,
    actualPng,
    diffPng,
    message:
      `${(fraction * 100).toFixed(3)}% of pixels differ from ${referencePng} by more than ` +
      `${GOLDEN_CHANNEL_TOLERANCE}/255 (limit ${(GOLDEN_MAX_DIFFERING_FRACTION * 100).toFixed(3)}%, worst channel ` +
      `delta ${maxDelta}). Encoding identical input twice is bit-exact here, so this is a real change in what is ` +
      `drawn, not encoder noise.\n  rendered: ${actualPng}\n  diff:     ${diffPng}\n  reference: ${referencePng}\n` +
      'If the change is intended, look at the rendered frame and then regenerate with UPDATE_VIDEO_GOLDEN=1.',
  }
}

/** Render every finding into one message a person can act on. */
export function describeFindings(findings: Finding[]): string {
  return findings
    .map((f) => `[${f.invariant}] frame ${f.frame}: ${f.message}${f.pngPath ? `\n    look at: ${f.pngPath}` : ''}`)
    .join('\n')
}

export { maskArea, maskBBox, colorMask }
