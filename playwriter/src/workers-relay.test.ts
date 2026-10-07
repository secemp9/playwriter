/**
 * Web Workers and CORS failures through the REAL extension, built for this suite's port and loaded in
 * Chromium, and the real relay, in a human-mode session on the Browser Lab's pages
 * (test/fixtures/browser-lab):
 *
 *  - a dedicated worker's console error and uncaught exception are on the ERRORS line and in
 *    getLatestLogs with their location, and its script request ends;
 *  - a worker started by a worker (nested) is followed too;
 *  - a second session of the same workspace, connected while the worker runs, is told of it and
 *    hears it, and the first one still does;
 *  - errors.html's worker, terminated by the page inside its error handler, settles: Chrome reports
 *    nothing of that error over CDP (measured; the test fails if that ever changes);
 *  - a request Chrome blocked for CORS names Chrome's reason, the origin and the address.
 *
 * Before the relay forwarded `worker` targets, it resumed and dropped them: Playwright never had the
 * worker's session, so none of this reached the report.
 *
 * Runs alone: `pnpm vitest run src/workers-relay.test.ts` (relay port: TEST_RELAY_PORTS).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from '@xmorse/playwright-core'
import { PlaywrightExecutor } from './executor.js'
import type { CDPEventBase } from './cdp-types.js'
import { startNetworkLab, type NetworkLab } from './network-lab-fixture.js'
import { cleanupTestContext, getExtensionServiceWorker, setupTestContext, TEST_WORKSPACE, type TestContext } from './test-utils.js'

let lab: NetworkLab
let cwd = ''
let testCtx: TestContext | null = null
let userPage: Page
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  lab = await startNetworkLab()
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-relay-'))
  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-workers-relay-' })
  const serviceWorker = await getExtensionServiceWorker(testCtx.browserContext)
  userPage = await testCtx.browserContext.newPage()
  const start = `${lab.origin}/landing.html`
  await userPage.goto(start, { waitUntil: 'load' })
  await userPage.bringToFront()
  // The executor must find this tab in its workspace when it connects; otherwise the relay
  // auto-creates a blank one. The relay registers the tab when the extension reports it attached.
  const attached = Promise.withResolvers<void>()
  const attachedUrls: string[] = []
  const stop = listen((event) => {
    if (event.method !== 'Target.attachedToTarget') return
    const url = targetUrlOf(event)
    attachedUrls.push(url)
    if (url === start) attached.resolve()
  })
  // Real timer: the extension attaches a real tab in a real browser; fail naming what did attach.
  const deadline = setTimeout(
    () => attached.reject(new Error(`the extension did not attach ${start} within 60 s; it attached: ${JSON.stringify(attachedUrls)}`)),
    60_000,
  )
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
    stop()
  }
}, 600_000)

afterAll(async () => {
  for (const executor of executors) await executor.disconnect().catch(() => {})
  await cleanupTestContext(testCtx)
  await lab.close()
  fs.rmSync(cwd, { recursive: true, force: true })
})

function newExecutor(): PlaywrightExecutor {
  const port = testCtx?.port
  if (port === undefined) throw new Error('the test context is not set up')
  const executor = new PlaywrightExecutor({ cdpConfig: { port, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  executors.push(executor)
  return executor
}

/** Hear every CDP event the extension sends the relay, until the returned function is called. */
function listen(onEvent: (event: CDPEventBase) => void): () => void {
  const relay = testCtx?.relayServer
  if (!relay) throw new Error('the test context is not set up')
  const listener = ({ event }: { event: CDPEventBase }): void => onEvent(event)
  relay.on('cdp:event', listener)
  return () => relay.off('cdp:event', listener)
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function targetUrlOf(event: CDPEventBase): string {
  const url = field(field(event.params, 'targetInfo'), 'url')
  return typeof url === 'string' ? url : String(url)
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

function returned(text: string): unknown {
  const match = /\[return value\] ([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`no return value in:\n${text}`)
  return JSON.parse(match[1]!.trim())
}

async function run(executor: PlaywrightExecutor, code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

async function open(executor: PlaywrightExecutor, page: string): Promise<string> {
  await run(executor, `await act.open('${lab.origin}/${page}', { reason: 'loading the test page' })`)
  return await run(executor, 'await observe()')
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('dedicated workers through the real extension', () => {
  it("puts a worker's console error and uncaught exception on the ERRORS line and in getLatestLogs, and its script request ends", async () => {
    const executor = newExecutor()
    const look = await open(executor, 'worker-errors.html')
    const clicked = await run(executor, `await act.click(${refOf(look, /button "Import rows"/)})`)
    const worker = `${lab.origin}/lab/import-worker.js`
    expect(clicked).toContain(`console.error: import worker: bad row 7 in rows.csv (${worker}:3:11)`)
    expect(clicked).toMatch(new RegExp(`uncaught: Uncaught Error: import worker crashed on row 7 \\(${escape(worker)}:5:\\d+\\)`))
    expect(clicked).not.toMatch(/NOT SETTLED/)

    const logs = returned(await run(executor, 'return JSON.stringify(await getLatestLogs())')) as string[]
    expect(logs).toContain(`[error] import worker: bad row 7 in rows.csv\n    at ${worker}:3:11`)
    const uncaught = logs.find((entry) => entry.startsWith('[pageerror] import worker crashed on row 7'))
    expect(uncaught, JSON.stringify(logs)).toMatch(new RegExp(`\\n    at .*${escape(worker)}:5:\\d+`))

    const rows = returned(await run(executor, "return JSON.stringify(await net.requests({ urlIncludes: 'import-worker.js' }))"))
    expect(rows).toEqual([expect.objectContaining({ status: 200, endedAt: expect.any(Number) })])
  })

  it('hears a worker that fails as its script first runs', async () => {
    // Chrome holds a new worker until a debugger resumes it; what its script does right away is reported
    // only if Runtime is on in the worker before that resume.
    const executor = newExecutor()
    const look = await open(executor, 'worker-startup.html')
    const clicked = await run(executor, `await act.click(${refOf(look, /button "Start sync"/)})`)
    const worker = `${lab.origin}/lab/startup-worker.js`
    expect(clicked).toContain(`console.error: sync worker: no server configured (${worker}:2:9)`)
    expect(clicked).toMatch(new RegExp(`uncaught: Uncaught Error: sync worker could not start \\(${escape(worker)}:3:\\d+\\)`))
    expect(clicked).not.toMatch(/NOT SETTLED/)
  })

  it('follows a worker started by a worker', async () => {
    const executor = newExecutor()
    const look = await open(executor, 'nested-worker.html')
    const clicked = await run(executor, `await act.click(${refOf(look, /button "Resize images"/)})`)
    expect(clicked).toContain(`console.error: resize worker: cannot decode photo-3.png (${lab.origin}/lab/nested-inner-worker.js:3:11)`)
    expect(clicked).not.toMatch(/NOT SETTLED/)
  })

  it('a second session of the workspace is told of a running worker and hears it; the first still does', async () => {
    const first = newExecutor()
    const look = await open(first, 'worker-errors.html')
    const button = refOf(look, /button "Import rows"/)
    const worker = `${lab.origin}/lab/import-worker.js`
    const expected = `console.error: import worker: bad row 7 in rows.csv (${worker}:3:11)`

    // Connects while the worker runs: the relay replays the worker's attach on the page's session.
    const second = newExecutor()
    const secondLook = await run(second, 'await observe()')
    const secondClick = await run(second, `await act.click(${refOf(secondLook, /button "Import rows"/)})`)
    expect(secondClick).toContain(expected)
    expect(secondClick).not.toMatch(/NOT SETTLED/)

    const firstClick = await run(first, `await act.click(${button})`)
    expect(firstClick).toContain(expected)
    expect(firstClick).not.toMatch(/NOT SETTLED/)
  })

  it('ERR-T4: settles after the lab worker error, its script request ended; Chrome still reports nothing of that error', async () => {
    const executor = newExecutor()
    const look = await open(executor, 'errors.html')
    const workerSessions = new Set<string>()
    const onWorker: CDPEventBase[] = []
    const stop = listen((event) => {
      if (event.method === 'Target.attachedToTarget' && targetUrlOf(event).endsWith('/lab/error-worker.js')) {
        const sessionId = field(event.params, 'sessionId')
        if (typeof sessionId === 'string') workerSessions.add(sessionId)
        return
      }
      if (event.method === 'Log.entryAdded' || (event.sessionId !== undefined && workerSessions.has(event.sessionId))) onWorker.push(event)
    })
    let clicked = ''
    try {
      clicked = await run(executor, `await act.click(${refOf(look, /button "Error in Web Worker"/)})`)
    } finally {
      stop()
    }
    expect(clicked).toMatch(/SETTLED \d+ms/)
    expect(clicked).not.toMatch(/NOT SETTLED/)
    expect(clicked).toContain('Worker error: Uncaught Error: Lab worker error')
    const rows = returned(await run(executor, "return JSON.stringify(await net.requests({ urlIncludes: 'error-worker.js' }))"))
    expect(rows).toEqual([expect.objectContaining({ status: 200, endedAt: expect.any(Number) })])

    // The measured limit (raw CDP, Chrome 149): Chrome reports the error on neither the worker's session
    // (Runtime.exceptionThrown) nor the page's (Log.entryAdded). Here the worker's session was live — Chrome
    // reported its script loaded on it — and nothing that reached the relay carries the error. (Through the
    // extension, Runtime may not yet be on in the worker when the page terminates it; the page's Log entry
    // does not depend on that.)
    const methods = onWorker.map((event) => event.method)
    expect(workerSessions.size, 'the worker attached').toBe(1)
    expect(methods, JSON.stringify(onWorker)).toContain('Inspector.workerScriptLoaded')
    expect(methods).not.toContain('Runtime.exceptionThrown')
    expect(onWorker.filter((event) => JSON.stringify(event.params).includes('Lab worker error'))).toEqual([])
  })
})

describe('CORS through the real extension', () => {
  it("names Chrome's CORS reason, the origin and the address of a blocked request", async () => {
    const executor = newExecutor()
    const look = await open(executor, 'network.html')
    const heard: CDPEventBase[] = []
    const requestIds = new Set<string>()
    const stop = listen((event) => {
      const requestId = field(event.params, 'requestId')
      if (JSON.stringify(event.params ?? null).includes('cors-fail')) {
        heard.push(event)
        if (typeof requestId === 'string') requestIds.add(requestId)
      } else if (typeof requestId === 'string' && requestIds.has(requestId)) heard.push(event)
    })
    let clicked = ''
    try {
      clicked = await run(executor, `await act.click(${refOf(look, /button "Cross-origin request \(CORS\)"/)})`)
    } finally {
      stop()
    }
    expect(clicked).toContain(
      `request failed GET /api/cors-fail: CORS: no Access-Control-Allow-Origin header (fetch from ${lab.origin} to ${lab.otherOrigin}/api/cors-fail)`,
    )
    expect(clicked).not.toMatch(/net::ERR_FAILED/)
    const rows = returned(await run(executor, "return JSON.stringify(await net.requests({ urlIncludes: '/api/cors-fail' }))"))
    expect(rows).toEqual([expect.objectContaining({ failed: expect.stringMatching(/^CORS: no Access-Control-Allow-Origin header/) })])

    // Measured: chrome.debugger delivers both of Chrome's CORS sources a launched browser has — the reason
    // on Network.loadingFailed (what the ERRORS line reads) and the console's messages as Log entries.
    // (Audits.issueAdded needs Audits.enable, which nothing sends.)
    const failed = heard.find((event) => event.method === 'Network.loadingFailed')
    expect(field(failed?.params, 'corsErrorStatus')).toEqual({ corsError: 'MissingAllowOriginHeader', failedParameter: '' })
    expect(
      heard
        .filter((event) => event.method === 'Log.entryAdded')
        .map((event) => `${String(field(field(event.params, 'entry'), 'source'))}: ${String(field(field(event.params, 'entry'), 'text'))}`),
    ).toEqual([
      `javascript: Access to fetch at '${lab.otherOrigin}/api/cors-fail' from origin '${lab.origin}' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`,
      'network: Failed to load resource: net::ERR_FAILED',
    ])
  })
})

describe('children of a tab no session hears of', () => {
  // Last in the file: it disconnects every session. The auto-attach a session asked for stays on the tab
  // (Chrome holds each new iframe and worker until the debugger resumes it), so with no session of the
  // tab's workspace connected, only the relay can let them start. Before it did, the user's page was
  // broken by us: the cross-site iframe never loaded and the worker never ran.
  /**
   * Have the page start a cross-site iframe and a worker, as its own script would (through the harness's
   * own Playwright, not a relay session), and wait until both ran. Returns what attached held for the
   * debugger, as `type url`, and the children's session ids.
   */
  async function startChildren(name: string): Promise<{ paused: string[]; sessions: string[] }> {
    const paused: string[] = []
    const sessions: string[] = []
    const stop = listen((event) => {
      if (event.method !== 'Target.attachedToTarget' || field(event.params, 'waitingForDebugger') !== true) return
      // An iframe target attaches before it navigates: its url is still empty.
      paused.push(`${String(field(field(event.params, 'targetInfo'), 'type'))} ${targetUrlOf(event)}`)
      sessions.push(String(field(event.params, 'sessionId')))
    })
    try {
      // The page's own script, as text: this file is typed for Node, which has no DOM Worker.
      const flag = JSON.stringify(name)
      await userPage.evaluate(`(() => {
        const frame = document.createElement('iframe')
        frame.onload = () => { window[${flag} + '-frame'] = true }
        frame.src = ${JSON.stringify(`${lab.otherOrigin}/landing.html?${name}`)}
        document.body.append(frame)
        const worker = new Worker('/lab/nested-inner-worker.js')
        worker.onmessage = () => { window[${flag} + '-worker'] = true }
        worker.postMessage('banner.png')
      })()`)
      // Playwright's own deadline: a held child never loads, and the test says so instead of hanging.
      await userPage.waitForFunction((id) => Reflect.get(window, `${id}-frame`) === true && Reflect.get(window, `${id}-worker`) === true, name, {
        timeout: 10_000,
      })
    } finally {
      stop()
    }
    return { paused: paused.sort(), sessions }
  }

  it('lets a cross-site iframe and a worker start while no session of the workspace is connected', async () => {
    // One session first, so the tab has the auto-attach that holds new children.
    await run(newExecutor(), 'await observe()')
    for (const executor of executors.splice(0)) await executor.disconnect()

    const { paused } = await startChildren('alone')
    // Both were held for the debugger (measured: the iframe attaches with an empty url): the relay let them go.
    expect(paused).toEqual(['iframe ', `worker ${lab.origin}/lab/nested-inner-worker.js`])
  })

  it("lets them start while only another workspace's session is connected, and that session is told nothing of them", async () => {
    const ctx = testCtx
    if (!ctx) throw new Error('the test context is not set up')
    const relay = ctx.relayServer
    const other = new PlaywrightExecutor({
      cdpConfig: { port: ctx.port, workspace: { ...TEST_WORKSPACE, key: `${TEST_WORKSPACE.key}-other`, label: 'other' } },
      logger: { log: () => {}, error: () => {} },
      cwd,
      policy: 'human',
    })
    executors.push(other)
    // Connected, on a tab of its own: the relay makes one for its workspace.
    await run(other, 'await observe()')
    const commands: Array<string | undefined> = []
    const onCommand = ({ command }: { command: { sessionId?: string } }): void => {
      commands.push(command.sessionId)
    }
    relay.on('cdp:command', onCommand)
    let started: { paused: string[]; sessions: string[] }
    try {
      started = await startChildren('foreign')
    } finally {
      relay.off('cdp:command', onCommand)
    }
    expect(started.paused).toEqual(['iframe ', `worker ${lab.origin}/lab/nested-inner-worker.js`])
    // The only client is of another workspace: it sent nothing to the children, so it never had them.
    expect(commands.filter((sessionId) => sessionId !== undefined && started.sessions.includes(sessionId))).toEqual([])
  })
})
