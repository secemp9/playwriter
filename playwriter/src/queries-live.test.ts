/**
 * find()/readPage() query handlers, snapshot() without options and with `diff`, and getCleanHTML({ ref })
 * against a real headless Chromium, through the executor in human mode (and debug mode where the
 * classification matters): what the model gets back, and that the refs it gets work.
 *
 * Fixture: test/fixtures/queries/page.html, served on an ephemeral port.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const FIXTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/queries/page.html'), 'utf8')

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}/`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'queries-'))
})

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

async function open(policy: 'human' | 'debug'): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

async function run(executor: PlaywrightExecutor, code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
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

describe('find() query handlers', () => {
  let human: PlaywrightExecutor
  beforeAll(async () => {
    human = await open('human')
  })

  it('finds by role with a name, exact or not, and counts', async () => {
    const tooltip = await run(human, "await find('role/tooltip')")
    expect(tooltip).toContain("1 match for \"role/tooltip\"")
    expect(tooltip).toMatch(/\[\d+\] tooltip <div> "Free shipping over \$50" — in view · box x=\d+ y=\d+ w=\d+ h=\d+/)
    const loose = await run(human, `const r = await find('role/button[name="save"]'); return [r.count, r.matches.map((m) => m.name)]`)
    expect(loose).toContain("[ 2, [ 'Save', 'Save draft' ] ]")
    const exact = await run(human, `const r = await find('role/button[name="Save" exact]'); return [r.count, r.matches.map((m) => m.name)]`)
    expect(exact).toContain("[ 1, [ 'Save' ] ]")
    expect(await run(human, "await find('role/img')")).toMatch(/\[\d+\] image .*"Company logo"/)
    const none = await run(human, "await find('role/dialog')")
    expect(none).toContain('No element matches "role/dialog" on this page (the accessibility tree: an element that is hidden')
  })

  it('finds by label, placeholder, alt, title and test id', async () => {
    expect(await run(human, "await find('label/email')")).toMatch(/1 match[\s\S]*textbox "Email address"/)
    expect(await run(human, "await find('label/wrapped name')")).toMatch(/textbox "Wrapped name"/)
    expect(await run(human, "await find('label/catalogue')")).toMatch(/textbox "Search the catalogue"/)
    expect(await run(human, "await find('placeholder/EXAMPLE.com')")).toMatch(/1 match[\s\S]*textbox "Email address"/)
    expect(await run(human, "await find('alt/logo')")).toMatch(/1 match[\s\S]*"Company logo"/)
    expect(await run(human, "await find('title/help page')")).toMatch(/1 match[\s\S]*link "Help"/)
    expect(await run(human, "await find('testid/save-btn')")).toMatch(/1 match[\s\S]*button "Save" \[disabled\]/)
  })

  it('finds the innermost element with a text, CSS through open and closed shadow roots, and XPath', async () => {
    const text = await run(human, "await find('text/order placed')")
    expect(text).toMatch(/1 match[\s\S]*paragraph <p> — in view/)
    expect(await run(human, "await find('pierce/button.inner')")).toMatch(/1 match[\s\S]*button "Shadow button"/)
    expect(await run(human, "await find('pierce/.inner-text')")).toMatch(/1 match[\s\S]*<span>/)
    expect(await run(human, "await find('pierce/.deep')")).toMatch(/1 match[\s\S]*<span>/)
    expect(await run(human, "await find('xpath///ul/li[2]')")).toMatch(/1 match[\s\S]*listitem <li>/)
    const far = await run(human, "await find('text/far below the fold')")
    expect(far).toMatch(/below, [\d.]+ screens down/)
    // observe() lists the button, so its row says what observe says; the paragraph is measured by the query.
    expect(await run(human, "await find('pierce/#covered')")).toMatch(/button "Under the veil" — in view but covered by div\.veil/)
    expect(await run(human, "await find('text/veiled note')")).toMatch(/paragraph <p> — in view, but covered by div\.shade at its centre — a click would hit that instead/)
  })

  it('gives refs that readPage, getCleanHTML and act can use, for elements observe() does not list', async () => {
    const tooltip = refOf(await run(human, "await find('role/tooltip')"), /tooltip/)
    expect(await run(human, `return await readPage((el) => el.id, { ref: ${tooltip} })`)).toContain('tip')
    expect(await run(human, `return await getCleanHTML({ ref: ${tooltip} })`)).toContain('id="tip"')
    const hovered = await human.execute(`await act.hover(${tooltip})`, 30000)
    expect(hovered.isError, hovered.text).toBe(false)
    expect(hovered.text).not.toContain('is not among what the page shows')
    const shadow = refOf(await run(human, "await find('pierce/button.inner')"), /Shadow button/)
    await run(human, `await act.click(${shadow})`)
    expect(await run(human, "return await readPage(() => document.getElementById('count').textContent)")).toContain('shadow clicked')
  })

  it('reads the one element a query matches with readPage(fn, { query }), and refuses several', async () => {
    expect(await run(human, "return await readPage((el) => el.textContent, { query: 'role/tooltip' })")).toContain('Free shipping over $50')
    const several = await human.execute(`return await readPage((el) => el.textContent, { query: 'role/button[name="save"]' })`, 30000)
    expect(several.isError).toBe(true)
    expect(several.text).toContain('2 elements match "role/button[name=\\"save\\"]", and readPage reads one')
  })

  it('keeps plain-text find, and names the grammar of a malformed query', async () => {
    expect(await run(human, "await find('Initech')")).toContain('Initech')
    const malformed = await human.execute("await find('role/button[name=')", 30000)
    expect(malformed.isError).toBe(true)
    expect(malformed.text).toContain('role/<role>[name="…"]')
  })

  it('is a read in debug mode too', async () => {
    const debug = await open('debug')
    expect(await run(debug, "await find('label/email')")).toMatch(/textbox "Email address"/)
  })

  it('leaves the page untouched: no mutation, no input or focus event, no user activation, no console helper', async () => {
    const fresh = await open('human')
    const queries = [
      'role/tooltip',
      'role/button[name="save"]',
      'label/email',
      'placeholder/example',
      'text/order placed',
      'alt/logo',
      'title/help',
      'testid/save-btn',
      'pierce/button.inner',
      'pierce/#covered',
      'xpath///ul/li[2]',
      'text/veiled note',
    ]
    const read = "return await readPage(() => JSON.stringify({ ...window.__witness, active: navigator.userActivation.hasBeenActive, helpers: ['$_', '$0', '$', 'keys'].filter((name) => Object.getOwnPropertyNames(window).includes(name)) }))"
    // The parser's own tail (the text after the observer's script) counts a few mutations at load.
    const before = await run(fresh, read)
    expect(before).toMatch(/\{"mutations":\d+,"events":\[\],"active":false,"helpers":\[\]\}/)
    for (const query of queries) await run(fresh, `await find(${JSON.stringify(query)})`)
    await run(fresh, "return await readPage((el) => el.textContent, { query: 'role/tooltip' })")
    await run(fresh, 'return await snapshot({ diff: true })')
    expect(await run(fresh, read)).toBe(before)
  })
})

describe('snapshot()', () => {
  it('reads the controlled page without options', async () => {
    const human = await open('human')
    expect(await run(human, 'return await snapshot()')).toContain('heading "Customers"')
  })

  it('returns revisions: full, unchanged, a delta keyed by node, per scope, and full again on a new document', async () => {
    const human = await open('human')
    const first = await run(human, 'return await snapshot({ diff: true })')
    expect(first).toContain('snapshot r1 — full tree (the first snapshot of this scope)')
    expect(first).toContain('heading "Customers"')
    expect(await run(human, 'const r = await snapshot({ diff: true }); return [r.status, r.revision]')).toContain("[ 'unchanged', 1 ]")
    const look = await run(human, 'await observe()')
    await run(human, `await act.click(${refOf(look, /button "Toggle panel"/)})`)
    const delta = await run(human, 'return await snapshot({ diff: true })')
    // The click also focused the toggle: a change like any other.
    expect(delta).toContain('snapshot r2 — delta since r1: 2 added, 0 removed, 2 changed')
    expect(delta).toMatch(/~ - button "Toggle panel".*\[focused\]/)
    expect(delta).toMatch(/\+ - region:? {2}\(in main\)/)
    expect(delta).toMatch(/\+ {3}- role=button\[name="Panel button"\]/)
    expect(delta).toMatch(/~ - checkbox "I agree".*\[checked\].*\(was: checkbox "I agree".*\[unchecked\]/)
    expect(delta).not.toContain('heading "Customers"')
    expect(await run(human, 'const r = await snapshot({ showDiffSinceLastCall: true }); return [r.status, r.revision]')).toContain("[ 'unchanged', 2 ]")
    await run(human, `await act.click(${refOf(look, /button "Reverse list"/)})`)
    const sorted = await run(human, 'return await snapshot({ diff: true })')
    expect(sorted).toContain('snapshot r3 — delta since r2')
    expect(sorted).toMatch(/~ - list:? {2}\(its children are in another order now\)/)
    // Chrome rebuilt the items' list markers: new nodes that read the same, counted, not listed as removed and added.
    expect(sorted).toMatch(/re-rendered without a change, not listed/)
    expect(sorted).not.toContain('listmarker')
    const list = refOf(await run(human, "await find('role/list')"), /list/)
    expect(await run(human, `return await snapshot({ ref: ${list}, diff: true })`)).toContain('snapshot r1 — full tree (the first snapshot of this scope)')
    await run(human, `await act.open('${baseUrl}', { reason: 'a new document is the test' })`)
    expect(await run(human, 'return await snapshot({ diff: true })')).toContain('snapshot r4 — full tree (a new document since r3)')
    const both = await human.execute("return await snapshot({ diff: true, search: 'Save' })", 30000)
    expect(both.isError).toBe(true)
    expect(both.text).toContain('pass one of them')
  })
})

describe('getCleanHTML({ ref })', () => {
  it("keeps an element's id, class, state, aria and test id, and drops its style and handlers", async () => {
    const human = await open('human')
    const save = refOf(await run(human, 'await observe()'), /button "Save" \[disabled\]/)
    const html = await run(human, `return await getCleanHTML({ ref: ${save} })`)
    for (const kept of ['id="save"', 'class="primary big"', 'disabled', 'aria-describedby="hint"', 'data-testid="save-btn"', 'type="submit"']) expect(html).toContain(kept)
    expect(html).not.toContain('style=')
    expect(html).not.toContain('onclick')
    const page = await run(human, 'return await getCleanHTML({ locator: page })')
    expect(page).toContain('id="save"')
    expect(page).not.toContain('class="primary big"')
  })
})
