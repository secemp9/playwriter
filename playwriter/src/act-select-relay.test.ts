/**
 * act.select through the relay — the extension mode a user's own Chrome runs in, where every key
 * and click goes through chrome.debugger: Chrome's list of a native <select> opens on the click,
 * type-ahead and arrow keys reach it, the select's accessibility value follows its highlight, and
 * Enter chooses. The Browser Lab's 200-country select and this suite's option-group, duplicate-label
 * and list-box selects.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@xmorse/playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { setupTestContext, cleanupTestContext, getExtensionServiceWorker, TEST_WORKSPACE, testRelayPort, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')

/** The ref printed in front of the first line matching `pattern`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

describe('act.select through the relay', () => {
  let server: http.Server
  let baseUrl = ''
  let cwd = ''
  let testCtx: TestContext | null = null
  let userPage: Page | null = null
  let executor: PlaywrightExecutor | null = null

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const file = pathname.startsWith('/act-input/') ? path.join(FIXTURES, pathname) : path.join(FIXTURES, 'browser-lab', pathname)
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(file))
    })
    const listening = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', () => listening.resolve())
    await listening.promise
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture server has no port')
    baseUrl = `http://127.0.0.1:${address.port}`
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'act-select-relay-'))

    testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-act-select-relay-' })
    const serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)
    userPage = await testCtx.browserContext.newPage()
    await userPage.goto(`${baseUrl}/form.html`, { waitUntil: 'load' })
    await userPage.bringToFront()
    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    executor = new PlaywrightExecutor({ cdpConfig: { port: TEST_PORT, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  }, 600000)

  afterAll(async () => {
    await userPage?.close().catch(() => {})
    await cleanupTestContext(testCtx)
    testCtx = null
    server?.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server?.close(() => closed.resolve())
    await closed.promise
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('chooses "United Kingdom" in the 200-country select in seconds, then "France" before it', async () => {
    const look = (await executor!.execute('await observe({ all: true })', 30000)).text
    const country = refOf(look, /combobox "Country"/)
    const started = Date.now()
    const result = await executor!.execute(`await act.select(${country}, 'United Kingdom')`, 60000)
    const took = Date.now() - started
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/typed "United K" in its open list, then Enter/)
    expect(result.text).toContain('selected "United Kingdom" (was "Select a country")')
    expect(await userPage!.locator('#country').inputValue()).toBe('United Kingdom')
    expect(took, result.text).toBeLessThan(10_000)
    const france = await executor!.execute(`await act.select(${country}, 'France')`, 60000)
    expect(france.isError, france.text).toBe(false)
    expect(await userPage!.locator('#country').inputValue()).toBe('France')
  })

  it('chooses across option groups, the second of two equal labels by value, and adds to a list box', async () => {
    const opened = await executor!.execute(`await act.open('${baseUrl}/act-input/select.html', { reason: 'the next fixture page' })`, 60000)
    expect(opened.isError, opened.text).toBe(false)
    const look = (await executor!.execute('await observe({ all: true })', 30000)).text
    const region = await executor!.execute(`await act.select(${refOf(look, /combobox "Region"/)}, 'Korea')`, 60000)
    expect(region.isError, region.text).toBe(false)
    const size = await executor!.execute(`await act.select(${refOf(look, /combobox "Size"/)}, 'm-tall')`, 60000)
    expect(size.isError, size.text).toBe(false)
    const toppings = refOf(look, /listbox "Toppings"/)
    expect((await executor!.execute(`await act.select(${toppings}, 'Tomato')`, 60000)).isError).toBe(false)
    const basil = await executor!.execute(`await act.select(${toppings}, 'Basil')`, 60000)
    expect(basil.isError, basil.text).toBe(false)
    expect(basil.text).toContain('now selected: "Basil", "Tomato"')
    const out = await executor!.execute("return await readPage(() => 'OUT<' + document.getElementById('out').textContent + '>OUT')", 30000)
    expect(/OUT<([^>]*)>OUT/.exec(out.text)?.[1], out.text).toBe('region=Korea size=m-tall toppings=Basil+Tomato delivery=Standard speed=Slow')
  })
})
