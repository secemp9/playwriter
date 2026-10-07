/**
 * Tabs through the real extension and relay (the way Nourdine's Chrome is driven), in human mode,
 * through the MCP server: refs across tabs, the controlled tab closing, and a tab in the background.
 * Every assertion is on what the MODEL reads.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMCPClient } from './mcp-client.js'
import { cleanupTestContext, setupTestContext, testRelayPort, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)
const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

let testCtx: TestContext | null = null
let client: Client
let cleanup: (() => Promise<void>) | null = null
let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const file = path.join(LAB, path.normalize(url.pathname).replace(/^\/+/, ''))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'
    res.writeHead(200, { 'Content-Type': type })
    res.end(fs.readFileSync(file))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-tabs-dialogs-', toggleExtension: true })
  const mcp = await createMCPClient({ port: TEST_PORT, policy: 'human' })
  client = mcp.client
  cleanup = mcp.cleanup
}, 600000)

afterAll(async () => {
  await cleanupTestContext(testCtx, cleanup)
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function execute(code: string): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name: 'execute', arguments: { code, timeout: 30000 } })
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('\n')
  return { text, isError: result.isError === true }
}

async function run(code: string): Promise<string> {
  const result = await execute(code)
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

describe('tabs through the extension relay', () => {
  it('keeps a tab’s refs valid after switchTab round trips and after a sibling tab closes', async () => {
    await run(`await page.goto('${baseUrl}/popups.html', { waitUntil: 'domcontentloaded' })`)
    const first = await run('console.log(await observe())')
    const opened = await run(`await act.click(${refOf(first, /Open landing in a new tab/)})`)
    expect(opened).toMatch(/new tab/)
    await run('await act.switchTab(1)')
    await run('console.log(await observe())')
    await run('await act.switchTab(0)')
    const again = await run('console.log(await observe())')
    const clicked = await execute(`await act.click(${refOf(again, /Open popup window/)})`)
    expect(clicked.text).not.toMatch(/previous page|is closed/)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/Popup opened/)
    // The person closes the landing tab: the refs of tab 0 stay usable.
    const landing = testCtx!.browserContext.pages().find((candidate) => candidate.url().includes('from=blank'))
    if (!landing) throw new Error('the landing tab is not open')
    await landing.close()
    const after = await run('console.log(await observe())')
    const sameLink = await execute(`await act.hover(${refOf(after, /Go to landing \(same tab\)/)})`)
    expect(sameLink.text).not.toMatch(/previous page|is closed/)
    expect(sameLink.isError, sameLink.text).toBe(false)
  }, 120000)

  it('says TAB CLOSED when the person closes the controlled tab, and which tab is controlled now', async () => {
    await run(`await act.switchTab('from=popup')`)
    const popup = testCtx!.browserContext.pages().find((candidate) => candidate.url().includes('from=popup'))
    if (!popup) throw new Error('the popup tab is not open')
    await popup.close()
    const next = await run('console.log(await observe())')
    expect(next).toMatch(/TAB CLOSED — the controlled tab "Landing · Browser Lab" \S*from=popup\S* was closed; now controlling tab 0 "Popups · Browser Lab"/)
    expect(next).toMatch(/PAGE {2}Popups · Browser Lab/)
  }, 120000)
})

/**
 * A page closing its own tab in answer to an act input (act-closes-tab.test.ts has the same on a
 * headless Chromium): the closing is the input's effect, never "FAILED" and never "Error executing
 * code". Closed on the press itself, Chrome may lose the press's own confirmation with the tab: then
 * the report says it cannot tell whether the page got it.
 */
describe('an act input that makes the page close its own tab, through the extension relay', () => {
  const closedByItself = / — the tab closed \(the page closed itself in response\)/

  async function openCloser(on: string): Promise<string> {
    const opener = await run('console.log(await observe())')
    expect(opener).toMatch(/PAGE {2}Closes Itself · Browser Lab/)
    await run(`await act.click(${refOf(opener, new RegExp(`Open a tab closing on ${on}\\b`))}, { again: true })`)
    await run(`await act.switchTab('on=${on}')`)
    return await run('console.log(await observe())')
  }

  const inputs: Array<{ on: string; code: (closer: string) => string; label: string; closesOn: 'press' | 'release'; runs: number }> = [
    { on: 'click', code: (closer) => `await act.click(${refOf(closer, /Close this tab/)})`, label: 'click', closesOn: 'release', runs: 10 },
    { on: 'pointerdown', code: (closer) => `await act.click(${refOf(closer, /Close this tab/)})`, label: 'click', closesOn: 'press', runs: 10 },
    { on: 'dblclick', code: (closer) => `await act.dblclick(${refOf(closer, /Close this tab/)})`, label: 'dblclick', closesOn: 'release', runs: 3 },
    { on: 'contextmenu', code: (closer) => `await act.click(${refOf(closer, /Close this tab/)}, { button: 'right' })`, label: 'click', closesOn: 'press', runs: 3 },
    { on: 'keydown', code: (closer) => `await act.press('Enter', { ref: ${refOf(closer, /Close this tab/)} })`, label: 'press', closesOn: 'press', runs: 3 },
    { on: 'drop', code: (closer) => `await act.drag(${refOf(closer, /Close this tab/)}, ${refOf(closer, /Drop here/)})`, label: 'drag', closesOn: 'release', runs: 3 },
  ]

  it('opens the page whose tabs close themselves', async () => {
    await run(`await act.open('${baseUrl}/closes-itself.html', { reason: 'the test page whose tabs close themselves' })`)
  }, 60000)

  for (const input of inputs) {
    it(`reports the tab closing as the input's effect, closed on ${input.on} (${input.runs} runs)`, async () => {
      const outcomes = { named: 0, tabClosedLineOnly: 0, pressUnconfirmed: 0 }
      for (let attempt = 0; attempt < input.runs; attempt++) {
        const closer = await openCloser(input.on)
        const result = await execute(input.code(closer))
        expect(result.text).toMatch(
          new RegExp(`TAB CLOSED — the controlled tab "Closer ${input.on} · Browser Lab" \\S*on=${input.on}\\S* was closed; now controlling tab \\d+ "Closes Itself · Browser Lab"`),
        )
        const actionLine = result.text.split('\n').find((line) => line.startsWith('ACTION')) ?? ''
        if (input.closesOn === 'press' && result.isError) {
          const what = input.label === 'press' ? 'the key Enter was being pressed: Chrome closed it before confirming the key' : 'the mouse button was being pressed: Chrome closed it before confirming the press'
          expect(result.text).toContain(`FAILED: The tab closed while ${what}, so whether the page got it cannot be told.`)
          outcomes.pressUnconfirmed += 1
          continue
        }
        expect(result.isError, result.text).toBe(false)
        expect(result.text).not.toMatch(/FAILED|Error executing code|✗/)
        expect(actionLine, result.text).toMatch(new RegExp(`^ACTION {2}✓ ${input.label} \\[\\d+\\] button "Close this tab"`))
        if (closedByItself.test(actionLine)) outcomes.named += 1
        else outcomes.tabClosedLineOnly += 1
      }
      console.log(`relay, closed on ${input.on}: ${JSON.stringify(outcomes)}`)
    }, 300000)
  }

  it('reports a tab that closed before the press as not done, nothing clicked', async () => {
    const closer = await openCloser('pointermove')
    const result = await execute(`await act.click(${refOf(closer, /Close this tab/)})`)
    expect(result.isError, result.text).toBe(true)
    expect(result.text).toMatch(/✗ click \[\d+\] button "Close this tab"\n {8}FAILED: Not done: the tab closed before the mouse button was pressed \(while the pointer moved to it\); nothing was clicked\./)
    expect(result.text).not.toMatch(closedByItself)
    expect(result.text).toMatch(/TAB CLOSED — the controlled tab "Closer pointermove · Browser Lab" \S*on=pointermove\S* was closed; now controlling tab \d+ "Closes Itself · Browser Lab"/)
  }, 120000)
})
