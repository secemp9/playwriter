/**
 * webmcp.* through the relay and the real Playwriter extension (chrome.debugger), in Google Chrome
 * 149 started with WebMCPTesting + DevToolsWebMCPSupport — the path Nourdine's own Chrome takes once
 * the two chrome://flags entries are on. chrome.debugger accepts the experimental WebMCP domain.
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
const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/browser-lab')

describe('webmcp through the extension relay (Chrome 149 with the WebMCP features)', () => {
  let server: http.Server
  let origin = ''
  let cwd = ''
  let testCtx: TestContext | null = null
  let userPage: Page | null = null
  let executor: PlaywrightExecutor | null = null

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const file = path.join(LAB, new URL(req.url ?? '/', 'http://x').pathname)
      if (!file.startsWith(LAB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404)
        res.end()
        return
      }
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    })
    const listening = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', () => listening.resolve())
    await listening.promise
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture server has no port')
    origin = `http://127.0.0.1:${address.port}`
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-relay-'))

    testCtx = await setupTestContext({
      suiteUrl: import.meta.url,
      tempDirPrefix: 'pw-webmcp-',
      chrome: { executablePath: '/opt/google/chrome/chrome', features: ['WebMCPTesting', 'DevToolsWebMCPSupport'] },
    })
    const serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)
    userPage = await testCtx.browserContext.newPage()
    await userPage.goto(`${origin}/webmcp.html`, { waitUntil: 'load' })
    await userPage.bringToFront()
    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    executor = new PlaywrightExecutor({ cdpConfig: { port: TEST_PORT, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  }, 600_000)

  afterAll(async () => {
    await executor?.disconnect().catch(() => {})
    await cleanupTestContext(testCtx)
    server?.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server?.close(() => closed.resolve())
    await closed.promise
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('lists the page tools and runs addTodo through chrome.debugger, with the report after it', async () => {
    const listed = await executor!.execute("return '<<' + JSON.stringify(await webmcp.list()) + '>>'", 30_000)
    expect(listed.isError, listed.text).toBe(false)
    const tools: { available: boolean; tools: Array<{ name: string }> } = JSON.parse(/<<(.*)>>/s.exec(listed.text)?.[1] ?? 'null')
    expect(tools.available).toBe(true)
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['addTodo', 'listTodos'])

    const ran = await executor!.execute("return '<<' + JSON.stringify(await webmcp.invoke('addTodo', { text: 'Buy milk' })) + '>>'", 30_000)
    expect(ran.isError, ran.text).toBe(false)
    expect(JSON.parse(/<<(.*)>>/s.exec(ran.text)?.[1] ?? 'null')).toMatchObject({ ok: true, status: 'Completed', text: 'Added todo #3: Buy milk' })
    expect(ran.text).toContain('3 todos, 2 open')
    // The user's own view of the tab agrees.
    expect(await userPage!.locator('#todo-count').textContent()).toBe('3 todos, 2 open')
  })
})
