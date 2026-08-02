/**
 * page-model-geometry.test.ts — the geometry / visibility / occlusion / diff substrate.
 *
 * Everything here runs against SYNTHETIC `DOMSnapshot.captureSnapshot` payloads built by
 * `buildCaptureSnapshot`, which now lives in `capture-snapshot-fixture.ts`. The builder
 * emits the real wire shape — one shared `strings` table that every other table indexes
 * into (with -1 for "absent"), a `layout` table joined to the node table through
 * `nodeIndex`, and genuinely sparse `RareBooleanData` index lists — because a simplified
 * fake would prove nothing about the decoder, which is the part that can silently
 * attribute a value to the wrong node or the wrong property.
 *
 * The builder is NOT trusted on its own say-so, which is the whole reason it moved out of
 * this file: `browser-contracts.test.ts` captures a REAL snapshot from a real headless
 * Chromium and asserts that `describeSnapshotShape` of the two agree. These tests stay
 * pure and browser-free; the generator's fidelity to Chrome is proven separately, so it
 * can no longer drift from Chrome silently the way it did before.
 */

import { describe, it, expect } from 'vitest'
import type { Protocol } from 'devtools-protocol'
import type { AriaSnapshotNode } from './aria-snapshot.js'
import type { ICDPSession } from './cdp-session.js'
import {
  buildPageModelFromRaw,
  decodeCaptureSnapshot,
  PAGE_MODEL_COMPUTED_STYLES,
  MOVED_THRESHOLD_PX,
  type Box,
  type FrameGeometry,
  type ModelDomInfo,
} from './page-model.js'
import {
  buildCaptureSnapshot,
  type FixtureDocument,
  type FixtureLayout,
  type FixtureNode,
} from './capture-snapshot-fixture.js'
import { computeElementPath, resolveElementNode } from './styles.js'

const VISIBLE_BLOCK: Record<string, string> = {
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  'pointer-events': 'auto',
  'overflow-x': 'visible',
  'overflow-y': 'visible',
  position: 'static',
  'z-index': 'auto',
}

const FRAME = 'frame-1'
const VIEWPORT: Box = { x: 0, y: 0, width: 800, height: 600 }

function geometryFor(documents: FixtureDocument[], viewports: Record<string, Box> = { [FRAME]: VIEWPORT }) {
  return decodeCaptureSnapshot({ snapshot: buildCaptureSnapshot({ documents }), viewports })
}

/** aria node shorthand */
function aria(
  backendNodeId: number,
  role: string,
  name: string,
  children: AriaSnapshotNode[] = [],
): AriaSnapshotNode {
  return { role, name, backendNodeId, locator: `role=${role}[name="${name}"]`, children }
}

function domIndex(entries: Array<[number, string, Record<string, string>?]>): Map<number, ModelDomInfo> {
  return new Map(entries.map(([id, nodeName, attributes]) => [id, { nodeName, attributes: attributes ?? {} }]))
}

// ---------------------------------------------------------------------------
// A page shape reused by several tests
// ---------------------------------------------------------------------------

/**
 *  html > body > [ button#save > span,  div#overlay ]
 * `overlay` paints last, so it covers the button.
 */
function pageFixture(opts: {
  overlayBounds?: [number, number, number, number]
  overlayStyles?: Record<string, string>
  buttonBounds?: [number, number, number, number]
  buttonStyles?: Record<string, string>
  hiddenBoxStyles?: Record<string, string>
  /** Drop the button's layout record entirely (display:none). */
  buttonUnrendered?: boolean
  includeOverlay?: boolean
}): FixtureDocument[] {
  const button: FixtureNode = {
    backendNodeId: 10,
    nodeName: 'BUTTON',
    attributes: { id: 'save' },
    clickable: true,
    ...(opts.buttonUnrendered
      ? {}
      : {
          layout: {
            bounds: opts.buttonBounds ?? [100, 100, 100, 40],
            styles: { ...VISIBLE_BLOCK, ...(opts.buttonStyles ?? {}) },
            paintOrder: 5,
          },
        }),
    children: [
      {
        backendNodeId: 11,
        nodeName: 'SPAN',
        layout: { bounds: [110, 110, 80, 20], styles: { ...VISIBLE_BLOCK }, paintOrder: 6 },
        children: [
          {
            backendNodeId: 12,
            nodeName: '#text',
            nodeType: 3,
            layout: { bounds: [110, 110, 80, 20], styles: { ...VISIBLE_BLOCK }, paintOrder: 7, text: 'Save' },
          },
        ],
      },
    ],
  }

  const overlay: FixtureNode = {
    backendNodeId: 20,
    nodeName: 'DIV',
    attributes: { id: 'overlay', class: 'modal backdrop' },
    layout: {
      bounds: opts.overlayBounds ?? [0, 0, 800, 600],
      styles: { ...VISIBLE_BLOCK, position: 'fixed', 'z-index': '10', ...(opts.overlayStyles ?? {}) },
      paintOrder: 10,
      stackingContext: true,
    },
  }

  const hiddenBox: FixtureNode = {
    backendNodeId: 30,
    nodeName: 'DIV',
    attributes: { id: 'hidden-box' },
    layout: {
      bounds: [0, 700, 200, 50],
      styles: { ...VISIBLE_BLOCK, ...(opts.hiddenBoxStyles ?? { visibility: 'hidden' }) },
      paintOrder: 4,
    },
  }

  const scrolledOut: FixtureNode = {
    backendNodeId: 40,
    nodeName: 'SECTION',
    attributes: { id: 'below-fold' },
    layout: { bounds: [0, 1200, 800, 300], styles: { ...VISIBLE_BLOCK }, paintOrder: 3 },
  }

  const displayNone: FixtureNode = {
    backendNodeId: 50,
    nodeName: 'DIV',
    attributes: { id: 'gone' },
    // No `layout` at all — exactly how a display:none node appears in the payload.
  }

  return [
    {
      frameId: FRAME,
      root: {
        backendNodeId: 1,
        nodeName: '#document',
        nodeType: 9,
        children: [
          {
            backendNodeId: 2,
            nodeName: 'HTML',
            layout: { bounds: [0, 0, 800, 2000], styles: { ...VISIBLE_BLOCK }, paintOrder: 0 },
            children: [
              {
                backendNodeId: 3,
                nodeName: 'BODY',
                layout: { bounds: [0, 0, 800, 2000], styles: { ...VISIBLE_BLOCK }, paintOrder: 1 },
                children: [
                  button,
                  hiddenBox,
                  scrolledOut,
                  displayNone,
                  ...(opts.includeOverlay === false ? [] : [overlay]),
                ],
              },
            ],
          },
        ],
      },
    },
  ]
}

function pageAria(): AriaSnapshotNode[] {
  return [
    aria(2, 'document', 'page', [
      aria(3, 'generic', 'body', [
        aria(10, 'button', 'Save', [aria(11, 'text', 'Save')]),
        aria(30, 'generic', 'hidden box'),
        aria(40, 'region', 'below fold'),
        aria(50, 'generic', 'gone'),
        aria(20, 'generic', 'overlay'),
      ]),
    ]),
  ]
}

function buildPage(opts: Parameters<typeof pageFixture>[0] = {}) {
  const geometry = geometryFor(pageFixture(opts))
  return buildPageModelFromRaw({
    ariaTree: pageAria(),
    domByBackendId: domIndex([
      [2, 'HTML'],
      [3, 'BODY'],
      [10, 'BUTTON', { id: 'save' }],
      [11, 'SPAN'],
      [20, 'DIV', { id: 'overlay', class: 'modal backdrop' }],
      [30, 'DIV', { id: 'hidden-box' }],
      [40, 'SECTION', { id: 'below-fold' }],
      [50, 'DIV', { id: 'gone' }],
    ]),
    frameId: FRAME,
    geometry,
  })
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

describe('decodeCaptureSnapshot', () => {
  it('joins the layout table to the node table and resolves the string table', () => {
    const geometry = geometryFor(pageFixture({}))
    const frame = geometry.get(FRAME)!
    expect(frame.frameId).toBe(FRAME)

    const button = frame.byBackendId.get(10)!
    expect(button.box).toEqual({ x: 100, y: 100, width: 100, height: 40 })
    expect(button.nodeName).toBe('BUTTON')
    expect(button.label).toBe('button#save')
    expect(button.paintOrder).toBe(5)
    expect(button.styles.display).toBe('block')
    expect(button.styles.position).toBe('static')
    // -1 string indexes must decode to "absent", not to strings[0].
    expect(button.styles['clip-path']).toBeUndefined()
    expect(button.styles['mix-blend-mode']).toBeUndefined()
  })

  it('decodes stackingContexts as a sparse LAYOUT index list', () => {
    const frame = geometryFor(pageFixture({})).get(FRAME)!
    expect(frame.byBackendId.get(20)!.stackingContext).toBe(true)
    expect(frame.byBackendId.get(10)!.stackingContext).toBe(false)
    expect(frame.byBackendId.get(3)!.stackingContext).toBe(false)
  })

  it('keeps nodes that have no layout object out of the layout index', () => {
    const frame = geometryFor(pageFixture({})).get(FRAME)!
    expect(frame.byBackendId.has(50)).toBe(false)
    // ...but they are still known to be in the document.
    expect(frame.documentBackendIds.has(50)).toBe(true)
  })

  it('the fixture emits the #document layout entry Chrome emits, with an empty styles array', () => {
    // Guards the generator itself: this shape is why the decoder threw against a real
    // page while 67 unit tests agreed with each other.
    const snapshot = buildCaptureSnapshot({ documents: pageFixture({}) })
    const layout = snapshot.documents[0].layout
    const nodes = snapshot.documents[0].nodes
    const documentLayoutIndex = layout.nodeIndex.findIndex((nodeIndex) => nodes.nodeType![nodeIndex] === 9)
    expect(documentLayoutIndex).toBeGreaterThanOrEqual(0)
    expect(layout.styles[documentLayoutIndex]).toEqual([])
    // ...and every element/text entry carries the full positional list.
    for (let i = 0; i < layout.nodeIndex.length; i++) {
      if (i === documentLayoutIndex) continue
      expect(layout.styles[i]).toHaveLength(PAGE_MODEL_COMPUTED_STYLES.length)
    }
  })

  it('accepts an empty styles array (a layout node with no computed style) as "no styles"', () => {
    const frame = geometryFor(pageFixture({})).get(FRAME)!
    // backendNodeId 1 is the #document node of the fixture.
    const documentRecord = frame.byBackendId.get(1)!
    expect(documentRecord.nodeType).toBe(9)
    expect(documentRecord.styles).toEqual({})
    expect(documentRecord.box).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })

  it('still throws on a non-empty styles array of the wrong length', () => {
    const snapshot = buildCaptureSnapshot({ documents: pageFixture({}) })
    // Index 1 is the first element entry; truncating it is real positional misalignment.
    snapshot.documents[0].layout.styles[1] = [0, 1]
    expect(() => decodeCaptureSnapshot({ snapshot })).toThrow(/style table is positional/)
  })

  it('throws on an out-of-range string index instead of decoding silence', () => {
    const snapshot = buildCaptureSnapshot({ documents: pageFixture({}) })
    snapshot.documents[0].nodes.nodeName![1] = 99999
    expect(() => decodeCaptureSnapshot({ snapshot })).toThrow(/out of range/)
  })

  it('a #document node with no computed styles flows through the rest of the pipeline', () => {
    // The a11y tree's RootWebArea maps to the #document node, so it really does end up
    // in the model on a live page.
    const geometry = geometryFor(pageFixture({}))
    const model = buildPageModelFromRaw({
      ariaTree: [aria(1, 'WebArea', 'page', [aria(10, 'button', 'Save')])],
      domByBackendId: domIndex([
        [1, '#document'],
        [10, 'BUTTON'],
      ]),
      frameId: FRAME,
      geometry,
    })
    const documentNode = model.byKey.get(`${FRAME}:1`)!
    expect(documentNode.runtime.rendered).toBe(true)
    // No `visibility`/`opacity` to hide it and a non-degenerate box: visible.
    expect(documentNode.runtime.visible).toBe(true)
    expect(documentNode.runtime.computedStyles).toEqual({})
    expect(documentNode.runtime.stackingContext).toBe(true)
    // Ground-truth stacking flag with no declaration to explain it — the reasons list is
    // derived from declarations, so it stays absent rather than inventing one.
    expect(documentNode.runtime.stackingReasons).toBeUndefined()
    // It is an ancestor of everything, so nothing in the page "occludes" it, and being a
    // non-element it never occludes anything either.
    expect(documentNode.runtime.occluded).toBeUndefined()
    expect(model.byKey.get(`${FRAME}:10`)!.runtime.occludedBy).toEqual([`${FRAME}:20`])
    // The diff must not see phantom style churn on it.
    const next = buildPageModelFromRaw({
      ariaTree: [aria(1, 'WebArea', 'page', [aria(10, 'button', 'Save')])],
      domByBackendId: domIndex([
        [1, '#document'],
        [10, 'BUTTON'],
      ]),
      frameId: FRAME,
      geometry,
    })
    next.diffAgainst(model)
    expect(next.byKey.get(`${FRAME}:1`)!.runtime.changedSince).toBeUndefined()
  })

  it('throws when the layout tables disagree in length', () => {
    const snapshot = buildCaptureSnapshot({ documents: pageFixture({}) })
    snapshot.documents[0].layout.bounds.pop()
    expect(() => decodeCaptureSnapshot({ snapshot })).toThrow(/layout tables disagree/)
  })

  it('keeps the outer box when a pseudo-element contributes two layout entries', () => {
    // Verified against Chromium: `::before` gets its OWN backendNodeId and contributes
    // both its block box and the inline box of its generated content, in that order.
    const documents: FixtureDocument[] = [
      {
        frameId: FRAME,
        root: {
          backendNodeId: 1,
          nodeName: '#document',
          nodeType: 9,
          children: [
            {
              backendNodeId: 2,
              nodeName: 'DIV',
              layout: { bounds: [8, 8, 1264, 30], styles: { ...VISIBLE_BLOCK }, paintOrder: 1 },
              children: [
                {
                  backendNodeId: 3,
                  nodeName: '::before',
                  layout: { bounds: [8, 8, 1264, 10], styles: { ...VISIBLE_BLOCK }, paintOrder: 1 },
                },
                {
                  // Same backendNodeId: the pseudo's inline content box.
                  backendNodeId: 3,
                  nodeName: '::before',
                  layout: { bounds: [8, 8, 11, 17], styles: { ...VISIBLE_BLOCK }, paintOrder: 1 },
                },
              ],
            },
          ],
        },
      },
    ]
    const frame = decodeCaptureSnapshot({ snapshot: buildCaptureSnapshot({ documents }) }).get(FRAME)!
    expect(frame.byBackendId.get(3)!.box).toEqual({ x: 8, y: 8, width: 1264, height: 10 })
    // The originating element keeps its own box — pseudo ids never overwrite it.
    expect(frame.byBackendId.get(2)!.box).toEqual({ x: 8, y: 8, width: 1264, height: 30 })
  })

  it('decodes a document whose only layout entry is its #document node', () => {
    // Verified against Chromium: a `display:none` iframe still yields a DocumentSnapshot,
    // with exactly one layout entry (the #document node) and an empty styles array.
    const documents: FixtureDocument[] = [
      { frameId: 'hidden-frame', root: { backendNodeId: 90, nodeName: '#document', nodeType: 9 } },
    ]
    const frame = decodeCaptureSnapshot({ snapshot: buildCaptureSnapshot({ documents }) }).get('hidden-frame')!
    expect(frame.byBackendId.size).toBe(1)
    expect(frame.byBackendId.get(90)!.styles).toEqual({})
  })

  it('keys a document with no frameId under a synthetic id instead of dropping it', () => {
    // Defensive: `frameId` is a required field and no capture in a real browser produced
    // an empty one, but a document Chromium cannot attribute to a frame still holds real
    // geometry, and dropping it would report its nodes as un-rendered.
    const snapshot = buildCaptureSnapshot({ documents: pageFixture({}) })
    snapshot.documents[0].frameId = -1
    const geometry = decodeCaptureSnapshot({ snapshot })
    expect([...geometry.keys()]).toEqual(['#unframed-document-0'])
    expect(geometry.get('#unframed-document-0')!.byBackendId.get(10)!.box).toEqual({
      x: 100,
      y: 100,
      width: 100,
      height: 40,
    })
  })
})

// ---------------------------------------------------------------------------
// visible / rendered / inViewport
// ---------------------------------------------------------------------------

describe('runtime.visible / rendered / inViewport', () => {
  it('a display:none node (absent from the layout tree) is not rendered and not visible', () => {
    const model = buildPage()
    const gone = model.byKey.get(`${FRAME}:50`)!
    expect(gone.runtime.rendered).toBe(false)
    expect(gone.runtime.visible).toBe(false)
    expect(gone.runtime.box).toBeUndefined()
    expect(gone.runtime.computedStyles).toEqual({})
  })

  it('a visibility:hidden node is rendered but not visible', () => {
    const model = buildPage()
    const hidden = model.byKey.get(`${FRAME}:30`)!
    expect(hidden.runtime.rendered).toBe(true)
    expect(hidden.runtime.visible).toBe(false)
    expect(hidden.runtime.box).toEqual({ x: 0, y: 700, width: 200, height: 50 })
  })

  it('an opacity:0 node is not visible', () => {
    const model = buildPage({ hiddenBoxStyles: { opacity: '0' } })
    expect(model.byKey.get(`${FRAME}:30`)!.runtime.visible).toBe(false)
  })

  it('opacity:0 on an ancestor hides descendants even though opacity is not inherited', () => {
    // The button keeps opacity:1; its BODY ancestor goes to 0.
    const documents = pageFixture({})
    const body = documents[0].root.children![0].children![0]
    body.layout!.styles = { ...VISIBLE_BLOCK, opacity: '0' }
    const model = buildPageModelFromRaw({
      ariaTree: pageAria(),
      domByBackendId: domIndex([[10, 'BUTTON']]),
      frameId: FRAME,
      geometry: decodeCaptureSnapshot({ snapshot: buildCaptureSnapshot({ documents }), viewports: { [FRAME]: VIEWPORT } }),
    })
    const button = model.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.computedStyles.opacity).toBe('1')
    expect(button.runtime.visible).toBe(false)
  })

  it('a scrolled-out node is visible but not in the viewport', () => {
    const model = buildPage()
    const belowFold = model.byKey.get(`${FRAME}:40`)!
    expect(belowFold.runtime.rendered).toBe(true)
    expect(belowFold.runtime.visible).toBe(true)
    expect(belowFold.runtime.inViewport).toBe(false)
    // ...and something inside the viewport is marked as such.
    expect(model.byKey.get(`${FRAME}:10`)!.runtime.inViewport).toBe(true)
  })

  it('a node scrolled out of an overflow:auto container is visible but not in the viewport', () => {
    const documents = pageFixture({})
    const body = documents[0].root.children![0].children![0]
    body.children!.push({
      backendNodeId: 60,
      nodeName: 'DIV',
      attributes: { id: 'scroller' },
      layout: {
        bounds: [0, 0, 300, 200],
        styles: { ...VISIBLE_BLOCK, 'overflow-y': 'auto', position: 'relative' },
        paintOrder: 2,
      },
      children: [
        {
          backendNodeId: 61,
          nodeName: 'LI',
          // Inside the viewport by absolute coordinates, but below the scroller's box.
          layout: { bounds: [0, 400, 300, 20], styles: { ...VISIBLE_BLOCK }, paintOrder: 2 },
        },
      ],
    })
    const model = buildPageModelFromRaw({
      ariaTree: [aria(61, 'listitem', 'row 40')],
      domByBackendId: domIndex([[61, 'LI']]),
      frameId: FRAME,
      geometry: decodeCaptureSnapshot({ snapshot: buildCaptureSnapshot({ documents }), viewports: { [FRAME]: VIEWPORT } }),
    })
    const row = model.byKey.get(`${FRAME}:61`)!
    expect(row.runtime.visible).toBe(true)
    expect(row.runtime.inViewport).toBe(false)
  })

  it('leaves inViewport undefined when the frame viewport is unknown', () => {
    const geometry = geometryFor(pageFixture({}), {})
    const model = buildPageModelFromRaw({
      ariaTree: pageAria(),
      domByBackendId: domIndex([[10, 'BUTTON']]),
      frameId: FRAME,
      geometry,
    })
    expect(model.byKey.get(`${FRAME}:10`)!.runtime.inViewport).toBeUndefined()
  })

  it('reports stacking-context ground truth with the declarations that explain it', () => {
    const model = buildPage()
    const overlay = model.byKey.get(`${FRAME}:20`)!
    expect(overlay.runtime.stackingContext).toBe(true)
    expect(overlay.runtime.stackingReasons).toContain('position:fixed')
    expect(model.byKey.get(`${FRAME}:10`)!.runtime.stackingContext).toBe(false)
  })

  it('visibleOnly / inViewportOnly actually filter, and are different filters', () => {
    const model = buildPage()
    const all = model.query({ fields: ['key'] }).map((row) => row.key)
    expect(all).toContain(`${FRAME}:30`) // visibility:hidden
    expect(all).toContain(`${FRAME}:40`) // scrolled out

    const visible = model.query({ visibleOnly: true, fields: ['key'] }).map((row) => row.key)
    expect(visible).not.toContain(`${FRAME}:30`)
    expect(visible).not.toContain(`${FRAME}:50`)
    expect(visible).toContain(`${FRAME}:40`) // scrolled out is still visible

    const onScreen = model.query({ inViewportOnly: true, fields: ['key'] }).map((row) => row.key)
    expect(onScreen).not.toContain(`${FRAME}:40`)
    expect(onScreen).toContain(`${FRAME}:10`)
  })

  it('VisibleElement / InViewportElement virtual types filter the same way', () => {
    const model = buildPage()
    const visible = model.query({ select: 'VisibleElement', fields: ['key'] }).map((row) => row.key)
    expect(visible).toContain(`${FRAME}:40`)
    expect(visible).not.toContain(`${FRAME}:30`)

    const onScreen = model.query({ select: 'InViewportElement', fields: ['key'] }).map((row) => row.key)
    expect(onScreen).not.toContain(`${FRAME}:40`)
  })
})

// ---------------------------------------------------------------------------
// Occlusion
// ---------------------------------------------------------------------------

describe('occlusion', () => {
  it('a full-page overlay marks the button fully occluded and names the overlay', () => {
    const model = buildPage()
    const button = model.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.occluded).toBe('full')
    expect(button.runtime.occludedFraction).toBe(1)
    expect(button.runtime.occludedBy).toEqual([`${FRAME}:20`])
    expect(button.runtime.occludedByLabels).toEqual(['div#overlay.modal.backdrop'])
  })

  it('a half-overlapping overlay reports partial, with the covered fraction', () => {
    const model = buildPage({ overlayBounds: [150, 100, 100, 40] })
    const button = model.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.occluded).toBe('partial')
    expect(button.runtime.occludedFraction).toBeCloseTo(0.5, 5)
    expect(button.runtime.occludedBy).toEqual([`${FRAME}:20`])
  })

  it('a child painting over its parent does not occlude the parent', () => {
    // No overlay at all: the only later-painting node covering the button is its own
    // span/text subtree.
    const model = buildPage({ includeOverlay: false })
    const button = model.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.occluded).toBeUndefined()
    expect(button.runtime.occludedBy).toBeUndefined()
  })

  it('an ancestor is not reported as occluded by its own descendant overlay', () => {
    const model = buildPage()
    // BODY contains the overlay, and the overlay paints later — but it is a descendant.
    expect(model.byKey.get(`${FRAME}:3`)!.runtime.occluded).toBeUndefined()
    expect(model.byKey.get(`${FRAME}:2`)!.runtime.occluded).toBeUndefined()
  })

  it('a pointer-events:none overlay does not occlude', () => {
    const model = buildPage({ overlayStyles: { 'pointer-events': 'none' } })
    expect(model.byKey.get(`${FRAME}:10`)!.runtime.occluded).toBeUndefined()
  })

  it('an invisible overlay (opacity 0 / visibility hidden) does not occlude', () => {
    expect(buildPage({ overlayStyles: { opacity: '0' } }).byKey.get(`${FRAME}:10`)!.runtime.occluded).toBeUndefined()
    expect(
      buildPage({ overlayStyles: { visibility: 'hidden' } }).byKey.get(`${FRAME}:10`)!.runtime.occluded,
    ).toBeUndefined()
  })

  it('a text box does not occlude its own element', () => {
    // The SPAN's text node paints last of the button subtree; neither may be an occluder
    // of the span (descendant + text-node rules).
    const model = buildPage({ includeOverlay: false })
    expect(model.byKey.get(`${FRAME}:11`)!.runtime.occluded).toBeUndefined()
  })

  it('OccludedElement / FullyOccludedElement select the occluded nodes', () => {
    const full = buildPage()
    expect(full.query({ select: 'FullyOccludedElement', fields: ['key'] }).map((r) => r.key)).toContain(`${FRAME}:10`)

    const partial = buildPage({ overlayBounds: [150, 100, 100, 40] })
    const occluded = partial.query({ select: 'OccludedElement', fields: ['key'] }).map((r) => r.key)
    expect(occluded).toContain(`${FRAME}:10`)
    expect(partial.query({ select: 'FullyOccludedElement', fields: ['key'] }).map((r) => r.key)).not.toContain(
      `${FRAME}:10`,
    )
  })

  it('two partial overlays that together cover the box report full', () => {
    const documents = pageFixture({ overlayBounds: [100, 100, 50, 40] })
    const body = documents[0].root.children![0].children![0]
    body.children!.push({
      backendNodeId: 21,
      nodeName: 'DIV',
      attributes: { id: 'overlay-2' },
      layout: { bounds: [150, 100, 50, 40], styles: { ...VISIBLE_BLOCK }, paintOrder: 11 },
    })
    const model = buildPageModelFromRaw({
      ariaTree: pageAria(),
      domByBackendId: domIndex([[10, 'BUTTON']]),
      frameId: FRAME,
      geometry: decodeCaptureSnapshot({ snapshot: buildCaptureSnapshot({ documents }), viewports: { [FRAME]: VIEWPORT } }),
    })
    const button = model.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.occluded).toBe('full')
    // Topmost first.
    expect(button.runtime.occludedBy).toEqual([`${FRAME}:21`, `${FRAME}:20`])
  })
})

// ---------------------------------------------------------------------------
// anchor({x, y})
// ---------------------------------------------------------------------------

describe('anchor({x, y})', () => {
  /** Two overlapping siblings; `first` appears first in the tree. */
  function stacked(firstPaintOrder: number, secondPaintOrder: number) {
    const documents: FixtureDocument[] = [
      {
        frameId: FRAME,
        root: {
          backendNodeId: 1,
          nodeName: '#document',
          nodeType: 9,
          children: [
            {
              backendNodeId: 2,
              nodeName: 'HTML',
              layout: { bounds: [0, 0, 800, 600], styles: { ...VISIBLE_BLOCK }, paintOrder: 0 },
              children: [
                {
                  backendNodeId: 70,
                  nodeName: 'BUTTON',
                  attributes: { id: 'first' },
                  layout: { bounds: [100, 100, 400, 400], styles: { ...VISIBLE_BLOCK }, paintOrder: firstPaintOrder },
                },
                {
                  backendNodeId: 71,
                  nodeName: 'DIV',
                  attributes: { id: 'second' },
                  layout: { bounds: [0, 0, 800, 600], styles: { ...VISIBLE_BLOCK }, paintOrder: secondPaintOrder },
                },
              ],
            },
          ],
        },
      },
    ]
    return buildPageModelFromRaw({
      // Tree order: `first` before `second`, deliberately the opposite of paint order
      // in one of the two cases below.
      ariaTree: [aria(70, 'button', 'first'), aria(71, 'generic', 'second')],
      domByBackendId: domIndex([
        [70, 'BUTTON'],
        [71, 'DIV'],
      ]),
      frameId: FRAME,
      geometry: decodeCaptureSnapshot({ snapshot: buildCaptureSnapshot({ documents }), viewports: { [FRAME]: VIEWPORT } }),
    })
  }

  it('returns the topmost node by paint order, not the first in tree order', () => {
    const model = stacked(5, 9)
    expect(model.anchor({ x: 200, y: 200 })!.key).toBe(`${FRAME}:71`)
  })

  it('returns the earlier-painted node when it is on top, even though it is later in the tree', () => {
    const model = stacked(9, 5)
    expect(model.anchor({ x: 200, y: 200 })!.key).toBe(`${FRAME}:70`)
  })

  it('ignores nodes that are not visible', () => {
    const model = buildPage()
    // (100, 720) is inside the visibility:hidden box and inside BODY.
    const handle = model.anchor({ x: 100, y: 720 })
    expect(handle).not.toBeNull()
    expect(handle!.key).not.toBe(`${FRAME}:30`)
  })

  it('returns null when no box contains the point', () => {
    const model = buildPage()
    expect(model.anchor({ x: 5000, y: 5000 })).toBeNull()
  })
})

describe('anchorAt (ground-truth hit test)', () => {
  function stubCdp(backendNodeId: number, calls: any[]): ICDPSession {
    return {
      async send(method: string, params?: any) {
        calls.push({ method, params })
        if (method === 'DOM.getNodeForLocation') return { backendNodeId, nodeId: 0 }
        return {}
      },
    } as unknown as ICDPSession
  }

  it('converts document coordinates to viewport coordinates and climbs to a known node', async () => {
    const calls: any[] = []
    const geometry = geometryFor(pageFixture({}), { [FRAME]: { x: 0, y: 600, width: 800, height: 600 } })
    const model = buildPageModelFromRaw({
      ariaTree: [aria(10, 'button', 'Save')],
      domByBackendId: domIndex([[10, 'BUTTON']]),
      frameId: FRAME,
      geometry,
      // The hit lands on the SPAN (11), which is NOT in the model.
      deps: { cdp: stubCdp(11, calls) },
    })
    const handle = await model.anchorAt({ x: 120, y: 700 })
    const hitCall = calls.find((call) => call.method === 'DOM.getNodeForLocation')
    expect(hitCall.params).toEqual({ x: 120, y: 100 })
    expect(handle!.key).toBe(`${FRAME}:10`)
  })

  it('throws instead of guessing when there is no CDP session', async () => {
    const model = buildPage()
    await expect(model.anchorAt({ x: 1, y: 1 })).rejects.toThrow(/CDP session/)
  })
})

// ---------------------------------------------------------------------------
// diffAgainst
// ---------------------------------------------------------------------------

describe('diffAgainst', () => {
  it("reports 'new' for a key absent from the previous model", () => {
    const prev = buildPage()
    const next = buildPage()
    // Drop the button from the previous model so it looks new.
    prev.byKey.delete(`${FRAME}:10`)
    next.diffAgainst(prev)
    expect(next.byKey.get(`${FRAME}:10`)!.runtime.changedSince).toBe('new')
    expect(next.byKey.get(`${FRAME}:10`)!.runtime.changes).toEqual([{ kind: 'new' }])
  })

  it("reports 'moved' with the delta when the box changes", () => {
    const prev = buildPage()
    const next = buildPage({ buttonBounds: [100, 140, 100, 40] })
    next.diffAgainst(prev)
    const button = next.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.changedSince).toBe('moved')
    const moved = button.runtime.changes!.find((change) => change.kind === 'moved')!
    expect(moved.delta).toEqual({ dx: 0, dy: 40, dw: 0, dh: 0 })
    expect(moved.from).toEqual({ x: 100, y: 100, width: 100, height: 40 })
  })

  it('does not report sub-threshold box jitter as movement', () => {
    const jitter = MOVED_THRESHOLD_PX * 0.8
    const prev = buildPage()
    const next = buildPage({ buttonBounds: [100 + jitter, 100 - jitter, 100 + jitter, 40] })
    next.diffAgainst(prev)
    const button = next.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.changes?.some((change) => change.kind === 'moved') ?? false).toBe(false)
    expect(button.runtime.changedSince).toBeUndefined()
  })

  it("reports 'style' naming exactly which properties changed", () => {
    const prev = buildPage()
    const next = buildPage({ buttonStyles: { opacity: '0.4', 'z-index': '3' } })
    next.diffAgainst(prev)
    const button = next.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.changedSince).toBe('style')
    const style = button.runtime.changes!.find((change) => change.kind === 'style')!
    expect(style.properties).toEqual([
      { property: 'opacity', from: '1', to: '0.4' },
      { property: 'z-index', from: 'auto', to: '3' },
    ])
  })

  it("reports 'removed' on the model, with enough identity to recognise the node", () => {
    const prev = buildPage()
    const next = buildPage()
    next.byKey.delete(`${FRAME}:10`)
    next.diffAgainst(prev)
    expect(next.removedKeys).toContain(`${FRAME}:10`)
    const record = next.removed.find((entry) => entry.key === `${FRAME}:10`)!
    expect(record.role).toBe('button')
    expect(record.name).toBe('Save')
    expect(record.tag).toBe('button')
    expect(record.box).toEqual({ x: 100, y: 100, width: 100, height: 40 })
  })

  it('lists removed nodes in renderText, since they have no node to tag', () => {
    const prev = buildPage()
    const next = buildPage()
    next.byKey.delete(`${FRAME}:10`)
    next.diffAgainst(prev)
    expect(next.renderText()).toContain('- button "Save" *removed')
    expect(next.renderText({ includeRemoved: false })).not.toContain('*removed')
  })

  it("reports 'hidden' when a node stops being rendered instead of a style storm", () => {
    const prev = buildPage()
    const next = buildPage({ buttonUnrendered: true })
    next.diffAgainst(prev)
    const button = next.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.changedSince).toBe('hidden')
    expect(button.runtime.changes).toHaveLength(1)
    expect(button.runtime.changes![0].reason).toMatch(/no longer rendered/)
  })

  it("reports 'shown' when a node starts being rendered", () => {
    const prev = buildPage({ buttonUnrendered: true })
    const next = buildPage()
    next.diffAgainst(prev)
    expect(next.byKey.get(`${FRAME}:10`)!.runtime.changedSince).toBe('shown')
  })

  it('records several simultaneous changes and keeps the dominant one in changedSince', () => {
    const prev = buildPage()
    const next = buildPage({ buttonBounds: [300, 100, 100, 40], buttonStyles: { opacity: '0.4' } })
    next.diffAgainst(prev)
    const button = next.byKey.get(`${FRAME}:10`)!
    expect(button.runtime.changes!.map((change) => change.kind).sort()).toEqual(['moved', 'style'])
    expect(button.runtime.changedSince).toBe('moved')
  })

  it('leaves unchanged nodes untagged', () => {
    const prev = buildPage()
    const next = buildPage()
    next.diffAgainst(prev)
    expect(next.byKey.get(`${FRAME}:10`)!.runtime.changedSince).toBeUndefined()
    expect(next.removed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Per-frame keying (OOPIF)
// ---------------------------------------------------------------------------

describe('per-frame keying', () => {
  function frameDoc(
    frameId: string,
    bounds: [number, number, number, number],
    documentBackendNodeId = 1,
  ): FixtureDocument {
    return {
      frameId,
      root: {
        // Within one capture, backendNodeIds are unique across documents (verified
        // against Chromium), so a second document in the SAME response needs its own id.
        backendNodeId: documentBackendNodeId,
        nodeName: '#document',
        nodeType: 9,
        children: [
          {
            backendNodeId: 11,
            nodeName: 'BUTTON',
            attributes: { id: frameId },
            layout: { bounds, styles: { ...VISIBLE_BLOCK }, paintOrder: 1 },
          },
        ],
      },
    }
  }

  it('the same backendNodeId in two frames produces two distinct nodes with their own geometry', () => {
    // OOPIFs are separate captures (separate processes), so they arrive as separate
    // responses merged into one map — which is also the only way the same backendNodeId
    // can legitimately appear twice.
    const geometry = decodeCaptureSnapshot({
      snapshot: buildCaptureSnapshot({ documents: [frameDoc('frame-a', [0, 0, 100, 20])] }),
      viewports: { 'frame-a': VIEWPORT },
    })
    decodeCaptureSnapshot({
      snapshot: buildCaptureSnapshot({ documents: [frameDoc('frame-b', [500, 300, 60, 30])] }),
      viewports: { 'frame-b': VIEWPORT },
      into: geometry,
    })
    expect([...geometry.keys()]).toEqual(['frame-a', 'frame-b'])

    const modelA = buildPageModelFromRaw({
      ariaTree: [aria(11, 'button', 'A')],
      domByBackendId: domIndex([[11, 'BUTTON']]),
      frameId: 'frame-a',
      geometry,
    })
    const modelB = buildPageModelFromRaw({
      ariaTree: [aria(11, 'button', 'B')],
      domByBackendId: domIndex([[11, 'BUTTON']]),
      frameId: 'frame-b',
      geometry,
    })

    expect(modelA.byKey.has('frame-a:11')).toBe(true)
    expect(modelA.byKey.has('frame-b:11')).toBe(false)
    expect(modelB.byKey.has('frame-b:11')).toBe(true)
    expect(modelB.byKey.has('frame-a:11')).toBe(false)
    expect(modelA.byKey.get('frame-a:11')!.runtime.box).toEqual({ x: 0, y: 0, width: 100, height: 20 })
    expect(modelB.byKey.get('frame-b:11')!.runtime.box).toEqual({ x: 500, y: 300, width: 60, height: 30 })
  })

  it('resolves a node that lives in a same-process iframe document of the same capture', () => {
    // One capture, two documents: the a11y tree reported node 11 under the main frame,
    // but its layout record lives in the child document.
    //
    // Verified against Chromium: the child document's bounds are in the CHILD's own
    // coordinate space — a button at y=10 inside an iframe positioned at y=200 in its
    // parent reports y=10, not y=210. The parent offset is deliberately NOT added here,
    // and boxes are never compared across documents because of it.
    const snapshot = buildCaptureSnapshot({
      documents: [
        {
          frameId: FRAME,
          root: {
            backendNodeId: 1,
            nodeName: '#document',
            nodeType: 9,
            children: [
              {
                backendNodeId: 2,
                nodeName: 'IFRAME',
                layout: { bounds: [0, 200, 400, 300], styles: { ...VISIBLE_BLOCK }, paintOrder: 1 },
              },
            ],
          },
        },
        frameDoc('child-frame', [10, 10, 80, 24], 90),
      ],
    })
    const geometry = decodeCaptureSnapshot({ snapshot, viewports: { [FRAME]: VIEWPORT } })
    const model = buildPageModelFromRaw({
      ariaTree: [aria(11, 'button', 'inside iframe')],
      domByBackendId: domIndex([[11, 'BUTTON']]),
      frameId: FRAME,
      geometry,
    })
    const node = model.byKey.get(`${FRAME}:11`)!
    expect(node.runtime.rendered).toBe(true)
    expect(node.runtime.box).toEqual({ x: 10, y: 10, width: 80, height: 24 })
  })

  it('refuses to build a model for a frame the geometry does not cover', () => {
    const geometry = decodeCaptureSnapshot({
      snapshot: buildCaptureSnapshot({ documents: [frameDoc('frame-a', [0, 0, 100, 20])] }),
    })
    // The old behaviour was a whole tree of `visible: true` nodes nobody had measured.
    expect(() =>
      buildPageModelFromRaw({
        ariaTree: [aria(11, 'button', 'B')],
        domByBackendId: domIndex([[11, 'BUTTON']]),
        frameId: 'frame-b',
        geometry,
      }),
    ).toThrow(/no layout snapshot for frame frame-b/)
  })
})

// ---------------------------------------------------------------------------
// Unmeasurable nodes
// ---------------------------------------------------------------------------

describe('nodes that cannot be measured report no visibility at all', () => {
  it('an a11y-only node (no backendNodeId) has neither visible nor rendered', () => {
    const geometry = geometryFor(pageFixture({}))
    const model = buildPageModelFromRaw({
      ariaTree: [aria(10, 'button', 'Save', [{ role: 'text', name: 'Save', children: [] }])],
      domByBackendId: domIndex([[10, 'BUTTON']]),
      frameId: FRAME,
      geometry,
    })
    const ariaOnly = model.root.children[0].children[0]
    expect(ariaOnly.runtime.visible).toBeUndefined()
    expect(ariaOnly.runtime.rendered).toBeUndefined()
    // ...and it can never be mistaken for a visible node.
    expect(model.query({ visibleOnly: true, fields: ['name'] }).map((row) => row.name)).not.toContain('Save the text')
  })

  it('a backendNodeId in no captured document is unmeasurable, NOT "not rendered"', () => {
    // 999 is in the a11y tree but in no document of the capture — user-agent shadow
    // content looks exactly like this. Claiming `rendered: false` for it would be a
    // measurement nobody made.
    const geometry = geometryFor(pageFixture({}))
    const model = buildPageModelFromRaw({
      ariaTree: [aria(999, 'slider', 'volume')],
      domByBackendId: domIndex([[999, 'INPUT']]),
      frameId: FRAME,
      geometry,
    })
    const node = model.byKey.get(`${FRAME}:999`)!
    expect(node.runtime.visible).toBeUndefined()
    expect(node.runtime.rendered).toBeUndefined()
    expect(node.runtime.box).toBeUndefined()
  })

  it('an unmeasurable node is excluded by visibleOnly and by VisibleElement', () => {
    const geometry = geometryFor(pageFixture({}))
    const model = buildPageModelFromRaw({
      ariaTree: [aria(999, 'slider', 'volume')],
      domByBackendId: domIndex([[999, 'INPUT']]),
      frameId: FRAME,
      geometry,
    })
    expect(model.query({ visibleOnly: true, fields: ['key'] }).map((row) => row.key)).not.toContain(`${FRAME}:999`)
    expect(model.query({ select: 'VisibleElement', fields: ['key'] }).map((row) => row.key)).not.toContain(
      `${FRAME}:999`,
    )
  })

  it('the synthetic document root claims no visibility either', () => {
    const model = buildPage()
    expect(model.root.runtime.visible).toBeUndefined()
    expect(model.root.runtime.rendered).toBeUndefined()
  })

  it('does not report a visibility change for a node that is unmeasurable on either side', () => {
    const geometry = geometryFor(pageFixture({}))
    const build = () =>
      buildPageModelFromRaw({
        ariaTree: [aria(999, 'slider', 'volume')],
        domByBackendId: domIndex([[999, 'INPUT']]),
        frameId: FRAME,
        geometry,
      })
    const next = build()
    next.diffAgainst(build())
    expect(next.byKey.get(`${FRAME}:999`)!.runtime.changedSince).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

describe('query scope', () => {
  it('an unmatched `within` throws rather than silently widening to the whole document', () => {
    const model = buildPage()
    expect(() => model.query({ within: 'main' })).toThrow(/matched no node/)
    // The old behaviour returned every node in the document for exactly this input.
    expect(() => model.query({ within: 'main' })).toThrow(/page-path selector/)
  })

  it('an unmatched deprecated `scope` throws too', () => {
    const model = buildPage()
    expect(() => model.query({ scope: '.card' })).toThrow(/matched no node/)
  })

  it('a matching `within` restricts the projection to that subtree', () => {
    const model = buildPage()
    const rows = model.query({ within: 'element#save', fields: ['key'] }).map((row) => row.key)
    expect(rows).toContain(`${FRAME}:10`)
    expect(rows).not.toContain(`${FRAME}:20`)
    expect(rows).not.toContain(`${FRAME}:3`)
  })

  it('`within` and the deprecated `scope` must not disagree', () => {
    const model = buildPage()
    expect(() => model.query({ within: 'element#save', scope: 'element#overlay' })).toThrow(/disagree/)
  })

  it('projects each node once even when scopes nest', () => {
    const model = buildPage()
    const rows = model.query({ within: '*', fields: ['key'] })
    const keys = rows.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

// ---------------------------------------------------------------------------
// The computed-style request list
// ---------------------------------------------------------------------------

describe('PAGE_MODEL_COMPUTED_STYLES', () => {
  it('is a short, de-duplicated list covering every property the predicates consume', () => {
    expect(new Set(PAGE_MODEL_COMPUTED_STYLES).size).toBe(PAGE_MODEL_COMPUTED_STYLES.length)
    for (const property of [
      'display',
      'visibility',
      'opacity',
      'content-visibility',
      'pointer-events',
      'overflow-x',
      'overflow-y',
      'position',
      'z-index',
    ]) {
      expect(PAGE_MODEL_COMPUTED_STYLES).toContain(property)
    }
    // Nothing token-list-shaped sneaked in.
    expect(PAGE_MODEL_COMPUTED_STYLES.length).toBeLessThan(20)
  })

  it('every requested property is decoded onto the node under its own name', () => {
    const styles: Record<string, string> = {}
    for (const property of PAGE_MODEL_COMPUTED_STYLES) styles[property] = `v-${property}`
    const documents: FixtureDocument[] = [
      {
        frameId: FRAME,
        root: {
          backendNodeId: 1,
          nodeName: '#document',
          nodeType: 9,
          children: [{ backendNodeId: 2, nodeName: 'DIV', layout: { bounds: [0, 0, 10, 10], styles } }],
        },
      },
    ]
    const frame = decodeCaptureSnapshot({ snapshot: buildCaptureSnapshot({ documents }) }).get(FRAME) as FrameGeometry
    const record = frame.byBackendId.get(2)!
    for (const property of PAGE_MODEL_COMPUTED_STYLES) {
      expect(record.styles[property]).toBe(`v-${property}`)
    }
  })
})

// ---------------------------------------------------------------------------
// styles.ts — element identity (the old code resolved by screen point)
// ---------------------------------------------------------------------------

/**
 * A hand-built stand-in for the page-side DOM. `computeElementPath` runs in the browser
 * via `String(fn)`, so calling it directly on these objects is exactly what the page
 * does — which is the point: the page half of the resolver is tested, not stubbed out.
 */
function fakeElement(tagName: string, children: any[] = []): any {
  const node: any = { nodeType: 1, tagName, children, parentElement: null, _root: null }
  node.getRootNode = () => node._root
  for (const child of children) child.parentElement = node
  return node
}

function setRoot(node: any, root: any): void {
  node._root = root
  for (const child of node.children ?? []) setRoot(child, root)
}

function fakeDocument(documentElement: any, frameElement: any = null): any {
  const doc: any = { nodeType: 9, children: [documentElement], defaultView: { frameElement } }
  setRoot(documentElement, doc)
  return doc
}

function fakeShadowRoot(host: any, children: any[]): any {
  const shadowRoot: any = { nodeType: 11, host, children }
  for (const child of children) {
    setRoot(child, shadowRoot)
    child.parentElement = null
  }
  return shadowRoot
}

describe('computeElementPath (page side)', () => {
  it('describes a plain document path as element child indexes', () => {
    const target = fakeElement('SPAN')
    const body = fakeElement('BODY', [fakeElement('HEADER'), fakeElement('DIV', [fakeElement('P'), target])])
    const html = fakeElement('HTML', [fakeElement('HEAD'), body])
    fakeDocument(html)

    expect(computeElementPath(target)).toEqual({
      hops: [{ enter: 'document', path: [1, 1, 1] }],
      tagName: 'span',
    })
  })

  it('describes the document element itself as an empty path', () => {
    const html = fakeElement('HTML', [])
    fakeDocument(html)
    expect(computeElementPath(html)).toEqual({ hops: [{ enter: 'document', path: [] }], tagName: 'html' })
  })

  it('splits the path at a shadow-root boundary', () => {
    const target = fakeElement('BUTTON')
    const shadowChild = fakeElement('DIV', [target])
    const host = fakeElement('MY-WIDGET')
    fakeShadowRoot(host, [shadowChild])
    const body = fakeElement('BODY', [host])
    const html = fakeElement('HTML', [body])
    fakeDocument(html)

    expect(computeElementPath(target)).toEqual({
      hops: [
        { enter: 'document', path: [0, 0] },
        { enter: 'shadow', path: [0, 0] },
      ],
      tagName: 'button',
    })
  })

  it('splits the path at an iframe boundary', () => {
    const target = fakeElement('INPUT')
    const innerHtml = fakeElement('HTML', [fakeElement('BODY', [target])])
    const iframe = fakeElement('IFRAME')
    fakeDocument(innerHtml, iframe)
    const outerHtml = fakeElement('HTML', [fakeElement('BODY', [fakeElement('NAV'), iframe])])
    fakeDocument(outerHtml)

    expect(computeElementPath(target)).toEqual({
      hops: [
        { enter: 'document', path: [0, 1] },
        { enter: 'frame', path: [0, 0] },
      ],
      tagName: 'input',
    })
  })

  it('reports a cross-origin iframe instead of guessing', () => {
    const target = fakeElement('INPUT')
    const html = fakeElement('HTML', [target])
    const doc: any = {
      nodeType: 9,
      children: [html],
      get defaultView() {
        return {
          get frameElement(): any {
            throw new Error('SecurityError: blocked a frame with origin ... from accessing a cross-origin frame')
          },
        }
      },
    }
    setRoot(html, doc)
    expect(computeElementPath(target).error).toMatch(/cross-origin iframe/)
  })

  it('reports a detached element instead of guessing', () => {
    const orphan = fakeElement('DIV')
    expect(computeElementPath(orphan).error).toMatch(/detached/)
  })
})

describe('resolveElementNode', () => {
  /** A CDP node tree mirroring `documentTree` below. */
  function cdpNode(nodeId: number, nodeName: string, children: any[] = [], extra: any = {}): any {
    return { nodeId, backendNodeId: nodeId + 1000, nodeName, nodeType: 1, children, ...extra }
  }

  function stubSession(root: any, calls: string[] = []) {
    const cdp = {
      async send(method: string) {
        calls.push(method)
        if (method === 'DOM.getDocument') return { root }
        return {}
      },
    } as unknown as ICDPSession
    return { cdp, calls }
  }

  function stubLocator(target: any) {
    return {
      async elementHandle() {
        return { async evaluate(fn: any) { return fn(target) } }
      },
    } as any
  }

  it('resolves the element through its own node, not the topmost node at a point', async () => {
    // Page side: BODY > [HEADER, DIV > [P, SPAN(target)]]
    const target = fakeElement('SPAN')
    const div = fakeElement('DIV', [fakeElement('P'), target])
    const body = fakeElement('BODY', [fakeElement('HEADER'), div])
    fakeDocument(fakeElement('HTML', [body]))

    const cdpSpan = cdpNode(7, 'SPAN')
    const cdpRoot = {
      nodeId: 1,
      backendNodeId: 1001,
      nodeName: '#document',
      nodeType: 9,
      children: [
        cdpNode(2, 'HTML', [
          cdpNode(3, 'BODY', [cdpNode(4, 'HEADER'), cdpNode(5, 'DIV', [cdpNode(6, 'P'), cdpSpan])]),
        ]),
      ],
    }
    const { cdp, calls } = stubSession(cdpRoot)
    const resolved = await resolveElementNode({ locator: stubLocator(target), cdp })
    expect(resolved.nodeId).toBe(7)
    expect(resolved.backendNodeId).toBe(1007)
    // getDocument doubles as the priming call CDP requires before it hands out node ids.
    expect(calls).toContain('DOM.getDocument')
  })

  it('walks into a shadow root, skipping user-agent shadow roots', async () => {
    const target = fakeElement('BUTTON')
    const host = fakeElement('MY-WIDGET')
    fakeShadowRoot(host, [fakeElement('DIV', [target])])
    fakeDocument(fakeElement('HTML', [fakeElement('BODY', [host])]))

    const cdpButton = cdpNode(9, 'BUTTON')
    const cdpHost = cdpNode(4, 'MY-WIDGET', [], {
      shadowRoots: [
        { nodeId: 90, backendNodeId: 1090, nodeName: '#document-fragment', nodeType: 11, shadowRootType: 'user-agent', children: [] },
        {
          nodeId: 7,
          backendNodeId: 1007,
          nodeName: '#document-fragment',
          nodeType: 11,
          shadowRootType: 'open',
          children: [cdpNode(8, 'DIV', [cdpButton])],
        },
      ],
    })
    const cdpRoot = {
      nodeId: 1,
      backendNodeId: 1001,
      nodeName: '#document',
      nodeType: 9,
      children: [cdpNode(2, 'HTML', [cdpNode(3, 'BODY', [cdpHost])])],
    }
    const { cdp } = stubSession(cdpRoot)
    expect((await resolveElementNode({ locator: stubLocator(target), cdp })).nodeId).toBe(9)
  })

  it('walks into a same-process iframe content document', async () => {
    const target = fakeElement('INPUT')
    const iframe = fakeElement('IFRAME')
    fakeDocument(fakeElement('HTML', [fakeElement('BODY', [target])]), iframe)
    fakeDocument(fakeElement('HTML', [fakeElement('BODY', [iframe])]))

    const cdpInput = cdpNode(9, 'INPUT')
    const cdpIframe = cdpNode(4, 'IFRAME', [], {
      contentDocument: {
        nodeId: 5,
        backendNodeId: 1005,
        nodeName: '#document',
        nodeType: 9,
        children: [cdpNode(6, 'HTML', [cdpNode(7, 'BODY', [cdpInput])])],
      },
    })
    const cdpRoot = {
      nodeId: 1,
      backendNodeId: 1001,
      nodeName: '#document',
      nodeType: 9,
      children: [cdpNode(2, 'HTML', [cdpNode(3, 'BODY', [cdpIframe])])],
    }
    const { cdp } = stubSession(cdpRoot)
    expect((await resolveElementNode({ locator: stubLocator(target), cdp })).nodeId).toBe(9)
  })

  it('fails loudly when the resolved node is not the target (DOM changed under us)', async () => {
    const target = fakeElement('SPAN')
    fakeDocument(fakeElement('HTML', [fakeElement('BODY', [target])]))
    // The CDP tree says that position holds a <b>, not the <span> the page reported.
    const cdpRoot = {
      nodeId: 1,
      backendNodeId: 1001,
      nodeName: '#document',
      nodeType: 9,
      children: [cdpNode(2, 'HTML', [cdpNode(3, 'BODY', [cdpNode(4, 'B')])])],
    }
    const { cdp } = stubSession(cdpRoot)
    await expect(resolveElementNode({ locator: stubLocator(target), cdp })).rejects.toThrow(
      /resolved to <b> but the locator points at <span>/,
    )
  })

  it('fails loudly for a cross-origin iframe rather than resolving a wrong node', async () => {
    const target = fakeElement('INPUT')
    const html = fakeElement('HTML', [target])
    const doc: any = {
      nodeType: 9,
      children: [html],
      get defaultView() {
        return {
          get frameElement(): any {
            throw new Error('SecurityError')
          },
        }
      },
    }
    setRoot(html, doc)
    const { cdp } = stubSession({ nodeId: 1, nodeName: '#document', nodeType: 9, children: [] })
    await expect(resolveElementNode({ locator: stubLocator(target), cdp })).rejects.toThrow(/cross-origin iframe/)
  })
})
