/**
 * video-scenes.ts — the canonical pages the burned-in overlay is checked against.
 *
 * Extracted so that the automated oracle (`cdp-screencast-visual.test.ts`) and the
 * frame-inspection harness (`scripts/render-visual-frames.ts`) look at THE SAME pages with
 * THE SAME caption and THE SAME keystrokes. Two copies of these eight HTML strings would
 * drift within a week, and the moment they drifted the harness would stop being evidence
 * about the thing the oracle guards.
 *
 * Nothing here is lorem ipsum. Every page defeats a specific shortcut, and the reason is
 * recorded on the scene.
 */
import type { Browser } from './playwright-import.js'
import {
  normalizeCaptionText,
  wrapCaptionText,
  type CaptionOptions,
  type StampedCaption,
  type StampedInput,
} from './cdp-screencast.js'

export interface Scene {
  name: string
  html: string
  /** Applied before frame `i` so a region of the page changes at a known moment. */
  mutate?: (i: number) => string
  /** Which captured frames an action landed on — the subject the clip exists to show. */
  actionFrames?: number[]
}

/**
 * Eight pages, each chosen because it defeats a specific shortcut.
 *
 * The checkout scene exists to have `Checkout`, `Filter` and `Scrollbar` sitting where
 * `Click`, `Fill` and `Scroll` want to go: a page whose words cannot prefix-merge with the
 * chip vocabulary cannot manufacture the "Clickkout" defect, so looking at one proves
 * nothing about it.
 */
export const VISUAL_SCENES: Scene[] = [
  {
    name: 'solid-white',
    // The case every brightness threshold fails: `> 200 is ink` matches the whole frame.
    html: '<body style="margin:0;background:#ffffff"></body>',
  },
  {
    name: 'solid-dark',
    // The case every existing pixel assertion was silently conditioned on.
    html: '<body style="margin:0;background:#111111"></body>',
  },
  {
    name: 'mid-grey',
    // Neither a white outline nor a black one wins here; it is the worst case for contrast
    // and the reason the default is white text WITH a black outline rather than either alone.
    html: '<body style="margin:0;background:#808080"></body>',
  },
  {
    name: 'checkout-top-left',
    // The "Clickkout" page. Every heading is a prefix-neighbour of a chip label.
    html:
      '<body style="margin:0;background:#ffffff;font-family:DejaVu Sans,sans-serif;color:#111">' +
      '<h1 style="margin:0;padding:10px;font-size:22px;background:#12325a;color:#fff">Checkout</h1>' +
      '<div style="padding:8px 10px;font-size:15px">Filter the results</div>' +
      '<div style="padding:8px 10px;font-size:15px">Scrollbar position saved</div>' +
      '<input id="email" style="margin:8px 10px;width:60%;font-size:14px" value="">' +
      '</body>',
    actionFrames: [4],
    mutate: (i) => (i >= 4 ? 'document.getElementById("email").value = "alice@example.com"' : ''),
  },
  {
    name: 'edge-hugging',
    // Text against all four edges: anything the overlay clips, it clips onto content.
    html:
      '<body style="margin:0;background:#fafafa;font-family:DejaVu Sans,sans-serif;color:#000;font-size:13px">' +
      '<div style="position:absolute;top:0;left:0">top left corner text</div>' +
      '<div style="position:absolute;top:0;right:0">top right corner text</div>' +
      '<div style="position:absolute;bottom:0;left:0">bottom left corner text</div>' +
      '<div style="position:absolute;bottom:0;right:0">bottom right corner text</div>' +
      '</body>',
  },
  {
    name: 'static-page',
    // Never repaints. The overlay's own frames are the only thing that changes, which is
    // what makes it a distinct case for the occlusion check: there is no subject to occlude.
    html: '<body style="margin:0;background:#1b1b2b"><div style="width:100vw;height:100vh"></div></body>',
  },
  {
    name: 'dense-12px',
    // No empty corner anywhere. Whichever corner the chips take, they take it from content.
    html:
      '<body style="margin:0;background:#fff;font-family:DejaVu Sans,sans-serif;font-size:12px;color:#222;line-height:1.25">' +
      Array.from({ length: 90 }, (_, i) => `<div>row ${i} the quick brown fox jumps over the lazy dog and keeps going past the fold</div>`).join('') +
      '</body>',
  },
  {
    name: 'portrait',
    // 390x844. Our wrapper wraps at 42 CHARACTERS and libass wraps at PIXELS, and below
    // roughly W/H = 1.04 for sentence-case prose those stop agreeing: a full 42-character
    // source line no longer fits across the frame and libass breaks it in three. Every
    // other scene here is landscape, and so was every test that existed before.
    html:
      '<body style="margin:0;background:#ffffff;font-family:DejaVu Sans,sans-serif;color:#111;font-size:15px">' +
      '<h1 style="margin:0;padding:12px;font-size:20px;background:#12325a;color:#fff">Checkout</h1>' +
      '<div style="padding:10px">Filter the results</div>' +
      '</body>',
  },
]

export interface SceneSize {
  label: string
  width: number
  height: number
}

/** Frame heights: one where the size floors bind, one where they do not. */
export const VISUAL_SIZES: SceneSize[] = [
  // H=320: the caption face is max(16, 16) = 16 and the chip face is max(10, 7.7) = 10, so
  // BOTH floors are active and the outline ratio is at its most dangerous.
  { label: 'small', width: 480, height: 320 },
  // H=720: caption 36, chip 17; neither floor binds.
  { label: 'large', width: 1280, height: 720 },
]

/**
 * The portrait scene's only size.
 *
 * It is not one of `VISUAL_SIZES` because the scene exists FOR this aspect ratio — the
 * character-vs-pixel wrapping disagreement it demonstrates does not happen on a landscape
 * frame, so rendering it at 480x320 would be a third copy of `checkout-top-left`.
 */
export const PORTRAIT_SIZE: SceneSize = { label: 'phone', width: 390, height: 844 }

/** The heights a scene is exercised at. The scene/size matrix, in one place. */
export function sizesForScene(scene: Scene): SceneSize[] {
  return scene.name === 'portrait' ? [PORTRAIT_SIZE] : VISUAL_SIZES
}

/** Output frame rate of every clip in this matrix. Decoded frame `f` is at `f * 100`ms. */
export const SCENE_FPS = 10
/** Wall-clock spacing of the CAPTURED frames — not the decoded ones. */
export const SCENE_FRAME_INTERVAL_MS = 200
/** Captured frames per scene: 10 x 200ms = a 2s clip. */
export const SCENE_FRAME_COUNT = 10

/**
 * The caption every scene carries.
 *
 * Long enough to wrap, and deliberately full of round-countered letters (`o`, `g`, `e`,
 * `a`) so a smudged outline is visible in a rendered frame rather than only in a probe.
 */
export const CAPTION_TEXT = 'Clicking Pay once posts two charge requests and both succeed'

/**
 * The keystrokes every scene carries.
 *
 * `Fill ••••••` is the masked form, `Click` is the label that prefix-merges with the
 * checkout page's `Checkout`, and `Ctrl+A` is the chord form. Three chips at 600/900/1200ms
 * against a 1600ms dwell means all three are up together for the second half of the clip.
 */
export function chipEvents(): StampedInput[] {
  return [inputStamp('Fill ' + '•'.repeat(6), 600), inputStamp('Click', 900), inputStamp('Ctrl+A', 1200)]
}

/** Normalise and wrap exactly as the recorder's `caption()` does at stamp time. */
export function captionStamp(text: string, atMs: number, options?: CaptionOptions): StampedCaption {
  const n = normalizeCaptionText(text)
  const w = n.text === ''
    ? { text: '', adjustments: [] as string[] }
    : wrapCaptionText(n.text, options?.maxCharsPerLine ?? 42, options?.maxLines ?? 3)
  return { text: w.text, atMs, blank: w.text === '', adjustments: [...n.adjustments, ...w.adjustments] }
}

export function inputStamp(label: string, atMs: number): StampedInput {
  return { kind: 'key', label, atMs, adjustments: [] }
}

/** Capture `count` JPEG frames of a scene, applying its `mutate` before each. */
export async function captureSceneFrames(
  browser: Browser,
  scene: Scene,
  width: number,
  height: number,
  count: number,
): Promise<Buffer[]> {
  const ctx = await browser.newContext({ viewport: { width, height } })
  const page = await ctx.newPage()
  try {
    await page.setContent(scene.html)
    const cdp = await ctx.newCDPSession(page)
    const out: Buffer[] = []
    for (let i = 0; i < count; i++) {
      const script = scene.mutate?.(i)
      if (script) await page.evaluate(script)
      // A short settle so the mutation is actually painted before it is captured.
      await new Promise((r) => setTimeout(r, 40))
      // `Page.captureScreenshot` intermittently answers "Unable to capture screenshot" when
      // the compositor has no frame ready yet — observed once in ~250 captures here. It is
      // a property of the harness, not of anything under test, so it is retried rather than
      // allowed to look like a visual regression.
      let shot: { data: string } | undefined
      for (let attempt = 0; attempt < 4 && !shot; attempt++) {
        try {
          shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 })
        } catch (err) {
          if (attempt === 3) throw err
          await new Promise((r) => setTimeout(r, 150))
        }
      }
      out.push(Buffer.from(shot!.data, 'base64'))
    }
    return out
  } finally {
    await page.close()
    await ctx.close()
  }
}
