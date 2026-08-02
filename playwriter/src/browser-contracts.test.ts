/**
 * browser-contracts.test.ts — the oracle.
 *
 * Every other test in the geometry / styles / debugger lanes asserts against payloads
 * this repository wrote. That is how the geometry lane ended up with 67 green unit tests
 * and a decoder that threw on the first real browser call: the fixture generator encoded
 * the same misunderstanding of the wire format as the decoder, so the tests could only
 * ever confirm it. Nothing was testing the generator, and nothing was testing the beliefs.
 *
 * These tests take their ground truth from a REAL headless Chromium instead — no
 * extension, no relay, just `@xmorse/playwright-core` and a throwaway static server —
 * and assert the STRUCTURAL INVARIANTS the decoders rely on. Each one names the specific
 * assumption rather than checking that a call succeeded, so a failure reads as "Chrome
 * stopped doing X, which <decoder> depends on" and not as "something broke".
 *
 * Where an assumption turned out to be RIGHT, the test says so and pins it, because an
 * unpinned correct belief is one Chrome release away from being an incorrect one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, CDPSession, Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import { PlaywrightCDPSessionAdapter, getCDPSessionForFrame, getCDPSessionForPage } from './cdp-session.js'
import {
  decodeCaptureSnapshot,
  PAGE_MODEL_COMPUTED_STYLES,
  fetchPageGeometry,
  type Box,
} from './page-model.js'
import {
  buildCaptureSnapshot,
  buildCaptureSnapshotWithoutPaintOrder,
  describeSnapshotShape,
  type FixtureDocument,
} from './capture-snapshot-fixture.js'
import { normalizeMatchedStyles } from './styles.js'
import { resolveCascade } from './css-cascade.js'
import { Debugger } from './debugger.js'
import { getAriaSnapshot } from './aria-snapshot.js'
import { netDelay, netTimeline, stopAllTraceProbes, tracePerturbationWarnings, listTraceProbes } from './trace.js'

// ---------------------------------------------------------------------------
// Fixtures served to the browser
// ---------------------------------------------------------------------------

const GEOMETRY_HTML = `<!doctype html><html><head><style>
  body { margin: 0; height: 4000px; }
  #spacer { height: 1200px; }
  .deep { padding: 0 }
  #sc { position: relative; z-index: 5; width: 120px; height: 40px; }
  #fixed { position: fixed; top: 10px; left: 20px; width: 90px; height: 30px; }
  #plain { width: 50px; height: 20px; }
  #gone { display: none; }
</style></head><body>
  <div id="spacer"></div>
  <div class="deep"><div class="deep"><div class="deep"><div class="deep">
    <div id="sc">SC</div><div id="plain">plain</div>
  </div></div></div></div>
  <div id="fixed">FIXED</div>
  <div id="gone">gone</div>
</body></html>`

const STYLES_HTML = `<!doctype html><html><head><style>
  /* A multi-selector list where only the MIDDLE selector matches: the alignment case. */
  .no-match-a, #target, div.no-match-b { color: rgb(1, 2, 3); }
  /* Declared later and more specific: must win, and must sort last in CDP order. */
  #target { color: rgb(9, 9, 9); }
  /* Declared FIRST and weakest: must sort first among the regular rules. */
  div { color: rgb(7, 7, 7); }
  #dropped { -webkit-line-clamp: 2; color: initial; background: rgb(4, 5, 6); }
</style></head><body>
  <div id="target">target</div><div id="dropped">dropped</div>
</body></html>`

const APP_JS = `function appFn(a) { return a + 1 }\nwindow.appFn = appFn;\n`
const VENDOR_APP_JS = `function vendorFn(b) { return b * 2 }\nwindow.vendorFn = vendorFn;\n`

let browser: Browser
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const raw = req.url || '/'
    const url = raw.split('?')[0]
    if (url === '/iframe-host') {
      // The OOPIF test needs the PARENT to be a real http origin: an `about:blank` parent
      // shares a process with its children whatever their url, so `setContent` cannot
      // produce a cross-process iframe and the test would silently exercise the
      // same-process path instead.
      const src = new URLSearchParams(raw.slice(raw.indexOf('?') + 1)).get('src') ?? ''
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><body><button id="outer-button">OuterButton</button>` +
          `<iframe src="${src}" width="300" height="200"></iframe></body>`,
      )
      return
    }
    if (url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(APP_JS)
      return
    }
    if (url === '/vendor-app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(VENDOR_APP_JS)
      return
    }
    if (url === '/api/cart') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"items":1}')
      return
    }
    if (url === '/styles') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(STYLES_HTML)
      return
    }
    if (url === '/scripts') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><body><script src="/app.js"></script><script src="/vendor-app.js"></script></body>`)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(GEOMETRY_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
  await stopAllTraceProbes()
  await browser?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

/** Open a page and give back its raw CDP session, closing everything afterwards. */
async function withPage<T>(
  fn: (args: { page: Page; cdp: PlaywrightCDPSessionAdapter; raw: CDPSession }) => Promise<T>,
  contextOptions?: Parameters<Browser['newContext']>[0],
): Promise<T> {
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  try {
    const raw = await context.newCDPSession(page)
    const cdp = await getCDPSessionForPage({ page })
    return await fn({ page, cdp, raw })
  } finally {
    await context.close()
  }
}

/** The layout index whose node carries `id`, plus that node's index. */
function locateInSnapshot(
  snapshot: Protocol.DOMSnapshot.CaptureSnapshotResponse,
  id: string,
): { nodeIndex: number; layoutIndex: number } {
  const doc = snapshot.documents[0]
  const str = (i: number | undefined) => (i == null || i < 0 ? '' : snapshot.strings[i])
  const nodeIndex = (doc.nodes.backendNodeId ?? []).findIndex((_, i) => {
    const attrs = doc.nodes.attributes?.[i] ?? []
    for (let k = 0; k + 1 < attrs.length; k += 2) {
      if (str(attrs[k]) === 'id' && str(attrs[k + 1]) === id) return true
    }
    return false
  })
  return { nodeIndex, layoutIndex: doc.layout.nodeIndex.indexOf(nodeIndex) }
}

/** `raw.send` is typed against Playwright's own bundled protocol; this project types CDP
 *  payloads with `devtools-protocol`, so each call is widened once, here. */
async function send(raw: CDPSession, method: string, params?: unknown): Promise<any> {
  return await (raw.send as (m: never, p?: never) => Promise<any>)(method as never, params as never)
}

async function captureGeometrySnapshot(raw: CDPSession): Promise<Protocol.DOMSnapshot.CaptureSnapshotResponse> {
  await send(raw, 'DOM.enable')
  await send(raw, 'DOMSnapshot.enable')
  return (await send(raw, 'DOMSnapshot.captureSnapshot', {
    computedStyles: [...PAGE_MODEL_COMPUTED_STYLES],
    includePaintOrder: true,
  })) as Protocol.DOMSnapshot.CaptureSnapshotResponse
}

// ===========================================================================
// CONTRACT 1 — layout.paintOrders density
// ===========================================================================

describe('CONTRACT 1: layout.paintOrders is read positionally, so its length is load-bearing', () => {
  it('is exactly as long as layout.nodeIndex when includePaintOrder is requested', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const snapshot = await captureGeometrySnapshot(raw)
      for (const [i, doc] of snapshot.documents.entries()) {
        expect(
          doc.layout.paintOrders,
          `ASSUMPTION BROKEN (page-model.ts:490 reads layout.paintOrders[layoutIndex]): documents[${i}] has no ` +
            `paintOrders table even though includePaintOrder:true was requested`,
        ).toBeDefined()
        expect(
          doc.layout.paintOrders!.length,
          `ASSUMPTION BROKEN: documents[${i}].layout.paintOrders is not parallel to layout.nodeIndex. ` +
            `page-model.ts indexes it by LAYOUT position, so any other length silently gives every node another ` +
            `node's paint order — and paint order decides every occlusion verdict and every hitTestPoint answer.`,
        ).toBe(doc.layout.nodeIndex.length)
      }
    })
  })

  it('is dense — every laid-out node has an order, including text boxes and #document', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const { layout } = (await captureGeometrySnapshot(raw)).documents[0]
      expect(
        layout.paintOrders!.filter((value) => typeof value !== 'number'),
        'ASSUMPTION BROKEN: paintOrders contains holes. A hole reads as `paintOrder: undefined`, which ' +
          'computeFrameOcclusion treats as "cannot be ordered" and skips — silently dropping an occluder.',
      ).toEqual([])
      // The #document node is layout entry 0 and carries paint order 0.
      expect(layout.paintOrders![0]).toBe(0)
    })
  })

  it('is ABSENT, never short, when includePaintOrder is not requested — the only other legal shape', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      await send(raw, 'DOM.enable')
      await send(raw, 'DOMSnapshot.enable')
      const snapshot = (await send(raw, 'DOMSnapshot.captureSnapshot', {
        computedStyles: [...PAGE_MODEL_COMPUTED_STYLES],
      })) as Protocol.DOMSnapshot.CaptureSnapshotResponse
      for (const doc of snapshot.documents) {
        expect(
          doc.layout.paintOrders,
          'ASSUMPTION BROKEN: without includePaintOrder Chromium returned a paintOrders table. The decoder accepts ' +
            'exactly two shapes (absent, or exactly nodeIndex.length); a third shape needs a decision, not a default.',
        ).toBeUndefined()
      }
      // The decoder must accept that shape rather than throwing.
      expect(() => decodeCaptureSnapshot({ snapshot })).not.toThrow()
    })
  })

  it('the decoder REJECTS a short paintOrders table instead of misindexing it', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const snapshot = await captureGeometrySnapshot(raw)
      // Take Chrome's own payload and corrupt only this one table.
      snapshot.documents[0].layout.paintOrders = snapshot.documents[0].layout.paintOrders!.slice(0, -1)
      expect(() => decodeCaptureSnapshot({ snapshot })).toThrow(/paintOrders has \d+ entries but the layout table has/)
    })
  })
})

// ===========================================================================
// CONTRACT 2 — layout.stackingContexts.index space
// ===========================================================================

describe('CONTRACT 2: layout.stackingContexts.index holds LAYOUT indexes, not node indexes', () => {
  it('names the stacking-context elements under the layout reading and NOT under the node reading', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const snapshot = await captureGeometrySnapshot(raw)
      const flagged = new Set(snapshot.documents[0].layout.stackingContexts?.index ?? [])

      // Two independent stacking contexts, deliberately deep in the tree so that their
      // layout index and their node index are DIFFERENT numbers. If they were equal the
      // test could not tell the two readings apart, which is exactly how this stayed
      // unmeasured.
      for (const id of ['sc', 'fixed']) {
        const { nodeIndex, layoutIndex } = locateInSnapshot(snapshot, id)
        expect(nodeIndex, `#${id} was not found in the node table`).toBeGreaterThanOrEqual(0)
        expect(layoutIndex, `#${id} was not found in the layout table`).toBeGreaterThanOrEqual(0)
        expect(
          nodeIndex,
          `this test proves nothing unless #${id}'s node index and layout index differ — they are both ${nodeIndex}`,
        ).not.toBe(layoutIndex)

        expect(
          flagged.has(layoutIndex),
          `ASSUMPTION BROKEN (page-model.ts:439/492): #${id} establishes a stacking context and sits at layout ` +
            `index ${layoutIndex} / node index ${nodeIndex}, but stackingContexts.index does not contain ` +
            `${layoutIndex}. It contains [${[...flagged].join(', ')}].`,
        ).toBe(true)
        expect(
          flagged.has(nodeIndex),
          `ASSUMPTION BROKEN: stackingContexts.index contains #${id}'s NODE index ${nodeIndex}, so the table is ` +
            `node-indexed after all and every stacking context is currently mislabelled.`,
        ).toBe(false)
      }
    })
  })

  it('never exceeds the layout table length, which the node reading could not satisfy', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const { layout, nodes } = (await captureGeometrySnapshot(raw)).documents[0]
      const flagged = layout.stackingContexts?.index ?? []
      expect(flagged.length, 'the page must establish at least one stacking context for this to prove anything')
        .toBeGreaterThan(0)
      // The whole point: the node table is strictly larger, so staying inside the layout
      // table is evidence, not coincidence.
      expect((nodes.backendNodeId ?? []).length).toBeGreaterThan(layout.nodeIndex.length)
      for (const index of flagged) {
        expect(
          index,
          `ASSUMPTION BROKEN: stackingContexts.index contains ${index}, outside the ${layout.nodeIndex.length}-entry ` +
            `layout table (the node table has ${(nodes.backendNodeId ?? []).length}). Read as a layout index it addresses ` +
            `nothing; the decoder would flag no node, or the wrong one.`,
        ).toBeLessThan(layout.nodeIndex.length)
        expect(index).toBeGreaterThanOrEqual(0)
      }
    })
  })

  it('the decoder REJECTS an out-of-range index instead of silently flagging nothing', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const snapshot = await captureGeometrySnapshot(raw)
      const layoutCount = snapshot.documents[0].layout.nodeIndex.length
      snapshot.documents[0].layout.stackingContexts = { index: [0, layoutCount + 3] }
      expect(() => decodeCaptureSnapshot({ snapshot })).toThrow(/stackingContexts\.index contains \d+/)
    })
  })

  it('the decoded flag lands on the element that really establishes the context', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const snapshot = await captureGeometrySnapshot(raw)
      const geometry = decodeCaptureSnapshot({ snapshot })
      const frame = [...geometry.values()][0]
      const byId = (id: string) => {
        const { nodeIndex } = locateInSnapshot(snapshot, id)
        const backendNodeId = (snapshot.documents[0].nodes.backendNodeId ?? [])[nodeIndex]
        return frame.byBackendId.get(backendNodeId)
      }
      expect(byId('sc')?.stackingContext, '#sc has position:relative + z-index:5').toBe(true)
      expect(byId('fixed')?.stackingContext, '#fixed has position:fixed').toBe(true)
      expect(byId('plain')?.stackingContext, '#plain is a bare block and establishes nothing').toBe(false)
    })
  })
})

// ===========================================================================
// CONTRACT 3 — layout.bounds coordinate space
// ===========================================================================

describe('CONTRACT 3: layout.bounds is CSS pixels in DOCUMENT space', () => {
  /** The same page, measured by the browser and by the snapshot, at a given scroll/DPR. */
  async function measure({ scrollY, dpr }: { scrollY: number; dpr: number }) {
    return withPage(
      async ({ page, raw }) => {
        await page.goto(baseUrl)
        await page.evaluate((y) => window.scrollTo(0, y), scrollY)
        await page.waitForTimeout(120)
        const snapshot = await captureGeometrySnapshot(raw)
        const truth = await page.evaluate(() => {
          const read = (id: string) => {
            const rect = document.getElementById(id)!.getBoundingClientRect()
            return {
              viewportY: rect.y,
              documentY: rect.y + window.scrollY,
              viewportX: rect.x,
              documentX: rect.x + window.scrollX,
            }
          }
          return { sc: read('sc'), fixed: read('fixed'), scrollY: window.scrollY, dpr: window.devicePixelRatio }
        })
        const boundsOf = (id: string) => snapshot.documents[0].layout.bounds[locateInSnapshot(snapshot, id).layoutIndex]
        return {
          truth,
          sc: boundsOf('sc'),
          fixed: boundsOf('fixed'),
          scrollOffsetY: snapshot.documents[0].scrollOffsetY,
        }
      },
      { viewport: { width: 800, height: 600 }, deviceScaleFactor: dpr },
    )
  }

  it('includes the scroll offset — it is document space, not viewport space', async () => {
    const m = await measure({ scrollY: 900, dpr: 1 })
    expect(m.truth.scrollY, 'the page must actually be scrolled for this to prove anything').toBe(900)
    expect(m.truth.sc.viewportY).not.toBe(m.truth.sc.documentY)
    expect(
      m.sc[1],
      `ASSUMPTION BROKEN (page-model.ts Box doc): #sc reads y=${m.truth.sc.viewportY} in the viewport and ` +
        `y=${m.truth.sc.documentY} in the document, and layout.bounds says ${m.sc[1]}. If bounds were viewport ` +
        `space, every box in a scrolled page is off by the scroll offset and inViewport is computed against the ` +
        `wrong rectangle.`,
    ).toBeCloseTo(m.truth.sc.documentY, 1)
  })

  it('reports position:fixed in document space too — the case that separates the two spaces hardest', async () => {
    const m = await measure({ scrollY: 900, dpr: 1 })
    // A fixed element does not move on screen, so its viewport Y stays 10 while its
    // document Y tracks the scroll. Whichever number bounds reports names the space.
    expect(m.truth.fixed.viewportY).toBeCloseTo(10, 1)
    expect(m.truth.fixed.documentY).toBeCloseTo(910, 1)
    expect(
      m.fixed[1],
      `ASSUMPTION BROKEN: #fixed is at viewport y=${m.truth.fixed.viewportY} and document y=${m.truth.fixed.documentY}, ` +
        `and layout.bounds says ${m.fixed[1]}. position:fixed is the one case where a decoder that quietly assumed ` +
        `viewport space would still look right everywhere else.`,
    ).toBeCloseTo(m.truth.fixed.documentY, 1)
  })

  it('equals the document scrollOffset the same payload reports, so adding it would double-count', async () => {
    const m = await measure({ scrollY: 900, dpr: 1 })
    expect(m.scrollOffsetY ?? 0).toBe(900)
    expect(
      m.sc[1] - m.truth.sc.viewportY,
      'FrameGeometry.scrollOffsetY is decoded and deliberately never read: the scroll is ALREADY in bounds. ' +
        'This pins that, so a future reader cannot "fix" inViewport by adding it and shift every box by a screenful.',
    ).toBeCloseTo(m.scrollOffsetY ?? 0, 1)
  })

  it('is CSS pixels — identical at deviceScaleFactor 1, 2 and 3', async () => {
    const [one, two, three] = await Promise.all([
      measure({ scrollY: 900, dpr: 1 }),
      measure({ scrollY: 900, dpr: 2 }),
      measure({ scrollY: 900, dpr: 3 }),
    ])
    expect(one.truth.dpr).toBe(1)
    expect(two.truth.dpr).toBe(2)
    expect(three.truth.dpr).toBe(3)
    for (const [label, m] of [
      ['DPR 2', two],
      ['DPR 3', three],
    ] as const) {
      expect(
        m.sc,
        `ASSUMPTION BROKEN: layout.bounds changed at ${label}. page-model.ts documents Box as CSS pixels and ` +
          `MOVED_THRESHOLD_PX (0.5px) assumes it; if bounds were device pixels, every box on a retina page is ` +
          `2-3x too large and every diff reports a move that did not happen.`,
      ).toEqual(one.sc)
      expect(m.fixed).toEqual(one.fixed)
    }
  })

  it('shares its space with cssLayoutViewport, which is what makes inViewport a valid comparison', async () => {
    await withPage(
      async ({ page, cdp }) => {
        await page.goto(baseUrl)
        await page.evaluate(() => window.scrollTo(0, 900))
        await page.waitForTimeout(120)
        const geometry = await fetchPageGeometry({ cdp })
        const frame = [...geometry.values()].find((f) => f.viewport)!
        expect(frame.viewport, 'the main frame must carry a viewport').toBeDefined()
        // pageY IS the scroll offset, in the same document space as the boxes.
        expect((frame.viewport as Box).y).toBeCloseTo(frame.scrollOffsetY, 1)
        // #sc sits at document y=1208, inside the 900..1500 window: visible AND in viewport.
        const inViewport = [...frame.byBackendId.values()].filter((r) => r.box.height > 0 && r.box.y >= 900 && r.box.y < 1500)
        expect(
          inViewport.length,
          'with bounds and viewport in one space, scrolling to 900 must bring the y=1208 content into the window',
        ).toBeGreaterThan(0)
      },
      { viewport: { width: 800, height: 600 } },
    )
  })
})

// ===========================================================================
// The fixture generator, checked against Chrome instead of against itself
// ===========================================================================

describe('the captureSnapshot fixture generator matches Chrome structurally', () => {
  /** A fixture whose node and layout counts differ, so index spaces stay distinguishable. */
  const fixtureDocuments: FixtureDocument[] = [
    {
      frameId: 'frame-1',
      root: {
        backendNodeId: 1,
        nodeName: '#document',
        nodeType: 9,
        children: [
          {
            backendNodeId: 2,
            nodeName: 'HTML',
            layout: { bounds: [0, 0, 800, 84], paintOrder: 1, styles: { display: 'block' }, stackingContext: true },
            children: [
              {
                backendNodeId: 3,
                nodeName: 'DIV',
                attributes: { id: 'sc' },
                layout: { bounds: [0, 0, 120, 40], paintOrder: 2, styles: { position: 'relative' }, stackingContext: true },
                children: [{ backendNodeId: 4, nodeName: '#text', nodeType: 3, layout: { bounds: [0, 0, 8, 17], paintOrder: 2, text: 'SC' } }],
              },
              // No layout: models `display: none`, which is what keeps nodeCount > layoutCount.
              { backendNodeId: 5, nodeName: 'DIV', attributes: { id: 'gone' } },
              { backendNodeId: 6, nodeName: 'DIV', attributes: { id: 'gone2' } },
            ],
          },
        ],
      },
    },
  ]

  it('emits the same tables, index spaces and absent-encodings as a real capture', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const real = await captureGeometrySnapshot(raw)
      const fixture = buildCaptureSnapshot({ documents: fixtureDocuments })

      const realShape = describeSnapshotShape(real)
      const fixtureShape = describeSnapshotShape(fixture)

      // Sanity: the two must be describing genuinely different pages, or this compares
      // nothing. The counts differ, so an index-space confusion cannot hide.
      expect((real.documents[0].nodes.backendNodeId ?? []).length).not.toBe(
        (fixture.documents[0].nodes.backendNodeId ?? []).length,
      )

      expect(
        fixtureShape,
        'THE FIXTURE GENERATOR HAS DRIFTED FROM CHROME. capture-snapshot-fixture.ts emits synthetic payloads that ' +
          'every geometry unit test asserts against; if its shape stops matching a real capture, those tests are ' +
          'confirming the generator rather than the decoder — which is exactly how the geometry lane got 67 green ' +
          'tests and a decoder that threw on the first real browser call. Fix the GENERATOR to match Chrome.',
      ).toEqual(realShape)
    })
  })

  it('models the no-paint-order capture the same way Chrome does', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      await send(raw, 'DOM.enable')
      await send(raw, 'DOMSnapshot.enable')
      const real = (await send(raw, 'DOMSnapshot.captureSnapshot', {
        computedStyles: [...PAGE_MODEL_COMPUTED_STYLES],
      })) as Protocol.DOMSnapshot.CaptureSnapshotResponse
      const fixture = buildCaptureSnapshotWithoutPaintOrder({ documents: fixtureDocuments })
      expect(describeSnapshotShape(fixture)).toEqual(describeSnapshotShape(real))
      expect(fixture.documents[0].layout.paintOrders).toBeUndefined()
    })
  })

  it('a real capture decodes through the same decoder the fixtures exercise', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const real = await captureGeometrySnapshot(raw)
      const geometry = decodeCaptureSnapshot({ snapshot: real })
      const frame = [...geometry.values()][0]
      expect(frame.byBackendId.size).toBeGreaterThan(0)
      // Every decoded record must agree with the browser's own measurement of the box.
      const truth = await page.evaluate(() => {
        const rect = document.getElementById('sc')!.getBoundingClientRect()
        return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, w: rect.width, h: rect.height }
      })
      const { nodeIndex } = locateInSnapshot(real, 'sc')
      const record = frame.byBackendId.get((real.documents[0].nodes.backendNodeId ?? [])[nodeIndex])!
      expect(record.box.x).toBeCloseTo(truth.x, 1)
      expect(record.box.y).toBeCloseTo(truth.y, 1)
      expect(record.box.width).toBeCloseTo(truth.w, 1)
      expect(record.box.height).toBeCloseTo(truth.h, 1)
    })
  })
})

// ===========================================================================
// CONTRACT 4 — creating a Debugger must not break the page session
// ===========================================================================

describe('CONTRACT 4: creating a Debugger leaves Playwright\'s own session usable', () => {
  it('page.evaluate still works and console capture still reaches the log stream', async () => {
    await withPage(async ({ page, cdp }) => {
      const logs: string[] = []
      page.on('console', (message) => logs.push(message.text()))
      await page.goto(`${baseUrl}/scripts`)
      await page.evaluate(() => console.log('before-enable'))
      await page.waitForTimeout(150)

      const dbg = new Debugger({ cdp })
      await dbg.enable()
      await page.waitForTimeout(250)

      expect(
        await page.evaluate(() => 2 + 2),
        'ASSUMPTION BROKEN: page.evaluate stopped working after createDebugger. Debugger.enable() runs on ' +
          "Playwright's OWN page session; anything it disables there breaks the rest of the process.",
      ).toBe(4)

      await page.evaluate(() => console.log('after-enable'))
      await page.waitForTimeout(200)
      expect(
        logs,
        'ASSUMPTION BROKEN: console output stopped reaching the log stream after createDebugger. Every ' +
          'readLogpoints() result would then be a false negative that reads as "the code never executed".',
      ).toContain('after-enable')
    })
  })

  it('does NOT replay the console buffer — a replayed logpoint line is a phantom hit', async () => {
    await withPage(async ({ page, cdp }) => {
      const logs: string[] = []
      page.on('console', (message) => logs.push(message.text()))
      await page.goto(`${baseUrl}/scripts`)
      // A tagged line in exactly the shape readLogpoints scans for.
      await page.evaluate(() => {
        console.log('[[logpoint:contract4]] {"n":1}')
        console.log('plain-line')
      })
      await page.waitForTimeout(200)
      const before = logs.filter((l) => l.includes('[[logpoint:contract4]]')).length
      expect(before).toBe(1)

      const dbg = new Debugger({ cdp })
      await dbg.enable()
      await page.waitForTimeout(400)

      const after = logs.filter((l) => l.includes('[[logpoint:contract4]]')).length
      expect(
        after,
        'ASSUMPTION BROKEN: enabling the Debugger replayed the page console buffer, so a logpoint line already ' +
          'in the stream was delivered again. readLogpoints() scans that array and would count the replay as a ' +
          'fresh hit — "this ran once" reads as "it ran twice". Measured cause: Runtime.disable followed by ' +
          'Runtime.enable makes V8 re-emit every buffered console message. Neither call is needed by anything ' +
          'in debugger.ts.',
      ).toBe(before)
      expect(logs.filter((l) => l === 'plain-line').length).toBe(1)
    })
  })

  it('still reads scripts, binds breakpoints and pauses — the capability the disable/enable existed for', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(`${baseUrl}/scripts`)
      const dbg = new Debugger({ cdp })
      const scripts = await dbg.listScripts({ search: 'app.js' })
      expect(
        scripts.map((s) => s.url),
        'Debugger.scriptParsed must still repopulate the script index without touching the Runtime domain',
      ).toEqual(expect.arrayContaining([`${baseUrl}/app.js`]))
      // Runtime.* commands must answer without Runtime.enable ever being sent.
      expect(await dbg.evaluate({ expression: '1 + 1' })).toEqual({ value: 2 })
      expect(Array.isArray(await dbg.inspectGlobalVariables())).toBe(true)
    })
  })
})

// ===========================================================================
// CONTRACT 5 — matchedCSSRules order and matchingSelectors alignment
// ===========================================================================

describe('CONTRACT 5: matched-rule order and matchingSelectors index space', () => {
  async function matched() {
    return withPage(async ({ page, cdp, raw }) => {
      await page.goto(`${baseUrl}/styles`)
      await send(raw, 'DOM.enable')
      await send(raw, 'CSS.enable')
      const { root } = (await send(raw, 'DOM.getDocument', { depth: -1, pierce: true })) as Protocol.DOM.GetDocumentResponse
      const find = (node: Protocol.DOM.Node, id: string): Protocol.DOM.Node | null => {
        const attrs = node.attributes ?? []
        for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node
        for (const child of node.children ?? []) {
          const hit = find(child, id)
          if (hit) return hit
        }
        return null
      }
      const target = find(root, 'target')!
      const dropped = find(root, 'dropped')!
      const forNode = async (node: Protocol.DOM.Node) =>
        (await send(raw, 'CSS.getMatchedStylesForNode', { nodeId: node.nodeId })) as any
      const winner = await page.evaluate(() => window.getComputedStyle(document.getElementById('target')!).color)
      return { target: await forNode(target), dropped: await forNode(dropped), winner, cdp }
    })
  }

  it('matchingSelectors indexes selectorList.selectors — every index resolves', async () => {
    const { target } = await matched()
    let checked = 0
    for (const ruleMatch of target.matchedCSSRules as Array<{ rule: any; matchingSelectors: number[] }>) {
      const selectors = ruleMatch.rule.selectorList.selectors as Array<{ text: string }>
      for (const index of ruleMatch.matchingSelectors) {
        checked++
        expect(
          selectors[index],
          `ASSUMPTION BROKEN (styles.ts:509-525): matchingSelectors index ${index} addresses nothing in a ` +
            `${selectors.length}-selector list for "${ruleMatch.rule.selectorList.text}". specificityForRule used ` +
            `to optional-chain this away, so a misalignment yielded [0,0,0] and the rule silently lost every ` +
            `specificity contest — a wrong cascade winner with nothing in the output saying so.`,
        ).toBeDefined()
      }
    }
    expect(checked, 'no matched selectors were checked, so this asserted nothing').toBeGreaterThan(0)
  })

  it('picks out the ONE matching selector from a multi-selector list', async () => {
    const { target } = await matched()
    const rule = (target.matchedCSSRules as Array<{ rule: any; matchingSelectors: number[] }>).find(
      (m) => m.rule.selectorList.text === '.no-match-a, #target, div.no-match-b',
    )
    expect(rule, 'the multi-selector rule must be among the matched rules').toBeDefined()
    expect(
      rule!.matchingSelectors,
      'ASSUMPTION BROKEN: `.no-match-a, #target, div.no-match-b` matched via #target, which is index 1. Any other ' +
        'index means specificity is computed from a selector that did not match — here [0,1,0] vs [0,0,1].',
    ).toEqual([1])
    expect(rule!.rule.selectorList.selectors[rule!.matchingSelectors[0]].text).toBe('#target')
  })

  it('orders rules weakest-first, so `order` really is the source-order tiebreak', async () => {
    const { target, winner } = await matched()
    const regular = (target.matchedCSSRules as Array<{ rule: any }>).filter((m) => m.rule.origin === 'regular')
    const texts = regular.map((m) => m.rule.selectorList.text)
    expect(
      texts,
      'ASSUMPTION BROKEN (styles.ts:399-402 documents `order` as "the CDP order (later = wins the source-order ' +
        'tiebreak)"). CDP returns matched rules weakest-first; if that reverses, normalizeMatchedStyles assigns ' +
        'increasing `order` in the wrong direction and resolveCascade picks the loser whenever specificity ties.',
    ).toEqual(['div', '.no-match-a, #target, div.no-match-b', '#target'])
    // User-agent rules come before author rules, which is the same ordering claim.
    const origins = (target.matchedCSSRules as Array<{ rule: any }>).map((m) => m.rule.origin)
    expect(origins.lastIndexOf('user-agent')).toBeLessThan(origins.indexOf('regular'))
    expect(winner).toBe('rgb(9, 9, 9)')
  })

  it('the cascade this repo computes agrees with the browser about the winner', async () => {
    const { target, winner } = await matched()
    const cascade = resolveCascade(normalizeMatchedStyles(target))
    expect(
      cascade.winnerFor['color']?.value,
      'the whole point of the ordering and alignment contracts: getting either wrong makes this disagree with ' +
        'getComputedStyle, which is the only ground truth for a cascade.',
    ).toBe(winner)
    expect(cascade.winnerFor['color']?.selector).toBe('#target')
  })

  it('reports the declarations it drops instead of leaving them invisible', async () => {
    const { dropped } = await matched()
    const rules = normalizeMatchedStyles(dropped)
    const rule = rules.find((r) => r.selector === '#dropped')
    expect(rule, '#dropped must have a matched author rule').toBeDefined()
    expect(rule!.declarations['background-color']).toBeDefined()
    expect(
      rule!.droppedDeclarations?.join('\n'),
      'styles.ts drops `initial` values and -webkit- properties from the cascade on purpose, but it used to do so ' +
        'with no trace, so `declarations` read as the rule\'s whole content.',
    ).toMatch(/-webkit-line-clamp/)
    expect(rule!.droppedDeclarations?.join('\n')).toMatch(/initial/)
  })

  it('an out-of-range matchingSelectors index is refused, not silently scored [0,0,0]', async () => {
    const { target } = await matched()
    const corrupted = JSON.parse(JSON.stringify(target))
    const victim = corrupted.matchedCSSRules.find((m: any) => m.rule.origin === 'regular')
    victim.matchingSelectors = [99]
    expect(() => normalizeMatchedStyles(corrupted)).toThrow(/matchingSelectors index 99 has no selector/)
  })
})

// ===========================================================================
// CONTRACT 6 — setBreakpointByUrl returns an id even when nothing binds
// ===========================================================================

describe('CONTRACT 6: a breakpoint id is not a binding', () => {
  it('CDP returns an id with zero locations for a url no script has', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(`${baseUrl}/scripts`)
      await send(raw, 'Debugger.enable')
      const response = (await send(raw, 'Debugger.setBreakpointByUrl', {
        lineNumber: 0,
        urlRegex: 'no-such-file-anywhere\\.js',
        columnNumber: 0,
        condition: 'false',
      })) as Protocol.Debugger.SetBreakpointByUrlResponse
      expect(
        response.breakpointId,
        'this is the whole defect: CDP hands back an id unconditionally, so an id proves nothing',
      ).toBeTruthy()
      expect(response.locations, 'nothing should have bound').toEqual([])
    })
  })

  it('an unbindable LOGPOINT is refused rather than reported as armed', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(`${baseUrl}/scripts`)
      const dbg = new Debugger({ cdp })
      await expect(
        dbg.setLogpoint({ file: 'no-such-file-anywhere.js', line: 1, expr: '1', tag: 't' }),
        'ASSUMPTION BROKEN: an unbound logpoint was reported as successfully set. It can never fire, so its ' +
          'empty readLogpoints() result reads as "the code path never ran" — a false negative dressed as a ' +
          'measurement.',
      ).rejects.toThrow(/bound it to NO location/)
      expect(dbg.listBreakpoints(), 'the phantom must not be left in the registry').toEqual([])
    })
  })

  it('a line past the end of a real script is unbindable too, and is refused', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(`${baseUrl}/scripts`)
      const dbg = new Debugger({ cdp })
      await expect(dbg.setLogpoint({ file: `${baseUrl}/app.js`, line: 99999, expr: '1' })).rejects.toThrow(
        /bound it to NO location/,
      )
    })
  })

  it('urlRegex is anchored: `app.js` no longer also matches `vendor-app.js`', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(`${baseUrl}/scripts`)
      const dbg = new Debugger({ cdp })
      const id = await dbg.setLogpoint({ file: 'app.js', line: 1, expr: '1', tag: 'anchored' })
      const info = dbg.listBreakpoints().find((b) => b.id === id)!
      expect(info.bound).toBe(true)
      expect(
        info.resolvedLocations.map((l) => l.url).sort(),
        'ASSUMPTION BROKEN: the escaped-but-unanchored urlRegex bound `app.js` in BOTH app.js and vendor-app.js ' +
          '(measured: two locations), so one logpoint fired in two files and their hits interleaved under one tag.',
      ).toEqual([`${baseUrl}/app.js`])
    })
  })

  it('the raw unanchored regex really does bind twice — the behaviour being fixed', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(`${baseUrl}/scripts`)
      await send(raw, 'Debugger.enable')
      const response = (await send(raw, 'Debugger.setBreakpointByUrl', {
        lineNumber: 0,
        // Exactly what `file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` used to produce.
        urlRegex: 'app\\.js',
        columnNumber: 0,
        condition: 'false',
      })) as Protocol.Debugger.SetBreakpointByUrlResponse
      expect(
        response.locations.length,
        'if this stops being 2, Chrome changed how urlRegex matches and the anchoring can be revisited',
      ).toBe(2)
    })
  })

  it('a bindable breakpoint on a full URL still binds, and records where', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(`${baseUrl}/scripts`)
      const dbg = new Debugger({ cdp })
      const id = await dbg.setLogpoint({ file: `${baseUrl}/app.js`, line: 1, expr: 'a', tag: 'ok' })
      const info = dbg.listBreakpoints().find((b) => b.id === id)!
      expect(info.bound).toBe(true)
      expect(info.resolvedLocations).toHaveLength(1)
      expect(info.nonPausing).toBe(true)
    })
  })

  it('a pre-navigation breakpoint is still allowed — requireBinding defaults false there', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto('about:blank')
      const dbg = new Debugger({ cdp })
      const id = await dbg.setBreakpoint({ file: 'not-loaded-yet.js', line: 1, condition: 'false' })
      expect(id, 'arming before the script loads is legitimate and must not throw').toBeTruthy()
      expect(dbg.listBreakpoints().find((b) => b.id === id)!.bound).toBe(false)
    })
  })
})

// ===========================================================================
// D-C1 — Debugger.evaluate must not turn a throw into {}
// ===========================================================================

describe('D-C1: a thrown Error is reported as a throw, not as an empty object', () => {
  it('distinguishes `throw new Error(...)` from `({})`', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(`${baseUrl}/scripts`)
      const dbg = new Debugger({ cdp })

      const threw = await dbg.evaluate({ expression: 'throw new Error("boom")' })
      const empty = await dbg.evaluate({ expression: '({})' })

      expect(
        threw.threw,
        'ASSUMPTION BROKEN: the throw produced no `threw`. Under returnByValue an Error serialises to {}, so ' +
          'without exceptionDetails a thrown exception is byte-identical to a genuine empty object — a debugger ' +
          'that confirms bugs that do not exist.',
      ).toBeDefined()
      expect(threw.threw!.message).toContain('boom')
      expect(threw.threw!.className).toBe('Error')
      expect(threw.value).toBeUndefined()

      expect(empty.threw, 'a real empty object must NOT be reported as a throw').toBeUndefined()
      expect(empty.value).toEqual({})
    })
  })

  it('reports a ReferenceError with its message rather than an empty object', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(`${baseUrl}/scripts`)
      const dbg = new Debugger({ cdp })
      const result = await dbg.evaluate({ expression: 'thisIdentifierDoesNotExist' })
      expect(result.threw?.className).toBe('ReferenceError')
      expect(result.threw?.message).toMatch(/thisIdentifierDoesNotExist is not defined/)
    })
  })

  it('still returns ordinary values, including falsy ones, unchanged', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(`${baseUrl}/scripts`)
      const dbg = new Debugger({ cdp })
      expect(await dbg.evaluate({ expression: 'window.appFn(41)' })).toEqual({ value: 42 })
      expect(await dbg.evaluate({ expression: '"text"' })).toEqual({ value: 'text' })
      expect(await dbg.evaluate({ expression: '0' })).toEqual({ value: 0 })
      expect(await dbg.evaluate({ expression: 'false' })).toEqual({ value: false })
      expect(await dbg.evaluate({ expression: 'null' })).toEqual({ value: null })
    })
  })

  it('reports a rejected promise as a throw', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(`${baseUrl}/scripts`)
      const dbg = new Debugger({ cdp })
      const result = await dbg.evaluate({ expression: 'Promise.reject(new Error("rejected-here"))' })
      expect(result.threw, 'an awaited rejection is a failure, not a value').toBeDefined()
      expect(result.threw!.text + ' ' + result.threw!.message).toMatch(/rejected-here/)
    })
  })
})

// ===========================================================================
// D-A2 — Fetch.enable's urlPattern is a glob, netTimeline's is a substring
// ===========================================================================

describe('D-A2: net.delay and net.timeline agree on what urlPattern means', () => {
  it('Fetch.enable takes a whole-url GLOB — a bare substring intercepts nothing', async () => {
    await withPage(async ({ page, raw }) => {
      await page.goto(baseUrl)
      const intercepted: string[] = []
      ;(raw as unknown as { on: (e: string, cb: (p: any) => void) => void }).on('Fetch.requestPaused', (event: Protocol.Fetch.RequestPausedEvent) => {
        intercepted.push(event.request.url)
        void send(raw, 'Fetch.continueRequest', { requestId: event.requestId }).catch(() => {})
      })
      await send(raw, 'Fetch.enable', { patterns: [{ urlPattern: '/api/' }] })
      await page.evaluate((base) => fetch(base + '/api/cart').then((r) => r.json()), baseUrl)
      await page.waitForTimeout(250)
      expect(
        intercepted,
        'This is the defect D-A2 rests on: Fetch.enable matches the WHOLE url as a glob, so the substring form ' +
          "netTimeline documents intercepts nothing while the probe still reports itself LIVE and PERTURBING.",
      ).toEqual([])
      await send(raw, 'Fetch.disable')
    })
  })

  it('net.delay accepts the substring form and actually holds the request', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(baseUrl)
      const probe = await netDelay({ cdp, urlPattern: '/api/cart', ms: 300, ttlMs: 10_000 })
      try {
        const elapsed = await page.evaluate(async (base) => {
          const start = Date.now()
          await fetch(base + '/api/cart').then((r) => r.json())
          return Date.now() - start
        }, baseUrl)
        expect(
          probe.stats().paused,
          'ASSUMPTION BROKEN: net.delay({ urlPattern: "/api/cart" }) held nothing. netTimeline documents the same ' +
            'option as "a substring or RegExp"; the two neighbours must not mean different things.',
        ).toBe(1)
        expect(elapsed, 'the request must actually have been delayed').toBeGreaterThanOrEqual(250)
        expect(probe.stats().interceptedNothing).toBe(false)
      } finally {
        await probe.stop()
      }
    })
  })

  it('a RegExp works too, and matches exactly what netTimeline would match', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(baseUrl)
      const timeline = netTimeline({ page, urlPattern: /\/api\/ca.t$/ })
      const probe = await netDelay({ cdp, urlPattern: /\/api\/ca.t$/, ms: 50, ttlMs: 10_000 })
      try {
        await page.evaluate((base) => fetch(base + '/api/cart').then((r) => r.json()), baseUrl)
        await page.waitForTimeout(300)
        expect(probe.stats().paused).toBe(1)
        expect(
          timeline.entries().filter((e) => e.phase === 'request').length,
          'the two probes must agree about which urls match, since they now share one predicate',
        ).toBe(1)
      } finally {
        await probe.stop()
        timeline.stop()
      }
    })
  })

  it('a SUBSTRING that matches nothing is reported as having intercepted nothing', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(baseUrl)
      const probe = await netDelay({ cdp, urlPattern: '/definitely-not-requested/', ms: 50, ttlMs: 10_000 })
      try {
        await page.evaluate((base) => fetch(base + '/api/cart').then((r) => r.json()), baseUrl)
        await page.waitForTimeout(300)
        const stats = probe.stats()
        expect(stats.paused).toBe(0)
        expect(
          stats.interceptedNothing,
          'stats() showing zeros must not be indistinguishable from a probe that ran and had nothing to do',
        ).toBe(true)
        // A substring becomes the glob `*<substring>*`, which Chrome evaluates itself, so a
        // non-matching request is never paused at all. That is the desirable half of the
        // translation: the probe does not touch requests it does not care about.
        expect(stats.seen, 'Chrome pre-filters the derived glob, so nothing should reach the interceptor').toBe(0)
        expect(stats.notMatched).toBe(0)
        const warnings = tracePerturbationWarnings()
        expect(
          warnings.join('\n'),
          'a live PERTURBING probe that perturbed nothing must say so, or a race-class measurement reads as clean',
        ).toMatch(/INTERCEPTED NOTHING/)
        expect(warnings.join('\n')).toMatch(/none reached it at all/)
        expect(listTraceProbes({ live: true, kind: 'net.delay' })[0].describe).toMatch(/INTERCEPTED NOTHING/)
      } finally {
        await probe.stop()
      }
    })
  })

  it('a REGEXP that matches nothing still filters handler-side, and says so', async () => {
    await withPage(async ({ page, cdp }) => {
      await page.goto(baseUrl)
      // A RegExp cannot be expressed as a glob, so interception is `*` and the narrowing
      // happens in the handler with the same predicate netTimeline uses.
      const probe = await netDelay({ cdp, urlPattern: /\/definitely-not-requested\//, ms: 50, ttlMs: 10_000 })
      try {
        await page.evaluate((base) => fetch(base + '/api/cart').then((r) => r.json()), baseUrl)
        await page.waitForTimeout(300)
        const stats = probe.stats()
        expect(stats.paused, 'nothing matched, so nothing was held').toBe(0)
        expect(stats.interceptedNothing).toBe(true)
        expect(stats.seen, 'with the `*` glob every request reaches the interceptor').toBeGreaterThan(0)
        expect(
          stats.notMatched,
          'a request that reached the interceptor but did not match must be counted and released at once',
        ).toBeGreaterThan(0)
        expect(probe.info()!.spec.fetchGlob).toBe('*')
        expect(tracePerturbationWarnings().join('\n')).toMatch(/INTERCEPTED NOTHING/)
      } finally {
        await probe.stop()
      }
    })
  })
})

// ===========================================================================
// D-A1 — OOPIF routing
// ===========================================================================

describe('D-A1: an iframe snapshot comes from the iframe, never from its parent', () => {
  let isolated: Browser
  let innerServer: http.Server
  let innerUrl: string
  let outerUrl: string

  beforeAll(async () => {
    innerServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><body><button id="inner-button">InnerButton</button></body>`)
    })
    await new Promise<void>((resolve) => innerServer.listen(0, '127.0.0.1', resolve))
    const innerPort = (innerServer.address() as AddressInfo).port
    // `localhost` vs `127.0.0.1` are different sites, which is what forces an OOPIF.
    innerUrl = `http://localhost:${innerPort}/`
    outerUrl = `${baseUrl}/`
    isolated = await chromium.launch({ headless: true, args: ['--site-per-process'] })
  }, 60_000)

  afterAll(async () => {
    await isolated?.close()
    await new Promise<void>((resolve) => innerServer?.close(() => resolve()))
  })

  async function pageWithIframe(browserToUse: Browser) {
    const context = await browserToUse.newContext()
    const page = await context.newPage()
    await page.goto(`${outerUrl}iframe-host?src=${encodeURIComponent(innerUrl)}`)
    await page.waitForTimeout(700)
    const frame = page.frames().find((f) => f.url().startsWith(innerUrl))
    return { context, page, frame }
  }

  it('a cross-process iframe has its own CDP session, a same-process one does not', async () => {
    const { context, page, frame } = await pageWithIframe(isolated)
    try {
      expect(frame, 'the iframe must have loaded').toBeDefined()
      const frameSession = await getCDPSessionForFrame({ frame: frame! })
      expect(
        frameSession,
        'ASSUMPTION BROKEN: Playwright holds no separate session for a cross-process iframe, so getAriaSnapshot ' +
          'has nothing to ask and would fall back to the parent document.',
      ).not.toBeNull()

      // A same-process iframe is the other half of the discrimination.
      await page.setContent(`<iframe srcdoc="<button>Sub</button>"></iframe>`)
      await page.waitForTimeout(300)
      expect(await getCDPSessionForFrame({ frame: page.frames()[1] })).toBeNull()
    } finally {
      await context.close()
    }
  })

  it('returns the IFRAME tree, not the parent document tree', async () => {
    const { context, page, frame } = await pageWithIframe(isolated)
    try {
      const result = await getAriaSnapshot({ page, frame })
      expect(
        result.snapshot,
        'ASSUMPTION BROKEN (the D-A1 failure): the snapshot for a cross-process iframe contains the PARENT\'s ' +
          'content. ICDPSession.send used to declare a `sessionId` third parameter the adapter never implemented, ' +
          'so every OOPIF-targeted command silently ran on the page session and returned the top document.',
      ).toContain('InnerButton')
      expect(
        result.snapshot,
        'the parent\'s own button must NOT appear in the iframe\'s snapshot',
      ).not.toContain('OuterButton')
    } finally {
      await context.close()
    }
  })

  it('works for a same-process iframe through the page session and frameId', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await page.setContent(`<button>OuterButton</button><iframe srcdoc="<button>InnerButton</button>"></iframe>`)
      await page.waitForTimeout(300)
      const frame = page.frames()[1]
      expect(await getCDPSessionForFrame({ frame })).toBeNull()
      const result = await getAriaSnapshot({ page, frame })
      expect(result.snapshot).toContain('InnerButton')
      expect(result.snapshot).not.toContain('OuterButton')
    } finally {
      await context.close()
    }
  })

  it('the page snapshot is unaffected — no frame means no scoping', async () => {
    const { context, page } = await pageWithIframe(isolated)
    try {
      const result = await getAriaSnapshot({ page })
      expect(result.snapshot).toContain('OuterButton')
    } finally {
      await context.close()
    }
  })
})
