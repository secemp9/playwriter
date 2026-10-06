/**
 * The recorder draws the pointer from the pointer track into the video — and the page under
 * test never gains a cursor element, a global, or a listener for it.
 *
 * Plain headless Chromium over direct CDP (the recorder is the same code through the
 * extension). The page is a flat colour and never repaints while the pointer moves, which is
 * the hard case: the screencast sends one or two frames, so the pointer can only follow the
 * path because the encoder resamples to the output rate before libass draws.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, Page } from '@xmorse/playwright-core'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'
import { PlaywrightCDPSessionAdapter } from './cdp-session.js'
import { startCdpScreencast, type CdpScreencastOptions } from './cdp-screencast.js'
import { createHumanMouseApi } from './human-mouse-driver.js'
import { pointerTrackFor } from './pointer-track.js'
import { openVideo, type DecodedVideo } from './video-probe.js'

/**
 * A real session whose screencast never delivers a frame — what the extension path does on
 * a page that never repaints. Every command still reaches Chrome.
 */
class ScreencastSilentSession extends PlaywrightCDPSessionAdapter {
  override on<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    return event === 'Page.screencastFrame' ? this : super.on(event, callback)
  }
}

const BACKGROUND = [232, 224, 200] as const // #E8E0C8
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>pointer fixture</title>
<style>html,body{margin:0;height:100%;background:#E8E0C8}</style></head><body></body></html>`

let browser: Browser
let server: http.Server
let baseUrl: string
let tmpRoot: string

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({ headless: true })
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-pointer-rec-'))
}, 120000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((r) => server?.close(() => r()))
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** What the page's own realm can observe about itself. */
async function pageFootprint(page: Page): Promise<{ elements: number; globals: string[] }> {
  return page.evaluate(() => ({
    elements: document.querySelectorAll('*').length,
    globals: Object.getOwnPropertyNames(globalThis).sort(),
  }))
}

/** Pixels in a box that are clearly not the page background, and their bounding box. */
function inkAround(video: DecodedVideo, frame: number, box: { x0: number; y0: number; x1: number; y1: number }) {
  let count = 0
  let dark = 0
  let blue = 0
  let minX = Infinity
  let minY = Infinity
  for (let y = Math.max(0, box.y0); y <= Math.min(video.height - 1, box.y1); y++) {
    for (let x = Math.max(0, box.x0); x <= Math.min(video.width - 1, box.x1); x++) {
      const [r, g, b] = video.pixel(frame, x, y)
      const distance = Math.max(Math.abs(r - BACKGROUND[0]), Math.abs(g - BACKGROUND[1]), Math.abs(b - BACKGROUND[2]))
      if (distance < 60) continue
      count++
      if (r + g + b < 150) dark++
      if (b > 150 && r < 120) blue++
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
    }
  }
  return { count, dark, blue, minX, minY }
}

describe('pointer layer in a CDP recording', () => {
  it('draws the dispatched pointer path and press into the video without touching the page', async () => {
    const context = await browser.newContext({ viewport: { width: 640, height: 400 } })
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const humanMouse = createHumanMouseApi({
      defaultPage: page,
      getCdpSession: async ({ page: target }) => new PlaywrightCDPSessionAdapter(await context.newCDPSession(target)),
    })

    const before = await pageFootprint(page)
    const outputPath = path.join(tmpRoot, 'pointer.mp4')

    const recordingStart = Date.now()
    const handle = await startCdpScreencast({ cdp, page, outputPath, fps: 10, mode: 'screencast' })
    await page.mouse.move(80, 80)
    const parkedAt = Date.now()
    await page.waitForTimeout(800)
    // A scripted human path, dispatched as raw CDP input and recorded on the track.
    const move = await humanMouse.moveTo({ page, from: { x: 80, y: 80 }, x: 480, y: 280, seed: 7, includeTrajectory: true })
    const arrivedAt = Date.now()
    await page.waitForTimeout(800)
    const clickAt = Date.now()
    await page.mouse.click(480, 280)
    await page.waitForTimeout(800)
    const result = await handle.stop()

    expect(move.ghostCursor.playing).toBe(false)
    expect(result.wrote).toBe(true)
    expect(result.pointer?.drawn).toBe(true)
    expect(result.pointer?.pulses).toBeGreaterThanOrEqual(2)
    expect(result.pointer?.samples).toBeGreaterThan(10)

    // The page never got anything: same elements, same globals, the click still landed.
    const after = await pageFootprint(page)
    expect(after.elements).toBe(before.elements)
    expect(after.globals).toEqual(before.globals)
    expect(after.globals.filter((k) => /playwriter/i.test(k))).toEqual([])

    const video = await openVideo(outputPath)
    expect(video.width).toBe(640)
    expect(video.height).toBe(400)
    const frameAt = (epochMs: number) =>
      Math.min(video.frameCount - 1, Math.round((epochMs - recordingStart - (result.videoStartOffsetMs ?? 0)) / 100))

    // Parked at (80, 80): the arrow's tip is there, and nothing is at the later target.
    const parked = frameAt(parkedAt + 400)
    const atStart = inkAround(video, parked, { x0: 70, y0: 70, x1: 110, y1: 115 })
    expect(atStart.dark).toBeGreaterThan(20)
    expect(Math.abs(atStart.minX - 80)).toBeLessThanOrEqual(3)
    expect(Math.abs(atStart.minY - 80)).toBeLessThanOrEqual(3)
    expect(inkAround(video, parked, { x0: 470, y0: 270, x1: 470 + 30, y1: 270 + 35 }).dark).toBe(0)

    // After the human path: the tip sits on (480, 280).
    const arrived = frameAt(arrivedAt + 400)
    const atTarget = inkAround(video, arrived, { x0: 474, y0: 274, x1: 474 + 30, y1: 274 + 35 })
    expect(atTarget.dark).toBeGreaterThan(20)
    expect(inkAround(video, arrived, { x0: 70, y0: 70, x1: 110, y1: 115 }).count).toBe(0)

    // While the path ran, the tip is drawn at intermediate positions that lie ON the
    // dispatched trajectory — it followed the path rather than jumping to the end.
    const samples = move.trajectory!.samples
    const intermediate: Array<{ x: number; y: number }> = []
    for (let f = frameAt(arrivedAt - move.achievedDurationMs); f <= frameAt(arrivedAt); f++) {
      const whole = inkAround(video, f, { x0: 0, y0: 0, x1: 639, y1: 399 })
      if (whole.dark < 20) continue
      const tip = { x: whole.minX, y: whole.minY }
      const atAnEnd = [{ x: 80, y: 80 }, { x: 480, y: 280 }].some((p) => Math.hypot(tip.x - p.x, tip.y - p.y) < 6)
      if (!atAnEnd) intermediate.push(tip)
    }
    expect(intermediate.length).toBeGreaterThan(0)
    for (const tip of intermediate) {
      const nearest = Math.min(...samples.map((s) => Math.hypot(tip.x - s.x, tip.y - s.y)))
      expect(nearest).toBeLessThan(6)
    }

    // The press ring: blue ink around the tip shortly after the click.
    const pressed = frameAt(clickAt + 150)
    expect(inkAround(video, pressed, { x0: 440, y0: 240, x1: 520, y1: 320 }).blue).toBeGreaterThan(10)

    await context.close()
  }, 120000)

  it('draws nothing when the pointer is turned off', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 200 } })
    const page = await context.newPage()
    await page.goto(baseUrl)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const outputPath = path.join(tmpRoot, 'no-pointer.mp4')
    const handle = await startCdpScreencast({ cdp, page, outputPath, fps: 10, mode: 'screencast', pointer: false })
    await page.mouse.move(60, 60)
    await page.waitForTimeout(500)
    const result = await handle.stop()
    expect(result.pointer).toBeUndefined()
    const video = await openVideo(outputPath)
    expect(inkAround(video, video.frameCount - 1, { x0: 50, y0: 50, x1: 90, y1: 95 }).count).toBe(0)
    await context.close()
  }, 60000)

  it('records a static page in a background tab at full length by default, without foregrounding it', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 200 } })
    const page = await context.newPage()
    await page.goto(baseUrl)
    // The executor gives every page its track when it attaches; do the same before moving.
    pointerTrackFor(page)
    await page.mouse.move(60, 60)
    // Another tab in front: the recorded one is in the background for the whole recording.
    const front = await context.newPage()
    await front.bringToFront()

    const session = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const sends = vi.spyOn(session, 'send')
    const bringToFront = vi.spyOn(page, 'bringToFront')
    const outputPath = path.join(tmpRoot, 'background-static.mp4')
    const requestedMs = 2000
    // No mode: the default is under test.
    const handle = await startCdpScreencast({ cdp: session, page, outputPath, fps: 10 })
    // Real time on purpose: the clip's length is the property under test.
    await page.waitForTimeout(requestedMs / 2)
    await page.mouse.move(200, 120)
    await page.waitForTimeout(requestedMs / 2)
    const result = await handle.stop()

    expect(bringToFront).not.toHaveBeenCalled()
    expect(sends.mock.calls.map(([method]) => method)).not.toContain('Page.bringToFront')
    expect(result.mode).toBe('screencast')
    expect(result.wrote).toBe(true)
    expect(result.pointer?.drawn).toBe(true)

    // Constant rate, and as long as the recording: the last frame is held to the end.
    const video = await openVideo(outputPath)
    expect(result.durationMs).toBeGreaterThanOrEqual(requestedMs)
    expect(result.videoDurationMs).toBeGreaterThanOrEqual(requestedMs - 300)
    // Within one output frame (100ms at 10fps) of the recorded length: the grid quantises it.
    expect(video.frameCount * 100).toBeGreaterThanOrEqual(result.videoDurationMs! - 100)
    expect(video.frameCount * 100).toBeLessThanOrEqual(result.videoDurationMs! + 1000)

    // The pointer is drawn on the held frames: at the first position early, the second late.
    const early = inkAround(video, 2, { x0: 50, y0: 50, x1: 90, y1: 95 })
    expect(early.dark).toBeGreaterThan(20)
    const late = inkAround(video, video.frameCount - 1, { x0: 190, y0: 110, x1: 230, y1: 155 })
    expect(late.dark).toBeGreaterThan(20)
    expect(inkAround(video, video.frameCount - 1, { x0: 50, y0: 50, x1: 90, y1: 95 }).count).toBe(0)
    await context.close()
  }, 60000)

  it('seeds a visible static page with one start-time frame when the screencast sends nothing', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 200 } })
    const page = await context.newPage()
    await page.goto(baseUrl)
    pointerTrackFor(page)
    await page.mouse.move(60, 60)
    // The extension path on a page that never repaints: no screencast frame ever arrives.
    const session = new ScreencastSilentSession(await context.newCDPSession(page))
    const sends = vi.spyOn(session, 'send')
    const bringToFront = vi.spyOn(page, 'bringToFront')
    const outputPath = path.join(tmpRoot, 'seeded-static.mp4')
    const requestedMs = 1500
    const handle = await startCdpScreencast({ cdp: session, page, outputPath, fps: 10 })
    // The seed is in place before start() returns.
    expect(handle.frameCount()).toBe(1)
    // Real time on purpose: the clip's length is the property under test.
    await page.waitForTimeout(requestedMs)
    const result = await handle.stop()

    const methods = sends.mock.calls.map(([method]) => method)
    expect(methods.filter((m) => m === 'Page.captureScreenshot')).toHaveLength(1)
    expect(methods).not.toContain('Page.bringToFront')
    expect(bringToFront).not.toHaveBeenCalled()
    expect(result.frames).toBe(1)
    expect(result.wrote).toBe(true)
    expect(result.note).toBeUndefined()
    // Video time 0 is the seed, stamped at start: the clip is the whole recording.
    expect(result.videoStartOffsetMs).toBeLessThan(200)
    const video = await openVideo(outputPath)
    expect(video.frameCount * 100).toBeGreaterThanOrEqual(result.videoDurationMs! - 100)
    expect(result.pointer?.drawn).toBe(true)
    expect(inkAround(video, video.frameCount - 1, { x0: 50, y0: 50, x1: 90, y1: 95 }).dark).toBeGreaterThan(20)
    await context.close()
  }, 60000)

  it('refuses the removed auto mode instead of reading it as screencast', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 200 } })
    const page = await context.newPage()
    const session = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    // Deliberately outside the type: this is what an untyped sandbox caller can still send.
    const options = { cdp: session, outputPath: path.join(tmpRoot, 'auto.mp4'), mode: 'auto' } as unknown as CdpScreencastOptions
    await expect(startCdpScreencast(options)).rejects.toThrow(/Unknown recording mode "auto"/)
    await context.close()
  }, 30000)
})
