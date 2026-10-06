/**
 * The human-mode run-time guard: what the static policy cannot read — a Playwright read reached
 * through a computed name, one the code leaves running after its call returned, Playwright's
 * internal calls, raw CDP sessions — is refused as the protocol call goes out, before Playwright
 * runs anything in the page. The page never counts as clicked. Debug mode is not guarded.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const PAGE = '<!doctype html><html><head><title>Guarded</title></head><body><h1>Hello</h1><button>Go</button></body></html>'

/**
 * A page that logs one of its elements to the console, as debugging code on real sites does. It also
 * records every listener added to anything through its own world's EventTarget.prototype, which is
 * where Playwright's injected script adds its capture listeners when it is built in the page's world.
 */
const LOGS = `<!doctype html><html><head><title>Logs</title></head><body><button id="b" class="buy" disabled>Buy</button>
<script>
  window.listenersAdded = []
  const add = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, listener, options) { window.listenersAdded.push(String(type)); return add.call(this, type, listener, options) }
  window.logged = 0
  setInterval(() => { console.log('row', document.getElementById('b')); window.logged += 1 }, 50)
</script></body></html>`

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(req.url === '/logs' ? LOGS : PAGE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}/`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'human-guard-'))
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

async function open(policy: 'human' | 'debug', at = ''): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}${at}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

/** Real time on purpose: a timer the code itself scheduled in the vm fires on the real clock. */
function realDelay(ms: number): Promise<void> {
  const elapsed = Promise.withResolvers<void>()
  setTimeout(elapsed.resolve, ms)
  return elapsed.promise
}

describe('human mode refuses Playwright script in the page at run time', () => {
  let human: PlaywrightExecutor
  beforeAll(async () => {
    human = await open('human')
  })

  it('refuses a read the static policy cannot see, before it runs', async () => {
    const result = await human.execute("const name = ['ti', 'tle'].join('')\nreturn await page[name]()", 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('page.title: Refused (human mode): it (Playwright protocol call Frame.title) runs Playwright\'s script in the page, as a user gesture')
    expect(result.text).toContain('It was not run.')
  })

  it('refuses a read the code left running after its call returned', async () => {
    const scheduled = await human.execute(
      "const name = ['eval', 'uate'].join('')\n" +
        "setTimeout(() => { page[name](() => 1).then(() => { state.late = 'ran' }, (error) => { state.late = error.message }) }, 50)\n" +
        "return 'scheduled'",
      30000,
    )
    expect(scheduled.isError, scheduled.text).toBe(false)
    await realDelay(1000)
    const late = await human.execute('return state.late', 30000)
    expect(late.text).toContain('page.evaluate: Refused (human mode): it (Playwright protocol call Frame.evaluateExpression)')
  })

  it("refuses Playwright's internal calls, which its instrumentation never reports", async () => {
    const result = await human.execute("const name = ['_snapshot', 'ForAI'].join('')\nreturn await page[name]({ timeout: 2000 })", 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Refused (human mode): it (Playwright protocol call Page.snapshotForAI)')
  })

  it('keeps raw CDP read-only: no new session, no way around the read-only one', async () => {
    const opened = await human.execute("const name = ['newCDP', 'Session'].join('')\nreturn await context[name](page)", 30000)
    expect(opened.isError).toBe(true)
    expect(opened.text).toContain('Refused (human mode): it (Playwright protocol call BrowserContext.newCDPSession) opens a CDP session')
    const bypass = await human.execute("const cdp = await getCDPSession({ page })\nreturn [typeof cdp.session, (await cdp.send('DOM.getDocument', { depth: 0 })).root.nodeName]", 30000)
    expect(bypass.isError, bypass.text).toBe(false)
    expect(bypass.text).toContain("[ 'undefined', '#document' ]")
  })

  it('left the page unactivated through all of it', async () => {
    const result = await human.execute('return await readPage(() => navigator.userActivation.hasBeenActive)', 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('[return value] false')
  })

  it('does not guard debug mode', async () => {
    const debug = await open('debug')
    const result = await debug.execute('return await page.title()', 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('Guarded')
  })
})

describe("the page's own console.log(element)", () => {
  /** Wait until the page has logged its element `times` times (its own timer, on the browser's clock). */
  async function loggedAtLeast(executor: PlaywrightExecutor, times: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const logged = Number(/\[return value\] (\d+)/.exec((await executor.execute('return await readPage(() => window.logged)', 30000)).text)?.[1])
      if (logged >= times) return
    }
    throw new Error(`the page did not log its element ${times} times`)
  }

  it('gives the page no user activation and builds nothing of Playwright in its world', async () => {
    const human = await open('human', 'logs')
    await loggedAtLeast(human, 5)
    const state = await human.execute('return JSON.stringify(await readPage(() => [navigator.userActivation.hasBeenActive, window.listenersAdded]))', 30000)
    expect(state.isError, state.text).toBe(false)
    expect(state.text).toContain('[false,[]]')
  })

  it("still gives Playwright's element preview, computed without the gesture", async () => {
    const debug = await open('debug', 'logs')
    const preview = await debug.execute(
      [
        'state.previews = []',
        "page.on('console', (message) => { state.previews.push(message.args()[1]) })",
        // The preview arrives after the console event, from the server (previewUpdated).
        "for (let i = 0; i < 100 && !String(state.previews.at(-1)).startsWith('JSHandle@<'); i++) await new Promise((resolve) => setTimeout(resolve, 50))",
        'return String(state.previews.at(-1))',
      ].join('\n'),
      30000,
    )
    expect(preview.isError, preview.text).toBe(false)
    expect(preview.text).toContain('JSHandle@<button id="b" disabled class="buy">Buy</button>')
    const cdpState = await debug.execute(
      "const cdp = await getCDPSession({ page })\nconst { result } = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify([navigator.userActivation.hasBeenActive, window.listenersAdded])', returnByValue: true })\nreturn result.value",
      30000,
    )
    expect(cdpState.text).toContain('[false,[]]')
  })
})
