/**
 * labelled-screenshot.ts — a viewport screenshot with every listed element's `observe()` ref
 * drawn onto it, composed in Node so the page is never touched.
 *
 * The page is captured once with `Page.captureScreenshot` and no `clip`: a clipped capture
 * makes Chrome temporarily override the emulated viewport, which was measured to corrupt
 * captures running at the same time. The PNG is decoded (`png-pixels.ts`), resampled to CSS
 * pixels so image coordinates are the coordinates an agent clicks at (capped at
 * LLM_MAX_DIMENSION on the longer side), and each ref is painted as an opaque, role-coloured
 * box with a built-in bitmap font at its element's top-left corner. No image library, no DOM
 * overlay, no injected script.
 *
 * Elements and boxes come from an `Observation` (page-observe.ts), so the labels are exactly the
 * `[N]` refs `observe()` prints and `act.*` accepts.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ICDPSession } from './cdp-session.js'
import { IsolatedWorld, withDeadline } from './isolated-world.js'
import { LLM_MAX_DIMENSION } from './aria-snapshot.js'
import { renderObservation, type Observation, type ObservedElement } from './page-observe.js'
import { decodePng, encodePng, type DecodedPng } from './png-pixels.js'
import { ModelFacingError } from './probe-types.js'

const CDP_TIMEOUT_MS = 10000

export interface ScreenshotResult {
  path: string
  base64: string
  mimeType: 'image/png'
  /** `renderObservation` text of the observation the labels came from. */
  snapshot: string
  labelCount: number
}

/** A label as drawn, in image pixels. */
export interface DrawnLabel {
  ref: number
  role: string
  name: string
  x: number
  y: number
  width: number
  height: number
}

export interface LabelledScreenshot {
  /** RGB PNG, `width`×`height`. */
  png: Buffer
  width: number
  height: number
  /** Image pixels per CSS pixel: 1 unless the viewport was larger than LLM_MAX_DIMENSION. */
  scale: number
  labels: DrawnLabel[]
}

/** What the capture shows, in CSS px: the window's scroll offset and its size. */
export interface CapturedViewport {
  scrollX: number
  scrollY: number
  /** `innerWidth` / `innerHeight`: the window including classic scrollbars, as the capture is. */
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// Colours and glyphs
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number]

function hex(value: string): Rgb {
  const n = Number.parseInt(value.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** [fill, border] per role. */
const ROLE_COLORS: Record<string, readonly [Rgb, Rgb]> = {
  link: [hex('#FFC542'), hex('#E3BE23')],
  button: [hex('#FFCC80'), hex('#FFB74D')],
  textbox: [hex('#EF9A9A'), hex('#E57373')],
  combobox: [hex('#F48FB1'), hex('#F06292')],
  searchbox: [hex('#F48FB1'), hex('#F06292')],
  listbox: [hex('#F48FB1'), hex('#F06292')],
  checkbox: [hex('#A5D6A7'), hex('#81C784')],
  radio: [hex('#A5D6A7'), hex('#81C784')],
  slider: [hex('#90CAF9'), hex('#64B5F6')],
  spinbutton: [hex('#90CAF9'), hex('#64B5F6')],
  switch: [hex('#B39DDB'), hex('#9575CD')],
  menuitem: [hex('#FFCC80'), hex('#FFB74D')],
  menuitemcheckbox: [hex('#FFCC80'), hex('#FFB74D')],
  menuitemradio: [hex('#FFCC80'), hex('#FFB74D')],
  option: [hex('#FFCC80'), hex('#FFB74D')],
  tab: [hex('#FFCC80'), hex('#FFB74D')],
  treeitem: [hex('#FFCC80'), hex('#FFB74D')],
  img: [hex('#81D4FA'), hex('#4FC3F7')],
  image: [hex('#81D4FA'), hex('#4FC3F7')],
  video: [hex('#81D4FA'), hex('#4FC3F7')],
  audio: [hex('#81D4FA'), hex('#4FC3F7')],
}

const DEFAULT_COLORS: readonly [Rgb, Rgb] = [hex('#FFF59D'), hex('#FFEB3B')]

const TEXT_COLOR: Rgb = [0, 0, 0]

export function labelColors(role: string): { fill: Rgb; border: Rgb } {
  const [fill, border] = ROLE_COLORS[role] ?? DEFAULT_COLORS
  return { fill, border }
}

/** 5×7 bitmap glyphs: the characters of a `[N]` ref label. */
const GLYPHS: Record<string, readonly string[]> = {
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  '3': ['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### '],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  '5': ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  '6': ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  '8': [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  '9': [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
  '[': [' ### ', ' #   ', ' #   ', ' #   ', ' #   ', ' #   ', ' ### '],
  ']': [' ### ', '   # ', '   # ', '   # ', '   # ', '   # ', ' ### '],
}

const GLYPH_W = 5
const GLYPH_H = 7
/** Each glyph pixel is a FONT_SCALE×FONT_SCALE block: 10×14 px characters. */
const FONT_SCALE = 2
const ADVANCE = (GLYPH_W + 1) * FONT_SCALE
const PAD_X = 3
const PAD_Y = 2
const BORDER = 1

export function labelSize(text: string): { width: number; height: number } {
  return {
    width: 2 * (BORDER + PAD_X) + text.length * ADVANCE - FONT_SCALE,
    height: 2 * (BORDER + PAD_Y) + GLYPH_H * FONT_SCALE,
  }
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/** Area-average resample to `width`×`height`, RGB out (screenshots are opaque). */
function resample(source: DecodedPng, width: number, height: number): DecodedPng {
  const { channels } = source
  const out = new Uint8Array(width * height * 3)
  const sx = source.width / width
  const sy = source.height / height
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.min(source.height, Math.floor((y + 1) * sy)))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.min(source.width, Math.floor((x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      for (let yy = y0; yy < y1; yy++) {
        let at = (yy * source.width + x0) * channels
        for (let xx = x0; xx < x1; xx++, at += channels) {
          r += source.data[at]
          g += source.data[at + 1]
          b += source.data[at + 2]
        }
      }
      const count = (y1 - y0) * (x1 - x0)
      const target = (y * width + x) * 3
      out[target] = Math.round(r / count)
      out[target + 1] = Math.round(g / count)
      out[target + 2] = Math.round(b / count)
    }
  }
  return { width, height, channels: 3, data: out }
}

function fillRect(image: DecodedPng, x: number, y: number, width: number, height: number, color: Rgb): void {
  const left = Math.max(0, x)
  const top = Math.max(0, y)
  const right = Math.min(image.width, x + width)
  const bottom = Math.min(image.height, y + height)
  for (let row = top; row < bottom; row++) {
    for (let col = left; col < right; col++) {
      const at = (row * image.width + col) * image.channels
      image.data[at] = color[0]
      image.data[at + 1] = color[1]
      image.data[at + 2] = color[2]
    }
  }
}

function paintLabel(image: DecodedPng, label: DrawnLabel, text: string): void {
  const { fill, border } = labelColors(label.role)
  fillRect(image, label.x, label.y, label.width, label.height, border)
  fillRect(image, label.x + BORDER, label.y + BORDER, label.width - 2 * BORDER, label.height - 2 * BORDER, fill)
  let penX = label.x + BORDER + PAD_X
  const penY = label.y + BORDER + PAD_Y
  for (const char of text) {
    const glyph = GLYPHS[char]
    if (!glyph) throw new Error(`labelled screenshot: no glyph for ${JSON.stringify(char)} in label "${text}"`)
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (glyph[gy][gx] !== '#') continue
        fillRect(image, penX + gx * FONT_SCALE, penY + gy * FONT_SCALE, FONT_SCALE, FONT_SCALE, TEXT_COLOR)
      }
    }
    penX += ADVANCE
  }
}

/**
 * Place each label at its element's top-left (clamped into the image). A label that would cover
 * one already placed moves right past it, then down a row, so nested elements that share a corner
 * keep readable labels; only when no free spot is left in the image does it go back to the corner
 * and cover what is there.
 */
function placeLabel(placed: DrawnLabel[], wanted: DrawnLabel, imageWidth: number, imageHeight: number): DrawnLabel {
  const startX = Math.min(Math.max(0, wanted.x), Math.max(0, imageWidth - wanted.width))
  const startY = Math.min(Math.max(0, wanted.y), Math.max(0, imageHeight - wanted.height))
  const candidate = { ...wanted, x: startX, y: startY }
  while (candidate.y + candidate.height <= imageHeight) {
    const blocker = placed.find(
      (other) =>
        candidate.x < other.x + other.width &&
        candidate.x + candidate.width > other.x &&
        candidate.y < other.y + other.height &&
        candidate.y + candidate.height > other.y,
    )
    if (!blocker) return candidate
    candidate.x = blocker.x + blocker.width + 1
    if (candidate.x + candidate.width > imageWidth) {
      candidate.x = startX
      candidate.y = blocker.y + blocker.height + 1
    }
  }
  return { ...wanted, x: startX, y: startY }
}

/**
 * Draw `elements`' ref labels onto a screenshot. Pure: `screenshot` is the PNG Chrome captured of
 * `viewport`; elements carry document CSS px boxes. Only elements drawn on screen are labelled
 * (`in-view` / `partly-covered`); a `covered` element's corner shows whatever covers it.
 *
 * The capture is mapped to CSS pixels by its own size against the window's, never by
 * `devicePixelRatio`: on a Chromium with 1.25 OS scaling, `devicePixelRatio` read 1.25 while
 * `Page.captureScreenshot` returned a 1× image (1365×768 for a 1365×768 CSS window). Headless
 * Chromium could not be made to show that mismatch (its captures follow the forced scale factor),
 * so the tests cover fractional and 2× ratios where the two agree.
 */
export function drawRefLabels({
  screenshot,
  viewport,
  elements,
  maxDimension = LLM_MAX_DIMENSION,
}: {
  screenshot: Uint8Array
  viewport: CapturedViewport
  elements: ObservedElement[]
  maxDimension?: number
}): LabelledScreenshot {
  const captured = decodePng(screenshot)
  const scale = Math.min(1, maxDimension / Math.max(viewport.width, viewport.height))
  const width = Math.max(1, Math.round(viewport.width * scale))
  const height = Math.max(1, Math.round(viewport.height * scale))
  const image = resample(captured, width, height)

  const labels: DrawnLabel[] = []
  for (const element of elements) {
    if (!element.box || (element.visibility !== 'in-view' && element.visibility !== 'partly-covered')) continue
    const text = `[${element.ref}]`
    const size = labelSize(text)
    const wanted: DrawnLabel = {
      ref: element.ref,
      role: element.role,
      name: element.name,
      x: Math.round((element.box.x - viewport.scrollX) * scale),
      y: Math.round((element.box.y - viewport.scrollY) * scale),
      ...size,
    }
    const label = placeLabel(labels, wanted, width, height)
    paintLabel(image, label, text)
    labels.push(label)
  }
  return { png: encodePng(image), width, height, scale, labels }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** The elements a scope keeps, with the same rule and refusal as `renderObservation`. */
function scopedElements(observation: Observation, scope: number | undefined): ObservedElement[] {
  if (scope === undefined) return observation.elements
  if (!observation.elements.some((e) => e.ref === scope) && observation.modal?.ref !== scope) {
    throw new ModelFacingError(
      `SCOPE [${scope}] is not on this page (call observe() without scope to see current refs)`,
    )
  }
  return observation.elements.filter((e) => e.ref === scope || e.inside?.includes(scope))
}

/**
 * Capture the viewport and draw `observation`'s refs on it. `cdp` / `world` are the page's probe
 * session and isolated world (`PageProbes.get(page)`); `observation` must be of the page as it is
 * now — a navigation or scroll since then is refused rather than drawn at stale positions.
 */
export async function renderLabelledScreenshot({
  cdp,
  world,
  observation,
  scope,
}: {
  cdp: ICDPSession
  world: IsolatedWorld
  observation: Observation
  scope?: number
}): Promise<LabelledScreenshot> {
  const elements = scopedElements(observation, scope)
  // A native dialog freezes the renderer: the observation then carries no scroll or boxes, and a
  // capture would block until the dialog is answered.
  const scrolledTo = observation.scroll?.y
  if (scrolledTo === undefined) {
    throw new ModelFacingError(
      'A native dialog is open and freezes the page, so there is nothing to draw labels on. Answer it first (act.dialog.accept() or act.dialog.dismiss()), then observe again.',
    )
  }
  const [frameTree, metrics, view] = await Promise.all([
    withDeadline(cdp.send('Page.getFrameTree'), CDP_TIMEOUT_MS, 'reading the frame tree (Page.getFrameTree)'),
    withDeadline(
      cdp.send('Page.getLayoutMetrics'),
      CDP_TIMEOUT_MS,
      'reading the layout metrics (Page.getLayoutMetrics)',
    ),
    world.evaluate<{ width: number; height: number; pinchScale: number; visibility: string }>(
      '({ width: innerWidth, height: innerHeight, pinchScale: visualViewport ? visualViewport.scale : 1, visibility: document.visibilityState })',
      { what: 'reading the window size, pinch zoom and tab visibility' },
    ),
  ])
  if (frameTree.frameTree.frame.loaderId !== observation.documentId) {
    throw new ModelFacingError(
      'The page navigated since this observation was taken, so its refs and boxes describe a document that is gone. Observe again, then take the labelled screenshot.',
    )
  }
  // Same source as the observation's `scroll.y`, so equality is exact.
  const layout = metrics.cssLayoutViewport
  if (layout.pageY !== scrolledTo) {
    throw new ModelFacingError(
      `The page scrolled since this observation was taken (y ${scrolledTo} then, ${layout.pageY} now), so the labels would sit at stale positions. Observe again, then take the labelled screenshot.`,
    )
  }
  if (view.visibility !== 'visible') {
    throw new ModelFacingError(
      `This tab is in the background (document.visibilityState is "${view.visibility}"), and Chrome paints nothing for a background tab, so there is no picture to take. observe() needs no pixels and works as usual; if the user wants a screenshot, ask them to switch to this tab.`,
    )
  }
  if (view.pinchScale !== 1) {
    throw new ModelFacingError(
      `The page is pinch-zoomed (visualViewport.scale ${view.pinchScale}), so a capture shows only the zoomed-in part of the window and the labels cannot be placed on it. observe() works as usual; for a labelled screenshot the zoom has to be reset by the user.`,
    )
  }
  const shot = await withDeadline(
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    CDP_TIMEOUT_MS,
    'capturing the viewport (Page.captureScreenshot)',
  )
  return drawRefLabels({
    screenshot: Buffer.from(shot.data, 'base64'),
    viewport: { scrollX: layout.pageX, scrollY: layout.pageY, width: view.width, height: view.height },
    elements,
  })
}

/**
 * The `screenshotWithAccessibilityLabels` global's body: render, save under ./tmp, and hand the
 * image plus the observation text to the execute collector.
 */
export async function screenshotWithAccessibilityLabels({
  cdp,
  world,
  observation,
  scope,
  collector,
}: {
  cdp: ICDPSession
  world: IsolatedWorld
  observation: Observation
  scope?: number
  collector: ScreenshotResult[]
}): Promise<LabelledScreenshot> {
  const shot = await renderLabelledScreenshot({ cdp, world, observation, scope })
  const tmpDir = path.join(process.cwd(), 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const screenshotPath = path.join(
    tmpDir,
    `playwriter-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`,
  )
  fs.writeFileSync(screenshotPath, shot.png)
  collector.push({
    path: screenshotPath,
    base64: shot.png.toString('base64'),
    mimeType: 'image/png',
    snapshot: renderObservation(observation, { scope }),
    labelCount: shot.labels.length,
  })
  return shot
}
