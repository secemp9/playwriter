/**
 * A crashed renderer in a Chrome driven through the real extension and relay (the way Nourdine's
 * Chrome is driven), in human mode, through the MCP server: the session names the crash, refuses
 * everything else with it, and `act.open(url)` brings it back in a new tab without `reset`.
 *
 * The renderer is crashed with CDP `Page.crash` from the test's own connection to that Chrome (the
 * pipe Playwright launched it with), not through the relay: the session only hears of it the way it
 * would hear of a real crash, through the extension's debugger.
 */

import http from 'node:http'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMCPClient } from './mcp-client.js'
import { cleanupTestContext, setupTestContext, testRelayPort, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = testRelayPort(import.meta.url)
const PAGE = (title: string) => `<!doctype html><html><head><title>${title}</title></head>
<body><main><h1>${title}</h1><button>Save</button></main></body></html>`

let testCtx: TestContext | null = null
let client: Client
let cleanup: (() => Promise<void>) | null = null
let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE(req.url === '/other' ? 'Other page' : 'Invoice 42'))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-page-crash-', toggleExtension: true })
  const mcp = await createMCPClient({ port: TEST_PORT, policy: 'human' })
  client = mcp.client
  cleanup = mcp.cleanup
}, 600000)

afterAll(async () => {
  await cleanupTestContext(testCtx, cleanup)
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
})

async function execute(code: string): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name: 'execute', arguments: { code, timeout: 30000 } })
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('\n')
  return { text, isError: result.isError === true }
}

describe('a crashed renderer through the extension relay', () => {
  it('reports PAGE CRASHED, refuses other calls with it, and act.open(url) recovers in a new tab', async () => {
    const loaded = await execute(`await act.open('${baseUrl}/')`)
    expect(loaded.isError, loaded.text).toBe(false)
    expect(loaded.text).toContain('Invoice 42')

    const context = testCtx?.browserContext
    if (!context) throw new Error('no test browser context')
    const tab = context.pages().find((candidate) => candidate.url() === `${baseUrl}/`)
    if (!tab) throw new Error(`no tab on ${baseUrl}/ in ${context.pages().map((candidate) => candidate.url())}`)
    const died = Promise.withResolvers<void>()
    tab.once('crash', () => died.resolve())
    const cdp = await context.newCDPSession(tab)
    cdp.send('Page.crash').catch(() => {})
    await died.promise

    // The session hears of the crash through the extension's debugger a moment after the test does.
    // Real time on purpose: that event's delivery, polled for at most 10 s.
    let refused = await execute('return 1')
    for (const deadline = Date.now() + 10_000; !refused.isError && Date.now() < deadline; ) {
      const tick = Promise.withResolvers<void>()
      setTimeout(tick.resolve, 200)
      await tick.promise
      refused = await execute('return 1')
    }
    expect(refused.isError, refused.text).toBe(true)
    expect(refused.text).toMatch(new RegExp(`^PAGE CRASHED — the tab's renderer crashed \\(it showed ${baseUrl}/, .*Nothing from this call was run\\.$`))

    const opened = await execute(`await act.open('${baseUrl}/other')`)
    expect(opened.isError, opened.text).toBe(false)
    expect(opened.text).toContain(`PAGE RECOVERED — the crashed tab (it showed ${baseUrl}/) was replaced by a new tab`)
    expect(opened.text).toContain('The crashed tab was closed.')
    expect(opened.text).toContain('Other page')
    expect(opened.text).not.toContain('TAB CLOSED')

    const after = await execute('await observe()')
    expect(after.isError, after.text).toBe(false)
    expect(after.text).toContain('Other page')
    expect(context.pages().some((candidate) => candidate.url() === `${baseUrl}/`)).toBe(false)
  }, 180000)
})
