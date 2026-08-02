import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { chromium } from '@xmorse/playwright-core'
import { getCdpUrl } from './utils.js'
import {
  setupTestContext,
  cleanupTestContext,
  getExtensionServiceWorker,
  createSimpleServer,
  TEST_WORKSPACE,
  testRelayPort,
  type TestContext,
} from './test-utils.js'
import './test-declarations.js'

// ─────────────────────────────────────────────────────────────────────────────────────────
// An OOPIF's Target.attachedToTarget must reach Playwright on a real session.
//
// cdp-relay.ts routes an iframe attach to `iframeOwnerSessionId ?? incomingSessionId`. Both
// can be absent, and when they are, the relay forwards the attach with NO sessionId at all —
// which is Playwright's ROOT session, where crBrowser._onAttachedToTarget has no branch for
// `type: 'iframe'` and falls through to `session.detach()` (crBrowser.ts:209 in the pinned
// playwright-core 1.59.10). Measured, on a real Chrome driving the packed extension:
//
//   66 from-extension Target.attachedToTarget  <no sessionId>  type=iframe  child=A56D…
//   67 to-playwright  Target.attachedToTarget  <no sessionId>  type=iframe  child=A56D…
//   68 from-playwright Runtime.runIfWaitingForDebugger  sessionId=A56D…
//   71 from-playwright Target.detachFromTarget          params.sessionId=A56D…
//   73 from-extension Target.detachedFromTarget         sessionId=A56D…
//   76 from-extension Target.attachedToTarget  <no sessionId>  type=page   child=pw-tab-…-2
//
// Note line 76: the tab's OWN page target was still unannounced when its iframe attached. The
// cause was in the extension, not the relay — attachTab re-applied the cached root
// Target.setAutoAttach before it had assigned the tab a sessionId, so onDebuggerEvent's
// `source.sessionId || tab.sessionId` evaluated to `undefined || undefined`. It also leaked:
// a message with no sessionId resolves to no owning target, so cdp-relay's broadcast
// classifies it as browser-level and sends it to EVERY client of the extension, across
// workspaces. background.ts now applies that Target.setAutoAttach last, after the tab's
// attach echo.
//
// WHY THIS TEST IS NOT A RACE. The ordering is forced by the fixture, not waited for: the
// cross-site iframe is fully loaded BEFORE the tab is attached, so enabling auto-attach makes
// Chrome report the already-existing OOPIF immediately, inside attachTab — there is no window
// to win or lose. Measured: 5/5 pass with the background.ts change, 5/5 fail (on the
// `unroutableFromExtension` assertion, same line every time) with it reverted.
//
// `127.0.0.1` and `localhost` are different SITES, so one HTTP server serving both hostnames
// is enough to force a genuine out-of-process iframe — no --site-per-process needed. The
// other iframe tests in this repo use two servers that are both 127.0.0.1, which is the same
// site, and therefore exercise the in-process path only.
// ─────────────────────────────────────────────────────────────────────────────────────────

const TEST_PORT = testRelayPort(import.meta.url)

type WireEntry = {
  direction: string
  message: {
    method?: string
    sessionId?: string
    params?: {
      sessionId?: string
      targetInfo?: { type?: string; url?: string; parentFrameId?: string }
    }
  }
}

function readWireLog(logFilePath: string): Array<WireEntry & { line: number }> {
  const raw = fs.readFileSync(logFilePath, 'utf-8')
  const out: Array<WireEntry & { line: number }> = []
  raw.split('\n').forEach((text, index) => {
    if (!text) return
    try {
      out.push({ ...(JSON.parse(text) as WireEntry), line: index + 1 })
    } catch {
      /* a truncated trailing write is not part of the protocol under test */
    }
  })
  return out
}

function iframeAttaches(entries: Array<WireEntry & { line: number }>, direction: string) {
  return entries.filter((e) => {
    return (
      e.direction === direction &&
      e.message.method === 'Target.attachedToTarget' &&
      e.message.params?.targetInfo?.type === 'iframe'
    )
  })
}

function describeAttach(e: WireEntry & { line: number }): string {
  return (
    `line ${e.line} ${e.direction} sessionId=${e.message.sessionId ?? '<none>'} ` +
    `child=${e.message.params?.sessionId} parentFrameId=${e.message.params?.targetInfo?.parentFrameId} ` +
    `url=${e.message.params?.targetInfo?.url}`
  )
}

describe('OOPIF Target.attachedToTarget routing', () => {
  let testCtx: TestContext | null = null

  beforeAll(async () => {
    testCtx = await setupTestContext({
      suiteUrl: import.meta.url,
      tempDirPrefix: 'pw-oopif-attach-',
      toggleExtension: true,
    })
  }, 600000)

  afterAll(async () => {
    await cleanupTestContext(testCtx)
    testCtx = null
  })

  it('never forwards an iframe attach without a session, for an OOPIF that pre-dates the attach', async () => {
    const ctx = testCtx
    if (!ctx) throw new Error('Test context not initialized')
    const { browserContext, cdpLogger } = ctx
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    // The child is fetched from `localhost`; the parent is served to `127.0.0.1`. Same
    // server, different site — an out-of-process iframe. The src is built in-page because
    // createSimpleServer's routes are static and the port is only known once it listens.
    const server = await createSimpleServer({
      routes: {
        '/': `<!doctype html><html><body><h1>parent</h1><script>
  const frame = document.createElement('iframe')
  frame.id = 'oopif'
  frame.width = 300
  frame.height = 200
  frame.src = 'http://localhost:' + location.port + '/child'
  document.body.appendChild(frame)
</script></body></html>`,
        '/child': '<!doctype html><html><body><button id="inner">Inner</button></body></html>',
      },
    })

    // A real client, connected BEFORE the tab under test is attached. Its connect-time root
    // Target.setAutoAttach is what caches autoAttachParams in the extension, which is the
    // precondition for attachTab re-applying auto-attach at all.
    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, workspace: TEST_WORKSPACE }))

    const page = await browserContext.newPage()
    try {
      await page.goto(server.baseUrl, { waitUntil: 'load' })
      // Force the ordering: the OOPIF must exist and be loaded before the debugger attaches.
      await page.frameLocator('#oopif').locator('#inner').waitFor({ timeout: 10000 })
      const childUrl = `http://localhost:${new URL(server.baseUrl).port}/child`
      expect(
        page.frames().map((f) => f.url()),
        'the fixture must produce a loaded cross-site child frame before the tab is attached',
      ).toContain(childUrl)

      await page.bringToFront()
      await serviceWorker.evaluate(
        async ([k, l]) => {
          await globalThis.toggleExtensionForActiveTab(k, l)
        },
        [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
      )
      // Let the attach, the OOPIF report and the client's page initialization all land.
      await new Promise((r) => setTimeout(r, 3000))
      await cdpLogger.flush()

      const entries = readWireLog(cdpLogger.logFilePath)
      const fromExtension = iframeAttaches(entries, 'from-extension')
      const toPlaywright = iframeAttaches(entries, 'to-playwright')

      // Without this the assertions below are vacuous: no OOPIF, nothing to misroute.
      expect(
        fromExtension.length,
        'no iframe Target.attachedToTarget reached the relay at all — the fixture did not produce ' +
          'an out-of-process iframe, so this test proves nothing. Check that 127.0.0.1 and localhost ' +
          'are still separate sites for this Chromium build.',
      ).toBeGreaterThan(0)

      const unroutableFromExtension = fromExtension.filter((e) => !e.message.sessionId)
      expect(
        unroutableFromExtension.map(describeAttach),
        'the extension forwarded an iframe Target.attachedToTarget with no sessionId. That happens when ' +
          'attachTab enables auto-attach before the tab has been assigned one, so onDebuggerEvent resolves ' +
          '`source.sessionId || tab.sessionId` to undefined and the relay has nothing to route on.',
      ).toEqual([])

      const unroutableToPlaywright = toPlaywright.filter((e) => !e.message.sessionId)
      expect(
        unroutableToPlaywright.map(describeAttach),
        'the relay forwarded an iframe Target.attachedToTarget on the ROOT session. crBrowser has no ' +
          "branch for type 'iframe' and answers it with session.detach() (crBrowser.ts:209), tearing the " +
          'OOPIF down; the event also reaches every client of this extension regardless of workspace, ' +
          'because a message with no sessionId is classified as browser-level.',
      ).toEqual([])

      // The end-to-end property the routing exists for: the client sees the OOPIF as a frame
      // of the page and can reach into it.
      //
      // NOT asserted: that the child frame reports its url. It does not — over this relay a
      // pre-existing OOPIF shows up as `frames() === [parentUrl, '']`. That was measured with
      // this fix BOTH applied and reverted, so it is a separate, older gap (Playwright builds
      // the frame from Target.attachedToTarget via frameManager.frameAttached, and the
      // Page.frameNavigated that would name it fired on the child session long before anyone
      // was listening; crPage only calls _handleFrameTree for a MAIN frame). Asserting it here
      // would tie this regression test to an unrelated bug.
      const cdpPage = browser
        .contexts()[0]
        .pages()
        .find((candidate) => candidate.url().startsWith(server.baseUrl))
      expect(cdpPage, 'the toggled tab must be visible to the connected client').toBeDefined()
      await cdpPage!.frameLocator('#oopif').locator('#inner').waitFor({ timeout: 10000 })
      expect(
        cdpPage!.frames().length,
        'the client must see the out-of-process child frame as a frame of the page',
      ).toBe(2)
    } finally {
      await browser.close().catch(() => {})
      await page.close().catch(() => {})
      await server.close()
    }
  }, 120000)
})
