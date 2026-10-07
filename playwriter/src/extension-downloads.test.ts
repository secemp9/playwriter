/**
 * `downloads.save` through the REAL extension, built for this suite's port and loaded in Chromium, and
 * the real relay: a human-mode session clicks a link that downloads a file, and gets its bytes.
 *
 * chrome.debugger cannot tell Chrome where to save a download, so Chrome saves it where the profile's
 * settings say, under the name it picks — here a folder of this test (set once on the browser by the
 * harness's own DevTools session, standing in for the user's Downloads folder). The extension finds
 * the file through chrome.downloads and reports it on the tab's completion; the relay puts it where the
 * session's Playwright reads it before forwarding that completion.
 *
 * Runs alone: `pnpm vitest run src/extension-downloads.test.ts` (relay port: TEST_RELAY_PORTS).
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from '@xmorse/playwright-core'
import { PlaywrightExecutor } from './executor.js'
import type { CDPEventBase } from './cdp-types.js'
import { cleanupTestContext, getExtensionServiceWorker, setupTestContext, TEST_WORKSPACE, testRelayPort, type TestContext } from './test-utils.js'

const TEST_PORT = testRelayPort(import.meta.url)
const CSV = 'id,total\n1,42\n'
const PAGE = '<!doctype html><title>Exports</title><main><h1>Exports</h1><p><a href="/export">Export CSV</a></p></main>'

let server: http.Server
let baseUrl = ''
let cwd = ''
/** Where Chrome saves downloads in this profile, as a user's Downloads folder. */
let userDownloads = ''
let testCtx: TestContext | null = null
let userPage: Page
let executor: PlaywrightExecutor

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/export') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' })
      res.end(CSV)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-downloads-'))
  userDownloads = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-downloads-user-'))

  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-extension-downloads-' })
  const serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)
  userPage = await testCtx.browserContext.newPage()
  // The harness's own Playwright made the whole profile save downloads into its artifacts folder
  // (allowAndName). A user's Chrome does not: put the profile back to saving under Chrome's own
  // names, in a folder of this test rather than the real ~/Downloads.
  const harness = await testCtx.browserContext.newCDPSession(userPage)
  await harness.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: userDownloads })
  await userPage.goto(`${baseUrl}/`, { waitUntil: 'load' })
  await userPage.bringToFront()
  // The executor must find this tab in its workspace when it connects; otherwise the relay
  // auto-creates a blank one and the session controls that. The relay registers the tab when the
  // extension reports it attached, handling the event right after it emits it, so wait for that.
  const relay = testCtx.relayServer
  const attached = Promise.withResolvers<void>()
  const attachedUrls: string[] = []
  const onEvent = ({ event }: { event: CDPEventBase }): void => {
    if (event.method !== 'Target.attachedToTarget' || typeof event.params !== 'object' || event.params === null) return
    const targetInfo: unknown = Reflect.get(event.params, 'targetInfo')
    const url: unknown = typeof targetInfo === 'object' && targetInfo !== null ? Reflect.get(targetInfo, 'url') : undefined
    attachedUrls.push(typeof url === 'string' ? url : String(url))
    if (url === `${baseUrl}/`) attached.resolve()
  }
  relay.on('cdp:event', onEvent)
  // Real timer: the extension attaches a real tab in a real browser. If it toggled another tab (the
  // active one when the toggle ran), the wanted attach never comes; fail naming what did attach
  // instead of hanging until the hook's own timeout.
  const deadline = setTimeout(
    () => attached.reject(new Error(`the extension did not attach ${baseUrl}/ within 60 s; it attached: ${JSON.stringify(attachedUrls)}`)),
    60_000,
  )
  try {
    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    await attached.promise
  } finally {
    clearTimeout(deadline)
    relay.off('cdp:event', onEvent)
  }
  executor = new PlaywrightExecutor({ cdpConfig: { port: TEST_PORT, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
}, 600_000)

afterAll(async () => {
  await cleanupTestContext(testCtx)
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.rmSync(userDownloads, { recursive: true, force: true })
})

/** The ref printed in front of the first line matching `pattern`, e.g. `[12] link "Export CSV"`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

describe('downloads through the real extension', () => {
  it('a human-mode session saves the file a click downloaded, with its bytes', async () => {
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)
    const clicked = await executor.execute(`await act.click(${refOf(look.text, /link "Export CSV"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/DOWNLOAD \[d1\] report\.csv from .*\/export — completed → downloads\.save\('d1', 'report\.csv'\) saves it into the session folder/)
    // Chrome saved it under its own name where the profile says.
    expect(fs.readFileSync(path.join(userDownloads, 'report.csv'), 'utf8')).toBe(CSV)

    const saved = await executor.execute(
      "const saved = await downloads.save('d1', 'got/report.csv')\nreturn JSON.stringify({ saved, text: require('node:fs').readFileSync(saved.path, 'utf8') })",
      30000,
    )
    expect(saved.isError, saved.text).toBe(false)
    const match = /\[return value\] ([\s\S]*)$/.exec(saved.text)
    expect(match, saved.text).not.toBeNull()
    const { saved: info, text } = JSON.parse(match![1]!.trim())
    expect(info).toEqual({ id: 'd1', file: 'report.csv', path: path.join(cwd, 'got', 'report.csv'), bytes: CSV.length })
    expect(text).toBe(CSV)
    // The user's own file is left where Chrome put it.
    expect(fs.readFileSync(path.join(userDownloads, 'report.csv'), 'utf8')).toBe(CSV)
  })
})
