/**
 * A controlled tab the user cannot see (another tab in front of it, its window minimised), through the
 * real extension and relay in human mode: every observation and action report carries the HIDDEN line
 * while it lasts, a timeout says so, and the line goes once the tab is visible. Playwright's focus
 * emulation makes the page itself read `visible`, so only the extension's report can tell
 * (tab-visibility.ts). A launched headless browser does not throttle background tabs and says nothing.
 * Every assertion is on what the MODEL reads.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Worker } from '@xmorse/playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { createMCPClient } from './mcp-client.js'
import { cleanupTestContext, getExtensionServiceWorker, setupTestContext, testRelayPort, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)

const PAGES: Record<string, string> = {
  '/': '<!doctype html><title>Hidden tab lab</title><button onclick="this.textContent = \'Clicked\'">Press me</button>',
  '/inbox': '<!doctype html><title>Inbox</title><p>Another tab</p>',
}

let testCtx: TestContext | null = null
let client: Client
let cleanup: (() => Promise<void>) | null = null
let server: http.Server
let baseUrl = ''
let serviceWorker: Worker

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = PAGES[new URL(req.url ?? '/', 'http://localhost').pathname]
    res.writeHead(body ? 200 : 404, { 'Content-Type': body ? 'text/html; charset=utf-8' : 'text/plain' })
    res.end(body ?? 'not found')
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-hidden-tab-', toggleExtension: true })
  serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)
  const mcp = await createMCPClient({ port: TEST_PORT, policy: 'human' })
  client = mcp.client
  cleanup = mcp.cleanup
}, 600000)

afterAll(async () => {
  await cleanupTestContext(testCtx, cleanup)
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
})

async function execute(code: string): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name: 'execute', arguments: { code, timeout: 30000 } })
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('\n')
  return { text, isError: result.isError === true }
}

async function run(code: string): Promise<string> {
  const result = await execute(code)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

/** The Chrome tab and window of the controlled page (the lab page), read in the extension. */
async function controlledTab(): Promise<{ tabId: number; windowId: number }> {
  return await serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/` })
    if (!tab || tab.id === undefined) throw new Error(`no tab at ${url}/`)
    return { tabId: tab.id, windowId: tab.windowId }
  }, baseUrl)
}

const HIDDEN = /^HIDDEN {2}this tab is not visible to the user/m

describe('a controlled tab the user cannot see, through the extension relay', () => {
  it('says HIDDEN in observe and in every action report while another tab is in front, and not after page.bringToFront()', async () => {
    await run(`await page.goto('${baseUrl}/', { waitUntil: 'domcontentloaded' })`)
    const visible = await run('console.log(await observe())')
    expect(visible).not.toMatch(HIDDEN)

    const { windowId } = await controlledTab()
    // Another tab of the same window becomes the active one, the way the user switches tabs.
    await serviceWorker.evaluate(
      async ({ url, windowId }) => {
        // Named by its title in the HIDDEN line: listen before creating it, then wait until it has loaded.
        const loaded = Promise.withResolvers<void>()
        const onUpdated = (_tabId: number, _change: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void => {
          if (tab.title !== 'Inbox' || tab.status !== 'complete') return
          chrome.tabs.onUpdated.removeListener(onUpdated)
          loaded.resolve()
        }
        chrome.tabs.onUpdated.addListener(onUpdated)
        const other = await chrome.tabs.create({ windowId, url: `${url}/inbox`, active: false })
        if (other.id === undefined) throw new Error('the new tab has no id')
        await loaded.promise
        await chrome.tabs.update(other.id, { active: true })
      },
      { url: baseUrl, windowId },
    )

    const hidden = await run('console.log(await observe())')
    expect(hidden).toMatch(
      /^HIDDEN {2}this tab is not visible to the user: the tab "Inbox" is in front of it in its window\. Chrome throttles a hidden tab's timers and animations and slows its answers to input, and colour and file choosers may not open there — page\.bringToFront\(\) brings it to the front\.$/m,
    )
    const clicked = await run(`await act.click(${refOf(hidden, /button "Press me"/)})`)
    expect(clicked).toMatch(/^ACTION/m)
    expect(clicked).toMatch(HIDDEN)

    const timedOut = await execute(`await page.waitForURL('**/never', { timeout: 300 })`)
    expect(timedOut.isError, timedOut.text).toBe(true)
    expect(timedOut.text).toMatch(/Timeout 300ms exceeded[\s\S]*\nHIDDEN {2}this tab is not visible to the user: the tab "Inbox" is in front of it/)

    await run('await page.bringToFront()')
    const back = await run('console.log(await observe())')
    expect(back).not.toMatch(HIDDEN)
    const again = await run(`await act.click(${refOf(back, /button "Clicked"/)})`)
    expect(again).not.toMatch(HIDDEN)
  }, 120000)

  it('says HIDDEN while its window is minimised, and not once the window is restored', async () => {
    const { windowId } = await controlledTab()
    await serviceWorker.evaluate(async (id) => {
      await chrome.windows.update(id, { state: 'minimized' })
    }, windowId)
    const minimised = await run('console.log(await observe())')
    expect(minimised).toMatch(
      /^HIDDEN {2}this tab is not visible to the user: its window is minimised\. Chrome throttles .* page\.bringToFront\(\) brings it to the front\. If this line is still here after it, its window stayed minimised: ask the user to restore it\.$/m,
    )

    await serviceWorker.evaluate(async (id) => {
      await chrome.windows.update(id, { state: 'normal' })
    }, windowId)
    const restored = await run('console.log(await observe())')
    expect(restored).not.toMatch(HIDDEN)
  }, 120000)
})

describe('a launched headless browser', () => {
  let executor: PlaywrightExecutor | null = null
  let cwd = ''

  afterAll(async () => {
    await executor?.closeHeadlessContext().catch(() => {})
    await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('says nothing about a background tab: its timers and animations are not throttled there', async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-tab-headless-'))
    // Debug policy: the test opens the second tab with page.goto, which human mode refuses for a page in use.
    const headless = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'debug' })
    executor = headless
    const ok = async (code: string): Promise<string> => {
      const result = await headless.execute(code)
      expect(result.isError, result.text).toBe(false)
      return result.text
    }
    await ok(`await page.goto('${baseUrl}/', { waitUntil: 'domcontentloaded' })`)
    await ok(`const inbox = await context.newPage(); await inbox.goto('${baseUrl}/inbox'); await inbox.bringToFront()`)
    // The controlled tab, now behind the inbox, still renders at full rate (a throttled tab: ~1 frame per
    // second). Measuring the frame rate needs the real clock: 500 ms of requestAnimationFrame.
    const frames = await ok(
      'console.log("frames", await page.evaluate(() => { const done = Promise.withResolvers(); let n = 0; const start = performance.now(); const tick = () => { n++; if (performance.now() - start < 500) requestAnimationFrame(tick); else done.resolve(n) }; requestAnimationFrame(tick); return done.promise }))',
    )
    expect(Number(/frames (\d+)/.exec(frames)?.[1] ?? 0)).toBeGreaterThan(20)
    const observed = await ok('console.log(await observe())')
    expect(observed).toMatch(/Hidden tab lab/)
    expect(observed).not.toMatch(HIDDEN)
    const clicked = await ok(`await act.click(${refOf(observed, /button "Press me"/)})`)
    expect(clicked).not.toMatch(HIDDEN)
  }, 120000)
})
