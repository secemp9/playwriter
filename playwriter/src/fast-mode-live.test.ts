/**
 * Fast mode end to end: through the real executor on the Browser Lab and human-shop fixtures, and
 * through the MCP `browser` tool for the choice of mode.
 *
 * - A whole sign-up form (fill, fill, fill, select, check, click) in ONE call in fast mode, with each
 *   action's own report in order, within a bound measured on this machine.
 * - The same actions one by one, human against fast, timed and printed.
 * - page.route and a page.evaluate DOM write: allowed in fast, refused in human.
 * - `browser new` / `use` with `mode: 'fast'` drive a fast session, and `browser list` says so.
 * - Human mode unchanged: one action per call, human-paced, its SETTLED line without the fast wording.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { PlaywrightExecutor } from './executor.js'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import { connectFakeExtension, freePort, type FakeExtension } from './fake-extension.js'
import { createMCPClient } from './mcp-client.js'
import { TEST_WORKSPACE } from './test-utils.js'
import { VERSION } from './utils.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')
const LAB = path.join(FIXTURES, 'browser-lab')
const SHOP = path.join(FIXTURES, 'human-shop')
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
/**
 * The whole form flow (six actions) in one fast call. Measured on this machine, Chrome 145 headless:
 * 2280–2400 ms over 6 runs (3 alone, 2 next to human-mode-live.test.ts, 1 more alone). The bound is
 * ~3.3× the slowest, room for a loaded machine.
 */
const FORM_FLOW_BOUND_MS = 8000

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const shop = /^\/shop\/([a-z-]+\.html)$/.exec(pathname)
    const root = shop ? SHOP : LAB
    const file = path.join(root, path.normalize(shop ? shop[1] : pathname))
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-mode-'))
}, 60_000)

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

function newExecutor(policy: 'human' | 'fast'): PlaywrightExecutor {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  return executor
}

/** The ref printed in front of the first line matching `pattern`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

async function timed(executor: PlaywrightExecutor, code: string, timeout = 60_000): Promise<{ ms: number; text: string; isError: boolean }> {
  const startedAt = performance.now()
  const result = await executor.execute(code, timeout)
  return { ms: Math.round(performance.now() - startedAt), text: result.text, isError: result.isError }
}

/** A fresh executor whose blank tab loads `page` of the fixture server, and its first look at all of it. */
async function open(policy: 'human' | 'fast', page: string): Promise<{ executor: PlaywrightExecutor; look: string }> {
  const executor = newExecutor(policy)
  const loaded = await executor.execute(`await page.goto('${baseUrl}/${page}', { waitUntil: 'domcontentloaded' })`, 30_000)
  expect(loaded.isError, loaded.text).toBe(false)
  const look = await executor.execute('await observe({ all: true })', 30_000)
  expect(look.isError, look.text).toBe(false)
  return { executor, look: look.text }
}

describe('a whole form flow in one call, in fast mode', () => {
  it('fills, selects, checks and submits in one call, with each action’s report in order', async () => {
    const { executor, look } = await open('fast', 'form.html')
    const name = refOf(look, /textbox "Full name"/)
    const email = refOf(look, /textbox "Email"/)
    const password = refOf(look, /textbox "Password"/)
    const country = refOf(look, /combobox "Country"/)
    const terms = refOf(look, /checkbox "I agree to the Terms of Service"/)
    const submit = refOf(look, /button "Create account"/)
    const flow = await timed(
      executor,
      [
        `await act.fill(${name}, 'Ada Lovelace')`,
        `await act.fill(${email}, 'ada@example.com')`,
        `await act.fill(${password}, 'correct horse battery')`,
        `await act.select(${country}, 'France')`,
        `await act.check(${terms})`,
        `await act.click(${submit})`,
      ].join('\n'),
    )
    console.log(`fast form flow in one call (6 actions): ${flow.ms}ms`)
    expect(flow.isError, flow.text).toBe(false)
    expect(flow.ms).toBeLessThan(FORM_FLOW_BOUND_MS)
    // One report per action, in order: its ACTION line, then its own SETTLED line.
    const blocks = flow.text.split(/\n(?=ACTION {2})/).filter((block) => block.startsWith('ACTION'))
    expect(blocks.map((block) => block.split('\n')[0].replace(/ \[\d+\].*/, ''))).toEqual([
      'ACTION  ✓ fill',
      'ACTION  ✓ fill',
      'ACTION  ✓ fill',
      'ACTION  ✓ select',
      'ACTION  ✓ check',
      'ACTION  ✓ click',
    ])
    for (const block of blocks) expect(block).toMatch(/SETTLED \d+ms \(fast settle|NOT SETTLED after \d+ms \(fast settle/)
    expect(flow.text).toMatch(/value read back: "Ada Lovelace"/)
    expect(flow.text).toMatch(/selected "France"/)
    expect(flow.text).toMatch(/now checked/)
    expect(flow.text).toMatch(/not waited for: work the page starts later on a timer/)
    // The form went through: "Processing…" now, the account a moment later.
    const done = await executor.execute("await act.waitForIdle(); return await readPage(() => document.getElementById('result').textContent)", 30_000)
    expect(done.text).toMatch(/Account created for Ada Lovelace/)
  }, 120_000)
})

describe('per-action timings, human against fast', () => {
  const timings: Array<{ action: string; human: number; fast: number }> = []

  afterAll(() => {
    console.log(['action    human ms   fast ms', ...timings.map((t) => `${t.action.padEnd(9)} ${String(t.human).padStart(8)} ${String(t.fast).padStart(9)}`)].join('\n'))
  })

  const measure = async (action: string, page: string, code: (look: string) => string, check: RegExp): Promise<void> => {
    const ms: Record<'human' | 'fast', number> = { human: 0, fast: 0 }
    for (const policy of ['human', 'fast'] as const) {
      const { executor, look } = await open(policy, page)
      const run = await timed(executor, code(look))
      expect(run.isError, run.text).toBe(false)
      expect(run.text).toMatch(check)
      expect(run.text).toMatch(policy === 'fast' ? /\(fast settle/ : /SETTLED \d+ms — page content and network went quiet/)
      ms[policy] = run.ms
    }
    timings.push({ action, ...ms })
    expect(ms.fast).toBeLessThan(ms.human)
  }

  it('click', async () => {
    await measure('click', 'form.html', (look) => `await act.click(${refOf(look, /button "Show password"/)})`, /✓ click/)
  }, 120_000)

  it('fill', async () => {
    await measure('fill', 'form.html', (look) => `await act.fill(${refOf(look, /textbox "Full name"/)}, 'Ada Lovelace')`, /value read back: "Ada Lovelace"/)
  }, 120_000)

  it('select', async () => {
    await measure('select', 'form.html', (look) => `await act.select(${refOf(look, /combobox "Country"/)}, 'France')`, /selected "France"/)
  }, 120_000)

  it('drag', async () => {
    await measure(
      'drag',
      'shop/act-form.html',
      (look) => `await act.drag(${refOf(look, /button "Card Lyon"/)}, ${refOf(look, /button "Done column"/)})`,
      /the page started an HTML drag/,
    )
  }, 120_000)

  it('scroll', async () => {
    await measure('scroll', 'scroll.html', () => "await act.scroll('down', { screens: 3 })", /scrolled the page \d+px/)
  }, 120_000)
})

describe('what fast mode allows that human mode refuses', () => {
  const route = (base: string): string =>
    `await page.route('**/mocked.json', (route) => route.fulfill({ contentType: 'application/json', body: '{"mocked":true}' }))\n` +
    `return await page.evaluate(async () => (await fetch('${base}/mocked.json')).text())`
  const domWrite = "await page.evaluate(() => { document.querySelector('h1').textContent = 'Rewritten' }); return await page.evaluate(() => document.querySelector('h1').textContent)"

  it('page.route and a page.evaluate DOM write run in fast mode', async () => {
    const { executor } = await open('fast', 'form.html')
    const routed = await executor.execute(route(baseUrl), 30_000)
    expect(routed.isError, routed.text).toBe(false)
    expect(routed.text).toContain('{"mocked":true}')
    const written = await executor.execute(domWrite, 30_000)
    expect(written.isError, written.text).toBe(false)
    expect(written.text).toContain('Rewritten')
  }, 120_000)

  it('human mode refuses both, and runs nothing', async () => {
    const { executor } = await open('human', 'form.html')
    const routed = await executor.execute(route(baseUrl), 30_000)
    expect(routed.isError).toBe(true)
    expect(routed.text).toMatch(/Refused \(human mode\)/)
    expect(routed.text).toMatch(/mode: 'fast'/)
    const written = await executor.execute(domWrite, 30_000)
    expect(written.isError).toBe(true)
    expect(written.text).toMatch(/Refused \(human mode\)/)
    const heading = await executor.execute("return await readPage(() => document.querySelector('h1').textContent)", 30_000)
    expect(heading.text).toContain('Create your account')
  }, 120_000)

  it('human mode is unchanged: a second action in the same call is refused before anything runs', async () => {
    const { executor, look } = await open('human', 'form.html')
    const result = await executor.execute(`await act.fill(${refOf(look, /textbox "Full name"/)}, 'Ada'); await act.click(${refOf(look, /button "Show password"/)})`, 30_000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/this call does 2 input actions/)
  }, 120_000)
})

describe('the browser tool chooses the mode', () => {
  const ALPHA = { name: 'alpha', email: 'alice@example.com', key: 'install:Chrome:alpha-install', url: 'https://alpha.example/' }
  let relayPort = 0
  let relay: RelayServer
  let alpha: FakeExtension
  let client: Client
  let cleanup: () => Promise<void>

  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }))
    return { text: result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'), isError: result.isError === true }
  }

  beforeAll(async () => {
    relayPort = await freePort()
    relay = await startPlayWriterCDPRelayServer({ port: relayPort, host: '127.0.0.1', logger: { log: () => {}, error: () => {} } })
    alpha = await connectFakeExtension({
      port: relayPort,
      name: ALPHA.name,
      workspace: TEST_WORKSPACE.key,
      url: ALPHA.url,
      query: { browser: 'Chrome', installId: `${ALPHA.name}-install`, email: ALPHA.email, id: '1001', v: VERSION, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/139.0.0.0', browserVersion: '139.0.7258.5' },
    })
    ;({ client, cleanup } = await createMCPClient({
      port: relayPort,
      env: { PLAYWRITER_BROWSER: '', PLAYWRITER_DIRECT: '', PLAYWRITER_HOST: '', PLAYWRITER_POLICY: '', PLAYWRITER_BROWSER_PATH: chromium.executablePath() },
    }))
  }, 120_000)

  afterAll(async () => {
    await cleanup?.()
    alpha?.ws.close()
    await relay?.close()
  })

  it('browser new with mode fast drives a fast session, and list says so', async () => {
    const launched = await call('browser', { action: 'new', mode: 'fast' })
    expect(launched.isError, launched.text).toBe(false)
    expect(launched.text).toMatch(/Mode: fast mode, for testing on localhost/)
    const listed = await call('browser', { action: 'list' })
    expect(listed.text).toMatch(/This session drives: a new Chrome launched for this session \(.*\), in fast mode/)
    // Several actions and a DOM write in one call: allowed only in fast mode.
    const executed = await call('execute', {
      code: `await page.goto('${baseUrl}/form.html'); await page.evaluate(() => { document.querySelector('h1').textContent = 'Fast' }); return await page.evaluate(() => document.querySelector('h1').textContent)`,
    })
    expect(executed.isError, executed.text).toBe(false)
    expect(executed.text).toContain('Fast')
  }, 120_000)

  it('browser new without a mode drives human mode (this server sets no PLAYWRITER_POLICY)', async () => {
    const launched = await call('browser', { action: 'new' })
    expect(launched.isError, launched.text).toBe(false)
    expect(launched.text).toMatch(/Mode: human mode/)
    const refused = await call('execute', { code: "await page.evaluate(() => { document.body.dataset.x = '1' })" })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/Refused \(human mode\)/)
  }, 120_000)

  it('browser use with mode fast drives that profile in fast mode, and list says so', async () => {
    const chosen = await call('browser', { action: 'use', browser: ALPHA.email, mode: 'fast' })
    expect(chosen.isError, chosen.text).toBe(false)
    expect(chosen.text).toContain(ALPHA.email)
    expect(chosen.text).toMatch(/Mode: fast mode/)
    expect(chosen.text).toMatch(/refs from earlier observe\(\)\/find\(\) no longer resolve/)
    const listed = await call('browser', { action: 'list' })
    expect(listed.text).toContain(`This session drives: ${ALPHA.email} (key ${ALPHA.key}), in fast mode`)
    // Code human mode refuses before it runs is not refused by the policy here.
    const executed = await call('execute', { code: "await page.evaluate(() => { document.body.dataset.x = '1' })" })
    expect(executed.text).not.toMatch(/Refused \(human mode\)/)
  }, 120_000)

  it('refuses a mode with list', async () => {
    const refused = await call('browser', { action: 'list', mode: 'fast' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/`mode` is only read by use and new/)
  }, 60_000)
})
