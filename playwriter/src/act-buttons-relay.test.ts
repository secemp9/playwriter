/**
 * Right-click through the real extension and relay (the way Nourdine's Chrome is driven), in human
 * mode, through the MCP server: a trusted contextmenu at the element and at a point of it, and the
 * page's own menu in the report the model reads.
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
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'act-pointer', 'act-buttons.html')

let testCtx: TestContext | null = null
let client: Client
let cleanup: (() => Promise<void>) | null = null
let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/act-buttons.html') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(PAGE))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-act-buttons-', toggleExtension: true })
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

describe('right-click through the extension relay', () => {
  it("fires a trusted contextmenu at the element and at a point of it; the page's menu is in the report", async () => {
    await run(`await page.goto('${baseUrl}/act-buttons.html', { waitUntil: 'domcontentloaded' })`)
    const look = await run('console.log(await observe())')
    const file = refOf(look, /button "Report\.pdf"/)
    const opened = await run(`await act.click(${file}, { button: 'right' })`)
    expect(opened).toContain(`click [${file}] button "Report.pdf" with the right button`)
    expect(opened).toMatch(/menuitem "Rename"/)
    const atPoint = await run(`await act.click({ ref: ${file}, x: 7, y: 9 }, { button: 'right' })`)
    expect(atPoint).toContain(`pointer at (7, 9) of [${file}]`)
    const log = await run("return await readPage(() => 'LOG<' + document.getElementById('log').textContent + '>')")
    expect(log).toMatch(/mousedown b2 trusted [\d.]+,[\d.]+; contextmenu b2 trusted/)
    const second = /contextmenu b2 trusted [\d.]+,[\d.]+; mouseup b2 trusted on menu; mousedown b2 trusted ([\d.]+),([\d.]+); contextmenu b2 trusted \1,\2/.exec(log)
    expect(second, log).not.toBeNull()
    // MouseEvent.clientX/Y are whole CSS px in Chrome: the offset from a fractional box edge is within 1 px.
    expect(Math.abs(Number(second?.[1]) - 7)).toBeLessThan(1)
    expect(Math.abs(Number(second?.[2]) - 9)).toBeLessThan(1)
    expect(log).not.toMatch(/(<|; )click /)
  }, 120000)
})
