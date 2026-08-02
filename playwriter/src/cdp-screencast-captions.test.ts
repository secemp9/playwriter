/**
 * Captions for the gesture-free recorder.
 *
 * These tests encode for real. Mocking ffmpeg here would prove nothing: every bug this
 * feature can have — a cue one repaint late, a filtergraph that eats a comma in the
 * path, an override block that swallows a caption — only exists on the other side of
 * the process boundary.
 *
 * The load-bearing one is `alignment`. `encodeFrames` holds each frame until the next
 * arrived, so video time 0 is the FIRST FRAME'S arrival, not the recording start. A
 * test that merely asserts "a cue exists" would pass with every caption seconds late.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  buildCues,
  buildEncodeArgs,
  captionBackdropPaddingPx,
  captionBackdropRect,
  captionBlockHeightPx,
  defaultOutlineWidth,
  encodeFrames,
  escapeAssText,
  escapeFilterPath,
  ffmpegCaptionCapabilities,
  formatAss,
  formatSrt,
  formatVtt,
  normalizeCaptionText,
  readableDurationMs,
  readJpegSize,
  renderedCaptionLines,
  resolveFrameSize,
  startCdpScreencast,
  validateVisualOptions,
  wrapCaptionText,
  type CaptionOptions,
  type ResolvedCue,
  type StampedCaption,
} from './cdp-screencast.js'
import type { CdpScreencastHandle } from './cdp-screencast.js'
import type { recording as recordingDecl } from './debugger-examples-types.js'
import { brightPixelsPerFrame, openVideo } from './video-probe.js'
import { PlaywrightCDPSessionAdapter } from './cdp-session.js'
import { getChromium } from './playwright-import.js'
import type { Browser, BrowserContext } from '@xmorse/playwright-core'

/* ------------------------------------------------------------------ utilities */

let tmpRoot: string

function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c) => (stdout += c.toString()))
    proc.stderr.on('data', (c) => (stderr += c.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** Solid-colour JPEGs stand in for screencast frames; ffmpeg makes them faster than sharp. */
async function solidJpeg(color: string, size = '320x240'): Promise<Buffer> {
  const file = path.join(tmpRoot, `solid-${color}-${size}.jpg`)
  if (!fs.existsSync(file)) {
    const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', file])
    if (r.code !== 0) throw new Error(r.stderr)
  }
  return fs.readFileSync(file)
}

/**
 * Count bright pixels in the bottom third of every decoded frame.
 *
 * Now one line over `video-probe`'s `brightPixelsPerFrame`. This file and the input-overlay
 * suite each carried their own copy of this loop and the two had drifted — that one took a
 * region, this one hardcoded the bottom third — so a change to either proved nothing about
 * the other.
 *
 * A `> 200` threshold on a gray conversion is "bright", not "ink": it is hue-dependent and
 * on a light page it matches the whole frame. Every plate in this file is solid black,
 * which is the only reason it answers the question being asked. Anything new should use the
 * clean-plate differential in `video-invariants.ts`, which does not care about the page.
 *
 * The width and height are no longer parameters: they come from ffprobe, so a caller who
 * believes the wrong size gets an error rather than a sheared image.
 */
async function inkPerFrame(videoPath: string): Promise<number[]> {
  return brightPixelsPerFrame(await openVideo(videoPath), { y0: 0.66 })
}

async function subtitleStreams(videoPath: string): Promise<Array<{ codec_name?: string }>> {
  const r = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 's',
    '-show_entries', 'stream=codec_name',
    '-of', 'json',
    videoPath,
  ])
  return JSON.parse(r.stdout || '{}').streams ?? []
}

/** A deliberately naive SRT reader — if the emitted file needs a lenient parser, it is wrong. */
function parseSrt(text: string): Array<{ index: number; startMs: number; endMs: number; text: string }> {
  const out: Array<{ index: number; startMs: number; endMs: number; text: string }> = []
  for (const block of text.trim().split(/\n\n/)) {
    const lines = block.split('\n')
    const index = Number(lines[0])
    const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(lines[1])
    if (!Number.isInteger(index) || !m) throw new Error(`unparseable SRT block:\n${block}`)
    const at = (i: number) => Number(m[i]) * 3_600_000 + Number(m[i + 1]) * 60_000 + Number(m[i + 2]) * 1000 + Number(m[i + 3])
    out.push({ index, startMs: at(1), endMs: at(5), text: lines.slice(2).join('\n') })
  }
  return out
}

function stamp(text: string, atMs: number, durationMs?: number): StampedCaption {
  const n = normalizeCaptionText(text)
  const blank = n.text === ''
  const w = blank ? { text: '', adjustments: [] as string[] } : wrapCaptionText(n.text, 42, 3)
  return { text: w.text, atMs, durationMs, blank, adjustments: [...n.adjustments, ...w.adjustments] }
}

/**
 * The sandbox declarations are what an agent writes against, and nothing imports them
 * at runtime — so without this they can drift from the recorder and no build notices.
 * tsc fails here the moment the two signatures disagree.
 */
type CaptionDeclMatchesHandle = CdpScreencastHandle['caption'] extends typeof recordingDecl.caption
  ? typeof recordingDecl.caption extends CdpScreencastHandle['caption']
    ? true
    : never
  : never
type ClearDeclMatchesHandle = CdpScreencastHandle['clearCaption'] extends typeof recordingDecl.clearCaption
  ? typeof recordingDecl.clearCaption extends CdpScreencastHandle['clearCaption']
    ? true
    : never
  : never
const declarationsMatchTheRecorder: [CaptionDeclMatchesHandle, ClearDeclMatchesHandle] = [true, true]

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-caption-test-'))
})

it('declares the sandbox recording API with the recorder’s own signatures', () => {
  expect(declarationsMatchTheRecorder).toEqual([true, true])
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/* ------------------------------------------------------------ the timing trap */

describe('buildCues: the video timeline is not the recording timeline', () => {
  it('shifts every cue by frames[0].offsetMs', () => {
    // The first repaint landed 800ms after the recording began.
    const frameOffsetsMs = [800, 1800, 2800, 3800]
    const built = buildCues({
      captions: [stamp('step one', 800), stamp('step two', 2800)],
      frameOffsetsMs,
      durationMs: 4800,
    })

    expect(built.videoStartOffsetMs).toBe(800)
    expect(built.videoDurationMs).toBe(4000)
    // Wall clock 800 -> video 0; wall clock 2800 -> video 2000. NOT 800 and 2800.
    expect(built.cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 2000],
      [2000, 4000],
    ])
  })

  it('is not fooled by a first frame at offset 0 (the case that hides the bug)', () => {
    const built = buildCues({
      captions: [stamp('a', 1000)],
      frameOffsetsMs: [0, 1000, 2000],
      durationMs: 3000,
    })
    expect(built.videoStartOffsetMs).toBe(0)
    expect(built.cues[0].startMs).toBe(1000)
  })

  it('reports the wall-clock stamp alongside the video time so the shift stays auditable', () => {
    const built = buildCues({ captions: [stamp('x', 2500)], frameOffsetsMs: [1000, 2500, 4000], durationMs: 5000 })
    expect(built.cues[0].atMs).toBe(2500)
    expect(built.cues[0].startMs).toBe(1500)
  })
})

/* --------------------------------------------------------------- cue hazards */

describe('buildCues: cue hazards', () => {
  const frameOffsetsMs = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]

  it('clamps a caption stamped before the first frame, and says so', () => {
    const built = buildCues({ captions: [stamp('early', 100)], frameOffsetsMs: [1000, 2000, 3000], durationMs: 4000 })
    expect(built.cues[0].startMs).toBe(0)
    expect(built.cues[0].adjustments?.join(' ')).toMatch(/900ms before the first captured frame/)
  })

  it('drops a caption stamped past the end of the video, and says so', () => {
    const built = buildCues({ captions: [stamp('late', 9000)], frameOffsetsMs, durationMs: 4500 })
    expect(built.cues[0].dropped).toBe(true)
    expect(built.cues[0].index).toBe(-1)
    expect(built.cues[0].adjustments?.join(' ')).toMatch(/past the .* end of the clip/)
    expect(built.note).toMatch(/1 caption\(s\) dropped/)
  })

  it('sorts non-chronological input and flags it', () => {
    const built = buildCues({
      captions: [stamp('second', 2000), stamp('first', 500)],
      frameOffsetsMs,
      durationMs: 4500,
    })
    expect(built.cues.map((c) => c.text)).toEqual(['first', 'second'])
    expect(built.cues[0].adjustments?.join(' ')).toMatch(/not in chronological order/)
  })

  it('never overlaps: an over-long explicit duration is cut by the next caption', () => {
    const built = buildCues({
      captions: [stamp('long', 500, 9999), stamp('next', 2000)],
      frameOffsetsMs,
      durationMs: 4500,
    })
    expect(built.cues[0].endMs).toBe(built.cues[1].startMs)
    expect(built.cues[0].adjustments?.join(' ')).toMatch(/shortened to 1500ms by the caption that follows/)
  })

  it('honours an explicit duration that ends early, leaving a gap', () => {
    const built = buildCues({
      captions: [stamp('brief', 500, 1000), stamp('next', 3000)],
      frameOffsetsMs,
      durationMs: 4500,
    })
    expect(built.cues[0].endMs).toBe(1500)
    expect(built.cues[1].startMs).toBe(3000)
  })

  it('treats a zero or negative duration as "until the next caption" and reports it', () => {
    for (const bad of [0, -250]) {
      const built = buildCues({ captions: [stamp('z', 500, bad), stamp('n', 2000)], frameOffsetsMs, durationMs: 4500 })
      expect(built.cues[0].endMs).toBe(2000)
      expect(built.cues[0].adjustments?.join(' ')).toMatch(/is not positive/)
    }
  })

  it('reports a cue squeezed under the minimum instead of silently overlapping the next', () => {
    const built = buildCues({
      captions: [stamp('a', 500), stamp('b', 1000)],
      frameOffsetsMs,
      durationMs: 4500,
      // An explicit floor still overrides the reading model, flat, for every cue.
      options: { minDurationMs: 700 },
    })
    expect(built.cues[0].endMs - built.cues[0].startMs).toBe(500)
    expect(built.cues[0].adjustments?.join(' ')).toMatch(
      /on screen for 500ms but needs about 700ms to read \(the 700ms captionOptions.minDurationMs floor\); 200ms too fast/,
    )
    expect(built.pacing?.minDurationMs).toBe(700)
  })

  it('drops a caption that the next one replaces on the very same frame', () => {
    // Both land between the frames at 1000 and 2000, so only one can ever be seen.
    const built = buildCues({
      captions: [stamp('never seen', 1200), stamp('seen', 1700)],
      frameOffsetsMs: [0, 1000, 2000, 3000],
      durationMs: 4000,
    })
    expect(built.cues[0].dropped).toBe(true)
    expect(built.cues[0].adjustments?.join(' ')).toMatch(/same captured frame/)
    expect(built.cues[1].dropped).toBeUndefined()
  })

  it('snaps a cue back onto the frame that is actually on screen at that instant', () => {
    const built = buildCues({ captions: [stamp('now', 1700)], frameOffsetsMs: [0, 1000, 2000], durationMs: 3000 })
    expect(built.cues[0].startMs).toBe(1000)
    expect(built.cues[0].adjustments?.join(' ')).toMatch(/moved 700ms earlier onto the frame captured at 1000ms/)
  })

  it('drops everything when nothing repainted, rather than writing cues for a video that does not exist', () => {
    const built = buildCues({ captions: [stamp('a', 100)], frameOffsetsMs: [], durationMs: 2000 })
    expect(built.cues[0].dropped).toBe(true)
    expect(built.cues[0].adjustments?.join(' ')).toMatch(/no frames were captured/)
  })
})

describe('clearCaption / blank cues', () => {
  const frameOffsetsMs = [0, 500, 1000, 1500, 2000, 2500, 3000]

  it('ends the running caption and emits nothing of its own', () => {
    const built = buildCues({
      captions: [stamp('narration', 500), stamp('', 1500)],
      frameOffsetsMs,
      durationMs: 3500,
    })
    expect(built.cues).toHaveLength(1)
    expect(built.cues[0].endMs).toBe(1500)
  })

  it('without it, the last caption runs to the end of the clip', () => {
    const built = buildCues({ captions: [stamp('narration', 500)], frameOffsetsMs, durationMs: 3500 })
    expect(built.cues[0].endMs).toBe(3500)
  })
})

/* ------------------------------------------------------------------- pacing */

/**
 * The defect these cover is not a crash, it is a clip nobody can read: three captions and
 * three key chips flashing past inside 2.25 seconds. The old flat 700ms floor called that
 * fine, which is why the floor is gone and the requirement now comes from the text.
 */
describe('readableDurationMs: the minimum comes from the text, not from a constant', () => {
  it('gives a long cue more time than a short one', () => {
    const short = readableDurationMs('Done')
    const long = readableDurationMs('2. Select all in the email field')
    const longer = readableDurationMs('BUG: the badge still reads 3 after every item was removed from the cart')
    expect(long).toBeGreaterThan(short)
    expect(longer).toBeGreaterThan(long)
  })

  it('asks for about two seconds for the 32-character cue that motivated this', () => {
    // 32 characters at 17cps is ~1.9s of pure reading, plus the look at the page.
    expect(readableDurationMs('2. Select all in the email field')).toBe(2482)
  })

  it('floors a two-word cue rather than letting it flash', () => {
    expect(readableDurationMs('Done')).toBe(1200)
    expect(readableDurationMs('Go')).toBe(1200)
  })

  it('caps the requirement, so a pathological cue cannot demand a minute of hold time', () => {
    expect(readableDurationMs('x'.repeat(5000))).toBe(7000)
  })

  it('follows the reading rate, for a caller who localises or narrates jargon', () => {
    const text = '2. Select all in the email field'
    expect(readableDurationMs(text, { readingRateCps: 9 })).toBeGreaterThan(readableDurationMs(text))
    expect(readableDurationMs(text, { readingRateCps: 30 })).toBeLessThan(readableDurationMs(text))
    expect(() => readableDurationMs(text, { readingRateCps: 0 })).toThrow(/positive number of characters per second/)
  })

  it('lets an explicit minDurationMs override the model entirely, flat', () => {
    expect(readableDurationMs('Done', { minDurationMs: 400 })).toBe(400)
    expect(readableDurationMs('x'.repeat(200), { minDurationMs: 400 })).toBe(400)
  })

  it('counts a wrapped multi-line cue as one run of text, not per line', () => {
    expect(readableDurationMs('aaaa bbbb\ncccc dddd')).toBe(readableDurationMs('aaaa bbbb cccc dddd'))
  })
})

describe('buildCues: telling the caller the clip is too fast to read', () => {
  /** The 2.25s three-caption repro, at 8fps, reduced to its timings. */
  const fastFrames = Array.from({ length: 18 }, (_, i) => i * 125)
  const fastCaptions = [
    stamp('1. Fill in the checkout form', 0),
    stamp('2. Select all in the email field', 750),
    stamp('3. Click Pay once', 1500),
  ]

  it('names the deficit AND the cause on every cue that outran its reading time', () => {
    const built = buildCues({ captions: fastCaptions, frameOffsetsMs: fastFrames, durationMs: 2250 })
    const adjustments = built.cues.map((c) => c.adjustments?.join(' ') ?? '')

    // 28 chars -> 2247ms needed, 750ms given.
    expect(adjustments[0]).toMatch(/on screen for 750ms but needs about 2247ms to read \(28 characters at 17 chars\/sec\); 1497ms too fast/)
    expect(adjustments[0]).toMatch(/the next caption arrived 750ms later — hold this beat before narrating again/)
    expect(adjustments[1]).toMatch(/needs about 2482ms to read/)
    // The last cue ran to the end of the clip, so the fix is a different one.
    expect(adjustments[2]).toMatch(/the recording stopped 750ms after it appeared — let the final state sit on screen before stopCdp/)
  })

  it('summarises the whole clip, with the numbers, in a warning an agent cannot skim past', () => {
    const built = buildCues({ captions: fastCaptions, frameOffsetsMs: fastFrames, durationMs: 2250 })

    expect(built.pacing).toEqual({
      cues: 3,
      cuesTooFast: 3,
      // 2247 + 2482 + 1600, against 750ms of screen time each.
      narrationNeedsMs: 6329,
      videoDurationMs: 2250,
      shortfallMs: 4079,
      readingRateCps: 17,
    })
    expect(built.pacingWarning).toMatch(/^TOO FAST TO READ: 3 of 3 captions were on screen for less time than the text needs — 4\.1s short in total\./)
    expect(built.pacingWarning).toMatch(/needs 6\.3s of reading time and the clip is only 2\.3s long/)
    expect(built.pacingWarning).toMatch(/Do NOT slow the video down/)
  })

  it('says the pauses are misplaced, not that the clip is too short, when the total does fit', () => {
    const built = buildCues({
      // Two cues in a 20s clip, but stamped 300ms apart.
      captions: [stamp('1. Fill in the checkout form', 0), stamp('2. Select all in the email field', 300)],
      frameOffsetsMs: Array.from({ length: 160 }, (_, i) => i * 125),
      durationMs: 20000,
    })
    expect(built.pacing?.cuesTooFast).toBe(1)
    expect(built.pacingWarning).toMatch(/there is room — the pauses are in the wrong places/)
    expect(built.pacingWarning).not.toMatch(/nobody watching can follow it/)
  })

  it('says nothing at all about pacing when the clip is properly paced', () => {
    // The same three captions, held ~4.5s each: 20.25s of video, the human-paced re-run.
    const built = buildCues({
      captions: [
        // On the frame grid, so the only adjustment left to see is a pacing one.
        stamp('1. Fill in the checkout form', 0),
        stamp('2. Select all in the email field', 4750),
        stamp('3. Click Pay once', 9625),
        stamp('BUG: charged twice from one click', 14375),
      ],
      frameOffsetsMs: Array.from({ length: 160 }, (_, i) => i * 125),
      durationMs: 20250,
    })
    expect(built.pacingWarning).toBeUndefined()
    expect(built.pacing).toMatchObject({ cues: 4, cuesTooFast: 0, shortfallMs: 0 })
    expect(built.cues.every((c) => !c.adjustments?.some((a) => a.includes('too fast')))).toBe(true)
    expect(built.note).toBeUndefined()
  })

  it('blames an explicit durationMs when that is what cut the cue short', () => {
    const built = buildCues({
      captions: [stamp('2. Select all in the email field', 0, 800)],
      frameOffsetsMs: Array.from({ length: 40 }, (_, i) => i * 100),
      durationMs: 4000,
    })
    expect(built.cues[0].adjustments?.join(' ')).toMatch(/durationMs: 800 ended it early, which is less than its reading time/)
  })

  it('reports no pacing at all when every cue was dropped, rather than a warning about nothing', () => {
    const built = buildCues({ captions: [stamp('a', 9000)], frameOffsetsMs: [0, 1000], durationMs: 2000 })
    expect(built.pacing).toBeUndefined()
    expect(built.pacingWarning).toBeUndefined()
  })
})

/* --------------------------------------------------------------- text hazards */

describe('caption text normalisation', () => {
  it('collapses blank lines, which would otherwise split an SRT cue in two', () => {
    const r = normalizeCaptionText('first\n\n\nsecond')
    expect(r.text).toBe('first\nsecond')
    expect(r.adjustments.join(' ')).toMatch(/blank lines collapsed/)
  })

  it('normalises CRLF and strips control characters', () => {
    const r = normalizeCaptionText('a\r\nb\u0007c')
    expect(r.text).toBe('a\nbc')
    expect(r.adjustments.join(' ')).toMatch(/control characters removed/)
  })

  it('keeps a legal embedded newline as a multi-line cue', () => {
    expect(normalizeCaptionText('line one\nline two').text).toBe('line one\nline two')
  })

  it('leaves --> and angle brackets alone; they are format hazards, not text hazards', () => {
    expect(normalizeCaptionText('a --> b <div>').text).toBe('a --> b <div>')
  })

  it('yields the blank sentinel for empty and whitespace-only text', () => {
    expect(normalizeCaptionText('').text).toBe('')
    expect(normalizeCaptionText('   \n  ').text).toBe('')
  })
})

describe('wrapCaptionText', () => {
  it('wraps on word boundaries', () => {
    const r = wrapCaptionText('the quick brown fox jumps over the lazy dog again', 20, 5)
    expect(r.text.split('\n').every((l) => l.length <= 20)).toBe(true)
    expect(r.text.replace(/\n/g, ' ')).toBe('the quick brown fox jumps over the lazy dog again')
  })

  it('breaks a single token longer than the line', () => {
    const r = wrapCaptionText('a'.repeat(45), 20, 5)
    expect(r.text.split('\n').every((l) => l.length <= 20)).toBe(true)
  })

  it('truncates past the line cap and says so', () => {
    const r = wrapCaptionText('word '.repeat(200).trim(), 42, 3)
    expect(r.text.split('\n')).toHaveLength(3)
    expect(r.text).toMatch(/…$/)
    expect(r.adjustments.join(' ')).toMatch(/truncated to 3 lines/)
  })
})

describe('escapeAssText: what libass will actually draw', () => {
  it('escapes braces, which are override syntax and swallow whatever is between them', () => {
    const r = escapeAssText('a {b} c')
    expect(r.text).toBe('a \\{b\\} c')
    expect(r.adjustments.join(' ')).toMatch(/braces escaped/)
  })

  it('turns a real newline into the ASS hard break', () => {
    expect(escapeAssText('one\ntwo').text).toBe('one\\Ntwo')
  })

  it('separates a caller backslash from N/n/h without doubling it', () => {
    // Doubling is wrong: libass renders `\\` as TWO visible backslashes (measured).
    const r = escapeAssText('C:\\Node')
    expect(r.text).toBe('C:\\\u200bNode')
    expect(r.adjustments.join(' ')).toMatch(/zero-width space/)
  })

  it('leaves a harmless backslash and angle brackets alone', () => {
    expect(escapeAssText('a\\b <i>c</i>').text).toBe('a\\b <i>c</i>')
  })
})

/* ------------------------------------------------------------ format exactness */

describe('formatSrt', () => {
  const cues: ResolvedCue[] = [
    { index: 1, text: 'first', startMs: 0, endMs: 1500, atMs: 0 },
    { index: 2, text: 'two\nlines', startMs: 1500, endMs: 3661001, atMs: 1500 },
    { index: -1, text: 'dropped', startMs: 0, endMs: 0, atMs: 0, dropped: true },
  ]

  it('uses a COMMA before the milliseconds, not a period', () => {
    expect(formatSrt(cues)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nfirst\n\n2\n00:00:01,500 --> 01:01:01,001\ntwo\nlines\n\n',
    )
  })

  it('renumbers around dropped cues so the indices stay contiguous', () => {
    expect(parseSrt(formatSrt(cues)).map((c) => c.index)).toEqual([1, 2])
  })

  it('round-trips text containing --> because a blank line can never appear inside a cue', () => {
    const srt = formatSrt([{ index: 1, text: 'input --> output', startMs: 0, endMs: 1000, atMs: 0 }])
    expect(parseSrt(srt)[0].text).toBe('input --> output')
  })
})

describe('formatVtt', () => {
  it('uses a PERIOD and escapes --> , which is illegal in a WebVTT payload', () => {
    const vtt = formatVtt([{ index: 1, text: 'a --> b <i>', startMs: 90, endMs: 1500, atMs: 0 }])
    expect(vtt).toBe('WEBVTT\n\n1\n00:00:00.090 --> 00:00:01.500\na --&gt; b &lt;i&gt;\n')
    // No payload line may contain the arrow.
    const payload = vtt.split('\n').slice(4)
    expect(payload.some((l) => l.includes('-->'))).toBe(false)
  })
})

describe('escapeFilterPath', () => {
  it('escapes both filtergraph levels, backslashes first', () => {
    expect(escapeFilterPath('/tmp/a b/c.ass')).toBe('/tmp/a b/c.ass')
    expect(escapeFilterPath('/tmp/x:y.ass')).toBe('/tmp/x\\\\:y.ass')
    expect(escapeFilterPath("/tmp/o'brien.ass")).toBe("/tmp/o\\\\\\'brien.ass")
    expect(escapeFilterPath('/tmp/a,b[1].ass')).toBe('/tmp/a\\,b\\[1\\].ass')
  })
})

describe('readJpegSize', () => {
  it('reads the SOF dimensions, width and height the right way round', async () => {
    expect(readJpegSize(await solidJpeg('red', '400x240'))).toEqual({ width: 400, height: 240 })
  })

  it('returns null for something that is not a JPEG', () => {
    expect(readJpegSize(Buffer.from('not a jpeg'))).toBeNull()
  })

  it('skips 0xFF fill bytes before a marker instead of losing the scan in them', async () => {
    // ITU-T T.81 B.1.1.2 lets any marker be preceded by any number of 0xFF fill bytes.
    // Reading one as a marker takes the next two bytes as a segment length and jumps into
    // the entropy-coded data, from which the scan never returns — a silent null.
    const real = await solidJpeg('red', '400x240')
    const padded = Buffer.concat([real.subarray(0, 2), Buffer.alloc(6, 0xff), real.subarray(2)])
    expect(readJpegSize(padded)).toEqual({ width: 400, height: 240 })
  })

  it('skips a stuffed 0xFF00 rather than reading it as a segment', async () => {
    const real = await solidJpeg('red', '400x240')
    const stuffed = Buffer.concat([real.subarray(0, 2), Buffer.from([0xff, 0x00]), real.subarray(2)])
    expect(readJpegSize(stuffed)).toEqual({ width: 400, height: 240 })
  })
})

describe('resolveFrameSize: the silent fallback is gone', () => {
  it('measures the frames', async () => {
    const f = await solidJpeg('red', '400x240')
    expect(resolveFrameSize([{ data: f }, { data: f }])).toEqual({ width: 400, height: 240 })
  })

  it('THROWS on an unreadable first frame rather than pretending it is 1280x720', () => {
    // The old `?? { width: 1280, height: 720 }` produced a perfectly clean result object
    // describing a video whose every caption and margin had been laid out for a frame four
    // times the area of the real one.
    expect(() => resolveFrameSize([{ data: Buffer.from('not a jpeg at all') }])).toThrow(
      /Could not read the pixel dimensions of the first captured frame/,
    )
    expect(() => resolveFrameSize([])).toThrow(/needs at least one captured frame/)
  })

  it('names the sizes when the frames are not all the same shape', async () => {
    const a = await solidJpeg('red', '400x240')
    const b = await solidJpeg('blue', '320x240')
    const r = resolveFrameSize([{ data: a }, { data: a }, { data: b }])
    expect(r).toMatchObject({ width: 400, height: 240 })
    expect(r.note).toMatch(/not all the same size: 400x240 \(2 frames\), 320x240 \(1 frame\)/)
    expect(r.note).toMatch(/drawn at the wrong scale/)
  })

  it('counts frames it could not measure, instead of dropping them', async () => {
    const a = await solidJpeg('red', '400x240')
    const r = resolveFrameSize([{ data: a }, { data: Buffer.from('junk') }])
    expect(r.note).toMatch(/1 frame\(s\) whose dimensions could not be read/)
  })
})

describe('the caption block, measured against libass rather than guessed', () => {
  it('is lines * fontSize plus ONE border, which is what libass draws', () => {
    // Measured: the baseline-to-baseline pitch is exactly the font size for every size and
    // every font tried, and the border is drawn once around the block, not once per line.
    expect(captionBlockHeightPx(1, 24, 2, 1)).toBe(29)
    expect(captionBlockHeightPx(3, 24, 2, 1)).toBe(77)
    // A tight upper bound on the measured 3-line ink height of 74px.
    expect(captionBlockHeightPx(3, 24, 2, 1)).toBeGreaterThanOrEqual(74)
    // The old formula reserved 102px for the same block — safe, but 38% too much.
    expect(3 * (Math.round(24 * 1.2) + 2 * 2 + 1)).toBe(102)
  })

  it('counts the lines libass will DRAW, not the lines our wrapper produced', () => {
    // 480x720 landscape: a 42-character line fits across the frame in one go.
    const text = 'x'.repeat(42)
    expect(renderedCaptionLines(text, 1152, 36)).toBe(1)
    // 390x844 portrait: the caption face is 42px and the usable width is 351px, so the same
    // 42 characters need three rendered lines. Counting source lines under-reserves the
    // caption block by 3x and puts the chip strip through the narration.
    expect(renderedCaptionLines(text, 351, 42)).toBeGreaterThanOrEqual(3)
    // Every source line is counted separately, and an empty one still occupies a line.
    expect(renderedCaptionLines('a\nb\nc', 1152, 36)).toBe(3)
  })

  it('puts the backdrop band across the WHOLE frame, and around the whole drawn block', () => {
    // 480x320 at the defaults: face 16, outline 1, shadow 1, marginV 19, pad 4.
    const video = { width: 480, height: 320 }
    expect(captionBackdropPaddingPx(16)).toBe(4)
    const two = captionBackdropRect(video, 2, 16, 1, 1, 19)
    // Full width, with no inset at all. This is the merge guarantee: on a row carrying
    // caption ink there is no page pixel left for a page glyph to occupy.
    expect([two.x0, two.x1]).toEqual([0, 480])
    // MEASURED on this machine's libass: the drawn extent of that exact 2-line caption is
    // rows 270..302. The band has to contain it with padding to spare on both sides.
    expect(two.y0).toBeLessThan(270)
    expect(two.y1).toBeGreaterThan(302)
    expect(two.y1 - two.y0).toBe(captionBlockHeightPx(2, 16, 1, 1) + 2 * 4)
    // A one-line cue gets a shorter band: the page is hidden for the rows the narration
    // occupies now, not for the rows the longest cue in the clip would need.
    const one = captionBackdropRect(video, 1, 16, 1, 1, 19)
    expect(one.y1).toBe(two.y1)
    expect(one.y0).toBe(two.y0 + 16)
  })

  it('keeps the band inside the frame however the caption is styled', () => {
    for (const height of [180, 320, 720, 844, 1440]) {
      for (const lines of [1, 2, 3]) {
        const video = { width: 640, height }
        const fontSize = Math.max(16, Math.round((height * 5) / 100))
        const marginV = Math.max(4, Math.round((height * 6) / 100))
        const r = captionBackdropRect(video, lines, fontSize, defaultOutlineWidth(fontSize), 1, marginV)
        expect(r.y0, `${height}px, ${lines} lines`).toBeGreaterThanOrEqual(0)
        expect(r.y1, `${height}px, ${lines} lines`).toBeLessThanOrEqual(height)
        expect(r.y1).toBeGreaterThan(r.y0)
        // The caption's ink bottom sits at height - marginV; the band must reach past it,
        // because MarginV measures to the INK box and the border overhangs below.
        expect(r.y1).toBeGreaterThan(height - marginV)
        // …and past its ink top, which is `lines * fontSize` above that.
        expect(r.y0).toBeLessThan(height - marginV - lines * fontSize)
      }
    }
  })

  it('holds the outline ratio inside the band where counters survive', () => {
    // Measured counter survival for 'o': 1/16 keeps 31-33%, 1/12 keeps 18%, 1/8 keeps none.
    for (let fontSize = 16; fontSize <= 200; fontSize++) {
      const ratio = defaultOutlineWidth(fontSize) / fontSize
      expect(ratio, `fontSize ${fontSize}`).toBeLessThanOrEqual(1 / 16)
      expect(ratio, `fontSize ${fontSize}`).toBeGreaterThan(1 / 32)
      expect(defaultOutlineWidth(fontSize)).toBeGreaterThanOrEqual(1)
    }
    // The rule it replaces is above 1/16 for every caption face under 32px — which is
    // every frame under 640px tall — and lands exactly on 1/8 at the 16px floor.
    expect(Math.max(2, Math.round(16 / 16)) / 16).toBe(1 / 8)
    expect(defaultOutlineWidth(16) / 16).toBe(1 / 16)
  })
})

describe('validateVisualOptions: the gap in an otherwise strict file', () => {
  const video = { width: 640, height: 360 }

  it('accepts the defaults and an ordinary custom style', () => {
    expect(() => validateVisualOptions(video)).not.toThrow()
    expect(() => validateVisualOptions(video, { fontSizePct: 4, textColor: '#FFFF00', outlineColor: '#101010' })).not.toThrow()
  })

  it('refuses a caption whose text and outline are the same colour', () => {
    // Encodes perfectly, renders an invisible caption, and reports wrote: true.
    expect(() => validateVisualOptions(video, { textColor: '#FFFFFF', outlineColor: '#FFFFFF' })).toThrow(
      /are the same colour, so the caption would be invisible/,
    )
    expect(() => validateVisualOptions(video, { textColor: '#FFFFFF', outlineColor: '#FEFEFE' })).toThrow(/same colour/)
    // Far enough apart to be a deliberate low-contrast choice, which is not refused here.
    expect(() => validateVisualOptions(video, { textColor: '#FFFFFF', outlineColor: '#CCCCCC' })).not.toThrow()
  })

  it('refuses a chip whose text and box are the same colour, unless the box is transparent', () => {
    expect(() => validateVisualOptions(video, undefined, { textColor: '#000000', boxColor: '#000000' })).toThrow(
      /would render as a featureless block/,
    )
    expect(() => validateVisualOptions(video, undefined, { textColor: '#000000', boxColor: '#000000', boxOpacity: 0 })).not.toThrow()
  })

  it('refuses numbers that are not numbers, or are out of range', () => {
    expect(() => validateVisualOptions(video, { outlineWidth: -3 })).toThrow(/captionOptions.outlineWidth must be between/)
    expect(() => validateVisualOptions(video, { outlineWidth: Number.NaN })).toThrow(/must be a finite number/)
    expect(() => validateVisualOptions(video, { fontSizePct: 0 })).toThrow(/captionOptions.fontSizePct must be between/)
    expect(() => validateVisualOptions(video, { shadow: -1 })).toThrow(/captionOptions.shadow/)
    expect(() => validateVisualOptions(video, { maxLines: 0 })).toThrow(/captionOptions.maxLines/)
    expect(() => validateVisualOptions(video, undefined, { boxOpacity: 1.5 })).toThrow(/inputOverlayOptions.boxOpacity/)
    expect(() => validateVisualOptions({ width: 0, height: 360 })).toThrow(/video size must be positive/)
  })

  it('refuses a font name with a comma, which would shift every ASS style field after it', () => {
    expect(() => validateVisualOptions(video, { fontName: 'DejaVu Sans, sans-serif' })).toThrow(/must be a single font family/)
    expect(() => validateVisualOptions(video, { fontName: '' })).toThrow(/non-empty font family/)
    // And it says out loud that fontconfig never reports a miss — measured on this machine,
    // an unknown family silently resolves to DejaVu Sans and 'Arial' resolves to Aerial.
    expect(() => validateVisualOptions(video, { fontName: 'A,B' })).toThrow(/silently substitutes/)
  })

  it('refuses a caption that cannot fit in the frame it is drawn on', () => {
    // maxLines and marginBottomPct are each reasonable and jointly impossible.
    expect(() => validateVisualOptions({ width: 640, height: 200 }, { fontSizePct: 30, maxLines: 3, marginBottomPct: 20 })).toThrow(
      /would be drawn off the top of the video/,
    )
  })

  it('is enforced by formatAss, not merely exported', () => {
    expect(() => formatAss([], video, { textColor: '#FFFFFF', outlineColor: '#FFFFFF' })).toThrow(/same colour/)
  })
})

/* ------------------------------------------- the uncaptioned path is untouched */

describe('the no-caption path', () => {
  it('emits exactly the argument list it emitted before captions existed', () => {
    expect(buildEncodeArgs({ listFile: '/w/frames.txt', outputPath: '/out/rec.mp4', fps: 10 })).toEqual([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', '/w/frames.txt',
      '-vsync', 'cfr',
      '-r', '10',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags', '+faststart',
      '/out/rec.mp4',
    ])
  })

  it('adds nothing to the args when every cue was dropped', async () => {
    const frames = [{ data: await solidJpeg('red'), offsetMs: 0 }]
    const out = path.join(tmpRoot, 'all-dropped.mp4')
    const r = await encodeFrames({
      frames,
      outputPath: out,
      fps: 10,
      durationMs: 1000,
      // Stamped past the end: nothing survives, so nothing may reach ffmpeg.
      captions: buildCues({ captions: [stamp('x', 99999)], frameOffsetsMs: [0], durationMs: 1000 }).cues,
    })
    expect(r.render).toEqual([])
    expect(await subtitleStreams(out)).toEqual([])
  })

  it('still produces a playable video', async () => {
    const frames = [
      { data: await solidJpeg('red'), offsetMs: 0 },
      { data: await solidJpeg('blue'), offsetMs: 500 },
    ]
    const out = path.join(tmpRoot, 'plain.mp4')
    await encodeFrames({ frames, outputPath: out, fps: 10, durationMs: 1000 })
    expect(fs.statSync(out).size).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------- capability gate */

describe('ffmpeg capability detection', () => {
  it('detects libass and mov_text from ffmpeg itself, not from a failed run', async () => {
    const caps = await ffmpegCaptionCapabilities(true)
    expect(caps.libass).toBe(true)
    expect(caps.movText).toBe(true)
  })

  it('names the cause and the way out when burn-in is asked for without libass', async () => {
    // Point PATH at a stub ffmpeg that reports no filters and no encoders, so the
    // detection path is exercised for real rather than stubbed at the module boundary.
    const binDir = fs.mkdtempSync(path.join(tmpRoot, 'nolibass-'))
    fs.writeFileSync(path.join(binDir, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const originalPath = process.env.PATH
    process.env.PATH = binDir
    try {
      await ffmpegCaptionCapabilities(true)
      const frames = [{ data: await solidJpeg('red'), offsetMs: 0 }]
      await expect(
        encodeFrames({
          frames,
          outputPath: path.join(tmpRoot, 'nope.mp4'),
          fps: 10,
          durationMs: 1000,
          captions: buildCues({ captions: [stamp('hi', 0)], frameOffsetsMs: [0], durationMs: 1000 }).cues,
        }),
      ).rejects.toThrow(/needs an ffmpeg built with libass[\s\S]*sidecar[\s\S]*soft/)
    } finally {
      process.env.PATH = originalPath
      await ffmpegCaptionCapabilities(true)
    }
  })
})

/* ---------------------------------------------------------------- real encodes */

describe('real encodes', () => {
  const W = 320
  const H = 240

  /** Three colour frames, first arriving at `firstOffsetMs`, one second apart. */
  async function colourFrames(firstOffsetMs: number) {
    return [
      { data: await solidJpeg('black', `${W}x${H}`), offsetMs: firstOffsetMs },
      { data: await solidJpeg('black', `${W}x${H}`), offsetMs: firstOffsetMs + 1000 },
      { data: await solidJpeg('black', `${W}x${H}`), offsetMs: firstOffsetMs + 2000 },
      { data: await solidJpeg('black', `${W}x${H}`), offsetMs: firstOffsetMs + 3000 },
    ]
  }

  async function encodeWith(
    name: string,
    captions: StampedCaption[],
    opts?: { firstOffsetMs?: number; durationMs?: number; captionOptions?: CaptionOptions; outputPath?: string },
  ) {
    const firstOffsetMs = opts?.firstOffsetMs ?? 0
    const durationMs = opts?.durationMs ?? firstOffsetMs + 4000
    const frames = await colourFrames(firstOffsetMs)
    const built = buildCues({
      captions,
      frameOffsetsMs: frames.map((f) => f.offsetMs),
      durationMs,
      options: opts?.captionOptions,
    })
    const outputPath = opts?.outputPath ?? path.join(tmpRoot, name)
    const encoded = await encodeFrames({
      frames,
      outputPath,
      fps: 10,
      durationMs,
      captions: built.cues,
      captionOptions: opts?.captionOptions,
    })
    return { built, encoded, outputPath }
  }

  it('burn: the caption appears on screen at the shifted video time, not the wall-clock one', async () => {
    // First repaint 800ms in. A caption stamped at wall clock 1800 must show up at
    // VIDEO second 1, and end at video second 2.
    const { built, outputPath } = await encodeWith(
      'align.mp4',
      [stamp('MIDDLE', 1800), stamp('', 2800)],
      { firstOffsetMs: 800, durationMs: 4800 },
    )
    expect(built.videoStartOffsetMs).toBe(800)
    expect(built.cues[0].startMs).toBe(1000)
    expect(built.cues[0].endMs).toBe(2000)

    const ink = await inkPerFrame(outputPath)
    const lit = ink.map((v) => v > 0)
    const firstLit = lit.indexOf(true)
    const lastLit = lit.lastIndexOf(true)
    // At 10fps, video second 1 is frame ~10 and second 2 is frame ~20. Allow one frame
    // of slack for ffmpeg's CFR resampling, which moves content and burned subtitles
    // together — they share the filtergraph timeline.
    expect(firstLit).toBeGreaterThanOrEqual(9)
    expect(firstLit).toBeLessThanOrEqual(10)
    expect(lastLit).toBeGreaterThanOrEqual(18)
    expect(lastLit).toBeLessThanOrEqual(20)
    // Nothing before it and nothing after it.
    expect(lit.slice(0, 9).some(Boolean)).toBe(false)
    expect(lit.slice(21).some(Boolean)).toBe(false)
  })

  it('burn: leaves NO soft subtitle stream in the mp4', async () => {
    const { outputPath } = await encodeWith('burn-only.mp4', [stamp('burned', 500)])
    expect(await subtitleStreams(outputPath)).toEqual([])
    expect((await inkPerFrame(outputPath)).some((v) => v > 0)).toBe(true)
  })

  it('soft: muxes a mov_text track and burns nothing into the pixels', async () => {
    const { outputPath } = await encodeWith('soft.mp4', [stamp('soft caption', 500)], {
      captionOptions: { render: 'soft' },
    })
    expect((await subtitleStreams(outputPath)).map((s) => s.codec_name)).toEqual(['mov_text'])
    expect((await inkPerFrame(outputPath)).every((v) => v === 0)).toBe(true)
  })

  it('sidecar: writes an .srt whose timings match the cues, and leaves the mp4 alone', async () => {
    // Stamped on frame arrivals (500ms, 1500ms, 2500ms) so the frame-grid snap is a
    // no-op and the only shift left to observe is the first-frame one.
    const { built, encoded, outputPath } = await encodeWith(
      'sidecar.mp4',
      [stamp('one', 1500), stamp('two', 2500)],
      { firstOffsetMs: 500, durationMs: 4500, captionOptions: { render: 'sidecar' } },
    )
    expect(await subtitleStreams(outputPath)).toEqual([])
    expect((await inkPerFrame(outputPath)).every((v) => v === 0)).toBe(true)

    expect(encoded.files).toEqual([path.join(tmpRoot, 'sidecar.srt')])
    const parsed = parseSrt(fs.readFileSync(encoded.files[0], 'utf8'))
    expect(parsed.map((c) => [c.startMs, c.endMs, c.text])).toEqual(
      built.cues.filter((c) => !c.dropped).map((c) => [c.startMs, c.endMs, c.text]),
    )
    // And those are the SHIFTED times: stamped at 1500 with a first frame at 500.
    expect(parsed.map((c) => c.startMs)).toEqual([1000, 2000])
  })

  it('composes burn + sidecar, describing exactly the same cues', async () => {
    const { encoded, outputPath } = await encodeWith('both.mp4', [stamp('narrated', 500)], {
      captionOptions: { render: ['burn', 'sidecar'], sidecarFormats: ['srt', 'vtt'] },
    })
    expect(encoded.render).toEqual(['burn', 'sidecar'])
    expect(encoded.files.map((f) => path.extname(f))).toEqual(['.srt', '.vtt'])
    expect(fs.readFileSync(encoded.files[1], 'utf8').startsWith('WEBVTT')).toBe(true)
    expect((await inkPerFrame(outputPath)).some((v) => v > 0)).toBe(true)
    expect(await subtitleStreams(outputPath)).toEqual([])
  })

  it('rejects an unknown render mode rather than quietly rendering nothing', async () => {
    await expect(
      encodeWith('bad.mp4', [stamp('x', 100)], { captionOptions: { render: 'burnt' as never } }),
    ).rejects.toThrow(/Unknown caption render mode/)
  })

  it('burns into a hostile output path', async () => {
    const dir = path.join(tmpRoot, "hos tile, dir'x")
    fs.mkdirSync(dir, { recursive: true })
    const outputPath = path.join(dir, "clip: v1, o'brien [final].mp4")
    const { encoded } = await encodeWith('unused', [stamp('hostile path', 500)], {
      outputPath,
      captionOptions: { render: ['burn', 'sidecar'] },
    })
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0)
    expect(encoded.files[0]).toBe(path.join(dir, "clip: v1, o'brien [final].srt"))
    expect((await inkPerFrame(outputPath)).some((v) => v > 0)).toBe(true)
  })

  it('burns from a hostile TEMP path, where the filtergraph actually has to escape', async () => {
    // The .ass lives in the work dir, so this is the path that reaches `subtitles=`.
    const hostileTmp = path.join(tmpRoot, "tmp d,ir'q[1]:v2")
    fs.mkdirSync(hostileTmp, { recursive: true })
    const originalTmp = process.env.TMPDIR
    process.env.TMPDIR = hostileTmp
    try {
      const { outputPath } = await encodeWith('hostile-tmp.mp4', [stamp('escaped', 500)])
      expect((await inkPerFrame(outputPath)).some((v) => v > 0)).toBe(true)
    } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = originalTmp
    }
  })

  it('survives hostile caption text in all three formats', async () => {
    const hostile = [
      'brace {\\pos(0,0)} and }close{',
      'arrow a --> b',
      'angle <script>alert(1)</script>',
      'emoji 🐛 café 你好',
      'windows C:\\Node\\bin',
      'x'.repeat(500),
    ].join('\n')
    const { built, encoded, outputPath } = await encodeWith('hostile-text.mp4', [stamp(hostile, 500)], {
      captionOptions: { render: ['burn', 'soft', 'sidecar'], sidecarFormats: ['srt', 'vtt'] },
    })

    expect(fs.statSync(outputPath).size).toBeGreaterThan(0)
    expect((await subtitleStreams(outputPath)).map((s) => s.codec_name)).toEqual(['mov_text'])
    expect((await inkPerFrame(outputPath)).some((v) => v > 0)).toBe(true)

    const srt = fs.readFileSync(encoded.files[0], 'utf8')
    expect(() => parseSrt(srt)).not.toThrow()
    expect(parseSrt(srt)).toHaveLength(1)
    // Truncation and brace escaping both reach the caller.
    const adjustments = (built.cues[0].adjustments ?? []).join(' ')
    expect(adjustments).toMatch(/truncated to 3 lines/)
  })

  it('does not swallow a caption that contains an ASS override block', async () => {
    // `A{XXX}B` renders as `AB` if the braces are not escaped; more ink means more text.
    const style: CaptionOptions = { maxCharsPerLine: 60 }
    const escaped = await encodeWith('brace-escaped.mp4', [stamp('A{XXXXXXXX}B', 500)], { captionOptions: style })
    const plain = await encodeWith('brace-absent.mp4', [stamp('AB', 500)], { captionOptions: style })
    const ink = (v: number[]) => Math.max(...v)
    expect(ink(await inkPerFrame(escaped.outputPath))).toBeGreaterThan(
      ink(await inkPerFrame(plain.outputPath)) * 1.5,
    )
  })

  it('styling options actually change the pixels', async () => {
    const small = await encodeWith('small.mp4', [stamp('SIZE', 500)], { captionOptions: { fontSizePct: 4 } })
    const large = await encodeWith('large.mp4', [stamp('SIZE', 500)], { captionOptions: { fontSizePct: 12 } })
    expect(Math.max(...(await inkPerFrame(large.outputPath)))).toBeGreaterThan(
      Math.max(...(await inkPerFrame(small.outputPath))) * 2,
    )
  })
})

/* ----------------------------------------------------------- the live recorder */

describe('recording.caption end to end', () => {
  let browser: Browser
  let context: BrowserContext
  let server: http.Server
  let baseUrl: string

  beforeAll(async () => {
    // A page that repaints continuously, so `screencast` has something to send.
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><body style="margin:0;background:#111">' +
          '<div id="b" style="width:100vw;height:100vh"></div><script>' +
          'let i=0;setInterval(()=>{i++;document.getElementById("b").style.background=i%2?"#111":"#222"},33)' +
          '</script></body>',
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const chromium = await getChromium()
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 400, height: 300 } })
  }, 120000)

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    await new Promise<void>((r) => server?.close(() => r()))
  })

  it('narrates a real recording, and the burned cue lands where the result says it does', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const outputPath = path.join(tmpRoot, 'live.mp4')

    const handle = await startCdpScreencast({
      cdp,
      outputPath,
      fps: 10,
      quality: 60,
      mode: 'screencast',
      captionOptions: { render: ['burn', 'sidecar'] },
    })

    await new Promise((r) => setTimeout(r, 700))
    const first = handle.caption('step 1 — open the page')
    expect(first.accepted).toBe(true)
    expect(first.blank).toBe(false)
    await new Promise((r) => setTimeout(r, 900))
    handle.caption('step 2 — the bug shows up here')
    await new Promise((r) => setTimeout(r, 900))

    const result = await handle.stop()
    await page.close()

    expect(result.wrote).toBe(true)
    expect(result.frames).toBeGreaterThan(0)
    expect(result.captionRender).toEqual(['burn', 'sidecar'])
    expect(result.captions).toHaveLength(2)
    expect(result.captions!.every((c) => !c.dropped)).toBe(true)

    // The two reported facts about the timeline have to agree with each other.
    expect(result.videoStartOffsetMs).toBe(result.durationMs - result.videoDurationMs!)
    // A real page paints quickly, but the cue must be shifted by whatever it took.
    expect(result.captions![0].startMs).toBeLessThan(result.captions![0].atMs + 1)

    const srt = parseSrt(fs.readFileSync(path.join(tmpRoot, 'live.srt'), 'utf8'))
    expect(srt.map((c) => c.startMs)).toEqual(result.captions!.map((c) => c.startMs))

    // The burned text is really in the pixels: the first caption's window is lit and
    // the run-up to it is not.
    const ink = await inkPerFrame(outputPath)
    const startFrame = Math.round(result.captions![0].startMs / 100)
    expect(ink.slice(Math.max(0, startFrame - 3), startFrame).every((v) => v === 0)).toBe(true)
    expect(ink.slice(startFrame + 1, startFrame + 4).some((v) => v > 0)).toBe(true)
  }, 60000)

  it('tells the caller at stop() that the clip it just made is unreadable', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({ cdp, outputPath: path.join(tmpRoot, 'too-fast.mp4'), fps: 10 })

    // The shape of the original repro: three beats, no pauses worth the name.
    await new Promise((r) => setTimeout(r, 300))
    handle.caption('1. Fill in the checkout form')
    await new Promise((r) => setTimeout(r, 450))
    handle.caption('2. Select all in the email field')
    await new Promise((r) => setTimeout(r, 450))
    handle.caption('3. Click Pay once')
    await new Promise((r) => setTimeout(r, 450))

    const result = await handle.stop()
    await page.close()

    expect(result.wrote).toBe(true)
    expect(result.captionPacing!.cuesTooFast).toBe(3)
    expect(result.captionPacing!.narrationNeedsMs).toBeGreaterThan(result.captionPacing!.videoDurationMs)
    expect(result.captionPacingWarning).toMatch(/^TOO FAST TO READ: 3 of 3 captions/)
    expect(result.captionPacingWarning).toMatch(/Do NOT slow the video down/)
    // It also leads the field a caller already reads for caption trouble.
    expect(result.captionNote).toMatch(/^TOO FAST TO READ/)
    expect(result.captions!.every((c) => c.adjustments?.some((a) => a.includes('too fast')))).toBe(true)
  }, 60000)

  it('says nothing about pacing when hold() paced the beats', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({ cdp, outputPath: path.join(tmpRoot, 'paced.mp4'), fps: 10 })

    await new Promise((r) => setTimeout(r, 300))
    handle.caption('1. Fill in the checkout form')
    // Some of the beat is spent doing the thing; hold() only waits out the remainder.
    await new Promise((r) => setTimeout(r, 500))
    const firstHold = await handle.hold()
    expect(firstHold.readableMs).toBe(2247)
    expect(firstHold.waitedMs).toBeLessThan(2247)
    expect(firstHold.heldForMs).toBeGreaterThanOrEqual(2247)

    handle.caption('2. Select all in the email field')
    await handle.hold()

    handle.clearCaption()
    const finalHold = await handle.hold({ minMs: 1500 })
    expect(finalHold.readableMs).toBe(0)
    expect(finalHold.text).toBe('')
    expect(finalHold.note).toMatch(/Nothing is captioned right now/)

    const result = await handle.stop()
    await page.close()

    expect(result.captionPacing).toMatchObject({ cues: 2, cuesTooFast: 0, shortfallMs: 0 })
    expect(result.captionPacingWarning).toBeUndefined()
    expect(result.captionNote ?? '').not.toMatch(/TOO FAST/)
    // A 2-caption repro paced this way is a ~7 second video, not a 2 second one.
    expect(result.videoDurationMs).toBeGreaterThan(6000)
  }, 60000)

  it('refuses to hold a recording that has already stopped', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({ cdp, outputPath: path.join(tmpRoot, 'held.mp4'), fps: 10 })
    await handle.cancel()
    await expect(handle.hold()).rejects.toThrow(/already stopped/)
    await page.close()
  }, 60000)

  it('refuses a caption once the recording has stopped', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({ cdp, outputPath: path.join(tmpRoot, 'stopped.mp4'), fps: 10 })
    await new Promise((r) => setTimeout(r, 400))
    await handle.cancel()
    expect(() => handle.caption('too late')).toThrow(/already stopped/)
    expect(() => handle.clearCaption()).toThrow(/already stopped/)
    await page.close()
  }, 60000)

  it('refuses captions past the cap instead of growing the result without bound', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({
      cdp,
      outputPath: path.join(tmpRoot, 'capped.mp4'),
      fps: 10,
      captionOptions: { maxCaptions: 2 },
    })
    expect(handle.caption('one').accepted).toBe(true)
    expect(handle.caption('two').accepted).toBe(true)
    const refused = handle.caption('three')
    expect(refused.accepted).toBe(false)
    expect(refused.note).toMatch(/2-caption maximum/)
    expect(handle.captionCount()).toBe(2)
    await handle.cancel()
    await page.close()
  }, 60000)

  it('accepts a pre-supplied script and merges live captions into it', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const outputPath = path.join(tmpRoot, 'scripted.mp4')
    const handle = await startCdpScreencast({
      cdp,
      outputPath,
      fps: 10,
      captions: [{ text: 'scripted opener', atMs: 0, durationMs: 400 }],
      captionOptions: { render: 'sidecar' },
    })
    await new Promise((r) => setTimeout(r, 800))
    handle.caption('live correction', { atMs: 600 })
    await new Promise((r) => setTimeout(r, 500))
    const result = await handle.stop()
    await page.close()

    expect(result.captions!.map((c) => c.text)).toEqual(['scripted opener', 'live correction'])
    expect(result.captionFiles).toEqual([path.join(tmpRoot, 'scripted.srt')])
  }, 60000)
})
