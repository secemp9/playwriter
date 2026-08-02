import { createMCPClient } from './mcp-client.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import { getCdpUrl } from './utils.js'
import type { CDPCommand } from './cdp-types.js'
import fs from 'node:fs'
import {
  setupTestContext,
  cleanupTestContext,
  getExtensionServiceWorker,
  type TestContext,
  withTimeout,
  js,
  tryJsonParse,
  createSimpleServer,
  readPageFixture,
  INERT_REQUEST_URL_PREFIXES,
  safeCloseCDPBrowser,
  TEST_WORKSPACE,
  testRelayPort,
} from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)

describe('Relay Core Tests', () => {
  let client: Awaited<ReturnType<typeof createMCPClient>>['client']
  let cleanup: (() => Promise<void>) | null = null
  let testCtx: TestContext | null = null

  beforeAll(async () => {
    testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-test-', toggleExtension: true })

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

  const ensureConnectedTabForExecute = async (): Promise<void> => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const connectedTabCount = await serviceWorker.evaluate(async () => {
      const state = globalThis.getExtensionState()
      return state.tabs.size
    })
    if (connectedTabCount > 0) {
      return
    }

    const page = await browserContext.newPage()
    await page.goto('about:blank')
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )

    await new Promise((r) => {
      setTimeout(r, 100)
    })
  }

  it('should inject script via addScriptTag through CDP relay', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await withTimeout({
      promise: getExtensionServiceWorker(browserContext),
      timeoutMs: 5000,
      errorMessage: 'Timed out waiting for extension service worker for iframe test',
    })

    const page = await browserContext.newPage()
    const html = '<html><body><button id="btn">Click</button></body></html>'
    const dataUrl = `data:text/html,${encodeURIComponent(html)}`
    await page.goto(dataUrl)
    await page.bringToFront()

    await withTimeout({
      promise: serviceWorker.evaluate(
        async ([k, l]) => {
          await globalThis.toggleExtensionForActiveTab(k, l)
        },
        [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
      ),
      timeoutMs: 10000,
      errorMessage: 'Timed out toggling extension for active tab',
    })
    await new Promise((r) => {
      setTimeout(r, 100)
    })

    const cdpSession = await withTimeout({
      promise: getCDPSessionForPage({ page }),
      timeoutMs: 10000,
      errorMessage: 'Timed out creating CDP session for page',
    })

    const hasGlobalBefore = await page.evaluate(() => {
      return Boolean((globalThis as { __testGlobal?: unknown }).__testGlobal)
    })
    expect(hasGlobalBefore).toBe(false)

    await withTimeout({
      promise: (async () => {
        await cdpSession.send('Page.enable')
        await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
          source: 'globalThis.__testGlobal = { foo: "bar" }',
        })
        await page.reload({ waitUntil: 'domcontentloaded' })
      })(),
      timeoutMs: 10000,
      errorMessage: 'Timed out injecting script via CDP session',
    })

    const hasGlobalAfter = await page.evaluate(() => {
      return (globalThis as { __testGlobal?: unknown }).__testGlobal
    })
    expect(hasGlobalAfter).toEqual({ foo: 'bar' })

    await cdpSession.detach()
    await page.close()
  }, 60000)

  it('should emit download events for both Browser and Page domains in extension mode', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    // This suite's OWN CDP wire log, not the shared ~/.playwriter/cdp.jsonl this used to read.
    // createCdpLogger() truncates its file on construction, so every other browser suite that
    // started a relay wiped the file mid-measurement; slicing from a line count taken before
    // the wipe then yielded nothing, and every flag in the summary below came out false in a
    // full run while the test passed alone. setupTestContext now gives each suite its own file.
    const cdpLogger = testCtx!.cdpLogger
    const logFilePath = cdpLogger.logFilePath
    const logLineCountBefore = fs.existsSync(logFilePath)
      ? fs
          .readFileSync(logFilePath, 'utf-8')
          .split('\n')
          .filter((line) => {
            return line.trim().length > 0
          }).length
      : 0

    const server = await createSimpleServer({
      routes: {
        '/': `<!doctype html>
<html>
  <body>
    <button id="download-button">Download</button>
    <script>
      const button = document.getElementById('download-button');
      button.addEventListener('click', () => {
        const blob = new Blob(['playwriter-download-test'], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'playwriter-download-test.txt';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 1000);
      });
    </script>
  </body>
</html>`,
      },
    })

    const page = await browserContext.newPage()
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
    await page.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )

    const directBrowser = await withTimeout({
      promise: chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE })),
      timeoutMs: 10000,
      errorMessage: 'Timed out connecting over CDP for download reproduction test',
    })

    const connectedPage = directBrowser
      .contexts()[0]
      .pages()
      .find((candidatePage) => {
        return candidatePage.url() === server.baseUrl + '/'
      })
    if (!connectedPage) {
      throw new Error('Connected page not found for download reproduction test')
    }

    const downloadResult = await Promise.all([
      connectedPage.waitForEvent('download', { timeout: 3000 }).then(
        (download) => {
          return { timedOut: false, suggestedFilename: download.suggestedFilename() }
        },
        (error: Error) => {
          return { timedOut: true, errorMessage: error.message }
        },
      ),
      connectedPage.click('#download-button'),
    ])

    // toEqual, not toMatchInlineSnapshot: `pnpm test` is `vitest run -u`, which rewrites an
    // inline snapshot to whatever the code currently produces. A regression that stopped
    // downloads reaching Playwright would have been recorded as the new expectation — silently,
    // and in exactly the assertion whose job is to catch it.
    expect(downloadResult[0]).toEqual({
      suggestedFilename: 'playwriter-download-test.txt',
      timedOut: false,
    })

    await directBrowser.close()
    await page.close()
    await server.close()

    // createCdpLogger batches for 500ms before touching disk, so without this the last events
    // of the download — the very ones under test — are still sitting in its buffer when the
    // file is read back.
    await cdpLogger.flush()

    const logLinesAfter = fs
      .readFileSync(logFilePath, 'utf-8')
      .split('\n')
      .filter((line) => {
        return line.trim().length > 0
      })
      .slice(logLineCountBefore)

    const newEntries = logLinesAfter
      .map((line) => {
        return tryJsonParse(line)
      })
      .filter((entry): entry is { direction: string; message: { method?: string } } => {
        return Boolean(entry && typeof entry === 'object' && 'direction' in entry && 'message' in entry)
      })

    const methods = newEntries
      .map((entry) => {
        return {
          direction: entry.direction,
          method: typeof entry.message?.method === 'string' ? entry.message.method : 'response',
        }
      })
      .filter((entry) => {
        return (
          entry.method.includes('download') ||
          entry.method === 'Browser.setDownloadBehavior' ||
          entry.method === 'Page.setDownloadBehavior'
        )
      })

    const summary = {
      hasBrowserSetDownloadBehavior: methods.some((entry) => {
        return entry.direction === 'from-playwright' && entry.method === 'Browser.setDownloadBehavior'
      }),
      hasPageSetDownloadBehavior: methods.some((entry) => {
        return entry.direction === 'to-extension' && entry.method === 'Page.setDownloadBehavior'
      }),
      hasPageDownloadWillBegin: methods.some((entry) => {
        return entry.method === 'Page.downloadWillBegin'
      }),
      hasPageDownloadProgress: methods.some((entry) => {
        return entry.method === 'Page.downloadProgress'
      }),
      hasBrowserDownloadWillBegin: methods.some((entry) => {
        return entry.method === 'Browser.downloadWillBegin'
      }),
      hasBrowserDownloadProgress: methods.some((entry) => {
        return entry.method === 'Browser.downloadProgress'
      }),
    }

    // Also toEqual rather than an inline snapshot, and for a sharper reason than the one above:
    // when the shared cdp.jsonl was wiped by a concurrent suite every flag here read false, and
    // `vitest run -u` would have written that all-false object in as the expected result — a
    // green test asserting that downloads emit nothing. All six must be true: Playwright asks
    // once at the browser level, cdp-relay rewrites that to a per-page Page.setDownloadBehavior
    // (cdp-relay.ts:741-783), and each Page.download* event is mirrored back up to its
    // Browser.download* form for Playwright's benefit (maybeEmitBrowserDownloadCompatEvent,
    // cdp-relay.ts:713).
    expect(summary).toEqual({
      hasBrowserSetDownloadBehavior: true,
      hasPageSetDownloadBehavior: true,
      hasPageDownloadWillBegin: true,
      hasPageDownloadProgress: true,
      hasBrowserDownloadWillBegin: true,
      hasBrowserDownloadProgress: true,
    })
  }, 120000)

  it('should ignore duplicate dialog dismissals from multiple CDP clients', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    // Same reason as the download test above: this suite's own relay log, not the shared
    // playwriter/relay-server.log every suite used to truncate and append to. Here the sharing
    // was worse than a failure — a wipe by a concurrent suite makes the slice empty, so the
    // "no unhandled rejections" assertion below passed by having nothing to look at.
    const relayLogger = testCtx!.logger
    const logFilePath = relayLogger.logFilePath
    const logLineCountBefore = fs.existsSync(logFilePath)
      ? fs
          .readFileSync(logFilePath, 'utf-8')
          .split('\n')
          .filter((line) => {
            return line.trim().length > 0
          }).length
      : 0

    const server = await createSimpleServer({
      routes: {
        '/': `<!doctype html>
<html>
  <body>
    <button id="open-dialog">Open dialog</button>
    <script>
      document.getElementById('open-dialog').addEventListener('click', () => {
        alert('shared dialog')
      })
    </script>
  </body>
</html>`,
      },
    })

    const page = await browserContext.newPage()
    let browserA: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null
    let browserB: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null

    try {
      await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await serviceWorker.evaluate(
        async ([k, l]) => {
          await globalThis.toggleExtensionForActiveTab(k, l)
        },
        [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
      )

      await new Promise((r) => {
        setTimeout(r, 100)
      })

      browserA = await withTimeout({
        promise: chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE })),
        timeoutMs: 10000,
        errorMessage: 'Timed out connecting first CDP client for dialog test',
      })
      browserB = await withTimeout({
        promise: chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE })),
        timeoutMs: 10000,
        errorMessage: 'Timed out connecting second CDP client for dialog test',
      })

      const getConnectedPage = (browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>) => {
        return browser
          .contexts()[0]
          ?.pages()
          .find((candidatePage) => {
            return candidatePage.url() === server.baseUrl + '/'
          })
      }

      const connectedPageA = getConnectedPage(browserA)
      const connectedPageB = getConnectedPage(browserB)

      expect(connectedPageA).toBeDefined()
      expect(connectedPageB).toBeDefined()

      await withTimeout({
        promise: connectedPageA!.click('#open-dialog'),
        timeoutMs: 5000,
        errorMessage: 'Timed out opening dialog with first CDP client',
      })

      const secondClientResult = await withTimeout({
        promise: connectedPageB!.evaluate(() => {
          return 2 + 2
        }),
        timeoutMs: 5000,
        errorMessage: 'Second CDP client stopped responding after shared dialog dismissal',
      })

      expect(secondClientResult).toBe(4)

      await new Promise((r) => {
        setTimeout(r, 200)
      })
    } finally {
      if (browserA) {
        await safeCloseCDPBrowser(browserA)
      }
      if (browserB) {
        await safeCloseCDPBrowser(browserB)
      }
      await page.close()
      await server.close()
    }

    // createFileLogger batches for 500ms too — an unhandled rejection logged in the last
    // moments of the dialog exchange would otherwise never reach disk before this read, and
    // the assertion would pass by missing it.
    await relayLogger.flush()

    const logLinesAfter = fs
      .readFileSync(logFilePath, 'utf-8')
      .split('\n')
      .filter((line) => {
        return line.trim().length > 0
      })
      .slice(logLineCountBefore)

    const unexpectedRelayCrashes = logLinesAfter.filter((line) => {
      return line.includes('Unhandled Rejection:')
    })

    expect(unexpectedRelayCrashes).toEqual([])
    // Guard the guard: if the slice is empty the filter above trivially passes, which is
    // exactly how the shared-log version of this test used to go green after another suite
    // truncated the file underneath it.
    expect(logLinesAfter.length, 'expected relay activity in this suite\'s log to inspect').toBeGreaterThan(0)
  }, 60000)

  it('should execute code and capture console output', async () => {
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const newPage = await context.newPage();
          state.page = newPage;
          if (!state.pages) state.pages = [];
          state.pages.push(newPage);
        `,
      },
    })

    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.page.goto('https://example.com');
          const title = await state.page.title();
          console.log('Page title:', title);
          return { url: state.page.url(), title };
        `,
      },
    })
    expect(result.content).toMatchInlineSnapshot(`
          [
            {
              "text": "Console output:
          [log] Page title: Example Domain

          [return value] { url: 'https://example.com/', title: 'Example Domain' }",
              "type": "text",
            },
          ]
        `)
    expect(result.content).toBeDefined()
  }, 30000)

  // Repro test for https://github.com/remorses/playwriter/issues/66.
  // Current limitation: extension-mode routing does not support root-session
  // Storage.getCookies in playwriter. MUST use Network.getCookies via page CDP
  // session instead (see test below), so this repro stays skipped.
  it.skip('should reproduce page.route failure in MCP execute path (issue #66)', async () => {
    const server = await createSimpleServer({
      routes: {
        '/': '<!doctype html><html><body>route issue repro</body></html>',
        '/api/data': '{"ok":true}',
      },
    })

    try {
      const result = await client.callTool({
        name: 'execute',
        arguments: {
          code: js`
            const newPage = await context.newPage();
            state.issue66Page = newPage;
            await newPage.goto('${server.baseUrl}', { waitUntil: 'domcontentloaded' });

            let routeFetchError = null;
            await newPage.route('**/api/**', async (route) => {
              try {
                const response = await route.fetch();
                await route.fulfill({ response });
              } catch (error) {
                routeFetchError = error instanceof Error ? error.message : String(error);
                await route.abort();
              }
            });

            await newPage.evaluate(async () => {
              await fetch('/api/data').catch(() => null);
            });

            return { routeFetchError };
          `,
        },
      })

      const resultWithContent = result as { content?: unknown }
      const content = Array.isArray(resultWithContent.content) ? resultWithContent.content : []
      const firstContent = content[0]
      const output =
        typeof firstContent === 'object' && firstContent !== null && 'text' in firstContent
          ? String((firstContent as { text?: unknown }).text ?? '')
          : ''
      expect(output).toContain('routeFetchError')
      expect(output).toContain('Storage.getCookies')
      expect(output).toContain('No tab found for method Storage.getCookies')
    } finally {
      try {
        await client.callTool({
          name: 'execute',
          arguments: {
            code: js`
              if (state.issue66Page && !state.issue66Page.isClosed()) {
                await state.issue66Page.close();
              }
              delete state.issue66Page;
            `,
          },
        })
      } catch {
        // Ignore cleanup failure if MCP disconnected due to the repro.
      }
      await server.close()
    }
  }, 30000)

  it('should read cookies via Network.getCookies through page CDP session', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const server = await createSimpleServer({
      routes: {
        '/': '<!doctype html><html><body>cookies test</body></html>',
      },
    })

    const page = await browserContext.newPage()
    try {
      await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await serviceWorker.evaluate(
        async ([k, l]) => {
          await globalThis.toggleExtensionForActiveTab(k, l)
        },
        [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
      )

      await new Promise((r) => {
        setTimeout(r, 200)
      })

      await page.evaluate(() => {
        document.cookie = 'issue66=ok; path=/'
      })

      const cdpSession = await getCDPSessionForPage({ page })
      const cookiesResult = await cdpSession.send('Network.getCookies', { urls: [page.url()] })
      const cookie = cookiesResult.cookies.find((value) => {
        return value.name === 'issue66'
      })
      expect(cookie?.value).toBe('ok')
    } finally {
      await page.close()
      await server.close()
    }
  }, 30000)

  it('should show extension as connected for pages created via newPage()', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    // Create a page via MCP (which uses context.newPage())
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const newPage = await context.newPage();
          state.testPage = newPage;
          await newPage.goto('https://example.com/mcp-test');
          return newPage.url();
        `,
      },
    })

    // Get extension state to verify the page is marked as connected
    const extensionState = await serviceWorker.evaluate(async () => {
      const state = globalThis.getExtensionState()
      const tabs = await chrome.tabs.query({})
      const testTab = tabs.find((t: any) => t.url?.includes('mcp-test'))
      return {
        connected: !!testTab && !!testTab.id && state.tabs.has(testTab.id),
        tabId: testTab?.id,
        tabInfo: testTab?.id ? state.tabs.get(testTab.id) : null,
        connectionState: state.connectionState,
      }
    })

    expect(extensionState.connected).toBe(true)
    expect(extensionState.tabInfo?.state).toBe('connected')
    expect(extensionState.connectionState).toBe('connected')

    // Clean up
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          if (state.testPage) {
            await state.testPage.close();
            delete state.testPage;
          }
        `,
      },
    })
  }, 30000)

  // ── Aria snapshots of complex real-world DOMs ────────────────────────────────────────
  //
  // These two used to navigate to https://news.ycombinator.com/item?id=1 and
  // https://ui.shadcn.com/ and snapshot whatever came back. That is not a test of an accessible
  // tree, it is a test of two websites being up and unchanged, and both halves failed:
  //
  //   - shadcn-ui timed out inside the sandbox's 10s execute budget on a slow fetch, and the
  //     committed file snapshot had been overwritten (by `pnpm test`, which is `vitest run -u`)
  //     with the literal text "Error executing code: Code execution timed out after 10000ms".
  //     Its `waitFor('text=shadcn/ui')` had also stopped matching — the site was redesigned.
  //   - hacker-news passed, but only because its committed snapshot still happened to contain
  //     the YC banner of the week ("Applications are open till July 27"). It was one banner
  //     change from failing.
  //
  // What they were actually worth is the DOM: hundreds of nodes, nesting 20+ deep, dozens of
  // same-named links that force `>> nth=` disambiguation, names that come from title/alt/
  // aria-label rather than text. Hand-written test HTML does not produce that, which is why the
  // fix is a captured fixture rather than a deleted test — see scripts/capture-page-fixture.ts
  // for how they were captured and how to regenerate them.
  const snapshotTestCases = [
    {
      name: 'hacker-news',
      // A comment thread, not the front page: nested layouttables and repeated author/date
      // links are what exercise the `>> nth=` disambiguation in the snapshot writer.
      fixture: 'hacker-news-item',
      expectedContent: ['role=link', 'Hacker News'],
      waitForCode: js`
        await state.page.locator('a[href="news"]').first().waitFor({ timeout: 10000 });
        await state.page.locator('a.hnuser').first().waitFor({ timeout: 10000 });
      `,
    },
    {
      name: 'shadcn-ui',
      // A completely different tree shape from Hacker News's table markup: ~1500 elements of
      // Tailwind/RSC divs, 150+ interactive elements, 96 aria-* attributes, and controls whose
      // accessible name exists only as an aria-label.
      fixture: 'shadcn-ui',
      expectedContent: ['role=link', 'shadcn'],
      waitForCode: js`
        await state.page.locator('h1').first().waitFor({ timeout: 10000 });
        await state.page.locator('a[href="/blocks"]').first().waitFor({ timeout: 10000 });
      `,
    },
  ]

  for (const testCase of snapshotTestCases) {
    it(`should get accessibility snapshot of ${testCase.name}`, async () => {
      const server = await createSimpleServer({ routes: { '/': readPageFixture(testCase.fixture) } })

      try {
        // The request log is collected in the sandbox because the page under test is created
        // there. It is what turns "the fixture should be hermetic" into something the suite
        // checks on every run instead of something the capture script promised once.
        await client.callTool({
          name: 'execute',
          arguments: {
            code: js`
              const newPage = await context.newPage();
              state.page = newPage;
              state.requestedUrls = [];
              newPage.on('request', (request) => { state.requestedUrls.push(request.url()); });
              if (!state.pages) state.pages = [];
              state.pages.push(newPage);
            `,
          },
        })

        // Capture interactiveOnly=true snapshot (default)
        const interactiveResult = await client.callTool({
          name: 'execute',
          arguments: {
            code: js`
              // The fixture is static, but the aria snapshot is computed from the AX tree, which
              // is only complete once layout is — so still wait for page-specific content.
              await state.page.goto('${server.baseUrl}/', { waitUntil: 'domcontentloaded' });
              ${testCase.waitForCode}
              const snap = await snapshot({ page: state.page, showDiffSinceLastCall: false, interactiveOnly: true });
              return snap;
            `,
            timeout: 60000,
          },
        })

        const interactiveData =
          typeof interactiveResult === 'object' && interactiveResult.content?.[0]?.text
            ? tryJsonParse(interactiveResult.content[0].text)
            : interactiveResult
        await expect(interactiveData).toMatchFileSnapshot(`snapshots/${testCase.name}-accessibility-interactive.md`)
        expect(interactiveResult.content).toBeDefined()
        for (const expected of testCase.expectedContent) {
          expect(interactiveData).toContain(expected)
        }

        // Capture interactiveOnly=false snapshot (full tree)
        const fullResult = await client.callTool({
          name: 'execute',
          arguments: {
            code: js`
              const snap = await snapshot({ page: state.page, showDiffSinceLastCall: false, interactiveOnly: false });
              return snap;
            `,
            timeout: 60000,
          },
        })

        const fullData =
          typeof fullResult === 'object' && fullResult.content?.[0]?.text
            ? tryJsonParse(fullResult.content[0].text)
            : fullResult
        await expect(fullData).toMatchFileSnapshot(`snapshots/${testCase.name}-accessibility-full.md`)
        expect(fullResult.content).toBeDefined()
        for (const expected of testCase.expectedContent) {
          expect(fullData).toContain(expected)
        }

        // The verdict is computed in the sandbox and raised as an exception there, so a
        // non-local request fails the test with the offending URLs in the message rather than
        // having to survive util.inspect on the way back out.
        const requestsResult = await client.callTool({
          name: 'execute',
          arguments: {
            code: js`
              const baseUrl = ${JSON.stringify(server.baseUrl)};
              const inertPrefixes = ${JSON.stringify(INERT_REQUEST_URL_PREFIXES)};
              const external = state.requestedUrls.filter((url) => {
                return !url.startsWith(baseUrl) && !inertPrefixes.some((prefix) => url.startsWith(prefix));
              });
              if (external.length > 0) {
                throw new Error('fixture page made external requests: ' + external.join(', '));
              }
              return { requestCount: state.requestedUrls.length, sawFixture: state.requestedUrls.includes(baseUrl + '/') };
            `,
          },
        })
        const requestsText = (requestsResult.content as any)?.[0]?.text ?? ''
        expect(requestsResult.isError, requestsText).toBeFalsy()
        // Guard the guard: if the relay never delivered request events the external filter above
        // would pass by having seen nothing at all.
        expect(requestsText).toContain('sawFixture: true')
      } finally {
        await server.close()
      }
    }, 120000)
  }

  it('should close all created pages', async () => {
    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          if (state.pages && state.pages.length > 0) {
            for (const page of state.pages) {
              await page.close();
            }
            const closedCount = state.pages.length;
            state.pages = [];
            return { closedCount };
          }
          return { closedCount: 0 };
        `,
      },
    })
  })

  it('should capture browser console logs with getLatestLogs', async () => {
    // Ensure clean state and clear any existing logs
    const resetResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          // Clear any existing logs from previous tests
          clearAllLogs();
          console.log('Cleared all existing logs');

          // Verify connection is working
          const pages = context.pages();
          console.log('Current pages count:', pages.length);

          return { success: true, pagesCount: pages.length };
        `,
      },
    })
    console.log('Cleanup result:', resetResult)

    // Create a new page for this test
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const newPage = await context.newPage();
          state.testLogPage = newPage;
          await newPage.goto('about:blank');
        `,
      },
    })

    // Generate some console logs in the browser
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.testLogPage.evaluate(() => {
            console.log('Test log 12345');
            console.error('Test error 67890');
            console.warn('Test warning 11111');
            console.log('Test log 2 with', { data: 'object' });
            setTimeout(() => { throw new Error('Test pageerror 22222'); }, 0);
          });
          // Wait for logs to be captured
          await new Promise(resolve => setTimeout(resolve, 100));
        `,
      },
    })

    // Test getting all logs
    const allLogsResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs();
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const output = (allLogsResult as any).content[0].text
    expect(output).toContain('[log] Test log 12345')
    expect(output).toContain('[error] Test error 67890')
    expect(output).toContain('[warning] Test warning 11111')
    expect(output).toContain('[pageerror] Test pageerror 22222')

    // Test filtering by search string
    const errorLogsResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs({ search: 'error' });
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const errorOutput = (errorLogsResult as any).content[0].text
    expect(errorOutput).toContain('[error] Test error 67890')
    // With context lines (5 above/below), nearby logs are also included
    expect(errorOutput).toContain('[log] Test log 12345')

    // Test that logs persist across page reload
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          // First add a log before reload
          await state.testLogPage.evaluate(() => {
            console.log('Before reload 99999');
          });
          await new Promise(resolve => setTimeout(resolve, 100));
        `,
      },
    })

    // Verify the log exists
    const beforeReloadResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs({ page: state.testLogPage });
          console.log('Logs before reload:', logs.length);
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const beforeReloadOutput = (beforeReloadResult as any).content[0].text
    expect(beforeReloadOutput).toContain('[log] Before reload 99999')

    // Reload the page
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.testLogPage.reload();
          await state.testLogPage.evaluate(() => {
            console.log('After reload 88888');
          });
          await new Promise(resolve => setTimeout(resolve, 100));
        `,
      },
    })

    // Check logs after reload - old logs persist (no longer cleared on navigation)
    // so both pre- and post-reload logs are present. Use sinceLastCall to get
    // only new logs if needed.
    const afterReloadResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs({ page: state.testLogPage });
          console.log('Logs after reload:', logs.length);
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const afterReloadOutput = (afterReloadResult as any).content[0].text
    expect(afterReloadOutput).toContain('[log] After reload 88888')
    expect(afterReloadOutput).toContain('[log] Before reload 99999')

    // Clean up
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.testLogPage.close();
          delete state.testLogPage;
        `,
      },
    })
  }, 30000)

  it('should keep logs separate between different pages', async () => {
    // Clear any existing logs from previous tests
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          clearAllLogs();
          console.log('Cleared all existing logs for second log test');
        `,
      },
    })

    // Create two pages
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          state.pageA = await context.newPage();
          state.pageB = await context.newPage();
          await state.pageA.goto('about:blank');
          await state.pageB.goto('about:blank');
        `,
      },
    })

    // Generate logs in page A
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.pageA.evaluate(() => {
            console.log('PageA log 11111');
            console.error('PageA error 22222');
          });
          await new Promise(resolve => setTimeout(resolve, 100));
        `,
      },
    })

    // Generate logs in page B
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.pageB.evaluate(() => {
            console.log('PageB log 33333');
            console.error('PageB error 44444');
          });
          await new Promise(resolve => setTimeout(resolve, 100));
        `,
      },
    })

    // Check logs for page A - should only have page A logs
    const pageALogsResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs({ page: state.pageA });
          console.log('Page A logs:', logs.length);
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const pageAOutput = (pageALogsResult as any).content[0].text
    expect(pageAOutput).toContain('[log] PageA log 11111')
    expect(pageAOutput).toContain('[error] PageA error 22222')
    expect(pageAOutput).not.toContain('PageB')

    // Check logs for page B - should only have page B logs
    const pageBLogsResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs({ page: state.pageB });
          console.log('Page B logs:', logs.length);
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const pageBOutput = (pageBLogsResult as any).content[0].text
    expect(pageBOutput).toContain('[log] PageB log 33333')
    expect(pageBOutput).toContain('[error] PageB error 44444')
    expect(pageBOutput).not.toContain('PageA')

    // Check all logs - should have logs from both pages
    const allLogsResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs();
          console.log('All logs:', logs.length);
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const allOutput = (allLogsResult as any).content[0].text
    expect(allOutput).toContain('[log] PageA log 11111')
    expect(allOutput).toContain('[log] PageB log 33333')

    // Test that reloading page A preserves logs (no longer cleared on navigation)
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.pageA.reload();
          await state.pageA.evaluate(() => {
            console.log('PageA after reload 55555');
          });
          await new Promise(resolve => setTimeout(resolve, 100));
        `,
      },
    })

    // Check page A logs - logs persist across navigation, so both old and new are present
    const pageAAfterReloadResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs({ page: state.pageA });
          console.log('Page A logs after reload:', logs.length);
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const pageAAfterReloadOutput = (pageAAfterReloadResult as any).content[0].text
    expect(pageAAfterReloadOutput).toContain('[log] PageA after reload 55555')
    expect(pageAAfterReloadOutput).toContain('[log] PageA log 11111')

    // Check page B logs - should still have original logs
    const pageBAfterAReloadResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs({ page: state.pageB });
          console.log('Page B logs after A reload:', logs.length);
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const pageBAfterAReloadOutput = (pageBAfterAReloadResult as any).content[0].text
    expect(pageBAfterAReloadOutput).toContain('[log] PageB log 33333')
    expect(pageBAfterAReloadOutput).toContain('[error] PageB error 44444')

    // Test that logs are deleted when page is closed
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          // Close page A
          await state.pageA.close();
          await new Promise(resolve => setTimeout(resolve, 100));
        `,
      },
    })

    // Check all logs - page A logs should be gone
    const logsAfterCloseResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const logs = await getLatestLogs();
          console.log('All logs after closing page A:', logs.length);
          logs.forEach(log => console.log(log));
        `,
      },
    })

    const logsAfterCloseOutput = (logsAfterCloseResult as any).content[0].text
    expect(logsAfterCloseOutput).not.toContain('PageA')
    expect(logsAfterCloseOutput).toContain('[log] PageB log 33333')

    // Clean up remaining page
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.pageB.close();
          delete state.pageA;
          delete state.pageB;
        `,
      },
    })
  }, 30000)

  it('should capture console logs from cross-origin iframes', async () => {
    // Two servers on different ports = different origins
    const iframeServer = await createSimpleServer({
      routes: {
        '/iframe.html': `<!doctype html><html><body>
          <script>
            console.log('iframe-log-ALPHA');
            console.error('iframe-error-BETA');
            console.warn('iframe-warn-GAMMA');
          </script>
          <p>cross-origin iframe</p>
        </body></html>`,
      },
    })

    const parentServer = await createSimpleServer({
      routes: {
        '/': `<!doctype html><html><body>
          <script>console.log('parent-log-DELTA');</script>
          <iframe src="${iframeServer.baseUrl}/iframe.html"></iframe>
        </body></html>`,
      },
    })

    try {
      // Clear logs and navigate to the parent page with cross-origin iframe
      await client.callTool({
        name: 'execute',
        arguments: {
          code: js`
            clearAllLogs();
            state.iframePage = await context.newPage();
            await state.iframePage.goto('${parentServer.baseUrl}', { waitUntil: 'networkidle' });
            // Wait for iframe to load and logs to be captured
            await state.iframePage.frameLocator('iframe').locator('p').waitFor({ timeout: 5000 });
            await new Promise(resolve => setTimeout(resolve, 500));
          `,
        },
      })

      // Retrieve logs and verify both parent and iframe logs are captured
      const logsResult = await client.callTool({
        name: 'execute',
        arguments: {
          code: js`
            const logs = await getLatestLogs({ page: state.iframePage });
            console.log('Cross-origin iframe logs count:', logs.length);
            logs.forEach(log => console.log(log));
          `,
        },
      })

      const output = (logsResult as any).content[0].text
      // Parent page log
      expect(output).toContain('parent-log-DELTA')
      // Cross-origin iframe logs
      expect(output).toContain('iframe-log-ALPHA')
      expect(output).toContain('iframe-error-BETA')
      expect(output).toContain('iframe-warn-GAMMA')

      // Clean up
      await client.callTool({
        name: 'execute',
        arguments: {
          code: js`
            await state.iframePage.close();
            delete state.iframePage;
          `,
        },
      })
    } finally {
      await Promise.all([parentServer.close(), iframeServer.close()])
    }
  }, 60000)

  // ── What this test is actually about ─────────────────────────────────────────────────
  //
  // Upstream playwright-core defaults `colorScheme` to 'light', which makes every page a
  // Playwright client attaches to report light mode. This fork changes the default to
  // 'no-override' (playwright-core/src/server/page.ts:598-606) precisely because playwriter
  // attaches to a browser the user is already looking at: forcing light there would recolour
  // the user's own tab. So the subject is "playwriter does not impose a colour scheme", not
  // "the page is dark".
  //
  // The previous version pinned `matchesDark: true` as an inline snapshot. That number is the
  // HOST's desktop theme, not a property of playwriter: `Emulation.setEmulatedMedia` overrides
  // are per-target and last-writer-wins across CDP sessions, so when the MCP client sends its
  // own no-override call it lifts the launch-time colorScheme:'dark' emulation, and the tab
  // falls back to whatever the machine says. On a dark-themed machine that is dark and the
  // snapshot passed; on a light-themed one it is light and the snapshot failed — with nothing
  // about playwriter having changed.
  //
  // So both halves are asserted against something measured:
  //   1. on the wire: every Emulation.setEmulatedMedia the MCP client sends must carry
  //      prefers-color-scheme with the empty value, i.e. "remove the override". Host-independent.
  //   2. in the page: what the tab reports through MCP must equal what this browser reports
  //      with no emulation in force, measured on a throwaway tab in the same browser.
  it(
    'should preserve system color scheme instead of forcing light mode',
    async () => {
      const browserContext = getBrowserContext()
      const serviceWorker = await getExtensionServiceWorker(browserContext)

      // Ground truth for "what the system says". A fresh Playwright page cannot be asked
      // directly — setupTestContext launches with colorScheme: 'dark' and Playwright installs
      // that as an emulation override on every page it creates — so the override is lifted
      // first, using the same empty `value` Playwright itself uses to mean no-override
      // (playwright-core/src/server/chromium/crPage.ts:966-981).
      const probePage = await browserContext.newPage()
      const probeSession = await browserContext.newCDPSession(probePage)
      await probeSession.send('Emulation.setEmulatedMedia', {
        media: '',
        features: [{ name: 'prefers-color-scheme', value: '' }],
      })
      const systemPrefersDark = await probePage.evaluate(() => {
        return window.matchMedia('(prefers-color-scheme: dark)').matches
      })
      await probeSession.detach()
      await probePage.close()
      console.log('System color scheme with no emulation in force:', systemPrefersDark ? 'dark' : 'light')

      const page = await browserContext.newPage()
      await page.goto('https://example.com')
      await page.bringToFront()

      // test-utils launches with colorScheme: 'dark', so before the MCP client touches this tab
      // Playwright's own override is in force. Asserted so that a later "the tab reports the
      // system scheme" cannot be satisfied by the override never having existed.
      const colorSchemeBefore = await page.evaluate(() => {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      })
      expect(colorSchemeBefore).toBe('dark')

      const emulateMediaCommands: CDPCommand[] = []
      const commandHandler = ({ command }: { clientId: string; command: CDPCommand }) => {
        if (command.method === 'Emulation.setEmulatedMedia') {
          emulateMediaCommands.push(command)
        }
      }
      testCtx!.relayServer.on('cdp:command', commandHandler)

      let result: Awaited<ReturnType<typeof client.callTool>>
      try {
        await serviceWorker.evaluate(
          async ([k, l]) => {
            await globalThis.toggleExtensionForActiveTab(k, l)
          },
          [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
        )
        await new Promise((r) => setTimeout(r, 500))

        result = await client.callTool({
          name: 'execute',
          arguments: {
            code: js`
                    const pages = context.pages();
                    const urls = pages.map(p => p.url());
                    const targetPage = pages.find(p => p.url().includes('example.com'));
                    if (!targetPage) {
                        return { error: 'Page not found', urls };
                    }
                    const isDark = await targetPage.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
                    const isLight = await targetPage.evaluate(() => window.matchMedia('(prefers-color-scheme: light)').matches);
                    return { matchesDark: isDark, matchesLight: isLight };
                `,
          },
        })
      } finally {
        testCtx!.relayServer.off('cdp:command', commandHandler)
      }

      console.log('Color scheme after MCP connection:', result.content)

      // (1) On the wire. crPage._updateEmulateMedia always sends all four media features, so a
      // regression to a 'light' default shows up here as value: 'light' on every machine.
      const colorSchemeFeatures = emulateMediaCommands.flatMap((command) => {
        const features = (command.params as { features?: Array<{ name: string; value: string }> } | undefined)
          ?.features
        return (features ?? []).filter((feature) => {
          return feature.name === 'prefers-color-scheme'
        })
      })
      console.log(
        `Emulation.setEmulatedMedia seen on the wire: ${emulateMediaCommands.length}, ` +
          `prefers-color-scheme values: ${JSON.stringify(colorSchemeFeatures.map((feature) => feature.value))}`,
      )
      expect(
        colorSchemeFeatures.length,
        'expected the MCP client to send Emulation.setEmulatedMedia for the new tab',
      ).toBeGreaterThan(0)
      expect([...new Set(colorSchemeFeatures.map((feature) => feature.value))]).toEqual([''])

      // (2) In the page: exactly the system answer measured above, and internally consistent
      // (dark and light are complementary, so "both false" — a page that observes no scheme at
      // all — cannot slip through).
      const resultText = (result.content as any)?.[0]?.text
      expect(resultText).toBe(
        `[return value] { matchesDark: ${systemPrefersDark}, matchesLight: ${!systemPrefersDark} }`,
      )

      await page.close()
    },
    60000,
  )

  it('should get clean HTML with getCleanHTML', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.setContent(`
            <html>
                <head>
                    <style>.hidden { display: none; }</style>
                    <script>console.log('test')</script>
                </head>
                <body>
                    <div class="container" data-testid="main">
                        <h1>Hello World</h1>
                        <button id="btn" aria-label="Click me">Submit</button>
                        <a href="/about" title="About page">About</a>
                        <input type="text" placeholder="Enter name" />
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

    // Test basic getCleanHTML
    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    let testPage;
                    for (const p of context.pages()) {
                        const html = await p.content();
                        if (html.includes('Hello World')) { testPage = p; break; }
                    }
                    if (!testPage) throw new Error('Test page not found');
                    const html = await getCleanHTML({ locator: testPage.locator('body') });
                    return html;
                `,
        timeout: 15000,
      },
    })

    expect(result.isError).toBeFalsy()
    const text = (result.content as any)[0]?.text || ''

    // Inline snapshot of cleaned HTML
    expect(text).toMatchInlineSnapshot(`
          "[return value] <div data-testid="main">
           <h1>Hello World</h1>
           <button aria-label="Click me">Submit</button>
           <a href="/about" title="About page">About</a>
           <input type="text" placeholder="Enter name">
          </div>"
        `)

    // Should NOT contain script/style tags (they're removed)
    expect(text).not.toContain('<script')
    expect(text).not.toContain('<style')
    expect(text).not.toContain('console.log')

    // Test search functionality
    const searchResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    let testPage;
                    for (const p of context.pages()) {
                        const html = await p.content();
                        if (html.includes('Hello World')) { testPage = p; break; }
                    }
                    if (!testPage) throw new Error('Test page not found');
                    const html = await getCleanHTML({ locator: testPage, search: /button/i });
                    return html;
                `,
        timeout: 15000,
      },
    })

    expect(searchResult.isError).toBeFalsy()
    const searchText = (searchResult.content as any)[0]?.text || ''
    expect(searchText).toContain('button')

    await page.close()
  }, 60000)

  it('should extract page content as markdown with getPageMarkdown', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    // Create a realistic article-like page structure
    await page.setContent(`
            <html>
                <head>
                    <title>Test Article Title</title>
                    <meta name="author" content="John Doe">
                    <script>console.log('analytics')</script>
                    <style>.nav { background: blue; }</style>
                </head>
                <body>
                    <nav class="nav">
                        <a href="/">Home</a>
                        <a href="/about">About</a>
                    </nav>
                    <article>
                        <h1>Test Article Title</h1>
                        <p>This is the first paragraph of the article content.</p>
                        <p>This is the second paragraph with more details about the topic.</p>
                        <p>The article continues with important information here.</p>
                    </article>
                    <aside>
                        <h3>Related Posts</h3>
                        <ul><li>Post 1</li><li>Post 2</li></ul>
                    </aside>
                    <footer>Copyright 2024</footer>
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

    // Test basic getPageMarkdown
    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    let testPage;
                    for (const p of context.pages()) {
                        const html = await p.content();
                        if (html.includes('Test Article Title')) { testPage = p; break; }
                    }
                    if (!testPage) throw new Error('Test page not found');
                    const content = await getPageMarkdown({ page: testPage });
                    console.log(content);
                `,
        timeout: 15000,
      },
    })

    expect(result.isError).toBeFalsy()
    const text = (result.content as any)[0]?.text || ''

    // Snapshot the full output
    await expect(text).toMatchFileSnapshot('./snapshots/page-markdown-output.txt')

    // Should contain article content
    expect(text).toContain('Test Article Title')
    expect(text).toContain('first paragraph')
    expect(text).toContain('second paragraph')

    // Should NOT contain script/style content
    expect(text).not.toContain('analytics')
    expect(text).not.toContain('background: blue')

    // Test search functionality
    const searchResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    let testPage;
                    for (const p of context.pages()) {
                        const html = await p.content();
                        if (html.includes('Test Article Title')) { testPage = p; break; }
                    }
                    if (!testPage) throw new Error('Test page not found');
                    const content = await getPageMarkdown({ page: testPage, search: /important/i, showDiffSinceLastCall: false });
                    return content;
                `,
        timeout: 15000,
      },
    })

    expect(searchResult.isError).toBeFalsy()
    const searchText = (searchResult.content as any)[0]?.text || ''
    expect(searchText).toContain('important')

    await page.close()
  }, 60000)

  it('should handle default page being closed and switch to another available page', async () => {
    // This test verifies that when the default `page` in MCP scope is closed,
    // the MCP automatically switches to another available page instead of failing
    // with cryptic "page closed" errors.

    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    // 1. Disconnect everything to start fresh
    await serviceWorker.evaluate(async () => {
      await globalThis.disconnectEverything()
    })
    await new Promise((r) => setTimeout(r, 100))

    // 2. Create first page and enable extension
    const page1 = await browserContext.newPage()
    await page1.goto('https://example.com/first-page')
    await page1.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    await new Promise((r) => setTimeout(r, 100))

    // 3. Reset MCP to ensure page1 becomes the default page (only page available)
    const resetResult = await client.callTool({
      name: 'reset',
      arguments: {},
    })
    expect((resetResult as any).content[0].text).toContain('Connection reset successfully')

    // 4. Verify initial page is accessible via default `page`
    const initialResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    const url = page.url();
                    console.log('Initial page URL:', url);
                    return { url };
                `,
      },
    })
    expect((initialResult as any).content[0].text).toContain('first-page')

    // 5. Create second page and enable extension
    const page2 = await browserContext.newPage()
    await page2.goto('https://example.com/second-page')
    await page2.bringToFront()

    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    await new Promise((r) => setTimeout(r, 100))

    // 6. Close the first page (which is the default `page` in MCP scope)
    await page1.close()
    await new Promise((r) => setTimeout(r, 100))

    // 7. Execute code via MCP - should NOT fail with "page closed" error
    // Instead, it should automatically switch to the second page
    const afterCloseResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
                    const url = page.url();
                    console.log('Page URL after close:', url);
                    const title = await page.title();
                    return { url, title };
                `,
      },
    })

    // Should succeed and return the second page's info
    expect((afterCloseResult as any).isError).toBeFalsy()
    const output = (afterCloseResult as any).content[0].text
    expect(output).toContain('second-page')
    expect(output).not.toContain('page closed')
    expect(output).not.toContain('Target closed')

    // Cleanup
    await page2.close()
  }, 60000)

  // The exact sentence playwright-core attaches for a non-visible target
  // (playwright-core/src/server/dom.ts:324 and :360). Shared by the two tests that expect it, so a
  // reword in the fork has to be made once here and cannot be half-applied.
  const NOT_VISIBLE_REASON =
    'Element is not visible — it may be hidden by CSS, inside a collapsed <details>, inactive tab, or closed accordion. Try: interact with the page to reveal it first, or use { force: true } to skip visibility checks'

  // ── The three click-error tests below ────────────────────────────────────────────────
  //
  // What they are about is the ENRICHED failure reason ("Element is not visible — it may be
  // hidden by CSS…", "<div id=\"overlay\">Overlay</div> intercepts pointer events"), which the
  // pinned playwright-core produces in ElementHandle._retryAction: it runs one action attempt,
  // gets back error:notvisible / a hitTargetDescription, and only then records the sentence on
  // progress.metadata.lastActionError, which the eventual TimeoutError picks up
  // (playwright-core/src/server/dom.ts:320-362). No completed attempt, no sentence.
  //
  // They used to run with `{ timeout: 100 }` and assert the whole call log as an inline
  // snapshot. Both halves were wrong for the same reason — machine speed. Every step of the
  // loop is a CDP round trip through relay -> extension -> chrome.debugger -> tab, so 100ms did
  // not reliably cover even the locator resolution: the observed failure is a bare
  // "Timeout 100ms exceeded." with a call log that stops at "waiting for locator". And the log's
  // tail records how many retries fitted before the deadline (waits of 0/20/100/100/500ms,
  // dom.ts:300), which is a stopwatch reading, not a behaviour.
  //
  // So: resolve the locator up front, so the click budget covers only the actionability loop;
  // give that loop 5000ms, ~25x the round trips one attempt needs and still well inside both
  // the sandbox's 10s execute ceiling and the 30s test timeout; and assert the message plus the
  // deterministic head of the call log, leaving the retry tail alone. Written as explicit
  // assertions rather than snapshots on purpose — `pnpm test` is `vitest run -u`, which would
  // rewrite a snapshot to match whatever the code now does (see the note in source-bytes.test.ts).

  it('should show descriptive error when clicking a hidden element', async () => {
    await ensureConnectedTabForExecute()

    // Create a fresh page and set content with a collapsed details element
    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          state.errorTestPage = await context.newPage();
          await state.errorTestPage.setContent(\`
            <details>
              <summary>Toggle</summary>
              <button id="hidden-btn">Hidden Button</button>
            </details>
          \`);
          await state.errorTestPage.waitForSelector('#hidden-btn', { state: 'attached' });
        `,
      },
    })
    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.errorTestPage.click('#hidden-btn', { timeout: 5000 });
        `,
      },
    })
    const text = (result as any).content[0].text as string
    expect((result as any).isError).toBe(true)
    // The enriched reason — the whole point of this test.
    expect(text).toContain(
      `page.click: Timeout 5000ms exceeded. ${NOT_VISIBLE_REASON}`,
    )
    // The deterministic head of the call log. The tail (how many retries fitted before the
    // deadline) is deliberately not asserted — that is a stopwatch reading.
    expect(text).toContain("- waiting for locator('#hidden-btn')")
    expect(text).toContain('- locator resolved to <button id="hidden-btn">Hidden Button</button>')
    expect(text).toContain('- attempting click action')
    expect(text).toContain('- element is not visible')
    // Cleanup
    await client.callTool({ name: 'execute', arguments: { code: js`await state.errorTestPage.close(); delete state.errorTestPage;` } })
  }, 30000)

  it('should show descriptive error when clicking an element covered by another', async () => {
    await ensureConnectedTabForExecute()

    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          state.errorTestPage = await context.newPage();
          await state.errorTestPage.setContent(\`
            <div style="position:relative">
              <button id="covered-btn" style="position:absolute;top:0;left:0">Covered</button>
              <div id="overlay" style="position:absolute;top:0;left:0;width:200px;height:200px;background:red;z-index:10">Overlay</div>
            </div>
          \`);
          await state.errorTestPage.waitForSelector('#covered-btn', { state: 'attached' });
        `,
      },
    })
    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.errorTestPage.click('#covered-btn', { timeout: 5000 });
        `,
      },
    })
    const text = (result as any).content[0].text as string
    expect((result as any).isError).toBe(true)
    // The enriched reason — the whole point of this test.
    expect(text).toContain(
      'page.click: Timeout 5000ms exceeded. <div id="overlay">Overlay</div> intercepts pointer events',
    )
    // The deterministic head of the call log. The tail (how many retries fitted before the
    // deadline) is deliberately not asserted — that is a stopwatch reading.
    expect(text).toContain("- waiting for locator('#covered-btn')")
    expect(text).toContain('- locator resolved to <button id="covered-btn">Covered</button>')
    expect(text).toContain('- attempting click action')
    expect(text).toContain('- element is visible, enabled and stable')
    expect(text).toContain('- <div id="overlay">Overlay</div> intercepts pointer events')
    await client.callTool({ name: 'execute', arguments: { code: js`await state.errorTestPage.close(); delete state.errorTestPage;` } })
  }, 30000)

  it('should show descriptive error when clicking a display:none element', async () => {
    await ensureConnectedTabForExecute()

    await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          state.errorTestPage = await context.newPage();
          await state.errorTestPage.setContent('<button id="invisible" style="display:none">Invisible</button>');
          await state.errorTestPage.waitForSelector('#invisible', { state: 'attached' });
        `,
      },
    })
    const result = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.errorTestPage.click('#invisible', { timeout: 5000 });
        `,
      },
    })
    const text = (result as any).content[0].text as string
    expect((result as any).isError).toBe(true)
    // The enriched reason — the whole point of this test.
    expect(text).toContain(
      `page.click: Timeout 5000ms exceeded. ${NOT_VISIBLE_REASON}`,
    )
    // The deterministic head of the call log. The tail (how many retries fitted before the
    // deadline) is deliberately not asserted — that is a stopwatch reading.
    expect(text).toContain("- waiting for locator('#invisible')")
    expect(text).toContain('- locator resolved to <button id="invisible">Invisible</button>')
    expect(text).toContain('- attempting click action')
    expect(text).toContain('- element is not visible')
    await client.callTool({ name: 'execute', arguments: { code: js`await state.errorTestPage.close(); delete state.errorTestPage;` } })
  }, 30000)

})
