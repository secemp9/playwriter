/**
 * A page that closes its own tab in answer to an act input (a click, a double click, a right click,
 * Enter, a drag's release), end to end through the real executor on a headless Chromium, in human
 * mode. The close takes Chrome's confirmation of the release with it, at random; the report must say
 * ✓ and name the closing as the action's effect either way, never "FAILED" and never "Error
 * executing code". A tab that closes before the press is a failure, said as such.
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
let executor: PlaywrightExecutor

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const file = path.join(LAB, path.normalize(url.pathname).replace(/^\/+/, ''))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(file))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'act-closes-tab-'))
  executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  await run(`await page.goto('${baseUrl}/closes-itself.html', { waitUntil: 'domcontentloaded' })`)
})

afterAll(async () => {
  await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(cwd, { recursive: true, force: true })
})

async function run(code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
  return result.text
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

/** Open the tab closing on `on` from the opener (tab 0), work in it, and return its observation. */
async function openCloser(on: string): Promise<string> {
  const opener = await run('console.log(await observe())')
  expect(opener).toMatch(/PAGE {2}Closes Itself · Browser Lab/)
  await run(`await act.click(${refOf(opener, new RegExp(`Open a tab closing on ${on}\\b`))}, { again: true })`)
  await run(`await act.switchTab('on=${on}')`)
  return await run('console.log(await observe())')
}

const CLOSED_BY_ITSELF = / — the tab closed \(the page closed itself in response\)/

/**
 * Every way an act input closes the tab in these tests: the act call, its ACTION label, and which of
 * its events closes the tab. Closed on the release (or on the click/drop the release makes), Chrome
 * has confirmed the press; closed on the press itself, Chrome's confirmation of the press may be
 * lost with the tab, and the report then says it cannot tell whether the page got it.
 */
const CLOSING_INPUTS: Array<{ on: string; code: (closer: string) => string; label: string; closesOn: 'press' | 'release'; runs: number }> = [
  // The browser-lab landing page's "Close this window": window.close() in a click handler.
  { on: 'click', code: (closer) => `await act.click(${refOf(closer, /Close this tab/)})`, label: 'click', closesOn: 'release', runs: 10 },
  { on: 'mouseup', code: (closer) => `await act.click(${refOf(closer, /Close this tab/)})`, label: 'click', closesOn: 'release', runs: 10 },
  // Forces the race every time: the tab closes before the release is even sent.
  { on: 'pointerdown', code: (closer) => `await act.click(${refOf(closer, /Close this tab/)})`, label: 'click', closesOn: 'press', runs: 10 },
  { on: 'dblclick', code: (closer) => `await act.dblclick(${refOf(closer, /Close this tab/)})`, label: 'dblclick', closesOn: 'release', runs: 3 },
  { on: 'contextmenu', code: (closer) => `await act.click(${refOf(closer, /Close this tab/)}, { button: 'right' })`, label: 'click', closesOn: 'press', runs: 3 },
  { on: 'keydown', code: (closer) => `await act.press('Enter', { ref: ${refOf(closer, /Close this tab/)} })`, label: 'press', closesOn: 'press', runs: 3 },
  { on: 'drop', code: (closer) => `await act.drag(${refOf(closer, /Close this tab/)}, ${refOf(closer, /Drop here/)})`, label: 'drag', closesOn: 'release', runs: 3 },
]

describe('an act input that makes the page close its own tab', () => {
  for (const input of CLOSING_INPUTS) {
    it(`reports the tab closing as the input's effect, closed on ${input.on} (${input.runs} runs)`, async () => {
      const outcomes = { named: 0, tabClosedLineOnly: 0, pressUnconfirmed: 0 }
      for (let attempt = 0; attempt < input.runs; attempt++) {
        const closer = await openCloser(input.on)
        const result = await executor.execute(input.code(closer), 30000)
        expect(result.text).toMatch(
          new RegExp(`TAB CLOSED — the controlled tab "Closer ${input.on} · Browser Lab" \\S*on=${input.on}\\S* was closed; now controlling tab 0 "Closes Itself · Browser Lab"`),
        )
        const actionLine = result.text.split('\n').find((line) => line.startsWith('ACTION')) ?? ''
        if (input.closesOn === 'press' && result.isError) {
          // Chrome lost the press's own confirmation with the tab: not claimed done, not claimed undone.
          const what = input.label === 'press' ? 'the key Enter was being pressed: Chrome closed it before confirming the key' : 'the mouse button was being pressed: Chrome closed it before confirming the press'
          expect(result.text).toContain(`FAILED: The tab closed while ${what}, so whether the page got it cannot be told.`)
          outcomes.pressUnconfirmed += 1
          continue
        }
        expect(result.isError, result.text).toBe(false)
        expect(result.text).not.toMatch(/FAILED|Error executing code|✗/)
        expect(actionLine, result.text).toMatch(new RegExp(`^ACTION {2}✓ ${input.label} \\[\\d+\\] button "Close this tab"`))
        if (CLOSED_BY_ITSELF.test(actionLine)) outcomes.named += 1
        else outcomes.tabClosedLineOnly += 1
      }
      console.log(`closed on ${input.on}: ${JSON.stringify(outcomes)}`)
    }, 240000)
  }

  it('reports a tab that closed before the press as not done, nothing clicked', async () => {
    const closer = await openCloser('pointermove')
    const result = await executor.execute(`await act.click(${refOf(closer, /Close this tab/)})`, 30000)
    expect(result.isError, result.text).toBe(true)
    expect(result.text).toMatch(/✗ click \[\d+\] button "Close this tab"\n {8}FAILED: Not done: the tab closed before the mouse button was pressed \(while the pointer moved to it\); nothing was clicked\./)
    expect(result.text).not.toMatch(CLOSED_BY_ITSELF)
    expect(result.text).toMatch(/TAB CLOSED — the controlled tab "Closer pointermove · Browser Lab" \S*on=pointermove\S* was closed; now controlling tab 0 "Closes Itself · Browser Lab"/)
  }, 60000)
})
