/**
 * cdp-screencast.ts — gesture-free tab recording.
 *
 * Why this exists alongside `screen-recording.ts`:
 *
 * The tabCapture recorder (`recording.start`) produces a better picture — real
 * compositor output at a fixed frame rate — but `chrome.tabCapture.getMediaStreamId`
 * is gated behind an **activeTab grant that only a genuine user gesture produces**.
 * Neither Playwriter's unconditional tab auto-creation nor the programmatic
 * `toggleExtensionForActiveTab` satisfies Chrome; a human must click the extension
 * icon on that tab. Fine interactively, useless unattended.
 *
 * ASSUMPTION, NOT MEASURED HERE. That paragraph describes the packed extension running in
 * a real Chrome with a real user profile, which cannot be exercised from this repo's test
 * environment (headless Chromium over direct CDP has no extension and no activeTab
 * concept). It is recorded as the reason this file exists, and it is the kind of claim
 * that has been wrong before in this very header — the two retractions below were both
 * confident statements about what the extension debugger API does. What would settle it:
 * calling `chrome.tabCapture.getMediaStreamId` from the loaded extension on a tab reached
 * by auto-creation, and again after a real toolbar click, and comparing the errors.
 *
 * This recorder needs no gesture and works on an ordinary extension-connected
 * session as well as over direct CDP.
 *
 * TAB VISIBILITY IS NOT A CONSTRAINT FOR SCREENCAST. Measured through the extension
 * on an animating page: 30 frames with the tab in the foreground, 31 with another tab
 * in front of it. Two earlier explanations for an empty capture — "the extension
 * debugger API withholds screencast frames" and "a backgrounded tab has no compositor
 * surface" — were both wrong, and both were guesses stated as fact. The real cause of
 * an empty screencast is below: it is change-driven.
 *
 * IT IS A HARD CONSTRAINT FOR THE SCREENSHOT PATH, AND THE TWO DO NOT GENERALISE TO EACH
 * OTHER. That is the single most surprising thing in this file, so both halves are
 * measured on one rig — Chrome for Testing 148 launched directly (none of Playwright's
 * `--disable-renderer-backgrounding` / `--disable-backgrounding-occluded-windows` /
 * `--disable-background-timer-throttling`), driven over raw CDP websockets, two real tabs
 * in one window under Xvfb, so "hidden" means genuinely hidden:
 *
 *                                     foreground        hidden          after bringToFront
 *   Page.startScreencast              59.8 fps          60.0 fps        60.0 fps
 *   Page.captureScreenshot @10fps     9.95-9.97 fps     0.08-0.18 fps   9.95-9.96 fps
 *   ...its longest gap                116-129ms         17.7-26.0s      118-134ms
 *
 * Both rows are with `Emulation.setFocusEmulationEnabled({enabled:true})` on, because
 * Playwright sends it on every main frame (`crPage.js:418`) and so every page Playwriter
 * drives has it. It is what makes the screencast row true: with focus emulation OFF the
 * same hidden tab reports `document.visibilityState === 'hidden'` and screencast delivers
 * 0 frames in 15s. It does NOT rescue captureScreenshot — the screenshot row is the same
 * with it on or off (0.08-0.18 fps hidden with, 1.95-6.31 fps hidden without), and adding
 * Playwright's three switches on top changes nothing (0.08-0.16 fps).
 *
 * What a hidden `captureScreenshot` does is BLOCK, not fail and not lie: across three
 * 38-second hidden windows every attempt returned a frame (260/260, 166/166, 267/267), and
 * a colour changed from outside while the tab was hidden appeared in the next frame to
 * complete, 25-55ms later — zero stale frames. It simply stops returning for up to 26
 * seconds at a stretch, which for a serialised poller is a 26-second hole in the video.
 * That, and only that, is why `startScreenshotPolling` foregrounds the tab.
 *
 * Two capture paths, because screencast can legitimately produce nothing:
 *   - screencast  — change-driven, cheap, preferred. A page that never repaints sends
 *                   essentially no frames; that is the usual reason for `frames: 0`.
 *                   Measured on Chromium 145 over direct CDP: an animating page yields
 *                   177 frames in 3s, a static page whose first paint had already settled
 *                   yields exactly 1 (the initial surface), and a static page captured
 *                   before its first paint settled yields 2. So "0" is what the extension
 *                   path produces; over direct CDP expect one or two frames rather than
 *                   literally none.
 *   - screenshot  — polls `Page.captureScreenshot` (~8.5fps measured through the
 *                   extension, 15.3fps over direct CDP). Produces frames even for a page
 *                   that never repaints.
 *
 * Screencast emits a frame when the page repaints, not on a clock, so we keep each
 * frame's real arrival time and let ffmpeg rebuild constant-rate video from those
 * timestamps — a two-second pause stays two seconds instead of collapsing.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ICDPSession } from './cdp-session.js'

/** A single captured frame: JPEG bytes plus the ms offset from recording start. */
interface CapturedFrame {
  data: Buffer
  offsetMs: number
}

/* ------------------------------------------------------------------ captions */

/**
 * How a caption reaches the viewer.
 *
 * - `'burn'` — painted into the pixels. The default, because the places a bug repro
 *   actually gets watched (a GitHub comment, a Slack preview, a bare `<video>` tag)
 *   show no soft track and offer no way to turn one on. A narration nobody sees is
 *   not narration.
 * - `'soft'`   — a `mov_text` track in the mp4. Toggleable, and the text stays
 *   selectable, but only players with a subtitle menu will surface it.
 * - `'sidecar'`— a `.srt`/`.vtt` written next to the mp4. Nothing renders it on its
 *   own; it exists so the timings can be read, diffed, or re-styled later.
 *
 * They compose: `['burn', 'sidecar']` is a reasonable pairing (watchable anywhere,
 * plus a machine-readable transcript). All three use the SAME resolved cue list, so
 * a sidecar always describes exactly what was burned in.
 */
export type CaptionRender = 'burn' | 'soft' | 'sidecar'

/** A caption with an explicit time, for a caller who already knows the script. */
export interface CaptionInput {
  text: string
  /** ms from recording start — the SAME origin as a frame's `offsetMs`, not video time. */
  atMs: number
  /** End the cue this long after `atMs` instead of running it to the next caption. */
  durationMs?: number
}

export interface CaptionOptions {
  /** One or more of `'burn' | 'soft' | 'sidecar'`. Default `['burn']`. */
  render?: CaptionRender | CaptionRender[]
  /** Which sidecar formats to write when `'sidecar'` is on (default `['srt']`). */
  sidecarFormats?: Array<'srt' | 'vtt'>
  /**
   * Flat floor on how long a cue stays up, in ms. **No default, and not the thing that
   * decides pacing.**
   *
   * Setting it REPLACES the reading-time model below with one number for every cue, which
   * is what the recorder used to do and what made a three-line cue and a two-word cue
   * equally "long enough". It stays because a caller who genuinely wants a flat floor —
   * a fixed-format clip, a test asserting one number — should not have to fight the model.
   * If you just want cues to be readable, leave it unset.
   */
  minDurationMs?: number
  /**
   * Reading rate in characters per second, used to derive each cue's readable time
   * (default 17).
   *
   * 17cps is the Netflix/BBC timed-text figure for adult subtitles, and it is a rate for
   * people who are already looking at the picture. Lower it for a denser script (CJK runs
   * nearer 9), raise it for an audience reading its own jargon.
   */
  readingRateCps?: number
  /** Wrap width in characters (default 42) and the cap on wrapped lines (default 3). */
  maxCharsPerLine?: number
  maxLines?: number
  /** Refuse more than this many cues, so a looping caller cannot grow the result unbounded. */
  maxCaptions?: number
  /** libass font family (default 'DejaVu Sans' — present anywhere ffmpeg+fontconfig is). */
  fontName?: string
  /**
   * Font size as a percentage of the PAGE height (default 5), floored at 16px.
   *
   * The page, not the encoded frame. The frame is taller than the page by the caption
   * strip, and the strip's height is derived from this face — so reading the percentage
   * off the frame would make the face feed its own input and the two would chase each
   * other. Against the page it is also the number a caller means: "how big is the
   * narration next to the thing being narrated".
   */
  fontSizePct?: number
  /**
   * `#RRGGBB` for the caption text. **Default black**, because the caption no longer sits
   * on the page — it sits on the light strip below it, and there is nothing behind it to
   * hide from.
   */
  textColor?: string
  /**
   * `#RRGGBB` for the glyph outline. Defaults to `stripColor`, i.e. to no visible outline.
   *
   * IT IS NO LONGER LOAD-BEARING, AND SAYING SO IS THE POINT. A black outline used to be
   * what made white text legible over an arbitrary page; with the strip the background is
   * known and controlled, so an outline the colour of its own background draws nothing.
   * The mechanism is kept rather than deleted because it is still the thing that keeps a
   * caller-CHOSEN outline from closing the glyph counters — see `defaultOutlineWidth` for
   * the measured ratio, which is unchanged and still enforced.
   */
  outlineColor?: string
  /** Outline thickness in px; default scales with the font. */
  outlineWidth?: number
  /** Drop-shadow offset in px (default 1). */
  shadow?: number
  /**
   * A per-line opaque box behind the text, painted from `outlineColor`, instead of an
   * outline. **Under `boxed`, `outlineWidth` stops being an outline and becomes the box's
   * PADDING** — ASS BorderStyle 3 paints the box from OutlineColour and reads Outline as
   * its inset.
   *
   * A pure look option, and at the defaults a no-op: `outlineColor` defaults to the strip
   * colour, so the box is drawn in the colour it is drawn on. It does something only for a
   * caller who also sets a contrasting `outlineColor`, and then it is a tight plate hugging
   * each line inside the strip.
   *
   * IT USED TO BE OFFERED AS THE MERGE FIX AND IT WAS NEVER ONE. MEASURED on `dense-12px`
   * at 480x320, back when the caption was drawn over the page: with the default 1px padding
   * the box stopped ~3px past the line's final `e` and the page's surviving `s` was still
   * beside it, so the frame still read `charges` — a word in neither layer. Three pixels of
   * plate is not a word boundary to the eye; a space at 12px page text is four. That whole
   * class is now closed by construction rather than by padding — the caption is not on the
   * page at all — so this option carries no guarantee and never did.
   */
  boxed?: boolean
  /**
   * `#RRGGBB` of the strip the caption is drawn on (default `#E8E8E8`).
   *
   * THE STRIP IS APPENDED TO THE FRAME, NOT DRAWN OVER IT. The encoder pads the page
   * render with `stripHeight` extra rows along the bottom and the caption is drawn only
   * there, so the page area of every frame is exactly the pixels the page showed. That is
   * the whole design, and it replaces a full-frame-width opaque band that was composited
   * over the page.
   *
   * WHY THE BAND WAS WRONG. It closed a real defect — overlay text landing beside page text
   * so the composite reads as a word in NEITHER layer, the "Clickkout" class, measured on
   * this exact scene as `charge` + a surviving page `s` = `charges`. But it closed it by
   * blacking out every scanline the caption occupied, edge to edge, for as long as the cue
   * was up. On `dense-12px` at 480x320 that is two full rows of page content destroyed, at
   * the bottom of the frame, which is exactly where status text, totals, toasts and error
   * messages live. A video made to show a bug was covering the part of the page most likely
   * to be carrying it. Occlusion is not a cheaper failure than merging; it is the same
   * failure — evidence that is not in the file — arriving as absence rather than as
   * fabrication.
   *
   * WHY APPENDING IS STRICTLY BETTER RATHER THAN A TRADE. The merge guarantee survives and
   * gets simpler: caption ink and page pixels are in disjoint REGIONS, so no page glyph can
   * share a scanline with a caption glyph, whatever the page says. `mergeShieldFindings` in
   * `video-invariants.ts` asserts exactly that — no caption ink inside the page region —
   * which is a stronger statement than the old per-scanline rule and easier to prove.
   * Against that, the only cost is canvas: the file is `stripHeight` rows taller. The old
   * size objection ("a letterbox grows with the frame") does not survive contact with the
   * arithmetic — the strip is sized to the caption block, which is precisely what the band
   * was sized to, so it is the SAME number of rows, moved off the page instead of onto it.
   *
   * THE COLOUR WAS CHOSEN BY RENDERING AND LOOKING, against both a light page (`dense-12px`,
   * white to all four edges) and a dark one (`solid-dark`, #111). Candidates were pure white,
   * #F2F2F2 and #E8E8E8 with black text, and #151515 with white text. Pure white on a white
   * page reads as one more paragraph of the document — narration indistinguishable from
   * evidence, which is its own defect. A dark strip disappears into a dark page and simply
   * relocates the black slab on a light one. #E8E8E8 is one clear tone step below any white
   * page and the softest of the light options against a dark one.
   */
  stripColor?: string
  /**
   * `#RRGGBB` of the hairline rule between the page and the strip (default `#707070`).
   *
   * `stripRuleHeightPx` rows at the very top of the strip. It exists because the tone step
   * alone is not enough in both directions: against a white page a light strip needs a hard
   * boundary to read as chrome rather than as content, and against a dark page it stops the
   * transition being a raw black-meets-light edge. Verified by rendering both.
   */
  stripRuleColor?: string
}

/**
 * A cue as it ended up in the file. `startMs`/`endMs` are VIDEO time; `atMs` is the
 * wall-clock instant the caller asked for. They differ by `videoStartOffsetMs`, and
 * `adjustments` names every reason the two stopped lining up.
 *
 * An entry with empty `text` is a `clearCaption()` that did NOT take effect — a
 * successful one only bounds the preceding cue and is not listed, because it renders
 * nothing and there is nothing to report about it.
 */
export interface ResolvedCue {
  /** Position in the emitted subtitle file (1-based). `-1` when dropped. */
  index: number
  text: string
  /** Video-time bounds, matching what a player shows. */
  startMs: number
  endMs: number
  /** The wall-clock offset from recording start that produced this cue. */
  atMs: number
  /** True when the cue reached no file. `adjustments` says why. */
  dropped?: boolean
  /** Every mutation applied to this cue, in the order applied. Never silent. */
  adjustments?: string[]
}

/**
 * Whether a human can actually read this clip, in numbers.
 *
 * Every field is on the VIDEO clock and in ms. The one that matters is `cuesTooFast`:
 * anything above zero means the artifact is narrated faster than it can be read, and no
 * amount of encoder cleverness fixes that — the recording has to be paced.
 */
export interface CaptionPacing {
  /** Cues that reached the file. Dropped ones are counted in `captionNote` instead. */
  cues: number
  /** How many of them were on screen for less than their reading time. */
  cuesTooFast: number
  /** Total reading time the narration asks for. */
  narrationNeedsMs: number
  /** How long the video actually is, for comparison with the above. */
  videoDurationMs: number
  /** Total ms by which the too-fast cues fell short, summed. */
  shortfallMs: number
  /** The rate the model used, characters per second. */
  readingRateCps: number
  /** Set when `captionOptions.minDurationMs` replaced the reading model with a flat floor. */
  minDurationMs?: number
}

/** What `caption()` hands back at stamp time. Final times only exist after `stop()`. */
export interface CaptionStamp {
  /** False when the cue was refused (over `maxCaptions`); nothing was recorded. */
  accepted: boolean
  /** Order of arrival, 0-based. Not the final subtitle index — cues can be dropped. */
  seq: number
  /** The normalised, wrapped text that will be rendered. */
  text: string
  /** Wall-clock ms from recording start. */
  atMs: number
  /**
   * Provisional video-time start. Final only if no later frame changes `frames[0]` —
   * which it cannot, so this is exact UNLESS no frame had arrived yet (see `note`).
   */
  videoStartMs: number
  /** A blank stamp: it ends the previous caption and shows nothing. */
  blank: boolean
  note?: string
}

const CAPTION_DEFAULTS = {
  render: ['burn'] as CaptionRender[],
  sidecarFormats: ['srt'] as Array<'srt' | 'vtt'>,
  readingRateCps: 17,
  maxCharsPerLine: 42,
  maxLines: 3,
  maxCaptions: 500,
  fontName: 'DejaVu Sans',
  fontSizePct: 5,
  textColor: '#000000',
  shadow: 1,
  boxed: false,
  stripColor: '#E8E8E8',
  stripRuleColor: '#707070',
} as const

/**
 * The caption's resolved palette, in one place because `formatAss` and
 * `validateVisualOptions` must agree about what `outlineColor` defaults to.
 *
 * `outlineColor` follows `stripColor` rather than a constant: the outline's only remaining
 * job is not to be seen, and a fixed black default would put a black halo around black text
 * on a light strip.
 */
export function resolveCaptionColors(options?: CaptionOptions): {
  text: string
  outline: string
  strip: string
  rule: string
} {
  const strip = options?.stripColor ?? CAPTION_DEFAULTS.stripColor
  return {
    text: options?.textColor ?? CAPTION_DEFAULTS.textColor,
    outline: options?.outlineColor ?? strip,
    strip,
    rule: options?.stripRuleColor ?? CAPTION_DEFAULTS.stripRuleColor,
  }
}

/** Pre-wrap ceiling. Bounds memory before the wrapper has a chance to truncate. */
const MAX_RAW_CAPTION_CHARS = 2000

/**
 * Fixed cost of a cue, on top of the time spent reading its characters.
 *
 * Subtitling rates assume a viewer whose eyes are already on the picture and who is
 * following continuous dialogue. A bug repro is not that: each cue is a fresh
 * instruction, and after reading it the viewer has to look back at the page to see what
 * changed. 600ms is the allowance for that — the saccade to the caption band, the
 * recognition, and the look back. It is why a two-word cue is not a 250ms cue.
 */
const READING_LEAD_IN_MS = 600

/**
 * Nothing is on screen for less than this, however short.
 *
 * The subtitling floor is 5/6 s (833ms) — long enough to register a cue you are already
 * expecting. 1200ms because these clips ask for the look-back above as well, and because
 * a cue this short is a beat the viewer has to act on, not one word of dialogue.
 */
const READING_FLOOR_MS = 1200

/**
 * Ceiling on the DERIVED requirement, not on how long a cue may stay up.
 *
 * Netflix caps a cue at 7s: past that a viewer re-reads it and stops watching the
 * picture. So a cue that would need longer than 7s is a cue that should be split, and
 * demanding 40s of hold time for one is how a pathological `maxLines` turns every clip
 * into a failed pacing check. Cues still run as long as the caller leaves them up.
 */
const READING_CEILING_MS = 7000

/**
 * How long a human needs to read `text`, in ms.
 *
 * `READING_LEAD_IN_MS + characters / readingRateCps`, clamped to
 * [`READING_FLOOR_MS`, `READING_CEILING_MS`]. Characters are counted by code point and
 * include spaces, the way a cps rate is defined.
 *
 * `captionOptions.minDurationMs` short-circuits the whole thing: an explicit flat floor
 * is a deliberate choice, and quietly taking the larger of the two would mean a caller
 * who asked for 400ms cues still got 1200ms ones with no way to say otherwise.
 */
export function readableDurationMs(text: string, options?: CaptionOptions): number {
  if (options?.minDurationMs !== undefined) return Math.max(0, options.minDurationMs)
  const cps = options?.readingRateCps ?? CAPTION_DEFAULTS.readingRateCps
  if (!(cps > 0) || !Number.isFinite(cps)) {
    throw new Error(`captionOptions.readingRateCps must be a positive number of characters per second, got ${JSON.stringify(cps)}.`)
  }
  const chars = [...text.replace(/\n/g, ' ')].length
  const raw = READING_LEAD_IN_MS + (chars / cps) * 1000
  return Math.round(Math.min(READING_CEILING_MS, Math.max(READING_FLOOR_MS, raw)))
}

/* ------------------------------------------------------------ input overlay */

/**
 * Which corner the key/button chips sit in. Default `'bottom-right'`.
 *
 * THE FIRST DEFAULT HERE WAS `'top-left'` AND IT WAS WRONG. The reasoning was that
 * captions own the bottom band (bottom-centre, 5% side margins, so a three-line cue spans
 * ~90% of the width) and that page chrome which overdraws content — scrollbars, toasts,
 * chat widgets — lives on the right. Both of those are true, and both are beside the
 * point: they weigh the overlay against the CAPTION and against other overlays, not
 * against the page being recorded.
 *
 * Rendered over an ordinary checkout page (dark header, then a form) the top-left chips
 * sat on the `<h1>`; the `Click` chip landed on the word "Checkout" and drew "Clickkout".
 * Web content is top- and left-anchored — nav, logo, heading, the first form field are all
 * exactly there — so top-left is the single most destructive corner on a typical page. The
 * emptiest region on the same render is the bottom-right two thirds, which is also why
 * every keystroke overlay on YouTube lives there.
 *
 * The caption conflict that motivated `'top-left'` is real, and is solved properly instead:
 * `formatAss` computes the caption block's actual height from its font size, margin and
 * observed line count, and lifts a bottom-anchored chip strip clear of it. The two can no
 * longer overlap whatever the caption says.
 */
export type InputOverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/**
 * How several live chips are arranged.
 *
 * - `'row'` (default) — one strip along the anchored edge, oldest left, newest at the
 *   corner. One line of height no matter how many chips are up, which matters because the
 *   page underneath is vertically dense: a three-high stack eats three times the page.
 *   It is also the ordinary convention in these videos.
 * - `'stack'` — one chip per line. Worth it when labels are long (a revealed `fill` of a
 *   URL) and a row would be trimmed to fit the frame width.
 */
export type InputOverlayLayout = 'row' | 'stack'

/**
 * One input as the caller observed it, before this file decides how to word it.
 *
 * Deliberately semantic rather than a reconstructed key/mouse event: the wiring in
 * `executor.ts` knows a `fill()` happened and what it filled, and throwing that away to
 * re-derive keystrokes would lose exactly the case that motivates the feature
 * (`page.fill()` dispatches no key events at all).
 */
export type InputAction =
  /** A key or chord in Playwright's own syntax, e.g. `'a'`, `'Control+A'`, `'Shift+ArrowLeft'`. */
  | { kind: 'key'; key: string; /** `'down'`/`'up'` render as held/released. */ phase?: 'press' | 'down' | 'up'; target?: string }
  /** Text delivered as text, not as keystrokes. `target` drives the secret-field heuristic. */
  | { kind: 'text'; text: string; via: 'fill' | 'type' | 'insertText'; target?: string }
  | {
      kind: 'mouse'
      action: 'click' | 'dblclick' | 'down' | 'up' | 'tap' | 'wheel' | 'drag'
      button?: string
      clickCount?: number
      deltaX?: number
      deltaY?: number
      target?: string
    }
  /** Anything else worth a chip: check, uncheck, hover, focus, selectOption, setInputFiles. */
  | { kind: 'action'; verb: string; detail?: string; target?: string }

export type InputEventKind = InputAction['kind']

export interface InputOverlayOptions {
  /** Corner. Default `'bottom-right'` — see `InputOverlayPosition` for why. */
  position?: InputOverlayPosition
  /** Row or stack. Default `'row'` — see `InputOverlayLayout`. */
  layout?: InputOverlayLayout
  /**
   * Font size as a percentage of video height (default 2.4), floored at 10px.
   *
   * Roughly half the caption's 5%. Set by rendering both at 900x560 and looking: at 3.2%
   * the chips read as a second subtitle rather than as an HUD, which is not what a
   * keystroke overlay is for.
   */
  fontSizePct?: number
  /** libass font family. Defaults to the caption font so one recording reads as one thing. */
  fontName?: string
  /** `#RRGGBB` for the chip text (default white). */
  textColor?: string
  /** `#RRGGBB` for the chip background (default black). */
  boxColor?: string
  /**
   * Chip background opacity 0..1. **Default 1, and that is load-bearing rather than
   * cosmetic** — see `chipStripMetrics` for the whole chip-merge argument.
   *
   * IT WAS 0.65, "translucent so page content still shows", and that is exactly what made
   * the worst case possible. A translucent plate does not cover the page: a page glyph
   * UNDER a chip stays visible at `1 - opacity` of its contrast and composites directly
   * with the chip's own letters, which is a merge at zero separation — strictly worse than
   * anything adjacency can produce. The original `Clickkout` was that: a `Click` chip over
   * the word `Checkout`, not beside it.
   *
   * At 1 the covered region is a proof rather than an attenuation: no page pixel inside the
   * plate survives at all, whatever the page is. Lowering it reinstates the defect, and the
   * visual suite's chip merge shield goes red when it is lowered on a page that is not
   * already the box colour.
   *
   * The CAPTION no longer has an equivalent knob, because it no longer has anything behind
   * it: it is drawn in a strip appended below the page rather than composited over it. The
   * chips cannot follow it there — see `chipStripMetrics`.
   */
  boxOpacity?: number
  /** Distance from the two anchored edges, as a percentage of the PAGE height (default 3). */
  marginPct?: number
  /**
   * How long one chip stays up (default 1600ms). A keystroke is instantaneous; one frame
   * is unreadable.
   *
   * Less than a caption's reading time on purpose — a chip is a glance, not prose. `Ctrl+A`
   * is one fixation once you have noticed it, and the noticing is most of the cost: the
   * viewer's eyes are on the page, not on the corner. 1600ms is roughly notice + fixate +
   * look back, and it comfortably outlives the ~500ms `GLANCE_MS` below.
   *
   * The old 900ms was too short for two reasons at once: it was under the time it takes to
   * look away and back at all, and paired with a 3-chip cap it meant an ordinary
   * fill/fill/click/press sequence retired its first chip before anyone saw it.
   */
  dwellMs?: number
  /**
   * Chips on screen at once before the oldest is retired early (default 4).
   *
   * Four, not three, because raising `dwellMs` makes chips overlap MORE, and the common
   * beat in a repro is exactly four inputs — fill, fill, click, press. At three, one of
   * them was always shed. The row is still bounded by width, which is the cap that
   * actually protects the frame.
   */
  maxVisible?: number
  /** Consecutive single-character keys closer than this merge into one chip (default 400ms). */
  coalesceWindowMs?: number
  /** Hard cap on a chip's rendered length (default 26 characters). */
  maxLabelChars?: number
  /** Refuse more than this many events, so a hot loop cannot grow the result unbounded (default 300). */
  maxEvents?: number
  /**
   * Show what was typed. **Off by default** — a repro very often types a password, and a
   * burned-in overlay is forever. With it off, `fill`/`type`/`insertText` render as
   * `Fill ••••••` (a fixed six dots, so not even the length leaks).
   *
   * Turning it on does NOT reveal everything: a target that looks like a secret field is
   * still masked (see `SECRET_TARGET_RE`). The heuristic can only ever add masking, so a
   * miss is never worse than the choice you made explicitly.
   */
  revealTypedText?: boolean
  /**
   * Grab one `Page.captureScreenshot` at each input event (default true when the overlay
   * is on and the capture path is screencast).
   *
   * This is the fix for the frame-grid trap, not a nicety. Screencast is change-driven:
   * typing into a field that renders nothing produces NO frame, so every chip in the
   * sequence snaps back onto the same stale frame and all but the last are dropped as
   * "never seen". Forcing a frame at each event gives every chip a frame of its own.
   */
  captureFrameOnEvent?: boolean
}

const INPUT_DEFAULTS = {
  position: 'bottom-right' as InputOverlayPosition,
  layout: 'row' as InputOverlayLayout,
  fontSizePct: 2.4,
  textColor: '#FFFFFF',
  boxColor: '#000000',
  boxOpacity: 1,
  marginPct: 3,
  dwellMs: 1600,
  maxVisible: 4,
  coalesceWindowMs: 400,
  maxLabelChars: 26,
  maxEvents: 300,
  revealTypedText: false,
} as const

/** Smallest legible chip. Below this libass renders a grey smear, verified by looking. */
const MIN_INPUT_FONT_PX = 10

/**
 * Shortest time a chip can be on screen and still be seen at all.
 *
 * Not a reading time — a chip that survives this long has merely been NOTICED by someone
 * whose attention was on the page. Used only to word the adjustment when a chip is retired
 * early, so "retired to make room" and "retired before anyone could see it" read
 * differently in the result.
 */
const GLANCE_MS = 500

/** What separates two chips inside a row. One dialogue, so libass cannot reflow them. */
const ROW_SEPARATOR = ' · '

/**
 * Advance width of the chip font, as a fraction of its size.
 *
 * MEASURED against this machine's libass 0.15.2 + DejaVu Sans, by rendering a string and
 * the same string doubled and differencing the inked widths — so it is the real advance,
 * kerning included, not a guess. Size-invariant to three decimals across 10/12/24/36px:
 *
 *     Ctrl+Shift+K  0.458      Double click  0.434-0.438     lowercase prose  0.453
 *     Fill ••••••   0.409      Scroll ↓      0.417-0.425     UPPERCASE        0.528
 *     ' · '         0.250-0.269                              digits           0.546
 *     a realistic four-chip row, separators included:        0.390
 *
 * 0.58 is therefore ABOVE every label the chip vocabulary can actually produce, which is
 * the safe direction: the budget comes out ~30-49% smaller than the row really needs and
 * a row is trimmed one chip early, which is reported on the retired chip. It is kept at
 * 0.58 rather than tightened to the measured 0.46 because revealTypedText can put
 * arbitrary text on a chip, and the same measurement puts 'W' at 0.846, '@' at 0.858 and
 * CJK at 0.693 — narrowing the constant to fit the common case would turn a reported
 * early trim into an unreported overflow.
 */
const CHIP_CHAR_WIDTH_RATIO = 0.58

/**
 * Advance of one ASS hard space (`\h`), as a fraction of the font size.
 *
 * MEASURED against this machine's libass 0.15.2 + DejaVu Sans by rendering a BorderStyle-3
 * chip with n hard spaces at each end and differencing the drawn box width. It is the
 * mechanism the chip plate is widened with, so it is measured on the box rather than on the
 * glyphs:
 *
 *     fontSize      10      12      17      24      36
 *     px per \h     2.750   3.250   4.625   6.500   9.813
 *     / fontSize    0.2750  0.2708  0.2721  0.2708  0.2726
 *
 * Two facts fall out of that table and both are load-bearing. libass does NOT trim a hard
 * space at either end of a line — leading and trailing runs each widened the box by the same
 * amount — and the ratio is size-invariant, so a fixed NUMBER of hard spaces buys a clearance
 * that scales with the face instead of a pixel count that stops meaning anything at another
 * frame size. 0.271 is below every measured value, which is the safe direction here: the
 * clearance `chipStripMetrics` CLAIMS is then a lower bound on the one libass draws.
 */
const CHIP_HARD_SPACE_RATIO = 0.271

/**
 * Clear pixels the chip plate must put between chip ink and any page glyph beside it,
 * as a multiple of the chip face.
 *
 * MEASURED, perceptually, and the measurement is reported as a range rather than a point
 * because the question genuinely is one. Rendering the real geometry — a white page, black
 * page text, and an opaque black plate carrying white overlay text ending G clear pixels
 * short of it — and reading the result at 1x and 6x, over `Click`+`out`, `charge`+`s`, and
 * chip/page face pairs 10/12, 12/12, 17/15:
 *
 *     clear px between the two ink runs      2   3   4   5   6   7   8   9   10+
 *     reads as one word                      Y   Y   Y   ?   ?   ?   n   n   n
 *
 * 3px is the documented `charges` failure and it reproduces exactly, which is what says the
 * rig is measuring the right thing.
 *
 * THE PIXEL COUNT IS NOT THE ANSWER, THOUGH, AND THIS IS THE PART THAT MAKES THE RULE
 * TRANSPORTABLE. Word segmentation is not done in pixels, it is done in spaces, so the same
 * sweep measured what a space actually looks like in DejaVu Sans — the CLEAR run between two
 * inked columns:
 *
 *     fontSize          10   12   15   17   22   36
 *     between letters    1    1  1-2  1-2    2  3-4
 *     between words      3    4  5-6    6    8  13-14      (= 0.36 of the face)
 *
 * So the reason 3px failed is not perceptual at all: at 12px page text a SPACE is 4 clear
 * pixels, and 3px is narrower than a space. Nothing separated by less than the page's own
 * word gap can read as a word break. Lining the two tables up, the pairs stop reading as one
 * word at about TWICE the page's inter-word gap — 8px against 4px at 12px text, 9-10px
 * against 6px at 15-17px text — i.e. at roughly `0.72 * pageFontSize`.
 *
 * The page's font size is not knowable here, so the rule is expressed against the one face
 * this file does know. 1.5 chip faces of clearance is therefore proof against page text up
 * to `1.5 / 0.72 = 2.08` times the chip face: 20px page text on a 480x320 frame, 35px on
 * 1280x720, 41px on 390x844. Above that it stops being proof — and the same sweep is why the
 * residual is small rather than merely unmeasured: rendered at 22px page text against a 10px
 * chip, the pair did not read as one word even at ZERO separation, because a 2:1 size step is
 * itself a word boundary. The band where a merge is possible is bounded on both sides.
 */
export const CHIP_MIN_CLEAR_RATIO = 1.5

/**
 * Hard spaces put inboard of the chip labels, which is what buys the clearance above.
 *
 * Six rather than a computed count, because `CHIP_HARD_SPACE_RATIO` is size-invariant and so
 * the arithmetic gives the same answer at every face: reaching `CHIP_MIN_CLEAR_RATIO` needs
 * `(1.5 - pad/fontSize) / 0.271` of them, which is 4.80 at fontSize 10, 4.88 at 17 and 4.98
 * at 20. Five would meet the requirement with under a pixel to spare at every size, which is
 * close enough to the rounding to be luck; six clears it by roughly a third of a face.
 *
 * They go INBOARD only. The outboard side needs no clearance at all because it is given
 * something better — see `chipStripMetrics`.
 */
const CHIP_INBOARD_CLEAR_SPACES = 6

/**
 * The chip strip's resolved geometry, in one place because two functions need it and they
 * must not disagree: `buildInputChips` budgets a row against it and `formatAss` draws it.
 *
 * THE CHIPS STAY ON THE PAGE, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT. The caption
 * moved OFF the page into an appended strip (see `captionOptions.stripColor`), and the
 * obvious next move is to put the chips there too, where they would obstruct nothing and
 * their merge question would vanish the same way the caption's did. It is not done, for
 * three reasons:
 *
 *   - **It would not be the thing that was asked for.** This is a NohBoard-style keystroke
 *     HUD, and a keystroke HUD is by definition ON the recording. Every one of them on
 *     YouTube is. A row of key names in a caption bar is a subtitle about keys, which is a
 *     different and worse artifact.
 *   - **The chip's position is information.** A chip sits in the picture at the moment the
 *     input landed, so the viewer's eye travels between the key and the thing it changed
 *     without leaving the page. Moved into the strip it becomes a second line of narration
 *     competing with the first, at which point it may as well be a caption.
 *   - **It costs almost nothing where it is.** The plate is one line tall in the emptiest
 *     corner of an ordinary page, against a caption band that was three lines across the
 *     full width at the bottom. The two are not the same size of imposition and did not
 *     deserve the same remedy.
 *
 * So the chips keep the geometry below, unchanged, and `chipMergeShieldFindings` still has
 * to pass on it. What DID change is the vertical offset: the frame is now taller than the
 * page by the strip, and a bottom-anchored strip measures its `MarginV` from the frame's
 * bottom edge, so `formatAss` adds the strip height to keep the chips in the same place on
 * the PAGE. The caption-lift reserve that used to sit in that number is gone — there is no
 * longer a caption on the page to be lifted clear of.
 *
 * WHY THE CHIP CANNOT MERGE, AND WHERE THAT STOPS BEING A PROOF.
 *
 * A composite reads as a word that is in neither layer only when two glyph runs sit side by
 * side on the rows they share. The caption is now immune by construction, because it shares
 * no row with the page at all. The chips cannot have that without leaving the page, so the
 * strip is given the strongest thing available to something drawn ON the picture, and it is
 * three separate properties:
 *
 *   1. **UNDER the plate: absolute.** The box is opaque (`boxOpacity` defaults to 1). No page
 *      pixel inside the plate survives, so a chip cannot composite with the page glyph it is
 *      drawn on top of. That was the original `Clickkout` — a chip over a word, not next to
 *      one — and a translucent box is what allowed it.
 *
 *   2. **OUTBOARD of the ink: absolute.** The strip's anchored horizontal margin is ZERO and
 *      the ink is held off the edge by hard spaces instead, so the plate runs continuously
 *      from the chip's ink to the frame edge it is anchored to. On a chip-ink scanline there
 *      is no page pixel on that side AT ALL. It also costs less than clearance would: the
 *      plate grows by the old margin, which is smaller than `CHIP_MIN_CLEAR_RATIO` faces.
 *
 *   3. **INBOARD of the ink: measured, not absolute.** `CHIP_INBOARD_CLEAR_SPACES` hard
 *      spaces put `clearPx` of opaque plate between the ink and the nearest page pixel. See
 *      `CHIP_MIN_CLEAR_RATIO` for what that distance was measured against and for the page
 *      face above which it stops being a proof.
 *
 * AND (3) CANNOT BE MADE ABSOLUTE WHILE THE CHIPS ARE ON THE PAGE. On a row carrying chip
 * ink, either the whole row is overlay — a full-width bar, which is the artifact this
 * refuses — or some page pixel is on it, at some distance, and whether that distance reads
 * as a word break is a perceptual question. There is no third option short of leaving the
 * page, which is the trade weighed at the top of this comment and declined.
 * What can be done is what is done here: make two of the three sides proofs, put a measured
 * number on the third, and CHECK all three on pixels — `chipMergeShieldFindings` in
 * `video-invariants.ts` asserts every one of them on every scene at every frame size.
 */
export interface ChipStripMetrics {
  /** Chip face in px, floored at `MIN_INPUT_FONT_PX`. */
  fontSize: number
  /** Box padding: the ASS `Outline` field under BorderStyle 3. */
  pad: number
  /**
   * `marginPct` in pixels. It is now the distance the INK is held off the anchored edge
   * rather than the distance the BOX is — the box runs to the edge — and it is still the
   * inboard style margin and the base for the vertical one before the caption lift.
   */
  margin: number
  /** Hard spaces inboard of the labels: the measured merge clearance. */
  inboardSpaces: number
  /** Hard spaces outboard of the labels: what `margin` used to do, now that it is zero. */
  outboardSpaces: number
  /** Total width the hard spaces add to a line, in px. Charged against the row budget. */
  hardSpaceWidthPx: number
  /** Opaque plate guaranteed inboard of the ink. A LOWER bound on what libass draws. */
  clearPx: number
  /** What `clearPx` has to reach. `clearPx >= requiredClearPx` is the invariant. */
  requiredClearPx: number
}

export function chipStripMetrics(
  video: { width: number; height: number },
  options?: InputOverlayOptions,
): ChipStripMetrics {
  const fontSize = Math.max(
    MIN_INPUT_FONT_PX,
    Math.round((video.height * (options?.fontSizePct ?? INPUT_DEFAULTS.fontSizePct)) / 100),
  )
  const pad = Math.max(2, Math.round(fontSize / 6))
  const margin = Math.max(4, Math.round((video.height * (options?.marginPct ?? INPUT_DEFAULTS.marginPct)) / 100))
  const space = CHIP_HARD_SPACE_RATIO * fontSize
  // Enough hard spaces to hold the ink where the margin used to hold it, now that the margin
  // itself is zero on that side. At least one, so the ink is never flush against the edge.
  const outboardSpaces = Math.max(1, Math.round((margin - pad) / space))
  return {
    fontSize,
    pad,
    margin,
    inboardSpaces: CHIP_INBOARD_CLEAR_SPACES,
    outboardSpaces,
    hardSpaceWidthPx: Math.ceil((CHIP_INBOARD_CLEAR_SPACES + outboardSpaces) * space),
    // floor, not round: this number is asserted as a lower bound on the rendered geometry.
    clearPx: pad + Math.floor(CHIP_INBOARD_CLEAR_SPACES * space),
    requiredClearPx: Math.round(CHIP_MIN_CLEAR_RATIO * fontSize),
  }
}

/**
 * Advance width of the CAPTION font, as a fraction of its size, used only to predict how
 * many lines libass will really draw (see `renderedCaptionLines`).
 *
 * Same measurement as above. Caption text is prose, so the relevant figures are the
 * sentence-case 0.445, lowercase 0.453, UPPERCASE 0.528 and digits 0.546. 0.6 sits above
 * all four, which is the safe direction HERE for the opposite reason: over-estimating the
 * advance over-estimates the line count, and the line count feeds a reserve that keeps the
 * chips off the captions. Under-estimating it is what lets a chip land on a caption.
 */
const CAPTION_CHAR_WIDTH_RATIO = 0.6

/**
 * Height of a rendered caption block, in pixels.
 *
 * MEASURED, not derived. Rendering 1/2/3-line cues through the real encode and reading the
 * inked rows back gives, for every font size and every font tried (DejaVu Sans, DejaVu
 * Serif, DejaVu Sans Mono, Liberation Sans):
 *
 *   - the baseline-to-baseline pitch is EXACTLY `fontSize` — 10→10, 13→13, 17→17, 24→24,
 *     25→25, 36→36, 54→54. libass normalises the face so its line height is the declared
 *     Fontsize. The 1.2 factor this function used to carry was never measured and is
 *     simply not what libass does;
 *   - the border and shadow are added ONCE around the whole block, not once per line.
 *
 * So `lines * fontSize + 2 * outline + shadow` is the height, and it is a tight upper
 * bound: measured slack over the true inked height is 1px at fontSize 10, 3px at 24, 8px
 * at 54. The old `lines * (round(fontSize * 1.2) + 2 * outline + shadow)` over-reserved by
 * 38% at three lines, which was safe but pushed the chip strip needlessly far up the frame
 * and hit the clamp ceiling on frames where there was no need to.
 */
export function captionBlockHeightPx(lines: number, fontSize: number, outline: number, shadow: number): number {
  return Math.max(1, Math.round(lines)) * fontSize + 2 * outline + shadow
}

/**
 * Blank strip left above and below the caption's drawn extent.
 *
 * A quarter of the face, which is the ordinary vertical padding of a subtitle plate. It is
 * a look decision and can be moved without weakening anything — the merge guarantee comes
 * from the strip being outside the page region, not from its padding.
 *
 * Floored at 2px so a tiny face still gets a visible edge.
 */
export function captionStripPaddingPx(fontSize: number): number {
  return Math.max(2, Math.round(fontSize / 4))
}

/**
 * Rows of `stripRuleColor` at the very top of the strip, separating it from the page.
 *
 * Two rather than one because a single row is swallowed by chroma subsampling in yuv420p —
 * the rule is a horizontal edge one pixel tall, which is exactly what 4:2:0 halves
 * vertically. Verified by rendering.
 */
export const STRIP_RULE_HEIGHT_PX = 2

/**
 * Everything about the caption strip and the frame it turns the page into.
 *
 * `pageHeight` rows of page, then `height` rows of strip; nothing is ever drawn above
 * `pageHeight`, which is the whole guarantee.
 */
export interface CaptionStripMetrics {
  /** The page area as ENCODED, after the even-dimension rounding. Rows `0 .. pageHeight-1`. */
  pageWidth: number
  pageHeight: number
  /** Rows the strip occupies: `pageHeight .. pageHeight + height - 1`. Always even. 0 with no cue. */
  height: number
  /** The rule, occupying the first `ruleHeight` rows of the strip. 0 when there is no strip. */
  ruleHeight: number
  /** The encoded frame. Both even, because yuv420p requires it. */
  videoWidth: number
  videoHeight: number
  /** Caption face, floored at 16px. Derived from `pageHeight`, never from `videoHeight`. */
  fontSize: number
  outline: number
  shadow: number
  /** Blank strip above and below the drawn caption block. */
  pad: number
  /** The ASS `MarginV` that lands the drawn block exactly `pad` above the frame bottom. */
  marginV: number
  /** Rendered line count the strip was sized for — the tallest cue in the clip. */
  lines: number
  stripColor: string
  ruleColor: string
  textColor: string
  outlineColor: string
}

/**
 * Size the strip from the caption, and the frame from the strip.
 *
 * FIXED FOR THE WHOLE CLIP, sized to the TALLEST cue in it, and both halves of that are
 * deliberate.
 *
 * Fixed, because a video stream has one frame size: a strip that grew and shrank per cue
 * would have to be a constant frame with a variable-height coloured band inside it, and
 * then the boundary between page and narration would move under the viewer mid-clip. A
 * moving boundary is its own evidence problem — it reads as the page shifting — and it
 * would put the rule in a different place every few seconds. The page origin stays at
 * (0, 0) for every frame of every clip, which is what makes "the page area is exactly what
 * the page showed" a statement anyone can check with a crop.
 *
 * Sized to the tallest cue rather than to `maxLines`, because the cost of over-sizing is
 * paid in dead canvas on every frame, and a clip whose cues are all one line has no reason
 * to carry three lines of empty strip. This is the same rule the chip reserve used and for
 * the same reason. Note that over-sizing is now the SAFE direction in a way it never was
 * for the band: extra strip covers nothing.
 *
 * THE ARITHMETIC, and every number in it is measured elsewhere in this file:
 *
 *   - `MarginV` measures to the INK box and the border overhangs below it by
 *     `outline + shadow` (verified over 8 style combinations), so `marginV = pad + outline
 *     + shadow` lands the DRAWN bottom exactly `pad` above the frame's bottom edge;
 *   - the line pitch is exactly `fontSize` and the border is added once around the block,
 *     so the drawn block is `captionBlockHeightPx(lines, ...)` tall — a measured upper
 *     bound, slack 1px at fontSize 10 and 3px at 24;
 *   - `lines` comes from `renderedCaptionLines`, which deliberately over-estimates. An
 *     over-estimate now costs a few rows of empty strip instead of a few rows of buried
 *     page, which is why the over-estimate is comfortable rather than merely safe.
 *
 * so `height = ruleHeight + captionBlockHeightPx(...) + 2 * pad`, rounded UP to even. The
 * page dimensions are rounded DOWN to even to match `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
 * which the encoder applies before the pad — PlayRes has to describe the frame libass is
 * actually drawing on, and on an odd-sized capture that is the rounded one. Both halves
 * even means the sum is even, which is what yuv420p requires.
 *
 * `lines <= 0` means no cue is burned, and then there is no strip at all: the encode is
 * byte-for-byte the one this recorder produced before captions existed.
 */
export function captionStripMetrics(
  page: { width: number; height: number },
  lines: number,
  options?: CaptionOptions,
): CaptionStripMetrics {
  const even = (v: number) => Math.max(2, Math.floor(Math.round(v) / 2) * 2)
  const pageWidth = even(page.width)
  const pageHeight = even(page.height)
  const fontSize = Math.max(16, Math.round((pageHeight * (options?.fontSizePct ?? CAPTION_DEFAULTS.fontSizePct)) / 100))
  const outline = options?.outlineWidth ?? defaultOutlineWidth(fontSize)
  const shadow = options?.shadow ?? CAPTION_DEFAULTS.shadow
  const pad = captionStripPaddingPx(fontSize)
  const colors = resolveCaptionColors(options)

  if (!(lines > 0)) {
    return {
      pageWidth,
      pageHeight,
      height: 0,
      ruleHeight: 0,
      videoWidth: pageWidth,
      videoHeight: pageHeight,
      fontSize,
      outline,
      shadow,
      pad,
      marginV: pad + outline + shadow,
      lines: 0,
      ...colors2fields(colors),
    }
  }

  const block = captionBlockHeightPx(lines, fontSize, outline, shadow)
  const raw = STRIP_RULE_HEIGHT_PX + block + 2 * pad
  // Up, never down: rounding down would eat a row of the caption's own border. The odd
  // extra row lands above the block, where it is blank strip.
  const height = raw + (raw % 2)
  return {
    pageWidth,
    pageHeight,
    height,
    ruleHeight: STRIP_RULE_HEIGHT_PX,
    videoWidth: pageWidth,
    videoHeight: pageHeight + height,
    fontSize,
    outline,
    shadow,
    pad,
    marginV: pad + outline + shadow,
    lines: Math.max(1, Math.round(lines)),
    ...colors2fields(colors),
  }
}

function colors2fields(c: { text: string; outline: string; strip: string; rule: string }) {
  return { stripColor: c.strip, ruleColor: c.rule, textColor: c.text, outlineColor: c.outline }
}

/**
 * How many lines libass will REALLY draw for this cue.
 *
 * `wrapCaptionText` wraps at a character count (42 by default); libass wraps at PIXELS.
 * On a landscape frame the two agree closely enough that nobody noticed, but they are not
 * the same rule and they diverge as the frame narrows: at 390x844 the caption face is 42px
 * and the usable width is 351px, so a full 42-character source line measures ~1060px and
 * libass breaks it into THREE. Counting source lines there under-reserves the caption
 * block by 3x and puts the chip strip straight through the narration — which is exactly
 * the failure the reserve exists to prevent, reappearing on a phone-shaped viewport.
 *
 * Deliberately an over-estimate (see `CAPTION_CHAR_WIDTH_RATIO`): reserving a line too
 * many costs a few pixels of chip position, reserving one too few costs the feature.
 */
export function renderedCaptionLines(text: string, usableWidthPx: number, fontSize: number): number {
  if (!(usableWidthPx > 0) || !(fontSize > 0)) return text.split('\n').length
  const perLine = Math.max(1, Math.floor(usableWidthPx / (fontSize * CAPTION_CHAR_WIDTH_RATIO)))
  let lines = 0
  for (const source of text.split('\n')) {
    lines += Math.max(1, Math.ceil([...source].length / perLine))
  }
  return lines
}

/**
 * The outline width that keeps a glyph readable at a given font size.
 *
 * MEASURED. Rendering `e g o a p b` at fontSize x outline and connected-component-labelling
 * the background enclosed by each glyph gives the fraction of each counter that survives.
 * Reading down the counter of `o`, which is the large round one and the only one that moves
 * monotonically with the ratio (see MIN_COUNTER_SURVIVAL in video-invariants.ts for why the
 * others are too small to read a threshold from):
 *
 *     outline/fontSize   1/24   1/20   1/18   1/16   1/14   1/12   1/10   1/8
 *     counter surviving   47%    36%    36%    31%    21%    18%     5%     0%
 *
 * 1/8 closes the counters of `o` outright — the glyph becomes a filled blob — and the
 * whole word reads as a smudge; verified by looking at the render as well as by counting.
 * That is not a hypothetical: the old `Math.max(2, round(fontSize / 16))` produced
 * EXACTLY 1/8 at fontSize 16, which is the caption face on any frame 320px tall or
 * shorter, and 1/10 and 1/12 at fontSize 20 and 24. The floor of 2 was the bug: below
 * fontSize 32 it forced the ratio above the documented 1/16 rather than holding it there.
 *
 * `max(1, floor(fontSize / 16))` keeps the ratio inside (1/32, 1/16] for every fontSize,
 * which is the band where every measured counter survives.
 */
export function defaultOutlineWidth(fontSize: number): number {
  return Math.max(1, Math.floor(fontSize / 16))
}

/**
 * Targets whose contents are masked even when `revealTypedText` is on.
 *
 * A heuristic over the selector text, so it misses `#field3`. That is fine BECAUSE it is
 * only ever additive: the default already masks everything, and this exists so that
 * opting into reveal does not silently opt into revealing a password.
 */
const SECRET_TARGET_RE =
  /pass(word|wd)?|pwd|secret|token|otp\b|\bpin\b|cvv|cvc|ssn|credit|card(num|number)?|api[-_ ]?key|credential|auth|private[-_ ]?key|seed[-_ ]?phrase/i

/** What the viewer sees instead of a secret. Fixed length: even the character count leaks. */
const MASKED_TEXT = '••••••'

export interface CdpScreencastOptions {
  cdp: ICDPSession
  /** Where to write the .mp4 */
  outputPath: string
  /**
   * How frames are obtained.
   *
   * - `'screencast'` — `Page.startScreencast`. Cheap and change-driven; works through
   *   the extension too. Yields (almost) nothing on a page that never repaints. It does
   *   NOT need a foreground tab — that half of this sentence used to be here and was
   *   wrong; see the file header for the 31-backgrounded-vs-30-foreground measurement.
   * - `'screenshot'` — poll `Page.captureScreenshot` (~8.5fps / 118ms per frame
   *   measured through the extension; 15.3fps / 65ms per frame measured over direct CDP
   *   to headless Chromium 145, so the extension hop is most of that cost). Produces
   *   frames even on a static page.
   * - `'auto'` (default) — try screencast, and if no frame arrives within `probeMs`,
   *   switch to screenshot polling. Covers the static-page case and any environment
   *   where screencast frames do not arrive.
   *
   * **THE SCREENSHOT PATH FOREGROUNDS THE TAB, AND `'auto'` CAN REACH IT.** `'screencast'`
   * never does and does not need to (measured 60fps on a hidden tab; see the file header).
   * `'screenshot'` calls `page.bringToFront()` once before polling, and `'auto'` does the
   * same the moment it falls back — which is exactly the static-page case it exists for.
   * So the DEFAULT mode will steal the user's focus on a page that does not repaint within
   * `probeMs`.
   *
   * That is not gold-plating: on a hidden tab a 10fps poll measures 0.08-0.18 fps with
   * single calls blocking up to 26 seconds, so without it the fallback produces a
   * near-empty video. If foregrounding is unacceptable for a given recording, pass
   * `mode: 'screencast'` — it captures a hidden tab at full rate and never foregrounds,
   * at the cost of capturing (almost) nothing from a page that never repaints.
   */
  mode?: 'auto' | 'screencast' | 'screenshot'
  /** How long `'auto'` waits for a screencast frame before falling back (default 1500ms). */
  probeMs?: number
  /**
   * Page handle, used for one thing: `bringToFront()` before screenshot polling starts.
   *
   * Reached by `'screenshot'` always and by `'auto'` whenever it falls back, so this is
   * the option through which the DEFAULT mode can foreground a tab. Omitting it does not
   * make the recording focus-safe in any useful sense — it makes the fallback capture at
   * 0.08-0.18 fps instead of ~10 (file header for the numbers), because nothing then
   * un-hides the tab. To avoid foregrounding, choose `mode: 'screencast'`; do not simply
   * withhold the page.
   */
  page?: { bringToFront(): Promise<void> }
  /** JPEG quality 0-100 (default 70). Lower = smaller files, faster frames. */
  quality?: number
  /** Cap the captured frame width/height; Chrome scales to fit. */
  maxWidth?: number
  maxHeight?: number
  /** Output frame rate for the encoded video (default 10). */
  fps?: number
  /** Hard stop so a forgotten recording cannot fill the disk (default 10 min). */
  maxDurationMs?: number
  /** Cap on retained frames (default 5000 ≈ 165MB at 33KB/frame). */
  maxFrames?: number
  /**
   * Cues known up front, with explicit `atMs` on the RECORDING clock. Callers who
   * narrate as they go should use the handle's `caption()` instead; the two merge,
   * so a pre-supplied script can still be corrected live.
   */
  captions?: CaptionInput[]
  /** Render mode and styling. Ignored when no caption is ever supplied. */
  captionOptions?: CaptionOptions
  /**
   * Burn a small NohBoard-style key/button overlay into a corner. **Off by default.**
   *
   * Nothing is captured on its own — the recorder only renders what is handed to
   * `inputEvent()`. `executor.ts` wires that to Playwright's client instrumentation so
   * every `click`/`fill`/`press`/`wheel` shows up; see `skill.md` for what it misses.
   */
  inputOverlay?: boolean
  /** Position, size, dwell and redaction. Ignored unless `inputOverlay` is true. */
  inputOverlayOptions?: InputOverlayOptions
  /** Events known up front, with explicit `atMs` on the RECORDING clock. Merges with live ones. */
  inputEvents?: Array<{ action: InputAction; atMs: number }>
}

/** What `hold()` waited for, so a caller can assert on the pacing instead of hoping. */
export interface HoldResult {
  /** How long this call actually slept. 0 when the beat was already long enough. */
  waitedMs: number
  /** The reading time of the cue that was on screen; 0 when nothing was captioned. */
  readableMs: number
  /** How long that cue had ALREADY been up when `hold()` was called. */
  onScreenMs: number
  /** Total time the cue will have been up once this resolves. */
  heldForMs: number
  /** The cue's text, or `''` when nothing is captioned. */
  text: string
  note?: string
}

export interface CdpScreencastHandle {
  /** Stop capturing, encode, and return the written file. */
  stop(): Promise<CdpScreencastResult>
  /** Abort without writing anything. */
  cancel(): Promise<void>
  /** Frames captured so far — useful to assert motion was actually recorded. */
  frameCount(): number
  /**
   * Stamp a caption at the current instant. It stays up until the next caption
   * (or the end of the clip) unless `durationMs` says otherwise.
   *
   * `atMs` overrides the stamp time for a caller that knows the real instant —
   * e.g. one that measured when a click landed rather than when it got around to
   * describing it.
   */
  caption(text: string, opts?: { atMs?: number; durationMs?: number }): CaptionStamp
  /** Blank the screen from here on. Same thing as `caption('')`, named so it reads. */
  clearCaption(opts?: { atMs?: number }): CaptionStamp
  /** Cues stamped so far, including blanks. */
  captionCount(): number
  /**
   * Wait until the caption now on screen has been up long enough to read.
   *
   * The point of it over `await new Promise(r => setTimeout(r, 2500))` is that it takes
   * its number from the TEXT, not from the caller's guess, and it counts the time the
   * action itself already took. Reword the caption longer and the pause follows; spend
   * two seconds clicking and it waits two seconds less. A hard-coded sleep does neither,
   * which is exactly how a clip ends up narrated faster than it can be read.
   *
   *     rec.caption('2. Select all in the email field')
   *     await page.click('#email')
   *     await page.keyboard.press('Control+A')
   *     await rec.hold()          // whatever is left of this cue's reading time
   *
   * With nothing captioned — after `clearCaption()`, holding the final broken state — it
   * waits `minMs`, which is what the end of a repro wants: `await rec.hold({ minMs: 3000 })`.
   */
  hold(opts?: { minMs?: number; extraMs?: number }): Promise<HoldResult>
  /**
   * Record one input for the on-screen overlay. A no-op returning `accepted: false` when
   * `inputOverlay` was not requested, so a caller can wire a tap unconditionally.
   *
   * `atMs` overrides the stamp time for a caller that knows when the input really landed.
   */
  inputEvent(action: InputAction, opts?: { atMs?: number }): InputStamp
  /** Events recorded so far. */
  inputEventCount(): number
}

/**
 * An input chip as it ended up in the video. Same contract as `ResolvedCue`: `startMs`
 * and `endMs` are VIDEO time, `atMs` is the recording clock, and `adjustments` names every
 * reason they differ — coalescing, early retirement, truncation and redaction included.
 */
export interface ResolvedInputEvent {
  /** Position in the overlay's own event list (1-based). `-1` when dropped. */
  index: number
  kind: InputEventKind
  /** Exactly the text drawn on the chip, after masking and truncation. */
  label: string
  startMs: number
  endMs: number
  atMs: number
  /** >1 when consecutive keystrokes were merged into this one chip. */
  coalescedCount?: number
  dropped?: boolean
  adjustments?: string[]
}

/** What `inputEvent()` hands back at stamp time. Final times only exist after `stop()`. */
export interface InputStamp {
  /** False when the overlay is off or the event cap is full; nothing was recorded. */
  accepted: boolean
  seq: number
  /** The chip text as it will be drawn — already masked and truncated. */
  label: string
  kind: InputEventKind
  atMs: number
  /** Provisional video-time start; 0 when no frame had arrived yet. */
  videoStartMs: number
  note?: string
}

export interface CdpScreencastResult {
  outputPath: string
  frames: number
  durationMs: number
  /** Which capture path actually produced the frames. */
  mode?: 'screencast' | 'screenshot'
  /** False when nothing repainted, so no video was produced. */
  wrote: boolean
  note?: string
  /**
   * The video timeline is NOT the recording timeline. `encodeFrames` holds each frame
   * until the next one arrived, so video time 0 is the FIRST FRAME'S arrival — which on
   * a slow first paint can be a long way after `startCdpScreencast()` returned.
   *
   * `videoStartOffsetMs` is that gap, and `videoDurationMs = durationMs - it`. Both are
   * reported rather than folded into `durationMs`, because `durationMs` is the honest
   * answer to "how long was the recording" and callers already depend on it (createDemoVideo
   * feeds it wall-clock timestamps). Padding the video to close the gap would change the
   * bytes of every existing no-caption recording for no gain.
   *
   * The encoded file is in practice slightly LONGER than `videoDurationMs` — ffmpeg's
   * concat demuxer gives the repeated final frame a tail — so `videoDurationMs` is a safe
   * lower bound to clamp cues against. MEASURED against ffmpeg 4.4.2 through
   * `buildEncodeArgs`: a list declaring 1.500s total encodes to a 2.000s file, and one
   * declaring 3.000s encodes to 3.700s. Longer in both cases, never shorter, which is the
   * direction that makes it safe to clamp against.
   */
  videoStartOffsetMs?: number
  videoDurationMs?: number
  /** Every cue, in video time, including the ones that were dropped and why. */
  captions?: ResolvedCue[]
  /** Which render modes were actually applied. */
  captionRender?: CaptionRender[]
  /** Sidecar subtitle files written next to the mp4. */
  captionFiles?: string[]
  /**
   * Rows of caption strip appended BELOW the page, when captions were burned in.
   *
   * The encoded video is this much taller than the page it recorded: rows
   * `0 .. height-1-captionStripHeightPx` are exactly the pixels the page showed, and the
   * rest is narration. Reported because it is the number a caller needs to crop the page
   * back out, or to check that claim for themselves. Absent when nothing was burned, in
   * which case the frame is the page.
   */
  captionStripHeightPx?: number
  /** Set when any cue was moved, shortened, truncated or dropped. */
  captionNote?: string
  /**
   * **Read this before handing the clip to anyone.** Present exactly when at least one cue
   * was on screen for less time than its text needs to be read, with the numbers and what
   * to do about it.
   *
   * There is no fix at encode time. Playback speed and frame timing are evidence in a bug
   * repro — a race-condition clip whose timeline has been stretched is worse than no clip —
   * so the only answer is to re-record with pauses between the beats.
   */
  captionPacingWarning?: string
  /** The numbers behind `captionPacingWarning`. Always present when any cue was emitted. */
  captionPacing?: CaptionPacing
  /**
   * Every input chip, in video time, including the ones that were coalesced, retired
   * early or dropped — and why. Present only when `inputOverlay` was on.
   */
  inputEvents?: ResolvedInputEvent[]
  /** Set when any chip was coalesced, retired, truncated, redacted or dropped. */
  inputOverlayNote?: string
}

/**
 * Begin capturing. Returns a handle; call `stop()` to encode and write.
 *
 * The returned promise resolves once Chrome has accepted `Page.startScreencast`,
 * so any action taken after the await is inside the capture window.
 */
export async function startCdpScreencast(options: CdpScreencastOptions): Promise<CdpScreencastHandle> {
  const {
    cdp,
    outputPath,
    quality = 70,
    maxWidth,
    maxHeight,
    fps = 10,
    maxDurationMs = 10 * 60 * 1000,
    maxFrames = 5000,
    mode = 'auto',
    probeMs = 1500,
    page,
    captions: preSuppliedCaptions,
    captionOptions,
    inputOverlay = false,
    inputOverlayOptions,
    inputEvents: preSuppliedInputEvents,
  } = options

  const frames: CapturedFrame[] = []
  const startedAt = Date.now()
  let stopped = false
  let droppedForCap = 0
  // Declared here rather than beside the capture-path setup below: a pre-supplied input
  // event stamps before that code runs, and reading either from the temporal dead zone
  // would throw out of `startCdpScreencast` itself.
  let usedMode: 'screencast' | 'screenshot' = 'screencast'
  let eventCaptureInFlight = false

  const maxCaptions = captionOptions?.maxCaptions ?? CAPTION_DEFAULTS.maxCaptions
  const maxCharsPerLine = captionOptions?.maxCharsPerLine ?? CAPTION_DEFAULTS.maxCharsPerLine
  const maxLines = captionOptions?.maxLines ?? CAPTION_DEFAULTS.maxLines
  const stamped: StampedCaption[] = []
  let captionsRefused = 0

  /**
   * Normalise and wrap once, at stamp time, so `caption()` can hand back the text that
   * will actually be rendered rather than a promise about it.
   */
  function stamp(rawText: string, atMs: number, durationMs?: number): CaptionStamp {
    const seq = stamped.length
    const normalized = normalizeCaptionText(rawText)
    const blank = normalized.text === ''
    const wrapped = blank ? { text: '', adjustments: [] as string[] } : wrapCaptionText(normalized.text, maxCharsPerLine, maxLines)
    const adjustments = [...normalized.adjustments, ...wrapped.adjustments]

    if (stamped.length >= maxCaptions) {
      captionsRefused++
      return {
        accepted: false,
        seq,
        text: wrapped.text,
        atMs,
        videoStartMs: 0,
        blank,
        note: `Refused: already holding the ${maxCaptions}-caption maximum (captionOptions.maxCaptions).`,
      }
    }

    stamped.push({ text: wrapped.text, atMs, durationMs, blank, adjustments })

    // Exact unless nothing has repainted yet — in which case this caption precedes
    // video time 0 and will be clamped there, which the note says out loud.
    const videoStartMs = frames.length > 0 ? Math.max(0, atMs - frames[0].offsetMs) : 0
    const notes = [...adjustments]
    if (frames.length === 0) {
      notes.push('no frame had arrived yet, so this cue starts at the very beginning of the video')
    }
    return {
      accepted: true,
      seq,
      text: wrapped.text,
      atMs,
      videoStartMs,
      blank,
      note: notes.length ? notes.join('; ') : undefined,
    }
  }

  for (const c of preSuppliedCaptions ?? []) {
    if (typeof c?.atMs !== 'number' || !Number.isFinite(c.atMs)) {
      throw new Error('Each entry in `captions` needs a finite numeric atMs (ms from recording start).')
    }
    stamp(c.text, c.atMs, c.durationMs)
  }

  /* ------------------------------------------------------------ input overlay */

  const maxInputEvents = inputOverlayOptions?.maxEvents ?? INPUT_DEFAULTS.maxEvents
  const stampedInputs: StampedInput[] = []
  let inputsRefused = 0
  let eventFramesCaptured = 0
  let eventFramesSkipped = 0

  /**
   * Word the chip once, at stamp time, so `inputEvent()` can hand back exactly what the
   * viewer will read — including the fact that it was masked.
   */
  function stampInput(action: InputAction, atMs: number): InputStamp {
    const seq = stampedInputs.length
    const { label, adjustments, coalesceChar } = formatInputLabel(action, inputOverlayOptions)
    const kind = action.kind

    if (stampedInputs.length >= maxInputEvents) {
      inputsRefused++
      return {
        accepted: false,
        seq,
        label,
        kind,
        atMs,
        videoStartMs: 0,
        note: `Refused: already holding the ${maxInputEvents}-event maximum (inputOverlayOptions.maxEvents).`,
      }
    }

    stampedInputs.push({
      kind,
      label,
      atMs,
      // Only a bare printable key is a candidate for merging into a typed run; a chord
      // is a distinct thing the viewer needs to see on its own.
      ...(coalesceChar !== undefined ? { coalesceChar } : {}),
      adjustments,
    })

    captureFrameForInput()

    const videoStartMs = frames.length > 0 ? Math.max(0, atMs - frames[0].offsetMs) : 0
    const notes = [...adjustments]
    if (frames.length === 0) notes.push('no frame had arrived yet, so this chip starts at the very beginning of the video')
    return { accepted: true, seq, label, kind, atMs, videoStartMs, note: notes.length ? notes.join('; ') : undefined }
  }

  for (const e of preSuppliedInputEvents ?? []) {
    if (typeof e?.atMs !== 'number' || !Number.isFinite(e.atMs)) {
      throw new Error('Each entry in `inputEvents` needs a finite numeric atMs (ms from recording start).')
    }
    if (inputOverlay) stampInput(e.action, e.atMs)
  }

  /**
   * Insert a frame keeping `frames` ascending by `offsetMs`.
   *
   * Screencast frames arrive in order, but an input-triggered screenshot is stamped when
   * it was REQUESTED and pushed when it resolves, so it can land behind a screencast frame
   * that arrived in the meantime. `encodeFrames` computes each frame's hold time as
   * `next.offsetMs - this.offsetMs`; one out-of-order entry there is a negative duration
   * and a corrupt concat list.
   */
  function pushFrame(frame: CapturedFrame): void {
    if (frames.length === 0 || frame.offsetMs >= frames[frames.length - 1].offsetMs) {
      frames.push(frame)
      return
    }
    let i = frames.length - 1
    while (i > 0 && frames[i - 1].offsetMs > frame.offsetMs) i--
    frames.splice(i, 0, frame)
  }

  /**
   * Force a frame at an input event, so the chip has somewhere to be drawn.
   *
   * The frame-grid trap is worse for input than for captions: typing into a field that
   * renders nothing produces NO screencast frame at all, so a whole burst of keystrokes
   * snaps back onto one stale frame and every chip but the last is dropped as "never
   * seen". Stamped at REQUEST time, not completion, because on a page that is not
   * repainting the pixels are the same either way and the request instant is the one the
   * chip needs to line up with.
   *
   * Skipped in `screenshot` mode (the poller already produces frames on a clock) and while
   * a capture is in flight (a fast burst would otherwise queue a screenshot per keystroke).
   */
  function captureFrameForInput(): void {
    if (!inputOverlay) return
    if ((inputOverlayOptions?.captureFrameOnEvent ?? true) === false) return
    if (stopped || usedMode === 'screenshot' || frames.length >= maxFrames) return
    if (eventCaptureInFlight) {
      eventFramesSkipped++
      return
    }
    eventCaptureInFlight = true
    const offsetMs = Date.now() - startedAt
    void cdp
      .send('Page.captureScreenshot', { format: 'jpeg', quality })
      .then((r: any) => {
        if (!stopped && r?.data && frames.length < maxFrames) {
          pushFrame({ data: Buffer.from(r.data, 'base64'), offsetMs })
          eventFramesCaptured++
        }
      })
      .catch(() => {})
      .finally(() => {
        eventCaptureInFlight = false
      })
  }

  const onFrame = (params: { data: string; sessionId: number }) => {
    if (stopped) return
    if (frames.length >= maxFrames) {
      droppedForCap++
      // Still ack, or Chrome stops sending and we silently lose the tail — see the
      // measurement below. The cap must drop frames, not stop the stream: `stop()` still
      // needs the recording to end at the right wall-clock time.
      void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
      return
    }
    pushFrame({ data: Buffer.from(params.data, 'base64'), offsetMs: Date.now() - startedAt })
    // Chrome stops sending once a small number of frames are outstanding, so every frame
    // must be acked. MEASURED against Chromium 145 on an animating page, 3000ms per run:
    //
    //     acking every frame       177 and 178 frames, arriving until the 3000ms mark
    //     acking nothing             3 and   3 frames, all within the first ~106ms
    //
    // The buffer is THREE un-acked frames, not one — an earlier version of this comment
    // said "we get exactly one frame", which is wrong by a factor of three and would have
    // sent anyone debugging a truncated capture looking for the wrong signature. What
    // matters is unchanged: without the ack the stream dies ~100ms in and the remaining
    // 97% of the recording is silently missing.
    void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  }

  cdp.on('Page.screencastFrame' as never, onFrame as never)

  // Deliberately NO bringToFront() here. Screencast does not need a foreground tab:
  // measured through the extension on a backgrounded tab it captured 31 frames, and 30
  // on a foreground one, and re-measured over raw CDP at 60.0 fps hidden against 59.8 fps
  // foreground. Foregrounding steals the user's focus, which is exactly what the "never
  // call bringToFront" rule exists to prevent.
  //
  // `startScreenshotPolling` below DOES foreground, and that is not an inconsistency: the
  // same rig measures the screenshot path at 0.08-0.18 fps on the same hidden tab. The
  // rule is "do not foreground for something that does not need it", and that path needs
  // it. See the file header for both sets of numbers.
  await cdp.send('Page.enable')

  let pollTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Poll `Page.captureScreenshot`. It is a plain request/response command rather than an
   * event stream, so it needs no ack loop and cannot stall the way an un-acked screencast
   * does. Serialised (no overlapping calls) because a backlog only adds latency.
   *
   * This used to read "unlike screencast … the extension debugger API forwards it
   * normally", which implied screencast is NOT forwarded normally — the same wrong belief
   * the file header retracts. Screencast does work through the extension (measured: 30/31
   * frames); the reason this path exists is that screencast is change-driven and a static
   * page produces almost nothing, not that the extension withholds anything.
   */
  async function startScreenshotPolling(): Promise<void> {
    usedMode = 'screenshot'
    /**
     * THIS `bringToFront()` IS LOAD-BEARING, AND IT IS THE ONE PLACE IN THIS FILE THAT IS.
     *
     * It used to be here on the grounds that captureScreenshot "has not been measured the
     * same way" as screencast. It has been now, on the rig described in the file header:
     * Chrome for Testing 148 launched directly with none of Playwright's backgrounding
     * switches, raw CDP websockets, two real tabs in one window under Xvfb, and
     * `Emulation.setFocusEmulationEnabled` set exactly as Playwright sets it — so the
     * measurement is of the configuration the product actually runs in. The poll is this
     * function's own shape: `setInterval(100ms)` with a single in-flight guard, 3 runs of
     * a 38-second hidden window each.
     *
     *                       frames/s   longest gap   calls over 500ms   window blocked
     *   foreground          9.95-9.97  116-129ms     0                  0%
     *   hidden              0.08-0.18  17.7-26.0s    3-4                99-100%
     *   after bringToFront  9.95-9.96  118-134ms     0                  0%
     *
     * The failure is NOT an error and NOT a stale frame — both would have been easier to
     * spot. Every attempt eventually returned a real frame (260/260, 166/166, 267/267),
     * and a colour changed from outside the hidden tab appeared in the next frame to
     * complete, 25-55ms later, with zero frames showing the previous colour. The call just
     * stops returning, for up to 26 seconds, and a serialised poller has no way to work
     * around that: the recording gets a 26-second hole and reports `wrote: true`.
     *
     * Awaited rather than fired and forgotten so the first poll tick cannot land while the
     * tab is still hidden. Best-effort: with no `page` there is nothing to foreground and
     * the poll runs anyway, at the hidden rate above.
     */
    try {
      await page?.bringToFront()
    } catch {
      // Best-effort; if we cannot foreground it the first capture will surface the problem.
    }
    let inFlight = false
    pollTimer = setInterval(() => {
      if (stopped || inFlight || frames.length >= maxFrames) return
      inFlight = true
      void cdp
        .send('Page.captureScreenshot', { format: 'jpeg', quality })
        .then((r: any) => {
          if (!stopped && r?.data) {
            pushFrame({ data: Buffer.from(r.data, 'base64'), offsetMs: Date.now() - startedAt })
          }
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false
        })
    }, Math.max(1000 / fps, 60))
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  if (mode === 'screenshot') {
    await startScreenshotPolling()
  } else {
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      ...(maxWidth ? { maxWidth } : {}),
      ...(maxHeight ? { maxHeight } : {}),
      everyNthFrame: 1,
    })
    if (mode === 'auto') {
      // Nothing in the CDP session says whether an extension is in the path, so detect
      // by observation: no frame within probeMs means screencast will never deliver.
      //
      // THIS IS THE LINE THAT LETS THE DEFAULT MODE FOREGROUND THE TAB. Falling back
      // enters `startScreenshotPolling`, which calls `page.bringToFront()`; see the
      // measurement there for why it has to. A caller for whom that is unacceptable wants
      // `mode: 'screencast'`, which never reaches this path.
      setTimeout(() => {
        if (!stopped && frames.length === 0) {
          void cdp.send('Page.stopScreencast').catch(() => {})
          void startScreenshotPolling()
        }
      }, probeMs).unref?.()
    }
  }

  const guard = setTimeout(() => {
    if (!stopped) void teardown().catch(() => {})
  }, maxDurationMs)
  // A stray timer must not hold the process open.
  if (typeof guard.unref === 'function') guard.unref()

  async function teardown(): Promise<void> {
    if (stopped) return
    stopped = true
    clearTimeout(guard)
    if (pollTimer) clearInterval(pollTimer)
    cdp.off?.('Page.screencastFrame' as never, onFrame as never)
    try {
      await cdp.send('Page.stopScreencast')
    } catch {
      // Tab may already be gone; nothing to stop.
    }
  }

  return {
    frameCount: () => frames.length,
    captionCount: () => stamped.length,

    caption(text: string, opts?: { atMs?: number; durationMs?: number }): CaptionStamp {
      if (stopped) {
        throw new Error('This CDP screencast has already stopped; captions must be stamped while it is running.')
      }
      const atMs = opts?.atMs ?? Date.now() - startedAt
      if (!Number.isFinite(atMs)) throw new Error('caption atMs must be a finite number of ms from recording start.')
      return stamp(text, atMs, opts?.durationMs)
    },

    clearCaption(opts?: { atMs?: number }): CaptionStamp {
      if (stopped) {
        throw new Error('This CDP screencast has already stopped; captions must be stamped while it is running.')
      }
      return stamp('', opts?.atMs ?? Date.now() - startedAt)
    },

    async hold(opts?: { minMs?: number; extraMs?: number }): Promise<HoldResult> {
      if (stopped) {
        throw new Error('This CDP screencast has already stopped; hold() paces a running recording.')
      }
      const nowMs = Date.now() - startedAt
      // The cue on screen is the latest stamp at or before now — a pre-supplied script can
      // hold cues that have not happened yet, and a later stamp at the same instant wins
      // for the same reason `buildCues` sorts stably.
      let current: StampedCaption | undefined
      for (const c of stamped) {
        if (c.atMs <= nowMs && (current === undefined || c.atMs >= current.atMs)) current = c
      }
      const readableMs = current && !current.blank ? readableDurationMs(current.text, captionOptions) : 0
      const floorMs = Math.max(0, opts?.minMs ?? READING_FLOOR_MS)
      // One output frame of headroom. A cue has to be readable as RENDERED, and both its
      // edges are snapped onto the frame grid — so waiting exactly the reading time can
      // still land a few ms under it once buildCues quantises, and hold() would have
      // promised a readable beat and delivered a reported deficit.
      const gridMs = Math.ceil(1000 / Math.max(1, fps))
      const target = Math.max(readableMs, floorMs) + gridMs + Math.max(0, opts?.extraMs ?? 0)

      /**
       * How long the cue has been on screen IN THE VIDEO — which is not how long ago it
       * was stamped.
       *
       * Video time 0 is the first repaint, and a cue stamped before it is clamped there.
       * Measured on the paced repro: the first frame arrived 724ms after `startCdp`, the
       * opening caption was stamped 17ms in, and it lost every one of those 707ms. So a
       * hold that counted wall clock left the very first beat short no matter how
       * patiently the caller waited. With no frame yet there is nothing to correct
       * against, so wall clock is the only estimate available.
       */
      const onScreenNow = (): number => {
        if (!current) return 0
        const now = Date.now() - startedAt
        const showingSinceMs = frames.length > 0 ? Math.max(current.atMs, frames[0].offsetMs) : current.atMs
        return Math.max(0, now - showingSinceMs)
      }

      const onScreenMs = onScreenNow()
      let waitedMs = 0
      // Two passes, because the first frame may only arrive DURING the wait — and until
      // it does, how much of the hold the video will actually show is unknowable. The
      // second pass tops up by exactly what the first repaint turned out to cost.
      for (let pass = 0; pass < 2; pass++) {
        const remaining = Math.max(0, Math.round(target - onScreenNow()))
        if (remaining === 0) break
        await new Promise((r) => setTimeout(r, remaining))
        waitedMs += remaining
      }
      return {
        waitedMs,
        readableMs,
        onScreenMs: Math.round(onScreenMs),
        heldForMs: Math.round(onScreenNow()),
        text: current && !current.blank ? current.text : '',
        ...(readableMs === 0
          ? {
              note:
                `Nothing is captioned right now, so this held ${target}ms rather than a reading time. ` +
                `That is the right call after clearCaption() — pass minMs to choose how long the final state sits on screen.`,
            }
          : {}),
      }
    },

    inputEventCount: () => stampedInputs.length,

    inputEvent(action: InputAction, opts?: { atMs?: number }): InputStamp {
      if (stopped) {
        throw new Error('This CDP screencast has already stopped; input events must be recorded while it is running.')
      }
      // A no-op rather than a throw: the tap in executor.ts is attached for the life of
      // the recording, and an overlay-less recording should not be a stream of errors.
      if (!inputOverlay) {
        return {
          accepted: false,
          seq: -1,
          label: '',
          kind: action.kind,
          atMs: opts?.atMs ?? Date.now() - startedAt,
          videoStartMs: 0,
          note: 'The input overlay is off for this recording; start it with inputOverlay: true.',
        }
      }
      const atMs = opts?.atMs ?? Date.now() - startedAt
      if (!Number.isFinite(atMs)) throw new Error('inputEvent atMs must be a finite number of ms from recording start.')
      return stampInput(action, atMs)
    },

    async cancel() {
      await teardown()
      frames.length = 0
      stamped.length = 0
      stampedInputs.length = 0
    },

    async stop(): Promise<CdpScreencastResult> {
      await teardown()
      const durationMs = Date.now() - startedAt

      if (frames.length === 0) {
        const empty = buildCues({ captions: stamped, frameOffsetsMs: [], durationMs, options: captionOptions })
        const emptyInputs = buildInputChips({
          events: stampedInputs,
          frameOffsetsMs: [],
          durationMs,
          options: inputOverlayOptions,
        })
        return {
          outputPath,
          frames: 0,
          durationMs,
          mode: usedMode,
          wrote: false,
          ...(stamped.length ? { captions: empty.cues, captionNote: empty.note } : {}),
          ...(stampedInputs.length ? { inputEvents: emptyInputs.events, inputOverlayNote: emptyInputs.note } : {}),
          // Screencast is change-driven, so "nothing repainted" is the ordinary reason
          // for an empty capture and the one worth naming first. Tab visibility is NOT
          // a cause — a backgrounded tab records fine (31 frames vs 30 foreground,
          // measured through the extension; 60.0 fps hidden vs 59.8 fps foreground
          // re-measured over raw CDP, see the file header).
          //
          // The remedy this names does have a cost, and saying "use screenshot mode"
          // without it would be the same kind of half-true this file has been burned by:
          // that path foregrounds the tab.
          note:
            'No frames captured. `screencast` only emits on repaint, so a page that did ' +
            'not change during the recording sends nothing. Use mode: "screenshot" (or ' +
            '"auto", which falls back to it) to capture a static page — note that both ' +
            'call bringToFront() on the tab, because a hidden tab polls at ~0.1fps with ' +
            'single captures blocking for up to 26s — or record for longer / while ' +
            'something actually animates. Tab focus is not the reason THIS capture was ' +
            'empty: screencast records a backgrounded tab normally.',
        }
      }

      const frameOffsetsMs = frames.map((f) => f.offsetMs)
      // Measured ONCE, here, and handed to everything downstream. Both consumers used to
      // read it themselves and both defaulted around a `null`; see `resolveFrameSize`.
      const videoSize = resolveFrameSize(frames)
      const built = buildCues({ captions: stamped, frameOffsetsMs, durationMs, options: captionOptions })
      const builtInputs = buildInputChips({
        events: stampedInputs,
        frameOffsetsMs,
        durationMs,
        options: inputOverlayOptions,
        // A row has to fit across the frame, and only the frame knows how wide that is.
        video: { width: videoSize.width, height: videoSize.height },
      })

      const encoded = await encodeFrames({
        frames,
        outputPath,
        fps,
        durationMs,
        captions: built.cues,
        captionOptions,
        inputSegments: builtInputs.segments,
        inputOverlayOptions,
        videoSize: { width: videoSize.width, height: videoSize.height },
      })

      // Escaping the burn-in text can itself change what the viewer reads (braces,
      // backslash-before-N); fold that back onto the cue so the result still accounts
      // for every difference between what was asked for and what is on screen.
      for (const [index, extra] of encoded.extraAdjustments) {
        const cue = built.cues.find((c) => c.index === index)
        if (cue) cue.adjustments = [...(cue.adjustments ?? []), ...extra]
      }
      for (const [index, extra] of encoded.inputAdjustments) {
        const event = builtInputs.events.find((e) => e.index === index)
        if (event) event.adjustments = [...(event.adjustments ?? []), ...extra]
      }

      const notes = [
        droppedForCap > 0 ? `Hit the ${maxFrames}-frame cap; dropped ${droppedForCap} later frames.` : undefined,
        captionsRefused > 0 ? `${captionsRefused} caption(s) refused past the ${maxCaptions}-caption cap.` : undefined,
        inputsRefused > 0 ? `${inputsRefused} input event(s) refused past the ${maxInputEvents}-event cap.` : undefined,
        // Frames of differing size change what the overlay means; never silent.
        videoSize.note,
        // Named because it changes what was captured: these frames exist only because the
        // overlay asked for them, and they show up in `frames`.
        eventFramesCaptured > 0
          ? `Captured ${eventFramesCaptured} extra frame(s) at input events so the chips had a frame to render on` +
            (eventFramesSkipped > 0 ? `; skipped ${eventFramesSkipped} while an earlier capture was still in flight.` : '.')
          : undefined,
      ].filter(Boolean)

      return {
        outputPath,
        frames: frames.length,
        durationMs,
        mode: usedMode,
        wrote: true,
        note: notes.length ? notes.join(' ') : undefined,
        videoStartOffsetMs: built.videoStartOffsetMs,
        videoDurationMs: built.videoDurationMs,
        ...(encoded.strip ? { captionStripHeightPx: encoded.strip.height } : {}),
        ...(stamped.length
          ? {
              captions: built.cues,
              captionRender: encoded.render,
              ...(encoded.files.length ? { captionFiles: encoded.files } : {}),
              // The pacing warning leads `captionNote` as well as standing on its own,
              // because `captionNote` is the field a caller already reads when it wants
              // to know whether the narration survived — and this is the answer to that
              // question that matters most.
              ...(built.note || built.pacingWarning
                ? { captionNote: [built.pacingWarning, built.note].filter(Boolean).join(' ') }
                : {}),
              ...(built.pacing ? { captionPacing: built.pacing } : {}),
              ...(built.pacingWarning ? { captionPacingWarning: built.pacingWarning } : {}),
            }
          : {}),
        ...(stampedInputs.length
          ? {
              inputEvents: builtInputs.events,
              ...(builtInputs.note || encoded.inputNote
                ? { inputOverlayNote: [builtInputs.note, encoded.inputNote].filter(Boolean).join(' ') }
                : {}),
            }
          : {}),
      }
    },
  }
}

/* ------------------------------------------------- caption text normalisation */

/**
 * Fold caller text into something every one of the three formats can carry.
 *
 * The hazards are format-specific and mostly invisible until they bite:
 *   - a BLANK LINE terminates a cue in SRT and WebVTT, so runs of them collapse;
 *   - control characters corrupt the burn path's ASS parse;
 *   - CRLF confuses SRT parsers that split on '\n'.
 * `-->`, `<`, `>` and `{}` are NOT touched here — they are hazards of the specific
 * format, handled where that format is written, so the same text survives into a
 * sidecar unmangled.
 */
export function normalizeCaptionText(input: string): { text: string; adjustments: string[] } {
  const adjustments: string[] = []
  if (typeof input !== 'string') throw new TypeError('caption text must be a string')

  let text = input
  if (text.length > MAX_RAW_CAPTION_CHARS) {
    text = text.slice(0, MAX_RAW_CAPTION_CHARS)
    adjustments.push(`text cut to ${MAX_RAW_CAPTION_CHARS} characters before wrapping`)
  }
  text = text.replace(/\r\n?/g, '\n')
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  if (stripped !== text) adjustments.push('control characters removed')
  text = stripped
  // A blank line ends a cue in both SRT and WebVTT; keeping one would split the cue
  // in half and leave the tail masquerading as a new one.
  const unblanked = text.replace(/\n[ \t]*\n+/g, '\n')
  if (unblanked !== text) adjustments.push('blank lines collapsed (they terminate a cue in SRT/VTT)')
  text = unblanked
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()

  return { text, adjustments }
}

/**
 * Greedy word wrap, then a hard line cap.
 *
 * Truncating loses narration, which is bad — but a twelve-line caption covering the
 * bug it is describing is worse, and silently letting it happen is worst. The caller
 * gets both the cap and an adjustment naming it.
 */
export function wrapCaptionText(
  text: string,
  maxCharsPerLine: number,
  maxLines: number,
): { text: string; adjustments: string[] } {
  const adjustments: string[] = []
  const out: string[] = []

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/ +/)) {
      let rest = word
      // A single token longer than the line (a URL, a selector) has to be broken
      // mid-token or it overflows the frame.
      while (rest.length > maxCharsPerLine) {
        if (line) {
          out.push(line)
          line = ''
        }
        out.push(rest.slice(0, maxCharsPerLine))
        rest = rest.slice(maxCharsPerLine)
      }
      if (!line) line = rest
      else if (line.length + 1 + rest.length <= maxCharsPerLine) line += ' ' + rest
      else {
        out.push(line)
        line = rest
      }
    }
    out.push(line)
  }

  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines)
    const last = kept[maxLines - 1]
    kept[maxLines - 1] = last.length >= maxCharsPerLine ? last.slice(0, Math.max(maxCharsPerLine - 1, 1)) + '…' : last + ' …'
    adjustments.push(`truncated to ${maxLines} lines of ${maxCharsPerLine} characters`)
    return { text: kept.join('\n'), adjustments }
  }
  return { text: out.join('\n'), adjustments }
}

/* ------------------------------------------------------- cue timing resolution */

/** A caption as stamped, before it knows anything about the video timeline. */
export interface StampedCaption {
  text: string
  atMs: number
  durationMs?: number
  /** A blank sentinel: bounds the previous cue, renders nothing. */
  blank: boolean
  /** Carried through from normalisation/wrapping so nothing is lost on the way. */
  adjustments: string[]
}

export interface BuildCuesResult {
  /** Every cue, emitted and dropped, in video-time order. */
  cues: ResolvedCue[]
  videoStartOffsetMs: number
  videoDurationMs: number
  /** Present when anything at all was adjusted. */
  note?: string
  /** Readability of the clip as a whole. Absent when no cue reached the file. */
  pacing?: CaptionPacing
  /** Present exactly when `pacing.cuesTooFast > 0`. */
  pacingWarning?: string
}

/**
 * Turn stamped captions into cues on the VIDEO timeline.
 *
 * Pure on purpose: the timing rules below are the part of captioning that is easy to
 * get quietly wrong, and this way they are testable without an encode.
 *
 * Two shifts happen here, and both are real:
 *
 * 1. **The video does not start when the recording did.** `encodeFrames` holds frame i
 *    for `next.offsetMs - this.offsetMs`, so video time 0 is `frames[0].offsetMs`. A
 *    caption stamped at wall-clock C belongs at `C - frames[0].offsetMs`. Skip this and
 *    every caption is late by the first repaint, which on a slow page is seconds.
 *
 * 2. **The video only changes at a captured frame.** Burned subtitles are drawn by a
 *    filter, and a filter only runs on frames that exist — measured: a cue spanning
 *    1.00s–1.50s over frames at 0s/1s/2s rendered on the 1s frame and stayed up for its
 *    whole 1s–2s display span. So a cue whose window contains no frame would be
 *    INVISIBLE. Snapping both edges onto the frame grid makes the reported time equal
 *    what is actually seen, and guarantees every surviving cue gets at least one frame.
 */
export function buildCues({
  captions,
  frameOffsetsMs,
  durationMs,
  options,
}: {
  captions: StampedCaption[]
  /** Frame arrival offsets from recording start, ascending. */
  frameOffsetsMs: number[]
  durationMs: number
  options?: CaptionOptions
}): BuildCuesResult {
  const readingRateCps = options?.readingRateCps ?? CAPTION_DEFAULTS.readingRateCps
  const { videoStartOffsetMs, videoDurationMs, frameTimes } = videoTimeline({ frameOffsetsMs, durationMs })

  if (frameOffsetsMs.length === 0) {
    return {
      cues: captions
        .filter((c) => !c.blank)
        .map((c) => ({
          index: -1,
          text: c.text,
          startMs: 0,
          endMs: 0,
          atMs: c.atMs,
          dropped: true,
          adjustments: [...c.adjustments, 'dropped: no frames were captured, so there is no video to caption'],
        })),
      videoStartOffsetMs: 0,
      videoDurationMs: 0,
      note: captions.length > 0 ? 'All captions dropped: nothing was captured.' : undefined,
    }
  }

  type Work = StampedCaption & { adjustments: string[]; startMs: number; endMs: number; dropped: boolean }

  const outOfOrder = captions.some((c, i) => i > 0 && c.atMs < captions[i - 1].atMs)
  const work: Work[] = captions
    .map((c, i) => ({ c, i }))
    // Stable: equal stamps keep arrival order, so the later caption still wins.
    .sort((a, b) => a.c.atMs - b.c.atMs || a.i - b.i)
    .map(({ c }) => ({
      ...c,
      adjustments: outOfOrder ? [...c.adjustments, 'captions were not in chronological order; sorted by time'] : [...c.adjustments],
      startMs: 0,
      endMs: 0,
      dropped: false,
    }))

  // --- starts, on the continuous video timeline ---
  for (const w of work) {
    const raw = w.atMs - videoStartOffsetMs
    if (raw < 0) {
      w.startMs = 0
      w.adjustments.push(
        `stamped ${Math.round(-raw)}ms before the first captured frame; clamped to the start of the video`,
      )
    } else if (raw >= videoDurationMs) {
      w.dropped = true
      w.adjustments.push(
        `dropped: stamped at video time ${Math.round(raw)}ms, at or past the ${Math.round(videoDurationMs)}ms end of the clip`,
      )
    } else {
      w.startMs = raw
    }
  }

  // --- snap onto the frame grid, then let each cue run to the next stamp ---
  const live = work.filter((w) => !w.dropped)
  for (const w of live) {
    const snapped = lastAtOrBefore(frameTimes, w.startMs)
    if (Math.abs(snapped - w.startMs) >= 1) {
      w.adjustments.push(
        `moved ${Math.round(w.startMs - snapped)}ms earlier onto the frame captured at ${Math.round(snapped)}ms — the video does not change between frames`,
      )
    }
    w.startMs = snapped
  }

  // Walk backwards so each cue knows where the next one starts. Blanks are boundaries
  // and nothing else: that is the whole point of `clearCaption()`.
  //
  // Readability is measured in the same pass, because "how long was this on screen" and
  // "how long does it need" only line up once the following cue has bounded it.
  let narrationNeedsMs = 0
  let shortfallMs = 0
  let cuesTooFast = 0
  let emittedCues = 0
  let nextStartMs = videoDurationMs
  for (let i = live.length - 1; i >= 0; i--) {
    const w = live[i]
    if (w.startMs >= nextStartMs) {
      w.dropped = true
      w.adjustments.push(
        w.blank
          ? 'dropped: nothing repainted before the following caption, so this blank had no frame to clear'
          : 'dropped: the next caption lands on the same captured frame, so this one would never be seen',
      )
      continue
    }
    if (!w.blank) {
      const wanted = w.durationMs !== undefined && w.durationMs > 0 ? w.startMs + w.durationMs : nextStartMs
      if (w.durationMs !== undefined && w.durationMs <= 0) {
        w.adjustments.push(`durationMs ${w.durationMs} is not positive; ran the cue to the next caption instead`)
      }
      let end = Math.min(wanted, nextStartMs, videoDurationMs)
      if (wanted > nextStartMs) {
        w.adjustments.push(`shortened to ${Math.round(nextStartMs - w.startMs)}ms by the caption that follows`)
      }
      // Snap the end forward: the cue stays visible until a frame WITHOUT it appears,
      // so the reported end is the moment the viewer actually stops seeing it.
      end = Math.min(firstAtOrAfter(frameTimes, end, videoDurationMs), nextStartMs)
      w.endMs = end

      // --- readability, per cue ---
      //
      // The old check compared against one flat number for every cue, so a 32-character
      // instruction and the word "Done" were both "fine" at 700ms. This compares against
      // what THIS text needs, and names the thing that cut it short — because "hold the
      // beat longer" and "stop the recording later" are different fixes.
      const shownMs = end - w.startMs
      const readableMs = readableDurationMs(w.text, options)
      emittedCues++
      narrationNeedsMs += readableMs
      if (shownMs < readableMs) {
        const deficit = Math.round(readableMs - shownMs)
        shortfallMs += deficit
        cuesTooFast++
        const boundedByNext = nextStartMs < videoDurationMs
        const cause =
          w.durationMs !== undefined && w.durationMs > 0 && w.startMs + w.durationMs <= nextStartMs
            ? `durationMs: ${w.durationMs} ended it early, which is less than its reading time — raise or drop it`
            : boundedByNext
              ? `the next caption arrived ${Math.round(nextStartMs - w.startMs)}ms later — hold this beat before narrating again`
              : `the recording stopped ${Math.round(videoDurationMs - w.startMs)}ms after it appeared — let the final state sit on screen before stopCdp`
        const basis =
          options?.minDurationMs !== undefined
            ? `the ${options.minDurationMs}ms captionOptions.minDurationMs floor`
            : `${[...w.text.replace(/\n/g, ' ')].length} characters at ${readingRateCps} chars/sec`
        w.adjustments.push(
          `on screen for ${Math.round(shownMs)}ms but needs about ${readableMs}ms to read (${basis}); ` +
            `${deficit}ms too fast — ${cause}`,
        )
      }
    }
    nextStartMs = w.startMs
  }

  const cues: ResolvedCue[] = []
  let index = 0
  for (const w of work) {
    if (w.blank && !w.dropped) continue // did its job as a boundary; renders nothing
    const dropped = w.dropped
    cues.push({
      index: dropped ? -1 : ++index,
      text: w.text,
      startMs: Math.round(w.startMs),
      endMs: Math.round(w.endMs),
      atMs: w.atMs,
      ...(dropped ? { dropped: true } : {}),
      ...(w.adjustments.length ? { adjustments: w.adjustments } : {}),
    })
  }

  const droppedCount = cues.filter((c) => c.dropped).length
  const adjustedCount = cues.filter((c) => !c.dropped && c.adjustments?.length).length
  const note =
    droppedCount || adjustedCount
      ? `${droppedCount} caption(s) dropped, ${adjustedCount} adjusted — see captions[].adjustments.`
      : undefined

  const pacing: CaptionPacing | undefined =
    emittedCues > 0
      ? {
          cues: emittedCues,
          cuesTooFast,
          narrationNeedsMs: Math.round(narrationNeedsMs),
          videoDurationMs: Math.round(videoDurationMs),
          shortfallMs: Math.round(shortfallMs),
          readingRateCps,
          ...(options?.minDurationMs !== undefined ? { minDurationMs: options.minDurationMs } : {}),
        }
      : undefined

  return {
    cues,
    videoStartOffsetMs,
    videoDurationMs,
    note,
    ...(pacing ? { pacing } : {}),
    ...(pacing && pacing.cuesTooFast > 0 ? { pacingWarning: formatPacingWarning(pacing) } : {}),
  }
}

/**
 * The one thing in this result an agent must not skim past.
 *
 * Written as prose rather than left to the caller to assemble from `pacing`, because the
 * failure it describes has a counter-intuitive fix: the instinct is to slow the video
 * down, and slowing a bug repro down destroys the evidence it was made to carry. So the
 * text names the fix (re-record with pauses) and forecloses the wrong one.
 *
 * Two shapes, because the two situations need different advice. When the narration needs
 * more time than the whole clip has, no rearrangement of the pauses can save it. When it
 * fits, the pauses are merely in the wrong places.
 */
export function formatPacingWarning(pacing: CaptionPacing): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  const plural = pacing.cuesTooFast === 1 ? 'caption was' : 'captions were'
  const overrun = pacing.narrationNeedsMs > pacing.videoDurationMs
  const rate =
    pacing.minDurationMs !== undefined
      ? `the ${pacing.minDurationMs}ms floor you set`
      : `${pacing.readingRateCps} characters per second plus ${s(READING_LEAD_IN_MS)} to look at the page, ${s(READING_FLOOR_MS)} minimum`

  return (
    `TOO FAST TO READ: ${pacing.cuesTooFast} of ${pacing.cues} ${plural} on screen for less time than the text needs ` +
    `— ${s(pacing.shortfallMs)} short in total. ` +
    (overrun
      ? `The narration needs ${s(pacing.narrationNeedsMs)} of reading time and the clip is only ${s(pacing.videoDurationMs)} long, ` +
        `so nobody watching can follow it. `
      : `The narration needs ${s(pacing.narrationNeedsMs)} of reading time in a ${s(pacing.videoDurationMs)} clip, so there is room — ` +
        `the pauses are in the wrong places. `) +
    `Re-record and hold each beat until its caption has been up for its full reading time (${rate}), ` +
    `then leave the final state on screen alone for a few seconds before stopCdp. ` +
    `Do NOT slow the video down to compensate: frame timing is the evidence in a repro.`
  )
}

/**
 * The one place the recording clock becomes the video clock.
 *
 * Shared by captions and the input overlay rather than derived twice: the whole class of
 * "everything is late by the first repaint" bugs comes from one of two consumers
 * computing this differently from the other.
 */
export function videoTimeline({
  frameOffsetsMs,
  durationMs,
}: {
  frameOffsetsMs: number[]
  durationMs: number
}): { videoStartOffsetMs: number; videoDurationMs: number; frameTimes: number[] } {
  const videoStartOffsetMs = frameOffsetsMs.length > 0 ? frameOffsetsMs[0] : 0
  return {
    videoStartOffsetMs,
    videoDurationMs: Math.max(durationMs - videoStartOffsetMs, 0),
    // Frame times on the video clock. Ascending, and the first is 0 by construction.
    frameTimes: frameOffsetsMs.map((o) => o - videoStartOffsetMs),
  }
}

/** Largest frame time <= t. `frameTimes[0]` is 0 and t >= 0, so this always exists. */
function lastAtOrBefore(frameTimes: number[], t: number): number {
  let best = frameTimes[0]
  for (const f of frameTimes) {
    if (f > t) break
    best = f
  }
  return best
}

/** Smallest frame time >= t, or `fallback` when the cue runs past the last frame. */
function firstAtOrAfter(frameTimes: number[], t: number, fallback: number): number {
  for (const f of frameTimes) if (f >= t) return f
  return fallback
}

/* -------------------------------------------------- input overlay: chip labels */

/** Playwright's modifier names -> what a viewer reads on a keycap. */
const MODIFIER_LABELS: Record<string, string> = {
  Control: 'Ctrl',
  ControlOrMeta: 'Ctrl',
  Alt: 'Alt',
  AltGraph: 'AltGr',
  Shift: 'Shift',
  Meta: 'Meta',
}

/** Long key names that would otherwise dominate a chip. Arrows become the arrow itself. */
const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
  Space: 'Space',
  Escape: 'Esc',
  Backspace: 'Bksp',
  Delete: 'Del',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  CapsLock: 'Caps',
  Insert: 'Ins',
}

/**
 * Split a Playwright key string on `+`, the same way Playwright's own keyboard does.
 *
 * `'+'` is itself a key, so a `+` only separates when something is already building —
 * `'Control++'` is Ctrl plus the plus key, and a naive `split('+')` turns it into an
 * empty chip. Mirrors `playwright-core/src/server/input.ts`.
 */
export function splitKeyChord(keyString: string): string[] {
  const keys: string[] = []
  let building = ''
  for (const char of keyString) {
    if (char === '+' && building) {
      keys.push(building)
      building = ''
    } else {
      building += char
    }
  }
  keys.push(building)
  return keys
}

/** `'Control+Shift+KeyK'` -> `'Ctrl+Shift+K'`. One chip for the whole chord, never three. */
export function formatKeyChord(keyString: string): string {
  return splitKeyChord(keyString)
    .map((key) => {
      if (MODIFIER_LABELS[key]) return MODIFIER_LABELS[key]
      if (KEY_LABELS[key]) return KEY_LABELS[key]
      // `KeyK`/`Digit3` are physical codes; the letter is what the viewer expects to see.
      const code = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(key)
      if (code) return code[1] ?? code[2]
      return key
    })
    .join('+')
}

/** True for a key that is one visible character — the case worth merging into a typed run. */
function isPrintableSingleKey(keyString: string): boolean {
  return [...keyString].length === 1 && keyString !== ' ' && keyString >= ' '
}

function mouseButtonWord(button?: string): string {
  if (!button || button === 'left') return ''
  return button.charAt(0).toUpperCase() + button.slice(1) + ' '
}

/**
 * Turn one `InputAction` into the text drawn on a chip, applying redaction and the
 * length cap, and saying out loud whenever either fired.
 */
export function formatInputLabel(
  action: InputAction,
  options?: InputOverlayOptions,
): { label: string; adjustments: string[]; coalesceChar?: string } {
  const adjustments: string[] = []
  const maxLabelChars = Math.max(4, options?.maxLabelChars ?? INPUT_DEFAULTS.maxLabelChars)
  const reveal = options?.revealTypedText ?? INPUT_DEFAULTS.revealTypedText

  let label: string
  /**
   * The character a following keystroke may be appended to. Derived from the LABEL, never
   * from the action: a key masked because it was aimed at a password field must not come
   * back in plaintext through the coalescer.
   */
  let coalesceChar: string | undefined

  switch (action.kind) {
    case 'key': {
      const secretTarget = !!action.target && SECRET_TARGET_RE.test(action.target)
      const single = action.phase !== 'down' && action.phase !== 'up' && isPrintableSingleKey(action.key)
      if (single && secretTarget) {
        adjustments.push(`key hidden: the target ${JSON.stringify(action.target)} looks like a secret field`)
        label = '•'
        coalesceChar = '•'
        break
      }
      const chord = formatKeyChord(action.key)
      if (single) coalesceChar = chord
      label = action.phase === 'down' ? `${chord} ↓` : action.phase === 'up' ? `${chord} ↑` : chord
      break
    }
    case 'text': {
      const verb = action.via === 'fill' ? 'Fill' : action.via === 'type' ? 'Type' : 'Insert'
      if (action.text === '') {
        label = 'Clear field'
        break
      }
      const secretTarget = !!action.target && SECRET_TARGET_RE.test(action.target)
      if (!reveal) {
        adjustments.push('typed text hidden; set inputOverlayOptions.revealTypedText to show it')
        label = `${verb} ${MASKED_TEXT}`
      } else if (secretTarget) {
        adjustments.push(`typed text hidden: the target ${JSON.stringify(action.target)} looks like a secret field`)
        label = `${verb} ${MASKED_TEXT}`
      } else {
        // A single line: a newline inside filled text would silently become a second chip row.
        label = `${verb} "${action.text.replace(/\s+/g, ' ')}"`
      }
      break
    }
    case 'mouse': {
      switch (action.action) {
        case 'click':
          label = (action.clickCount ?? 1) >= 2 ? 'Double click' : `${mouseButtonWord(action.button)}Click`
          break
        case 'dblclick':
          label = `${mouseButtonWord(action.button)}Double click`
          break
        case 'down':
          label = `${mouseButtonWord(action.button)}Mouse down`
          break
        case 'up':
          label = `${mouseButtonWord(action.button)}Mouse up`
          break
        case 'tap':
          label = 'Tap'
          break
        case 'drag':
          label = 'Drag'
          break
        case 'wheel': {
          const dx = action.deltaX ?? 0
          const dy = action.deltaY ?? 0
          if (dx === 0 && dy === 0) label = 'Scroll'
          else if (Math.abs(dy) >= Math.abs(dx)) label = `Scroll ${dy > 0 ? '↓' : '↑'}`
          else label = `Scroll ${dx > 0 ? '→' : '←'}`
          break
        }
      }
      break
    }
    case 'action': {
      label = action.detail ? `${action.verb} ${action.detail}` : action.verb
      break
    }
  }

  // Control characters would corrupt the ASS parse the same way they do a caption.
  // eslint-disable-next-line no-control-regex
  const stripped = label.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (stripped !== label) adjustments.push('control characters and line breaks flattened out of the chip')
  label = stripped || '?'

  const chars = [...label]
  if (chars.length > maxLabelChars) {
    label = chars.slice(0, maxLabelChars - 1).join('') + '…'
    adjustments.push(`chip truncated to ${maxLabelChars} characters`)
  }
  // Flattening or truncation can leave a "single character" that no longer is one.
  if (coalesceChar !== undefined && label !== coalesceChar) coalesceChar = undefined
  return { label, adjustments, ...(coalesceChar !== undefined ? { coalesceChar } : {}) }
}

/* --------------------------------------------- input overlay: timing + stacking */

/** An input as stamped, before it knows anything about the video timeline. */
export interface StampedInput {
  kind: InputEventKind
  label: string
  atMs: number
  /** The single character this event typed, when it is a candidate for coalescing. */
  coalesceChar?: string
  adjustments: string[]
}

/** One drawn state of the overlay: a fixed stack of chips over a fixed span of video time. */
export interface InputSegment {
  startMs: number
  endMs: number
  /** Oldest first, so the stack grows away from the anchored edge and never reshuffles. */
  lines: Array<{ index: number; label: string }>
}

export interface BuildInputChipsResult {
  events: ResolvedInputEvent[]
  segments: InputSegment[]
  note?: string
}

/**
 * Turn stamped inputs into chips on the VIDEO timeline, then into drawable segments.
 *
 * Same two shifts as `buildCues` — video time 0 is the first repaint, and a burned overlay
 * only exists on frames that exist — reusing the same helpers so the two can never drift.
 *
 * What differs from captions, and why:
 *
 * - **Chips overlap.** A caption replaces its predecessor; a keystroke does not cancel the
 *   one before it. So each chip gets a fixed `dwellMs` and several can be live at once.
 * - **The live set is capped, by count AND by width.** Ten keys inside one dwell window
 *   would be a wall over the page. Past `maxVisible` — or, in `'row'` layout, past what
 *   fits across the frame — the OLDEST live chip is retired early. Newest wins, because
 *   the newest is the one the viewer is currently trying to follow, and the retirement is
 *   recorded on the retired chip.
 * - **Fast typing coalesces first.** Consecutive single-character keys inside
 *   `coalesceWindowMs` become one chip showing the run (`abcdefghij`), which is both more
 *   readable than ten chips and closer to what the user actually did.
 *
 * The whole visible set is emitted as ONE dialogue per segment rather than one dialogue
 * per chip: libass does its own collision-avoidance when two events share an alignment,
 * and that is not something to leave to chance when the layout is the feature.
 *
 * `video` is optional and only used for the row width budget. Without it a row can only be
 * capped by count, and an over-long row is left to libass to wrap.
 */
export function buildInputChips({
  events,
  frameOffsetsMs,
  durationMs,
  options,
  video,
}: {
  events: StampedInput[]
  frameOffsetsMs: number[]
  durationMs: number
  options?: InputOverlayOptions
  video?: { width: number; height: number }
}): BuildInputChipsResult {
  const dwellMs = Math.max(1, options?.dwellMs ?? INPUT_DEFAULTS.dwellMs)
  const maxVisible = Math.max(1, Math.floor(options?.maxVisible ?? INPUT_DEFAULTS.maxVisible))
  const coalesceWindowMs = Math.max(0, options?.coalesceWindowMs ?? INPUT_DEFAULTS.coalesceWindowMs)
  const maxLabelChars = Math.max(4, options?.maxLabelChars ?? INPUT_DEFAULTS.maxLabelChars)
  const layout = options?.layout ?? INPUT_DEFAULTS.layout
  const { videoStartOffsetMs, videoDurationMs, frameTimes } = videoTimeline({ frameOffsetsMs, durationMs })

  /**
   * How many characters a row may span before it runs off the frame.
   *
   * `Infinity` for a stack (each chip is its own line and is already capped by
   * `maxLabelChars`) and when no video size is known.
   *
   * The two subtractions are the strip's own furniture, and both moved when the merge plate
   * arrived. Only ONE margin is charged, because the anchored side's margin is now zero — the
   * plate runs to that frame edge instead. Against that, the hard spaces that hold the ink off
   * that edge and provide the inboard clearance are charged in full: they are part of the
   * line libass lays out, and a budget that ignored them would let a row that "fits" be
   * wrapped by the padding, which is the one failure `singleRowFindings` exists to catch.
   * Charged at their MEASURED advance rather than at `CHIP_CHAR_WIDTH_RATIO`; over-charging
   * a fixed ten-space overhead by 2x would retire a chip on every narrow frame for nothing.
   */
  const rowCharBudget =
    layout === 'row' && video
      ? (() => {
          const m = chipStripMetrics(video, options)
          return Math.max(
            maxLabelChars,
            Math.floor((video.width - m.margin - m.hardSpaceWidthPx) / (m.fontSize * CHIP_CHAR_WIDTH_RATIO)),
          )
        })()
      : Infinity

  if (events.length === 0) return { events: [], segments: [] }

  // --- 1. chronological order (a caller-supplied atMs can arrive out of order) ---
  const outOfOrder = events.some((e, i) => i > 0 && e.atMs < events[i - 1].atMs)
  const ordered = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.atMs - b.e.atMs || a.i - b.i)
    .map(({ e }) => ({
      ...e,
      adjustments: outOfOrder ? [...e.adjustments, 'input events were not in chronological order; sorted by time'] : [...e.adjustments],
    }))

  // --- 2. coalesce runs of single-character keys ---
  type Merged = StampedInput & { coalescedCount: number }
  const merged: Merged[] = []
  for (const e of ordered) {
    const prev = merged[merged.length - 1]
    const canMerge =
      prev !== undefined &&
      e.coalesceChar !== undefined &&
      prev.coalesceChar !== undefined &&
      e.atMs - prev.atMs <= coalesceWindowMs
    if (!canMerge) {
      merged.push({ ...e, coalescedCount: 1 })
      continue
    }
    // Keep the run's START time: the chip belongs where the typing began, and the
    // dwell already carries it past the end of the burst.
    prev.coalesceChar = e.coalesceChar
    prev.coalescedCount++
    const run = prev.label + e.coalesceChar
    const chars = [...run]
    prev.label = chars.length > maxLabelChars ? chars.slice(0, maxLabelChars - 1).join('') + '…' : run
    if (chars.length > maxLabelChars && !prev.adjustments.some((a) => a.startsWith('chip truncated'))) {
      prev.adjustments.push(`chip truncated to ${maxLabelChars} characters`)
    }
  }
  for (const m of merged) {
    if (m.coalescedCount > 1) {
      m.adjustments.push(`${m.coalescedCount} keystrokes within ${coalesceWindowMs}ms merged into one chip`)
    }
  }

  // --- 3. no video at all ---
  if (frameOffsetsMs.length === 0) {
    return {
      events: merged.map((m) => ({
        index: -1,
        kind: m.kind,
        label: m.label,
        startMs: 0,
        endMs: 0,
        atMs: m.atMs,
        ...(m.coalescedCount > 1 ? { coalescedCount: m.coalescedCount } : {}),
        dropped: true,
        adjustments: [...m.adjustments, 'dropped: no frames were captured, so there is no video to draw on'],
      })),
      segments: [],
      note: 'All input chips dropped: nothing was captured.',
    }
  }

  // --- 4. onto the video timeline, then onto the frame grid ---
  type Chip = Merged & { startMs: number; endMs: number; dropped: boolean }
  const chips: Chip[] = merged.map((m) => ({ ...m, startMs: 0, endMs: 0, dropped: false }))

  for (const c of chips) {
    const raw = c.atMs - videoStartOffsetMs
    if (raw < 0) {
      c.startMs = 0
      c.adjustments.push(`stamped ${Math.round(-raw)}ms before the first captured frame; clamped to the start of the video`)
    } else if (raw >= videoDurationMs) {
      c.dropped = true
      c.adjustments.push(
        `dropped: stamped at video time ${Math.round(raw)}ms, at or past the ${Math.round(videoDurationMs)}ms end of the clip`,
      )
      continue
    } else {
      c.startMs = raw
    }
    const snapped = lastAtOrBefore(frameTimes, c.startMs)
    if (Math.abs(snapped - c.startMs) >= 1) {
      c.adjustments.push(
        `shown ${Math.round(c.startMs - snapped)}ms early, on the frame captured at ${Math.round(snapped)}ms — the video does not change between frames, so nothing repainted when this input landed`,
      )
    }
    c.startMs = snapped
    // Snap the end forward for the same reason `buildCues` does: the chip stays visible
    // until a frame without it exists, so the reported end is when it really goes away.
    c.endMs = Math.min(firstAtOrAfter(frameTimes, c.startMs + dwellMs, videoDurationMs), videoDurationMs)
    // A chip cut short by the END OF THE CLIP, reported the way `buildCues` reports the
    // same thing about a cue. These two functions sit next to each other and described the
    // identical situation with opposite honesty: a caption that ran out of video said
    // "the recording stopped Xms after it appeared", a chip said nothing at all — so the
    // last action in a repro, which is usually the one the clip exists to show, silently
    // flashed for a fraction of its dwell.
    const shownMs = c.endMs - c.startMs
    if (c.startMs + dwellMs > videoDurationMs && shownMs > 0) {
      c.adjustments.push(
        `on screen for ${Math.round(shownMs)}ms of its ${dwellMs}ms dwell — the recording stopped ` +
          `${Math.round(videoDurationMs - c.startMs)}ms after this input landed` +
          (shownMs < GLANCE_MS
            ? `, under the ~${GLANCE_MS}ms a viewer needs just to notice a chip, so it was never really seen`
            : '') +
          '; let the final state sit on screen before stopCdp',
      )
    }
  }

  // --- 5. rolling window: retire the oldest live chip until the set fits ---
  //
  // Two criteria, both applied when a new chip arrives, oldest-first. Count keeps the
  // overlay small; width keeps a row inside the frame instead of letting libass wrap it
  // into the page. Retiring at ARRIVAL rather than per rendered segment is what stops a
  // chip disappearing and coming back as its neighbours change.
  const rowWidth = (labels: string[]) =>
    labels.reduce((n, l) => n + [...l].length, 0) + Math.max(0, labels.length - 1) * ROW_SEPARATOR.length
  const live = chips.filter((c) => !c.dropped)
  for (let i = 0; i < live.length; i++) {
    const at = live[i].startMs
    const stillUp = live.filter((c, j) => j < i && !c.dropped && c.endMs > at)
    const keep = [...stillUp, live[i]]
    for (const victim of stillUp) {
      const overCount = keep.length > maxVisible
      const overWidth = rowWidth(keep.map((c) => c.label)) > rowCharBudget
      if (!overCount && !overWidth) break
      keep.shift()
      const shownFor = at - victim.startMs
      const because = overCount
        ? `only ${maxVisible} chips are shown at once (inputOverlayOptions.maxVisible)`
        : `the row would not fit across the frame (${rowCharBudget} characters)`
      if (at <= victim.startMs) {
        victim.dropped = true
        victim.adjustments.push(`dropped: newer chips landed on the same captured frame and ${because}, so this one would never be seen`)
      } else {
        victim.endMs = at
        // A retirement inside a glance is a pacing problem, not a layout one: the chip was
        // drawn and no viewer could have seen it. Said here for the same reason the caption
        // deficit is said on the cue — the fix is at record time and nothing else reports it.
        victim.adjustments.push(
          `retired after ${Math.round(shownFor)}ms to make room; ${because}` +
            (shownFor < GLANCE_MS
              ? ` — under the ~${GLANCE_MS}ms a viewer needs just to notice a chip, so this one was never really seen; space these actions further apart`
              : ''),
        )
      }
    }
  }

  // --- 6. number the survivors and build the drawable segments ---
  const resolved: ResolvedInputEvent[] = []
  let index = 0
  for (const c of chips) {
    const dropped = c.dropped || c.endMs <= c.startMs
    if (dropped && !c.dropped) {
      c.adjustments.push('dropped: no later frame exists, so the chip would occupy no video time')
    }
    resolved.push({
      index: dropped ? -1 : ++index,
      kind: c.kind,
      label: c.label,
      startMs: Math.round(c.startMs),
      endMs: Math.round(dropped ? c.startMs : c.endMs),
      atMs: c.atMs,
      ...(c.coalescedCount > 1 ? { coalescedCount: c.coalescedCount } : {}),
      ...(dropped ? { dropped: true } : {}),
      ...(c.adjustments.length ? { adjustments: c.adjustments } : {}),
    })
    c.dropped = dropped
  }

  const drawable = chips
    .map((c, i) => ({ c, index: resolved[i].index }))
    .filter(({ c }) => !c.dropped)
  const boundaries = [...new Set(drawable.flatMap(({ c }) => [c.startMs, c.endMs]))].sort((a, b) => a - b)
  const segments: InputSegment[] = []
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const [t0, t1] = [boundaries[i], boundaries[i + 1]]
    const lines = drawable
      .filter(({ c }) => c.startMs <= t0 && c.endMs > t0)
      .map(({ c, index: idx }) => ({ index: idx, label: c.label }))
    if (lines.length === 0) continue
    const last = segments[segments.length - 1]
    // Merge with the previous segment when the visible stack did not actually change,
    // so a long-lived chip is one dialogue rather than one per neighbouring boundary.
    if (last && last.endMs === t0 && last.lines.length === lines.length && last.lines.every((l, k) => l.index === lines[k].index)) {
      last.endMs = t1
    } else {
      segments.push({ startMs: Math.round(t0), endMs: Math.round(t1), lines })
    }
  }

  const droppedCount = resolved.filter((e) => e.dropped).length
  const adjustedCount = resolved.filter((e) => !e.dropped && e.adjustments?.length).length
  const note =
    droppedCount || adjustedCount
      ? `${droppedCount} input chip(s) dropped, ${adjustedCount} adjusted — see inputEvents[].adjustments.`
      : undefined

  return { events: resolved, segments, note }
}

/* -------------------------------------------------------- subtitle formatting */

function timestamp(ms: number, msSeparator: ',' | '.'): string {
  const clamped = Math.max(0, Math.round(ms))
  const h = Math.floor(clamped / 3_600_000)
  const m = Math.floor(clamped / 60_000) % 60
  const s = Math.floor(clamped / 1000) % 60
  const milli = clamped % 1000
  const p = (n: number, w: number) => String(n).padStart(w, '0')
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}${msSeparator}${p(milli, 3)}`
}

/**
 * SubRip. The millisecond separator is a COMMA — a period is WebVTT, and players are
 * unforgiving about the difference.
 *
 * Cue text is emitted verbatim. `-->` inside it is unambiguous because a timing line
 * can only follow a blank line and an index, and `normalizeCaptionText` has already
 * removed blank lines. `<` and `>` are left alone too: SubRip has no escape syntax, so
 * inventing one would just show `&lt;` to the viewer.
 */
export function formatSrt(cues: ResolvedCue[]): string {
  const body = cues
    .filter((c) => !c.dropped)
    .map((c, i) => `${i + 1}\n${timestamp(c.startMs, ',')} --> ${timestamp(c.endMs, ',')}\n${c.text}\n`)
    .join('\n')
  return body ? body + '\n' : ''
}

/**
 * WebVTT. Period separator, and unlike SubRip the payload genuinely may not contain
 * `-->` — so the spec's own escapes are used, which also fixes angle brackets.
 */
export function formatVtt(cues: ResolvedCue[]): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = cues
    .filter((c) => !c.dropped)
    .map((c, i) => `${i + 1}\n${timestamp(c.startMs, '.')} --> ${timestamp(c.endMs, '.')}\n${esc(c.text)}\n`)
    .join('\n')
  return `WEBVTT\n\n${body}`
}

/**
 * Escape caption text for an ASS dialogue line.
 *
 * Verified against this machine's libass by rendering and reading the pixels:
 *   - a bare `{…}` is an override block and SWALLOWS everything inside it (measured:
 *     `A{XXX}B` rendered as `AB`), so braces must become `\{` `\}`, which libass
 *     renders as literal braces;
 *   - a lone backslash renders literally, and `\\` renders as TWO backslashes — so
 *     doubling is wrong;
 *   - `\N` `\n` `\h` are the only sequences that mean anything, so a caller's backslash
 *     is only dangerous immediately before one of those three. A zero-width space
 *     breaks the pair without changing what the viewer reads (verified: no tofu box);
 *   - `<b>` and `-->` are literal to libass and need nothing.
 */
export function escapeAssText(text: string): { text: string; adjustments: string[] } {
  const adjustments: string[] = []
  let out = text.replace(/\{/g, '\\{').replace(/\}/g, '\\}')
  if (out !== text) adjustments.push('braces escaped for the burn-in renderer (they are override syntax in ASS)')
  const deNbackslashed = out.replace(/\\(?=[Nnh])/g, '\\\u200b')
  if (deNbackslashed !== out) {
    adjustments.push('a backslash before N/n/h was separated with a zero-width space so libass would not read it as a line break')
    out = deNbackslashed
  }
  // Real line breaks are the ASS hard-break, applied last so it is not itself escaped.
  return { text: out.replace(/\n/g, '\\N'), adjustments }
}

/** `#RRGGBB` -> ASS `&HAABBGGRR`. ASS colours are BGR with an INVERTED alpha byte. */
function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`caption colour must be #RRGGBB, got ${JSON.stringify(hex)}`)
  const [r, g, b] = [0, 2, 4].map((i) => m[1].slice(i, i + 2).toUpperCase())
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`
}

/**
 * `#RRGGBB` -> `0xRRGGBB`, the form an ffmpeg filter option takes.
 *
 * Validated rather than string-replaced, because this value goes into a filtergraph: an
 * unvalidated caller string could carry a `:` or a `,` and silently become extra filter
 * options. Re-emitted from the parsed bytes, so nothing of the input survives into the
 * command line except six hex digits.
 */
function ffmpegColor(hex: string): string {
  const [r, g, b] = parseHexColor(hex)
  return '0x' + [r, g, b].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')
}

/** `#RRGGBB` -> `[r, g, b]`, for comparing two colours the caller supplied. */
function parseHexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`caption colour must be #RRGGBB, got ${JSON.stringify(hex)}`)
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number]
}

/**
 * Smallest per-channel separation between two colours that still reads as two colours.
 *
 * Not a perceptual metric — a deliberately loose one. It exists to catch the case where a
 * caller has asked for text and outline (or text and box) that are the SAME, which encodes
 * perfectly and renders nothing a viewer can see. `#FFFFFF` text on a `#FFFFFF` outline is
 * an invisible caption in a result object that says `wrote: true`. 24/255 is under a tenth
 * of the range, so it refuses only genuine collisions and never a deliberate low-contrast
 * choice; the per-glyph contrast invariant in the visual suite is what judges legibility.
 */
const MIN_COLOR_SEPARATION = 24

function colorsCollide(a: string, b: string): boolean {
  const [r1, g1, b1] = parseHexColor(a)
  const [r2, g2, b2] = parseHexColor(b)
  return Math.abs(r1 - r2) < MIN_COLOR_SEPARATION && Math.abs(g1 - g2) < MIN_COLOR_SEPARATION && Math.abs(b1 - b2) < MIN_COLOR_SEPARATION
}

function assertFiniteInRange(value: unknown, name: string, min: number, max: number, unit: string): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number ${unit}, got ${JSON.stringify(value)}.`)
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max} ${unit}, got ${value}.`)
  }
}

/**
 * Refuse visual options that encode cleanly and produce nothing watchable.
 *
 * The rest of this file is scrupulous about bad input — `readingRateCps`, `render`,
 * `position` and `layout` all throw with the way out named — and the visual options were
 * the hole in that. `captionOptions: { textColor: '#FFF', outlineColor: '#FFF' }` used to
 * encode without complaint and produce an invisible caption; a negative `outlineWidth`
 * reached libass as a negative Outline; a `fontSizePct` of 400 produced a caption taller
 * than the frame with no indication anything was wrong.
 *
 * Every check here is for something that CANNOT be what the caller meant. Judgement calls
 * about legibility belong in the visual invariants, not in a throw.
 */
export function validateVisualOptions(
  video: { width: number; height: number },
  options?: CaptionOptions,
  inputOptions?: InputOverlayOptions,
): void {
  if (!(video.width > 0) || !(video.height > 0) || !Number.isFinite(video.width) || !Number.isFinite(video.height)) {
    throw new Error(`The video size must be positive and finite, got ${video.width}x${video.height}.`)
  }

  assertFiniteInRange(options?.fontSizePct, 'captionOptions.fontSizePct', 0.1, 100, 'percent of the page height')
  assertFiniteInRange(options?.outlineWidth, 'captionOptions.outlineWidth', 0, 100, 'pixels')
  assertFiniteInRange(options?.shadow, 'captionOptions.shadow', 0, 100, 'pixels')
  assertFiniteInRange(options?.maxLines, 'captionOptions.maxLines', 1, 100, 'lines')
  assertFiniteInRange(options?.maxCharsPerLine, 'captionOptions.maxCharsPerLine', 1, 1000, 'characters')
  assertFiniteInRange(inputOptions?.fontSizePct, 'inputOverlayOptions.fontSizePct', 0.1, 100, 'percent of the page height')
  assertFiniteInRange(inputOptions?.marginPct, 'inputOverlayOptions.marginPct', 0, 100, 'percent of the page height')
  assertFiniteInRange(inputOptions?.boxOpacity, 'inputOverlayOptions.boxOpacity', 0, 1, '(0 = invisible, 1 = opaque)')

  for (const [name, value] of [
    ['captionOptions.fontName', options?.fontName],
    ['inputOverlayOptions.fontName', inputOptions?.fontName],
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${name} must be a non-empty font family name, got ${JSON.stringify(value)}.`)
    }
    // fontconfig NEVER fails to match: an unknown family silently resolves to whatever the
    // system default is (measured on this machine: 'NoSuchFamily' -> DejaVu Sans, 'Arial'
    // -> Aerial, 'Helvetica' -> Nimbus Sans). A comma would additionally be read as a field
    // separator by the ASS style line and shift every field after it.
    if (value.includes(',')) {
      throw new Error(
        `${name} must be a single font family, got ${JSON.stringify(value)}. A comma separates fields in an ASS ` +
          'style line, so a font list would shift every style field after it. Name one family that fontconfig can ' +
          'resolve — and note that fontconfig never reports a miss, it silently substitutes.',
      )
    }
  }

  const colors = resolveCaptionColors(options)
  // The thing the caption is actually READ against is the strip, so that is the pair worth
  // refusing. It used to be text-vs-outline, which was right when the outline was the only
  // thing between white text and an arbitrary page; on a strip an outline the colour of its
  // own background is the DEFAULT, and refusing that pair would refuse the defaults.
  if (colorsCollide(colors.text, colors.strip)) {
    throw new Error(
      `captionOptions.textColor ${JSON.stringify(colors.text)} and stripColor ${JSON.stringify(colors.strip)} are the ` +
        'same colour, so the caption would be invisible: it is drawn in a strip appended below the page, and the strip ' +
        'is the only thing behind it. The default pair is black text on a light strip.',
    )
  }
  // A caller who asks for a visible outline must still get one that is not the text colour,
  // or the glyphs fill in to a solid block. Only checked when it would be visible at all.
  if (!colorsCollide(colors.outline, colors.strip) && colorsCollide(colors.text, colors.outline)) {
    throw new Error(
      `captionOptions.textColor ${JSON.stringify(colors.text)} and outlineColor ${JSON.stringify(colors.outline)} are ` +
        `the same colour, so the caption would be ${options?.boxed ?? CAPTION_DEFAULTS.boxed ? 'a solid block with no readable text in it' : 'a smudge with no separation between fill and border'}. ` +
        'Leave outlineColor unset to have it follow stripColor, which draws no visible outline at all.',
    )
  }

  if (inputOptions) {
    const chipText = inputOptions.textColor ?? INPUT_DEFAULTS.textColor
    const chipBox = inputOptions.boxColor ?? INPUT_DEFAULTS.boxColor
    const opacity = inputOptions.boxOpacity ?? INPUT_DEFAULTS.boxOpacity
    // Only a collision when the box is actually painted; at opacity 0 the box is not the
    // thing behind the text and the page is, which the contrast invariant judges instead.
    if (opacity > 0.15 && colorsCollide(chipText, chipBox)) {
      throw new Error(
        `inputOverlayOptions.textColor ${JSON.stringify(chipText)} and boxColor ${JSON.stringify(chipBox)} are the same ` +
          `colour at ${opacity} opacity, so every chip would render as a featureless block. The default pair is white ` +
          'text on an opaque black box.',
      )
    }
  }

  /**
   * The narration must not be bigger than the evidence.
   *
   * The old form of this check was "the caption has to fit inside the frame it is drawn
   * on", which the strip makes impossible to fail — the frame grows to hold the caption,
   * so a 22% face simply produces a very tall video. That is not a crash but it is still
   * not what anyone meant: at `fontSizePct: 30` with three lines the strip is taller than
   * the page and the clip is mostly subtitle. Refused at parity, where the page is still
   * at least half the frame.
   */
  const maxLines = options?.maxLines ?? CAPTION_DEFAULTS.maxLines
  const worst = captionStripMetrics(video, maxLines, options)
  if (worst.height > worst.pageHeight) {
    throw new Error(
      `A ${maxLines}-line caption at ${worst.fontSize}px needs a ${worst.height}px strip appended below a ` +
        `${worst.pageHeight}px page, so more than half the video would be subtitle rather than page. The caption is ` +
        'drawn in a strip below the page, not over it, so this is not clipping — it is a clip whose narration ' +
        'dominates the thing it narrates. Lower captionOptions.fontSizePct or maxLines.',
    )
  }
}

/**
 * Build an ASS script sized to the LETTERBOXED frame, from the PAGE size.
 *
 * `video` is the page — the size of the captured frames — and everything the caller has is
 * expressed in it. The frame the ASS describes is taller: `captionStripMetrics` appends a
 * caption strip below the page and returns the sum, and `PlayResX/Y` is written from THAT,
 * because PlayRes has to describe the surface libass is drawing on or every margin and face
 * in the style means something else. The returned `strip` is how `encodeFrames` knows how
 * many rows to pad, so the two cannot disagree about where the page ends.
 *
 * ASS rather than handing the SRT to `subtitles=` with `force_style`: PlayResX/Y let the
 * style be expressed relative to the actual frame, and it keeps a second layer of
 * filtergraph escaping (force_style is itself a `:`-separated value) out of the picture.
 *
 * TWO STYLES, TWO LAYERS, ONE FILE:
 *
 *     Layer 0  Default — the caption glyphs, inside the strip and never above it.
 *     Layer 1  Input   — the key/button chips, on the page, offset by the strip height.
 *
 * There used to be a third, `Layer -1 Backdrop`, drawing a full-frame-width opaque band
 * behind each cue ON the page. It is gone: the strip does its job without covering anything.
 *
 * AFTER CHANGING ANY OF THE LAYOUT OR STYLING BELOW, LOOK AT THE RESULT.
 * `video-invariants.ts` automates what can be stated as a property of known pixel masks —
 * disjointness, edge clipping, per-glyph contrast, counter survival, single-row chips, chip
 * subordination, subject occlusion, golden-frame drift, and the two merge shields.
 *
 *   CAPTION. No caption ink falls inside the page region at all. That is the whole merge
 *   argument now, and it is a statement about two disjoint REGIONS rather than about
 *   scanlines: a merged token needs two glyph runs side by side on rows they share, and the
 *   caption shares no row with the page. It replaces "every scanline carrying caption ink is
 *   opaque overlay from edge to edge", which was true but bought with the page underneath.
 *
 *   CHIPS. A different formulation, because the chips deliberately stay ON the page — see
 *   `chipStripMetrics` for why that trade is taken rather than assumed. The plate is opaque
 *   (nothing under it survives), it runs to the frame edge it is anchored to (nothing beside
 *   it on that side exists), and it extends a MEASURED clear distance inboard. Two of those
 *   three are proofs; the third is a number, and `chipStripMetrics` says how it was measured
 *   and where it stops being a proof.
 *
 * Neither shield is a substitute for looking, and the harness for that is:
 *
 *     pnpm exec vite-node scripts/render-visual-frames.ts
 *
 * It renders every canonical scene at every height through the shipped `encodeFrames`,
 * writes the meaningful frames to `tmp/visual-frames/`, and prints the caption text and
 * chip labels that belong in each one so a manufactured word is identifiable rather than
 * arguable. The per-frame checklist is in that script's header.
 */
export function formatAss(
  cues: ResolvedCue[],
  /** The PAGE size — the captured frame. The encoded frame is this plus `strip.height`. */
  video: { width: number; height: number },
  options?: CaptionOptions,
  /**
   * The input overlay, in the SAME file. One `subtitles` filter, two styles, two layers —
   * running a second filter would mean a second libass instance rasterising the whole
   * frame again for a handful of chips.
   */
  input?: { segments: InputSegment[]; options?: InputOverlayOptions },
): {
  text: string
  /** The letterbox geometry this file was written for. `encodeFrames` pads to match. */
  strip: CaptionStripMetrics
  adjustments: Map<number, string[]>
  inputAdjustments: Map<number, string[]>
  inputNote?: string
} {
  validateVisualOptions(video, options, input?.options)
  const fontName = options?.fontName ?? CAPTION_DEFAULTS.fontName
  const burnedCues = cues.filter((c) => !c.dropped)

  // The face has to be known before the line count can be, and the line count before the
  // strip height — so the face is resolved once against the PAGE and reused. Reading it off
  // the letterboxed frame would make the strip feed its own input.
  const probe = captionStripMetrics(video, 0, options)
  const marginH = Math.max(8, Math.round(probe.pageWidth * 0.05))
  const usableWidth = probe.pageWidth - 2 * marginH
  /**
   * ONE strip for the whole clip, sized to the tallest cue in it.
   *
   * `renderedCaptionLines` rather than the source line count, because our wrapper wraps at
   * characters and libass wraps at pixels, and on a narrow frame a 42-character line becomes
   * three — see that function. Over-estimating now costs blank strip instead of buried page.
   */
  const lines = burnedCues.length > 0
    ? Math.max(...burnedCues.map((c) => renderedCaptionLines(c.text, usableWidth, probe.fontSize)))
    : 0
  const strip = captionStripMetrics(video, lines, options)
  const { fontSize, outline, shadow } = strip
  const primary = assColor(strip.textColor)
  const outlineCol = assColor(strip.outlineColor)
  // BorderStyle 3 paints an opaque box using OutlineColour; 1 is outline + shadow.
  const borderStyle = options?.boxed ?? CAPTION_DEFAULTS.boxed ? 3 : 1

  const adjustments = new Map<number, string[]>()
  const events = burnedCues
    .map((c) => {
      const escaped = escapeAssText(c.text)
      if (escaped.adjustments.length) adjustments.set(c.index, escaped.adjustments)
      return `Dialogue: 0,${assTime(c.startMs)},${assTime(c.endMs)},Default,,0,0,0,,${escaped.text}`
    })
    .join('\n')

  const inputAdjustments = new Map<number, string[]>()
  let inputNote: string | undefined
  // Alignment 2 is bottom-centre and MarginV measures up from the frame's bottom edge, which
  // is now the strip's bottom edge. `strip.marginV` is what lands the drawn block exactly
  // `strip.pad` above it, so the caption is centred in a strip that was sized around it.
  const styleLines = [
    `Style: Default,${fontName},${fontSize},${primary},${primary},${outlineCol},${outlineCol},0,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,${marginH},${marginH},${strip.marginV},1`,
  ]
  const eventLines = events ? [events] : []

  if (input && input.segments.length > 0) {
    const io = input.options
    // The face, the padding, the margin and the two hard-space runs, all from one place —
    // `buildInputChips` budgets the row against the same numbers and the two must agree.
    // The face is floored at MIN_INPUT_FONT_PX for the same reason the caption face is
    // floored at 16: below it the box swallows the glyphs and the chip reads as a grey tab.
    const chip = chipStripMetrics(video, io)
    const chipSize = chip.fontSize
    const opacity = Math.min(1, Math.max(0, io?.boxOpacity ?? INPUT_DEFAULTS.boxOpacity))
    // ASS alpha is INVERTED — 0x00 is opaque — so the default opacity 1 is alpha 0x00, and a
    // caller-chosen 0.65 would be 0x59. Opacity is not decoration here: see `boxOpacity`.
    const boxAlpha = Math.round((1 - opacity) * 255)
    const chipText = assColor(io?.textColor ?? INPUT_DEFAULTS.textColor)
    // BorderStyle 3 fills the box from OutlineColour — that fill IS the merge plate. `Outline`
    // becomes its padding, and Shadow is 0 so the box does not get a second, offset twin
    // behind it that would extend past the plate's own edge.
    const chipBox = assColor(io?.boxColor ?? INPUT_DEFAULTS.boxColor, boxAlpha)
    const chipPad = chip.pad
    const chipMargin = chip.margin
    const position = io?.position ?? INPUT_DEFAULTS.position
    const alignment = { 'top-left': 7, 'top-right': 9, 'bottom-left': 1, 'bottom-right': 3 }[position]
    if (alignment === undefined) {
      throw new Error(
        `Unknown inputOverlayOptions.position ${JSON.stringify(position)}; expected 'top-left', 'top-right', 'bottom-left' or 'bottom-right'.`,
      )
    }
    const layout = io?.layout ?? INPUT_DEFAULTS.layout
    if (layout !== 'row' && layout !== 'stack') {
      throw new Error(`Unknown inputOverlayOptions.layout ${JSON.stringify(layout)}; expected 'row' or 'stack'.`)
    }

    /**
     * Hold a bottom-anchored strip on the PAGE, now that the frame is taller than the page.
     *
     * THE CAPTION-LIFT RESERVE THAT USED TO BE HERE IS GONE, and this is what replaced it.
     * It reserved the caption block's measured height plus a gap so the chips could not be
     * drawn on top of the narration — an arithmetic that had to track the caption's font
     * size, its bottom margin, its backdrop padding and the number of lines libass would
     * really wrap it to, and that had a clamp for when the answer pushed the chips off the
     * top of the frame. All of it existed because both layers were competing for the bottom
     * of the same page. They are not any more: the caption is below the page entirely, so
     * the chips only have to clear the strip, and the strip's height is a constant known
     * exactly.
     *
     * `MarginV` on a bottom alignment measures up from the frame's bottom edge, which is now
     * the strip's bottom. Adding `strip.height` puts the chip ink `chipMargin` above the
     * PAGE's bottom edge — the same place it sat before the strip existed, and the same
     * place it sits in a clip with no captions at all, where `strip.height` is 0.
     *
     * Nothing to clamp and nothing to report: the sum cannot exceed the frame, because
     * `validateVisualOptions` already refuses a strip taller than its own page.
     */
    const bottomAnchored = position === 'bottom-left' || position === 'bottom-right'
    const chipMarginV = bottomAnchored ? chipMargin + strip.height : chipMargin

    /**
     * The merge plate, expressed as margins and hard spaces rather than as a rectangle.
     *
     * `chipStripMetrics` carries the argument for why these are the shape they are; this is
     * the mechanism. BorderStyle 3 makes libass draw the opaque box around the line's TRUE
     * extent, so the plate is the ink's own bounding box plus padding by construction — there
     * is no advance-width estimate anywhere in it, and it cannot come out narrower than the
     * glyphs the way a `\p1` rectangle sized from `CHIP_CHAR_WIDTH_RATIO` could.
     *
     * The two things that then have to be added are asymmetric, and ASS `Outline` is not:
     * it pads all four sides at once, and paying the inboard clearance vertically as well
     * would make a 14px strip a 46px one, cover three times the page for no merge benefit,
     * and break the subordination the HUD depends on. Hard spaces are the asymmetric vehicle
     * — MEASURED not to be trimmed at either end of a line, and to widen the box by exactly
     * their advance (see `CHIP_HARD_SPACE_RATIO`), while adding no height at all.
     *
     *   outboard side  the anchored margin is ZERO, so the plate reaches the frame edge, and
     *                  `outboardSpaces` holds the ink where the margin used to hold it;
     *   inboard side   `inboardSpaces` of clearance between the ink and the page.
     */
    const leftAnchored = position === 'top-left' || position === 'bottom-left'
    const inboardPad = '\\h'.repeat(chip.inboardSpaces)
    const outboardPad = '\\h'.repeat(chip.outboardSpaces)
    const leadPad = leftAnchored ? outboardPad : inboardPad
    const trailPad = leftAnchored ? inboardPad : outboardPad
    const marginL = leftAnchored ? 0 : chipMargin
    const marginR = leftAnchored ? chipMargin : 0

    styleLines.push(
      `Style: Input,${io?.fontName ?? fontName},${chipSize},${chipText},${chipText},${chipBox},${chipBox},0,0,0,0,100,100,0,0,3,${chipPad},0,${alignment},${marginL},${marginR},${chipMarginV},1`,
    )
    for (const segment of input.segments) {
      const lines = segment.lines.map((l) => {
        const escaped = escapeAssText(l.label)
        if (escaped.adjustments.length) {
          inputAdjustments.set(l.index, [...(inputAdjustments.get(l.index) ?? []), ...escaped.adjustments])
        }
        return escaped.text
      })
      // Layer 1, above the captions. The two can no longer reach each other — they are in
      // disjoint regions of the frame — so the ordering is now only a convention, kept so
      // that `Dialogue: 1,` still means "chip" everywhere that prefix is read.
      // A row is one line with separators; a stack is one line per chip. Either way it is
      // ONE dialogue, so libass lays it out exactly as written.
      //
      // The padding is applied AFTER `escapeAssText`, so `\h` stays a hard space: the escaper
      // deliberately breaks a CALLER's backslash before an h with a zero-width space, and
      // running our own padding through it would turn the plate into six literal `\h`s.
      // Per LINE in a stack, not per dialogue — each stacked chip gets its own box.
      const pad = (s: string) => `${leadPad}${s}${trailPad}`
      const body = layout === 'row' ? pad(lines.join(ROW_SEPARATOR)) : lines.map(pad).join('\\N')
      eventLines.push(`Dialogue: 1,${assTime(segment.startMs)},${assTime(segment.endMs)},Input,,0,0,0,,${body}`)
    }
  }

  const text = [
    '[Script Info]',
    'ScriptType: v4.00+',
    // The LETTERBOXED frame, not the page. `ScaledBorderAndShadow: yes` scales the whole
    // style by the frame/PlayRes ratio, so a PlayRes describing only the page would render
    // every margin and face against the wrong height — the exact silent mis-scaling that
    // `resolveFrameSize` exists to prevent, arriving from the other direction.
    `PlayResX: ${strip.videoWidth}`,
    `PlayResY: ${strip.videoHeight}`,
    // 0 keeps libass wrapping anything our own wrapper mis-measured, rather than
    // letting a wide line run off the frame.
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...eventLines,
    '',
  ].join('\n')

  return { text, strip, adjustments, inputAdjustments, ...(inputNote ? { inputNote } : {}) }
}

/** ASS wants `H:MM:SS.cc` — centiseconds, one digit of hours, no padding on hours. */
function assTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const h = Math.floor(clamped / 3_600_000)
  const m = Math.floor(clamped / 60_000) % 60
  const s = Math.floor(clamped / 1000) % 60
  const cs = Math.floor((clamped % 1000) / 10)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${h}:${p(m)}:${p(s)}.${p(cs)}`
}

/**
 * Escape a path for use as a value inside an ffmpeg filtergraph.
 *
 * Two independent unescape passes run before the `subtitles` filter ever sees the
 * string, and both have to be undone in the right order (ffmpeg-filters(1), "Notes on
 * filtergraph escaping"):
 *
 *   1. the filter's own option parser, where `:` separates options and `'`/`\` quote;
 *   2. the filtergraph parser, where `,` and `;` separate filters, `[` `]` delimit
 *      links, `'` quotes, and `\` escapes — including the backslashes level 1 added.
 *
 * There is no third, shell pass: the whole `-vf` argument is one argv element.
 */
export function escapeFilterPath(p: string): string {
  const level1 = p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  return level1.replace(/\\/g, '\\\\').replace(/['[\],;]/g, (c) => '\\' + c)
}

/**
 * Read a JPEG's pixel dimensions from its SOF marker.
 *
 * This measures the PAGE — a captured frame is the page and nothing else. The ASS PlayRes
 * is NOT this: `formatAss` appends the caption strip and writes PlayRes from the sum, so
 * the page size measured here is the input to that calculation rather than its answer.
 * Done by hand rather than with `image-size` because that is a devDependency and this file
 * runs in the published package.
 *
 * `null` means "this is not a JPEG we can measure". **Never default around it** — see
 * `resolveFrameSize`, which is the only thing that should call this on a captured frame.
 */
export function readJpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    // A marker may be preceded by any number of 0xFF fill bytes (ITU-T T.81 B.1.1.2), so
    // 0xFF here is padding and the REAL marker is one byte further on. Treating it as a
    // marker read the next two bytes as a segment length and jumped into the middle of
    // the entropy-coded data, from which the scan never recovers — a silent `null`.
    if (marker === 0xff) {
      i++
      continue
    }
    // 0xFF00 is a stuffed byte inside entropy-coded data, not a marker at all.
    if (marker === 0x00) {
      i += 2
      continue
    }
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    // Any SOFn except the arithmetic/DHT/DAC oddities in the same numeric range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

/** What `resolveFrameSize` found. `note` is set only when something is worth saying. */
export interface ResolvedFrameSize {
  width: number
  height: number
  /** Present when the frames were not all the same size. Never silent. */
  note?: string
}

/**
 * The PAGE size — the size of the captured frames, and the base every style in the ASS
 * file is expressed as a fraction of.
 *
 * Not the size of the encoded video, which is taller by `captionStripMetrics(...).height`.
 * The distinction matters in exactly one direction: everything a caller can choose
 * (`fontSizePct`, `marginPct`) is a fraction of THIS, so that the strip, whose height is
 * derived from those fractions, cannot feed back into them.
 *
 * THROWS rather than defaulting. The previous `?? { width: 1280, height: 720 }` was a
 * silent catastrophe: on a 480x320 frame it declared PlayRes 1280x720, and since
 * `ScaledBorderAndShadow: yes` scales the whole style by the frame/PlayRes ratio, every
 * margin ended up computed against the wrong aspect — a 5% horizontal margin becoming
 * 5% of 1280 rendered into 480px of frame. The result object reported success either way,
 * so the only evidence was a human looking at the file. The other call site defaulted to
 * `undefined`, which made `rowCharBudget` `Infinity` and quietly deleted the row-width
 * cap. One function now answers the question for both, and it cannot answer it wrongly.
 *
 * Also the only place that notices frames of DIFFERING size. `PlayRes` can only describe
 * one of them, so the rest render at the wrong scale.
 *
 * This note is the ONLY thing that reports it, which is the opposite of what an earlier
 * version of this comment claimed ("ffmpeg's concat demuxer usually fails on this
 * outright, but when it does not the mis-scaling is invisible"). MEASURED against ffmpeg
 * 4.4.2 through `buildEncodeArgs`'s own arg list, concatenating a 320x240 frame followed
 * by two 160x120 frames: exit code 0, a valid 2.8s mp4 at 320x240, and not one line of
 * stderr mentioning width, height, a size change or an error. It does not usually fail —
 * on this build it did not fail at all, it silently rescaled. So there is no crash to fall
 * back on and this is the whole warning. Reported rather than thrown, because the first
 * frame's size is still the best available answer and a recording that already happened
 * should not be destroyed by the report.
 */
export function resolveFrameSize(frames: Array<{ data: Buffer }>): ResolvedFrameSize {
  if (frames.length === 0) {
    throw new Error('resolveFrameSize needs at least one captured frame; there is nothing to size the overlay against.')
  }
  const first = readJpegSize(frames[0].data)
  if (!first) {
    throw new Error(
      'Could not read the pixel dimensions of the first captured frame: no JPEG SOF marker was found in ' +
        `${frames[0].data.length} bytes. Every caption and chip size is expressed as a fraction of the frame, so ` +
        'there is no safe size to fall back to — a guess would burn a caption at the wrong scale into a result ' +
        'object that still says it succeeded. Capture with format: "jpeg" (Page.startScreencast / ' +
        'Page.captureScreenshot both default to it here) and check that the frame data is not truncated.',
    )
  }
  const counts = new Map<string, number>()
  let unreadable = 0
  for (const f of frames) {
    const s = readJpegSize(f.data)
    if (!s) {
      unreadable++
      continue
    }
    const k = `${s.width}x${s.height}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  if (counts.size <= 1 && unreadable === 0) return { width: first.width, height: first.height }

  const listed = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n} frame${n === 1 ? '' : 's'})`)
  return {
    width: first.width,
    height: first.height,
    note:
      `The captured frames are not all the same size: ${listed.join(', ')}` +
      (unreadable > 0 ? `, plus ${unreadable} frame(s) whose dimensions could not be read` : '') +
      `. The overlay is laid out for ${first.width}x${first.height} (the first frame), so on every other size the ` +
      'captions and chips are drawn at the wrong scale and may sit off the edge. This happens when the viewport is ' +
      'resized mid-recording, or when maxWidth/maxHeight start clamping partway through. Re-record without ' +
      'resizing, or set a fixed viewport before starting.',
  }
}

/* ------------------------------------------------------- ffmpeg capabilities */

export interface FfmpegCaptionCaps {
  /** `subtitles`/`ass` filters — present only in an ffmpeg built --enable-libass. */
  libass: boolean
  /** `mov_text`, the only subtitle codec an mp4 can carry. */
  movText: boolean
}

let capsCache: Promise<FfmpegCaptionCaps> | null = null

/**
 * Ask ffmpeg what it can do, before asking it to do it.
 *
 * Detecting up front rather than parsing a failed run's stderr: a missing libass
 * surfaces as a generic "No such filter" buried in a hundred lines of build config,
 * and the caller needs to be told which of the other two modes to use instead.
 */
export function ffmpegCaptionCapabilities(force = false): Promise<FfmpegCaptionCaps> {
  if (!capsCache || force) {
    capsCache = (async () => {
      const [filters, encoders] = await Promise.all([
        captureFfmpeg(['-hide_banner', '-filters']).catch(() => ''),
        captureFfmpeg(['-hide_banner', '-encoders']).catch(() => ''),
      ])
      return {
        libass: /^\s*\S+\s+subtitles\s/m.test(filters),
        movText: /^\s*\S+\s+mov_text\s/m.test(encoders),
      }
    })()
  }
  return capsCache
}

function captureFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout?.on('data', (c) => {
      out += c.toString()
    })
    proc.on('error', (err) => reject(new Error(`ffmpeg failed to spawn (is it installed?): ${err.message}`)))
    proc.on('close', () => resolve(out))
  })
}

/**
 * Encode captured frames to mp4, preserving real timing.
 *
 * ffmpeg's concat demuxer takes an explicit `duration` per image, so a still stretch
 * of the recording stays still for the right length instead of being compressed away.
 * We then force a constant output rate so ordinary players scrub correctly.
 */
export async function encodeFrames({
  frames,
  outputPath,
  fps,
  durationMs,
  captions,
  captionOptions,
  inputSegments,
  inputOverlayOptions,
  videoSize,
}: {
  frames: CapturedFrame[]
  outputPath: string
  fps: number
  durationMs: number
  /** Already resolved onto the video timeline by `buildCues`. */
  captions?: ResolvedCue[]
  captionOptions?: CaptionOptions
  /** Already resolved onto the video timeline by `buildInputChips`. */
  inputSegments?: InputSegment[]
  inputOverlayOptions?: InputOverlayOptions
  /**
   * The frame size the ASS PlayRes is written from. Optional so a caller that only wants
   * an encode need not measure it; when it is omitted and a burn is actually required,
   * `resolveFrameSize` measures it here and THROWS if it cannot — it never guesses.
   */
  videoSize?: { width: number; height: number }
}): Promise<{
  render: CaptionRender[]
  files: string[]
  extraAdjustments: Map<number, string[]>
  inputAdjustments: Map<number, string[]>
  /**
   * The caption strip appended below the page, when there was one. Absent when nothing was
   * burned, in which case the encoded frame is exactly the page.
   */
  strip?: CaptionStripMetrics
  /** Set when the layout itself had to compromise. */
  inputNote?: string
}> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-screencast-'))
  try {
    const lines: string[] = []
    frames.forEach((frame, i) => {
      const file = path.join(workDir, `f${String(i).padStart(6, '0')}.jpg`)
      fs.writeFileSync(file, frame.data)
      // Hold this frame until the next one arrived (last frame gets a sane tail).
      // The floor must stay well below the output frame interval: clamping to 1/fps
      // would stretch a burst of rapid repaints into one wall-clock second each and
      // desynchronise the whole clip from real time. `-vsync cfr` resamples anyway.
      const next = i + 1 < frames.length ? frames[i + 1].offsetMs : durationMs
      const holdSec = Math.max((next - frame.offsetMs) / 1000, 0.001)
      lines.push(`file ${quoteConcatPath(file)}`, `duration ${holdSec.toFixed(3)}`)
    })
    // concat demuxer quirk: the final image must be repeated or it is dropped.
    //
    // MEASURED against ffmpeg 4.4.2 through the exact arg list `buildEncodeArgs` emits,
    // decoding every output frame and classifying it by colour. On the shape this recorder
    // actually produces — 20 rapid frames at `duration 0.016` then a final image held for
    // 1.000s:
    //
    //     without the repeat   RGRGG              0.5s — the final image is ABSENT
    //     with the repeat      RGRGGBBBBBBBBB     1.4s — it is present for its full hold
    //
    // So the quirk is real and this line is load-bearing. It is shape-dependent, which is
    // worth knowing before "simplifying" it away: with three images held 0.5s each the
    // final image survives without the repeat (`RRRRRGGGGBBBB`) and the repeat only
    // lengthens its tail (`RRRRRGGGGBBBBBBBBBBB`). Testing it on evenly-spaced frames
    // would therefore "prove" the line unnecessary.
    lines.push(`file ${quoteConcatPath(path.join(workDir, `f${String(frames.length - 1).padStart(6, '0')}.jpg`))}`)

    const listFile = path.join(workDir, 'frames.txt')
    fs.writeFileSync(listFile, lines.join('\n'))

    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })

    const emitted = (captions ?? []).filter((c) => !c.dropped)
    const segments = inputSegments ?? []
    if (emitted.length === 0 && segments.length === 0) {
      // No captions and no overlay, no change: the args below must stay identical to
      // what this recorder emitted before either feature existed.
      await runFfmpeg(buildEncodeArgs({ listFile, outputPath, fps }))
      return { render: [], files: [], extraAdjustments: new Map(), inputAdjustments: new Map() }
    }
    let inputNote: string | undefined

    const render = emitted.length === 0 ? [] : normalizeRender(captionOptions?.render)
    // The overlay is pixels or nothing: there is no soft or sidecar form of a key chip,
    // so it burns regardless of what captionOptions.render says about the captions.
    const needsBurn = render.includes('burn') || segments.length > 0
    const caps = await ffmpegCaptionCapabilities()
    if (needsBurn && !caps.libass) {
      throw new Error(
        segments.length > 0 && !render.includes('burn')
          ? 'The input overlay is burned into the pixels and needs an ffmpeg built with libass: the ' +
            '`subtitles` filter is absent from `ffmpeg -filters` on this machine. There is no soft or ' +
            'sidecar form of a key chip — either install an ffmpeg configured with --enable-libass, or ' +
            're-run with inputOverlay: false.'
          : 'Caption burn-in needs an ffmpeg built with libass: the `subtitles` filter is absent from ' +
            '`ffmpeg -filters` on this machine. Re-run with captionOptions.render: "sidecar" (writes a ' +
            '.srt next to the mp4) or "soft" (a toggleable mov_text track in the mp4), or install an ' +
            'ffmpeg configured with --enable-libass.',
      )
    }
    if (render.includes('soft') && !caps.movText) {
      throw new Error(
        'Soft captions need the `mov_text` encoder, which is absent from `ffmpeg -encoders` on this ' +
          'machine — mp4 can carry no other subtitle codec. Re-run with captionOptions.render: "burn" ' +
          '(rendered into the pixels) or "sidecar" (a .srt beside the mp4).',
      )
    }

    let burnAssPath: string | undefined
    let strip: CaptionStripMetrics | undefined
    let extraAdjustments = new Map<number, string[]>()
    let inputAdjustments = new Map<number, string[]>()
    if (needsBurn) {
      // The PAGE size. `formatAss` derives the letterboxed PlayRes from it and hands back
      // the strip, which is what `buildEncodeArgs` pads with — so the ASS and the filter
      // chain cannot disagree about where the page ends and the caption begins.
      // No fallback: a wrong page size silently rescales every margin and font in the file.
      const measured = videoSize ?? resolveFrameSize(frames)
      const size = { width: measured.width, height: measured.height }
      const ass = formatAss(
        render.includes('burn') ? emitted : [],
        size,
        captionOptions,
        segments.length > 0 ? { segments, options: inputOverlayOptions } : undefined,
      )
      extraAdjustments = ass.adjustments
      inputAdjustments = ass.inputAdjustments
      inputNote = ass.inputNote
      strip = ass.strip
      burnAssPath = path.join(workDir, 'captions.ass')
      fs.writeFileSync(burnAssPath, ass.text, 'utf8')
    }

    let softSrtPath: string | undefined
    if (render.includes('soft')) {
      softSrtPath = path.join(workDir, 'captions.srt')
      fs.writeFileSync(softSrtPath, formatSrt(emitted), 'utf8')
    }

    await runFfmpeg(buildEncodeArgs({ listFile, outputPath, fps, burnAssPath, softSrtPath, strip }))

    const files: string[] = []
    if (render.includes('sidecar')) {
      const formats = captionOptions?.sidecarFormats ?? CAPTION_DEFAULTS.sidecarFormats
      const base = path.resolve(outputPath).replace(/\.[^./\\]*$/, '')
      for (const format of formats) {
        const target = `${base}.${format}`
        fs.writeFileSync(target, format === 'srt' ? formatSrt(emitted) : formatVtt(emitted), 'utf8')
        files.push(target)
      }
    }

    return {
      render,
      files,
      extraAdjustments,
      inputAdjustments,
      ...(strip && strip.height > 0 ? { strip } : {}),
      ...(inputNote ? { inputNote } : {}),
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

/**
 * Quote a path for a concat list line.
 *
 * The frames live under `os.tmpdir()`, which is `TMPDIR` — a caller-controlled value.
 * A single quote in it terminated the `file '...'` token early and ffmpeg failed with
 * "Impossible to open" on a truncated path; found by pointing TMPDIR at a hostile
 * directory. The demuxer takes the usual `'\''` break-out, verified against ffmpeg.
 */
function quoteConcatPath(p: string): string {
  return `'${p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`
}

function normalizeRender(render: CaptionOptions['render']): CaptionRender[] {
  const list = render === undefined ? CAPTION_DEFAULTS.render : Array.isArray(render) ? render : [render]
  const seen = new Set<CaptionRender>()
  for (const r of list) {
    if (r !== 'burn' && r !== 'soft' && r !== 'sidecar') {
      throw new Error(`Unknown caption render mode ${JSON.stringify(r)}; expected 'burn', 'soft' or 'sidecar'.`)
    }
    seen.add(r)
  }
  if (seen.size === 0) throw new Error('captionOptions.render was empty — captions were supplied with nowhere to put them.')
  return [...seen]
}

/**
 * The ffmpeg command line, in one place so a test can prove the uncaptioned form is
 * byte-for-byte what it always was.
 *
 * `-vf` may only appear once, so everything is one chain, and the ORDER of the three stages
 * is the whole of the letterbox mechanism:
 *
 *     scale  →  pad (rule, then strip)  →  subtitles
 *
 *   - `scale` first, because `trunc(iw/2)*2` is what makes the PAGE dimensions even, and
 *     `captionStripMetrics` computes its geometry against those rounded numbers. Padding
 *     first and scaling after would round the SUM and could shave a row off the strip.
 *   - `pad` next. It places the input at `0:0` and fills the new rows below it, so the page
 *     keeps the origin it had and every page pixel keeps its coordinates. This is the line
 *     that makes the page area of the output identical to the page area of the input — pad
 *     copies, it does not resample.
 *   - `subtitles` last, so libass draws at the final resolution and the ASS PlayRes — which
 *     `formatAss` wrote from `strip.videoWidth/videoHeight` — lines up with what the viewer
 *     sees. Drawing before the pad would put the caption on the page and then push it up.
 *
 * TWO PADS, NOT ONE, because the rule is a different colour from the strip: the first adds
 * `ruleHeight` rows of `ruleColor`, the second adds the rest in `stripColor`. `iw`/`ih` are
 * re-evaluated per filter, so the second sees the height the first produced.
 *
 * EVEN DIMENSIONS, WHICH `-pix_fmt yuv420p` REQUIRES. `scale` makes the page even and
 * `captionStripMetrics` rounds the strip UP to even, so the sum is even by construction and
 * no second `trunc` is needed after the pad. Getting this wrong is not subtle — x264 refuses
 * an odd dimension outright — but it is worth stating, because the guarantee now comes from
 * arithmetic in another file rather than from the filter that used to carry it.
 */
export function buildEncodeArgs({
  listFile,
  outputPath,
  fps,
  burnAssPath,
  softSrtPath,
  strip,
}: {
  listFile: string
  outputPath: string
  fps: number
  burnAssPath?: string
  softSrtPath?: string
  /** The caption strip to append below the page. Omitted or zero-height means no letterbox. */
  strip?: Pick<CaptionStripMetrics, 'height' | 'ruleHeight' | 'stripColor' | 'ruleColor'>
}): string[] {
  const stages = ['scale=trunc(iw/2)*2:trunc(ih/2)*2']
  if (strip && strip.height > 0) {
    if (strip.ruleHeight > 0) stages.push(`pad=iw:ih+${strip.ruleHeight}:0:0:${ffmpegColor(strip.ruleColor)}`)
    stages.push(`pad=iw:ih+${strip.height - strip.ruleHeight}:0:0:${ffmpegColor(strip.stripColor)}`)
  }
  if (burnAssPath) stages.push(`subtitles=${escapeFilterPath(burnAssPath)}`)
  const filter = stages.join(',')

  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    ...(softSrtPath ? ['-i', softSrtPath] : []),
    '-vsync', 'cfr',
    '-r', String(fps),
    ...(softSrtPath ? ['-map', '0:v:0', '-map', '1:s:0', '-c:s', 'mov_text'] : []),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    // yuv420p needs even dimensions; screencast output is often odd, and the strip is
    // rounded up to even so the padded sum stays even too.
    '-vf', filter,
    '-movflags', '+faststart',
    path.resolve(outputPath),
  ]
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (chunk) => {
      // Keep only the tail; ffmpeg is extremely chatty.
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    proc.on('error', (err) =>
      reject(new Error(`ffmpeg failed to spawn (is it installed?): ${err.message}`)),
    )
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr}`))
    })
  })
}
