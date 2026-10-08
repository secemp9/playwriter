/**
 * page-screenshot.ts — the `screenshot()` and `diffScreenshot()` sandbox globals: plain pictures of
 * the page taken by the browser (`Page.captureScreenshot`), cropped, compared and encoded in Node,
 * so the page is never touched.
 *
 * Why not Playwright's `page.screenshot()`: it prepares the page with its own script (a user
 * gesture) and writes `caret-color` into every text field's inline style while it shoots. Human mode
 * refuses it.
 *
 * What each capture does to the page, measured with test/fixtures/screenshot/watched.html (resize,
 * scroll, visualViewport, matchMedia, ResizeObserver, IntersectionObserver and MutationObserver
 * listeners), headless and headed Chromium, with and without an emulated viewport:
 *   - unclipped `Page.captureScreenshot` (the window as shown): no event in any setup;
 *   - with a `clip` (no captureBeyondViewport): none headless; headed WITH an emulated viewport
 *     the page got `resize`, `visualViewport.resize` and `ResizeObserver` — so a ref is cropped in
 *     Node from an unclipped capture, never clipped by Chrome;
 *   - `captureBeyondViewport: true` (full page, or an element outside the window): every setup, the
 *     window is resized to 1×1 and back while it shoots — `resize`, `visualViewport.resize`,
 *     `ResizeObserver` and `matchMedia` change, twice. When both resizes fall between
 *     two of the page's frames (measured on a loaded computer, Chromium 133 and Chrome 149 alike),
 *     it gets one `resize` (at its own size), one `visualViewport.resize` and one `matchMedia`
 *     change, and no `ResizeObserver` callback. A page can re-render, close
 *     menus or log analytics on that, so it is debug mode only; in human mode the model scrolls
 *     (act.scroll / act.scrollTo) and takes the window, the way a person looks at a long page.
 *
 * `ifChanged` compares with this tab's previous capture of the same scope (window, full page, or
 * one ref) pixel by pixel, exactly (a pixel changed when any channel differs by more than
 * `pixelTolerance`, default 0), and saves nothing when the changed share is at most `threshold`.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@xmorse/playwright-core'
import type sharpModule from 'sharp'
import type { ICDPSession } from './cdp-session.js'
import { withDeadline, type IsolatedWorld } from './isolated-world.js'
import { ALLOWED_IN_FAST_OR_DEBUG } from './code-policy.js'
import { LLM_MAX_DIMENSION, resizeImageForAgent } from './aria-snapshot.js'
import type { Observation } from './page-observe.js'
import { decodePng, encodePng, type DecodedPng } from './png-pixels.js'
import { ModelFacingError, type JsDialogState, type PolicyMode } from './probe-types.js'
import type { ScopedFS } from './scoped-fs.js'

const CDP_TIMEOUT_MS = 10000
/** A full page can be tall: Chrome rasterises all of it in one go. */
const FULL_PAGE_TIMEOUT_MS = 30000

/** What the page received while Chrome shot beyond the window (measured; see the module comment). */
export const BEYOND_VIEWPORT_EVENTS =
  'Chrome resizes the window to 1×1 and back while it shoots beyond it: measured, the page receives resize, visualViewport resize, ' +
  'ResizeObserver and matchMedia change events up to twice'

export interface ScreenshotDeps {
  policy: PolicyMode
  page: Page
  cdp: ICDPSession
  world: IsolatedWorld
  dialog: () => JsDialogState | null
  /** A fresh observation of the page (not shown to the model), for the boxes of refs. */
  observe: () => Promise<Observation>
  jail: ScopedFS
  /** Hand an image to the execute result, so the MCP client shows it to a vision model. */
  emit: (image: { data: string; mimeType: string }) => void
}

export interface ScreenshotOptions {
  path?: string
  fullPage?: boolean
  ref?: number
  ifChanged?: boolean
  threshold?: number
  pixelTolerance?: number
  format?: 'png' | 'jpeg'
  quality?: number
}

export interface ScreenshotResult {
  /** True when this capture was saved. False only with `ifChanged` when nothing changed beyond `threshold`. */
  changed: boolean
  /** Where it was saved (absent when unchanged: see `previousPath`). */
  path?: string
  previousPath?: string
  bytes?: number
  width: number
  height: number
  format: 'png' | 'jpeg'
  quality?: number
  /** Image pixels per CSS pixel (the device pixel ratio Chrome captured at). */
  cssPixelRatio: number
  /** What was captured: 'window', 'full page', or '[ref] …' with the part of it. */
  scope: string
  /** Counts saved captures of this scope on this tab. */
  revision: number
  /** Share of pixels that differ from the previous capture of this scope; null when there is none or its size differs. */
  pixelChangeRatio?: number | null
  /** Where the changed pixels are, in image pixels (absent when nothing changed). */
  changedBox?: Box | null
  note?: string
}

export interface DiffOptions {
  threshold?: number
  pixelTolerance?: number
  output?: string
  /** Compare with this image file instead of the page as it is now. */
  against?: string
  ref?: number
  fullPage?: boolean
}

export interface DiffResult {
  changed: boolean
  pixelChangeRatio: number
  changedPixels: number
  totalPixels: number
  width: number
  height: number
  changedBox: Box | null
  /** The diff image: the baseline faded to grey, changed pixels in red. */
  diffPath: string
  baselinePath: string
  /** The page capture compared with (saved next to the diff), or the `against` file. */
  comparedWith: string
  note?: string
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface Capture {
  image: DecodedPng
  /** Chrome's own PNG when the image is exactly it (not cropped), to save without re-encoding. */
  png: Buffer | null
  cssPixelRatio: number
  scope: string
  key: string
  note?: string
}

interface Previous {
  image: DecodedPng
  path: string
  revision: number
}

/** Each tab's last saved capture per scope key ('window', 'full page', 'ref:12'). */
const previousCaptures = new WeakMap<Page, Map<string, Previous>>()

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function fail(call: string, message: string): never {
  throw new ModelFacingError(`${call}: ${message} Nothing was captured.`)
}

/** The model's options object with only `allowed` keys, or a refusal naming what is wrong. */
function optionsObject(call: string, raw: unknown, allowed: readonly string[], example: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(call, `pass an options object, like ${example}.`)
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) fail(call, `unknown option${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (it takes ${allowed.join(', ')}).`)
  return Object.fromEntries(Object.entries(raw))
}

function ratioOption(call: string, name: string, value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) fail(call, `${name} is the share of pixels that may differ, a number from 0 to 1 (0.01 = 1%); got ${String(value)}.`)
  return value
}

function toleranceOption(call: string, value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    fail(call, `pixelTolerance is how much a colour channel may differ before the pixel counts as changed, an integer from 0 to 255; got ${String(value)}.`)
  }
  return value
}

function refOption(call: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) fail(call, `ref is the number of an element from observe() or find(), like { ref: 12 }; got ${String(value)}.`)
  return value
}

function parseScreenshotOptions(raw: unknown): Required<Pick<ScreenshotOptions, 'format'>> & ScreenshotOptions {
  const call = 'screenshot'
  if (raw === undefined) return { format: 'png' }
  const options = optionsObject(call, raw, ['path', 'fullPage', 'ref', 'ifChanged', 'threshold', 'pixelTolerance', 'format', 'quality'], 'screenshot({ ref: 12 })')
  const { path: target, fullPage, ifChanged, format, quality } = options
  if (target !== undefined && (typeof target !== 'string' || target === '')) fail(call, 'path is the file to save to, like { path: "shots/cart.png" }.')
  if (fullPage !== undefined && typeof fullPage !== 'boolean') fail(call, 'fullPage is true or false.')
  if (ifChanged !== undefined && typeof ifChanged !== 'boolean') fail(call, 'ifChanged is true or false.')
  const ref = refOption(call, options.ref)
  if (fullPage && ref !== undefined) fail(call, 'pass either ref (one element) or fullPage, not both.')
  if (format !== undefined && format !== 'png' && format !== 'jpeg') fail(call, `format is 'png' or 'jpeg'; got ${String(format)}.`)
  const extension = typeof target === 'string' ? path.extname(target).toLowerCase() : ''
  const fromPath = extension === '.png' ? 'png' : extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : undefined
  if (format !== undefined && fromPath !== undefined && format !== fromPath) fail(call, `path ends in ${extension} but format is '${format}'; make them agree.`)
  const chosen = format ?? fromPath ?? 'png'
  if (quality !== undefined) {
    if (chosen !== 'jpeg') fail(call, "quality applies to JPEG only: pass format: 'jpeg' (or a .jpg path) with it.")
    if (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 1 || quality > 100) fail(call, `quality is an integer from 1 to 100; got ${String(quality)}.`)
  }
  return {
    ...(typeof target === 'string' ? { path: target } : {}),
    ...(fullPage ? { fullPage } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(ifChanged ? { ifChanged } : {}),
    threshold: ratioOption(call, 'threshold', options.threshold),
    pixelTolerance: toleranceOption(call, options.pixelTolerance),
    format: chosen,
    ...(typeof quality === 'number' ? { quality } : {}),
  }
}

function parseDiffOptions(raw: unknown): DiffOptions {
  const call = 'diffScreenshot'
  if (raw === undefined) return {}
  const options = optionsObject(call, raw, ['threshold', 'pixelTolerance', 'output', 'against', 'ref', 'fullPage'], 'diffScreenshot("before.png", { threshold: 0.01 })')
  const { output, against, fullPage } = options
  if (output !== undefined && (typeof output !== 'string' || output === '')) fail(call, 'output is the file to save the diff image to, like { output: "diff.png" }.')
  if (against !== undefined && (typeof against !== 'string' || against === '')) fail(call, 'against is the path of an image file to compare with.')
  if (fullPage !== undefined && typeof fullPage !== 'boolean') fail(call, 'fullPage is true or false.')
  const ref = refOption(call, options.ref)
  if (against !== undefined && (fullPage || ref !== undefined)) fail(call, 'against compares two files; ref and fullPage choose what to capture of the page — pass one or the other.')
  if (fullPage && ref !== undefined) fail(call, 'pass either ref (one element) or fullPage, not both.')
  if (typeof output === 'string' && path.extname(output).toLowerCase() !== '.png') fail(call, 'the diff image is a PNG: give output a .png name.')
  return {
    threshold: ratioOption(call, 'threshold', options.threshold),
    pixelTolerance: toleranceOption(call, options.pixelTolerance),
    ...(typeof output === 'string' ? { output } : {}),
    ...(typeof against === 'string' ? { against } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(fullPage ? { fullPage } : {}),
  }
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

export function cropImage(image: DecodedPng, box: Box): DecodedPng {
  const { channels } = image
  const data = new Uint8Array(box.width * box.height * channels)
  for (let row = 0; row < box.height; row++) {
    const from = ((box.y + row) * image.width + box.x) * channels
    data.set(image.data.subarray(from, from + box.width * channels), row * box.width * channels)
  }
  return { width: box.width, height: box.height, channels, data }
}

export interface PixelDiff {
  changedPixels: number
  totalPixels: number
  ratio: number
  box: Box | null
  /** The baseline faded to grey with changed pixels red, RGB. */
  image: DecodedPng
}

/**
 * Pixel-by-pixel comparison of two images of the same size: a pixel changed when any colour channel
 * (and alpha, when both have it) differs by more than `tolerance`.
 */
export function diffPixels(baseline: DecodedPng, current: DecodedPng, tolerance: number): PixelDiff {
  if (baseline.width !== current.width || baseline.height !== current.height) {
    throw new Error(`sizes differ: ${baseline.width}×${baseline.height} and ${current.width}×${current.height}`)
  }
  const { width, height } = baseline
  const out = new Uint8Array(width * height * 3)
  const alpha = baseline.channels === 4 && current.channels === 4
  let changed = 0
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x
      const a = pixel * baseline.channels
      const b = pixel * current.channels
      let differs = false
      for (let c = 0; c < 3 && !differs; c++) differs = Math.abs(baseline.data[a + c] - current.data[b + c]) > tolerance
      if (!differs && alpha) differs = Math.abs(baseline.data[a + 3] - current.data[b + 3]) > tolerance
      const o = pixel * 3
      if (differs) {
        changed++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        out[o] = 255
        out[o + 1] = 0
        out[o + 2] = 0
      } else {
        const luma = 0.299 * baseline.data[a] + 0.587 * baseline.data[a + 1] + 0.114 * baseline.data[a + 2]
        const grey = Math.round(170 + luma / 3)
        out[o] = grey
        out[o + 1] = grey
        out[o + 2] = grey
      }
    }
  }
  const total = width * height
  return {
    changedPixels: changed,
    totalPixels: total,
    ratio: changed / total,
    box: changed === 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
    image: { width, height, channels: 3, data: out },
  }
}

async function loadSharp(what: string): Promise<typeof sharpModule> {
  try {
    // Dynamic: sharp is an optionalDependency (native binaries that may be absent on a platform).
    return (await import('sharp')).default
  } catch {
    throw new ModelFacingError(`${what} needs the sharp package, which is not installed here (pnpm add sharp).`)
  }
}

/** An image file as pixels: PNG through png-pixels, anything else sharp reads (JPEG, WebP). */
async function readImage(file: string, call: string): Promise<{ image: DecodedPng; lossy: boolean }> {
  const bytes = fs.readFileSync(file)
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  if (isPng) {
    try {
      return { image: decodePng(bytes), lossy: false }
    } catch {
      // Interlaced, palette, grey or 16-bit PNGs are not what Chrome writes; sharp reads them.
    }
  }
  const sharp = await loadSharp(call)
  try {
    const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return { image: { width: info.width, height: info.height, channels: 4, data: new Uint8Array(data) }, lossy: !isPng }
  } catch (error) {
    throw new ModelFacingError(`${call}: ${file} is not an image it can read (${error instanceof Error ? error.message : String(error)}).`)
  }
}

async function encode(image: DecodedPng, png: Buffer | null, format: 'png' | 'jpeg', quality: number): Promise<Buffer> {
  if (format === 'png') return png ?? encodePng(image)
  const sharp = await loadSharp('screenshot({ format: "jpeg" })')
  return await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: image.channels },
  })
    .jpeg({ quality })
    .toBuffer()
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function savePath(jail: ScopedFS, call: string, target: string | undefined, stem: string, extension: string): string {
  const wanted = target ?? path.join('tmp', `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${extension}`)
  const resolved = jail.resolveAllowed(wanted)
  if (resolved === null) {
    fail(call, `${wanted} is outside the folders this session may write to (${jail.allowedDirectories().join(', ')}). A relative path is saved in the session folder.`)
  }
  if (wanted.endsWith('/') || wanted.endsWith(path.sep) || (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())) {
    fail(call, `${wanted} is a folder; give the file name to save to inside it.`)
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  return resolved
}

function readablePath(jail: ScopedFS, call: string, file: string): string {
  const resolved = jail.resolveAllowed(file)
  if (resolved === null) throw new ModelFacingError(`${call}: ${file} is outside the folders this session may read (${jail.allowedDirectories().join(', ')}).`)
  if (!fs.existsSync(resolved)) throw new ModelFacingError(`${call}: there is no file ${resolved}. Save a baseline first: const { path } = await screenshot({ path: 'before.png' }).`)
  return resolved
}

/** Show the image to a vision model, downscaled to fit LLM_MAX_DIMENSION when larger (the file stays full size). */
async function show(deps: ScreenshotDeps, bytes: Buffer, format: 'png' | 'jpeg', width: number, height: number): Promise<string | undefined> {
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
  if (Math.max(width, height) <= LLM_MAX_DIMENSION) {
    deps.emit({ data: bytes.toString('base64'), mimeType })
    return undefined
  }
  const resized = await resizeImageForAgent({ input: bytes, format })
  deps.emit({ data: resized.buffer.toString('base64'), mimeType: resized.mimeType })
  const scale = LLM_MAX_DIMENSION / Math.max(width, height)
  return `the image shown inline is downscaled to ${Math.round(width * scale)}×${Math.round(height * scale)}; the saved file is full size`
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

interface View {
  width: number
  height: number
  pinchScale: number
  visibility: string
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

async function captureBeyond(deps: ScreenshotDeps, clip: Box, what: string): Promise<{ image: DecodedPng; png: Buffer }> {
  const shot = await withDeadline(
    deps.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } }),
    FULL_PAGE_TIMEOUT_MS,
    `capturing ${what} (Page.captureScreenshot beyond the window)`,
  )
  const png = Buffer.from(shot.data, 'base64')
  return { image: decodePng(png), png }
}

async function capture(deps: ScreenshotDeps, call: string, mode: { fullPage?: boolean; ref?: number }): Promise<Capture> {
  const dialog = deps.dialog()
  if (dialog) {
    throw new ModelFacingError(
      `${call}: a native ${dialog.type}("${dialog.message}") dialog is open and freezes the page, so Chrome cannot paint it. Answer it first ` +
        '(act.dialog.accept() or act.dialog.dismiss()), then take the screenshot. Nothing was captured.',
    )
  }
  if (mode.fullPage && deps.policy === 'human') {
    throw new ModelFacingError(
      `Refused (human mode): ${call}({ fullPage: true }) — ${BEYOND_VIEWPORT_EVENTS}, so the app can re-render, close menus or log it; a ` +
        'person never makes the page do that by looking. Take the window with screenshot(), act.scroll(\'down\') and screenshot() again; ' +
        `getPageMarkdown() reads the whole text. Full-page captures need ${ALLOWED_IN_FAST_OR_DEBUG}. It was not run.`,
    )
  }
  const [metrics, view] = await Promise.all([
    withDeadline(deps.cdp.send('Page.getLayoutMetrics'), CDP_TIMEOUT_MS, 'reading the layout metrics (Page.getLayoutMetrics)'),
    deps.world.evaluate<View>(
      '({ width: innerWidth, height: innerHeight, pinchScale: visualViewport ? visualViewport.scale : 1, visibility: document.visibilityState })',
      { what: 'reading the window size, pinch zoom and tab visibility' },
    ),
  ])
  if (view.visibility !== 'visible') {
    throw new ModelFacingError(
      `${call}: this tab is in the background (document.visibilityState is "${view.visibility}"), and Chrome paints nothing for a background tab, ` +
        'so there is no picture to take. observe() needs no pixels and works as usual; if the user wants a screenshot, ask them to switch to this tab. Nothing was captured.',
    )
  }

  if (mode.fullPage) {
    const content = metrics.cssContentSize
    const clip = { x: 0, y: 0, width: Math.ceil(content.width), height: Math.ceil(content.height) }
    const { image, png } = await captureBeyond(deps, clip, 'the full page')
    return { image, png, cssPixelRatio: image.width / clip.width, scope: 'full page', key: 'full page', note: `debug mode: ${BEYOND_VIEWPORT_EVENTS}` }
  }

  if (mode.ref === undefined) {
    const shot = await withDeadline(deps.cdp.send('Page.captureScreenshot', { format: 'png' }), CDP_TIMEOUT_MS, 'capturing the window (Page.captureScreenshot)')
    const png = Buffer.from(shot.data, 'base64')
    const image = decodePng(png)
    return { image, png, cssPixelRatio: image.width / view.width, scope: 'window', key: 'window' }
  }

  const ref = mode.ref
  if (view.pinchScale !== 1) {
    throw new ModelFacingError(
      `${call}: the page is pinch-zoomed (visualViewport.scale ${view.pinchScale}), so element boxes do not map onto the capture. screenshot() without ref ` +
        'takes the zoomed window as shown; the zoom itself has to be reset by the user. Nothing was captured.',
    )
  }
  const observation = await deps.observe()
  const element = observation.elements.find((candidate) => candidate.ref === ref)
  if (!element) {
    throw new ModelFacingError(`${call}: [${ref}] is not on this page now. observe() lists the current refs. Nothing was captured.`)
  }
  const label = `[${ref}] ${element.role}${element.name ? ` "${element.name}"` : ''}`
  if (!element.box || element.box.width <= 0 || element.box.height <= 0) {
    throw new ModelFacingError(`${call}: ${label} has no box on screen (it is not laid out: hidden, or display: none), so there is nothing to picture. Nothing was captured.`)
  }
  const box = element.box
  const layout = metrics.cssLayoutViewport
  const inWindow = { x: box.x - layout.pageX, y: box.y - layout.pageY, width: box.width, height: box.height }
  const visible = intersect(inWindow, { x: 0, y: 0, width: view.width, height: view.height })
  if (!visible) {
    if (deps.policy === 'human') {
      const where =
        inWindow.y >= view.height ? `${Math.round(inWindow.y - view.height)}px below the window` :
        inWindow.y + inWindow.height <= 0 ? `${Math.round(-(inWindow.y + inWindow.height))}px above the window` :
        inWindow.x >= view.width ? 'to the right of the window' : 'to the left of the window'
      throw new ModelFacingError(
        `${call}: ${label} is outside the window (${where}), and a picture of it would need Chrome to shoot beyond the window, which resizes ` +
          `the page while it shoots. Bring it into view first with act.scrollTo(${ref}), then screenshot({ ref: ${ref} }) again. Nothing was captured.`,
      )
    }
    const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) }
    const { image, png } = await captureBeyond(deps, clip, label)
    return { image, png, cssPixelRatio: image.width / clip.width, scope: `${label} (outside the window)`, key: `ref:${ref}`, note: `debug mode: ${BEYOND_VIEWPORT_EVENTS}` }
  }
  const shot = await withDeadline(deps.cdp.send('Page.captureScreenshot', { format: 'png' }), CDP_TIMEOUT_MS, `capturing the window for ${label} (Page.captureScreenshot)`)
  const after = await withDeadline(deps.cdp.send('Page.getLayoutMetrics'), CDP_TIMEOUT_MS, 'reading the layout metrics (Page.getLayoutMetrics)')
  if (after.cssLayoutViewport.pageX !== layout.pageX || after.cssLayoutViewport.pageY !== layout.pageY) {
    throw new ModelFacingError(`${call}: the page scrolled while ${label} was being captured, so its box no longer matches the picture. Call it again. Nothing was captured.`)
  }
  const full = decodePng(Buffer.from(shot.data, 'base64'))
  const scale = full.width / view.width
  const x = Math.max(0, Math.floor(visible.x * scale))
  const y = Math.max(0, Math.floor(visible.y * scale))
  const cropBox = {
    x,
    y,
    width: Math.min(full.width, Math.ceil((visible.x + visible.width) * scale)) - x,
    height: Math.min(full.height, Math.ceil((visible.y + visible.height) * scale)) - y,
  }
  const whole = visible.width === inWindow.width && visible.height === inWindow.height
  return {
    image: cropImage(full, cropBox),
    png: null,
    cssPixelRatio: scale,
    scope: label,
    key: `ref:${ref}`,
    ...(whole
      ? {}
      : {
          note:
            `only the part of ${label} inside the window is pictured (${Math.round(visible.width)}×${Math.round(visible.height)} of ` +
            `${Math.round(box.width)}×${Math.round(box.height)} CSS px); act.scrollTo(${ref}) brings more of it into view`,
        }),
  }
}

// ---------------------------------------------------------------------------
// The globals
// ---------------------------------------------------------------------------

export async function takeScreenshot(rawOptions: unknown, deps: ScreenshotDeps): Promise<ScreenshotResult> {
  const options = parseScreenshotOptions(rawOptions)
  const shot = await capture(deps, 'screenshot', { ...(options.fullPage ? { fullPage: true } : {}), ...(options.ref !== undefined ? { ref: options.ref } : {}) })
  let byScope = previousCaptures.get(deps.page)
  if (!byScope) {
    byScope = new Map()
    previousCaptures.set(deps.page, byScope)
  }
  const previous = byScope.get(shot.key)
  const notes = shot.note ? [shot.note] : []
  let pixelChangeRatio: number | null | undefined
  let changedBox: Box | null | undefined
  if (previous) {
    if (previous.image.width === shot.image.width && previous.image.height === shot.image.height) {
      const diff = diffPixels(previous.image, shot.image, options.pixelTolerance ?? 0)
      pixelChangeRatio = diff.ratio
      changedBox = diff.box
    } else {
      pixelChangeRatio = null
      notes.push(`its size changed from ${previous.image.width}×${previous.image.height} to ${shot.image.width}×${shot.image.height} since revision ${previous.revision}`)
    }
  } else if (options.ifChanged) {
    pixelChangeRatio = null
    notes.push(`no earlier capture of ${shot.scope} on this tab to compare with`)
  }
  const base = { width: shot.image.width, height: shot.image.height, format: options.format, cssPixelRatio: shot.cssPixelRatio, scope: shot.scope }
  if (options.ifChanged && previous && typeof pixelChangeRatio === 'number' && pixelChangeRatio <= (options.threshold ?? 0)) {
    return {
      changed: false,
      ...base,
      previousPath: previous.path,
      revision: previous.revision,
      pixelChangeRatio,
      changedBox: changedBox ?? null,
      note: [`unchanged beyond threshold ${options.threshold ?? 0} since revision ${previous.revision}: nothing saved or shown`, ...notes].join('; '),
    }
  }
  const quality = options.format === 'jpeg' ? (options.quality ?? 80) : undefined
  const bytes = await encode(shot.image, shot.png, options.format, quality ?? 0)
  const file = savePath(deps.jail, 'screenshot', options.path, 'screenshot', options.format === 'png' ? 'png' : 'jpg')
  fs.writeFileSync(file, bytes)
  const revision = (previous?.revision ?? 0) + 1
  byScope.set(shot.key, { image: shot.image, path: file, revision })
  const shown = await show(deps, bytes, options.format, shot.image.width, shot.image.height)
  if (shown) notes.push(shown)
  return {
    changed: true,
    path: file,
    bytes: bytes.length,
    ...base,
    ...(quality !== undefined ? { quality } : {}),
    revision,
    ...(pixelChangeRatio !== undefined ? { pixelChangeRatio } : {}),
    ...(changedBox !== undefined ? { changedBox } : {}),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  }
}

export async function diffScreenshot(baselinePath: unknown, rawOptions: unknown, deps: ScreenshotDeps): Promise<DiffResult> {
  const call = 'diffScreenshot'
  if (typeof baselinePath !== 'string' || baselinePath === '') {
    fail(call, 'its first argument is the path of the baseline image, like diffScreenshot("before.png") after screenshot({ path: "before.png" }).')
  }
  const options = parseDiffOptions(rawOptions)
  const baselineFile = readablePath(deps.jail, call, baselinePath)
  const baseline = await readImage(baselineFile, call)
  const notes: string[] = []
  let current: DecodedPng
  let comparedWith: string
  if (options.against !== undefined) {
    const againstFile = readablePath(deps.jail, call, options.against)
    const read = await readImage(againstFile, call)
    if (read.lossy) notes.push(`${options.against} is lossy (JPEG/WebP): compression alone changes pixels; raise pixelTolerance to ignore it`)
    current = read.image
    comparedWith = againstFile
  } else {
    const shot = await capture(deps, call, { ...(options.fullPage ? { fullPage: true } : {}), ...(options.ref !== undefined ? { ref: options.ref } : {}) })
    if (shot.note) notes.push(shot.note)
    current = shot.image
    comparedWith = savePath(deps.jail, call, undefined, 'screenshot', 'png')
    fs.writeFileSync(comparedWith, shot.png ?? encodePng(shot.image))
  }
  if (baseline.lossy) notes.push(`${baselinePath} is lossy (JPEG/WebP): compression alone changes pixels; raise pixelTolerance to ignore it, or save baselines as PNG`)
  if (baseline.image.width !== current.width || baseline.image.height !== current.height) {
    throw new ModelFacingError(
      `${call}: the baseline is ${baseline.image.width}×${baseline.image.height} px and ${options.against === undefined ? 'the page capture' : options.against} is ` +
        `${current.width}×${current.height} px; a pixel diff needs the same size. Capture both the same way (same window size, same ref or fullPage) — ` +
        `the capture was saved at ${comparedWith}. No diff was made.`,
    )
  }
  const diff = diffPixels(baseline.image, current, options.pixelTolerance ?? 0)
  const diffPath = savePath(deps.jail, call, options.output, 'diff', 'png')
  const png = encodePng(diff.image)
  fs.writeFileSync(diffPath, png)
  const shown = await show(deps, png, 'png', diff.image.width, diff.image.height)
  if (shown) notes.push(shown)
  return {
    changed: diff.ratio > (options.threshold ?? 0),
    pixelChangeRatio: diff.ratio,
    changedPixels: diff.changedPixels,
    totalPixels: diff.totalPixels,
    width: diff.image.width,
    height: diff.image.height,
    changedBox: diff.box,
    diffPath,
    baselinePath: baselineFile,
    comparedWith,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  }
}
