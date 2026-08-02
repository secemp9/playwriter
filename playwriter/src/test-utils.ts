import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import net from 'node:net'
// Type-only: importing the value would make every module that touches this file (including
// the browser-free suites that only want testRelayPort) load playwright-core. setupTestContext
// imports chromium dynamically instead, at the one place that actually launches a browser.
import type { BrowserContext } from '@xmorse/playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import { createCdpLogger, type CdpLogger } from './cdp-log.js'
import { createFileLogger, type Logger } from './create-logger.js'
import { killPortProcess } from './kill-port.js'
import { deriveWorkspace } from './workspace-key.js'

const execAsync = promisify(exec)

/**
 * The single workspace every test in this suite acts as. All tests run from one cwd,
 * so they derive one key — which is why keying them changes nothing about the suite's
 * semantics except that their relay clients are no longer 4005-rejected as unkeyed.
 * Todos 26-31 pass `TEST_WORKSPACE.key`/`.label` at every toggle + getCdpUrl site where
 * the test's own client must see its tab; `null, null` only on the deliberate freestyle
 * (human-icon-click) path, whose tab must then be invisible to every keyed client.
 */
export const TEST_WORKSPACE = deriveWorkspace()

/**
 * The port a real relay daemon listens on (relay-client.ts's RELAY_PORT default). No test
 * suite may take it: a suite that did would fight the developer's own running daemon.
 */
const PRODUCTION_RELAY_PORT = 19988

/**
 * The single place a test suite's relay port is decided.
 *
 * Two suites sharing a port is not a nuisance, it is a whole-file outage: the second relay
 * to bind throws EADDRINUSE inside beforeAll, so every test in that file fails to collect
 * while both files still pass in isolation. That is exactly what happened when
 * popup-relocation.test.ts and trace-integration.test.ts both hardcoded 19995 — it cost all
 * 7 trace-integration tests, silently, only in a full run.
 *
 * Renumbering one of them would have moved the tripwire, not removed it. So every port lives
 * here, keyed by the test file that owns it, and three invariants are checked at import time
 * by the block below — meaning any suite that imports this module fails loudly and
 * immediately, before a single browser is launched:
 *
 *   1. no two suites may share a port,
 *   2. no suite may take PRODUCTION_RELAY_PORT,
 *   3. an unregistered suite gets an exception from testRelayPort(), never a number it made up.
 *
 * The remaining way to collide would be to hardcode a number instead of calling
 * testRelayPort(). setupTestContext() closes that off by construction: it takes `suiteUrl`
 * (pass `import.meta.url`) and resolves the port itself, so there is no port parameter for a
 * literal to be passed to.
 *
 * Ports are deliberately stable per suite rather than ephemeral: buildExtension() bakes the
 * port into the extension bundle (PLAYWRITER_PORT) and caches the result in
 * ../extension/dist-<port>, so a random port every run would rebuild the extension every run
 * and leave an unbounded pile of dist directories behind.
 */
const TEST_RELAY_PORTS: Readonly<Record<string, number>> = Object.freeze({
  'relay-workspace.test.ts': 19771,
  'relay-two-targets.test.ts': 19772,
  'trace-integration.test.ts': 19985,
  'aria-snapshot.test.ts': 19986,
  'relay-core.test.ts': 19987,
  'extension-connection.test.ts': 19990,
  'snapshot-tools.test.ts': 19991,
  'relay-navigation.test.ts': 19992,
  'relay-session.test.ts': 19993,
  'on-mouse-action.test.ts': 19994,
  'popup-relocation.test.ts': 19995,
  'relay-state.test.ts': 19996,
})

// Invariants (1) and (2), enforced at module load so a bad edit cannot reach a test run.
{
  const ownerByPort = new Map<number, string>()
  for (const [suite, port] of Object.entries(TEST_RELAY_PORTS)) {
    if (port === PRODUCTION_RELAY_PORT) {
      throw new Error(
        `TEST_RELAY_PORTS: ${suite} is assigned ${port}, the port a real relay daemon uses. Pick another.`,
      )
    }
    const previousOwner = ownerByPort.get(port)
    if (previousOwner) {
      throw new Error(
        `TEST_RELAY_PORTS: ${previousOwner} and ${suite} are both assigned port ${port}. ` +
          `Two suites on one port make the second relay die with EADDRINUSE and take its whole file ` +
          `with it. Give one of them an unused port.`,
      )
    }
    ownerByPort.set(port, suite)
  }
}

/**
 * The relay port owned by the calling test file. Pass `import.meta.url`.
 *
 * Throws for an unregistered suite (invariant 3) rather than inventing a port, so a new test
 * file cannot quietly reuse another's.
 */
export function testRelayPort(suiteUrl: string): number {
  const suite = path.basename(suiteUrl.startsWith('file:') ? fileURLToPath(suiteUrl) : suiteUrl)
  const port = TEST_RELAY_PORTS[suite]
  if (port === undefined) {
    throw new Error(
      `No relay port is registered for ${suite}. Add it to TEST_RELAY_PORTS in src/test-utils.ts ` +
        `with a port no other suite uses — do not hardcode one in the test file.`,
    )
  }
  return port
}

const extensionBuildQueues: Map<string, Promise<void>> = new Map()

async function buildExtension({ port, distDir }: { port: number; distDir: string }): Promise<void> {
  const previous = extensionBuildQueues.get(distDir) || Promise.resolve()
  const buildPromise = previous
    .catch((error) => {
      console.error('Previous extension build failed:', error)
    })
    .then(async () => {
      // Build into a per-port dist to avoid parallel test runs overwriting each other.
      await execAsync(`TESTING=1 PLAYWRITER_PORT=${port} PLAYWRITER_EXTENSION_DIST=${distDir} pnpm build`, {
        cwd: '../extension',
      })
    })

  extensionBuildQueues.set(
    distDir,
    buildPromise.finally(() => {}),
  )
  await buildPromise
}

export async function getExtensionServiceWorker(context: BrowserContext) {
  let serviceWorkers = context.serviceWorkers().filter((sw) => sw.url().startsWith('chrome-extension://'))
  if (serviceWorkers.length === 0) {
    await context.waitForEvent('serviceworker', {
      predicate: (sw) => sw.url().startsWith('chrome-extension://'),
    })
  }

  // Check all chrome-extension service workers for the playwriter one (the one
  // that exposes toggleExtensionForActiveTab). This handles cases where
  // additional test fixture extensions are loaded alongside playwriter.
  for (let i = 0; i < 50; i++) {
    const allSws = context.serviceWorkers().filter((sw) => sw.url().startsWith('chrome-extension://'))
    for (const sw of allSws) {
      try {
        const isReady = await sw.evaluate(() => {
          // @ts-ignore
          return typeof globalThis.toggleExtensionForActiveTab === 'function'
        })
        if (isReady) {
          return sw
        }
      } catch {
        // Service worker might not be ready yet
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  // Fallback to first service worker
  return context.serviceWorkers().filter((sw) => sw.url().startsWith('chrome-extension://'))[0]
}

export interface TestContext {
  browserContext: BrowserContext
  userDataDir: string
  relayServer: RelayServer
  /** The suite's relay port, resolved from TEST_RELAY_PORTS. */
  port: number
  /** This suite's own relay log. Never the shared one — see setupTestContext. */
  logger: Logger
  /** This suite's own CDP wire log. Never the shared one — see setupTestContext. */
  cdpLogger: CdpLogger
}

export async function setupTestContext({
  suiteUrl,
  tempDirPrefix,
  toggleExtension = false,
  additionalExtensions = [],
}: {
  /**
   * Pass `import.meta.url`. The relay port is looked up from TEST_RELAY_PORTS, never supplied
   * by the caller — that is what makes a hardcoded, collidable port impossible on this path.
   */
  suiteUrl: string
  tempDirPrefix: string
  /** Create initial page and toggle extension on it */
  toggleExtension?: boolean
  /** Additional extension paths to load alongside the main playwriter extension */
  additionalExtensions?: string[]
}): Promise<TestContext> {
  const port = testRelayPort(suiteUrl)
  await killPortProcess({ port }).catch(() => {})

  // Use a port-scoped dist folder so parallel tests don't replace each other's extension builds.
  const distDir = `dist-${port}`

  console.log('Building extension...')
  await buildExtension({ port, distDir })
  console.log('Extension built')

  // Both loggers truncate their file on construction and buffer writes for 500ms. Pointing
  // every suite at one shared file therefore does two things to any test that reads the log
  // back: a suite starting its relay wipes the file another suite is midway through
  // measuring, and line-count slicing across that wipe silently yields nothing. That is what
  // made the download-events assertion in relay-core flip to all-false in a full run while
  // passing alone. Per-port files remove the sharing; TestContext hands the test the exact
  // logger so it can flush() before reading, which removes the 500ms buffer race too.
  const logger = createFileLogger({ logFilePath: path.join(process.cwd(), 'tmp', `relay-server-${port}.log`) })
  const cdpLogger = createCdpLogger({ logFilePath: path.join(process.cwd(), 'tmp', `cdp-${port}.jsonl`) })
  const relayServer = await startPlayWriterCDPRelayServer({ port, logger, cdpLogger })

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix))
  const extensionPath = path.resolve('../extension', distDir)
  const allExtensionPaths = [extensionPath, ...additionalExtensions].join(',')

  const { chromium } = await import('@xmorse/playwright-core')
  const browserContext = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADFUL,
    colorScheme: 'dark',
    args: [`--disable-extensions-except=${allExtensionPaths}`, `--load-extension=${allExtensionPaths}`],
  })

  const serviceWorker = await getExtensionServiceWorker(browserContext)

  if (toggleExtension) {
    const page = await browserContext.newPage()
    await page.goto('about:blank')
    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
  }

  return { browserContext, userDataDir, relayServer, port, logger, cdpLogger }
}

export async function cleanupTestContext(
  ctx: TestContext | null,
  cleanup?: (() => Promise<void>) | null,
): Promise<void> {
  if (ctx?.browserContext) {
    await ctx.browserContext.close()
  }
  if (ctx?.relayServer) {
    ctx.relayServer.close()
  }

  if (ctx?.userDataDir) {
    try {
      fs.rmSync(ctx.userDataDir, { recursive: true, force: true })
    } catch (e) {
      console.error('Failed to cleanup user data dir:', e)
    }
  }
  if (cleanup) {
    await cleanup()
  }
}

export type SseServerState = {
  connected: boolean
  finished: boolean
  writeCount: number
  closed: boolean
}

export type SseServer = {
  baseUrl: string
  getState: () => SseServerState
  close: () => Promise<void>
}

export async function createSseServer(): Promise<SseServer> {
  let sseResponse: http.ServerResponse | null = null
  let sseFinished = false
  let sseClosed = false
  let sseWriteCount = 0
  let sseInterval: NodeJS.Timeout | null = null
  const openResponses: Set<http.ServerResponse> = new Set()
  const openSockets: Set<net.Socket> = new Set()

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>SSE Test</title>
  </head>
  <body>
    <script>
      window.__sseMessages = [];
      window.__sseOpen = false;
      window.__sseError = null;
      window.startSse = function () {
        const source = new EventSource('/sse');
        window.__sseSource = source;
        source.onopen = function () {
          window.__sseOpen = true;
        };
        source.onmessage = function (event) {
          window.__sseMessages.push(event.data);
        };
        source.onerror = function () {
          window.__sseError = 'SSE error';
        };
        return true;
      };
      window.stopSse = function () {
        if (window.__sseSource) {
          window.__sseSource.close();
        }
      };
    </script>
  </body>
</html>`)
      return
    }

    if (req.url === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      res.write('retry: 1000\n\n')
      res.write('data: hello\n\n')
      sseResponse = res
      sseWriteCount += 1
      openResponses.add(res)

      res.on('finish', () => {
        sseFinished = true
      })
      res.on('close', () => {
        sseClosed = true
        openResponses.delete(res)
        if (sseInterval) {
          clearInterval(sseInterval)
          sseInterval = null
        }
      })

      sseInterval = setInterval(() => {
        res.write('data: ping\n\n')
        sseWriteCount += 1
      }, 200)
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind SSE server')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getState: () => ({
      connected: sseResponse !== null,
      finished: sseFinished,
      closed: sseClosed,
      writeCount: sseWriteCount,
    }),
    close: async () => {
      for (const response of openResponses) {
        response.destroy()
      }
      for (const socket of openSockets) {
        socket.destroy()
      }
      if (sseInterval) {
        clearInterval(sseInterval)
        sseInterval = null
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

export async function withTimeout<T>({
  promise,
  timeoutMs,
  errorMessage,
}: {
  promise: Promise<T>
  timeoutMs: number
  errorMessage: string
}): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(errorMessage))
    }, timeoutMs)

    promise
      .then((value) => {
        clearTimeout(timeoutId)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}

/** Tagged template for inline JS code strings used in MCP execute calls */
export function js(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((result, str, i) => result + str + (values[i] || ''), '')
}

export function tryJsonParse(str: string) {
  try {
    return JSON.parse(str)
  } catch {
    return str
  }
}

/**
 * Safely close a browser connected via connectOverCDP.
 *
 * Playwright's CRConnection uses async message handling (messageWrap) that can cause
 * a race condition where _onClose() runs before all pending _onMessage() handlers complete.
 * This results in "Assertion error" from crConnection.js when a CDP response arrives
 * after callbacks were cleared by dispose().
 *
 * This helper waits for the message queue to drain before closing, avoiding the race.
 *
 * @param browser - Browser instance from chromium.connectOverCDP()
 * @param drainDelayMs - Time to wait for pending messages to be processed (default: 50ms)
 */
export async function safeCloseCDPBrowser(
  browser: Awaited<ReturnType<typeof import('@xmorse/playwright-core').chromium.connectOverCDP>>,
  drainDelayMs = 50,
): Promise<void> {
  // Wait for any queued message handlers to run
  // This gives Playwright's messageWrap time to process pending CDP responses
  await new Promise((r) => setTimeout(r, drainDelayMs))
  await browser.close()
}

/**
 * Read a committed page fixture, `src/assets/fixture-<name>.html`.
 *
 * These are real, complicated websites captured once and neutralised so they load nothing at all
 * from the network — see scripts/capture-page-fixture.ts, which is both how they were made and
 * how they are regenerated. Serve one through createSimpleServer() and a suite gets the same
 * deep, dense, real-world DOM the live site used to provide, minus the live site: the aria
 * snapshot and ref-label tests need a tree that hand-written HTML does not produce, and pointing
 * a browser at news.ycombinator.com to get one made those tests fail on network luck.
 */
export function readPageFixture(name: string): string {
  const fixtureFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', `fixture-${name}.html`)
  if (!fs.existsSync(fixtureFile)) {
    throw new Error(
      `Missing page fixture ${fixtureFile}. Regenerate it with: bun scripts/capture-page-fixture.ts ${name}`,
    )
  }
  return fs.readFileSync(fixtureFile, 'utf-8')
}

/**
 * URL prefixes that fetch nothing over the network, on top of the fixture server's own origin.
 * `chrome-extension:` is here because the playwriter extension injects its toolbar into every
 * connected tab.
 *
 * Exported as data, not just baked into the predicate below, because one of the two call sites
 * runs inside the MCP sandbox as a code string and has to inline the list — one definition
 * rather than two that can drift.
 */
export const INERT_REQUEST_URL_PREFIXES: readonly string[] = ['data:', 'about:', 'blob:', 'chrome-extension://']

/**
 * Whether a request a fixture-served page made stayed local. Anything else means the fixture
 * still reaches the internet, which is the exact failure the fixtures exist to remove — so the
 * tests assert on this every run rather than trusting the capture script's one-time check.
 */
export function isLocalOrInertRequestUrl({ url, baseUrl }: { url: string; baseUrl: string }): boolean {
  return url.startsWith(baseUrl) || INERT_REQUEST_URL_PREFIXES.some((prefix) => url.startsWith(prefix))
}

export type SimpleServer = {
  baseUrl: string
  close: () => Promise<void>
}

/** Minimal local HTTP server for tests that need cross-origin iframes or custom routes */
export async function createSimpleServer({ routes }: { routes: Record<string, string> }): Promise<SimpleServer> {
  const openSockets: Set<net.Socket> = new Set()
  const server = http.createServer((req, res) => {
    const url = req.url || '/'
    const body = routes[url]
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    // charset=utf-8 explicitly, matching every other local test server in this package. Without
    // it Chrome falls back to encoding sniffing, and the committed page fixtures served through
    // here (src/assets/fixture-*.html) are full of non-ASCII — Hacker News's "[–]" collapse
    // links alone would come back mojibake and change the accessible names under test.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
  })

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    throw new Error('Failed to start test server')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of openSockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}
