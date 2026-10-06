/**
 * The action report and the human-mode run-time policy, end to end through the real executor on
 * headless Chromium: what a click that opens a file chooser, a download in a popup, and a page that
 * closes while the report waits for it look like to the model; that human-mode raw CDP only reads;
 * and that a second action the static analysis could not see is refused when it is dispatched.
 *
 * Every assertion is on what the MODEL reads.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const PAGE = `<!doctype html>
<html><head><title>Report fixture</title></head>
<body>
  <main>
    <h1>Account</h1>
    <label for="cv">Resume</label>
    <input id="cv" type="file">
    <p><a href="/export" target="_blank">Export CSV</a></p>
    <p><a href="#/details">Details</a></p>
    <p id="route">Overview</p>
    <button id="a" onclick="document.getElementById('route').textContent = 'A pressed'">A</button>
    <button id="b" onclick="document.getElementById('route').textContent = 'B pressed'">B</button>
  </main>
  <script>
    window.addEventListener('hashchange', () => {
      document.getElementById('route').textContent = 'Details for ' + location.hash
    })
  </script>
</body></html>`

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/export') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' })
      res.end('id,total\n1,42\n')
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
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-report-'))
})

afterAll(async () => {
  for (const executor of executors) {
    await executor.closeHeadlessContext().catch(() => {})
  }
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

/** A fresh session on the fixture page, with what the model saw on it. */
async function openFixture(policy: 'human' | 'debug'): Promise<{ executor: PlaywrightExecutor; observation: string }> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const load = await executor.execute(`await page.goto('${baseUrl}/', { waitUntil: 'domcontentloaded' })`, 30000)
  expect(load.isError, load.text).toBe(false)
  const look = await executor.execute('await observe()', 30000)
  expect(look.isError, look.text).toBe(false)
  return { executor, observation: look.text }
}

/** The ref printed in front of the first line matching `pattern`, e.g. `[12] link "Export CSV"`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

describe('action report', () => {
  it('reports the file dialog a click opened, keeps it open, and answers it with act.dialog.chooseFiles', async () => {
    const { executor, observation } = await openFixture('human')
    const resume = refOf(observation, /Resume/)
    const result = await executor.execute(`await act.click(${resume})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(
      new RegExp(`FILE DIALOG OPEN, opened by your click \\[${resume}\\] .*Resume.* \\(one file\\) — the page waits for an answer: act\\.dialog\\.chooseFiles\\(path\\)`),
    )
    expect(result.text).not.toMatch(/NO VISIBLE CHANGE/)
    // A person facing a file dialog answers it before doing anything else.
    const blocked = await executor.execute(`await act.click(${resume})`, 30000)
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toMatch(/A file dialog is open \(opened by your click .*\) and the page waits for it/)
    const looked = await executor.execute('await observe()', 30000)
    expect(looked.text).toMatch(new RegExp(`FILE DIALOG open, opened by your click \\[${resume}\\]`))
    fs.writeFileSync(path.join(cwd, 'cv.pdf'), 'cv')
    const chosen = await executor.execute("await act.dialog.chooseFiles('cv.pdf')", 30000)
    expect(chosen.isError, chosen.text).toBe(false)
    expect(chosen.text).toMatch(/a file dialog \(one file\): cv\.pdf was chosen in it/)
    expect(chosen.text).not.toMatch(/FILE DIALOG OPEN/)
    const after = await executor.execute('await observe()', 30000)
    expect(after.text).not.toMatch(/FILE DIALOG/)
  })

  it('reports a download made in a popup, with its completion', async () => {
    const { executor, observation } = await openFixture('human')
    const exportLink = refOf(observation, /link "Export CSV"/)
    const result = await executor.execute(`await act.click(${exportLink})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/DOWNLOAD report\.csv from .*\/export.* — completed/)
    expect(result.text).not.toMatch(/NO VISIBLE CHANGE/)
  })

  it('keeps the action and NAV lines when the page closes while the report waits for it', async () => {
    const { executor, observation } = await openFixture('human')
    const details = refOf(observation, /link "Details"/)
    // A real timer on purpose: the page has to close while the executor's settle is running against
    // the browser's clock, after the click returned — nothing in this process can stand in for that.
    const result = await executor.execute(`await act.click(${details})\nsetTimeout(() => { page.close() }, 100)`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(new RegExp(`✓ click \\[${details}\\] link "Details"`))
    expect(result.text).toMatch(/NAV {5}in-app route → \/#\/details/)
    expect(result.text).toMatch(/AFTER-STATE UNAVAILABLE — the page was closed/)
  })

  it('follows raw input to the tab it went to, names that tab, and makes no claim without a picture of it', async () => {
    const { executor } = await openFixture('debug')
    const opened = await executor.execute('state.other = await context.newPage()', 30000)
    expect(opened.isError, opened.text).toBe(false)

    const navigated = await executor.execute(`await state.other.goto('${baseUrl}/', { waitUntil: 'domcontentloaded' })`, 30000)
    expect(navigated.isError, navigated.text).toBe(false)
    expect(navigated.text).toContain(`ACTION  (raw Playwright) goto ${baseUrl}/ on tab 1 "Report fixture" — `)
    expect(navigated.text).toContain(`NAV     NEW DOCUMENT → ${baseUrl}/`)
    expect(navigated.text).not.toMatch(/NO VISIBLE CHANGE/)

    // The controlled tab has a picture from before the code ran; the other tab does not, so a click
    // there gets no diff and no "nothing changed" — even though the controlled tab did not change.
    const clicked = await executor.execute("await state.other.click('#a')", 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toContain('ACTION  (raw Playwright) Click on #a on tab 1 "Report fixture" — ')
    expect(clicked.text).toMatch(/SETTLED \d+ms/)
    expect(clicked.text).not.toMatch(/NO VISIBLE CHANGE/)
    expect(clicked.text).not.toMatch(/^NAV/m)
  })
})

describe('human mode at run time', () => {
  it('lets raw CDP read and refuses raw CDP that would act', async () => {
    const { executor } = await openFixture('human')
    const read = await executor.execute(
      "const cdp = await getCDPSession({ page })\nconst { root } = await cdp.send('DOM.getDocument', { depth: 0 })\nconst { node } = await cdp.send('DOM.describeNode', { nodeId: root.nodeId })\nreturn node.nodeName",
      30000,
    )
    expect(read.isError, read.text).toBe(false)
    expect(read.text).toContain('#document')
    const input = await executor.execute(
      "const cdp = await getCDPSession({ page })\nawait cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 })",
      30000,
    )
    expect(input.isError).toBe(true)
    expect(input.text).toContain("Refused (human mode): getCDPSession().send('Input.dispatchMouseEvent') is not a read.")
  })

  it('refuses a second raw action that only shows up at run time', async () => {
    const { executor } = await openFixture('human')
    // One click as far as the static pass can tell (the helper is called through an array element);
    // two when it runs.
    const result = await executor.execute("const press = (selector) => page.click(selector)\nconst steps = [press]\nawait steps[0]('#a')\nawait steps[0]('#b')", 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Refused \(human mode\): Click on #b would be another action in this call, after Click on #a/)
    const look = await executor.execute('await observe()', 30000)
    expect(look.text).toMatch(/A pressed/)
    expect(look.text).not.toMatch(/B pressed/)
  })
})
