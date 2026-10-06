/**
 * The tabCapture recorder (`recording.start/stop`) against a live headless Chromium page.
 *
 * The extension cannot run here, so the relay is a local HTTP stand-in that answers
 * `/recording/start` with a start stamp and `/recording/stop` with a synthetic video of the
 * page's viewport size — exactly the file the extension would hand back, minus the pixels
 * of the page. Everything on the Node side is the real code: the default no-resize start,
 * the read-only viewport read, the pointer track, and the burn at stop.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, Page } from '@xmorse/playwright-core'
import { createRecordingApi } from './screen-recording.js'
import { GhostCursorController } from './ghost-cursor-controller.js'
import { getCDPSessionForPage } from './cdp-session.js'
import { PageFrames } from './page-frames.js'
import { openVideo, type DecodedVideo } from './video-probe.js'

const BACKGROUND = [232, 224, 200] as const // #E8E0C8
const WIDTH = 640
const HEIGHT = 480
const FPS = 30

// The page installs its own observers, so what it reports is what the page itself saw.
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>recording fixture</title>
<style>html,body{margin:0;height:100%;background:#E8E0C8}</style>
<script>
  window.pageSeen = { resizes: 0, mediaChanges: 0, mutations: 0 }
  addEventListener('resize', () => { pageSeen.resizes++ })
  const mq = matchMedia('(min-aspect-ratio: 16/10)')
  mq.addEventListener('change', () => { pageSeen.mediaChanges++ })
  new MutationObserver((records) => { pageSeen.mutations += records.length })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
</script></head><body></body></html>`

let browser: Browser
let pageServer: http.Server
let pageUrl: string
let relay: http.Server
let relayPort: number
let tmpRoot: string
let syntheticVideo: string
/** What the stand-in relay was asked, and the start stamp it handed out. */
const relayState = { startedAt: 0, outputPath: '', calls: [] as string[] }

function listen(server: http.Server): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>()
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(typeof address === 'object' && address ? address.port : 0)
  })
  return promise
}

function close(server: http.Server | undefined): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  if (!server) return Promise.resolve()
  server.close(() => resolve())
  return promise
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-tabcapture-rec-'))
  syntheticVideo = path.join(tmpRoot, 'synthetic.mp4')
  const made = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0xE8E0C8:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=4`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4', syntheticVideo,
  ])
  if (made.status !== 0) throw new Error(`could not make the synthetic video: ${made.stderr}`)

  pageServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  pageUrl = `http://127.0.0.1:${await listen(pageServer)}`

  relay = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => {
      body += c.toString()
    })
    req.on('end', () => {
      relayState.calls.push(req.url ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.url === '/recording/start') {
        relayState.outputPath = JSON.parse(body).outputPath
        relayState.startedAt = Date.now()
        res.end(JSON.stringify({ success: true, tabId: 1, startedAt: relayState.startedAt }))
        return
      }
      if (req.url === '/recording/stop') {
        fs.copyFileSync(syntheticVideo, relayState.outputPath)
        res.end(
          JSON.stringify({
            success: true,
            tabId: 1,
            path: relayState.outputPath,
            duration: Date.now() - relayState.startedAt,
            size: fs.statSync(relayState.outputPath).size,
          }),
        )
        return
      }
      res.end(JSON.stringify({ success: false, error: `unexpected ${req.url}` }))
    })
  })
  relayPort = await listen(relay)
  browser = await chromium.launch({ headless: true })
}, 120000)

afterAll(async () => {
  await browser?.close()
  await close(pageServer)
  await close(relay)
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function recordingApiFor(page: Page) {
  return createRecordingApi({
    context: page.context(),
    defaultPage: page,
    relayPort,
    ghostCursorController: new GhostCursorController({ logger: console }),
    onStart: () => {},
    onFinish: () => {},
    getExecutionTimestamps: () => [],
    // As the executor reads it: in an isolated world, so the read gives the page no user gesture.
    viewportOf: async (target) => {
      const frames = new PageFrames({ page: target, cdp: await getCDPSessionForPage({ page: target }) })
      try {
        return await frames.main.world.evaluate<{ width: number; height: number }>('({ width: innerWidth, height: innerHeight })')
      } finally {
        frames.dispose()
      }
    },
  })
}

/** What the page's own realm reports: its viewport, its media query, and its own observers. */
async function pageView(page: Page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    wide: window.matchMedia('(min-aspect-ratio: 16/10)').matches,
    globals: Object.getOwnPropertyNames(window).sort(),
    elements: document.querySelectorAll('*').length,
    // The page's own counters, serialised so the snapshot is a value, not a live object.
    seen: JSON.stringify(Reflect.get(window, 'pageSeen')),
  }))
}

/** Dark pixels in a box that are clearly not the background, and the box's top-left ink. */
function inkAround(video: DecodedVideo, frame: number, box: { x0: number; y0: number; x1: number; y1: number }) {
  let dark = 0
  let minX = Infinity
  let minY = Infinity
  for (let y = Math.max(0, box.y0); y <= Math.min(video.height - 1, box.y1); y++) {
    for (let x = Math.max(0, box.x0); x <= Math.min(video.width - 1, box.x1); x++) {
      const [r, g, b] = video.pixel(frame, x, y)
      const distance = Math.max(Math.abs(r - BACKGROUND[0]), Math.abs(g - BACKGROUND[1]), Math.abs(b - BACKGROUND[2]))
      if (distance < 60 || r + g + b >= 150) continue
      dark++
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
    }
  }
  return { dark, minX, minY }
}

describe('recording.start / stop (tabCapture recorder)', () => {
  it('leaves the page untouched and burns the dispatched pointer into the stopped video', async () => {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } })
    const page = await context.newPage()
    await page.goto(pageUrl)
    const recording = recordingApiFor(page)
    const outputPath = path.join(tmpRoot, 'tab.mp4')

    const before = await pageView(page)
    // 4:3, so the old 16:9 default would have shrunk it and flipped the media query.
    expect(before.wide).toBe(false)
    await recording.start({ page, outputPath })
    const during = await pageView(page)
    expect(during).toEqual(before)

    // Real time on purpose: the pointer is placed by the wall-clock instant each move was
    // dispatched, which is the alignment under test.
    await page.mouse.move(100, 100)
    const firstAt = Date.now()
    await page.waitForTimeout(700)
    await page.mouse.move(400, 300)
    const secondAt = Date.now()
    await page.waitForTimeout(700)
    const result = await recording.stop({ page })

    expect(relayState.calls).toEqual(['/recording/start', '/recording/stop'])
    expect(result.pointer?.drawn).toBe(true)
    expect(result.pointer?.samples).toBeGreaterThanOrEqual(2)
    expect(result.pointer?.note).toBeUndefined()
    expect(result.size).toBe(fs.statSync(outputPath).size)

    const after = await pageView(page)
    expect(after).toEqual(before)

    const video = await openVideo(outputPath)
    expect(video.width).toBe(WIDTH)
    expect(video.height).toBe(HEIGHT)
    const frameAt = (epochMs: number) => Math.round(((epochMs - relayState.startedAt) / 1000) * FPS)

    const first = inkAround(video, frameAt(firstAt + 300), { x0: 90, y0: 90, x1: 130, y1: 135 })
    expect(first.dark).toBeGreaterThan(20)
    expect(Math.abs(first.minX - 100)).toBeLessThanOrEqual(3)
    expect(Math.abs(first.minY - 100)).toBeLessThanOrEqual(3)
    expect(inkAround(video, frameAt(firstAt + 300), { x0: 390, y0: 290, x1: 430, y1: 335 }).dark).toBe(0)

    const second = inkAround(video, frameAt(secondAt + 300), { x0: 390, y0: 290, x1: 430, y1: 335 })
    expect(second.dark).toBeGreaterThan(20)
    expect(Math.abs(second.minX - 400)).toBeLessThanOrEqual(3)
    expect(Math.abs(second.minY - 300)).toBeLessThanOrEqual(3)
    expect(inkAround(video, frameAt(secondAt + 300), { x0: 90, y0: 90, x1: 130, y1: 135 }).dark).toBe(0)

    // Before the first dispatched position there is no pointer anywhere.
    expect(inkAround(video, 0, { x0: 0, y0: 0, x1: WIDTH - 1, y1: HEIGHT - 1 }).dark).toBe(0)

    relayState.calls.length = 0
    await context.close()
  }, 120000)

  it('draws nothing and leaves the file as recorded with pointer: false', async () => {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } })
    const page = await context.newPage()
    await page.goto(pageUrl)
    const recording = recordingApiFor(page)
    const outputPath = path.join(tmpRoot, 'no-pointer.mp4')
    await recording.start({ page, outputPath, pointer: false })
    await page.mouse.move(100, 100)
    const result = await recording.stop({ page })
    expect(result.pointer).toBeUndefined()
    expect(fs.readFileSync(outputPath).equals(fs.readFileSync(syntheticVideo))).toBe(true)
    relayState.calls.length = 0
    await context.close()
  }, 60000)

  it('resizes only when aspectRatio is asked for, and restores the viewport at stop', async () => {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } })
    const page = await context.newPage()
    await page.goto(pageUrl)
    const recording = recordingApiFor(page)
    await recording.start({ page, outputPath: path.join(tmpRoot, 'aspect.mp4'), aspectRatio: { width: 16, height: 9 }, pointer: false })
    expect(page.viewportSize()).toEqual({ width: 640, height: 360 })
    await recording.stop({ page })
    expect(page.viewportSize()).toEqual({ width: WIDTH, height: HEIGHT })
    relayState.calls.length = 0
    await context.close()
  }, 60000)
})
