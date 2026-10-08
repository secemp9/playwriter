/**
 * Iframes whose documents Chrome has not delivered, through the REAL extension (built for this suite's port and
 * loaded in Chromium) and the real relay, in a human-mode session.
 *
 * Measured on MDN in a user's Chrome (RerunExist): its live examples' documents (`runner.html`) answer
 * with `Clear-Site-Data: "cookies", "storage"`, and Chrome delivered them one by one over a minute
 * after the page had loaded. Every request ended in the journal exactly when its iframe showed its
 * document — nothing was lost on the iframes' sessions — but `act.open` waited the whole settle window
 * (`NOT SETTLED … waiting on GET …/runner.html`) and every observe() printed 13 `BUSY? no response yet`
 * lines. Now the page settles without them, the SETTLED line names the iframes by ref with their
 * documents' addresses, observe() says it once, and the journal keeps them open (Chrome has not
 * answered them).
 *
 * Fixture: test/fixtures/browser-lab/play-runners.html, whose runner documents the lab never answers
 * (network-lab-fixture.ts): Chrome has sent the requests and has no response for the whole test, on any
 * machine. Chrome's own Clear-Site-Data hold is no fixture: a test browser holds such a document only
 * when its clearing starts within the browser's first ~5 s, and a full test run reached act.open later
 * (the documents arrived within 2.5 s, and no `not waited for` line was printed).
 *
 * Runs alone: `pnpm vitest run src/frames-journal-relay.test.ts` (relay port: TEST_RELAY_PORTS).
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

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/** Hear every CDP event the extension sends the relay, until the returned function is called. */
function listen(onEvent: (event: CDPEventBase) => void): () => void {
  const relay = testCtx?.relayServer
  if (!relay) throw new Error('the test context is not set up')
  const listener = ({ event }: { event: CDPEventBase }): void => onEvent(event)
  relay.on('cdp:event', listener)
  return () => relay.off('cdp:event', listener)
}

beforeAll(async () => {
  lab = await startNetworkLab()
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-journal-relay-'))
  testCtx = await setupTestContext({ suiteUrl: import.meta.url, tempDirPrefix: 'pw-frames-journal-relay-' })
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
    const url = String(field(field(event.params, 'targetInfo'), 'url'))
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

async function run(executor: PlaywrightExecutor, code: string): Promise<string> {
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

/** How long the report's SETTLED line says settling took; fails on NOT SETTLED. */
function settledMs(report: string): number {
  const match = /^SETTLED (\d+)ms/m.exec(report)
  if (!match) throw new Error(`the report did not settle:\n${report}`)
  return Number(match[1])
}

describe('iframes whose documents Chrome has not delivered, through the real extension', () => {
  it('settles without them, names them by ref on the SETTLED line, says so once in observe(), and keeps them open in the journal', async () => {
    const port = testCtx?.port
    if (port === undefined) throw new Error('the test context is not set up')
    const executor = new PlaywrightExecutor({ cdpConfig: { port, workspace: TEST_WORKSPACE }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
    executors.push(executor)
    const opened = await run(executor, `await act.open('${lab.origin}/play-runners.html?count=15', { reason: 'loading the test page' })`)
    expect(settledMs(opened)).toBeLessThan(4500)
    expect(opened).toMatch(/not waited for: 15 iframes still loading their documents — \[\d+\] iframe "runner"'s document http:\/\/[0-9a-f]{40}\.play\.localhost:\d+\/play-runner\.html\?code=example%20\d+ — Chrome has not delivered it after \d+\.\ds/)

    const look = await run(executor, 'await observe()')
    expect(look).toMatch(/^BUSY\? 15 iframes still loading their documents: (\[\d+\] ){14}\[\d+\] — Chrome has not delivered them yet \(weak signal; may be idle\)$/m)
    expect(look).not.toMatch(/no response yet/)

    const rows = await run(executor, "return JSON.stringify((await net.requests({ urlIncludes: 'play-runner.html' })).map((r) => [r.status ?? null, r.endedAt ?? null]))")
    const pending = JSON.parse(/\[return value\] ([\s\S]*)$/.exec(rows)?.[1] ?? 'null')
    expect(pending).toEqual(Array.from({ length: 15 }, () => [null, null]))

    const clicked = await run(executor, `await act.click(${refOf(look, /button "Run example 1"/)})`)
    expect(settledMs(clicked)).toBeLessThan(4500)
    expect(clicked).toMatch(/not waited for: an iframe still loading its document — \[\d+\] iframe "runner"'s document http:\/\/[0-9a-f]{40}\.play\.localhost:\d+\/play-runner\.html\?code=example%201 — Chrome has not delivered it after \d+\.\ds/)
  }, 180_000)
})
