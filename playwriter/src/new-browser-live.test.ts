/**
 * The new browser (new-browser.ts) as a page sees it: a fixture page reports how its page, dedicated,
 * shared and service worker scopes present the browser, the witness reports automation traces, and the
 * server records the request headers. Driven through the executor in human mode, like the MCP server
 * drives it; the options through the real MCP server are in mcp-new-browser.test.ts.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { chromeIdentity } from './chrome-identity.js'
import { getChromium } from './playwright-import.js'
import { launchOptionsFor, planNewBrowser } from './new-browser.js'
import { reportFor, startFixtureServer, witnessFor, type FixtureServer } from './new-browser-fixture.js'

let server: FixtureServer
const executors: PlaywrightExecutor[] = []
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'new-browser-live-'))

beforeAll(async () => {
  server = await startFixtureServer()
}, 30_000)

afterAll(async () => {
  for (const executor of executors) await executor.disconnect()
  await server?.close()
})

async function openIdentity(policy: 'human' | 'debug', tag: string): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const opened = await executor.execute(`await act.open('${server.url}/identity.html?tag=${tag}')`, 30_000)
  expect(opened.isError, opened.text).toBe(false)
  return executor
}

describe('the new browser presents itself as the Chrome it is', () => {
  it('in the page, every worker scope and every request, with no automation trace (human mode)', async () => {
    const executor = await openIdentity('human', 'identity-human')
    const report = await reportFor(server, 'identity-human')
    const plan = await planNewBrowser({}, { cwd })
    const identity = await chromeIdentity(await getChromium(), plan.executablePath)
    const major = identity.version.split('.')[0]

    expect(identity.userAgent).not.toContain('Headless')
    expect(identity.userAgent).toContain(`Chrome/${major}.0.0.0`)
    for (const scope of ['page', 'dedicated', 'shared', 'service'] as const) {
      const presented = report[scope].scope
      expect({ scope, userAgent: presented.userAgent }).toEqual({ scope, userAgent: identity.userAgent })
      expect({ scope, platform: presented.platform }).toEqual({ scope, platform: identity.navigatorPlatform })
      expect({ scope, highEntropy: presented.highEntropy }).toEqual({
        scope,
        highEntropy: {
          brands: identity.metadata.brands,
          mobile: identity.metadata.mobile,
          platform: identity.metadata.platform,
          architecture: identity.metadata.architecture,
          bitness: identity.metadata.bitness,
          formFactors: identity.metadata.formFactors,
          fullVersionList: identity.metadata.fullVersionList,
          model: identity.metadata.model,
          platformVersion: identity.metadata.platformVersion,
          uaFullVersion: identity.metadata.fullVersion,
          wow64: identity.metadata.wow64,
        },
      })
    }
    // A complete identity: not the blanks Chrome's --user-agent switch alone leaves.
    expect(report.page.scope.highEntropy?.fullVersionList.length).toBeGreaterThan(0)
    expect(report.page.scope.highEntropy?.uaFullVersion).toBe(identity.version)
    expect(report.page.scope.webdriver).toBe(false)

    const pageRequests = server.requests.filter((request) => request.path === '/identity.html' || request.path === '/scope.js')
    expect(pageRequests.length).toBeGreaterThanOrEqual(4)
    for (const request of pageRequests) expect(request.userAgent).toBe(identity.userAgent)
    expect(server.requests.find((request) => request.path === '/identity.html')?.secChUa).toContain(`v="${major}"`)

    // The witness: no automation global, navigator.webdriver false, no console getter read by a Runtime-enabled client.
    const last = await witnessFor(server, 'identity-human')
    expect({ webdriver: last.webdriver, automationGlobals: last.automationGlobals, consoleGetterCalls: last.consoleGetterCalls }).toEqual({
      webdriver: false,
      automationGlobals: [],
      consoleGetterCalls: 0,
    })

    // Native WebMCP is on in a new browser (Chrome ≥ 149): the page has navigator.modelContext.
    if (Number(major) >= 149) expect(report.page.scope.modelContext).toBe(true)
    await executor.disconnect()
  }, 90_000)

  it('sizes the page from a desktop window on a desktop screen', async () => {
    const executor = await openIdentity('human', 'window-default')
    const report = await reportFor(server, 'window-default')
    expect(report.window).toMatchObject({ innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 })
    expect(report.window.outerHeight).toBeGreaterThan(report.window.innerHeight)
    expect(report.screen.width).toBeGreaterThanOrEqual(report.window.outerWidth)
    expect(report.screen.availHeight).toBeLessThan(report.screen.height)
    expect(report.screen.availHeight).toBeGreaterThanOrEqual(report.window.outerHeight)
    await executor.disconnect()
  }, 90_000)

  it('is the same browser in debug mode', async () => {
    const executor = await openIdentity('debug', 'identity-debug')
    const report = await reportFor(server, 'identity-debug')
    expect(report.page.scope.userAgent).not.toContain('Headless')
    const webdriver = await executor.execute('return await page.evaluate(() => navigator.webdriver)', 30_000)
    expect(webdriver.isError, webdriver.text).toBe(false)
    expect(webdriver.text).toContain('false')
    await executor.disconnect()
  }, 90_000)
})

describe('launch options', () => {
  it('never pass --enable-automation, keep one --enable-features with native WebMCP, keep web features on, and size the window around the page', async () => {
    const plan = await planNewBrowser({ viewport: { width: 1000, height: 700 } }, { cwd })
    const identity = await chromeIdentity(await getChromium(), plan.executablePath)
    const options = launchOptionsFor(plan, identity, { userAgent: identity.userAgent, metadata: identity.metadata, navigatorPlatform: identity.navigatorPlatform }, 'linux')
    expect(options.ignoreDefaultArgs).toEqual(['--enable-automation'])
    const args = options.args ?? []
    expect(args).toContain('--disable-blink-features=AutomationControlled')
    expect(args.filter((arg) => arg.startsWith('--enable-features='))).toEqual(['--enable-features=CDPScreenshotNewSurface,WebMCPTesting,DevToolsWebMCPSupport'])
    const disabled = args.filter((arg) => arg.startsWith('--disable-features='))
    expect(disabled).toHaveLength(1)
    expect(disabled[0]).not.toMatch(/ThirdPartyStoragePartitioning|HttpsUpgrades|BoundaryEventDispatchTracksNodeRemoval/)
    expect(args).toContain(`--user-agent=${identity.userAgent}`)
    expect(args).toContain(`--window-size=${1000 + identity.windowFrame.width},${700 + identity.windowFrame.height}`)
    expect(args).toContain('--use-angle=gl-egl')
    expect(args.find((arg) => arg.startsWith('--screen-info='))).toBe('--screen-info={0,0 1920x1080 workAreaTop=32}')
  }, 60_000)
})

describe('allowedDomains', () => {
  // The held requests are answered from the executor's own browser session, outside any sandbox call:
  // the human-mode guard must not refuse them, and debug mode must not change them.
  for (const policy of ['human', 'debug'] as const) {
    it(`blocks other hosts in every scope and names the cause (${policy} mode)`, async () => {
      const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
      executors.push(executor)
      await executor.planNewBrowser({ allowedDomains: ['127.0.0.1'] })
      const tag = `allow-${policy}`
      const opened = await executor.execute(`await act.open('${server.url}/identity.html?tag=${tag}&fetch=${encodeURIComponent(`${server.otherHostUrl}/ping`)}')`, 30_000)
      expect(opened.isError, opened.text).toBe(false)
      const report = await reportFor(server, tag)
      for (const scope of ['page', 'dedicated', 'shared', 'service'] as const) {
        expect({ scope, fetched: report[scope].fetched }).toEqual({ scope, fetched: expect.stringMatching(/^failed:/) })
      }
      const failed = await executor.execute(`return await net.requests({ urlIncludes: '/ping', failedOnly: true })`, 30_000)
      expect(`${opened.text}\n${failed.text}`).toContain('blocked: localhost is not in allowedDomains (127.0.0.1)')
      await executor.disconnect()
    }, 90_000)
  }
})
