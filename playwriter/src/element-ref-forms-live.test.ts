/**
 * The element readers' `{ ref }` forms: the element a ref names is read over CDP and playwriter's
 * isolated world, never with Playwright's script in the page. In debug mode they answer exactly what
 * the locator forms answer; in human mode the locator forms are refused before anything runs and the
 * ref forms work, leaving the page unactivated.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const PAGE = `<!doctype html><html><head><title>Ref forms</title><style>
  .primary { color: rgb(0, 0, 255); padding: 8px 16px; }
  #save { color: rgb(255, 0, 0); }
</style></head><body>
  <h1>Settings</h1>
  <label>Email <input id="email" type="email" placeholder="you@example.com"></label>
  <button id="save" class="primary" data-kind="submit">Save <b>now</b></button>
</body></html>`

/** A production stylesheet: one line of 120 000 characters, the rule that colours the button in the middle of it. */
const MINIFIED_CSS = `${'.pad{margin:0}'.repeat(4000)}#deal{color:rgb(0,128,0)}${'.tail{padding:0}'.repeat(4000)}`
const MINIFIED_PAGE = `<!doctype html><html><head><title>Minified</title><link rel="stylesheet" href="/min.css"></head><body><button id="deal">Deal</button></body></html>`

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const css = req.url === '/min.css'
    res.writeHead(200, { 'Content-Type': css ? 'text/css' : 'text/html; charset=utf-8' })
    res.end(css ? MINIFIED_CSS : req.url === '/min' ? MINIFIED_PAGE : PAGE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}/`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-forms-'))
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

/** A fresh executor whose blank tab loads a fixture page (the first load of a blank tab is allowed in human mode too). */
async function open(policy: 'human' | 'debug', at = ''): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}${at}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

/** The ref observe() printed for the Save button. */
async function saveRef(executor: PlaywrightExecutor): Promise<number> {
  const seen = await executor.execute('await observe()', 30000)
  expect(seen.isError, seen.text).toBe(false)
  const match = seen.text.match(/\[(\d+)\] button "Save now"/)
  if (!match) throw new Error(`no ref for the Save button in:\n${seen.text}`)
  return Number(match[1])
}

describe('element readers: { ref } forms', () => {
  it('answer what the locator forms answer, in debug mode', async () => {
    const debug = await open('debug')
    const ref = await saveRef(debug)
    const result = await debug.execute(
      [
        "const locator = page.locator('#save')",
        "const byLocator = await debugStyle({ locator, property: 'color' })",
        `const byRef = await debugStyle({ ref: ${ref}, property: 'color' })`,
        'const htmlByLocator = await getCleanHTML({ locator })',
        `const htmlByRef = await getCleanHTML({ ref: ${ref} })`,
        'const from = { x: 5, y: 5 }',
        'const planByLocator = await humanMouse.plan({ locator, from, seed: 7 })',
        `const planByRef = await humanMouse.plan({ ref: ${ref}, from, seed: 7 })`,
        'return JSON.stringify({',
        '  style: byLocator.text === byRef.text, styleText: byRef.text,',
        '  html: htmlByLocator === htmlByRef, htmlText: htmlByRef,',
        '  plan: JSON.stringify(planByLocator) === JSON.stringify(planByRef),',
        '})',
      ].join('\n'),
      30000,
    )
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('"style":true')
    expect(result.text).toContain('rgb(255, 0, 0)')
    expect(result.text).toContain('"html":true')
    expect(result.text).toContain('now')
    expect(result.text).toContain('"plan":true')
  })

  it('in human mode: refuses the locator form before it runs, reads by ref, and leaves the page unactivated', async () => {
    const human = await open('human')
    // Written out, the policy reads it before the code runs: nothing of the call runs.
    const refused = await human.execute("state.ran = true\nreturn await debugStyle({ locator: page.locator('#save'), property: 'color' })", 30000)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("debugStyle({ locator }) on line 2 → debugStyle({ ref: 12 }). Given a Playwright locator, selector or element handle")
    expect(refused.text).toContain('Nothing from this call was run.')
    expect((await human.execute('return String(state.ran)', 30000)).text).toContain('undefined')
    // Built in a variable, it is refused when the reader is called, before any Playwright call of it.
    const dynamic = await human.execute("const options = { locator: page.locator('#save'), property: 'color' }\nreturn await debugStyle(options)", 30000)
    expect(dynamic.isError).toBe(true)
    expect(dynamic.text).toContain(
      "Refused (human mode): debugStyle({ locator }) resolves the locator with Playwright's script in the page, which Playwright " +
        'runs as a user gesture (the page then counts as clicked: navigator.userActivation). Pass a ref from observe() or find(): ' +
        'debugStyle({ ref: 12 }). It was not run.',
    )
    const enabled = await human.execute('return await humanMouse.enable()', 30000)
    expect(enabled.isError).toBe(true)
    expect(enabled.text).toContain('humanMouse.enable() on line 1 routes locator.click/dblclick/hover through human motion')
    expect(enabled.text).toContain('act.click(12), act.hover(12)')

    const ref = await saveRef(human)
    const look = (await human.execute('await observe()', 30000)).text
    const email = /\[(\d+)\] textbox "Email"/.exec(look)?.[1]
    if (!email) throw new Error(`no ref for the Email field in:\n${look}`)
    const read = await human.execute(
      `const style = await debugStyle({ ref: ${ref}, property: 'color' })\n` +
        `const html = await getCleanHTML({ ref: ${ref} })\n` +
        `const field = await getCleanHTML({ ref: ${email} })\n` +
        `const styles = await getStylesForLocator({ ref: ${ref} })\n` +
        // A page-model handle's cascade is read by the node's id in the model's own session.
        "const handle = await pm.anchor('element#save')\n" +
        'const winners = await handle.styles()\n' +
        'return JSON.stringify({ style: style.text.includes("rgb(255, 0, 0)"), html, field, rules: styles.rules.length, color: winners.color })',
      30000,
    )
    expect(read.isError, read.text).toBe(false)
    expect(read.text).toContain('"style":true')
    expect(read.text).toContain('now')
    // An element is read with its own tag: a field has no content, and is not empty.
    expect(read.text).toContain('"field":"<input')
    expect(read.text).toContain('type=\\"email\\"')
    expect(read.text).toMatch(/"color":\{"value":"rgb\(255, 0, 0\)","selector":"#save"/)

    const activation = await human.execute('return await readPage(() => navigator.userActivation.hasBeenActive)', 30000)
    expect(activation.isError, activation.text).toBe(false)
    expect(activation.text).toContain('[return value] false')
  })

  it("points at the winning rule of a minified stylesheet with a frame of a few short lines, not the stylesheet's one long line", async () => {
    const human = await open('human', 'min')
    const look = (await human.execute('await observe()', 30000)).text
    const deal = /\[(\d+)\] button "Deal"/.exec(look)?.[1]
    if (!deal) throw new Error(`no ref for the Deal button in:\n${look}`)
    const style = await human.execute(`return (await debugStyle({ ref: ${deal}, property: 'color' })).text`, 30000)
    expect(style.isError, style.text).toBe(false)
    const frame = style.text.slice(style.text.indexOf('> 1 |'))
    expect(frame).toMatch(/> 1 \| …[^\n]*#deal\{color:rgb\(0,128,0\)\}[^\n]*…/)
    expect(frame).toMatch(/\n\s+\|\s*\^/)
    for (const line of frame.split('\n')) expect(line.length).toBeLessThan(200)
  })
})
