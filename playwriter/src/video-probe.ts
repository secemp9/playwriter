/**
 * video-probe.ts — reading what is actually in the pixels of an encoded clip.
 *
 * This exists because the visual guard it replaces was structurally unable to see the
 * defects it was written to catch. The old helper lived inside a test file and:
 *
 *   - took the frame WIDTH AND HEIGHT FROM THE CALLER. Every index into the decoded byte
 *     stream is `frameIndex * width * height + y * width + x`, so a caller who believes
 *     the wrong size does not get an error, it gets a confidently wrong answer about a
 *     sheared image. The encode's own `scale=trunc(iw/2)*2` can change a dimension by a
 *     pixel, which is exactly enough. Here the size comes from `ffprobe`, and the decoded
 *     length is checked against it.
 *
 *   - thresholded gray-converted pixels at `> 200` and called the result "ink". That is
 *     hue-dependent (pure blue converts to 29, pure red to 76 — neither is "ink" by that
 *     rule, both are page content) and on a light page it saturates to the WHOLE FRAME, so
 *     every assertion built on it was silently conditioned on the plate being dark. Here
 *     the overlay is found by differencing the composite against a clean plate encoded
 *     from the same frames without the subtitle filter: whatever changed IS the overlay,
 *     whatever the page is.
 *
 *   - classified each row by the single leftmost inked column on it, so a row containing
 *     both caption ink and chip ink was filed entirely as caption. A genuine 21-row
 *     overlap therefore reported as disjoint and the assertion passed. Here masks are
 *     two-dimensional and regions come out of connected-component labelling, so
 *     "do these two things overlap" is asked of the pixels they actually occupy.
 *
 * The measurements that set the constants in this file are recorded at each constant.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Per-channel delta above which a pixel counts as "the overlay changed this".
 *
 * MEASURED. The plate and the composite are two separate x264 encodes of the same frames,
 * so they differ slightly even where nothing was drawn — the subtitle changes the picture,
 * which changes rate-control decisions, which perturbs macroblocks elsewhere. Measured on
 * a real 25-frame capture of a repainting page, sampling only rows the caption never
 * touches:
 *
 *     max per-pixel delta                              24
 *     pixels differing at all                     0.226%
 *     pixels differing by more than  8            0.018%
 *     pixels differing by more than 16            0.002%
 *     pixels differing by more than 24                 0
 *
 * On a static clip the same measurement gives a max delta of 0 — every byte identical. So
 * 32 is above the worst observed bleed with a third of headroom, and far below any real
 * overlay edge, which is a glyph or an outline against page content.
 */
export const OVERLAY_MASK_THRESHOLD = 32

/**
 * Components smaller than this are discarded before any geometry is asserted.
 *
 * At `OVERLAY_MASK_THRESHOLD` the measured encode bleed is exactly zero pixels, so this is
 * headroom rather than a fitted value: it guards against a noisier ffmpeg build without
 * being able to swallow a real glyph. The thinnest thing the overlay can draw is a 1px
 * outline around a fontSize-16 face, whose connected footprint is hundreds of pixels.
 */
export const MIN_COMPONENT_AREA = 8

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  height: number
}

export interface Component {
  /** Pixel count. */
  area: number
  bbox: Rect
  /** Flat pixel indices (y * width + x), for exact overlap tests. */
  pixels: Int32Array
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

/** What `ffprobe` says about the video stream. Never what the caller believes. */
export interface ProbedStream {
  width: number
  height: number
  frameCount: number
}

/**
 * Ask ffprobe for the real dimensions and the real frame count.
 *
 * `-count_frames` rather than the container's `nb_frames`, which is a hint and is absent
 * from plenty of muxes. Slower, and worth it: a frame count that is off by one turns
 * "sweep every frame" into "sweep every frame but the last", and the last frame is where
 * a chip cut short by the end of the clip lives.
 */
export async function probeVideo(videoPath: string): Promise<ProbedStream> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`probeVideo: ${videoPath} does not exist. Nothing was encoded, or the path is wrong.`)
  }
  const r = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=width,height,nb_read_frames',
    '-of', 'json',
    videoPath,
  ])
  if (r.code !== 0) throw new Error(`ffprobe failed on ${videoPath}:\n${r.stderr}`)
  const parsed = JSON.parse(r.stdout.toString() || '{}')
  const s = parsed?.streams?.[0]
  if (!s) throw new Error(`ffprobe found no video stream in ${videoPath}.`)
  const width = Number(s.width)
  const height = Number(s.height)
  const frameCount = Number(s.nb_read_frames)
  if (!(width > 0) || !(height > 0) || !(frameCount > 0)) {
    throw new Error(
      `ffprobe returned an unusable video stream for ${videoPath}: ` +
        `width=${s.width} height=${s.height} frames=${s.nb_read_frames}.`,
    )
  }
  return { width, height, frameCount }
}

/**
 * A decoded clip: decode once, index many.
 *
 * Decoding is by far the expensive part, and the old helper re-spawned ffmpeg and re-decoded
 * the entire video for every single question asked of it — including once per frame in a
 * loop. Everything here reads the one `rgb24` buffer.
 */
export class DecodedVideo {
  readonly path: string
  readonly width: number
  readonly height: number
  readonly frameCount: number
  /** `frameCount * height * width * 3` bytes of rgb24. */
  readonly rgb: Buffer

  constructor(videoPath: string, probed: ProbedStream, rgb: Buffer) {
    this.path = videoPath
    this.width = probed.width
    this.height = probed.height
    this.frameCount = probed.frameCount
    this.rgb = rgb
  }

  get frameBytes(): number {
    return this.width * this.height * 3
  }

  /** Byte offset of pixel (x, y) in frame `i`. Bounds-checked, because a silent wrap is the bug. */
  offset(frame: number, x: number, y: number): number {
    if (frame < 0 || frame >= this.frameCount) throw new RangeError(`frame ${frame} of ${this.frameCount} in ${this.path}`)
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      throw new RangeError(`pixel (${x}, ${y}) outside ${this.width}x${this.height} in ${this.path}`)
    }
    return frame * this.frameBytes + (y * this.width + x) * 3
  }

  pixel(frame: number, x: number, y: number): [number, number, number] {
    const o = this.offset(frame, x, y)
    return [this.rgb[o], this.rgb[o + 1], this.rgb[o + 2]]
  }

  /** Rec.601 luma, for contrast questions. Not for finding ink — see the file header. */
  luma(frame: number, x: number, y: number): number {
    const [r, g, b] = this.pixel(frame, x, y)
    return 0.299 * r + 0.587 * g + 0.114 * b
  }
}

/**
 * Decode a clip to rgb24 and check the result against what ffprobe promised.
 *
 * The length check is the point. If the decoded stream is not exactly
 * `frames * width * height * 3` bytes then one of the two sources is lying, and every
 * index computed from either would be off — silently, and by a whole row per frame.
 */
export async function openVideo(videoPath: string): Promise<DecodedVideo> {
  const probed = await probeVideo(videoPath)
  const r = await run('ffmpeg', ['-v', 'error', '-i', videoPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  if (r.code !== 0) throw new Error(`ffmpeg failed to decode ${videoPath}:\n${r.stderr}`)
  const expected = probed.width * probed.height * 3 * probed.frameCount
  if (r.stdout.length !== expected) {
    throw new Error(
      `Decoded ${videoPath} to ${r.stdout.length} bytes but ffprobe describes ` +
        `${probed.frameCount} frames of ${probed.width}x${probed.height} rgb24 = ${expected} bytes. ` +
        'Every pixel index is derived from those dimensions, so continuing would read a sheared image ' +
        'and report confident nonsense about it.',
    )
  }
  return new DecodedVideo(videoPath, probed, r.stdout)
}

/**
 * The overlay footprint in one frame: what the composite has that the clean plate does not.
 *
 * This replaces thresholding brightness. The plate is the SAME frames through the SAME
 * encoder with the subtitle filter removed, so anything that differs is something libass
 * drew — regardless of whether it is bright, dark, or the same colour as the page it sits
 * on. A white caption over a white page has an invisible fill and a very visible outline,
 * and this finds the outline; a brightness threshold finds the whole page.
 */
export function overlayMask(
  composite: DecodedVideo,
  plate: DecodedVideo,
  frame: number,
  threshold = OVERLAY_MASK_THRESHOLD,
): Uint8Array {
  if (composite.width !== plate.width || composite.height !== plate.height) {
    throw new Error(
      `The composite is ${composite.width}x${composite.height} and the clean plate is ` +
        `${plate.width}x${plate.height}. They must be the same encode of the same frames with only the ` +
        'subtitle filter differing, or the difference between them is not the overlay.',
    )
  }
  if (composite.frameCount !== plate.frameCount) {
    throw new Error(
      `The composite has ${composite.frameCount} frames and the clean plate has ${plate.frameCount}. ` +
        'They must line up frame for frame.',
    )
  }
  const { width, height } = composite
  const mask = new Uint8Array(width * height)
  const base = frame * composite.frameBytes
  for (let p = 0; p < width * height; p++) {
    const i = base + p * 3
    const d = Math.max(
      Math.abs(composite.rgb[i] - plate.rgb[i]),
      Math.abs(composite.rgb[i + 1] - plate.rgb[i + 1]),
      Math.abs(composite.rgb[i + 2] - plate.rgb[i + 2]),
    )
    if (d > threshold) mask[p] = 1
  }
  return mask
}

/**
 * Pixels inside `mask` whose colour is within `tolerance` of `hex` — the glyph FILL as
 * opposed to its outline or its box.
 *
 * Needed because the differential finds the whole overlay footprint, and several questions
 * are about the text specifically: whether its counters survived, and what is immediately
 * behind it.
 */
export function colorMask(
  video: DecodedVideo,
  frame: number,
  within: Uint8Array,
  hex: string,
  tolerance = 60,
): Uint8Array {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`colorMask needs #RRGGBB, got ${JSON.stringify(hex)}`)
  const [tr, tg, tb] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
  const { width, height } = video
  const out = new Uint8Array(width * height)
  const base = frame * video.frameBytes
  for (let p = 0; p < width * height; p++) {
    if (!within[p]) continue
    const i = base + p * 3
    if (
      Math.abs(video.rgb[i] - tr) <= tolerance &&
      Math.abs(video.rgb[i + 1] - tg) <= tolerance &&
      Math.abs(video.rgb[i + 2] - tb) <= tolerance
    ) {
      out[p] = 1
    }
  }
  return out
}

export function maskArea(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++
  return n
}

export function maskBBox(mask: Uint8Array, width: number, height: number): Rect | null {
  let x0 = width, x1 = -1, y0 = height, y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/** Pixels in both masks. The disjointness question, asked in two dimensions. */
export function maskIntersection(a: Uint8Array, b: Uint8Array): number[] {
  const hits: number[] = []
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] && b[i]) hits.push(i)
  return hits
}

export function maskSubtract(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] && !b[i] ? 1 : 0
  return out
}

export function maskUnion(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] || b[i] ? 1 : 0
  return out
}

/** Every pixel of `mask` inside `rect`, as a new mask. */
export function maskWithin(mask: Uint8Array, width: number, rect: Rect): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const p = y * width + x
      if (mask[p]) out[p] = 1
    }
  }
  return out
}

/**
 * Connected components of a mask, 8-connected.
 *
 * 8 rather than 4 because glyph strokes meet diagonally all the time and a 4-connected
 * label would split one letter into three, which turns "how many things are drawn here"
 * into a question about the font's hinting.
 */
export function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  { minArea = MIN_COMPONENT_AREA, connectivity = 8 }: { minArea?: number; connectivity?: 4 | 8 } = {},
): Component[] {
  const seen = new Uint8Array(width * height)
  const out: Component[] = []
  const stack: number[] = []
  const neighbours = connectivity === 8
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    : [[0, -1], [-1, 0], [1, 0], [0, 1]]

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const pixels: number[] = []
    let x0 = width, x1 = -1, y0 = height, y1 = -1
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const p = stack.pop() as number
      pixels.push(p)
      const x = p % width
      const y = (p - x) / width
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (const [dx, dy] of neighbours) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const q = ny * width + nx
        if (mask[q] && !seen[q]) {
          seen[q] = 1
          stack.push(q)
        }
      }
    }
    if (pixels.length >= minArea) {
      out.push({
        area: pixels.length,
        bbox: { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 },
        pixels: Int32Array.from(pixels),
      })
    }
  }
  return out.sort((a, b) => b.area - a.area)
}

/**
 * Areas of the holes enclosed by `mask` — the counters of the glyphs it draws.
 *
 * TOPOLOGICAL, and that is the whole point. The smudge defect ADDS ink: a heavier outline
 * fills the counters of `e`, `o`, `a`, `g` until each letter is a solid blob. Every measure
 * that counts ink, or brightness, or area, therefore moves the WRONG WAY as the text gets
 * less readable, and would report a smudged caption as a stronger one. What actually
 * changes is that the holes stop existing.
 *
 * Measured against libass: at an outline of 1/24 of the font size the worst counter keeps
 * 45% of its open area, at 1/16 it keeps 17%, at 1/12 it keeps 9%, and at 1/8 it is gone
 * entirely — which is what `Math.max(2, round(fontSize / 16))` produced on any frame 320px
 * tall or shorter.
 */
export function enclosedHoles(mask: Uint8Array, width: number, height: number, minArea = 1): number[] {
  const seen = new Uint8Array(width * height)
  const areas: number[] = []
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || seen[start]) continue
    let area = 0
    let touchesEdge = false
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const p = stack.pop() as number
      area++
      const x = p % width
      const y = (p - x) / width
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true
      // 4-connected on the BACKGROUND, which is the dual of 8-connected ink: mixing the
      // two connectivities is what makes a hole a hole rather than a diagonal leak.
      if (x > 0 && !mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1) }
      if (x < width - 1 && !mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1) }
      if (y > 0 && !mask[p - width] && !seen[p - width]) { seen[p - width] = 1; stack.push(p - width) }
      if (y < height - 1 && !mask[p + width] && !seen[p + width]) { seen[p + width] = 1; stack.push(p + width) }
    }
    if (!touchesEdge && area >= minArea) areas.push(area)
  }
  return areas.sort((a, b) => b - a)
}

/** True when the two rectangles share any pixel. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0)
}

/**
 * Write one frame to a PNG so a human can look at it.
 *
 * All four defects this suite exists for were found by someone looking at a frame, and
 * none of them by a number going red. Every assertion that can fail names a path written
 * by this function, so the first thing a failure hands you is the picture.
 */
export async function writeFramePng(video: DecodedVideo, frame: number, outPng: string): Promise<string> {
  if (frame < 0 || frame >= video.frameCount) {
    throw new RangeError(`writeFramePng: frame ${frame} of ${video.frameCount} in ${video.path}`)
  }
  const base = frame * video.frameBytes
  const body = video.rgb.subarray(base, base + video.frameBytes)
  return writeRgbPng(body, video.width, video.height, outPng)
}

/** Write an arbitrary rgb24 buffer to a PNG. */
export async function writeRgbPng(rgb: Buffer | Uint8Array, width: number, height: number, outPng: string): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-probe-'))
  try {
    const ppm = path.join(tmp, 'f.ppm')
    fs.writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), Buffer.from(rgb)]))
    fs.mkdirSync(path.dirname(path.resolve(outPng)), { recursive: true })
    const r = await run('ffmpeg', ['-y', '-v', 'error', '-i', ppm, path.resolve(outPng)])
    if (r.code !== 0) throw new Error(`ffmpeg failed writing ${outPng}:\n${r.stderr}`)
    return path.resolve(outPng)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Write a frame with one or more masks painted over it, so a failure shows WHERE.
 *
 * A red-on-the-frame overlay rather than a bare mask: the question a human asks of a
 * failing frame is "what is it touching", and a mask on its own has thrown that away.
 */
export async function writeMaskOverlayPng(
  video: DecodedVideo,
  frame: number,
  masks: Array<{ mask: Uint8Array; color: [number, number, number] }>,
  outPng: string,
): Promise<string> {
  const base = frame * video.frameBytes
  const body = Buffer.from(video.rgb.subarray(base, base + video.frameBytes))
  for (const { mask, color } of masks) {
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue
      const i = p * 3
      // Half-blend, so the page underneath stays legible next to the highlight.
      body[i] = Math.round((body[i] + color[0]) / 2)
      body[i + 1] = Math.round((body[i + 1] + color[1]) / 2)
      body[i + 2] = Math.round((body[i + 2] + color[2]) / 2)
    }
  }
  return writeRgbPng(body, video.width, video.height, outPng)
}

/**
 * Bright pixels per frame inside a rectangle given as fractions of the frame.
 *
 * KEPT ONLY for the assertions that predate the differential, and deliberately named for
 * what it does rather than for what it was once believed to mean. `> 200` on a gray
 * conversion is not "ink": it is "bright", it is hue-dependent, and on a light page it
 * matches everything. Use `overlayMask` for any new question. This is here so that the two
 * drifted copies of it — one region-aware in the input-overlay suite, one with the bottom
 * third hardcoded in the caption suite — become one function with one behaviour.
 */
export function brightPixelsPerFrame(
  video: DecodedVideo,
  region: { x0?: number; x1?: number; y0?: number; y1?: number } = {},
  threshold = 200,
): number[] {
  return lumaPixelsPerFrame(video, region, (g) => g > threshold)
}

/**
 * The same count, the other way up: pixels DARKER than `threshold`.
 *
 * Exists because the caption inverted. It used to be white text over an arbitrary page and
 * was counted as "bright"; it is now black text on a light strip, so on the strip the ink is
 * the dark minority and the background is the bright majority. Counting bright pixels there
 * measures the strip's area, which is constant, and is blind to whether any caption was
 * drawn in it at all.
 *
 * Sound only where the region is known to be uniformly light apart from the ink — i.e. the
 * caption strip, whose colour this file chooses. It is not a general "find the ink" rule any
 * more than its sibling is; for that, use the clean-plate differential.
 */
export function darkPixelsPerFrame(
  video: DecodedVideo,
  region: { x0?: number; x1?: number; y0?: number; y1?: number } = {},
  threshold = 128,
): number[] {
  return lumaPixelsPerFrame(video, region, (g) => g < threshold)
}

function lumaPixelsPerFrame(
  video: DecodedVideo,
  region: { x0?: number; x1?: number; y0?: number; y1?: number },
  keep: (luma: number) => boolean,
): number[] {
  const x0 = Math.floor(video.width * (region.x0 ?? 0))
  const x1 = Math.floor(video.width * (region.x1 ?? 1))
  const y0 = Math.floor(video.height * (region.y0 ?? 0))
  const y1 = Math.floor(video.height * (region.y1 ?? 1))
  const out: number[] = []
  for (let f = 0; f < video.frameCount; f++) {
    let n = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = f * video.frameBytes + (y * video.width + x) * 3
        const g = 0.299 * video.rgb[o] + 0.587 * video.rgb[o + 1] + 0.114 * video.rgb[o + 2]
        if (keep(g)) n++
      }
    }
    out.push(n)
  }
  return out
}
