/**
 * Live-Chromium tests for the labelled screenshot (labelled-screenshot.ts) and the scoped aria
 * snapshot (`getAriaSnapshot({ locator })`): where the labels land in the image, and that neither
 * leaves a trace in the page — no new globals, no new elements, no mutation records seen by the
 * page's own MutationObserver. Plain headless Chromium, no extension: the same CDP calls the relay
 * forwards.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContextOptions, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import type { ICDPSession } from './cdp-session.js'
import type { IsolatedWorld } from './isolated-world.js'
import { PageFrames } from './page-frames.js'
import { RefRegistry } from './ref-registry.js'
import { observePage, type Observation } from './page-observe.js'
import { getAriaSnapshot } from './aria-snapshot.js'
import { labelColors, renderLabelledScreenshot, type LabelledScreenshot } from './labelled-screenshot.js'
import { decodePng } from './png-pixels.js'
import { ModelFacingError } from './probe-types.js'

// Absolutely placed buttons with known corners; everything else sits below the first screen so
// the unscrolled screenshot labels exactly #a, #b and #c.
const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Labels fixture</title>
<style>
  body { margin: 0; font: 16px sans-serif; height: 2400px; background: #fff; }
  .abs { position: absolute; width: 120px; height: 40px; }
  #a { left: 40px; top: 60px; }
  #b { left: 300px; top: 200px; }
  #c { left: 600px; top: 400px; }
  #far { left: 100px; top: 1500px; }
  #below { position: absolute; left: 0; top: 800px; }
</style></head>
<body>
<button id="a" class="abs">Alpha</button>
<button id="b" class="abs">Beta</button>
<button id="c" class="abs">Gamma</button>
<button id="far" class="abs">Far</button>
<div id="below">
  <div id="panel"><button>Inside button</button><a href="#x">Inside link</a></div>
  <button>Outside button</button>
  <div id="host"></div>
  <iframe srcdoc="<button id='inner'>In frame</button>"></iframe>
</div>
<script>
  window.__mutations = 0
  const observer = new MutationObserver((records) => { window.__mutations += records.length })
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  window.__takeMutations = () => window.__mutations + observer.takeRecords().length
  document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow button</button>'
</script>
</body></html>`

let browser: Browser
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('fixture server has no TCP address')
  baseUrl = `http://127.0.0.1:${address.port}/`
  browser = await chromium.launch({ headless: true })
}, 120000)

afterAll(async () => {
  await browser?.close()
  const closed = Promise.withResolvers<void>()
  server?.close(() => closed.resolve())
  await closed.promise
})

interface Opened {
  page: Page
  cdp: ICDPSession
  world: IsolatedWorld
  observe: () => Promise<Observation>
  close: () => Promise<void>
}

const VIEWPORT_1000 = { viewport: { width: 1000, height: 600 } }

async function open(contextOptions: BrowserContextOptions = VIEWPORT_1000, from: Browser = browser): Promise<Opened> {
  const context = await from.newContext(contextOptions)
  const page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'load' })
  const cdp = await getCDPSessionForPage({ page })
  const frames = new PageFrames({ page, cdp })
  const world = frames.main.world
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  const registry = new RefRegistry()
  return {
    page,
    cdp,
    world,
    observe: () => observePage({ page, frames, registry, targetId: targetInfo.targetId, shown: true }),
    close: async () => {
      frames.dispose()
      await context.close()
    },
  }
}

/** The page's own view of itself: its global names, its element count, its mutation records. */
function footprint(page: Page) {
  return page.evaluate(() => {
    const takeMutations = Reflect.get(window, '__takeMutations') as () => number
    return {
      globals: Object.getOwnPropertyNames(window).sort(),
      elements: document.getElementsByTagName('*').length,
      mutations: takeMutations(),
    }
  })
}

async function labelledShot({ cdp, world, observe }: Opened): Promise<LabelledScreenshot> {
  const observation = await observe()
  return renderLabelledScreenshot({ cdp, world, observation })
}

/** Viewport-relative top-left corners of buttons, read from the page itself. */
function corners(page: Page, names: string[]) {
  return page.evaluate((wanted) => {
    return wanted.map((name) => {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === name)
      if (!button) throw new Error(`fixture has no button "${name}"`)
      const rect = button.getBoundingClientRect()
      return { name, x: Math.round(rect.left), y: Math.round(rect.top) }
    })
  }, names)
}

function expectLabelsAtCorners(
  shot: LabelledScreenshot,
  expected: Array<{ name: string; x: number; y: number }>,
): void {
  const image = decodePng(shot.png)
  const { fill, border } = labelColors('button')
  const pixel = (x: number, y: number) => {
    const at = (y * image.width + x) * image.channels
    return [image.data[at], image.data[at + 1], image.data[at + 2]]
  }
  for (const corner of expected) {
    const matches = shot.labels.filter((label) => label.name === corner.name)
    expect(matches, `one label for "${corner.name}" in ${JSON.stringify(shot.labels)}`).toHaveLength(1)
    const label = matches[0]
    expect({ name: corner.name, x: label.x, y: label.y }).toEqual(corner)
    // Border at the corner, fill just inside it, and the glyphs drawn in black inside the box.
    expect(pixel(corner.x, corner.y), `border pixel of "${corner.name}"`).toEqual([...border])
    expect(pixel(corner.x + 2, corner.y + 2), `fill pixel of "${corner.name}"`).toEqual([...fill])
    let black = 0
    for (let y = label.y; y < label.y + label.height; y++) {
      for (let x = label.x; x < label.x + label.width; x++) if (pixel(x, y).every((channel) => channel === 0)) black++
    }
    expect(black, `text pixels in the label of "${corner.name}"`).toBeGreaterThan(20)
  }
}

describe('labelled screenshot', () => {
  it('draws each ref at its element top-left in a viewport-sized PNG', async () => {
    const opened = await open()
    try {
      const shot = await labelledShot(opened)
      const image = decodePng(shot.png)
      expect({ width: image.width, height: image.height, scale: shot.scale }).toEqual({
        width: 1000,
        height: 600,
        scale: 1,
      })
      expect(shot.labels.map((label) => label.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma'])
      expect(shot.labels.every((label) => label.width > 0 && label.height > 0)).toBe(true)
      expectLabelsAtCorners(shot, await corners(opened.page, ['Alpha', 'Beta', 'Gamma']))
    } finally {
      await opened.close()
    }
  }, 60000)

  it('maps a scrolled page and a 2x device pixel ratio back to CSS pixels', async () => {
    const opened = await open({ ...VIEWPORT_1000, deviceScaleFactor: 2 })
    try {
      await opened.page.evaluate(() => window.scrollTo(0, 1300))
      const shot = await labelledShot(opened)
      const image = decodePng(shot.png)
      expect({ width: image.width, height: image.height }).toEqual({ width: 1000, height: 600 })
      expect(shot.labels.map((label) => label.name)).toContain('Far')
      expectLabelsAtCorners(shot, await corners(opened.page, ['Far']))
    } finally {
      await opened.close()
    }
  }, 60000)

  it('maps a fractional OS scale factor back to CSS pixels', async () => {
    // A forced 1.25 scale factor with no viewport emulation: the capture comes back at 1.25×
    // (1000×750 for the 800×600 window), so the mapping has to be fractional.
    const scaled = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1.25'] })
    const opened = await open({ viewport: null }, scaled)
    try {
      const windowSize = await opened.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      const shot = await labelledShot(opened)
      const image = decodePng(shot.png)
      expect({ width: image.width, height: image.height }).toEqual(windowSize)
      expectLabelsAtCorners(shot, await corners(opened.page, ['Alpha', 'Beta', 'Gamma']))
    } finally {
      await opened.close()
      await scaled.close()
    }
  }, 60000)

  it('refuses a pinch-zoomed page', async () => {
    const opened = await open()
    try {
      const observation = await opened.observe()
      await opened.cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 })
      const refused = await renderLabelledScreenshot({ cdp: opened.cdp, world: opened.world, observation }).catch(
        (error: unknown) => error,
      )
      expect(refused).toBeInstanceOf(ModelFacingError)
      expect(String(refused)).toContain('pinch-zoomed')
    } finally {
      await opened.close()
    }
  }, 60000)

  it('refuses an observation taken while a native dialog froze the page', async () => {
    const opened = await open()
    try {
      // What observePage returns while a dialog is open: no scroll, no boxes.
      const { scroll: _scroll, ...frozen } = await opened.observe()
      const refused = await renderLabelledScreenshot({
        cdp: opened.cdp,
        world: opened.world,
        observation: { ...frozen, elements: [] },
      }).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(ModelFacingError)
      expect(String(refused)).toContain('native dialog')
    } finally {
      await opened.close()
    }
  }, 60000)

  it('refuses an observation the page has scrolled away from', async () => {
    const opened = await open()
    try {
      const observation = await opened.observe()
      await opened.page.evaluate(() => window.scrollTo(0, 500))
      const refused = await renderLabelledScreenshot({ cdp: opened.cdp, world: opened.world, observation }).catch(
        (error: unknown) => error,
      )
      expect(refused).toBeInstanceOf(ModelFacingError)
      expect(String(refused)).toContain('scrolled since this observation')
    } finally {
      await opened.close()
    }
  }, 60000)
})

describe('scoped aria snapshot', () => {
  it('cuts the tree at the locator, through shadow roots and same-process iframes', async () => {
    const opened = await open()
    try {
      const panel = await getAriaSnapshot({ page: opened.page, locator: opened.page.locator('#panel') })
      expect(panel.snapshot).toContain('Inside button')
      expect(panel.snapshot).toContain('Inside link')
      expect(panel.snapshot).not.toContain('Outside button')
      expect(panel.snapshot).not.toContain('Alpha')

      const shadow = await getAriaSnapshot({ page: opened.page, locator: opened.page.locator('#host') })
      expect(shadow.snapshot).toContain('Shadow button')
      expect(shadow.snapshot).not.toContain('Inside button')

      const frame = opened.page.frames().find((candidate) => candidate !== opened.page.mainFrame())
      if (!frame) throw new Error('fixture iframe did not load')
      const inFrame = await getAriaSnapshot({ page: opened.page, frame, locator: frame.locator('body') })
      expect(inFrame.snapshot).toContain('In frame')
    } finally {
      await opened.close()
    }
  }, 60000)

  it('refuses a locator outside the requested frame', async () => {
    const opened = await open()
    try {
      const frame = opened.page.frames().find((candidate) => candidate !== opened.page.mainFrame())
      if (!frame) throw new Error('fixture iframe did not load')
      const refused = await getAriaSnapshot({ page: opened.page, frame, locator: opened.page.locator('#panel') }).catch(
        (error: unknown) => error,
      )
      expect(String(refused)).toContain('is not the requested frame')
    } finally {
      await opened.close()
    }
  }, 60000)
})

describe('page purity', () => {
  it('snapshot({ locator }) and a labelled screenshot leave globals, elements and mutations unchanged', async () => {
    const opened = await open()
    try {
      const before = await footprint(opened.page)
      expect(before.globals).toContain('__takeMutations')

      await getAriaSnapshot({ page: opened.page, locator: opened.page.locator('#panel') })
      await getAriaSnapshot({ page: opened.page, locator: opened.page.locator('#host') })
      const frame = opened.page.frames().find((candidate) => candidate !== opened.page.mainFrame())
      if (!frame) throw new Error('fixture iframe did not load')
      await getAriaSnapshot({ page: opened.page, frame, locator: frame.locator('#inner') })
      const shot = await labelledShot(opened)
      expect(shot.labels.length).toBeGreaterThan(0)

      const after = await footprint(opened.page)
      expect(after.globals).toEqual(before.globals)
      expect(after.elements).toBe(before.elements)
      expect(after.mutations).toBe(before.mutations)
    } finally {
      await opened.close()
    }
  }, 60000)
})
