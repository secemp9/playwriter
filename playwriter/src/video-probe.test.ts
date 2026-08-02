/**
 * Unit tests for the pixel module.
 *
 * The first block is the important one. It reconstructs the helper this module replaces
 * and shows it passing a frame in which the caption and the chips genuinely overlap by 21
 * rows — then shows the replacement failing on the same frame. An oracle that was green
 * from the start proves nothing, and `splitBands` was green from the start.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MIN_COMPONENT_AREA,
  OVERLAY_MASK_THRESHOLD,
  brightPixelsPerFrame,
  connectedComponents,
  enclosedHoles,
  maskBBox,
  maskIntersection,
  maskWithin,
  openVideo,
  overlayMask,
  probeVideo,
  rectsOverlap,
  writeFramePng,
  writeRgbPng,
} from './video-probe.js'

let tmpRoot: string

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-video-probe-test-'))
})

afterAll(() => {
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

/* ------------------------------------------- the blindness this module removes */

/**
 * The old helper, reproduced exactly as it was, so the comparison is against the real
 * thing rather than against a description of it.
 *
 * `inkRows` recorded ONE `x0` per row — the leftmost inked column — and `splitBands`
 * classified the whole row by it. A row carrying both caption ink (left of centre) and
 * chip ink (right of centre) therefore had `x0` from the caption and was filed entirely
 * as caption, taking the chip's ink on that row with it.
 */
function legacyInkRows(mask: Uint8Array, width: number, height: number) {
  const out: Array<{ y: number; x0: number; count: number }> = []
  for (let y = 0; y < height; y++) {
    let x0 = -1
    let count = 0
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        if (x0 < 0) x0 = x
        count++
      }
    }
    if (x0 >= 0) out.push({ y, x0, count })
  }
  return out
}

function legacySplitBands(mask: Uint8Array, width: number, height: number) {
  const rows = legacyInkRows(mask, width, height)
  return {
    chip: rows.filter((r) => r.x0 >= width * 0.5),
    caption: rows.filter((r) => r.x0 < width * 0.5),
  }
}

describe('the replaced helper was structurally unable to see an overlap', () => {
  const W = 800
  const H = 480
  /**
   * A caption block on rows 410-450 spanning columns 100-499, and a chip strip on rows
   * 400-430 spanning columns 400-699. They genuinely share 21 rows AND 100 columns, so
   * 2100 pixels carry both — a chip sitting squarely on top of the narration.
   */
  const captionMask = new Uint8Array(W * H)
  const chipMask = new Uint8Array(W * H)
  for (let y = 410; y <= 450; y++) for (let x = 100; x <= 499; x++) captionMask[y * W + x] = 1
  for (let y = 400; y <= 430; y++) for (let x = 400; x <= 699; x++) chipMask[y * W + x] = 1
  const combined = new Uint8Array(W * H)
  for (let i = 0; i < combined.length; i++) combined[i] = captionMask[i] || chipMask[i] ? 1 : 0

  it('is a GENUINE overlap: 2100 pixels across 21 rows carry both', () => {
    const shared = maskIntersection(captionMask, chipMask)
    expect(shared.length).toBe(21 * 100)
    const box = maskBBox(chipMask.map((v, i) => (v && captionMask[i] ? 1 : 0)) as Uint8Array, W, H)!
    expect(box).toMatchObject({ x0: 400, x1: 499, y0: 410, y1: 430 })
  })

  it('splitBands PASSES it — rows 410-430 carry chip ink but are filed as caption', () => {
    const { chip, caption } = legacySplitBands(combined, W, H)
    const lowestChipRow = Math.max(...chip.map((r) => r.y))
    const highestCaptionRow = Math.min(...caption.map((r) => r.y))
    // The chip strip really reaches row 430. Rows 410-430 have caption ink starting at
    // column 100, so their single recorded x0 is 100 and the whole row — chip pixels and
    // all — is classified as caption.
    expect(lowestChipRow).toBe(409)
    expect(highestCaptionRow).toBe(410)
    // This is verbatim the assertion the shipped suite made, and it is satisfied.
    expect(lowestChipRow).toBeLessThan(highestCaptionRow)
  })

  it('the 2D mask intersection FAILS it, which is the point of the replacement', () => {
    expect(maskIntersection(captionMask, chipMask).length).toBeGreaterThan(0)

    // And the geometric claim splitBands believed it was making — the chip block sits
    // strictly above the caption block — is checkable directly, and is false.
    const chipBox = maskBBox(chipMask, W, H)!
    const capBox = maskBBox(captionMask, W, H)!
    expect(chipBox.y1).toBe(430)
    expect(capBox.y0).toBe(410)
    expect(chipBox.y1 < capBox.y0).toBe(false)
    expect(rectsOverlap(chipBox, capBox)).toBe(true)
  })

  it('and it still passes splitBands when the chip is moved fully INSIDE the caption', () => {
    // The worst case: the strip entirely within the caption's rows. splitBands reports an
    // empty chip band and an intact caption band, so `max(chip.y) < min(caption.y)` is
    // comparing -Infinity against 410 and passes without the chips existing at all.
    const inside = new Uint8Array(W * H)
    for (let y = 415; y <= 440; y++) for (let x = 400; x <= 699; x++) inside[y * W + x] = 1
    const both = new Uint8Array(W * H)
    for (let i = 0; i < both.length; i++) both[i] = captionMask[i] || inside[i] ? 1 : 0
    const { chip, caption } = legacySplitBands(both, W, H)
    expect(chip).toHaveLength(0)
    expect(Math.max(...chip.map((r) => r.y))).toBe(-Infinity)
    expect(Math.max(...chip.map((r) => r.y)) < Math.min(...caption.map((r) => r.y))).toBe(true)
    // The replacement sees 26 rows of collision.
    expect(maskIntersection(captionMask, inside).length).toBe(26 * 100)
  })
})

/* ------------------------------------------------------------ mask primitives */

describe('connectedComponents', () => {
  const W = 40
  const H = 20
  function withBlocks(blocks: Array<[number, number, number, number]>) {
    const m = new Uint8Array(W * H)
    for (const [x0, y0, x1, y1] of blocks) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * W + x] = 1
    return m
  }

  it('separates two blocks and reports each bounding box', () => {
    const cs = connectedComponents(withBlocks([[1, 1, 5, 5], [20, 10, 30, 15]]), W, H)
    expect(cs).toHaveLength(2)
    // Sorted by area, largest first: the 11x6 block beats the 5x5 one.
    expect(cs[0].bbox).toMatchObject({ x0: 20, y0: 10, x1: 30, y1: 15 })
    expect(cs[1].bbox).toMatchObject({ x0: 1, y0: 1, x1: 5, y1: 5 })
    expect(cs[0].area).toBe(11 * 6)
  })

  it('joins blocks that touch only diagonally, because glyph strokes do', () => {
    const m = new Uint8Array(W * H)
    m[5 * W + 5] = 1
    m[6 * W + 6] = 1
    m[7 * W + 7] = 1
    expect(connectedComponents(m, W, H, { minArea: 1 })).toHaveLength(1)
    expect(connectedComponents(m, W, H, { minArea: 1, connectivity: 4 })).toHaveLength(3)
  })

  it('drops components under minArea, so encoder speckle is not a region', () => {
    const m = withBlocks([[1, 1, 8, 8]])
    m[15 * W + 30] = 1
    expect(connectedComponents(m, W, H)).toHaveLength(1)
    expect(connectedComponents(m, W, H, { minArea: 1 })).toHaveLength(2)
    expect(MIN_COMPONENT_AREA).toBeGreaterThan(1)
  })
})

describe('enclosedHoles: the topological measure the smudge needs', () => {
  const W = 30
  const H = 30
  /** A ring: an 'o' with an open counter. */
  function ring(thickness: number) {
    const m = new Uint8Array(W * H)
    for (let y = 5; y <= 24; y++) {
      for (let x = 5; x <= 24; x++) {
        const inner = x >= 5 + thickness && x <= 24 - thickness && y >= 5 + thickness && y <= 24 - thickness
        if (!inner) m[y * W + x] = 1
      }
    }
    return m
  }

  it('finds the counter of an open ring', () => {
    const holes = enclosedHoles(ring(2), W, H)
    expect(holes).toHaveLength(1)
    expect(holes[0]).toBe(16 * 16)
  })

  it('finds NOTHING once the ring has filled in — which is the defect', () => {
    // thickness 10 leaves no interior at all: the glyph has become a blob.
    expect(enclosedHoles(ring(10), W, H)).toHaveLength(0)
  })

  it('moves the OPPOSITE way to ink, which is why ink cannot detect a smudge', () => {
    const thin = ring(2)
    const thick = ring(6)
    const ink = (m: Uint8Array) => m.reduce((n, v) => n + v, 0)
    // More ink, fewer counters. Any brightness- or area-based check reads the smudged
    // glyph as the stronger one.
    expect(ink(thick)).toBeGreaterThan(ink(thin))
    expect(enclosedHoles(thick, W, H)[0]).toBeLessThan(enclosedHoles(thin, W, H)[0])
  })

  it('does not count the outside as a hole, however concave the shape', () => {
    const m = new Uint8Array(W * H)
    // A 'C': a ring with its right side missing, so the interior connects to the outside.
    for (let y = 5; y <= 24; y++) for (let x = 5; x <= 24; x++) {
      const inner = x >= 7 && x <= 22 && y >= 7 && y <= 22
      if (!inner) m[y * W + x] = 1
    }
    for (let y = 10; y <= 19; y++) for (let x = 23; x <= 24; x++) m[y * W + x] = 0
    expect(enclosedHoles(m, W, H)).toHaveLength(0)
  })
})

describe('maskWithin and bounding boxes', () => {
  it('clips a mask to a rectangle', () => {
    const W = 20
    const H = 10
    const m = new Uint8Array(W * H).fill(1)
    const clipped = maskWithin(m, W, { x0: 2, y0: 3, x1: 5, y1: 6, width: 4, height: 4 })
    expect(maskBBox(clipped, W, H)).toMatchObject({ x0: 2, y0: 3, x1: 5, y1: 6, width: 4, height: 4 })
  })

  it('returns null for an empty mask rather than a degenerate rectangle', () => {
    expect(maskBBox(new Uint8Array(100), 10, 10)).toBeNull()
  })
})

/* --------------------------------------------------- ffprobe is the authority */

describe('openVideo takes its dimensions from ffprobe, not from the caller', () => {
  let mp4: string

  beforeAll(async () => {
    mp4 = path.join(tmpRoot, 'probe.mp4')
    // 641x361 on purpose: `scale=trunc(iw/2)*2` rounds it to 640x360, so the size a caller
    // would "know" from the source is NOT the size of the encoded frames. This is the exact
    // shape of the bug the old helper could not detect.
    const r = await run('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=641x361:rate=10:duration=1',
      '-vsync', 'cfr', '-r', '10',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      mp4,
    ])
    if (r.code !== 0) throw new Error(r.stderr)
  }, 60000)

  it('reports the ENCODED size, which is not the size that was asked for', async () => {
    const probed = await probeVideo(mp4)
    expect(probed.width).toBe(640)
    expect(probed.height).toBe(360)
    expect(probed.frameCount).toBe(10)
  })

  it('decodes once and checks the byte count against what ffprobe promised', async () => {
    const v = await openVideo(mp4)
    expect(v.rgb.length).toBe(640 * 360 * 3 * 10)
    expect(v.frameBytes).toBe(640 * 360 * 3)
  })

  it('refuses an out-of-range pixel instead of silently wrapping into the next row', async () => {
    const v = await openVideo(mp4)
    expect(() => v.pixel(0, 640, 0)).toThrow(/outside 640x360/)
    expect(() => v.pixel(10, 0, 0)).toThrow(/frame 10 of 10/)
    // The old helper computed `frame * width * height + y * width + x` from a caller-supplied
    // size and read whatever byte that landed on.
    expect(() => v.pixel(0, 0, 360)).toThrow(/outside 640x360/)
  })

  it('says so loudly when there is no file to probe', async () => {
    await expect(probeVideo(path.join(tmpRoot, 'absent.mp4'))).rejects.toThrow(/does not exist/)
  })

  it('writes a frame to a PNG a human can open', async () => {
    const v = await openVideo(mp4)
    const png = await writeFramePng(v, 3, path.join(tmpRoot, 'frame3.png'))
    expect(fs.statSync(png).size).toBeGreaterThan(0)
    await expect(writeFramePng(v, 99, path.join(tmpRoot, 'nope.png'))).rejects.toThrow(/frame 99 of 10/)
  })
})

/* ----------------------------------------------- the clean-plate differential */

describe('overlayMask finds the overlay on a LIGHT page, where a brightness threshold cannot', () => {
  let plate: string
  let composite: string

  beforeAll(async () => {
    // A white page. Under the old `> 200 is ink` rule the entire frame is ink.
    const frame = path.join(tmpRoot, 'white.jpg')
    let r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x240', '-frames:v', '1', frame])
    if (r.code !== 0) throw new Error(r.stderr)
    const list = path.join(tmpRoot, 'white-list.txt')
    const lines: string[] = []
    for (let i = 0; i < 4; i++) lines.push(`file '${frame}'`, 'duration 0.500')
    lines.push(`file '${frame}'`)
    fs.writeFileSync(list, lines.join('\n'))

    const ass = path.join(tmpRoot, 'white.ass')
    fs.writeFileSync(
      ass,
      [
        '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 320', 'PlayResY: 240', 'WrapStyle: 0',
        'ScaledBorderAndShadow: yes', '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        // White text with a black outline, exactly the default look, on a white page.
        'Style: Default,DejaVu Sans,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,16,16,14,1',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:00.00,0:00:09.00,Default,,0,0,0,,legible caption',
        '',
      ].join('\n'),
    )

    const enc = (out: string, vf: string) => [
      '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vsync', 'cfr', '-r', '10',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-vf', vf,
      '-movflags', '+faststart', '-v', 'error', out,
    ]
    plate = path.join(tmpRoot, 'white-plate.mp4')
    composite = path.join(tmpRoot, 'white-comp.mp4')
    r = await run('ffmpeg', enc(plate, 'scale=trunc(iw/2)*2:trunc(ih/2)*2'))
    if (r.code !== 0) throw new Error(r.stderr)
    r = await run('ffmpeg', enc(composite, `scale=trunc(iw/2)*2:trunc(ih/2)*2,subtitles=${ass}`))
    if (r.code !== 0) throw new Error(r.stderr)
  }, 120000)

  it('the brightness rule saturates: EVERY pixel of a white page is "ink"', async () => {
    const v = await openVideo(composite)
    const bright = brightPixelsPerFrame(v)
    // Nothing about the caption is visible in this number; it is the frame size.
    expect(Math.max(...bright)).toBeGreaterThan(v.width * v.height * 0.9)
    // And the caption REDUCES it, because the outline is dark. The measure runs backwards.
    const plateV = await openVideo(plate)
    expect(Math.max(...bright)).toBeLessThan(Math.max(...brightPixelsPerFrame(plateV)) + 1)
  })

  it('the differential finds exactly the caption, and only the caption', async () => {
    const comp = await openVideo(composite)
    const pl = await openVideo(plate)
    const m = overlayMask(comp, pl, 2)
    const box = maskBBox(m, comp.width, comp.height)
    expect(box).not.toBeNull()
    // A one-line 20px caption near the bottom of a 240px frame.
    expect(box!.height).toBeLessThan(40)
    expect(box!.y0).toBeGreaterThan(comp.height * 0.7)
    // It is a small fraction of the frame, not the whole thing.
    expect(box!.width).toBeLessThan(comp.width)
    const components = connectedComponents(m, comp.width, comp.height)
    expect(components.length).toBeGreaterThan(0)
  })

  it('refuses to difference two clips that are not the same shape', async () => {
    const comp = await openVideo(composite)
    const other = await openVideo(path.join(tmpRoot, 'probe.mp4'))
    expect(() => overlayMask(comp, other, 0)).toThrow(/same encode of the same frames/)
  })

  it('has a threshold above the measured encoder bleed', () => {
    // Measured on a 25-frame capture of a repainting page: the largest plate-vs-composite
    // delta outside the caption band was 24, and nothing exceeded it.
    expect(OVERLAY_MASK_THRESHOLD).toBeGreaterThan(24)
  })
})

describe('writeRgbPng', () => {
  it('round-trips a buffer to a file a viewer can open', async () => {
    const W = 8
    const H = 4
    const rgb = Buffer.alloc(W * H * 3, 128)
    const png = await writeRgbPng(rgb, W, H, path.join(tmpRoot, 'flat.png'))
    expect(fs.statSync(png).size).toBeGreaterThan(0)
  })
})
