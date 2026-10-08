/**
 * What the human-mode report says about the Browser Lab pages (test/fixtures/browser-lab), on
 * headless Chromium through the executor, each claim checked on the exact text a model reads:
 *  - a call that only waited says it waited and that nothing changed meanwhile, never "do not
 *    assume it worked" (a wait is not an action);
 *  - a new tab gets one line naming act.switchTab, not a second Playwright `context.pages()[1]` warning;
 *  - a multi-line value and text show their line breaks as ⏎ in the change lines;
 *  - getLatestLogs({ search }) returns the matching entries only;
 *  - table rows a page re-rendered unchanged are not printed as -/+ pairs when the table's caption
 *    (its name) changed with them;
 *  - a plain ref covered everywhere names the spot to press anyway, as a point target does.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
}

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const file = path.join(LAB, path.normalize(pathname))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'report-wording-'))
}, 60000)

afterAll(async () => {
  const closing = await Promise.allSettled(executors.map((executor) => executor.closeHeadlessContext()))
  const shared = await Promise.allSettled([PlaywrightExecutor.closeSharedHeadlessBrowser()])
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close((error) => (error ? closed.reject(error) : closed.resolve()))
  const stopped = await Promise.allSettled([closed.promise])
  fs.rmSync(cwd, { recursive: true, force: true })
  const errors = [...closing, ...shared, ...stopped].flatMap((outcome): unknown[] => (outcome.status === 'rejected' ? [outcome.reason] : []))
  if (errors.length > 0) throw new AggregateError(errors, `teardown failed ${errors.length} time(s): ${errors.map(String).join('; ')}`)
})

async function openPage(file: string, policy: 'human' | 'debug' = 'human'): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}/${file}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

async function refOf(executor: PlaywrightExecutor, query: string, line: RegExp): Promise<number> {
  const found = await executor.execute(`await find(${JSON.stringify(query)})`, 30000)
  const match = line.exec(found.text)
  expect(match, found.text).not.toBeNull()
  return Number(match![1])
}

describe('a call that only waited (H6)', () => {
  it('says it waited and nothing changed, not that an action may not have worked', async () => {
    const executor = await openPage('form.html')
    // A page the model has looked at (FORM-T1 waited after reading the result).
    await executor.execute('await observe()', 30000)
    const idle = await executor.execute('await act.waitForIdle()', 60000)
    expect(idle.isError, idle.text).toBe(false)
    expect(idle.text).not.toContain('Do not assume it worked')
    expect(idle.text).not.toContain('NO VISIBLE CHANGE')
    expect(idle.text).toMatch(/^NOTHING CHANGED WHILE WAITING — waited \d+ms; the page was quiet; the page looks as it did before the wait\./m)
    const waited = await executor.execute('await act.wait(300)', 30000)
    expect(waited.text).toMatch(/^NOTHING CHANGED WHILE WAITING — waited 3\d\dms; the page looks as it did before the wait\./m)
    expect(waited.text).not.toContain('Do not assume it worked')
  }, 120000)
})

describe('a new tab (H7)', () => {
  it('is one TAB line naming act.switchTab, with no Playwright context.pages() warning in this call or the next', async () => {
    const executor = await openPage('popups.html')
    const link = await refOf(executor, 'Open landing in a new tab', /\[(\d+)\] link "Open landing in a new tab"/)
    const clicked = await executor.execute(`await act.click(${link})`, 60000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/^TAB {5}a new tab opened by this page: .* — act\.switchTab\(1\) to work in it$/m)
    expect(clicked.text.match(/a new tab opened by this page/g), clicked.text).toHaveLength(1)
    expect(clicked.text).not.toContain('[WARNING]')
    expect(clicked.text).not.toContain('context.pages()')
    const next = await executor.execute('await observe()', 30000)
    expect(next.text).not.toContain('[WARNING]')
    expect(next.text).not.toContain('context.pages()')
  }, 120000)
})

describe('a multi-line value in the change lines (H8)', () => {
  it('shows the composer value and the sent message with their line break as ⏎', async () => {
    const executor = await openPage('keyboard.html')
    const composer = await refOf(executor, 'Message', /\[(\d+)\] textbox "Message"/)
    const typed = await executor.execute(`await act.fill(${composer}, 'Hello\\nWorld', { newline: 'Shift+Enter' })`, 60000)
    expect(typed.isError, typed.text).toBe(false)
    expect(typed.text).toContain('value read back: "Hello⏎World"')
    expect(typed.text).toMatch(/value "" → "Hello⏎World"|= "Hello⏎World"/)
    const sent = await executor.execute(`await act.press('Enter')`, 60000)
    expect(sent.isError, sent.text).toBe(false)
    expect(sent.text).toMatch(/^\+ item: "Hello⏎World"/m)
    expect(sent.text).toContain('value "Hello⏎World" → ""')
    expect(sent.text).not.toContain('"Hello World"')
  }, 120000)
})

describe('getLatestLogs filters (H9f)', () => {
  it('returns only the entries a search matches, a string case-insensitively, a global regex every time', async () => {
    const executor = await openPage('errors.html')
    const read = async (options: string): Promise<string[]> => {
      const result = await executor.execute(`return JSON.stringify(await getLatestLogs(${options}))`, 30000)
      expect(result.isError, result.text).toBe(false)
      const json = /\[return value\] ([\s\S]*)$/.exec(result.text)?.[1]
      if (json === undefined) throw new Error(`no return value in:\n${result.text}`)
      const parsed: unknown = JSON.parse(json.trim())
      if (!Array.isArray(parsed)) throw new Error(`not an array: ${result.text}`)
      return parsed.map(String)
    }
    const all = await read('')
    expect(all.filter((entry) => entry.includes('[errors]'))).toHaveLength(3)
    const preferences = await read("{ search: 'PREFERENCES' }")
    expect(preferences).toHaveLength(1)
    expect(preferences[0]).toContain('[error] [errors] failed to load user preferences')
    const global = await read('{ search: /\\[errors\\] (page|failed)/g }')
    expect(global.map((entry) => entry.split('\n')[0])).toEqual(['[log] [errors] page loaded', '[error] [errors] failed to load user preferences'])
    expect(await read("{ search: '[errors]', count: 0 }")).toEqual([])
    expect(await read("{ search: '[errors]', count: 1 }")).toHaveLength(1)
  }, 120000)
})

describe('rows re-rendered unchanged while their table was renamed (H9g)', () => {
  it('reports the deleted and the new row, not every unchanged row as a -/+ pair', async () => {
    const executor = await openPage('table.html')
    const remove = await refOf(executor, 'Initech', /\[(\d+)\] button "Delete" \(in row "INV-1003 Initech/)
    const clicked = await executor.execute(`await act.click(${remove})`, 60000)
    expect(clicked.text).toContain('DIALOG')
    const accepted = await executor.execute('await act.dialog.accept()', 60000)
    expect(accepted.isError, accepted.text).toBe(false)
    expect(accepted.text).toContain('~ table "Showing 1–6 of 11 invoices" (was "Showing 1–6 of 12 invoices")')
    expect(accepted.text).toMatch(/^- row: "INV-1003 \| Initech/m)
    expect(accepted.text).toMatch(/^\+ row: "INV-1007 \| Hooli/m)
    for (const unchanged of ['INV-1001', 'INV-1002', 'INV-1004', 'INV-1005', 'INV-1006']) {
      expect(accepted.text, unchanged).not.toMatch(new RegExp(`^[-+] row: "${unchanged}`, 'm'))
    }
  }, 120000)
})

describe('a plain ref covered at every point (H9g)', () => {
  it('names the spot to press anyway as a point of the cover, like a point target', async () => {
    const executor = await openPage('overlay.html')
    // The newsletter modal opens 1.2 s after load; its backdrop (which has a ref) then covers Continue.
    await executor.execute('await act.wait(2000)', 30000)
    const cont = await refOf(executor, 'Continue', /\[(\d+)\] button "Continue"/)
    const refused = await executor.execute(`await act.click(${cont})`, 60000)
    expect(refused.text).toContain('at every point a person could click')
    expect(refused.text).toMatch(/To press that spot anyway \(it lands on what is on top\): \{ ref: \d+, x: [\d.]+, y: [\d.]+ \}\./)
  }, 120000)
})
