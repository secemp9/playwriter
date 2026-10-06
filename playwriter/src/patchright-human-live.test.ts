/**
 * Human mode on the patchright engine (`PLAYWRITER_PATCHRIGHT=1`, `@playwriter/patchright-core`). The
 * engine is chosen once per process (`getChromium` caches it), so this file selects it before anything
 * loads one. It walks one human-mode flow — load, observe, act.click, readPage — and checks that the
 * page's own console.log(element) neither activates the page nor builds Playwright's injected script in
 * its world, also when the server does receive those messages.
 */

import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { getChromium } from './playwright-import.js'

const previousEngine = process.env.PLAYWRITER_PATCHRIGHT
process.env.PLAYWRITER_PATCHRIGHT = '1'

function isInstalled(name: string): boolean {
  try {
    createRequire(import.meta.url).resolve(name)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') return false
    throw error
  }
}

const PATCHRIGHT = '@playwriter/patchright-core'
const patchrightInstalled = isInstalled(PATCHRIGHT)

/**
 * A shop page that logs its button to the console on a timer, as debugging code on real sites does, and
 * records every listener added through its own world's EventTarget.prototype — where Playwright's
 * injected script adds its capture listeners when it is built in the page's world. Its own click handler
 * is a property, so the record starts empty.
 */
const SHOP = `<!doctype html><html><head><title>Shop</title></head><body>
<button id="b" class="buy">Buy</button><p id="status">Not bought</p>
<script>
  window.listenersAdded = []
  const add = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, listener, options) { window.listenersAdded.push(String(type)); return add.call(this, type, listener, options) }
  document.getElementById('b').onclick = () => { document.getElementById('status').textContent = 'Bought' }
  window.logged = 0
  setInterval(() => { console.log('row', document.getElementById('b')); window.logged += 1 }, 50)
</script></body></html>`

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  if (!patchrightInstalled) return
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(SHOP)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}/`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'patchright-human-'))
})

afterAll(async () => {
  if (previousEngine === undefined) delete process.env.PLAYWRITER_PATCHRIGHT
  else process.env.PLAYWRITER_PATCHRIGHT = previousEngine
  if (!patchrightInstalled) return
  // Close everything, then report what failed to close: a browser left running must fail the file.
  const failures: unknown[] = []
  for (const executor of executors) await executor.closeHeadlessContext().catch((error: unknown) => failures.push(error))
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch((error: unknown) => failures.push(error))
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
  if (failures.length > 0) throw new AggregateError(failures, 'the patchright test browser did not close cleanly')
})

async function open(policy: 'human' | 'debug'): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

/** Wait until the page has logged its button `times` times (its own timer, on the browser's clock). */
async function loggedAtLeast(executor: PlaywrightExecutor, times: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const logged = Number(/\[return value\] (\d+)/.exec((await executor.execute('return await readPage(() => window.logged)', 30000)).text)?.[1])
    if (logged >= times) return
  }
  throw new Error(`the page did not log its button ${times} times`)
}

/** The ref printed in front of the first line matching `pattern`, e.g. `[12] button "Buy"`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

describe.skipIf(!patchrightInstalled)(`human mode on the patchright engine (skipped when ${PATCHRIGHT} is not installed)`, () => {
  it("runs on patchright's server", async () => {
    const patchright: { chromium: unknown } = await import(PATCHRIGHT)
    expect(await getChromium()).toBe(patchright.chromium)
  })

  describe('a human-mode flow', () => {
    let human: PlaywrightExecutor
    beforeAll(async () => {
      human = await open('human')
    })

    it("leaves the page unactivated and unlistened while it logs its own button", async () => {
      await loggedAtLeast(human, 5)
      const state = await human.execute('return JSON.stringify(await readPage(() => [navigator.userActivation.hasBeenActive, window.listenersAdded]))', 30000)
      expect(state.isError, state.text).toBe(false)
      expect(state.text).toContain('[false,[]]')
    })

    it('observes the button, clicks it like a person, and reads the result', async () => {
      const look = await human.execute('await observe()', 30000)
      expect(look.isError, look.text).toBe(false)
      const clicked = await human.execute(`await act.click(${refOf(look.text, /button "Buy"/)})`, 30000)
      expect(clicked.isError, clicked.text).toBe(false)
      const status = await human.execute("return await readPage(() => document.getElementById('status').textContent)", 30000)
      expect(status.isError, status.text).toBe(false)
      expect(status.text).toContain('[return value] Bought')
    })
  })

  it("previews the logged button without a gesture once the server receives the page's console", async () => {
    const debug = await open('debug')
    // Patchright's server never enables Runtime on a page session, so it hears the page's console only once
    // another client of the session enables Runtime — as a second relay client on the extension's debugger
    // session does. Then every console.log(element) makes it create and preview an element handle.
    const enabled = await debug.execute("const cdp = await getCDPSession({ page })\nawait cdp.send('Runtime.enable')", 30000)
    expect(enabled.isError, enabled.text).toBe(false)
    const preview = await debug.execute(
      [
        'state.previews = []',
        "page.on('console', (message) => { state.previews.push(message.args()[1]) })",
        // The preview arrives after the console event, from the server (previewUpdated), with no event of its
        // own on the handle: polling on the real clock is the only way to see it land.
        "for (let i = 0; i < 100 && !String(state.previews.at(-1)).startsWith('JSHandle@<'); i++) { const pause = Promise.withResolvers(); setTimeout(pause.resolve, 50); await pause.promise }",
        'return String(state.previews.at(-1))',
      ].join('\n'),
      30000,
    )
    expect(preview.isError, preview.text).toBe(false)
    expect(preview.text).toContain('JSHandle@<button id="b" class="buy">Buy</button>')
    const pageState = await debug.execute(
      "const cdp = await getCDPSession({ page })\nconst { result } = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify([navigator.userActivation.hasBeenActive, window.listenersAdded])', returnByValue: true })\nreturn result.value",
      30000,
    )
    expect(pageState.isError, pageState.text).toBe(false)
    expect(pageState.text).toContain('[false,[]]')
  })
})
