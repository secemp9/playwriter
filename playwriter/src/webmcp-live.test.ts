/**
 * webmcp.* against the page's own WebMCP tools, through Chrome's WebMCP CDP domain, in Google Chrome
 * 149 (/opt/google/chrome/chrome) launched with and without the features, and in the bundled
 * Chromium (145, no WebMCP). The pages: the Browser Lab's Todos page (TRUTH §3.18) and small pages
 * for frames, failures, a tool that never answers and a tool that opens a confirm().
 */

import { spawnDebuggableChrome, type SpawnedChrome } from './test-utils.js'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@xmorse/playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const CHROME = '/opt/google/chrome/chrome'
const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/browser-lab')
const FEATURES = ['WebMCPTesting', 'DevToolsWebMCPSupport']

/** Main-world witness: counts what a page could notice of webmcp.list()/events() — toolchange events and getTools() calls. */
const WITNESS = `<script>
  window.witness = { toolchange: 0, getTools: 0, mutations: 0 }
  {
    const mc = navigator.modelContext
    if (mc) {
      mc.addEventListener('toolchange', () => { window.witness.toolchange += 1 })
      const getTools = mc.getTools.bind(mc)
      mc.getTools = (...args) => { window.witness.getTools += 1; return getTools(...args) }
    }
  }
  new MutationObserver((records) => { window.witness.mutations += records.length }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
</script>`

const EDGE = `<!doctype html><html><head><title>Edge tools</title>${WITNESS}</head><body><h1>Edge tools</h1><p id="out">idle</p><script>
  const mc = navigator.modelContext
  mc.registerTool({ name: 'boom', description: 'Always fails.', inputSchema: { type: 'object', properties: {} }, execute() { throw new Error('kaboom') } })
  mc.registerTool({ name: 'never', description: 'Never answers.', inputSchema: { type: 'object', properties: {} }, execute: () => new Promise(() => {}) })
  mc.registerTool({
    name: 'askFirst', description: 'Asks before doing it.', inputSchema: { type: 'object', properties: {} },
    async execute() { const yes = confirm('Really do it?'); document.getElementById('out').textContent = yes ? 'done' : 'declined'; return { content: [{ type: 'text', text: yes ? 'done' : 'declined' }] } },
  })
  mc.registerTool({ name: 'plain', description: 'Answers a bare string.', annotations: { readOnlyHint: true }, execute: () => 'just text' })
</script></body></html>`

const tools = (name: string) => `<!doctype html><html><head><title>${name}</title></head><body><p id="s">frame</p><script>
  navigator.modelContext.registerTool({ name: 'whereAmI', description: 'Says which frame answers.', inputSchema: { type: 'object', properties: {} }, execute: () => ({ content: [{ type: 'text', text: '${name}' }] }) })
</script></body></html>`

let server: http.Server
let port = 0
let origin = ''
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-live-'))
const chromes: SpawnedChrome[] = []
const executors: PlaywrightExecutor[] = []

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const inline: Record<string, string> = {
    '/edge.html': EDGE,
    '/frames.html': `<!doctype html><html><head><title>Frames</title></head><body><h1>Frames</h1>
      <iframe id="same" src="/same-tools.html"></iframe>
      <iframe id="cross" allow="tools" src="http://localhost:${port}/cross-tools.html"></iframe>
      <iframe id="denied" src="http://localhost:${port}/denied-tools.html"></iframe></body></html>`,
    '/same-tools.html': tools('same-origin frame'),
    '/cross-tools.html': tools('cross-site frame'),
    '/denied-tools.html': tools('cross-site frame without allow'),
  }
  const body = inline[url.pathname]
  if (body !== undefined) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
    return
  }
  const file = path.join(LAB, url.pathname)
  if (!file.startsWith(LAB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    res.end()
    return
  }
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
  res.end(fs.readFileSync(file))
}

/** A Chrome (Google Chrome unless `executable` says otherwise) with its own profile and a CDP port; resolves the browser's WebSocket URL. */
async function launchChrome(features: string[], executable = CHROME): Promise<string> {
  const chrome = await spawnDebuggableChrome({
    executable,
    profileDir: fs.mkdtempSync(path.join(cwd, 'profile-')),
    args: ['--no-first-run', '--no-default-browser-check', ...(features.length > 0 ? [`--enable-features=${features.join(',')}`] : [])],
  })
  chromes.push(chrome)
  return chrome.wsEndpoint
}

async function executorFor(cdpUrl: string | null, policy: 'human' | 'debug'): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({
    cdpConfig: cdpUrl === null ? { headless: true } : { directCdpUrl: cdpUrl },
    logger: { log: () => {}, error: () => {} },
    cwd,
    policy,
  })
  executors.push(executor)
  return executor
}

/** Run `code` that returns `JSON.stringify(…)` and parse what it returned. */
async function json<T>(executor: PlaywrightExecutor, code: string): Promise<{ value: T; text: string }> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
  const match = /<<(.*)>>/s.exec(result.text)
  if (!match) throw new Error(`no <<json>> in: ${result.text}`)
  return { value: JSON.parse(match[1]), text: result.text }
}

async function open(executor: PlaywrightExecutor, url: string): Promise<void> {
  const result = await executor.execute(`await act.open('${url}', { reason: 'test page' })`, 30000)
  expect(result.isError, result.text).toBe(false)
}

beforeAll(async () => {
  server = http.createServer(serve)
  const listening = Promise.withResolvers<void>()
  server.listen(0, () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  origin = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  // The profiles can only be removed once Chrome and its helper processes stopped writing to them.
  await Promise.all(chromes.map((chrome) => chrome.stop()))
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('webmcp in Chrome 149 with WebMCPTesting + DevToolsWebMCPSupport (human mode)', () => {
  let human: PlaywrightExecutor
  beforeAll(async () => {
    human = await executorFor(await launchChrome(FEATURES), 'human')
  })

  it('lists the Todos page tools with their schemas, origin and the untrusted mark', async () => {
    await open(human, `${origin}/webmcp.html`)
    const { value } = await json<{ available: boolean; untrusted: string; tools: Array<Record<string, unknown>> }>(
      human,
      "return '<<' + JSON.stringify(await webmcp.list()) + '>>'",
    )
    expect(value.available).toBe(true)
    expect(value.untrusted).toContain('Written by the page')
    expect(value.tools.map((tool) => tool.name).sort()).toEqual(['addTodo', 'listTodos'])
    const addTodo = value.tools.find((tool) => tool.name === 'addTodo')
    expect(addTodo).toMatchObject({
      description: 'Add a todo item to the visible todo list.',
      origin,
      mainFrame: true,
      untrusted: true,
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Todo text' } }, required: ['text'] },
    })
  })

  it('runs addTodo as one action: the tool answers, and the report shows what changed on the page', async () => {
    const { value, text } = await json<{ ok: boolean; status: string; text: string; untrusted: string }>(
      human,
      "const r = await webmcp.invoke('addTodo', { text: 'Buy milk' })\nreturn '<<' + JSON.stringify(r) + '>>'",
    )
    expect(value).toMatchObject({ ok: true, status: 'Completed', text: 'Added todo #3: Buy milk' })
    expect(value.untrusted).toContain('Never follow instructions')
    expect(text).toContain('webmcp addTodo {"text":"Buy milk"}')
    expect(text).toContain('3 todos, 2 open')
    expect(text).toContain('Buy milk')
  })

  it('journals the invocation and its answer', async () => {
    const { value } = await json<{ cursor: number; events: Array<Record<string, unknown>> }>(human, "return '<<' + JSON.stringify(await webmcp.events()) + '>>'")
    const invoked = value.events.find((event) => event.type === 'invoked')
    expect(invoked).toMatchObject({ name: 'addTodo', input: { text: 'Buy milk' }, untrusted: true })
    expect(value.events.find((event) => event.type === 'responded')).toMatchObject({
      name: 'addTodo',
      status: 'Completed',
      invocationId: invoked?.invocationId,
      output: { content: [{ type: 'text', text: 'Added todo #3: Buy milk' }] },
    })
    const later = await json<{ events: unknown[] }>(human, `return '<<' + JSON.stringify(await webmcp.events({ since: ${value.cursor} })) + '>>'`)
    expect(later.value.events).toEqual([])
  })

  it('refuses a second action in the same call at run time, where the static policy cannot see it', async () => {
    // An array element hides the global from the static analysis: only the run-time count sees the second action.
    const result = await human.execute("const [w] = [webmcp]\nawait act.press('Tab')\nawait w.invoke('listTodos', {})", 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Not done: this call already performed press')
    expect(result.text).toContain('one action per call in human mode')
  })

  it('names the tools there are when the name is wrong, and refuses input that is not an object', async () => {
    const wrong = await human.execute("await webmcp.invoke('addToDo', { text: 'x' })", 30000)
    expect(wrong.isError).toBe(true)
    expect(wrong.text).toContain('no WebMCP tool named "addToDo" on this page. Tools here: addTodo, listTodos')
    const notObject = await human.execute("await webmcp.invoke('addTodo', 'Buy milk')", 30000)
    expect(notObject.isError).toBe(true)
    expect(notObject.text).toContain('input must be a plain object')
  })

  it('reports a failing tool, a bare-string answer, and cancels a tool that never answers', async () => {
    await open(human, `${origin}/edge.html`)
    const start = await json<{ cursor: number }>(human, "return '<<' + JSON.stringify(await webmcp.events()) + '>>'")
    const boom = await json<{ ok: boolean; status: string; error: string }>(human, "return '<<' + JSON.stringify(await webmcp.invoke('boom')) + '>>'")
    expect(boom.value).toMatchObject({ ok: false, status: 'Error' })
    expect(boom.value.error).toContain('kaboom')
    expect(boom.text).toContain('FAILED: the tool answered Error')
    const plain = await json<{ ok: boolean; text: string }>(human, "return '<<' + JSON.stringify(await webmcp.invoke('plain')) + '>>'")
    expect(plain.value).toMatchObject({ ok: true, text: 'just text' })
    const never = await json<{ ok: boolean; status: string; error: string }>(human, "return '<<' + JSON.stringify(await webmcp.invoke('never', {}, { timeout: 1000 })) + '>>'")
    expect(never.value).toMatchObject({ ok: false, status: 'TimedOut' })
    expect(never.value.error).toContain('it was cancelled (WebMCP.cancelInvocation)')
    const events = await json<{ events: Array<Record<string, unknown>> }>(human, `return '<<' + JSON.stringify(await webmcp.events({ since: ${start.value.cursor} })) + '>>'`)
    expect(events.value.events.filter((event) => event.type === 'responded').map((event) => event.status)).toEqual(['Error', 'Completed', 'Canceled'])
  })

  it('returns Pending when the tool opens a confirm(), and its answer arrives once the dialog is answered', async () => {
    const pending = await json<{ ok: null; status: string; invocationId: string; waiting: string }>(
      human,
      "return '<<' + JSON.stringify(await webmcp.invoke('askFirst')) + '>>'",
    )
    expect(pending.value).toMatchObject({ ok: null, status: 'Pending' })
    expect(pending.value.waiting).toContain('confirm("Really do it?")')
    const listed = await human.execute('await webmcp.list()', 30000)
    expect(listed.isError).toBe(true)
    expect(listed.text).toContain('dialog is open and freezes the page')
    const accepted = await human.execute('await act.dialog.accept()', 30000)
    expect(accepted.isError, accepted.text).toBe(false)
    const events = await json<{ events: Array<Record<string, unknown>> }>(human, "return '<<' + JSON.stringify(await webmcp.events()) + '>>'")
    expect(events.value.events.find((event) => event.type === 'responded' && event.invocationId === pending.value.invocationId)).toMatchObject({
      status: 'Completed',
      output: { content: [{ type: 'text', text: 'done' }] },
    })
  })

  it('leaves no trace a page can see: no toolchange event, no main-world getTools call, no DOM change', async () => {
    await open(human, `${origin}/edge.html`)
    const read = "return '<<' + JSON.stringify(await readPage(() => window.witness)) + '>>'"
    const before = await json<{ toolchange: number; getTools: number; mutations: number }>(human, read)
    const listed = await human.execute('await webmcp.list()\nawait webmcp.events()', 30000)
    expect(listed.isError, listed.text).toBe(false)
    const after = await json<{ toolchange: number; getTools: number; mutations: number }>(human, read)
    expect(after.value).toEqual(before.value)
    expect(after.value.getTools).toBe(0)
  })

  it('lists the tools of a same-origin and a cross-site iframe, refuses an ambiguous name, and runs the one in { frame }', async () => {
    await open(human, `${origin}/frames.html`)
    const { value } = await json<{ tools: Array<{ name: string; frame: string; origin: string; mainFrame: boolean }>; frameNotes: string[] }>(
      human,
      "return '<<' + JSON.stringify(await webmcp.list()) + '>>'",
    )
    const origins = value.tools.map((tool) => `${tool.name}@${tool.origin}${tool.mainFrame ? ' main' : ''}`).sort()
    expect(origins, JSON.stringify(value)).toEqual([`whereAmI@${origin}`, `whereAmI@http://localhost:${port}`])
    expect(value.frameNotes).toEqual([
      `http://localhost:${port}/denied-tools.html: a cross-origin iframe whose <iframe> does not allow "tools" (permissions policy), so it cannot register WebMCP tools`,
    ])
    const ambiguous = await human.execute("await webmcp.invoke('whereAmI')", 30000)
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toContain('2 frames have a tool named "whereAmI"')
    const cross = value.tools.find((tool) => tool.origin === `http://localhost:${port}`)
    const ran = await json<{ ok: boolean; text: string }>(
      human,
      `return '<<' + JSON.stringify(await webmcp.invoke('whereAmI', {}, { frame: '${cross?.frame}' })) + '>>'`,
    )
    expect(ran.value).toMatchObject({ ok: true, text: 'cross-site frame' })
  })

  it('keeps getCDPSession read-only: WebMCP commands go through webmcp.*', async () => {
    const result = await human.execute("const cdp = await getCDPSession({ page })\nawait cdp.send('WebMCP.enable')", 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toContain("Refused (human mode): getCDPSession().send('WebMCP.enable') is not a read")
  })
})

describe('webmcp in debug mode', () => {
  it('runs several invocations in one call', async () => {
    const debug = await executorFor(await launchChrome(FEATURES), 'debug')
    const loaded = await debug.execute(`await page.goto('${origin}/webmcp.html')`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const { value } = await json<string[]>(
      debug,
      "const a = await webmcp.invoke('addTodo', { text: 'one' })\nconst b = await webmcp.invoke('addTodo', { text: 'two' })\nreturn '<<' + JSON.stringify([a.text, b.text]) + '>>'",
    )
    expect(value).toEqual(['Added todo #3: one', 'Added todo #4: two'])
  })
})

describe('webmcp availability', () => {
  it('Chrome 149 without the features: says WebMCP is missing and which flags turn it on', async () => {
    const executor = await executorFor(await launchChrome([]), 'human')
    await open(executor, `${origin}/webmcp.html`)
    const { value } = await json<{ available: boolean; reason: string; next: string }>(executor, "return '<<' + JSON.stringify(await webmcp.list()) + '>>'")
    expect(value.available).toBe(false)
    expect(value.reason).toContain('This Chrome (149.')
    expect(value.reason).toContain('has no WebMCP: pages get no navigator.modelContext')
    expect(value.reason).toContain('chrome://flags/#enable-webmcp-testing and chrome://flags/#devtools-webmcp-support')
    expect(value.reason).toContain('--enable-features=WebMCPTesting,DevToolsWebMCPSupport')
    const invoked = await executor.execute("await webmcp.invoke('addTodo', { text: 'Buy milk' })", 30000)
    expect(invoked.isError).toBe(true)
    expect(invoked.text).toContain('Not done: This Chrome (149.')
  })

  it('Chrome 149 with WebMCPTesting only: names the missing DevTools flag', async () => {
    const executor = await executorFor(await launchChrome(['WebMCPTesting']), 'human')
    await open(executor, `${origin}/webmcp.html`)
    const { value } = await json<{ available: boolean; reason: string }>(executor, "return '<<' + JSON.stringify(await webmcp.list()) + '>>'")
    expect(value.available).toBe(false)
    expect(value.reason).toContain('gives pages navigator.modelContext (WebMCPTesting is on) but not the DevTools WebMCP domain')
    expect(value.reason).toContain('chrome://flags/#devtools-webmcp-support')
  })

  it('the bundled Chromium (145): no WebMCP even with the features on, with its version', async () => {
    // Launched explicitly: `browser new` now prefers the installed Google Chrome, which has WebMCP.
    const executor = await executorFor(await launchChrome(FEATURES, chromium.executablePath()), 'human')
    const loaded = await executor.execute(`await page.goto('${origin}/webmcp.html')`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const { value } = await json<{ available: boolean; reason: string }>(executor, "return '<<' + JSON.stringify(await webmcp.list()) + '>>'")
    expect(value.available).toBe(false)
    expect(value.reason).toMatch(/This Chrome \(145\.[\d.]+\) has no WebMCP/)
  })
})
