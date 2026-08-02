/**
 * render-visual-frames.ts — render every canonical scene and write the frames out to be
 * LOOKED AT.
 *
 *     pnpm exec vite-node scripts/render-visual-frames.ts
 *
 * Output: `playwriter/tmp/visual-frames/` (stable, overwritten on each run, gitignored).
 * The script prints every path it wrote, with the caption text and the chip labels that
 * are on screen in that frame.
 *
 * WHY THIS IS A STEP AND NOT A CONVENIENCE
 * ----------------------------------------
 * Four visual defects shipped before any of this existed, and every one of them was found
 * by a human looking at a frame rather than by a check going red. `video-invariants.ts`
 * automates the ones that can be stated as a property of known pixel masks. The one that
 * resisted longest is:
 *
 *   **the "Clickkout" class** — overlay text landing beside page text so the composite
 *   reads as a word that is in NEITHER layer. Every pixel we drew is exactly where we meant
 *   to draw it and the page is untouched, so nothing confined to our own layer can see it.
 *
 * That check used to be an OCR-against-OCR comparison through tesseract. It was removed
 * because it could not run on the case it existed for: over a white page a white caption
 * with a thin black outline is an outline font with nothing to threshold, and tesseract
 * read the composite as `chang paty nequeststangsbothpsugcceed` and the caption-alone as
 * `chcdng ones posts charge raquesiss both suacasd` — 0 of 7 tokens recovered from either,
 * different garbage each time, while being plainly legible to a person. An oracle that
 * cannot see is not an oracle, and it dragged an external binary into CI for the privilege.
 *
 * FOR THE CAPTION IT IS NOW AUTOMATED, and not by learning to read. `captionOptions.backdrop`
 * puts a full-frame-width opaque band behind every cue, which turns "does this read as a
 * third word" into "is any page pixel left on a row that carries caption ink" — a question
 * about scanlines that `mergeShieldFindings` answers on pixels. A merged token needs two
 * glyph runs side by side on shared rows; under the band there is nothing beside the caption
 * to be side by side with.
 *
 * FOR THE CHIPS IT IS NOW MOSTLY AUTOMATED TOO, BY A WEAKER RULE. They cannot have the
 * caption's band — a full-width bar behind a corner HUD would be a worse artifact than the
 * defect it prevents — so `chipMergeShieldFindings` asserts three things instead: the plate is
 * OPAQUE (nothing under it survives, which is what a 0.65 box lost), it runs to the frame
 * EDGE it is anchored to (nothing beside it on that side exists), and it clears the ink by a
 * MEASURED distance inboard. Two of those are proofs. The third is a number, and it holds for
 * page text up to about 2.1 times the chip face — above that it is not a proof, though the
 * same measurement found that a 2:1 size step is itself a word boundary, so the band of real
 * risk is narrow rather than open-ended.
 *
 * WHAT THAT LEAVES FOR A PERSON. Question 6 in the checklist is still live for the chips, but
 * it is now asking about the residual — page text much LARGER than the chip face sitting just
 * inboard of the strip — rather than about the whole class. Question 7 has grown a second
 * half: the chip plate is wider than it used to be and reaches a frame edge, and whether that
 * still reads as a subordinate corner HUD is not something a pixel check can answer.
 *
 * THE PER-FRAME CHECKLIST
 * -----------------------
 * For every PNG this writes, ask:
 *
 *   1. Is the caption legible against THAT background? (not "is a caption present")
 *   2. Are the chips legible — box, text, and the `·` separators?
 *   3. Do the caption and the chip strip overlap each other anywhere?
 *   4. Do either of them cover page content that matters — the field being typed into,
 *      the button being pressed, a heading?
 *   5. Is any text clipped at a frame edge, or drawn partly outside it?
 *   6. **The merge question, which is now only about the chips' RESIDUAL.** Read the frame the
 *      way a viewer does. Does any CHIP label run into a page word so the pair reads as a
 *      third word that is in neither? The `checkout-top-left` and `portrait` scenes are built
 *      for this — their page words (`Checkout`, `Filter`, `Scrollbar`) are prefix-neighbours
 *      of the chip vocabulary (`Click`, `Fill`, `Scroll`). The ground truth for both layers is
 *      printed next to each path below, so a manufactured word is identifiable rather than
 *      arguable. Two thirds of the question are now settled by construction: nothing under the
 *      plate survives and nothing exists beside it on its anchored side, both asserted. What
 *      is left is page text sitting INBOARD of the strip and much larger than the chip face,
 *      which is where the measured clearance stops being a proof. The CAPTION cannot merge at
 *      all and you do not have to check it: it sits on a full-frame-width opaque band, so
 *      there is no page pixel on its rows, and `mergeShieldFindings` asserts that everywhere.
 *   7. **Are the plates too heavy?** They are the two things here that cover page content on
 *      purpose. The caption band should read as a subtitle plate sized to the cue that is up —
 *      one line of narration should not black out three lines of page. The chip plate should
 *      still read as a subordinate corner HUD: it is now wider than its letters and runs to
 *      the frame edge it is anchored to, and if that has turned it into a bar rather than a
 *      badge, that is a defect this checklist is the only thing that can catch.
 *
 * Anything you find is a defect in the RENDERER, not in the scene. Fix it in
 * `cdp-screencast.ts`, re-run this, and look again.
 *
 * WHAT DOING THIS FOUND, so that "I saw nothing" is calibrated against a sweep that did see
 * something. All of it is on `dense-12px`, which is why that scene exists:
 *
 *   At 480x320, every frame, BEFORE `captionOptions.backdrop`. The caption's first line
 *   ended in `charge`; the page row it was drawn across is `…and keeps going past the fold`,
 *   whose `keep` was under the caption and whose `s` was not. The composite read **`two
 *   charges going past the fold`** — `charges` is in neither layer. Confirmed by cropping
 *   the seam at 8x: no gap at all between the caption's `e` and the page's `s`. The caption
 *   itself was fully legible, so no contrast, counter or geometry check could see it.
 *
 *   It was NOT fixable by moving anything: a bottom-centred caption over a page that is text
 *   to all four edges has nowhere to go, and the outline that guarantees legibility cannot
 *   stop the page's uncovered letters from joining onto the caption's.
 *
 *   `captionOptions.boxed: true` ON ITS OWN DID NOT FIX IT, which was found the same way —
 *   by rendering it and cropping the seam, after it had been written down as the remedy on
 *   the strength of reasoning alone. Under `boxed` the padding is `outlineWidth`, 1px at
 *   this face, so the plate stopped ~3px past the `e` and the page's `s` was still there: it
 *   still read `charges`. THREE PIXELS OF OPAQUE PLATE IS NOT A WORD BOUNDARY, and that is
 *   why the CAPTION's fix is a band that spans the frame rather than one that hugs the text.
 *   `boxed: true` WITH `outlineWidth: 6` also stopped it, by covering whatever page glyph
 *   happened to be next to the line end — luck, not construction, and a ratio far outside the
 *   counter-survival band.
 *
 *   THAT LINE USED TO END "…rules out every 'just add a bit of padding' remedy, including for
 *   the chips", AND THAT PART WAS WRONG. It reads a measurement of one padding value as a
 *   verdict on the whole idea. Sweeping the padding instead of asserting about it — the same
 *   pairs, the same faces, clear separations of 0 to 20px, read at 1x and 6x — puts the
 *   fusion threshold at about 8px at 12px page text and 9-10px at 15-17px, which is roughly
 *   twice the page's own inter-word gap. 3px failed because it is NARROWER THAN A SPACE (a
 *   space is 4 clear pixels at 12px), not because padding cannot work. The chip plate now
 *   carries 18px at the smallest supported face, and that IS a padding remedy — a measured
 *   one. See `chipStripMetrics`.
 *
 *   At 480x320, every frame, BEFORE the chip plate was made opaque. The strip sat on the same
 *   `…and keeps going past the fold` row, and at 0.65 opacity the page's `going past the`
 *   showed straight THROUGH `Fill •••••• · Click · Ctrl+A`: two texts superimposed, both
 *   illegible, with the page's `keep` running into the chip's `F` at zero separation. Found
 *   by cropping the same seam at 8x. The clearance sweep above is about text BESIDE a chip;
 *   this was text UNDER one, and no amount of clearance addresses it.
 *
 *   The same scene at 1280x720 did NOT merge — the page's line ends at x=493 and the caption
 *   spans 366..915, so the caption's right half was over blank page. The defect was invisible
 *   at one of the two heights, which is why the matrix renders both and why "it looked fine"
 *   from a single render means nothing.
 *
 * WHAT IS RENDERED
 * ----------------
 * The scene/size matrix of `video-scenes.ts` — the same pages, caption and keystrokes the
 * automated suite asserts on, so the two are evidence about one thing rather than two.
 * Encoding goes through the shipped `encodeFrames`, not through the test rig's
 * dialogue-filtering variants: this is what a viewer would actually receive.
 *
 * Frames are chosen by what the overlay is DOING at that moment, computed from the resolved
 * cue and segment times rather than hardcoded, so they stay meaningful if the timings move:
 *
 *   caption-only — a cue is up and no chip is                (the caption against the page)
 *   first-chip   — a cue is up and the first chip has joined (narrow strip)
 *   all-chips    — the segment carrying the most chips       (widest strip, max footprint)
 *   action-N     — one captured frame after `scene.actionFrames[N]` fired
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCues,
  buildInputChips,
  encodeFrames,
  type InputSegment,
  type ResolvedCue,
} from '../src/cdp-screencast.js'
import { openVideo, writeFramePng } from '../src/video-probe.js'
import {
  CAPTION_TEXT,
  SCENE_FPS,
  SCENE_FRAME_COUNT,
  SCENE_FRAME_INTERVAL_MS,
  VISUAL_SCENES,
  captionStamp,
  captureSceneFrames,
  chipEvents,
  sizesForScene,
  type Scene,
  type SceneSize,
} from '../src/video-scenes.js'
import { getChromium, type Browser } from '../src/playwright-import.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Stable and documented. `tmp/` is gitignored, so these are evidence, not fixtures. */
const OUT_DIR = path.resolve(HERE, '..', 'tmp', 'visual-frames')

/** One frame worth opening, and the ground truth of what is drawn in it. */
interface Moment {
  /** Goes into the filename. */
  slug: string
  /** Index into the DECODED clip, which runs at `SCENE_FPS` and is longer than the capture. */
  frame: number
  atMs: number
  captionText: string
  chipLabels: string[]
}

/** What the overlay is drawing at `ms`, from the resolved timeline. */
function overlayAt(ms: number, cues: ResolvedCue[], segments: InputSegment[]) {
  const cue = cues.find((c) => ms >= c.startMs && ms < c.endMs)
  const segment = segments.find((s) => ms >= s.startMs && ms < s.endMs)
  return { cue, segment }
}

/**
 * Pick the frames that are worth a human's attention, by what is on them.
 *
 * Every decoded frame is classified and the first example of each state is taken, so a
 * change to the cue timings moves these rather than invalidating them.
 */
function chooseMoments(scene: Scene, frameCount: number, cues: ResolvedCue[], segments: InputSegment[]): Moment[] {
  const at = (frame: number): Moment => {
    const ms = Math.round((frame * 1000) / SCENE_FPS)
    const { cue, segment } = overlayAt(ms, cues, segments)
    return {
      slug: '',
      frame,
      atMs: ms,
      captionText: cue?.text ?? '',
      chipLabels: segment?.lines.map((l) => l.label) ?? [],
    }
  }
  const all = Array.from({ length: frameCount }, (_, f) => at(f))
  const picked = new Map<number, Moment>()
  /**
   * Claim the first candidate frame nobody else has taken, under this slug.
   *
   * A slug is written AT MOST ONCE — the filename is `${id}-${slug}.png`, so a second
   * moment under the same slug would silently overwrite the first and the sweep would
   * quietly be one frame shorter than it printed. Candidates are in preference order, so
   * a collision moves to the next acceptable frame rather than dropping the state.
   */
  const take = (slug: string, candidates: Moment[]): boolean => {
    for (const m of candidates) {
      if (picked.has(m.frame)) continue
      picked.set(m.frame, { ...m, slug })
      return true
    }
    return false
  }

  take('caption-only', all.filter((m) => m.captionText !== '' && m.chipLabels.length === 0))
  take('first-chip', all.filter((m) => m.captionText !== '' && m.chipLabels.length > 0))
  const mostChips = Math.max(0, ...all.map((m) => m.chipLabels.length))
  take('all-chips', [
    // Preferably with a caption up, since that is the maximum-overlay frame; failing that,
    // the widest strip on its own is still the one worth looking at.
    ...all.filter((m) => m.chipLabels.length === mostChips && m.captionText !== ''),
    ...all.filter((m) => m.chipLabels.length === mostChips),
  ])
  scene.actionFrames?.forEach((captured, i) => {
    // One captured frame later: `mutate` runs before the capture, so the repaint is in the
    // frame itself, and the next one is where it is unambiguously settled.
    const ms = (captured + 1) * SCENE_FRAME_INTERVAL_MS
    const frame = Math.min(frameCount - 1, Math.round((ms * SCENE_FPS) / 1000))
    if (!take(`action-${i}`, [at(frame)])) {
      // Said out loud rather than dropped: the frame IS being written, under an earlier
      // slug, and a reader hunting for `action-0` needs to know where it went.
      console.log(`      (action ${i} lands on frame ${frame}, already written as "${picked.get(frame)!.slug}")`)
    }
  })

  return [...picked.values()].sort((a, b) => a.frame - b.frame)
}

async function renderOne(browser: Browser, scene: Scene, size: SceneSize): Promise<string[]> {
  const jpegs = await captureSceneFrames(browser, scene, size.width, size.height, SCENE_FRAME_COUNT)
  const frames = jpegs.map((data, i) => ({ data, offsetMs: i * SCENE_FRAME_INTERVAL_MS }))
  const durationMs = jpegs.length * SCENE_FRAME_INTERVAL_MS
  const frameOffsetsMs = frames.map((f) => f.offsetMs)
  const built = buildCues({ captions: [captionStamp(CAPTION_TEXT, 400)], frameOffsetsMs, durationMs })
  const chips = buildInputChips({ events: chipEvents(), frameOffsetsMs, durationMs, video: size })

  const id = `${scene.name}-${size.label}`
  const workDir = path.join(OUT_DIR, '.clips')
  fs.mkdirSync(workDir, { recursive: true })
  const mp4 = path.join(workDir, `${id}.mp4`)
  await encodeFrames({
    frames,
    outputPath: mp4,
    fps: SCENE_FPS,
    durationMs,
    captions: built.cues,
    inputSegments: chips.segments,
    videoSize: { width: size.width, height: size.height },
  })

  const video = await openVideo(mp4)
  const cues = built.cues.filter((c) => !c.dropped)
  const moments = chooseMoments(scene, video.frameCount, cues, chips.segments)
  const written: string[] = []
  for (const m of moments) {
    const out = path.join(OUT_DIR, `${id}-${m.slug}.png`)
    await writeFramePng(video, m.frame, out)
    written.push(out)
    console.log(`  ${out}`)
    console.log(`      ${size.width}x${size.height}  frame ${m.frame} of ${video.frameCount}  t=${m.atMs}ms`)
    console.log(`      caption drawn: ${JSON.stringify(m.captionText)}`)
    console.log(`      chips drawn:   ${JSON.stringify(m.chipLabels)}`)
  }
  return written
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await (await getChromium()).launch({ headless: true })
  const written: string[] = []
  try {
    for (const scene of VISUAL_SCENES) {
      for (const size of sizesForScene(scene)) {
        console.log(`\n${scene.name} @ ${size.label} (${size.width}x${size.height})`)
        written.push(...(await renderOne(browser, scene, size)))
      }
    }
  } finally {
    await browser.close()
  }
  console.log(`\n${written.length} frame(s) written to ${OUT_DIR}:`)
  for (const p of written) console.log(p)
  console.log('\nNow OPEN EVERY ONE and run the checklist in the header of this file.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
