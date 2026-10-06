import { createMCPClient } from './mcp-client.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import type { Page } from '@xmorse/playwright-core'
import type { AriaSnapshotNode } from './aria-snapshot.js'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { imageSize } from 'image-size'
import { getCdpUrl } from './utils.js'
import { getCDPSessionForPage } from './cdp-session.js'
import type { CDPCommand } from './cdp-types.js'
import { getAriaSnapshot } from './aria-snapshot.js'
import { PageFrames } from './page-frames.js'
import { RefRegistry } from './ref-registry.js'
import { observePage } from './page-observe.js'
import { renderLabelledScreenshot } from './labelled-screenshot.js'
import { decodePng } from './png-pixels.js'
import {
  setupTestContext,
  cleanupTestContext,
  getExtensionServiceWorker,
  createSimpleServer,
  readPageFixture,
  isLocalOrInertRequestUrl,
  TEST_WORKSPACE,
  testRelayPort,
  type TestContext,
  js,
} from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)

/**
 * Floors for the labelled screenshot, one per committed page fixture.
 *
 * Floors rather than exact counts: how many elements observe() lists is allowed to change
 * without this test caring. What is NOT allowed is the number collapsing — which is exactly
 * what a live old.reddit.com did when it served headless Chromium a bot-check stub and the old
 * `expect(labelCount).toBeGreaterThan(0)` reported success on 3 labels for a page that should
 * have produced hundreds.
 *
 * `minLabels` counts only refs drawn inside the 1280x720 viewport, which is why it is so much
 * smaller than `minSnapshotLines` — that one covers the whole document. Both are set to roughly
 * half the observed value, so there is real room for drift before either means anything.
 */
const MIN_ARIA_LABELS = {
  wikipedia: { minLabels: 35, minSnapshotLines: 350 },
  hackerNews: { minLabels: 50, minSnapshotLines: 235 },
} as const

/**
 * How many times a measurement is retaken when the page moved out from under it.
 *
 * Two tests below compare something CDP reported — a screenshot clip, a
 * `Page.getLayoutMetrics` reply — against what the page reports about itself. Those are two
 * reads at two moments, and the viewport between them is not this test's to hold still:
 * three clients drive this suite's Chrome at once (the Playwright that launched it, the
 * extension's `chrome.debugger`, and the `connectOverCDP` client each test opens), and
 * Chrome's device-metrics emulation is state they share. Under full-suite load the settling
 * runs late enough to land in the middle of a test, and it did: one run had the screenshot
 * test capture a 720-tall clip and then read 581 off the page, while the layout-metrics test
 * in the same run read 581 where its inline snapshot said 720. The same two numbers, in
 * opposite directions, which is what a moving viewport looks like and what a real change in
 * behaviour does not.
 *
 * Retaking the sample is the fix, and it is not tolerance: every assertion downstream is an
 * exact equality against page-reported values, with no literal and no margin. What the retry
 * buys is only that both sides of that equality describe the same page state. A viewport
 * still moving after every attempt is not a settling race, so that is a failure and it
 * carries every reading it saw.
 *
 * This matters more than an ordinary flake because `pnpm test` is `vitest run -u`: the
 * layout-metrics expectation used to be a `toMatchInlineSnapshot`, so one unlucky run
 * silently REWROTE it to the wrong number and went green.
 */
const COHERENT_SAMPLE_ATTEMPTS = 5

async function coherentSample<P, M>({
  label,
  readPage,
  measure,
}: {
  /** What is being measured. Only used in the exhaustion message. */
  label: string
  /** The page's own account of itself. Taken before AND after `measure`. */
  readPage: () => Promise<P>
  /** The measurement that has to describe the same page state as `readPage`. */
  measure: () => Promise<M>
}): Promise<{ pageState: P; measured: M }> {
  const rejected: string[] = []
  for (let attempt = 1; attempt <= COHERENT_SAMPLE_ATTEMPTS; attempt++) {
    const before = await readPage()
    const measured = await measure()
    const after = await readPage()
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { pageState: before, measured }
    }
    rejected.push(`attempt ${attempt}: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  }
  throw new Error(
    `${label}: the page changed underneath all ${COHERENT_SAMPLE_ATTEMPTS} attempts, so nothing measured ` +
      `describes a single page state. This is not the settling race the retry exists for — something is ` +
      `resizing the viewport continuously.\n${rejected.join('\n')}`,
  )
}

describe('Snapshot & Screenshot Tests', () => {
  let client: Awaited<ReturnType<typeof createMCPClient>>['client']
  let cleanup: (() => Promise<void>) | null = null
  let testCtx: TestContext | null = null

  beforeAll(async () => {
    testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-snap-test-', toggleExtension: true })

    // Snapshot and screenshot tools through the relay, not the human-mode policy.
    const result = await createMCPClient({ port: TEST_PORT, policy: 'debug' })
    client = result.client
    cleanup = result.cleanup
  }, 600000)

  afterAll(async () => {
    await cleanupTestContext(testCtx, cleanup)
    cleanup = null
    testCtx = null
  })

  const getBrowserContext = () => {
    if (!testCtx?.browserContext) throw new Error('Browser not initialized')
    return testCtx.browserContext
  }

  it('should capture screenshot correctly', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('https://example.com/')
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )

    await new Promise((r) => setTimeout(r, 100))

    const capturedCommands: CDPCommand[] = []
    const commandHandler = ({ command }: { clientId: string; command: CDPCommand }) => {
      if (command.method === 'Page.captureScreenshot') {
        capturedCommands.push(command)
      }
    }
    testCtx!.relayServer.on('cdp:command', commandHandler)

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    const cdpPage = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes('example.com'))

    expect(cdpPage).toBeDefined()

    // viewportSize() is null over connectOverCDP (there is no emulated size to report), which is
    // why the assertions below measure the page instead. It is logged, not asserted: the old
    // `if (viewportSize)` guard around the dimension checks meant they never ran at all.
    console.log('Viewport size (emulated, null over CDP):', cdpPage!.viewportSize())

    // The two clips Playwright asked for are not free numbers — each is a documented function of
    // state the page itself can report, so the page is asked and the answer is compared:
    //
    //   viewport screenshot -> clip = window.innerWidth/innerHeight at the current scroll offset
    //                          (screenshotter.ts:176-180 _originalViewportSize, then
    //                           crPage.ts:250-258 adds visualViewport.pageX/pageY)
    //   fullPage screenshot -> clip = the max-of-six document size
    //                          (screenshotter.ts:183-201 _fullPageSize), and
    //                          captureBeyondViewport = !(that size fits the viewport)
    //                          (screenshotter.ts:213, crPage.ts:267)
    //
    // This replaces an inline snapshot that pinned height 581 for the full-page clip — the
    // height example.com happened to render to on one machine. It is not a constant: the
    // formula's `document.documentElement.clientHeight` term alone makes the full-page height at
    // least the viewport height, so a machine with a different window size records a different
    // number and the snapshot fails for a reason that has nothing to do with the relay.
    const readPageMetrics = async () =>
      await cdpPage!.evaluate(() => ({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: {
          x: window.visualViewport?.pageLeft ?? window.scrollX,
          y: window.visualViewport?.pageTop ?? window.scrollY,
        },
        devicePixelRatio: window.devicePixelRatio,
        fullPage: {
          width: Math.max(
            document.body.scrollWidth,
            document.documentElement.scrollWidth,
            document.body.offsetWidth,
            document.documentElement.offsetWidth,
            document.body.clientWidth,
            document.documentElement.clientWidth,
          ),
          height: Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
            document.body.offsetHeight,
            document.documentElement.offsetHeight,
            document.body.clientHeight,
            document.documentElement.clientHeight,
          ),
        },
      }))

    // Both captures and the reading they are compared against have to describe ONE viewport —
    // see COHERENT_SAMPLE_ATTEMPTS. Reading the page after the captures instead, as this test
    // did, is exactly how a 720-tall clip came to be compared against a 581-tall page.
    const { pageState: pageMetrics, measured } = await coherentSample({
      label: 'screenshot clips against the page-reported viewport',
      readPage: readPageMetrics,
      measure: async () => {
        // Each attempt is judged on its OWN commands. Keeping the previous attempt's entries
        // would assert a clip captured under the viewport that just moved.
        capturedCommands.length = 0
        const viewport = await cdpPage!.screenshot()
        const fullPage = await cdpPage!.screenshot({ fullPage: true })
        return { viewport, fullPage, commands: [...capturedCommands] }
      },
    })

    testCtx!.relayServer.off('cdp:command', commandHandler)

    const viewportScreenshot = measured.viewport
    expect(viewportScreenshot).toBeDefined()
    const viewportDimensions = imageSize(viewportScreenshot)
    console.log('Viewport screenshot dimensions:', viewportDimensions)

    const fullPageScreenshot = measured.fullPage
    expect(fullPageScreenshot).toBeDefined()
    const fullPageDimensions = imageSize(fullPageScreenshot)
    console.log('Full page screenshot dimensions:', fullPageDimensions)

    console.log('Page-reported metrics:', pageMetrics)

    const fullPageFitsViewport =
      pageMetrics.fullPage.width <= pageMetrics.viewport.width &&
      pageMetrics.fullPage.height <= pageMetrics.viewport.height

    expect(measured.commands.length).toBe(2)
    expect(
      measured.commands.map((c) => ({
        method: c.method,
        params: c.params,
      })),
    ).toEqual([
      {
        method: 'Page.captureScreenshot',
        params: {
          captureBeyondViewport: false,
          clip: {
            x: pageMetrics.scroll.x,
            y: pageMetrics.scroll.y,
            width: pageMetrics.viewport.width,
            height: pageMetrics.viewport.height,
            scale: 1,
          },
          format: 'png',
        },
      },
      {
        method: 'Page.captureScreenshot',
        params: {
          captureBeyondViewport: !fullPageFitsViewport,
          clip: {
            x: 0,
            y: 0,
            width: pageMetrics.fullPage.width,
            height: pageMetrics.fullPage.height,
            scale: 1,
          },
          format: 'png',
        },
      },
    ])

    // And the PNGs Chrome returned must be those clips, in device pixels. This is the assertion
    // the removed `if (viewportSize)` block was meant to be.
    expect({ width: viewportDimensions.width, height: viewportDimensions.height }).toEqual({
      width: pageMetrics.viewport.width * pageMetrics.devicePixelRatio,
      height: pageMetrics.viewport.height * pageMetrics.devicePixelRatio,
    })
    expect({ width: fullPageDimensions.width, height: fullPageDimensions.height }).toEqual({
      width: pageMetrics.fullPage.width * pageMetrics.devicePixelRatio,
      height: pageMetrics.fullPage.height * pageMetrics.devicePixelRatio,
    })

    const screenshotPath = path.join(os.tmpdir(), 'playwriter-test-screenshot.png')
    fs.writeFileSync(screenshotPath, viewportScreenshot)
    console.log('Screenshot saved to:', screenshotPath)

    await browser.close()
    await page.close()
  }, 60000)

  it('should match window.innerWidth/Height without clip param', async () => {
    // Proves that in connectOverCDP mode, Playwright already queries
    // window.innerWidth/innerHeight for viewport screenshots, so passing
    // a manual clip is redundant.
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('https://example.com/')
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    await new Promise((r) => setTimeout(r, 100))

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    const cdpPage = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes('example.com'))
    expect(cdpPage).toBeDefined()

    // Get actual browser viewport via JS
    const actualViewport = await cdpPage!.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    console.log('Actual viewport (window.inner*):', actualViewport)

    // Plain screenshot with scale:'css', NO clip
    const screenshot = await cdpPage!.screenshot({ scale: 'css' })
    const dimensions = imageSize(screenshot)
    console.log('Screenshot dimensions (no clip):', dimensions)

    expect(dimensions.width).toBe(actualViewport.width)
    expect(dimensions.height).toBe(actualViewport.height)

    await browser.close()
    await page.close()
  }, 60000)

  it('should capture element screenshot with correct coordinates', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const target = { x: 200, y: 150, width: 300, height: 100 }
    const scrolledTarget = { x: 100, y: 1500, width: 200, height: 80 }

    const page = await browserContext.newPage()
    await page.setContent(`
            <html>
                <head>
                    <style>
                        body { margin: 0; padding: 0; height: 2000px; }
                        #target {
                            position: absolute;
                            top: ${target.y}px;
                            left: ${target.x}px;
                            width: ${target.width}px;
                            height: ${target.height}px;
                            background: red;
                        }
                        #scrolled-target {
                            position: absolute;
                            top: ${scrolledTarget.y}px;
                            left: ${scrolledTarget.x}px;
                            width: ${scrolledTarget.width}px;
                            height: ${scrolledTarget.height}px;
                            background: blue;
                        }
                    </style>
                </head>
                <body>
                    <div id="target">Target Element</div>
                    <div id="scrolled-target">Scrolled Target</div>
                </body>
            </html>
        `)
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )

    await new Promise((r) => setTimeout(r, 400))

    const capturedCommands: CDPCommand[] = []
    const commandHandler = ({ command }: { clientId: string; command: CDPCommand }) => {
      if (command.method === 'Page.captureScreenshot') {
        capturedCommands.push(command)
      }
    }
    testCtx!.relayServer.on('cdp:command', commandHandler)

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    let cdpPage
    for (const p of browser.contexts()[0].pages()) {
      const html = await p.content()
      if (html.includes('scrolled-target')) {
        cdpPage = p
        break
      }
    }
    expect(cdpPage).toBeDefined()

    await cdpPage!.locator('#target').screenshot()

    await cdpPage!.locator('#scrolled-target').screenshot()

    testCtx!.relayServer.off('cdp:command', commandHandler)

    expect(capturedCommands.length).toBe(2)

    const targetCmd = capturedCommands[0]
    expect(targetCmd.method).toBe('Page.captureScreenshot')
    const targetClip = (targetCmd.params as any).clip
    expect(targetClip.x).toBe(target.x)
    expect(targetClip.y).toBe(target.y)
    expect(targetClip.width).toBe(target.width)
    expect(targetClip.height).toBe(target.height)

    const scrolledCmd = capturedCommands[1]
    expect(scrolledCmd.method).toBe('Page.captureScreenshot')
    const scrolledClip = (scrolledCmd.params as any).clip
    expect(scrolledClip.x).toBe(scrolledTarget.x)
    expect(scrolledClip.y).toBe(scrolledTarget.y)
    expect(scrolledClip.width).toBe(scrolledTarget.width)
    expect(scrolledClip.height).toBe(scrolledTarget.height)

    await browser.close()
    await page.close()
  }, 60000)

  it('should get locator string for element using getLocatorStringForElement', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.setContent(`
            <html>
                <body>
                    <button id="test-btn">Click Me</button>
                    <input type="text" placeholder="Enter name" />
                </body>
            </html>
        `)
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )

    await new Promise((r) => setTimeout(r, 400))

    const globalsBefore = await page.evaluate(() => Object.getOwnPropertyNames(globalThis).sort())
    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    let testPage;
                    for (const p of context.pages()) {
                        const html = await p.content();
                        if (html.includes('test-btn')) { testPage = p; break; }
                    }
                    if (!testPage) throw new Error('Test page not found');
                    const btn = testPage.locator('#test-btn');
                    const locatorString = await getLocatorStringForElement(btn);
                    console.log('Locator string:', locatorString);
                `,
        timeout: 30000,
      },
    })

    expect(result.isError).toBeFalsy()
    const text = (result.content as any)[0]?.text || ''
    const locatorString = text.match(/Locator string: (.+)/)?.[1]?.trim() ?? ''
    expect(locatorString).toBe("getByRole('button', { name: 'Click Me' })")
    // The string is a working locator: build it on the same tab, here in the test process (the
    // human-mode policy refuses eval in execute code, since it cannot read code built at run time).
    const locatorFromString = new Function('page', `return page.${locatorString}`)(page)
    expect(await locatorFromString.count()).toBe(1)
    expect(await locatorFromString.textContent()).toBe('Click Me')
    // The generator ran in playwriter's isolated world: the page's own globals are unchanged.
    expect(await page.evaluate(() => Object.getOwnPropertyNames(globalThis).sort())).toEqual(globalsBefore)

    await page.close()
  }, 60000)

  it('should get styles for element using getStylesForLocator', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.setContent(`
            <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; color: #333; }
                        .container { padding: 20px; margin: 10px; }
                        #main-btn { background-color: blue; color: white; border-radius: 4px; }
                        .btn { padding: 8px 16px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <button id="main-btn" class="btn" style="font-weight: bold;">Click Me</button>
                    </div>
                </body>
            </html>
        `)
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )

    await new Promise((r) => setTimeout(r, 400))

    const stylesResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    let testPage;
                    for (const p of context.pages()) {
                        const html = await p.content();
                        if (html.includes('main-btn')) { testPage = p; break; }
                    }
                    if (!testPage) throw new Error('Test page not found');
                    const btn = testPage.locator('#main-btn');
                    const styles = await getStylesForLocator({ locator: btn });
                    return styles;
                `,
        timeout: 30000,
      },
    })

    expect(stylesResult.isError).toBeFalsy()
    // A stylesheet id embeds a per-browser-process counter (`style-sheet-1205205-1`), so it
    // differs on every run. It only reaches the output when the sheet's real sourceURL is
    // unknown — which is the case for a `setContent` page here. Normalise the counter so the
    // snapshot can still pin the parts that matter: that `source` is populated at all, and
    // the exact line/column. Both were untestable before: `getStylesForLocator` read
    // `selectorList.range`, which current Chromium does not send, so `source` was `null` for
    // every rule and this snapshot recorded that bug as the expected result.
    const normalizeStyleSheetIds = (text: string): string => text.replace(/style-sheet-\d+-\d+/g, 'style-sheet-<id>')
    const stylesText = normalizeStyleSheetIds((stylesResult.content as any)[0]?.text || '')
    expect(stylesText).toMatchInlineSnapshot(`
      "[return value] {
        element: 'button#main-btn.btn',
        inlineStyle: { 'font-weight': 'bold' },
        rules: [
          {
            selector: '.btn',
            source: { url: 'stylesheet:style-sheet-<id>', line: 5, column: 24 },
            origin: 'regular',
            declarations: {
              padding: '8px 16px',
              'padding-top': '8px',
              'padding-right': '16px',
              'padding-bottom': '8px',
              'padding-left': '16px'
            },
            inheritedFrom: null
          },
          {
            selector: '#main-btn',
            source: { url: 'stylesheet:style-sheet-<id>', line: 4, column: 24 },
            origin: 'regular',
            declarations: {
              'background-color': 'blue',
              color: 'white',
              'border-radius': '4px',
              'border-top-left-radius': '4px',
              'border-top-right-radius': '4px',
              'border-bottom-right-radius': '4px',
              'border-bottom-left-radius': '4px'
            },
            inheritedFrom: null
          },
          {
            selector: '.container',
            source: { url: 'stylesheet:style-sheet-<id>', line: 3, column: 24 },
            origin: 'regular',
            declarations: {
              padding: '20px',
              margin: '10px',
              'padding-top': '20px',
              'padding-right': '20px',
              'padding-bottom': '20px',
              'padding-left': '20px',
              'margin-top': '10px',
              'margin-right': '10px',
              'margin-bottom': '10px',
              'margin-left': '10px'
            },
            inheritedFrom: 'ancestor[1]'
          },
          {
            selector: 'body',
            source: { url: 'stylesheet:style-sheet-<id>', line: 2, column: 24 },
            origin: 'regular',
            declarations: { 'font-family': 'Arial, sans-serif', color: 'rgb(51, 51, 51)' },
            inheritedFrom: 'ancestor[2]'
          }
        ]
      }"
    `)

    const formattedResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    let testPage;
                    for (const p of context.pages()) {
                        const html = await p.content();
                        if (html.includes('main-btn')) { testPage = p; break; }
                    }
                    if (!testPage) throw new Error('Test page not found');
                    const btn = testPage.locator('#main-btn');
                    const styles = await getStylesForLocator({ locator: btn });
                    return formatStylesAsText(styles);
                `,
        timeout: 30000,
      },
    })

    expect(formattedResult.isError).toBeFalsy()
    const formattedText = normalizeStyleSheetIds((formattedResult.content as any)[0]?.text || '')
    expect(formattedText).toMatchInlineSnapshot(`
      "[return value] Element: button#main-btn.btn

      Inline styles:
        font-weight: bold

      Matched rules:
        .btn {
          /* stylesheet:style-sheet-<id>:5:24 */
          padding: 8px 16px;
          padding-top: 8px;
          padding-right: 16px;
          padding-bottom: 8px;
          padding-left: 16px;
        }
        #main-btn {
          /* stylesheet:style-sheet-<id>:4:24 */
          background-color: blue;
          color: white;
          border-radius: 4px;
          border-top-left-radius: 4px;
          border-top-right-radius: 4px;
          border-bottom-right-radius: 4px;
          border-bottom-left-radius: 4px;
        }

      Inherited from ancestor[1]:
        .container {
          /* stylesheet:style-sheet-<id>:3:24 */
          padding: 20px;
          margin: 10px;
          padding-top: 20px;
          padding-right: 20px;
          padding-bottom: 20px;
          padding-left: 20px;
          margin-top: 10px;
          margin-right: 10px;
          margin-bottom: 10px;
          margin-left: 10px;
        }

      Inherited from ancestor[2]:
        body {
          /* stylesheet:style-sheet-<id>:2:24 */
          font-family: Arial, sans-serif;
          color: rgb(51, 51, 51);
        }"
    `)

    await page.close()
  }, 60000)

  it('should return correct layout metrics via CDP', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('https://example.com/')
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )

    await new Promise((r) => setTimeout(r, 100))

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    const cdpPage = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes('example.com'))
    expect(cdpPage).toBeDefined()

    const cdpSession = await getCDPSessionForPage({ page: cdpPage! })

    // What `Page.getLayoutMetrics` reports through the relay has to be the page's OWN viewport,
    // in the page's own numbers. That is the whole claim, and it is the one the relay can break.
    //
    // This used to be a `toMatchInlineSnapshot` pinning 1280x720 in five places. 1280x720 is not
    // a property of the relay at all — it is whatever size this suite's Chrome gave the tab, and
    // a full-suite run read 581 instead. Worse than failing: `pnpm test` is `vitest run -u`, so
    // that run would have REWRITTEN the expectation to 581 and gone green, shipping the wrong
    // number as the recorded truth. Nothing about the literal was ever the subject.
    const readPageViewport = async () =>
      await cdpPage!.evaluate(() => {
        const vv = window.visualViewport
        if (!vv) {
          throw new Error('window.visualViewport is unavailable, so CDP has nothing to be checked against')
        }
        return {
          layout: {
            pageX: window.scrollX,
            pageY: window.scrollY,
            clientWidth: document.documentElement.clientWidth,
            clientHeight: document.documentElement.clientHeight,
          },
          visual: {
            offsetX: vv.offsetLeft,
            offsetY: vv.offsetTop,
            pageX: vv.pageLeft,
            pageY: vv.pageTop,
            clientWidth: vv.width,
            clientHeight: vv.height,
            scale: vv.scale,
          },
          devicePixelRatio: window.devicePixelRatio,
        }
      })

    const { pageState: pageViewport, measured: layoutMetrics } = await coherentSample({
      label: 'Page.getLayoutMetrics against the page-reported viewport',
      readPage: readPageViewport,
      measure: async () => await cdpSession.send('Page.getLayoutMetrics'),
    })
    console.log('Page-reported viewport:', pageViewport)
    console.log('cssLayoutViewport:', layoutMetrics.cssLayoutViewport)
    console.log('cssVisualViewport:', layoutMetrics.cssVisualViewport)

    // The layout viewport in CSS pixels is `document.documentElement.clientWidth/Height` at the
    // document scroll offset — both exclude scrollbars, so they are the same measurement.
    expect(layoutMetrics.cssLayoutViewport).toEqual(pageViewport.layout)

    // The visual viewport in CSS pixels is `window.visualViewport`, field for field. `zoom` is
    // the only member with no page-visible counterpart: it is the browser's own zoom level, and
    // nothing in this suite changes it.
    const { zoom, ...cssVisualViewport } = layoutMetrics.cssVisualViewport
    expect(cssVisualViewport).toEqual(pageViewport.visual)
    expect(zoom).toBe(1)

    // `layoutViewport`/`visualViewport` are the protocol's pre-CSS-pixel fields, documented as
    // "in device pixels". Current Chromium reports them IDENTICAL to the css* ones even at
    // deviceScaleFactor 2 (measured directly), which is why the `devicePixelRatio` this test used
    // to derive as visualViewport.clientWidth / cssVisualViewport.clientWidth was 1 by
    // construction and said nothing whatsoever about the device pixel ratio. Assert the equality
    // that makes it a tautology rather than recording the tautology as if it were evidence.
    expect(layoutMetrics.layoutViewport).toEqual(layoutMetrics.cssLayoutViewport)
    expect(layoutMetrics.visualViewport).toEqual(layoutMetrics.cssVisualViewport)

    // The real device pixel ratio is the page's, and it is 1 because this suite launches Chrome
    // with Playwright's default deviceScaleFactor. It is asserted here rather than derived
    // because the screenshot test above multiplies clips by it to predict PNG sizes.
    console.log('window.devicePixelRatio:', pageViewport.devicePixelRatio)
    expect(pageViewport.devicePixelRatio).toBe(1)

    await cdpSession.detach()
    await browser.close()
    await page.close()
  }, 60000)

  it('should support getExistingCDPSession through the relay (reusing Playwright WS)', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('https://example.com/')
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )

    await new Promise((r) => setTimeout(r, 100))

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    const cdpPage = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes('example.com'))
    expect(cdpPage).toBeDefined()

    // Use the new getCDPSessionForPage which reuses Playwright's internal WS
    const cdpClient = await getCDPSessionForPage({ page: cdpPage! })

    // Should be able to send CDP commands just like the regular getCDPSessionForPage
    const layoutMetrics = await cdpClient.send('Page.getLayoutMetrics')
    expect(layoutMetrics).toBeDefined()
    const metrics = layoutMetrics as { cssVisualViewport?: { clientWidth?: number } }
    expect(metrics.cssVisualViewport).toBeDefined()
    expect(metrics.cssVisualViewport!.clientWidth).toBeGreaterThan(0)

    // Test DOM access
    const document = await cdpClient.send('DOM.getDocument')
    expect(document).toBeDefined()

    await cdpClient.detach()
    await browser.close()
    await page.close()
  }, 60000)

  it('should get aria ref for locator using getAriaSnapshot', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    // Use data-testid for stable refs, regular id for the button
    await page.setContent(`
            <html>
                <body>
                    <button data-testid="submit-btn">Submit Form</button>
                    <a href="/about" data-testid="about-link">About Us</a>
                    <input type="text" placeholder="Enter your name" data-testid="name-input" />
                </body>
            </html>
        `)
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    await new Promise((r) => setTimeout(r, 400))

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    let cdpPage
    for (const p of browser.contexts()[0].pages()) {
      const html = await p.content()
      if (html.includes('submit-btn')) {
        cdpPage = p
        break
      }
    }
    expect(cdpPage).toBeDefined()

    const { getAriaSnapshot } = await import('./aria-snapshot.js')

    const ariaResult = await getAriaSnapshot({
      page: cdpPage!,
    })

    expect(ariaResult.snapshot).toBeDefined()
    expect(ariaResult.snapshot.length).toBeGreaterThan(0)
    expect(ariaResult.snapshot).toContain('Submit Form')
    // Snapshot lines include Playwright locators for interactive elements
    expect(ariaResult.snapshot).toContain('[data-testid="submit-btn"]')
    expect(ariaResult.snapshot).toContain('[data-testid="about-link"]')
    expect(ariaResult.snapshot).toContain('[data-testid="name-input"]')

    const flattenNodes = (nodes: AriaSnapshotNode[]): AriaSnapshotNode[] => {
      return nodes.flatMap((node) => {
        return [node, ...flattenNodes(node.children)]
      })
    }

    const allNodes = flattenNodes(ariaResult.tree)
    const findByLocator = (locator: string) => {
      return allNodes.find((node) => node.locator === locator)
    }

    const submitNode = findByLocator('[data-testid="submit-btn"]')
    const aboutNode = findByLocator('[data-testid="about-link"]')
    const nameNode = findByLocator('[data-testid="name-input"]')

    expect(submitNode).toBeDefined()
    expect(aboutNode).toBeDefined()
    expect(nameNode).toBeDefined()

    const submitLocator = cdpPage!.locator(submitNode!.locator!)
    const aboutLocator = cdpPage!.locator(aboutNode!.locator!)
    const nameLocator = cdpPage!.locator(nameNode!.locator!)

    expect(await submitLocator.count()).toBe(1)
    expect(await aboutLocator.count()).toBe(1)
    expect(await nameLocator.count()).toBe(1)

    expect(await submitLocator.textContent()).toBe('Submit Form')
    expect(await aboutLocator.textContent()).toBe('About Us')
    expect(await nameLocator.getAttribute('placeholder')).toBe('Enter your name')

    expect(ariaResult.refToElement.size).toBeGreaterThan(0)
    console.log('RefToElement map size:', ariaResult.refToElement.size)
    console.log('RefToElement entries:', [...ariaResult.refToElement.entries()])

    // Verify refs are stable test IDs
    expect(ariaResult.refToElement.has('submit-btn')).toBe(true)
    expect(ariaResult.refToElement.has('about-link')).toBe(true)
    expect(ariaResult.refToElement.has('name-input')).toBe(true)

    // Use getSelectorForRef to get CSS selector for a ref
    const btnSelector = ariaResult.getSelectorForRef('submit-btn')
    expect(btnSelector).toBeDefined()
    console.log('Button selector:', btnSelector)

    // Verify the selector works
    const btnViaSelector = cdpPage!.locator(btnSelector!)
    const btnTextViaRef = await btnViaSelector.textContent()
    console.log('Button text via selector:', btnTextViaRef)
    expect(btnTextViaRef).toBe('Submit Form')

    // Test role and name
    const btnInfo = ariaResult.refToElement.get('submit-btn')
    expect(btnInfo?.role).toBe('button')
    expect(btnInfo?.name).toBe('Submit Form')

    const linkInfo = ariaResult.refToElement.get('about-link')
    expect(linkInfo?.role).toBe('link')
    expect(linkInfo?.name).toBe('About Us')

    const inputInfo = ariaResult.refToElement.get('name-input')
    expect(inputInfo?.role).toBe('textbox')

    await browser.close()
    await page.close()
  }, 60000)

  // ── The labelled screenshot on a dense real-world page ───────────────────────────────
  //
  // This used to open https://old.reddit.com/ and https://news.ycombinator.com/ for real. Two
  // separate things went wrong with that, and only one of them looked like a failure:
  //
  //   - Hacker News timed out — but NOT because of the network: a relay-side stall (see the
  //     note on the loop below). The live site was hiding it, not causing it.
  //   - old.reddit.com "passed" with 3 labels. Three. On a page that should produce hundreds —
  //     reddit serves headless Chromium a 17-element bot-check stub, verified by loading it.
  //     `expect(labelCount).toBeGreaterThan(0)` cannot tell that from success, so that half of
  //     the test had already stopped testing anything and said nothing about it.
  //
  // Both pages are now committed fixtures (scripts/capture-page-fixture.ts) served locally, with
  // reddit replaced by a Wikipedia article — same job (semantic sectioning, 1200+ interactive
  // elements, 21 tables, nesting 31 deep), but a site that answers. And the assertion is a
  // per-page floor on the label count rather than `> 0`, so a stub page — or a regression that
  // labels only a handful of the refs — fails instead of passing quietly.
  it('should draw observe() refs onto screenshots of real pages without touching them', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const assetsDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'assets')
    fs.mkdirSync(assetsDir, { recursive: true })

    const testPages = [
      { name: 'wikipedia', fixture: 'wikipedia', ...MIN_ARIA_LABELS.wikipedia },
      { name: 'hacker-news', fixture: 'hacker-news', ...MIN_ARIA_LABELS.hackerNews },
    ]

    const server = await createSimpleServer({
      routes: Object.fromEntries(
        testPages.map((testPage) => {
          return [`/${testPage.name}`, readPageFixture(testPage.fixture)]
        }),
      ),
    })

    const externalRequests: string[] = []
    const requestedUrls: string[] = []
    const requestListener = (request: { url: () => string }) => {
      const url = request.url()
      requestedUrls.push(url)
      if (!isLocalOrInertRequestUrl({ url, baseUrl: server.baseUrl })) {
        externalRequests.push(url)
      }
    }

    // Every CDP read below already carries its own deadline; this one bounds the whole step so a
    // regression fails the test with the step's name instead of hanging the run.
    const withTimeout = async <T>(label: string, task: () => Promise<T>, timeoutMs: number): Promise<T> => {
      const expired = Promise.withResolvers<never>()
      const timeoutId = setTimeout(
        () => expired.reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`)),
        timeoutMs,
      )
      try {
        return await Promise.race([task(), expired.promise])
      } finally {
        clearTimeout(timeoutId)
      }
    }

    // ── One tab per fixture, all connected before the CDP client attaches ──────────────
    //
    // Several connected tabs at once is the ordinary way an agent drives a browser. With a
    // second connected target the first main-world read against it used to hang about one run
    // in two: the relay let a session's Runtime.enable context events overtake the response to
    // the Page.getFrameTree the client had sent earlier, and Playwright drops context events
    // that arrive before it has the frame tree. Fixed by the Runtime.enable ordering fence in
    // cdp-relay.ts; guarded directly by relay-two-targets.test.ts.
    const ownPages = new Map<string, Page>()
    for (const testPage of testPages) {
      const url = `${server.baseUrl}/${testPage.name}`
      const p = await browserContext.newPage()
      p.setDefaultNavigationTimeout(30000)
      p.on('request', requestListener)
      await p.goto(url, { waitUntil: 'load' })
      await p.bringToFront()
      await serviceWorker.evaluate(
        async ([k, l]) => {
          await globalThis.toggleExtensionForActiveTab(k, l)
        },
        [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
      )
      ownPages.set(url, p)
    }

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))
    try {
      for (const { name, minLabels, minSnapshotLines } of testPages) {
        const url = `${server.baseUrl}/${name}`
        const cdpPage = browser
          .contexts()[0]
          .pages()
          .find((p) => p.url() === url)
        if (!cdpPage) {
          throw new Error(`Could not find the fixture page over CDP (looked for ${url})`)
        }
        // Chrome paints only the front tab; the labelled screenshot refuses a hidden one.
        await ownPages.get(url)!.bringToFront()

        const cdp = await getCDPSessionForPage({ page: cdpPage })
        const frames = new PageFrames({ page: cdpPage, cdp })
        const world = frames.main.world
        try {
          const elementCount = () => cdpPage.evaluate(() => document.getElementsByTagName('*').length)
          const elementsBefore = await withTimeout(`count elements (${name})`, elementCount, 10000)

          const { targetInfo } = await cdp.send('Target.getTargetInfo')
          const observation = await withTimeout(
            `observePage(${name})`,
            () =>
              observePage({
                page: cdpPage,
                frames,
                registry: new RefRegistry(),
                targetId: targetInfo.targetId,
                shown: true,
              }),
            60000,
          )
          const shot = await withTimeout(
            `renderLabelledScreenshot(${name})`,
            () => renderLabelledScreenshot({ cdp, world, observation }),
            30000,
          )
          fs.writeFileSync(path.join(assetsDir, `aria-labels-${name}.png`), shot.png)

          const { snapshot } = await withTimeout(
            `getAriaSnapshot(${name})`,
            () => getAriaSnapshot({ page: cdpPage }),
            30000,
          )
          const snapshotLines = snapshot.split('\n').filter((line) => line.trim().length > 0).length
          console.log(`${name}: ${shot.labels.length} labels drawn, ${snapshotLines} snapshot lines`)
          // Two floors, because they fail for different reasons: the label count says "a real number
          // of on-screen refs was drawn"; the snapshot line count says "the whole page was there".
          expect(shot.labels.length, `${name}: expected a real number of labels`).toBeGreaterThanOrEqual(minLabels)
          expect(snapshotLines, `${name}: expected the full page in the aria snapshot`).toBeGreaterThanOrEqual(
            minSnapshotLines,
          )

          // The labels are observe()'s own refs, and the PNG is what the result says it is.
          const observedRefs = new Set(observation.elements.map((element) => element.ref))
          expect(shot.labels.filter((label) => !observedRefs.has(label.ref))).toEqual([])
          const image = decodePng(shot.png)
          expect({ width: image.width, height: image.height }).toEqual({ width: shot.width, height: shot.height })

          // Nothing was added to the page.
          expect(await withTimeout(`count elements again (${name})`, elementCount, 10000)).toBe(elementsBefore)
        } finally {
          frames.dispose()
        }

        expect(requestedUrls, `expected ${name}'s own request in the log`).toContain(url)
      }
    } finally {
      await browser.close()
      for (const p of ownPages.values()) {
        p.off('request', requestListener)
        await p.close()
      }
      await server.close()
    }

    // Guard the guard first: no request log means the check below would pass by seeing nothing.
    expect(requestedUrls.length, 'expected request events from the fixture pages').toBeGreaterThan(0)
    // The point of the fixtures: this run touched nothing outside the local server.
    expect(externalRequests).toEqual([])
  }, 180000)

  it('should take screenshot with accessibility labels via MCP execute tool', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.setContent(`
            <html>
                <head>
                    <style>
                        body {
                            margin: 0;
                            background: #e8f4f8;
                            position: relative;
                            min-height: 100vh;
                        }
                        .controls {
                            padding: 20px;
                            position: relative;
                            z-index: 10;
                        }
                        .grid-marker {
                            position: absolute;
                            background: rgba(255, 100, 100, 0.3);
                            border: 1px solid #ff6464;
                            font-size: 10px;
                            color: #333;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        }
                        .h-marker {
                            left: 0;
                            width: 100%;
                            height: 20px;
                        }
                        .v-marker {
                            top: 0;
                            height: 100%;
                            width: 20px;
                        }
                    </style>
                </head>
                <body>
                    <div class="controls">
                        <button id="submit-btn">Submit Form</button>
                        <a href="/about">About Us</a>
                        <input type="text" placeholder="Enter your name" />
                    </div>
                    <!-- Horizontal markers every 200px -->
                    <div class="grid-marker h-marker" style="top: 200px;">200px</div>
                    <div class="grid-marker h-marker" style="top: 400px;">400px</div>
                    <div class="grid-marker h-marker" style="top: 600px;">600px</div>
                    <!-- Vertical markers every 200px -->
                    <div class="grid-marker v-marker" style="left: 200px;">200</div>
                    <div class="grid-marker v-marker" style="left: 400px;">400</div>
                    <div class="grid-marker v-marker" style="left: 600px;">600</div>
                    <div class="grid-marker v-marker" style="left: 800px;">800</div>
                    <div class="grid-marker v-marker" style="left: 1000px;">1000</div>
                    <div class="grid-marker v-marker" style="left: 1200px;">1200</div>
                </body>
            </html>
        `)
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    await new Promise((r) => setTimeout(r, 400))

    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    let testPage;
                    for (const p of context.pages()) {
                        const html = await p.content();
                        if (html.includes('submit-btn')) { testPage = p; break; }
                    }
                    if (!testPage) throw new Error('Test page not found');
                    await screenshotWithAccessibilityLabels({ page: testPage });
                `,
        timeout: 15000,
      },
    })

    expect(result.isError).toBeFalsy()

    const content = result.content as any[]
    expect(content.length).toBe(2)

    const textContent = content.find((c) => c.type === 'text')
    expect(textContent).toBeDefined()
    expect(textContent.text).toContain('Screenshot saved to:')
    expect(textContent.text).toContain('image included below')
    expect(textContent.text).toContain('Accessibility snapshot:')
    expect(textContent.text).toContain('Submit Form')

    const imageContent = content.find((c) => c.type === 'image')
    expect(imageContent).toBeDefined()
    expect(imageContent.mimeType).toBe('image/png')
    expect(imageContent.data).toBeDefined()
    expect(imageContent.data.length).toBeGreaterThan(100)

    const buffer = Buffer.from(imageContent.data, 'base64')
    const dimensions = imageSize(buffer)

    const viewport = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
    }))
    console.log('Screenshot dimensions:', dimensions.width, 'x', dimensions.height)
    console.log('Window viewport:', viewport)

    expect(dimensions.type).toBe('png')
    expect(dimensions.width).toBeGreaterThan(0)
    expect(dimensions.height).toBeGreaterThan(0)

    await page.close()
  }, 60000)
})
