/**
 * Reads through the REAL extension (built for this suite's port, loaded in Chromium) and the real relay,
 * in human mode: Chrome gives an extension's chrome.debugger none of the console helpers ($_, $, …), so
 * readPage with a ref must not depend on them; query handlers and snapshot() work the same as on a
 * direct connection.
 *
 * Fixture: test/fixtures/queries/page.html. Runs alone: `pnpm vitest run src/queries-relay.test.ts`
 * (relay port: TEST_RELAY_PORTS).
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import type { CDPEventBase } from './cdp-types.js'
import { cleanupTestContext, getExtensionServiceWorker, setupTestContext, TEST_WORKSPACE, testRelayPort, type TestContext } from './test-utils.js'

const TEST_PORT = testRelayPort(import.meta.url)
const FIXTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/queries/page.html'), 'utf8')

let server: http.Server
let baseUrl = ''
let cwd = ''
let testCtx: TestContext | null = null
let executor: PlaywrightExecutor

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}/`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'queries-relay-'))

  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-queries-relay-' })
  const serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)
  const userPage = await testCtx.browserContext.newPage()
  await userPage.goto(baseUrl, { waitUntil: 'load' })
  await userPage.bringToFront()
  // The executor must find this tab in its workspace when it connects: wait until the relay registered it.
  const relay = testCtx.relayServer
  const attached = Promise.withResolvers<void>()
  const attachedUrls: string[] = []
  const onEvent = ({ event }: { event: CDPEventBase }): void => {
    if (event.method !== 'Target.attachedToTarget' || typeof event.params !== 'object' || event.params === null) return
    const targetInfo: unknown = Reflect.get(event.params, 'targetInfo')
    const url: unknown = typeof targetInfo === 'object' && targetInfo !== null ? Reflect.get(targetInfo, 'url') : undefined
    attachedUrls.push(typeof url === 'string' ? url : String(url))
    if (url === baseUrl) attached.resolve()
  }
  relay.on('cdp:event', onEvent)
  // Real timer: the extension attaches a real tab in a real browser; fail naming what it attached instead.
  const deadline = setTimeout(() => attached.reject(new Error(`the extension did not attach ${baseUrl} within 60 s; it attached: ${JSON.stringify(attachedUrls)}`)), 60_000)
  try {
    await serviceWorker.evaluate(
      async ([k, l]) => {
        await globalThis.toggleExtensionForActiveTab(k, l)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    await attached.promise
  } finally {
    clearTimeout(deadline)
    relay.off('cdp:event', onEvent)
  }
  executor = new PlaywrightExecutor({ cdpConfig: { port: TEST_PORT, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
}, 600_000)

afterAll(async () => {
  await cleanupTestContext(testCtx)
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

async function run(code: string): Promise<string> {
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

describe('reads through the real extension', () => {
  it('readPage(fn, { ref }) reads the element of a ref, in the document and in an open shadow root', async () => {
    const look = await run('await observe()')
    const save = refOf(look, /button "Save" \[disabled\]/)
    expect(await run(`return await readPage((el, suffix) => el.id + suffix, { ref: ${save}, arg: '!' })`)).toContain('[return value] save!')
    const deep = refOf(await run("await find('pierce/.deep')"), /<span>/)
    expect(await run(`return await readPage((el) => el.textContent, { ref: ${deep} })`)).toContain('Open shadow text')
  })

  it('names why an element inside a closed shadow root cannot be read with a function, and what reads it', async () => {
    const shadow = refOf(await run("await find('pierce/button.inner')"), /Shadow button/)
    const refused = await executor.execute(`return await readPage((el) => el.className, { ref: ${shadow} })`, 30000)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('the element is inside a closed shadow root')
    expect(refused.text).toContain('getCleanHTML({ ref })')
    expect(await run(`return await getCleanHTML({ ref: ${shadow} })`)).toContain('class="inner"')
  })

  it('finds by role and through closed shadow roots, reads by query, and snapshots without options', async () => {
    expect(await run("await find('role/tooltip')")).toMatch(/1 match[\s\S]*tooltip <div> "Free shipping over \$50" — in view/)
    expect(await run("await find('pierce/.inner-text')")).toMatch(/1 match[\s\S]*<span>/)
    expect(await run("return await readPage((el) => el.textContent, { query: 'role/tooltip' })")).toContain('Free shipping over $50')
    expect(await run('return await snapshot()')).toContain('heading "Customers"')
  })
})
