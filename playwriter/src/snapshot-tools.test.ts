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
import { screenshotWithAccessibilityLabels } from './aria-snapshot.js'
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
 * Floors for the ref-label overlay, one per committed page fixture.
 *
 * Floors rather than exact counts: how many nodes aria-snapshot.ts calls interactive is allowed
 * to change without this test caring. What is NOT allowed is the number collapsing — which is
 * exactly what a live old.reddit.com did when it served headless Chromium a bot-check stub and
 * the old `expect(labelCount).toBeGreaterThan(0)` reported success on 3 labels for a page that
 * should have produced hundreds.
 *
 * `minLabels` counts only refs whose box lands inside the 1280x720 viewport, which is why it is
 * so much smaller than `minSnapshotLines` — that one covers the whole document. Both are
 * measured against the committed fixtures and set to roughly half the observed value, so there
 * is real room for drift before either means anything.
 */
const MIN_ARIA_LABELS = {
  // Observed on the committed fixtures: wikipedia 71 labels / 695 lines,
  // hacker-news 101 labels / 475 lines.
  wikipedia: { minLabels: 35, minSnapshotLines: 350 },
  hackerNews: { minLabels: 50, minSnapshotLines: 235 },
} as const

describe('Snapshot & Screenshot Tests', () => {
  let client: Awaited<ReturnType<typeof createMCPClient>>['client']
  let cleanup: (() => Promise<void>) | null = null
  let testCtx: TestContext | null = null

  beforeAll(async () => {
    testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-snap-test-', toggleExtension: true })

    const result = await createMCPClient({ port: TEST_PORT })
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

    const viewportScreenshot = await cdpPage!.screenshot()
    expect(viewportScreenshot).toBeDefined()

    const viewportDimensions = imageSize(viewportScreenshot)
    console.log('Viewport screenshot dimensions:', viewportDimensions)

    const fullPageScreenshot = await cdpPage!.screenshot({ fullPage: true })
    expect(fullPageScreenshot).toBeDefined()

    const fullPageDimensions = imageSize(fullPageScreenshot)
    console.log('Full page screenshot dimensions:', fullPageDimensions)

    testCtx!.relayServer.off('cdp:command', commandHandler)

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
    const pageMetrics = await cdpPage!.evaluate(() => ({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.visualViewport?.pageLeft ?? window.scrollX, y: window.visualViewport?.pageTop ?? window.scrollY },
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
    console.log('Page-reported metrics:', pageMetrics)

    const fullPageFitsViewport =
      pageMetrics.fullPage.width <= pageMetrics.viewport.width &&
      pageMetrics.fullPage.height <= pageMetrics.viewport.height

    expect(capturedCommands.length).toBe(2)
    expect(
      capturedCommands.map((c) => ({
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
                    const locatorFromString = eval('testPage.' + locatorString);
                    const count = await locatorFromString.count();
                    console.log('Locator count:', count);
                    const text = await locatorFromString.textContent();
                    console.log('Locator text:', text);
                `,
        timeout: 30000,
      },
    })

    expect(result.isError).toBeFalsy()
    const text = (result.content as any)[0]?.text || ''
    expect(text).toContain('Locator string:')
    expect(text).toContain("getByRole('button', { name: 'Click Me' })")
    expect(text).toContain('Locator count:')
    expect(text).toContain('Locator text:')
    expect(text).toContain('Click Me')

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

    const layoutMetrics = await cdpSession.send('Page.getLayoutMetrics')

    const normalized = {
      cssLayoutViewport: layoutMetrics.cssLayoutViewport,
      cssVisualViewport: layoutMetrics.cssVisualViewport,
      layoutViewport: layoutMetrics.layoutViewport,
      visualViewport: layoutMetrics.visualViewport,
      devicePixelRatio:
        layoutMetrics.cssVisualViewport.clientWidth > 0
          ? layoutMetrics.visualViewport.clientWidth / layoutMetrics.cssVisualViewport.clientWidth
          : 1,
    }

    expect(normalized).toMatchInlineSnapshot(`
          {
            "cssLayoutViewport": {
              "clientHeight": 720,
              "clientWidth": 1280,
              "pageX": 0,
              "pageY": 0,
            },
            "cssVisualViewport": {
              "clientHeight": 720,
              "clientWidth": 1280,
              "offsetX": 0,
              "offsetY": 0,
              "pageX": 0,
              "pageY": 0,
              "scale": 1,
              "zoom": 1,
            },
            "devicePixelRatio": 1,
            "layoutViewport": {
              "clientHeight": 720,
              "clientWidth": 1280,
              "pageX": 0,
              "pageY": 0,
            },
            "visualViewport": {
              "clientHeight": 720,
              "clientWidth": 1280,
              "offsetX": 0,
              "offsetY": 0,
              "pageX": 0,
              "pageY": 0,
              "scale": 1,
              "zoom": 1,
            },
          }
        `)

    const windowDpr = await cdpPage!.evaluate(() => (globalThis as any).devicePixelRatio)
    console.log('window.devicePixelRatio:', windowDpr)
    expect(windowDpr).toBe(1)

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

  // ── The ref-label overlay on a dense real-world page ─────────────────────────────────
  //
  // This used to open https://old.reddit.com/ and https://news.ycombinator.com/ for real. Two
  // separate things went wrong with that, and only one of them looked like a failure:
  //
  //   - Hacker News timed out — but NOT because of the network, which is what it looked like.
  //     `showAriaRefLabels` never got past its first page.evaluate, and it does the same thing
  //     against a local fixture: see the note on the loop below. The live site was hiding a
  //     relay-side stall, not causing one.
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
  it('should show aria ref labels on real pages and save screenshots', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const { showAriaRefLabels, hideAriaRefLabels } = await import('./aria-snapshot.js')

    // Create assets folder for screenshots
    const assetsDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'assets')
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true })
    }

    const testPages = [
      // Floors are set well under what the committed fixtures actually produce, so ordinary
      // drift in how refs are assigned does not fail the test, but losing most of the page does.
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

    const withTimeout = async <T>(label: string, task: () => Promise<T>, timeoutMs: number): Promise<T> => {
      let timeoutId: NodeJS.Timeout | null = null
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`))
        }, timeoutMs)
      })

      try {
        return await Promise.race([task(), timeoutPromise])
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
      }
    }

    // ── One tab per fixture, all connected before the CDP client attaches ──────────────
    //
    // This is the test's original shape, restored. For a while it was reshaped into "one tab
    // navigated between fixtures", because with a SECOND connected target in the session the
    // first `page.evaluate` against it — the one inside showAriaRefLabels' ensureA11yClient,
    // which returns in ~30ms — hung forever, about one run in two. That was never a property
    // of this test: it was a relay bug. The relay let a session's Runtime.enable execution
    // context events overtake the response to the Page.getFrameTree that same client had sent
    // earlier on that session, and Playwright drops context events that arrive before it has
    // the frame tree (crPage.ts:457 registers the listener inside the getFrameTree callback,
    // and crPage.ts:654 needs the frame to exist). Chrome emits those events once, so the main
    // world was lost for good and `frame._context('main')` never resolved. Fixed by the
    // Runtime.enable ordering fence in cdp-relay.ts; guarded directly by
    // relay-two-targets.test.ts.
    //
    // The reshape is reverted rather than kept because it was symptom avoidance, and because a
    // suite in which several tabs are connected at once is the ordinary way an agent drives a
    // browser — this test should keep exercising it. Navigation through the relay, the one
    // thing the reshaped version added, is relay-navigation.test.ts's subject.
    //
    // The `withTimeout` wrappers below stay: page.evaluate has no deadline of its own, so
    // without them a regression of this class would hang the run instead of failing it.
    const ownPages = new Map<string, Page>()
    for (const testPage of testPages) {
      const url = `${server.baseUrl}/${testPage.name}`
      const p = await browserContext.newPage()
      p.setDefaultNavigationTimeout(30000)
      p.on('request', requestListener)
      console.log(`[labels] opening ${testPage.name}: ${url}`)
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
      for (const { name, fixture, minLabels, minSnapshotLines } of testPages) {
        const url = `${server.baseUrl}/${name}`
        const cdpPage = browser
          .contexts()[0]
          .pages()
          .find((p) => p.url() === url)
        if (!cdpPage) {
          throw new Error(`Could not find the fixture page over CDP (looked for ${url})`)
        }
        console.log(`[labels] loaded ${name}: ${cdpPage.url()} (fixture ${fixture})`)

        console.log(`[labels] show labels ${name}`)
        const { labelCount, snapshot } = await withTimeout(
          `showAriaRefLabels(${name})`,
          async () => {
            return await showAriaRefLabels({ page: cdpPage })
          },
          60000,
        )
        const snapshotLines = snapshot.split('\n').filter((line) => {
          return line.trim().length > 0
        }).length
        console.log(`${name}: ${labelCount} labels shown, ${snapshotLines} snapshot lines`)
        // Two floors, because they fail for different reasons. The label count only counts refs
        // whose box lands in the 1280x720 viewport, so it says "the overlay drew a real number of
        // boxes"; the snapshot line count covers the whole document, so it says "the whole page
        // was there to be labelled". A stub page fails both; a regression that stops rendering
        // labels fails only the first.
        expect(labelCount, `${name}: expected the overlay to label a real number of refs`).toBeGreaterThanOrEqual(
          minLabels,
        )
        expect(snapshotLines, `${name}: expected the full page in the aria snapshot`).toBeGreaterThanOrEqual(
          minSnapshotLines,
        )

        console.log(`[labels] screenshot ${name}`)
        const screenshot = await withTimeout(
          `screenshot(${name})`,
          async () => {
            return await cdpPage.screenshot({ type: 'png', fullPage: false })
          },
          30000,
        )
        const screenshotPath = path.join(assetsDir, `aria-labels-${name}.png`)
        fs.writeFileSync(screenshotPath, screenshot)
        console.log(`Screenshot saved: ${screenshotPath}`)

        console.log(`[labels] count dom labels ${name}`)
        const labelElements = await withTimeout(
          `countLabels(${name})`,
          async () => {
            return await cdpPage.evaluate(() => document.querySelectorAll('.__pw_label__').length)
          },
          10000,
        )
        expect(labelElements).toBe(labelCount)

        console.log(`[labels] hide labels ${name}`)
        await withTimeout(
          `hideAriaRefLabels(${name})`,
          async () => {
            await hideAriaRefLabels({ page: cdpPage })
          },
          10000,
        )

        const labelsAfterHide = await withTimeout(
          `verifyHide(${name})`,
          async () => {
            return await cdpPage.evaluate(() => document.getElementById('__playwriter_labels__'))
          },
          10000,
        )
        expect(labelsAfterHide).toBeNull()

        expect(requestedUrls, `expected ${name}'s own request in the log`).toContain(url)
      }
    } finally {
      console.log('[labels] closing page')
      await browser.close()
      for (const p of ownPages.values()) {
        p.off('request', requestListener)
        await p.close()
      }
      await server.close()
    }

    console.log(`Screenshots saved to: ${assetsDir}`)

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
