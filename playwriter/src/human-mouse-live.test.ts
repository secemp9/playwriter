/**
 * Live-Chromium tests for human pointer motion.
 *
 * These exist to prove the two claims the unit tests CANNOT make:
 *  1. the modelled duration survives contact with real CDP dispatch (bounded drift), and
 *  2. the move is a behaviour change — a hover-sensitive element sitting between origin
 *     and target really does receive `mouseover` with human motion on, and really does
 *     not with it off.
 *
 * A plain Chromium is enough; no extension, no relay. The per-event costs measured
 * through the extension are documented in human-mouse-driver.ts and are strictly worse
 * than what runs here, so the drift bounds asserted below are the optimistic case.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { PlaywrightCDPSessionAdapter } from './cdp-session.js'
import { createHumanMouseApi } from './human-mouse-driver.js'
import { enableGhostCursor } from './ghost-cursor.js'

/**
 * Origin top-left, target bottom-right, and a wide hover-sensitive band straddling the
 * diagonal between them. A teleporting pointer jumps clean over the band; a real
 * trajectory has to cross it.
 */
const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>human mouse fixture</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f172a; color: #e2e8f0;
    font: 14px system-ui, sans-serif; overflow: hidden; }
  #origin { position: fixed; left: 60px; top: 60px; width: 16px; height: 16px;
    background: #f43f5e; border-radius: 50%; }
  #hazard { position: fixed; left: 260px; top: 200px; width: 360px; height: 200px;
    background: #334155; border-radius: 10px; display: flex; align-items: center;
    justify-content: center; }
  #target { position: fixed; left: 820px; top: 520px; width: 140px; height: 48px;
    background: #38bdf8; color: #0b1220; border-radius: 10px; display: flex;
    align-items: center; justify-content: center; font-weight: 600; }
  #readout { position: fixed; left: 12px; bottom: 12px; font: 12px ui-monospace, monospace; }
</style></head>
<body>
  <div id="origin"></div>
  <div id="hazard">hover-sensitive</div>
  <div id="target">Click me</div>
  <div id="readout">ready</div>
<script>
  window.__hazardHovers = 0
  window.__targetClicks = 0
  window.__moveTrail = []
  document.getElementById('hazard').addEventListener('mouseover', function () {
    window.__hazardHovers++
    document.getElementById('readout').textContent = 'hazard hovered x' + window.__hazardHovers
  })
  document.getElementById('target').addEventListener('click', function () { window.__targetClicks++ })
  document.addEventListener('mousemove', function (e) {
    if (window.__moveTrail.length < 4000) window.__moveTrail.push([e.clientX, e.clientY, Math.round(performance.now())])
  }, true)
  window.__resetProbes = function () {
    window.__hazardHovers = 0
    window.__targetClicks = 0
    window.__moveTrail = []
  }
</script>
</body></html>`

const ORIGIN = { x: 68, y: 68 }
const TARGET_CENTRE = { x: 890, y: 544 }

let browser: Browser
let context: BrowserContext
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1100, height: 700 } })
}, 120000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
  await new Promise<void>((r) => server?.close(() => r()))
})

async function openFixture(): Promise<{ page: Page; humanMouse: ReturnType<typeof createHumanMouseApi> }> {
  const page = await context.newPage()
  await page.goto(baseUrl)
  const humanMouse = createHumanMouseApi({
    defaultPage: page,
    getCdpSession: async ({ page: target }) => new PlaywrightCDPSessionAdapter(await context.newCDPSession(target)),
  })
  return { page, humanMouse }
}

describe('achieved wall-clock duration vs the model', () => {
  let page: Page
  let humanMouse: ReturnType<typeof createHumanMouseApi>

  beforeAll(async () => {
    const opened = await openFixture()
    page = opened.page
    humanMouse = opened.humanMouse
  }, 60000)

  afterAll(async () => {
    await page?.close()
  })

  it('delivers the modelled duration within a bounded drift', async () => {
    const drifts: number[] = []

    for (let i = 0; i < 4; i++) {
      const result = await humanMouse.moveTo({
        page,
        from: ORIGIN,
        locator: page.locator('#target'),
        seed: 1000 + i,
      })

      expect(result.dispatchedEvents).toBe(result.sampleCount)
      expect(result.sampleCount).toBeGreaterThan(10)
      // The plan must be the thing that decides the duration, not vsync.
      expect(result.plannedDurationMs).toBeGreaterThan(150)
      drifts.push(result.durationDriftMs)
    }

    // Every move must land close to its plan, and the loop must not run FAST either —
    // a negative drift would mean samples were dropped or the pacing collapsed.
    for (const drift of drifts) {
      expect(drift).toBeGreaterThan(-20)
      expect(drift).toBeLessThan(120)
    }
    const meanDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length
    expect(Math.abs(meanDrift)).toBeLessThan(60)
  }, 60000)

  it('reports the per-event probe and does not claim a throttled renderer is fine', async () => {
    const result = await humanMouse.moveTo({ page, from: ORIGIN, x: 500, y: 400, seed: 77 })
    expect(Number.isFinite(result.probeDispatchMs)).toBe(true)
    // A foreground/headless renderer acks well inside the throttle threshold.
    expect(result.rendererThrottled).toBe(false)
    // And when nothing is wrong, nothing is warned about.
    expect(result.warnings.filter((w) => w.includes('throttled'))).toHaveLength(0)
  }, 60000)

  it('scales duration with Fitts index of difficulty on a real page', async () => {
    const toWide = await humanMouse.moveTo({ page, from: ORIGIN, locator: page.locator('#hazard'), seed: 5 })
    const toNarrow = await humanMouse.moveTo({ page, from: ORIGIN, x: 890, y: 544, seed: 5 })

    expect(toWide.effectiveWidthPx).toBeGreaterThan(toNarrow.effectiveWidthPx)
    expect(toWide.indexOfDifficultyBits).toBeLessThan(toNarrow.indexOfDifficultyBits)
  }, 60000)
})

describe('the behavioural claim: a real path fires hover events a teleport does not', () => {
  let page: Page
  let humanMouse: ReturnType<typeof createHumanMouseApi>

  beforeAll(async () => {
    const opened = await openFixture()
    page = opened.page
    humanMouse = opened.humanMouse
  }, 60000)

  afterAll(async () => {
    await page?.close()
  })

  it('does NOT hover the intervening element with human motion off', async () => {
    await page.evaluate(() => (globalThis as unknown as { __resetProbes: () => void }).__resetProbes())
    // Plain Playwright: one dispatch at the destination.
    await page.mouse.move(ORIGIN.x, ORIGIN.y)
    await page.mouse.move(TARGET_CENTRE.x, TARGET_CENTRE.y)
    await page.waitForTimeout(120)

    const hovers = await page.evaluate(() => (globalThis as unknown as { __hazardHovers: number }).__hazardHovers)
    expect(hovers).toBe(0)
  }, 60000)

  it('DOES hover the intervening element with human motion on', async () => {
    await page.evaluate(() => (globalThis as unknown as { __resetProbes: () => void }).__resetProbes())

    const result = await humanMouse.moveTo({
      page,
      from: ORIGIN,
      locator: page.locator('#target'),
      seed: 4242,
      reportCrossings: true,
    })
    await page.waitForTimeout(120)

    const hovers = await page.evaluate(() => (globalThis as unknown as { __hazardHovers: number }).__hazardHovers)
    expect(hovers).toBeGreaterThan(0)

    // And the driver reports the crossing itself, from real events rather than geometry.
    expect(result.crossed).toBeDefined()
    const descriptions = (result.crossed ?? []).map((c) => c.description).join(' | ')
    expect(descriptions).toContain('#hazard')
  }, 60000)

  it('the page receives a dense, ordered trail of mousemoves, not one jump', async () => {
    await page.evaluate(() => (globalThis as unknown as { __resetProbes: () => void }).__resetProbes())
    const result = await humanMouse.moveTo({ page, from: ORIGIN, locator: page.locator('#target'), seed: 99 })
    await page.waitForTimeout(150)

    const trail = await page.evaluate(
      () => (globalThis as unknown as { __moveTrail: Array<[number, number, number]> }).__moveTrail,
    )

    // Chrome coalesces mousemove within a frame, so the page sees at most one per frame —
    // fewer than we dispatched, but far more than the single event a teleport produces.
    expect(trail.length).toBeGreaterThan(8)
    expect(trail.length).toBeLessThanOrEqual(result.dispatchedEvents + 2)

    // The trail must actually traverse: it starts near the origin and ends on target.
    const first = trail[0]
    const last = trail[trail.length - 1]
    expect(Math.hypot(first[0] - ORIGIN.x, first[1] - ORIGIN.y)).toBeLessThan(220)
    expect(Math.hypot(last[0] - TARGET_CENTRE.x, last[1] - TARGET_CENTRE.y)).toBeLessThan(30)

    // And it is not a straight line — the perpendicular deviation is real.
    const dx = last[0] - first[0]
    const dy = last[1] - first[1]
    const chord = Math.hypot(dx, dy)
    const maxDeviation = Math.max(
      ...trail.map(([x, y]) => Math.abs((x - first[0]) * dy - (y - first[1]) * dx) / chord),
    )
    expect(maxDeviation).toBeGreaterThan(1)
    expect(maxDeviation).toBeLessThan(chord * 0.2)
  }, 60000)

  it('reports crossings only when asked', async () => {
    const silent = await humanMouse.moveTo({ page, from: ORIGIN, x: 600, y: 400, seed: 12 })
    expect(silent.crossed).toBeUndefined()
  }, 60000)
})

describe('clicking', () => {
  let page: Page
  let humanMouse: ReturnType<typeof createHumanMouseApi>

  beforeAll(async () => {
    const opened = await openFixture()
    page = opened.page
    humanMouse = opened.humanMouse
  }, 60000)

  afterAll(async () => {
    await page?.close()
  })

  it('lands the click on the target after a human approach', async () => {
    await page.evaluate(() => (globalThis as unknown as { __resetProbes: () => void }).__resetProbes())
    const result = await humanMouse.click({ page, from: ORIGIN, locator: page.locator('#target'), seed: 8 })

    const clicks = await page.evaluate(() => (globalThis as unknown as { __targetClicks: number }).__targetClicks)
    expect(clicks).toBe(1)
    // The trajectory terminated exactly on the resolved point, which is why it hit.
    expect(result.to.x).toBeCloseTo(890, 0)
    expect(result.to.y).toBeCloseTo(544, 0)
  }, 60000)

  it('enable() routes locator.click through a human move, and disable() restores', async () => {
    await humanMouse.enable({ page })
    expect(humanMouse.isEnabled({ page })).toBe(true)

    await page.mouse.move(ORIGIN.x, ORIGIN.y)
    await page.evaluate(() => (globalThis as unknown as { __resetProbes: () => void }).__resetProbes())
    await page.locator('#target').click()
    await page.waitForTimeout(120)

    const hoversWithHuman = await page.evaluate(
      () => (globalThis as unknown as { __hazardHovers: number }).__hazardHovers,
    )
    const clicksWithHuman = await page.evaluate(
      () => (globalThis as unknown as { __targetClicks: number }).__targetClicks,
    )
    expect(clicksWithHuman).toBe(1)
    expect(hoversWithHuman).toBeGreaterThan(0)

    await humanMouse.disable({ page })
    expect(humanMouse.isEnabled({ page })).toBe(false)

    await page.mouse.move(ORIGIN.x, ORIGIN.y)
    await page.evaluate(() => (globalThis as unknown as { __resetProbes: () => void }).__resetProbes())
    await page.locator('#target').click()
    await page.waitForTimeout(120)

    const hoversAfterDisable = await page.evaluate(
      () => (globalThis as unknown as { __hazardHovers: number }).__hazardHovers,
    )
    const clicksAfterDisable = await page.evaluate(
      () => (globalThis as unknown as { __targetClicks: number }).__targetClicks,
    )
    expect(clicksAfterDisable).toBe(1)
    expect(hoversAfterDisable).toBe(0)
  }, 60000)
})

describe('ghost cursor follows the same path', () => {
  let page: Page
  let humanMouse: ReturnType<typeof createHumanMouseApi>

  beforeAll(async () => {
    const opened = await openFixture()
    page = opened.page
    humanMouse = opened.humanMouse
    await enableGhostCursor({ page })
  }, 60000)

  afterAll(async () => {
    await page?.close()
  })

  it('plays the trajectory rather than CSS-transitioning between two points', async () => {
    // Sample the overlay's transform while the move runs, from inside the page.
    await page.evaluate(() => {
      // `src` builds with node + chrome types and no DOM lib, so page-side globals are
      // reached structurally rather than as ambient names.
      const store = globalThis as unknown as {
        __cursorTrail?: Array<[number, number]>
        __sampling?: boolean
        requestAnimationFrame: (callback: () => void) => number
      }
      store.__cursorTrail = []
      store.__sampling = true
      const tick = (): void => {
        if (!store.__sampling) return
        const element = document.getElementById('__playwriter_ghost_cursor__')
        if (element) {
          const rect = element.getBoundingClientRect()
          store.__cursorTrail!.push([Math.round(rect.left), Math.round(rect.top)])
        }
        store.requestAnimationFrame(tick)
      }
      store.requestAnimationFrame(tick)
    })

    const result = await humanMouse.moveTo({
      page,
      from: ORIGIN,
      locator: page.locator('#target'),
      seed: 31337,
      includeTrajectory: true,
    })
    expect(result.ghostCursor.playing).toBe(true)

    await page.waitForTimeout(120)
    const trail = await page.evaluate(() => {
      const store = globalThis as unknown as { __cursorTrail: Array<[number, number]>; __sampling: boolean }
      store.__sampling = false
      return store.__cursorTrail
    })

    // The overlay moved through many intermediate positions, not two.
    const unique = new Set(trail.map(([x, y]) => `${x},${y}`))
    expect(unique.size).toBeGreaterThan(10)

    const planned = result.trajectory!

    // Distance to the nearest point on the planned POLYLINE — not to the nearest vertex.
    // At peak speed consecutive samples are ~50px apart, so a reading taken mid-segment
    // is legitimately ~25px from every vertex while sitting exactly on the path.
    const distanceToPath = ([x, y]: [number, number]): number => {
      let best = Number.POSITIVE_INFINITY
      for (let i = 1; i < planned.samples.length; i++) {
        const a = planned.samples[i - 1]
        const b = planned.samples[i]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const lengthSquared = dx * dx + dy * dy
        const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared))
        best = Math.min(best, Math.hypot(a.x + t * dx - x, a.y + t * dy - y))
      }
      return best
    }

    // Frames captured before playback started show the cursor's previous resting place
    // (the overlay centres itself on enable), so playback is taken to begin at the first
    // frame that reaches the trajectory's origin.
    const startIndex = trail.findIndex(([x, y]) => Math.hypot(x - ORIGIN.x, y - ORIGIN.y) < 30)
    expect(startIndex).toBeGreaterThanOrEqual(0)
    const playbackFrames = trail.slice(startIndex)
    expect(playbackFrames.length).toBeGreaterThan(15)

    // EVERY playback frame lies on the planned polyline. This is the assertion that the
    // drawn cursor and the real CDP pointer do not disagree: the overlay is not CSS-easing
    // between two points, it is tracing the same curve the pointer traced.
    //
    // The tolerance covers the pointer-hotspot offset (a couple of px) plus up to a frame
    // of sampling skew — this rAF sampler is registered before the playback rAF, so each
    // reading returns the transform written on the previous frame.
    const offPath = playbackFrames.map(distanceToPath)
    expect(Math.max(...offPath)).toBeLessThan(12)

    // ...and it genuinely traverses, rather than jumping and sitting still.
    const travelled = playbackFrames.reduce(
      (sum, point, i) =>
        i === 0 ? 0 : sum + Math.hypot(point[0] - playbackFrames[i - 1][0], point[1] - playbackFrames[i - 1][1]),
      0,
    )
    expect(travelled).toBeGreaterThan(planned.distancePx * 0.9)
  }, 60000)
})
