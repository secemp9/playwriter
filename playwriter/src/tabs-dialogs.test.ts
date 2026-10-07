/**
 * Tabs, popups and native dialogs in human mode, end to end through the real executor on a
 * headless Chromium, on the browser-lab pages (popups.html, landing.html, dialogs.html).
 * Every assertion is on what the MODEL reads.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const file = path.join(LAB, path.normalize(url.pathname).replace(/^\/+/, ''))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'
    res.writeHead(200, { 'Content-Type': type })
    res.end(fs.readFileSync(file))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tabs-dialogs-'))
})

afterAll(async () => {
  for (const executor of executors) {
    await executor.closeHeadlessContext().catch(() => {})
  }
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(cwd, { recursive: true, force: true })
})

function newExecutor(policy: 'human' | 'debug'): PlaywrightExecutor {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  return executor
}

/** The ref printed in front of the first line matching `pattern`, e.g. `[12] button "Send"`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

async function run(executor: PlaywrightExecutor, code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

describe('refs across tabs', () => {
  it('keeps a tab’s refs valid after switchTab round trips and after a sibling tab closes', async () => {
    const executor = newExecutor('human')
    await run(executor, `await page.goto('${baseUrl}/popups.html', { waitUntil: 'domcontentloaded' })`)
    const first = await run(executor, 'console.log(await observe())')
    const opened = await run(executor, `await act.click(${refOf(first, /Open landing in a new tab/)})`)
    expect(opened).toMatch(/new tab/)
    await run(executor, 'await act.switchTab(1)')
    await run(executor, 'console.log(await observe())')
    await run(executor, 'await act.switchTab(0)')
    const again = await run(executor, 'console.log(await observe())')
    const popupButton = refOf(again, /Open popup window/)
    const clicked = await executor.execute(`await act.click(${popupButton})`, 30000)
    expect(clicked.text).not.toMatch(/previous page|is closed/)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/Popup opened/)
  })
})

describe('popup windows and new tabs', () => {
  it('reports a window.open popup as POPUP and a target=_blank link as a new tab; switchTab takes title or URL text', async () => {
    const executor = newExecutor('human')
    await run(executor, `await page.goto('${baseUrl}/popups.html', { waitUntil: 'domcontentloaded' })`)
    const first = await run(executor, 'console.log(await observe())')
    const tab = await run(executor, `await act.click(${refOf(first, /Open landing in a new tab/)})`)
    expect(tab).toMatch(/TAB {5}a new tab opened by this page: "Landing · Browser Lab" .*from=blank.* — act\.switchTab\(1\)/)
    const popup = await run(executor, `await act.click(${refOf(first, /Open popup window/)})`)
    expect(popup).toMatch(
      /POPUP {3}a popup window opened by this page \(window\.open with window features width=520, height=420, resizable\): "Landing · Browser Lab" .*from=popup.* — act\.switchTab\(2\)/,
    )
    const listed = await run(executor, 'console.log(await observe())')
    expect(listed).toMatch(/TABS {2}0: "Popups · Browser Lab" \(controlled\) · 1: "Landing · Browser Lab" · 2: "Landing · Browser Lab" \(popup window\)/)

    const ambiguous = await executor.execute(`await act.switchTab('landing')`, 30000)
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toMatch(/2 tabs have "landing" in their title or URL: 1: "Landing · Browser Lab" .*from=blank.* · 2: "Landing · Browser Lab" .*from=popup/)
    const none = await executor.execute(`await act.switchTab('checkout')`, 30000)
    expect(none.text).toMatch(/No open tab has "checkout" in its title or URL\. The open tabs: 0: "Popups · Browser Lab"/)
    const switched = await run(executor, `await act.switchTab('from=popup')`)
    expect(switched).toMatch(/✓ switchTab tab 2 "Landing · Browser Lab" .*from=popup/)
  })
})

describe('the controlled tab closing', () => {
  it('says TAB CLOSED and names the tab now controlled (the opener), instead of moving silently', async () => {
    const executor = newExecutor('human')
    await run(executor, `await page.goto('${baseUrl}/popups.html', { waitUntil: 'domcontentloaded' })`)
    const first = await run(executor, 'console.log(await observe())')
    await run(executor, 'console.log(await observe())')
    await run(executor, `await act.click(${refOf(first, /Open popup window/)})`)
    await run(executor, `await act.switchTab('from=popup')`)
    const landing = await run(executor, 'console.log(await observe())')
    const closed = await run(executor, `await act.click(${refOf(landing, /Close this window/)})`)
    expect(closed).toMatch(
      /TAB CLOSED — the controlled tab "Landing · Browser Lab" \S*from=popup\S* was closed; now controlling tab 0 "Popups · Browser Lab" \S*popups\.html \(the tab that opened it\)/,
    )
    const after = await run(executor, 'console.log(await observe())')
    expect(after).toMatch(/PAGE {2}Popups · Browser Lab/)
  })

  it('with no tab left, says so, and reports the blank tab the next call works in', async () => {
    // Debug mode: closing the page from code is the way to lose the last tab here.
    const executor = newExecutor('debug')
    await run(executor, `await page.goto('${baseUrl}/landing.html', { waitUntil: 'domcontentloaded' })`)
    await run(executor, 'console.log(await observe())')
    const closed = await run(executor, 'await page.close()')
    expect(closed).toMatch(/TAB CLOSED — the controlled tab "Landing · Browser Lab" \S*landing\.html was closed and no tab is left/)
    const next = await run(executor, 'console.log(page.url())')
    expect(next).toMatch(/TAB {4}no tab was left, so a new blank tab was opened \(tab 0, about:blank\)/)
  })
})

describe('native dialogs', () => {
  async function dialogsPage(executor: PlaywrightExecutor): Promise<string> {
    await run(executor, `await page.goto('${baseUrl}/dialogs.html', { waitUntil: 'domcontentloaded' })`)
    return await run(executor, 'console.log(await observe())')
  }

  it('shows a prompt’s default value in the DIALOG line, and OK on it answers with that default', async () => {
    const executor = newExecutor('human')
    const page = await dialogsPage(executor)
    const opened = await run(executor, `await act.click(${refOf(page, /Ask prompt/)})`)
    expect(opened).toMatch(/DIALOG {2}prompt\("What is your name\?", default "Guest"\) is OPEN and blocks the page/)
    const accepted = await run(executor, 'await act.dialog.accept()')
    expect(accepted).toMatch(/✓ dialog-accept prompt\("What is your name\?", default "Guest"\) with "Guest"/)
    expect(accepted).toMatch(/Prompt result: Guest/)
  })

  for (const mode of ['human', 'debug'] as const) {
    it(`act.dialog.policy answers confirm and prompt as they open and says so (${mode} mode)`, async () => {
      const executor = newExecutor(mode)
      const page = await dialogsPage(executor)
      // A setting, not an action: it goes with the call's one action.
      const confirmed = await run(executor, `await act.dialog.policy('accept'); await act.click(${refOf(page, /Ask confirm/)})`)
      expect(confirmed).toMatch(/✓ dialog-policy confirm\/prompt: accept \(prompts with their default\) · beforeunload: ask/)
      expect(confirmed).toMatch(/DIALOG {2}confirm\("Discard draft\?"\) — accepted by the session dialog policy/)
      expect(confirmed).toMatch(/Confirm result: true/)
      const prompted = await run(executor, `await act.click(${refOf(page, /Ask prompt/)})`)
      expect(prompted).toMatch(/DIALOG {2}prompt\("What is your name\?", default "Guest"\) — accepted by the session dialog policy with "Guest"/)
      await run(executor, `await act.dialog.policy('dismiss')`)
      const dismissed = await run(executor, `await act.click(${refOf(page, /Ask confirm/)})`)
      expect(dismissed).toMatch(/DIALOG {2}confirm\("Discard draft\?"\) — dismissed by the session dialog policy/)
      expect(dismissed).toMatch(/Confirm result: false/)
    })
  }

  it('never answers "Leave site?" under accept; an explicit beforeunload setting answers the one waiting', async () => {
    const executor = newExecutor('human')
    const page = await dialogsPage(executor)
    await run(executor, `await act.fill(${refOf(page, /textbox "Draft title"/)}, 'Unsaved draft')`)
    await run(executor, `await act.dialog.policy('accept')`)
    const leaving = await run(executor, `await act.click(${refOf(page, /Leave this page/)})`)
    expect(leaving).toMatch(/DIALOG {2}beforeunload\(".*"\) is OPEN and blocks the page/)
    const left = await run(executor, `await act.dialog.policy('accept', { beforeunload: 'leave' })`)
    expect(left).toMatch(/answers the beforeunload\(".*"\) dialog that is open now/)
    expect(left).toMatch(/DIALOG {2}beforeunload\(".*"\) — accepted by the session dialog policy/)
    expect(left).toMatch(/NAV {5}NEW DOCUMENT → .*landing\.html\?from=dialogs/)
  })
})
