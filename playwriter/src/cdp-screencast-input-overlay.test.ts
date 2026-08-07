/**
 * The on-screen input overlay: NohBoard-style key/button chips burned into a corner.
 *
 * Two things here can only be settled by looking at pixels, and both were:
 *
 *  1. **Whether a chip is on screen at all.** The ASS file says what we asked libass for,
 *     not what libass drew. `BorderStyle 3` with a translucent OutlineColour is not an
 *     obvious combination, and a wrong alpha byte (ASS alpha is INVERTED) renders an
 *     invisible box or an opaque black bar.
 *  2. **Whether the chip and the caption collide.** They are two styles in ONE ass file
 *     with different alignments; nothing but a rendered frame proves they do not overlap.
 *
 * And one thing can only be settled by driving a real browser: that `page.fill()` produces
 * a chip. `fill()` reaches `keyboard.insertText`, which dispatches no key event at all, so
 * an overlay built on in-page listeners shows nothing for it. That test is the reason the
 * event source is Playwright's client instrumentation and not `addEventListener`.
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
  buildInputChips,
  captionStripMetrics,
  chipStripMetrics,
  defaultOutlineWidth,
  encodeFrames,
  formatAss,
  formatInputLabel,
  formatKeyChord,
  normalizeCaptionText,
  renderedCaptionLines,
  splitKeyChord,
  startCdpScreencast,
  videoTimeline,
  wrapCaptionText,
  type CaptionOptions,
  type CdpScreencastOptions,
  type InputAction,
  type InputOverlayOptions,
  type StampedCaption,
  type StampedInput,
} from './cdp-screencast.js'
import { attachInputOverlayTap, playwrightChannelToInputAction } from './executor.js'
import { brightPixelsPerFrame, maskBBox, openVideo, overlayMask } from './video-probe.js'
import { PlaywrightCDPSessionAdapter } from './cdp-session.js'
import { getChromium } from './playwright-import.js'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'

let tmpRoot: string

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-input-overlay-test-'))
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ utilities */

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

async function solidJpeg(color: string, size = '480x320'): Promise<Buffer> {
  const file = path.join(tmpRoot, `solid-${color}-${size}.jpg`)
  if (!fs.existsSync(file)) {
    const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', file])
    if (r.code !== 0) throw new Error(r.stderr)
  }
  return fs.readFileSync(file)
}

/**
 * Bright pixels per frame inside a rectangle given as fractions of the frame.
 *
 * Now one line over `video-probe`'s `brightPixelsPerFrame`. This file and the caption suite
 * each carried their own copy of this loop and the two had drifted — one took a region, the
 * other hardcoded the bottom third — so a change to either proved nothing about the other.
 *
 * The name says "bright" rather than "ink" because that is what a `> 200` threshold on a
 * gray conversion measures: it is hue-dependent (pure blue converts to 29) and on a light
 * page it matches the entire frame. It is sound HERE only because every plate in this
 * describe block is solid black. Anything new should use the clean-plate differential.
 *
 * The width and height are no longer parameters: they come from ffprobe, because a caller
 * who believes the wrong size gets a sheared image and a confident wrong answer about it.
 */
async function inkPerFrame(
  videoPath: string,
  region: { x0?: number; x1?: number; y0?: number; y1?: number } = {},
): Promise<number[]> {
  return brightPixelsPerFrame(await openVideo(videoPath), region)
}

/** Write one frame of the encoded video to a PNG, so a human can actually look at it. */
async function extractFrame(videoPath: string, atSec: number, outPng: string): Promise<string> {
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', outPng])
  if (r.code !== 0) throw new Error(r.stderr)
  return outPng
}

function inputStamp(label: string, atMs: number, extra: Partial<StampedInput> = {}): StampedInput {
  return { kind: 'key', label, atMs, adjustments: [], ...extra }
}

/** Normalise AND wrap, exactly as the recorder's `caption()` does at stamp time. */
function captionStamp(text: string, atMs: number): StampedCaption {
  const n = normalizeCaptionText(text)
  const w = n.text === '' ? { text: '', adjustments: [] as string[] } : wrapCaptionText(n.text, 42, 3)
  return { text: w.text, atMs, blank: w.text === '', adjustments: [...n.adjustments, ...w.adjustments] }
}

/* ------------------------------------------------------- the shared timeline */

describe('videoTimeline: captions and chips read the same clock', () => {
  it('puts video time 0 at the first captured frame', () => {
    const t = videoTimeline({ frameOffsetsMs: [800, 1800, 2800], durationMs: 3500 })
    expect(t.videoStartOffsetMs).toBe(800)
    expect(t.videoDurationMs).toBe(2700)
    expect(t.frameTimes).toEqual([0, 1000, 2000])
  })

  it('agrees with buildCues and buildInputChips on the same input', () => {
    const frameOffsetsMs = [500, 1500, 2500, 3500]
    const durationMs = 4000
    const cues = buildCues({ captions: [captionStamp('x', 1500)], frameOffsetsMs, durationMs })
    const chips = buildInputChips({ events: [inputStamp('K', 1500)], frameOffsetsMs, durationMs })
    // Same wall-clock instant, same video-time start: the shift cannot drift between them.
    expect(chips.events[0].startMs).toBe(cues.cues[0].startMs)
    expect(chips.events[0].startMs).toBe(1000)
  })
})

/* ------------------------------------------------------------- chip wording */

describe('key chords are ONE chip', () => {
  it('splits on + the way Playwright does, so "+" is itself a key', () => {
    expect(splitKeyChord('Control+A')).toEqual(['Control', 'A'])
    expect(splitKeyChord('Control++')).toEqual(['Control', '+'])
    expect(splitKeyChord('a')).toEqual(['a'])
  })

  it('renders a chord as one label, not three', () => {
    expect(formatKeyChord('Control+Shift+K')).toBe('Ctrl+Shift+K')
    expect(formatKeyChord('Meta+KeyC')).toBe('Meta+C')
    expect(formatKeyChord('ControlOrMeta+A')).toBe('Ctrl+A')
  })

  it('turns arrows into arrows and long names into short ones', () => {
    expect(formatKeyChord('ArrowDown')).toBe('↓')
    expect(formatKeyChord('Shift+ArrowLeft')).toBe('Shift+←')
    expect(formatKeyChord('Escape')).toBe('Esc')
    expect(formatKeyChord('Backspace')).toBe('Bksp')
  })
})

describe('formatInputLabel', () => {
  it('names the mouse button, and a double click as a double click', () => {
    const label = (a: InputAction) => formatInputLabel(a).label
    expect(label({ kind: 'mouse', action: 'click' })).toBe('Click')
    expect(label({ kind: 'mouse', action: 'click', button: 'right' })).toBe('Right Click')
    expect(label({ kind: 'mouse', action: 'click', button: 'middle' })).toBe('Middle Click')
    expect(label({ kind: 'mouse', action: 'click', clickCount: 2 })).toBe('Double click')
    expect(label({ kind: 'mouse', action: 'dblclick' })).toBe('Double click')
    expect(label({ kind: 'mouse', action: 'down' })).toBe('Mouse down')
  })

  it('gives a scroll its direction', () => {
    const label = (a: InputAction) => formatInputLabel(a).label
    expect(label({ kind: 'mouse', action: 'wheel', deltaY: 200 })).toBe('Scroll ↓')
    expect(label({ kind: 'mouse', action: 'wheel', deltaY: -200 })).toBe('Scroll ↑')
    expect(label({ kind: 'mouse', action: 'wheel', deltaX: 120, deltaY: 0 })).toBe('Scroll →')
    expect(label({ kind: 'mouse', action: 'wheel', deltaX: 0, deltaY: 0 })).toBe('Scroll')
  })

  it('HIDES typed text by default, and says it did', () => {
    const r = formatInputLabel({ kind: 'text', text: 'alice@example.com', via: 'fill', target: '#email' })
    expect(r.label).toBe('Fill ••••••')
    expect(r.adjustments.join(' ')).toMatch(/typed text hidden/)
    // Fixed-width mask: not even the length of the secret leaks.
    const long = formatInputLabel({ kind: 'text', text: 'x'.repeat(400), via: 'fill', target: '#email' })
    expect(long.label).toBe(r.label)
  })

  it('reveals typed text only when asked', () => {
    const r = formatInputLabel({ kind: 'text', text: 'alice@example.com', via: 'fill', target: '#email' }, { revealTypedText: true })
    expect(r.label).toBe('Fill "alice@example.com"')
  })

  it('still hides a secret-looking target even with revealTypedText on', () => {
    const opts: InputOverlayOptions = { revealTypedText: true }
    for (const target of ['#password', 'input[type=password]', '#api_key', '[name="otp"]', '#card-number', '#credential']) {
      const r = formatInputLabel({ kind: 'text', text: 'hunter2', via: 'fill', target }, opts)
      expect(r.label, target).toBe('Fill ••••••')
      expect(r.adjustments.join(' ')).toMatch(/looks like a secret field/)
    }
  })

  it('masks a single keystroke aimed at a secret field, and masks what it coalesces with', () => {
    const r = formatInputLabel({ kind: 'key', key: 'h', target: '#password' }, { revealTypedText: true })
    expect(r.label).toBe('•')
    // The coalescing character is derived from the LABEL: a masked key must not come back
    // in plaintext when the next keystroke merges into it.
    expect(r.coalesceChar).toBe('•')
  })

  it('truncates a long revealed value rather than letting it become a wall', () => {
    const r = formatInputLabel(
      { kind: 'text', text: 'x'.repeat(200), via: 'fill', target: '#notes' },
      { revealTypedText: true },
    )
    expect([...r.label].length).toBe(26)
    expect(r.label.endsWith('…')).toBe(true)
    expect(r.adjustments.join(' ')).toMatch(/chip truncated to 26 characters/)
  })

  it('flattens newlines instead of silently growing a second chip row', () => {
    const r = formatInputLabel({ kind: 'text', text: 'a\nb\tc', via: 'fill', target: '#notes' }, { revealTypedText: true })
    expect(r.label).toBe('Fill "a b c"')
  })

  it('reads an empty fill as clearing the field, not as an empty chip', () => {
    expect(formatInputLabel({ kind: 'text', text: '', via: 'fill', target: '#q' }).label).toBe('Clear field')
  })

  it('marks a held key as held', () => {
    expect(formatInputLabel({ kind: 'key', key: 'Shift', phase: 'down' }).label).toBe('Shift ↓')
    expect(formatInputLabel({ kind: 'key', key: 'Shift', phase: 'up' }).label).toBe('Shift ↑')
  })
})

/* ------------------------------------------------------------- the event source */

describe('playwrightChannelToInputAction: the whitelist is the contract', () => {
  const map = (type: string, method: string, params?: Record<string, any>) =>
    playwrightChannelToInputAction({ type, method, params })

  it('covers every keyboard and mouse method on the Page channel', () => {
    expect(map('Page', 'keyboardPress', { key: 'Control+A' })).toEqual({ kind: 'key', key: 'Control+A' })
    expect(map('Page', 'keyboardDown', { key: 'Shift' })).toEqual({ kind: 'key', key: 'Shift', phase: 'down' })
    expect(map('Page', 'keyboardUp', { key: 'Shift' })).toEqual({ kind: 'key', key: 'Shift', phase: 'up' })
    expect(map('Page', 'keyboardType', { text: 'hi' })).toEqual({ kind: 'text', text: 'hi', via: 'type' })
    expect(map('Page', 'keyboardInsertText', { text: 'hi' })).toEqual({ kind: 'text', text: 'hi', via: 'insertText' })
    expect(map('Page', 'mouseClick', { x: 1, y: 2, button: 'right' })).toMatchObject({ kind: 'mouse', action: 'click', button: 'right' })
    expect(map('Page', 'mouseWheel', { deltaX: 0, deltaY: 200 })).toMatchObject({ kind: 'mouse', action: 'wheel', deltaY: 200 })
    expect(map('Page', 'touchscreenTap', {})).toMatchObject({ kind: 'mouse', action: 'tap' })
  })

  it('covers the Frame and ElementHandle methods, carrying the selector as the target', () => {
    expect(map('Frame', 'fill', { selector: '#pw', value: 'x' })).toEqual({
      kind: 'text',
      text: 'x',
      via: 'fill',
      target: '#pw',
    })
    expect(map('Frame', 'press', { selector: '#a', key: 'Enter' })).toEqual({ kind: 'key', key: 'Enter', target: '#a' })
    expect(map('Frame', 'type', { selector: '#a', text: 'qw' })).toMatchObject({ via: 'type', target: '#a' })
    expect(map('Frame', 'check', { selector: '#c' })).toMatchObject({ kind: 'action', verb: 'Check' })
    expect(map('Frame', 'selectOption', { selector: '#s', options: [{ valueOrLabel: 'o2' }] })).toMatchObject({
      verb: 'Select',
      detail: '"o2"',
    })
    expect(map('Frame', 'setInputFiles', { selector: '#f', localPaths: ['/a', '/b'] })).toMatchObject({ detail: '2 files' })
    // ElementHandle has the same method names and no selector.
    expect(map('ElementHandle', 'click', {})).toMatchObject({ kind: 'mouse', action: 'click', target: undefined })
  })

  it('ignores everything that is not input, including mouse MOVEMENT', () => {
    expect(map('Page', 'mouseMove', { x: 1, y: 2 })).toBeNull()
    expect(map('Frame', 'goto', { url: 'https://x' })).toBeNull()
    expect(map('Frame', 'setContent', { html: '<b>' })).toBeNull()
    expect(map('Frame', 'querySelector', { selector: '#a' })).toBeNull()
    expect(map('BrowserContext', 'newPage', {})).toBeNull()
    expect(map('Page', 'screenshot', {})).toBeNull()
  })
})

describe('attachInputOverlayTap', () => {
  /** A stand-in for the ClientInstrumentation proxy, with the two hooks it really has. */
  function fakeInstrumentation() {
    const listeners: any[] = []
    return {
      page: { _instrumentation: { addListener: (l: any) => listeners.push(l), removeListener: (l: any) => listeners.splice(listeners.indexOf(l), 1) } } as unknown as Page,
      listeners,
    }
  }

  it('emits at the END of the call, not the beginning', () => {
    const { page, listeners } = fakeInstrumentation()
    const seen: InputAction[] = []
    attachInputOverlayTap({ page, onAction: (a) => seen.push(a) })
    const apiCall: any = { apiName: 'locator.click' }
    listeners[0].onApiCallBegin(apiCall, { type: 'Frame', method: 'click', params: { selector: '#b' } })
    // A click that spends seconds waiting for actionability must not chip on arrival.
    expect(seen).toHaveLength(0)
    listeners[0].onApiCallEnd(apiCall)
    expect(seen).toHaveLength(1)
  })

  it('emits nothing for an action that threw — it never happened', () => {
    const { page, listeners } = fakeInstrumentation()
    const seen: InputAction[] = []
    attachInputOverlayTap({ page, onAction: (a) => seen.push(a) })
    const apiCall: any = { apiName: 'locator.click' }
    listeners[0].onApiCallBegin(apiCall, { type: 'Frame', method: 'click', params: { selector: '#gone' } })
    apiCall.error = new Error('Timeout 30000ms exceeded')
    listeners[0].onApiCallEnd(apiCall)
    expect(seen).toHaveLength(0)
  })

  it('never lets an overlay failure escape into the action being observed', () => {
    const { page, listeners } = fakeInstrumentation()
    attachInputOverlayTap({
      page,
      onAction: () => {
        throw new Error('recorder already stopped')
      },
    })
    const apiCall: any = {}
    listeners[0].onApiCallBegin(apiCall, { type: 'Frame', method: 'click', params: {} })
    expect(() => listeners[0].onApiCallEnd(apiCall)).not.toThrow()
  })

  it('detaches, and reports rather than throws when there is no instrumentation to tap', () => {
    const { page, listeners } = fakeInstrumentation()
    const tap = attachInputOverlayTap({ page, onAction: () => {} })
    expect(listeners).toHaveLength(1)
    tap.detach()
    expect(listeners).toHaveLength(0)

    const bare = attachInputOverlayTap({ page: {} as Page, onAction: () => {} })
    expect(bare.note).toMatch(/no Playwright client instrumentation/)
    expect(() => bare.detach()).not.toThrow()
  })
})

/* ------------------------------------------------------- chip timing + stacking */

describe('buildInputChips: timing', () => {
  const frameOffsetsMs = [0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000]

  it('shifts every chip by the first frame offset, exactly like a caption', () => {
    const built = buildInputChips({
      events: [inputStamp('Click', 1800)],
      frameOffsetsMs: [800, 1800, 2800, 3800],
      durationMs: 4200,
    })
    expect(built.events[0].startMs).toBe(1000)
    expect(built.events[0].atMs).toBe(1800)
  })

  it('gives a chip a readable dwell instead of a single frame', () => {
    const built = buildInputChips({ events: [inputStamp('Click', 400)], frameOffsetsMs, durationMs: 3200 })
    expect(built.events[0].startMs).toBe(400)
    // 1600ms dwell, snapped forward onto the frame grid. Long enough that a viewer whose
    // eyes are on the page can look away, read the chip and look back.
    expect(built.events[0].endMs).toBe(2000)
  })

  it('snaps back onto the frame that is really on screen, and says the page did not repaint', () => {
    // Frames a full second apart: the keystroke at 1700 has nothing of its own.
    const built = buildInputChips({ events: [inputStamp('K', 1700)], frameOffsetsMs: [0, 1000, 2000, 3000], durationMs: 3500 })
    expect(built.events[0].startMs).toBe(1000)
    expect(built.events[0].adjustments?.join(' ')).toMatch(/shown 700ms early.*nothing repainted/)
  })

  it('drops a chip stamped past the end of the clip and says why', () => {
    const built = buildInputChips({ events: [inputStamp('K', 9000)], frameOffsetsMs, durationMs: 3200 })
    expect(built.events[0].dropped).toBe(true)
    expect(built.events[0].index).toBe(-1)
    expect(built.events[0].adjustments?.join(' ')).toMatch(/at or past the/)
    expect(built.segments).toHaveLength(0)
  })

  it('drops everything, loudly, when no frame was ever captured', () => {
    const built = buildInputChips({ events: [inputStamp('K', 100)], frameOffsetsMs: [], durationMs: 2000 })
    expect(built.events[0].dropped).toBe(true)
    expect(built.events[0].adjustments?.join(' ')).toMatch(/no frames were captured/)
    expect(built.note).toMatch(/All input chips dropped/)
  })

  it('reports a chip cut short by the END OF THE CLIP, the way buildCues does for a cue', () => {
    // `buildCues` has always said "the recording stopped Xms after it appeared"; the
    // adjacent function describing the identical situation for a chip said nothing at all.
    // So the LAST action in a repro — usually the one the clip exists to show — flashed for
    // a fraction of its dwell and the result reported it as fine.
    const built = buildInputChips({
      events: [inputStamp('Click', 900)],
      frameOffsetsMs: [0, 200, 400, 600, 800, 1000],
      durationMs: 1200,
    })
    expect(built.events[0].dropped).toBeUndefined()
    expect(built.events[0].adjustments?.join(' ')).toMatch(
      /on screen for \d+ms of its 1600ms dwell — the recording stopped \d+ms after this input landed/,
    )
    expect(built.events[0].adjustments?.join(' ')).toMatch(/let the final state sit on screen before stopCdp/)
    expect(built.note).toMatch(/0 input chip\(s\) dropped, 1 adjusted/)
  })

  it('says when that chip was cut short of even being NOTICED', () => {
    const built = buildInputChips({
      events: [inputStamp('Click', 1000)],
      frameOffsetsMs: [0, 200, 400, 600, 800, 1000],
      durationMs: 1200,
    })
    expect(built.events[0].adjustments?.join(' ')).toMatch(/under the ~500ms a viewer needs just to notice a chip/)
  })

  it('stays quiet when the chip got its whole dwell', () => {
    const built = buildInputChips({
      events: [inputStamp('Click', 200)],
      frameOffsetsMs: Array.from({ length: 30 }, (_, i) => i * 200),
      durationMs: 6000,
    })
    expect(built.events[0].adjustments ?? []).toEqual([])
    expect(built.note).toBeUndefined()
  })

  it('sorts out-of-order stamps and flags that it did', () => {
    const built = buildInputChips({
      events: [inputStamp('second', 1200), inputStamp('first', 400)],
      frameOffsetsMs,
      durationMs: 3200,
    })
    expect(built.events.map((e) => e.label)).toEqual(['first', 'second'])
    expect(built.events[0].adjustments?.join(' ')).toMatch(/not in chronological order/)
  })
})

describe('buildInputChips: the rolling stack', () => {
  const frameOffsetsMs = Array.from({ length: 40 }, (_, i) => i * 100)

  it('shows several chips at once — a keystroke does not cancel the one before it', () => {
    const built = buildInputChips({
      events: [inputStamp('A', 0), inputStamp('B', 300), inputStamp('C', 600)],
      frameOffsetsMs,
      durationMs: 4000,
    })
    expect(built.events.every((e) => !e.dropped)).toBe(true)
    const atThreeChips = built.segments.find((s) => s.lines.length === 3)
    expect(atThreeChips).toBeDefined()
    // Oldest first, so the stack grows away from the anchor and never reshuffles.
    expect(atThreeChips!.lines.map((l) => l.label)).toEqual(['A', 'B', 'C'])
  })

  it('retires the OLDEST chip past maxVisible, and records the retirement on it', () => {
    const built = buildInputChips({
      events: [inputStamp('A', 0), inputStamp('B', 200), inputStamp('C', 400), inputStamp('D', 600)],
      frameOffsetsMs,
      durationMs: 4000,
      options: { maxVisible: 3 },
    })
    expect(built.events.every((e) => !e.dropped)).toBe(true)
    // A would have run to 900ms on dwell alone; D pushed it out at 600ms.
    expect(built.events[0].endMs).toBe(600)
    expect(built.events[0].adjustments?.join(' ')).toMatch(/retired after 600ms to make room; only 3 chips/)
    expect(built.segments.every((s) => s.lines.length <= 3)).toBe(true)
    expect(built.note).toMatch(/0 input chip\(s\) dropped, 1 adjusted/)
  })

  /**
   * The repro that motivated the retuning: fill, fill, click, press is ONE beat of an
   * ordinary repro, and at the old 900ms/3-chip defaults it always cost the first chip.
   */
  it('sheds nothing on an ordinary four-input beat: fill, fill, click, press', () => {
    const built = buildInputChips({
      events: [
        inputStamp('Fill ••••••', 0),
        inputStamp('Fill ••••••', 200),
        inputStamp('Click', 500),
        inputStamp('Ctrl+A', 700),
      ],
      frameOffsetsMs,
      durationMs: 6000,
      video: { width: 900, height: 560 },
    })
    expect(built.events.every((e) => !e.dropped)).toBe(true)
    expect(built.events.some((e) => e.adjustments?.some((a) => a.includes('retired')))).toBe(false)
    expect(built.note).toBeUndefined()
    // All four are up together at some point; none is cut short of its dwell.
    expect(built.segments.some((s) => s.lines.length === 4)).toBe(true)
    expect(built.events.every((e) => e.endMs - e.startMs >= 1600)).toBe(true)
  })

  it('says a chip was retired inside a glance, which is a pacing problem and not a layout one', () => {
    const built = buildInputChips({
      // Five inputs inside 800ms — the too-fast clip. Something has to give, and the
      // result has to say that the chip was never really seen.
      events: [0, 200, 400, 600, 800].map((t, i) => inputStamp(`K${i}`, t)),
      frameOffsetsMs,
      durationMs: 4000,
    })
    expect(built.events[0].adjustments?.join(' ')).toMatch(
      /retired after 800ms to make room; only 4 chips are shown at once/,
    )
    expect(built.events[0].adjustments?.join(' ')).not.toMatch(/never really seen/)

    const tighter = buildInputChips({
      events: [0, 60, 120, 180, 240].map((t, i) => inputStamp(`K${i}`, t)),
      frameOffsetsMs,
      durationMs: 4000,
    })
    expect(tighter.events[0].adjustments?.join(' ')).toMatch(
      /under the ~500ms a viewer needs just to notice a chip, so this one was never really seen; space these actions further apart/,
    )
  })

  it('drops rather than lies when maxVisible newer chips land on the same frame', () => {
    const built = buildInputChips({
      events: [inputStamp('A', 1000), inputStamp('B', 1001), inputStamp('C', 1002)],
      frameOffsetsMs: [0, 1000, 2000, 3000],
      durationMs: 3500,
      options: { maxVisible: 2 },
    })
    expect(built.events[0].dropped).toBe(true)
    expect(built.events[0].adjustments?.join(' ')).toMatch(/would never be seen/)
    expect(built.events[1].dropped).toBeUndefined()
    expect(built.events[2].dropped).toBeUndefined()
  })

  it('retires the oldest when a ROW would run off the frame, even under maxVisible', () => {
    // Three long labels fit the count cap but not a 360px-wide frame.
    const built = buildInputChips({
      events: [inputStamp('Fill "aaaaaaaaaaaaaaaaa"', 0), inputStamp('Fill "bbbbbbbbbbbbbbbbb"', 200), inputStamp('Fill "ccccccccccccccccc"', 400)],
      frameOffsetsMs,
      durationMs: 4000,
      video: { width: 360, height: 240 },
    })
    expect(built.events.every((e) => !e.dropped)).toBe(true)
    expect(built.segments.every((s) => s.lines.length < 3)).toBe(true)
    expect(built.events[0].adjustments?.join(' ')).toMatch(/the row would not fit across the frame \(\d+ characters\)/)
  })

  it('does not apply the width budget to a stack, where each chip has its own line', () => {
    const events = [inputStamp('Fill "aaaaaaaaaaaaaaaaa"', 0), inputStamp('Fill "bbbbbbbbbbbbbbbbb"', 200), inputStamp('Fill "ccccccccccccccccc"', 400)]
    const built = buildInputChips({
      events,
      frameOffsetsMs,
      durationMs: 4000,
      video: { width: 360, height: 240 },
      options: { layout: 'stack' },
    })
    expect(built.segments.some((s) => s.lines.length === 3)).toBe(true)
  })

  it('emits one segment per distinct visible stack, merging the ones that do not change', () => {
    const built = buildInputChips({ events: [inputStamp('A', 0)], frameOffsetsMs, durationMs: 4000 })
    expect(built.segments).toHaveLength(1)
    expect(built.segments[0]).toMatchObject({ startMs: 0, endMs: 1600 })
  })
})

describe('buildInputChips: rapid sequences coalesce', () => {
  const frameOffsetsMs = Array.from({ length: 40 }, (_, i) => i * 100)

  it('merges 10 keys in 300ms into ONE readable chip instead of a ten-line wall', () => {
    const letters = 'abcdefghij'.split('')
    const events = letters.map((c, i) => inputStamp(c, i * 30, { coalesceChar: c }))
    const built = buildInputChips({ events, frameOffsetsMs, durationMs: 4000 })

    expect(built.events).toHaveLength(1)
    expect(built.events[0].label).toBe('abcdefghij')
    expect(built.events[0].coalescedCount).toBe(10)
    expect(built.events[0].adjustments?.join(' ')).toMatch(/10 keystrokes within 400ms merged into one chip/)
    // The chip belongs where the typing STARTED.
    expect(built.events[0].atMs).toBe(0)
    expect(built.segments.every((s) => s.lines.length === 1)).toBe(true)
  })

  it('does not merge across a pause longer than the window', () => {
    const built = buildInputChips({
      events: [inputStamp('a', 0, { coalesceChar: 'a' }), inputStamp('b', 900, { coalesceChar: 'b' })],
      frameOffsetsMs,
      durationMs: 4000,
    })
    expect(built.events.map((e) => e.label)).toEqual(['a', 'b'])
  })

  it('does not merge a chord into a typed run — a chord is its own thing', () => {
    const built = buildInputChips({
      events: [
        inputStamp('a', 0, { coalesceChar: 'a' }),
        inputStamp('Ctrl+A', 60),
        inputStamp('b', 120, { coalesceChar: 'b' }),
      ],
      frameOffsetsMs,
      durationMs: 4000,
    })
    expect(built.events.map((e) => e.label)).toEqual(['a', 'Ctrl+A', 'b'])
  })

  it('truncates a very long typed run instead of overflowing the frame', () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
    const events = chars.map((c, i) => inputStamp(c, i * 20, { coalesceChar: c }))
    const built = buildInputChips({ events, frameOffsetsMs, durationMs: 4000, options: { maxLabelChars: 12 } })
    expect([...built.events[0].label].length).toBe(12)
    expect(built.events[0].label.endsWith('…')).toBe(true)
    expect(built.events[0].adjustments?.join(' ')).toMatch(/chip truncated to 12 characters/)
  })
})

/* ------------------------------------------------------------- one ASS file */

describe('formatAss: captions and chips share one subtitle file', () => {
  const video = { width: 480, height: 320 }
  const cues = buildCues({ captions: [captionStamp('narration', 0)], frameOffsetsMs: [0, 1000, 2000], durationMs: 3000 }).cues
  const chips = buildInputChips({ events: [inputStamp('Ctrl+A', 0)], frameOffsetsMs: [0, 1000, 2000], durationMs: 3000 })

  it('leaves the caption output byte-for-byte unchanged when the overlay is off', () => {
    const without = formatAss(cues, video, {})
    const withEmpty = formatAss(cues, video, {}, { segments: [] })
    expect(withEmpty.text).toBe(without.text)
    expect(without.text).not.toContain('Style: Input')
  })

  it('adds styles and layers, not a second filter', () => {
    const ass = formatAss(cues, video, {}, { segments: chips.segments }).text
    expect(ass.match(/^Style: /gm)).toHaveLength(2)
    expect(ass).toContain('Style: Default,')
    expect(ass).toContain('Style: Input,')
    // Captions on layer 0, chips on 1. There is no longer a layer -1: the band that used to
    // sit under the captions is gone, replaced by a strip the ENCODER pads on.
    expect(ass).not.toMatch(/^Dialogue: -1,/m)
    expect(ass).not.toContain('Style: Backdrop,')
    expect(ass).toMatch(/^Dialogue: 0,.*,Default,/m)
    expect(ass).toMatch(/^Dialogue: 1,.*,Input,/m)
  })

  it('declares PlayRes as the LETTERBOXED frame, not as the page', () => {
    const built = formatAss(cues, video, {}, { segments: chips.segments })
    const strip = captionStripMetrics(video, 1)
    expect(built.strip.height).toBe(strip.height)
    expect(built.strip.height).toBeGreaterThan(0)
    // PlayRes has to describe the surface libass draws on. Declaring the PAGE height would
    // make `ScaledBorderAndShadow: yes` rescale every margin and face by frame/PlayRes.
    expect(built.text).toContain(`PlayResX: ${video.width}`)
    expect(built.text).toContain(`PlayResY: ${video.height + strip.height}`)
    // The caption's MarginV is measured against the FRAME's bottom, which is the strip's
    // bottom: this is the number that keeps the block inside the strip.
    const marginV = Number(/^Style: Default,(.*)$/m.exec(built.text)![1].split(',')[20])
    expect(marginV).toBe(strip.marginV)
    expect(marginV).toBeLessThan(strip.height)
  })

  it('appends no strip at all when nothing is burned, so the frame is the page', () => {
    const none = formatAss([], video, {}, { segments: chips.segments })
    expect(none.strip.height).toBe(0)
    expect(none.text).toContain(`PlayResY: ${video.height}`)
  })

  it('defaults to the bottom-right corner, in a row', () => {
    const ass = formatAss(cues, video, {}, { segments: chips.segments }).text
    const style = /^Style: Input,(.*)$/m.exec(ass)![1]
    // 3 = bottom-right. Top-left was the original default and it drew on the page's
    // heading; the empty region of an ordinary page is the bottom-right.
    expect(style.split(',')[17]).toBe('3')
    // A row is one dialogue line with separators, never an ASS hard break.
    const dialogue = /^Dialogue: 1,.*,Input,,0,0,0,,(.*)$/m.exec(ass)![1]
    expect(dialogue).not.toContain('\\N')
  })

  /**
   * The caption-lift reserve is gone and this is what replaced it.
   *
   * It used to add the caption block's measured height plus a gap to the chip MarginV, so
   * the chips could not be drawn on top of the narration; it needed the caption's font size,
   * its bottom margin, its backdrop padding and the line count libass would really wrap to,
   * and it needed a clamp for when the sum pushed the chips off the top. All of that existed
   * because both layers competed for the bottom of the same page. They no longer do — so the
   * offset is exactly `strip.height`, which is a constant known exactly.
   */
  it('offsets a bottom-anchored strip by the caption strip, so the chips stay on the PAGE', () => {
    const marginVOf = (assText: string) => Number(/^Style: Input,(.*)$/m.exec(assText)![1].split(',')[20])
    const chipMargin = chipStripMetrics(video).margin
    const noCaption = marginVOf(formatAss([], video, {}, { segments: chips.segments }).text)
    const oneLine = marginVOf(formatAss(cues, video, {}, { segments: chips.segments }).text)
    const threeLineCue = [{ index: 1, text: 'a\nb\nc', startMs: 0, endMs: 1000, atMs: 0 }]
    const threeLine = marginVOf(formatAss(threeLineCue, video, {}, { segments: chips.segments }).text)

    // No caption, no strip, no offset: the chips hug the frame's own bottom edge.
    expect(noCaption).toBe(chipMargin)
    // With one, the offset is the strip height and nothing else — so the chip ink sits
    // `chipMargin` above the PAGE's bottom edge, exactly where it sat with no caption at all.
    expect(oneLine).toBe(chipMargin + captionStripMetrics(video, 1).height)
    expect(threeLine).toBe(chipMargin + captionStripMetrics(video, 3).height)
    // …and a taller strip moves them further, because the frame grew underneath them.
    expect(oneLine).toBeLessThan(threeLine)
    // Nothing is clamped and nothing is reported: the sum cannot exceed the frame.
    expect(formatAss(threeLineCue, video, {}, { segments: chips.segments }).inputNote).toBeUndefined()
  })

  it('does not offset a TOP-anchored strip: the strip is at the bottom', () => {
    const marginVOf = (assText: string) => Number(/^Style: Input,(.*)$/m.exec(assText)![1].split(',')[20])
    const top = marginVOf(formatAss(cues, video, {}, { segments: chips.segments, options: { position: 'top-right' } }).text)
    const bottom = marginVOf(formatAss(cues, video, {}, { segments: chips.segments, options: { position: 'bottom-right' } }).text)
    expect(top).toBe(chipStripMetrics(video).margin)
    expect(top).toBeLessThan(bottom)
  })

  it('refuses a caption whose strip would be taller than the page it is appended to', () => {
    // The clamp that used to live here is gone with the reserve. What replaced it is a
    // refusal further upstream: there is nothing to push the chips off the top of, but a
    // clip that is mostly subtitle is still not what anyone meant.
    //
    // MEASURED on this 480x320 frame, sweeping fontSizePct against the 3-line `maxLines`
    // default: 25% gives a 294px strip under a 320px page and is allowed, 28% gives 330px
    // and is refused. The boundary is parity, so both sides of it are pinned here rather
    // than one — a limit only ever tested from the failing side can be off by any margin.
    const threeLines = [{ index: 1, text: 'a\nb\nc', startMs: 0, endMs: 1000, atMs: 0 }]
    expect(() => formatAss(threeLines, video, { fontSizePct: 25 }, { segments: chips.segments })).not.toThrow()
    expect(captionStripMetrics(video, 3, { fontSizePct: 25 }).height).toBe(294)
    expect(() => formatAss(threeLines, video, { fontSizePct: 28 }, { segments: chips.segments })).toThrow(
      /more than half the video would be subtitle rather than page/,
    )
    expect(captionStripMetrics(video, 3, { fontSizePct: 28 }).height).toBe(330)
  })

  it('renders a stack as one line per chip when asked, each on its own merge plate', () => {
    const three = buildInputChips({
      events: [inputStamp('A', 0), inputStamp('B', 100), inputStamp('C', 200)],
      frameOffsetsMs: [0, 1000, 2000],
      durationMs: 3000,
      options: { layout: 'stack' },
    })
    const ass = formatAss([], video, {}, { segments: three.segments, options: { layout: 'stack' } }).text
    const widest = ass.split('\n').filter((l) => l.startsWith('Dialogue: 1')).map((l) => l.split(',,').pop()!)
    // Each stacked chip draws its OWN BorderStyle-3 box, so each line needs its own hard-space
    // padding — one run for the whole dialogue would leave the middle chips' plates hugging
    // their letters. Written out from `chipStripMetrics` rather than as a literal, so it stays
    // an assertion about the shipped geometry rather than about a string somebody once saw.
    const m = chipStripMetrics(video)
    const pad = (s: string) => '\\h'.repeat(m.inboardSpaces) + s + '\\h'.repeat(m.outboardSpaces)
    expect(widest.some((d) => d === [pad('A'), pad('B'), pad('C')].join('\\N'))).toBe(true)
  })

  it('rejects an unknown layout rather than silently picking one', () => {
    expect(() => formatAss([], video, {}, { segments: chips.segments, options: { layout: 'grid' as any } })).toThrow(
      /Unknown inputOverlayOptions.layout/,
    )
  })

  it('anchors each position to the right ASS alignment', () => {
    const alignmentOf = (position: InputOverlayOptions['position']) => {
      const style = /^Style: Input,(.*)$/m.exec(formatAss([], video, {}, { segments: chips.segments, options: { position } }).text)![1]
      // Style format: Name,Fontname,Fontsize,Primary,Secondary,Outline,Back,Bold,Italic,
      // Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,...
      // The capture starts after 'Style: Input,', so Alignment is field 17.
      return style.split(',')[17]
    }
    expect(alignmentOf('top-left')).toBe('7')
    expect(alignmentOf('top-right')).toBe('9')
    expect(alignmentOf('bottom-left')).toBe('1')
    expect(alignmentOf('bottom-right')).toBe('3')
  })

  it('makes the chip noticeably smaller than the caption, and scales both with the video', () => {
    const sizeOf = (name: string, height: number) => {
      const ass = formatAss(cues, { width: 1280, height }, {}, { segments: chips.segments }).text
      return Number(new RegExp(`^Style: ${name},[^,]*,(\\d+)`, 'm').exec(ass)![1])
    }
    expect(sizeOf('Input', 720)).toBeLessThan(sizeOf('Default', 720) * 0.75)
    expect(sizeOf('Input', 1440)).toBeGreaterThan(sizeOf('Input', 720))
  })

  it('paints a translucent box: ASS alpha is INVERTED, so 0.65 opacity is 0x59', () => {
    const style = /^Style: Input,(.*)$/m.exec(
      formatAss([], video, {}, { segments: chips.segments, options: { boxColor: '#000000', boxOpacity: 0.65 } }).text,
    )![1]
    const fields = style.split(',')
    expect(fields[4]).toBe('&H59000000') // OutlineColour = the box fill
    expect(fields[14]).toBe('3') // BorderStyle 3 = opaque-box mode, which is what draws a chip
    expect(fields[16]).toBe('0') // Shadow off, or the translucent box gets an opaque twin
  })

  it('escapes a brace inside a chip and reports it against the event that carried it', () => {
    const withBrace = buildInputChips({
      events: [inputStamp('Fill "{a}"', 0)],
      frameOffsetsMs: [0, 1000, 2000],
      durationMs: 3000,
    })
    const ass = formatAss([], video, {}, { segments: withBrace.segments })
    expect(ass.text).toContain('\\{a\\}')
    expect(ass.inputAdjustments.get(1)?.join(' ')).toMatch(/braces escaped/)
  })

  it('rejects an unknown position rather than quietly drawing in a corner nobody asked for', () => {
    expect(() => formatAss([], video, {}, { segments: chips.segments, options: { position: 'middle' as any } })).toThrow(
      /Unknown inputOverlayOptions.position/,
    )
  })
})

/* -------------------------------------------------- the overlay-off guarantee */

describe('with the overlay off, nothing about the encode changes', () => {
  it('emits exactly the argument list it emitted before either feature existed', () => {
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

  it('captions on, input overlay off: still one subtitles filter and nothing else added', () => {
    expect(buildEncodeArgs({ listFile: '/w/frames.txt', outputPath: '/out/rec.mp4', fps: 10, burnAssPath: '/w/captions.ass' })).toEqual([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', '/w/frames.txt',
      '-vsync', 'cfr',
      '-r', '10',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,subtitles=/w/captions.ass',
      '-movflags', '+faststart',
      '/out/rec.mp4',
    ])
  })

  it('encodes with no filter at all when there are neither cues nor chips', async () => {
    const frames = [
      { data: await solidJpeg('red'), offsetMs: 0 },
      { data: await solidJpeg('blue'), offsetMs: 500 },
    ]
    const out = path.join(tmpRoot, 'bare.mp4')
    const encoded = await encodeFrames({ frames, outputPath: out, fps: 10, durationMs: 1000, inputSegments: [] })
    expect(encoded.render).toEqual([])
    expect(encoded.inputAdjustments.size).toBe(0)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
    expect((await inkPerFrame(out)).every((v) => v === 0)).toBe(true)
  })
})

/* ------------------------------------------------------------- real encodes */

describe('the overlay is really in the pixels', () => {
  const W = 720
  const H = 480
  const BOTTOM_RIGHT = { y0: 0.6, y1: 1, x0: 0.55, x1: 1 }

  /** Four dark frames one second apart, first arriving at `firstOffsetMs`. */
  async function darkFrames(firstOffsetMs: number) {
    const data = await solidJpeg('black', `${W}x${H}`)
    return [0, 1, 2, 3].map((i) => ({ data, offsetMs: firstOffsetMs + i * 1000 }))
  }

  async function encodeWith(
    name: string,
    events: StampedInput[],
    opts: { captions?: StampedCaption[]; firstOffsetMs?: number; options?: InputOverlayOptions } = {},
  ) {
    const firstOffsetMs = opts.firstOffsetMs ?? 0
    const frames = await darkFrames(firstOffsetMs)
    const durationMs = firstOffsetMs + 4000
    const frameOffsetsMs = frames.map((f) => f.offsetMs)
    const chips = buildInputChips({
      events,
      frameOffsetsMs,
      durationMs,
      options: opts.options,
      video: { width: W, height: H },
    })
    const cues = buildCues({ captions: opts.captions ?? [], frameOffsetsMs, durationMs })
    const outputPath = path.join(tmpRoot, name)
    await encodeFrames({
      frames,
      outputPath,
      fps: 10,
      durationMs,
      captions: cues.cues,
      inputSegments: chips.segments,
      inputOverlayOptions: opts.options,
    })

    /**
     * The caption's pixels and the chips' pixels, separately and exactly.
     *
     * This replaces `splitBands`, which classified each ROW of the frame by the single
     * leftmost inked column on it. A row carrying both caption ink and chip ink therefore
     * took the caption's `x0` and was filed wholly as caption — so a genuine overlap
     * reported as two disjoint bands and the assertion passed. `video-probe.test.ts`
     * demonstrates that on a constructed 21-row collision.
     *
     * Here each layer is encoded on its own from the SAME frames and the SAME `formatAss`
     * output with the other layer's dialogue lines removed, so the styles — and therefore
     * the chip strip's caption-clearing MarginV — are identical to the composite. What
     * differs between an encode and the bare plate is that layer and nothing else.
     */
    async function layers() {
      const ass = formatAss(
        cues.cues,
        { width: W, height: H },
        undefined,
        chips.segments.length ? { segments: chips.segments, options: opts.options } : undefined,
      )
      const variant = async (label: string, which: 'none' | 'caption' | 'chips') => {
        const text = ass.text
          .split('\n')
          .filter((l) => {
            if (l.startsWith('Dialogue: 0,')) return which === 'caption'
            if (l.startsWith('Dialogue: 1,')) return which === 'chips'
            return true
          })
          .join('\n')
        const dir = fs.mkdtempSync(path.join(tmpRoot, `layer-${label}-`))
        const lines: string[] = []
        frames.forEach((f, i) => {
          const file = path.join(dir, `f${String(i).padStart(6, '0')}.jpg`)
          fs.writeFileSync(file, f.data)
          const next = i + 1 < frames.length ? frames[i + 1].offsetMs : durationMs
          lines.push(`file '${file}'`, `duration ${Math.max((next - f.offsetMs) / 1000, 0.001).toFixed(3)}`)
        })
        lines.push(`file '${path.join(dir, `f${String(frames.length - 1).padStart(6, '0')}.jpg`)}'`)
        const listFile = path.join(dir, 'frames.txt')
        fs.writeFileSync(listFile, lines.join('\n'))
        const assPath = path.join(dir, 'a.ass')
        fs.writeFileSync(assPath, text, 'utf8')
        const out = path.join(dir, 'v.mp4')
        // The SAME strip for every variant, so all three clips are the same shape and the
        // differential is the layer and nothing else.
        const r = await run('ffmpeg', [
          '-v', 'error',
          ...buildEncodeArgs({ listFile, outputPath: out, fps: 10, burnAssPath: assPath, strip: ass.strip }),
        ])
        if (r.code !== 0) throw new Error(r.stderr)
        return openVideo(out)
      }
      const plate = await variant('plate', 'none')
      const captionOnly = await variant('caption', 'caption')
      const chipsOnly = await variant('chips', 'chips')
      const at = (frameIndex: number) => ({
        caption: overlayMask(captionOnly, plate, frameIndex),
        chips: overlayMask(chipsOnly, plate, frameIndex),
        width: plate.width,
        height: plate.height,
      })
      return { at, strip: ass.strip }
    }

    return { outputPath, chips, cues, layers }
  }

  it('draws in the BOTTOM-RIGHT by default, only while the chip is up', async () => {
    const { outputPath, chips } = await encodeWith('chip.mp4', [inputStamp('Ctrl+Shift+K', 1000)])
    // The 1600ms dwell lands between the frames at 2000 and 3000 and is snapped forward:
    // the chip is on screen until a frame WITHOUT it exists.
    expect(chips.events[0]).toMatchObject({ startMs: 1000, endMs: 3000 })

    const ink = await inkPerFrame(outputPath, BOTTOM_RIGHT)
    // 10fps: video second 1 is frame 10, second 3 is frame 30.
    expect(ink.slice(0, 9).every((v) => v === 0)).toBe(true)
    expect(ink.slice(11, 29).every((v) => v > 0)).toBe(true)
    expect(ink.slice(31).every((v) => v === 0)).toBe(true)
    // The top-left corner — where a heading, nav or first form field lives on any
    // ordinary page — stays completely clean. This is the regression that matters.
    expect((await inkPerFrame(outputPath, { y0: 0, y1: 0.5, x0: 0, x1: 0.6 })).every((v) => v === 0)).toBe(true)
  })

  it('honours every corner it is told to use', async () => {
    const corners: Array<[InputOverlayOptions['position'], { x0: number; x1: number; y0: number; y1: number }]> = [
      ['top-left', { x0: 0, x1: 0.4, y0: 0, y1: 0.3 }],
      ['top-right', { x0: 0.6, x1: 1, y0: 0, y1: 0.3 }],
      ['bottom-left', { x0: 0, x1: 0.4, y0: 0.7, y1: 1 }],
      ['bottom-right', { x0: 0.6, x1: 1, y0: 0.7, y1: 1 }],
    ]
    for (const [position, here] of corners) {
      const { outputPath } = await encodeWith(`corner-${position}.mp4`, [inputStamp('Click', 1000)], { options: { position } })
      expect(Math.max(...(await inkPerFrame(outputPath, here))), `${position} draws in its own corner`).toBeGreaterThan(0)
      // The diagonally opposite corner must be untouched.
      const opposite = { x0: 1 - here.x1, x1: 1 - here.x0, y0: 1 - here.y1, y1: 1 - here.y0 }
      expect(Math.max(...(await inkPerFrame(outputPath, opposite))), `${position} leaves the opposite corner clean`).toBe(0)
    }
  })

  it('NEVER overlaps the caption, even a three-line one', async () => {
    // The caption block's height is computed from its font, margin and observed line
    // count, and the chips are lifted clear of it. Three lines is the cap, so this is the
    // worst case the default styling can produce.
    const long = captionStamp(
      'Clicking Pay exactly once posts two charge requests to the payments API, and both succeed, so the customer is billed twice for one order.',
      1000,
    )
    expect(long.text.split('\n')).toHaveLength(3)
    const built = await encodeWith('no-overlap.mp4', [inputStamp('Fill •••••• · Ctrl+A', 1000)], { captions: [long] })

    // The two layers must not share a single PIXEL — asked in two dimensions, of the two
    // masks, rather than inferred from which column each row happened to start in.
    const layers = await built.layers()
    const { caption, chips, width, height } = layers.at(15)
    expect(maskBBox(caption, width, height)).not.toBeNull()
    expect(maskBBox(chips, width, height)).not.toBeNull()
    let shared = 0
    for (let i = 0; i < caption.length; i++) if (caption[i] && chips[i]) shared++
    expect(shared, 'the chip strip and the caption block share pixels').toBe(0)
    // And the strip is strictly above the caption, which is the layout that was intended.
    expect(maskBBox(chips, width, height)!.y1).toBeLessThan(maskBBox(caption, width, height)!.y0)

    /**
     * THE STRONGER STATEMENT, which is what replaced the band arithmetic that used to be
     * here: the two are in disjoint REGIONS of the frame. The caption is entirely inside the
     * strip and the chips are entirely on the page, so they cannot reach each other whatever
     * the caption says or how it wraps.
     *
     * A three-line cue is the worst case the default styling can produce — `maxLines` is 3 —
     * so this is not a sample, it is the bound.
     */
    const strip = layers.strip
    expect(strip.lines, 'a three-line cue must produce a three-line strip').toBe(
      renderedCaptionLines(long.text, W - 2 * Math.max(8, Math.round(W * 0.05)), strip.fontSize),
    )
    expect(height).toBe(strip.videoHeight)
    expect(maskBBox(caption, width, height)!.y0, 'no caption ink above the strip').toBeGreaterThanOrEqual(strip.pageHeight)
    expect(maskBBox(chips, width, height)!.y1, 'no chip ink below the page').toBeLessThan(strip.pageHeight)

    const png = await extractFrame(built.outputPath, 1.5, path.join(tmpRoot, 'no-overlap.png'))
    expect(fs.statSync(png).size).toBeGreaterThan(0)
  })

  it('sits in the SAME place on the page whether or not there is a caption', async () => {
    /**
     * This used to assert the opposite — that a caption pushed the chips UP — because the
     * caption was drawn on the page and the chips had to be reserved clear of it. There is
     * nothing to clear now, so the correct property is that the caption changes nothing
     * about where the chips land on the page. The frame is taller, the chip MarginV is
     * larger by exactly that much, and the two cancel.
     *
     * It is a real check and not a tautology: getting the offset wrong in either direction
     * moves the chips, and moving them is the whole failure this replaces.
     */
    const withCaption = await encodeWith('lift-yes.mp4', [inputStamp('Click', 1000)], {
      captions: [captionStamp('narration', 1000)],
    })
    const without = await encodeWith('lift-no.mp4', [inputStamp('Click', 1000)])
    const chipBox = async (b: Awaited<ReturnType<typeof encodeWith>>) => {
      const l = (await b.layers()).at(15)
      return { box: maskBBox(l.chips, l.width, l.height)!, height: l.height, strip: (await b.layers()).strip }
    }
    const a = await chipBox(withCaption)
    const b = await chipBox(without)

    // The captioned clip really is letterboxed and the other really is not.
    expect(a.strip.height).toBeGreaterThan(0)
    expect(b.strip.height).toBe(0)
    expect(a.height).toBe(b.height + a.strip.height)

    // …and the chips are in the same rows of the PAGE in both.
    expect(a.box.y0).toBe(b.box.y0)
    expect(a.box.y1).toBe(b.box.y1)
    expect(a.box.y1, 'the chips are on the page, not in the strip').toBeLessThan(a.strip.pageHeight)
  })

  it('is visually subordinate: the chip carries far less ink than the caption', async () => {
    const built = await encodeWith('subordinate.mp4', [inputStamp('CAPTION', 1000)], {
      captions: [captionStamp('CAPTION', 1000)],
    })
    // The same word, in both styles, at the same instant.
    const { caption, chips, width, height } = (await built.layers()).at(15)
    const area = (m: Uint8Array) => m.reduce((n, v) => n + v, 0)
    expect(area(chips)).toBeGreaterThan(0)
    // 2.4% of height against the caption's 5%: well under half the footprint for one word.
    expect(area(chips)).toBeLessThan(area(caption) * 0.5)
    // And well under the caption's height, which is what makes it read as an HUD.
    expect(maskBBox(chips, width, height)!.height).toBeLessThan(maskBBox(caption, width, height)!.height * 0.9)
  })

  it('a row of three chips is ONE line tall; a stack of three is three', async () => {
    const events = [inputStamp('AAA', 1000), inputStamp('BBB', 1100), inputStamp('CCC', 1200)]
    const row = await encodeWith('layout-row.mp4', events)
    const stack = await encodeWith('layout-stack.mp4', events, { options: { layout: 'stack' } })
    const heightOf = async (b: Awaited<ReturnType<typeof encodeWith>>) => {
      const l = (await b.layers()).at(15)
      return maskBBox(l.chips, l.width, l.height)?.height ?? 0
    }
    const rowH = await heightOf(row)
    const stackH = await heightOf(stack)
    expect(rowH).toBeGreaterThan(0)
    // The whole reason the row is the default: it costs the page a third of the height.
    expect(stackH).toBeGreaterThan(rowH * 2.2)
  })

  it('places a chip at the right VIDEO time when the first frame is late', async () => {
    // First repaint 1500ms in; a chip stamped at 2500 belongs at video time 1000.
    const { outputPath, chips } = await encodeWith('late-start.mp4', [inputStamp('Click', 2500)], { firstOffsetMs: 1500 })
    expect(chips.events[0].startMs).toBe(1000)
    const ink = await inkPerFrame(outputPath, BOTTOM_RIGHT)
    expect(ink.slice(0, 9).every((v) => v === 0)).toBe(true)
    expect(ink.slice(11, 19).every((v) => v > 0)).toBe(true)
  })

  it('refuses to burn without libass rather than dropping the overlay silently', async () => {
    const frames = [{ data: await solidJpeg('black', `${W}x${H}`), offsetMs: 0 }]
    const chips = buildInputChips({ events: [inputStamp('K', 0)], frameOffsetsMs: [0], durationMs: 1000 })
    const realPath = process.env.PATH
    // An ffmpeg that reports no filters at all: capability detection must catch it.
    const stub = path.join(tmpRoot, 'nolibass')
    fs.mkdirSync(stub, { recursive: true })
    fs.writeFileSync(path.join(stub, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    process.env.PATH = stub
    try {
      const { ffmpegCaptionCapabilities } = await import('./cdp-screencast.js')
      await ffmpegCaptionCapabilities(true)
      await expect(
        encodeFrames({ frames, outputPath: path.join(tmpRoot, 'no-libass.mp4'), fps: 10, durationMs: 1000, inputSegments: chips.segments }),
      ).rejects.toThrow(/input overlay is burned into the pixels and needs an ffmpeg built with libass/)
    } finally {
      process.env.PATH = realPath
      const { ffmpegCaptionCapabilities } = await import('./cdp-screencast.js')
      await ffmpegCaptionCapabilities(true)
    }
  })
})

/* ----------------------------------------------------------- the live recorder */

describe('recording.startCdp({ inputOverlay: true }) end to end', () => {
  let browser: Browser
  let context: BrowserContext
  let server: http.Server
  let baseUrl: string

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><body style="margin:0;background:#111;color:#eee">' +
          '<input id="email" style="width:200px">' +
          '<input id="password" type="password" style="width:200px">' +
          '<button id="go">go</button>' +
          '<div id="tall" style="height:2000px"></div>' +
          '</body>',
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const chromium = await getChromium()
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 480, height: 320 } })
  }, 120000)

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    await new Promise<void>((r) => server?.close(() => r()))
  })

  /** Exactly what executor.ts does: start the recorder, then arm the tap on the page. */
  async function record(page: Page, outputPath: string, options: Partial<CdpScreencastOptions> = {}) {
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({
      cdp,
      page,
      outputPath,
      fps: 10,
      quality: 60,
      mode: 'screenshot',
      inputOverlay: true,
      ...options,
    })
    const tap = attachInputOverlayTap({ page, onAction: (a) => handle.inputEvent(a) })
    return { handle, stop: async () => { tap.detach(); return handle.stop() } }
  }

  it('shows a chip for click, fill, Control+A and wheel — including the fill', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const { handle, stop } = await record(page, path.join(tmpRoot, 'live-actions.mp4'))

    await new Promise((r) => setTimeout(r, 400))
    await page.click('#go')
    await new Promise((r) => setTimeout(r, 500))
    await page.fill('#email', 'alice@example.com')
    await new Promise((r) => setTimeout(r, 500))
    await page.keyboard.press('Control+A')
    await new Promise((r) => setTimeout(r, 500))
    await page.mouse.wheel(0, 300)
    await new Promise((r) => setTimeout(r, 700))

    const result = await stop()
    await page.close()

    expect(result.wrote).toBe(true)
    expect(handle.inputEventCount()).toBe(4)
    const labels = result.inputEvents!.map((e: any) => e.label)
    // THE case that killed the naive design: page.fill() dispatches no key event at all,
    // so an in-page keydown listener would show nothing here.
    expect(labels).toEqual(['Click', 'Fill ••••••', 'Ctrl+A', 'Scroll ↓'])
    expect(result.inputEvents!.every((e: any) => !e.dropped)).toBe(true)

    // Every chip is in ascending video time and inside the clip.
    const starts = result.inputEvents!.map((e: any) => e.startMs)
    expect([...starts].sort((a: number, b: number) => a - b)).toEqual(starts)
    expect(starts[0]).toBeGreaterThanOrEqual(0)
    expect(starts[starts.length - 1]).toBeLessThan(result.videoDurationMs!)

    // And they are really burned in.
    const ink = await inkPerFrame(result.outputPath, { y0: 0, y1: 0.25, x0: 0, x1: 0.6 })
    expect(ink.some((v) => v > 0)).toBe(true)
    await extractFrame(result.outputPath, (starts[1] + 200) / 1000, path.join(tmpRoot, 'live-fill-chip.png'))
  }, 90000)

  it('masks a password field even with revealTypedText on', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const { stop } = await record(page, path.join(tmpRoot, 'live-secret.mp4'), {
      inputOverlayOptions: { revealTypedText: true },
    })
    await new Promise((r) => setTimeout(r, 300))
    await page.fill('#email', 'alice@example.com')
    await new Promise((r) => setTimeout(r, 300))
    await page.fill('#password', 'hunter2')
    await new Promise((r) => setTimeout(r, 500))
    const result = await stop()
    await page.close()

    const labels = result.inputEvents!.map((e: any) => e.label)
    expect(labels[0]).toBe('Fill "alice@example.com"')
    expect(labels[1]).toBe('Fill ••••••')
    expect(result.inputEvents![1].adjustments?.join(' ')).toMatch(/looks like a secret field/)
    // The secret must not survive anywhere in the JSON that crosses the MCP boundary.
    expect(JSON.stringify(result)).not.toContain('hunter2')
  }, 90000)

  it('coalesces 10 keystrokes typed inside 300ms into one chip', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const { stop } = await record(page, path.join(tmpRoot, 'live-burst.mp4'), {
      inputOverlayOptions: { revealTypedText: true },
    })
    await new Promise((r) => setTimeout(r, 300))
    await page.locator('#email').focus()
    const began = Date.now()
    for (const c of 'abcdefghij') await page.keyboard.press(c)
    const burstMs = Date.now() - began
    await new Promise((r) => setTimeout(r, 700))
    const result = await stop()
    await page.close()

    // A focus chip, then the merged run. The burst has to actually be a burst for the
    // coalescing window to be the thing under test.
    const keys = result.inputEvents!.filter((e: any) => e.kind === 'key')
    if (burstMs <= 400) {
      expect(keys).toHaveLength(1)
      expect(keys[0].label).toBe('abcdefghij')
      expect(keys[0].coalescedCount).toBe(10)
    } else {
      // Slower machine: the rolling stack is the policy that applies instead, and it
      // must still never put more than maxVisible chips on screen.
      expect(keys.length).toBeGreaterThan(1)
      expect(keys.every((k: any) => [...k.label].length <= 26)).toBe(true)
    }
    expect(result.inputEvents!.length).toBeLessThanOrEqual(12)
  }, 90000)

  it('does not chip an action that failed — it never happened', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const { stop } = await record(page, path.join(tmpRoot, 'live-failed.mp4'))
    await new Promise((r) => setTimeout(r, 300))
    await expect(page.click('#does-not-exist', { timeout: 800 })).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 400))
    const result = await stop()
    await page.close()
    expect(result.inputEvents).toBeUndefined()
  }, 90000)

  it('records nothing and stays quiet when the overlay is off', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({
      cdp,
      page,
      outputPath: path.join(tmpRoot, 'live-off.mp4'),
      fps: 10,
      mode: 'screenshot',
    })
    const stamp = handle.inputEvent({ kind: 'mouse', action: 'click' })
    expect(stamp.accepted).toBe(false)
    expect(stamp.note).toMatch(/input overlay is off/)
    await new Promise((r) => setTimeout(r, 400))
    await page.click('#go')
    await new Promise((r) => setTimeout(r, 300))
    const result = await handle.stop()
    await page.close()
    expect(result.inputEvents).toBeUndefined()
    expect(result.inputOverlayNote).toBeUndefined()
    // No cues and no chips means the plain, unfiltered encode.
    expect((await inkPerFrame(result.outputPath)).length).toBeGreaterThan(0)
  }, 90000)

  it('forces a frame at each input so a page that never repaints still shows its chips', async () => {
    const page = await context.newPage()
    // A page that paints once and then never again: the frame-grid trap in its pure form.
    await page.setContent('<body style="margin:0;background:#111"><input id="q" style="opacity:0"></body>')
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({
      cdp,
      page,
      outputPath: path.join(tmpRoot, 'live-static.mp4'),
      fps: 10,
      mode: 'screencast',
      inputOverlay: true,
    })
    const tap = attachInputOverlayTap({ page, onAction: (a) => handle.inputEvent(a) })
    await new Promise((r) => setTimeout(r, 400))
    await page.keyboard.press('a')
    await new Promise((r) => setTimeout(r, 400))
    await page.keyboard.press('Control+B')
    await new Promise((r) => setTimeout(r, 400))
    await page.keyboard.press('Enter')
    await new Promise((r) => setTimeout(r, 700))
    tap.detach()
    const result = await handle.stop()
    await page.close()

    expect(result.note).toMatch(/Captured \d+ extra frame\(s\) at input events/)
    expect(result.inputEvents).toHaveLength(3)
    // Without the forced frames these would all snap onto one stale frame and two of the
    // three would be dropped as "would never be seen".
    expect(result.inputEvents!.filter((e: any) => !e.dropped).length).toBeGreaterThanOrEqual(2)
  }, 90000)

  it('refuses input events past the cap instead of growing the result without bound', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({
      cdp,
      page,
      outputPath: path.join(tmpRoot, 'live-capped.mp4'),
      fps: 10,
      mode: 'screenshot',
      inputOverlay: true,
      inputOverlayOptions: { maxEvents: 2 },
    })
    expect(handle.inputEvent({ kind: 'mouse', action: 'click' }).accepted).toBe(true)
    expect(handle.inputEvent({ kind: 'mouse', action: 'click' }).accepted).toBe(true)
    const refused = handle.inputEvent({ kind: 'mouse', action: 'click' })
    expect(refused.accepted).toBe(false)
    expect(refused.note).toMatch(/2-event maximum/)
    expect(handle.inputEventCount()).toBe(2)
    await handle.cancel()
    await page.close()
  }, 90000)

  it('refuses an input event once the recording has stopped', async () => {
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const handle = await startCdpScreencast({
      cdp,
      page,
      outputPath: path.join(tmpRoot, 'live-stopped.mp4'),
      fps: 10,
      inputOverlay: true,
    })
    await handle.cancel()
    expect(() => handle.inputEvent({ kind: 'mouse', action: 'click' })).toThrow(/already stopped/)
    await page.close()
  }, 90000)
})
