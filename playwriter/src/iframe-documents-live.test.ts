/**
 * Iframes whose documents Chrome has not delivered, in a new browser (headless, human mode).
 *
 * MDN's live examples are cross-site iframes whose documents (`runner.html`) answer with
 * `Clear-Site-Data: "cookies", "storage"`; Chrome delivers such a document only once it has cleared
 * that site's data, and on MDN it delivered them one by one over a minute after the page had loaded
 * (RerunExist, Chrome 149). The journal is right to keep them open, but the report waited the whole
 * settle window on every load (`NOT SETTLED … waiting on GET …/runner.html`) and observe() printed one
 * `BUSY? no response yet` line per example. Now the rest of the page settles without them, the SETTLED
 * line names the iframes by ref with their documents' addresses and how long Chrome has not delivered
 * them, and observe() says it once: `BUSY? 15 iframes still loading their documents: [..] [..] …`.
 *
 * Fixture: test/fixtures/browser-lab/play-runners.html (MDN's runner pattern: an about:blank iframe
 * replaced by one whose document comes from `<hash>.play.localhost`), whose runner documents the lab
 * never answers (network-lab-fixture.ts), so Chrome has not delivered them for the whole test on any
 * machine. Chrome's own Clear-Site-Data hold is no fixture: a fresh browser holds such a document only
 * when its clearing starts within the browser's first ~5 s (measured: 4 s after launch, held 45 s and
 * more; 7 s and later, delivered in ~0.1 s).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { startNetworkLab, type NetworkLab } from './network-lab-fixture.js'

let lab: NetworkLab
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  lab = await startNetworkLab()
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iframe-documents-'))
})

afterAll(async () => {
  const closing = await Promise.allSettled(executors.map((executor) => executor.closeHeadlessContext()))
  const browser = await Promise.allSettled([PlaywrightExecutor.closeSharedHeadlessBrowser()])
  await lab.close()
  fs.rmSync(cwd, { recursive: true, force: true })
  const errors = [...closing, ...browser].flatMap((outcome): unknown[] => (outcome.status === 'rejected' ? [outcome.reason] : []))
  if (errors.length > 0) throw new AggregateError(errors, `teardown failed ${errors.length} time(s)`)
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

describe('iframes whose documents Chrome has not delivered, in a new browser', () => {
  it('settles without them, names them by ref on the SETTLED line, says so once in observe(), and keeps them open in the journal', async () => {
    const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
    executors.push(executor)
    const opened = await run(executor, `await act.open('${lab.origin}/play-runners.html?count=15', { reason: 'loading the test page' })`)
    // The page and its own requests are quiet; the 15 documents Chrome holds are not waited for.
    expect(settledMs(opened)).toBeLessThan(4500)
    expect(opened).not.toMatch(/NOT SETTLED/)
    expect(opened).toMatch(/not waited for: 15 iframes still loading their documents — \[\d+\] iframe "runner"'s document http:\/\/[0-9a-f]{40}\.play\.localhost:\d+\/play-runner\.html\?code=example%20\d+ — Chrome has not delivered it after \d+\.\ds/)
    expect(opened).toMatch(/\+12 more: (\[\d+\] ){11}\[\d+\]/)

    const look = await run(executor, 'await observe()')
    expect(look).toMatch(/^BUSY\? 15 iframes still loading their documents: (\[\d+\] ){14}\[\d+\] — Chrome has not delivered them yet \(weak signal; may be idle\)$/m)
    expect(look).not.toMatch(/no response yet/)

    // The journal stays truthful: Chrome has not answered them.
    const rows = await run(executor, "return JSON.stringify((await net.requests({ urlIncludes: 'play-runner.html' })).map((r) => [r.status ?? null, r.endedAt ?? null]))")
    const pending = JSON.parse(/\[return value\] ([\s\S]*)$/.exec(rows)?.[1] ?? 'null')
    expect(pending).toEqual(Array.from({ length: 15 }, () => [null, null]))

    // A run replaces example 1's iframe: the click settles without its new document too.
    const clicked = await run(executor, `await act.click(${refOf(look, /button "Run example 1"/)})`)
    expect(settledMs(clicked)).toBeLessThan(4500)
    expect(clicked).toMatch(/not waited for: an iframe still loading its document — \[\d+\] iframe "runner"'s document http:\/\/[0-9a-f]{40}\.play\.localhost:\d+\/play-runner\.html\?code=example%201 — Chrome has not delivered it after \d+\.\ds/)
  }, 120_000)
})
