/**
 * A password manager's autofill menu cuts the extension's debugger off the tab — through the relay,
 * with the real Playwriter extension and a real (minimal) password manager extension
 * (fake-password-manager.ts) loaded side by side, the way Nourdine's Chrome ran Bitwarden.
 *
 * Focusing an email field makes the password manager put its `chrome-extension://` menu iframe into
 * the page; Chrome then takes every other extension's debugger off that tab (onDetach
 * `target_closed`, the tab still open) and refuses to attach again while the iframe is there. What
 * the model must read: the cut, its cause, that the tab is the same, and either the re-attach or
 * what to do — and the session must stay on that tab, never move to a new blank one.
 *
 * The same menu over Chrome's own remote debugging (PLAYWRITER_DIRECT) cuts nothing: that client is
 * not an extension.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Page, type Worker } from '@xmorse/playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { writeFakePasswordManager } from './fake-password-manager.js'
import { setupTestContext, cleanupTestContext, getExtensionServiceWorker, spawnDebuggableChrome, TEST_WORKSPACE, testRelayPort, type SpawnedChrome, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>Log in</title></head>
<body><main><h1>Log in</h1>
<p><label>Work email <input type="email" id="work" data-pm-flash></label></p>
<p><label>Email <input type="email" id="email"></label></p>
<p><label>Password <input type="password" id="password"></label></p>
<p><button id="other" type="button">Need help?</button></p>
</main>
<script>
// The fixture's own witness: what input the page received around a cut.
window.seen = []
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'focusin', 'focusout', 'keydown']) {
  document.addEventListener(type, (event) => window.seen.push(type + (event.target.id ? '#' + event.target.id : '')), true)
}
</script></body></html>`

let server: http.Server
let port = 0
let cwd = ''
let pmDir = ''

/** The ref printed in front of the first line matching `pattern`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(LOGIN)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'debugger-cut-relay-'))
  pmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debugger-cut-pm-'))
  writeFakePasswordManager({ dir: pmDir, inlineMenu: true })
})

afterAll(async () => {
  server?.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server?.close(() => closed.resolve())
  await closed.promise
  // The direct Chrome's suite stopped its whole process group (spawnDebuggableChrome), so nothing writes into cwd any more.
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.rmSync(pmDir, { recursive: true, force: true })
})

describe('a password manager menu cuts the debugger off the tab', () => {
  let testCtx: TestContext | null = null
  let userPage: Page | null = null
  let serviceWorker: Worker | null = null
  let executor: PlaywrightExecutor | null = null
  let pmId = ''
  let tabId = 0

  const tabsSeenByTheExtension = async (): Promise<Array<{ id: number; state: string }>> =>
    await serviceWorker!.evaluate(() => [...globalThis.getExtensionState().tabs.entries()].map(([id, tab]) => ({ id, state: tab.state })))

  beforeAll(async () => {
    testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-debugger-cut-', additionalExtensions: [pmDir] })
    serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)
    const pmWorker = testCtx.browserContext.serviceWorkers().find((worker) => worker.url().endsWith('/worker.js'))
    if (!pmWorker) throw new Error(`the password manager's worker is not running: ${testCtx.browserContext.serviceWorkers().map((worker) => worker.url()).join(', ')}`)
    pmId = new URL(pmWorker.url()).host

    userPage = await testCtx.browserContext.newPage()
    await userPage.goto(`http://127.0.0.1:${port}/login`, { waitUntil: 'load' })
    await userPage.bringToFront()
    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    const tabs = await tabsSeenByTheExtension()
    if (tabs.length !== 1) throw new Error(`expected the one toggled tab, the extension has ${JSON.stringify(tabs)}`)
    tabId = tabs[0].id
    executor = new PlaywrightExecutor({ cdpConfig: { port: TEST_PORT, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  }, 600_000)

  afterAll(async () => {
    await executor?.disconnect().catch(() => {})
    await cleanupTestContext(testCtx)
    testCtx = null
  })

  const run = async (code: string): Promise<{ text: string; isError: boolean }> => {
    const result = await executor!.execute(code, 30_000)
    return { text: result.text, isError: result.isError }
  }

  let look = ''
  it('observes the login page', async () => {
    const result = await run('await observe()')
    expect(result.isError, result.text).toBe(false)
    look = result.text
    expect(look).toContain('Log in')
    expect(look).toMatch(/textbox "Email"/)
  })

  it('a menu that leaves at once: the cut is reported with its cause and the re-attach, in the same call, on the same tab', async () => {
    const pagesBefore = testCtx!.browserContext.pages().length
    const work = refOf(look, /textbox "Work email"/)
    const result = await run(`await act.click(${work})`)
    // MEASURED, not asserted: what the model read, and what the page received around the cut.
    console.log(`[debugger-cut] flash click:\n${result.text}`)
    console.log(`[debugger-cut] page events: ${JSON.stringify(await userPage!.evaluate(() => window.seen.splice(0)))}`)
    expect(result.text).toContain(
      `DEBUGGER CUT — Chrome took the debugger off this tab because another extension's frame (chrome-extension://${pmId}, e.g. a password manager's autofill menu) is in the page; the tab is still open. Re-attached after `,
    )
    expect(result.text).toMatch(/Re-attached after \d+\.\d s; refs from before are gone — observe\(\) again\./)

    const after = await run('await observe()')
    expect(after.isError, after.text).toBe(false)
    expect(after.text).toContain('Log in')
    expect(after.text).toContain(`127.0.0.1:${port}/login`)
    expect(after.text).not.toContain('about:blank')
    expect(testCtx!.browserContext.pages().length).toBe(pagesBefore)

    const stale = await run(`await act.click(${work})`)
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain(`Ref [${work}] is from before Chrome took the debugger off this tab`)
    look = after.text
  }, 90_000)

  it('a menu that stays: says it cannot re-attach yet and what to do, keeps the tab, and re-adopts it once the menu is gone', async () => {
    const pagesBefore = testCtx!.browserContext.pages().length
    const email = refOf(look, /textbox "Email"/)
    const result = await run(`await act.click(${email})`)
    console.log(`[debugger-cut] sticky click:\n${result.text}`)
    console.log(`[debugger-cut] page events: ${JSON.stringify(await userPage!.evaluate(() => window.seen.splice(0)))}`)
    expect(result.text).toContain(
      `DEBUGGER CUT — Chrome took the debugger off this tab because another extension's frame (chrome-extension://${pmId}, e.g. a password manager's autofill menu) is in the page; the tab is still open. Not re-attached yet`,
    )
    expect(result.text).toContain('Cannot access a chrome-extension:// URL of different extension')
    expect(result.text).toMatch(/ask the user to close it/)
    expect(result.text).toContain('PLAYWRITER_DIRECT')
    // The extension kept the tab: it is still tracked, waiting to re-attach.
    expect(await tabsSeenByTheExtension()).toEqual([{ id: tabId, state: 'connecting' }])

    // Every call while the menu is there says the same, and runs nothing.
    const blocked = await run('await observe()')
    console.log(`[debugger-cut] while the menu stays:\n${blocked.text}`)
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain('Not re-attached yet')
    expect(blocked.text).toContain('Nothing from this call was run.')
    expect(testCtx!.browserContext.pages().length).toBe(pagesBefore)

    // The user closes the menu (Escape in that tab, through the test's own browser connection).
    await userPage!.keyboard.press('Escape')
    const back = await run('await observe()')
    console.log(`[debugger-cut] after Escape:\n${back.text.slice(0, 600)}`)
    expect(back.isError, back.text).toBe(false)
    expect(back.text).toMatch(/DEBUGGER CUT — .* Re-attached after \d+\.\d s; refs from before are gone — observe\(\) again\./)
    expect(back.text).toContain('Log in')
    expect(back.text).toContain(`127.0.0.1:${port}/login`)
    expect(testCtx!.browserContext.pages().length).toBe(pagesBefore)
    expect(await tabsSeenByTheExtension()).toEqual([{ id: tabId, state: 'connected' }])
  }, 120_000)

  it('a page no extension may debug cuts the same way: named, kept, and taken back when the tab leaves it', async () => {
    const pagesBefore = testCtx!.browserContext.pages().length
    // The user takes the tab to a chrome:// page (through the test's own browser connection).
    await userPage!.goto('chrome://version')
    const there = await run('await observe()')
    console.log(`[debugger-cut] on chrome://version:\n${there.text}`)
    expect(there.isError).toBe(true)
    expect(there.text).toContain(
      'DEBUGGER CUT — Chrome took the debugger off this tab because it went to chrome://version/, a page Chrome lets no extension debug; the tab is still open. Not re-attached yet',
    )
    expect(there.text).toContain('ask the user to take the tab back to a normal web page')
    expect(await tabsSeenByTheExtension()).toEqual([{ id: tabId, state: 'connecting' }])

    await userPage!.goto(`http://127.0.0.1:${port}/login`, { waitUntil: 'load' })
    const back = await run('await observe()')
    expect(back.isError, back.text).toBe(false)
    expect(back.text).toMatch(/DEBUGGER CUT — Chrome took the debugger off this tab because it went to chrome:\/\/version\/.* Re-attached after \d+\.\d s/)
    expect(back.text).toContain(`127.0.0.1:${port}/login`)
    expect(testCtx!.browserContext.pages().length).toBe(pagesBefore)
  }, 120_000)
})

describe("Chrome's own remote debugging (PLAYWRITER_DIRECT) is not cut off by the menu", () => {
  let chrome: SpawnedChrome | null = null
  let executor: PlaywrightExecutor | null = null

  beforeAll(async () => {
    // Playwright's Chromium: branded Chrome no longer loads an unpacked extension from the command line.
    chrome = await spawnDebuggableChrome({
      executable: chromium.executablePath(),
      profileDir: fs.mkdtempSync(path.join(cwd, 'profile-')),
      args: ['--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${pmDir}`, `--load-extension=${pmDir}`],
    })
    executor = new PlaywrightExecutor({ cdpConfig: { directCdpUrl: chrome.wsEndpoint }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  }, 120_000)

  afterAll(async () => {
    await executor?.disconnect().catch(() => {})
    await chrome?.stop()
  })

  it('acts and reads on while the menu is in the page', async () => {
    const opened = await executor!.execute(`await page.goto('http://127.0.0.1:${port}/login', { waitUntil: 'load' })`, 30_000)
    expect(opened.isError, opened.text).toBe(false)
    const look = await executor!.execute('await observe()', 30_000)
    expect(look.isError, look.text).toBe(false)
    const clicked = await executor!.execute(`await act.click(${refOf(look.text, /textbox "Email"/)})`, 30_000)
    console.log(`[debugger-cut] direct CDP click:\n${clicked.text}`)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).not.toContain('DEBUGGER CUT')
    const after = await executor!.execute('await observe()', 30_000)
    expect(after.isError, after.text).toBe(false)
    expect(after.text).toContain('iframe "Password manager menu" — not read: it is a browser extension\'s frame')
    expect(after.text).toMatch(/textbox "Email" \[focused\]/)
  }, 60_000)
})
