/**
 * Pure tests for the pointer timeline and the recorder's pointer layer: no browser.
 */

import { describe, it, expect } from 'vitest'
import { PointerTrack } from './pointer-track.js'
import { buildEncodeArgs, buildPointerLayer, formatAss, validatePointerOptions } from './cdp-screencast.js'

describe('PointerTrack', () => {
  it('keeps samples ordered and answers between/latest by time', () => {
    const track = new PointerTrack()
    track.record({ t: 100, x: 1, y: 1, kind: 'move' })
    track.record({ t: 300, x: 3, y: 3, kind: 'down', button: 'left' })
    // A path whose samples were issued between the two hook samples above.
    track.recordPath(
      [
        { tMs: 0, x: 2, y: 2 },
        { tMs: 50, x: 2.5, y: 2.5 },
      ],
      200,
    )

    expect(track.between(0, 1000).map((s) => s.t)).toEqual([100, 200, 250, 300])
    expect(track.between(200, 250).map((s) => s.x)).toEqual([2, 2.5])
    expect(track.latest(260)).toMatchObject({ t: 250, x: 2.5, kind: 'move' })
    expect(track.latest(300)).toMatchObject({ t: 300, kind: 'down', button: 'left' })
    expect(track.latest(99)).toBeUndefined()
    expect(track.latest()).toMatchObject({ t: 300 })
  })

  it('tells listeners whether a sample came from an action or a path', () => {
    const track = new PointerTrack()
    const seen: string[] = []
    const off = track.onRecord((sample, origin) => seen.push(`${origin}:${sample.kind}`))
    track.record({ x: 0, y: 0, kind: 'down' })
    track.recordPath([{ tMs: 0, x: 1, y: 1 }], Date.now())
    off()
    track.record({ x: 0, y: 0, kind: 'up' })
    expect(seen).toEqual(['action:down', 'path:move'])
  })

  it('refuses non-finite positions instead of recording them', () => {
    const track = new PointerTrack()
    expect(() => track.record({ x: Number.NaN, y: 1, kind: 'move' })).toThrow(/finite/)
    expect(track.size).toBe(0)
  })
})

describe('buildPointerLayer', () => {
  const frames = [
    { offsetMs: 0, scale: 2, offsetTop: 0 },
    { offsetMs: 1000, scale: 2, offsetTop: 0 },
  ]

  it('steps through dispatched positions on the output frame grid, in frame px', () => {
    const layer = buildPointerLayer({
      samples: [
        { t: 1000, x: 10, y: 20, kind: 'move' },
        { t: 1500, x: 100, y: 50, kind: 'move' },
        { t: 1510, x: 100, y: 50, kind: 'down', button: 'left' },
        { t: 1530, x: 100, y: 50, kind: 'up', button: 'left' },
      ],
      recordingStartedAt: 1000,
      frames,
      durationMs: 2000,
      fps: 10,
    })
    // 0..450ms at (10,20)*2, then (100,50)*2 from the 500ms frame on. The press lasted 20ms,
    // between two output frames, so no frame shows it held; the rings do.
    expect(layer.segments).toEqual([
      { startMs: 0, endMs: 450, x: 20, y: 40, scale: 2, pressed: false },
      { startMs: 450, endMs: 2050, x: 200, y: 100, scale: 2, pressed: false },
    ])
    expect(layer.pulses.map((p) => [p.kind, p.atMs, p.x, p.y])).toEqual([
      ['down', 510, 200, 100],
      ['up', 530, 200, 100],
    ])
  })

  it('starts from the last position before the recording, and skips frames with no scale', () => {
    const layer = buildPointerLayer({
      samples: [{ t: 500, x: 5, y: 5, kind: 'move' }],
      recordingStartedAt: 1000,
      frames: [{ offsetMs: 0 }, { offsetMs: 500, scale: 1 }],
      durationMs: 1000,
      fps: 10,
    })
    expect(layer.segments[0]).toMatchObject({ startMs: 450, x: 5, y: 5 })
    expect(layer.note).toMatch(/missing from 5 output frame/)
  })

  it('clips the pointer to the page rows and resamples before libass draws', () => {
    const layer = buildPointerLayer({
      samples: [{ t: 0, x: 10, y: 10, kind: 'move' }],
      recordingStartedAt: 0,
      frames: [{ offsetMs: 0, scale: 1 }],
      durationMs: 500,
      fps: 10,
    })
    const ass = formatAss(
      [{ index: 0, text: 'caption', startMs: 0, endMs: 500, atMs: 0 }],
      { width: 320, height: 200 },
      undefined,
      undefined,
      { layer },
    )
    const pointerLines = ass.text.split('\n').filter((l) => l.includes(',Pointer,'))
    expect(pointerLines.length).toBe(1)
    expect(pointerLines[0]).toContain(`\\clip(0,0,320,200)`)
    expect(pointerLines[0]).toContain('\\pos(10,10)')
    expect(ass.strip.height).toBeGreaterThan(0)

    const args = buildEncodeArgs({ listFile: 'l.txt', outputPath: 'o.mp4', fps: 10, burnAssPath: '/tmp/a.ass', resampleBeforeBurn: true })
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=10,subtitles=/tmp/a.ass')
  })

  it('refuses pointer options that cannot be meant', () => {
    expect(() => validatePointerOptions({ fillColor: '#FFFFFF', outlineColor: '#FFFFFF' })).toThrow(/same colour/)
    expect(() => validatePointerOptions({ sizePx: 0 })).toThrow(/sizePx/)
    expect(() => validatePointerOptions({ pulseColor: 'blue' })).toThrow(/#RRGGBB/)
  })
})
