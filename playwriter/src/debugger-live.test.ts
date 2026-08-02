/**
 * Live-Chromium tests for the paused-frame value readers.
 *
 * The unit tests in `debugger.test.ts` assert against CDP payload fixtures; these
 * assert against a REAL `Debugger.paused` from a real V8, which is the only way to
 * prove the fixtures (and the reading of the CDP spec behind them) are right. A
 * plain headless Chromium is enough — no extension, no relay.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { PlaywrightCDPSessionAdapter } from './cdp-session.js'
import { Debugger } from './debugger.js'
import type { LocalVariablesResult } from './debugger.js'

// Every local is referenced after the `debugger` statement so V8 cannot elide it.
const APP_JS = `
function runTest() {
  var userAge = 25;
  var userName = 'Alice';
  var looksNumeric = '10';
  var scores = [10, 20, 30];
  var mixed = [1, 'two', true, null, undefined];
  var settings = { lang: 'en', theme: 'dark', nested: { deep: 1 }, tags: ['a', 'b'] };
  var flag = false;
  var nothing = null;
  var missing = undefined;
  var big = 9007199254740993n;
  var sym = Symbol('tag');
  var helper = function helperFn(a) { return a };
  var when = new Date(0);
  var lookup = new Map([['a', 1], ['b', 2]]);
  var seen = new Set([1, 2]);
  var many = new Array(150).fill(7);
  var manyKeys = {}; for (var i = 0; i < 130; i++) manyKeys['k' + i] = i;
  var nan = NaN;
  var negZero = -0;
  var frac = 0.30000000000000004;
  var arrExtra = [1, 2]; arrExtra.foo = 'bar';
  debugger;
  return [userAge, userName, looksNumeric, scores, mixed, settings, flag, nothing, missing, big, sym,
          helper, when, lookup, seen, many, manyKeys, nan, negZero, frac, arrExtra].length;
}
function outer() { var outerLocal = 'from-outer'; return runTest(); }
window.outer = outer;
`

let browser: Browser
let context: BrowserContext
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/app.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(APP_JS)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><body><div id="root">hi</div><script src="/app.js"></script></body>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext()
}, 120000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
  await new Promise<void>((r) => server?.close(() => r()))
})

/** Pause on the fixture's `debugger` statement and hand back a live Debugger. */
async function pausedAtFixture(): Promise<{ page: Page; dbg: Debugger; resume: () => Promise<void> }> {
  const page = await context.newPage()
  await page.goto(baseUrl)
  const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
  const dbg = new Debugger({ cdp })
  await dbg.enable()

  const paused = new Promise<void>((resolve) => {
    const onPaused = () => {
      cdp.off('Debugger.paused', onPaused)
      resolve()
    }
    cdp.on('Debugger.paused', onPaused)
  })
  // Not awaited: the evaluate blocks while V8 is paused.
  const running = page.evaluate('outer()').catch(() => {})
  await paused
  expect(dbg.isPaused()).toBe(true)

  return {
    page,
    dbg,
    resume: async () => {
      await dbg.resume().catch(() => {})
      await running
      await page.close()
    },
  }
}

describe('inspectLocalVariables against a real paused frame', () => {
  let res: LocalVariablesResult
  let done: () => Promise<void>

  beforeAll(async () => {
    const { dbg, resume } = await pausedAtFixture()
    res = await dbg.inspectLocalVariables()
    done = resume
  }, 60000)

  afterAll(async () => {
    await done()
  })

  it('keeps top-level primitives exact', () => {
    expect(res.variables.userAge).toBe(25)
    expect(res.variables.userName).toBe('Alice')
    expect(res.variables.flag).toBe(false)
    expect(res.variables.nothing).toBeNull()
    expect(res.variables.missing).toBeUndefined()
    expect(Number.isNaN(res.variables.nan as number)).toBe(true)
    expect(Object.is(res.variables.negZero, -0)).toBe(true)
    expect(res.variables.frac).toBe(0.30000000000000004)
  })

  it('keeps NESTED numbers as numbers — the regression this test exists for', () => {
    // Every value in a CDP preview arrives as a string; the type is in `type`.
    expect(res.variables.scores).toEqual([10, 20, 30])
    for (const n of res.variables.scores as unknown[]) expect(typeof n).toBe('number')
    expect(res.variables.mixed).toEqual([1, 'two', true, null, undefined])
    expect(res.variables.settings).toMatchObject({ lang: 'en', theme: 'dark' })
  })

  it('distinguishes the string "10" from the number 10 at every depth', () => {
    expect(res.variables.looksNumeric).toBe('10')
    expect(typeof res.variables.looksNumeric).toBe('string')
    const scores = res.variables.scores as number[]
    expect(scores[0]).toBe(10)
    expect(scores[0]).not.toBe('10' as unknown)
  })

  it('represents BigInt and Symbol deliberately, and distinguishably', () => {
    // A real BigInt would make JSON.stringify throw; the marker carries the literal.
    expect(res.variables.big).toBe('[bigint 9007199254740993n]')
    expect(() => JSON.stringify(res.variables)).not.toThrow()
    expect(res.variables.sym).toBe('[symbol Symbol(tag)]')
  })

  it('names a function instead of flattening it to a bare marker', () => {
    expect(res.variables.helper).toBe('[function helperFn]')
  })

  it('renders a Date as a Date, and a Map/Set with its entries', () => {
    expect(String(res.variables.when)).toMatch(/^\[date .*1970/)
    expect(res.variables.lookup).toEqual({
      '[collection]': 'Map(2)',
      '[entries]': [
        ['a', 1],
        ['b', 2],
      ],
    })
    expect(res.variables.seen).toEqual({ '[collection]': 'Set(2)', '[entries]': [1, 2] })
  })

  it('marks a nested container the browser never previewed', () => {
    const settings = res.variables.settings as Record<string, unknown>
    expect(settings.nested).toBe('[object Object]')
    expect(settings.tags).toBe('[array Array(2)]')
  })

  it('reports the browser’s own truncation without corrupting the value shape', () => {
    const many = res.variables.many as unknown[]
    // V8 previews at most 100 array items; the array must be exactly what arrived.
    expect(many.length).toBe(100)
    expect(many.every((x) => x === 7)).toBe(true)
    expect(res.overflowedContainers.join('\n')).toMatch(/many: Array\(150\) — the browser sent only the first 100 item/)
    // Objects are previewed at ~5 properties — also reported, not inferred.
    expect(res.overflowedContainers.join('\n')).toMatch(/manyKeys: the browser sent only \d+ of this object's properties/)
    // A non-index array property stays off the element shape.
    expect(res.variables.arrExtra).toEqual([1, 2])
    expect(res.overflowedContainers.join('\n')).toMatch(/arrExtra: non-index property foo/)
  })

  it('states its limits and the marker vocabulary', () => {
    expect(res.limits.topFrameOnly).toBe(true)
    expect(res.limits.note).toMatch(/overflowedContainers/)
    expect(res.limits.note).toMatch(/\[bigint 1n\]/)
    expect(res.frame.functionName).toBe('runTest')
    expect(res.frame.totalFrames).toBeGreaterThan(1)
  })
})

describe('getCallFrames against a real paused stack', () => {
  it('reads every frame with the same type fidelity and its own accounting', async () => {
    const { dbg, resume } = await pausedAtFixture()
    const frames = await dbg.getCallFrames()

    expect(frames.length).toBeGreaterThan(1)
    expect(frames[0].functionName).toBe('runTest')
    const top = frames[0].scopeChain.find((s) => s.type === 'local')!
    expect(top.variables.userAge).toBe(25)
    expect(top.variables.scores).toEqual([10, 20, 30])
    expect(top.variables.looksNumeric).toBe('10')
    expect(frames[0].overflowedContainers.join('\n')).toMatch(/the browser sent only the first 100 item/)
    expect(frames[0].cappedValues).toEqual([])

    // The caller's frame is read too (this is what inspectLocalVariables cannot do).
    const outerFrame = frames.find((f) => f.functionName === 'outer')!
    const outerLocal = outerFrame.scopeChain.find((s) => s.type === 'local')!
    expect(outerLocal.variables.outerLocal).toBe('from-outer')

    await resume()
  }, 60000)
})
