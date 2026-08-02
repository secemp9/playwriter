/**
 * Live-page tests for the trace/probe lane.
 *
 * These need a real page + a real CDP session but NOT the extension/relay, so they
 * launch a plain headless Chromium (the same `@xmorse/playwright-core` build
 * `test-utils.ts` uses for the extension harness) and, where a URL is required for
 * `Debugger.setBreakpointByUrl`, a throwaway static server. Everything that can be
 * tested without a browser lives in `trace.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { PlaywrightCDPSessionAdapter } from './cdp-session.js'
import { Debugger } from './debugger.js'
import {
  storeIdentity,
  fiberSnapshot,
  fiberDiff,
  netTimeline,
  netDelay,
  readLogpoints,
  listTraceProbes,
  readTraceProbe,
  getTraceProbe,
  stopAllTraceProbes,
  tracePerturbationWarnings,
} from './trace.js'

let browser: Browser
let context: BrowserContext
let server: http.Server
let baseUrl: string

const APP_JS = `
function computeTotal(a, b) {
  var sum = a + b;
  return sum;
}
window.computeTotal = computeTotal;
window.hitCount = 0;
`

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    if (url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(APP_JS)
      return
    }
    if (url === '/slow.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body><div id="root">hi</div><script src="/app.js"></script></body></html>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  browser = await chromium.launch({ headless: true })
  context = await browser.newContext()
}, 120000)

afterAll(async () => {
  await stopAllTraceProbes()
  await context?.close()
  await browser?.close()
  await new Promise<void>((r) => server?.close(() => r()))
})

async function freshPage(): Promise<Page> {
  const page = await context.newPage()
  await page.goto(baseUrl)
  return page
}

describe('storeIdentity — a probe that did not measure can never read as a pass', () => {
  it('returns measured:false (and NO verdict field) on a page with no recognisable store', async () => {
    const page = await freshPage()
    let actionRan = false
    const result = await storeIdentity({ page, action: () => { actionRan = true } })

    expect(result.measured).toBe(false)
    // The load-bearing assertion: the healthy-looking field is not merely false,
    // it does not exist. `sameReference: false` used to be indistinguishable from
    // a correctly-behaving store.
    expect('sameReference' in result).toBe(false)
    expect('verdict' in result).toBe(false)
    if (result.measured) throw new Error('unreachable')
    expect(result.reason).toBe('store-not-found')
    // Says what to pass, loudly.
    expect(result.remedy).toMatch(/storeExpr/)
    expect(result.detail).toMatch(/no store was found/)
    // Names everything it looked at, including the fiber walk.
    expect(result.tried.some((t) => t.includes('globalThis.__STORE__'))).toBe(true)
    expect(result.tried.some((t) => t.includes('react fiber tree'))).toBe(true)
    // The action is NOT run when there was nothing to compare.
    expect(result.actionRan).toBe(false)
    expect(actionRan).toBe(false)
    await page.close()
  }, 60000)

  it('detects a mutating reducer: the SAME state reference comes back', async () => {
    const page = await freshPage()
    await page.evaluate(() => {
      const state: any = { total: 0, items: [] as number[] }
      ;(globalThis as any).store = {
        getState: () => state,
        // The bug: mutate in place and return the same object.
        dispatch: (n: number) => {
          state.total = state.total + n
          state.items.push(n)
          return state
        },
      }
    })

    const result = await storeIdentity({
      page,
      action: () => page.evaluate(() => (globalThis as any).store.dispatch(5)),
    })

    expect(result.measured).toBe(true)
    if (!result.measured) throw new Error('unreachable')
    expect(result.sameReference).toBe(true)
    expect(result.verdict).toBe('in-place-mutation')
    expect(result.discovery.via).toBe('global')
    expect(result.discovery.expr).toBe('globalThis.store.getState()')
    // The shallow snapshot proves the mutation even though the root reference did
    // not move — comparing the object against itself would have shown nothing.
    expect(result.changedKeys).toContain('total')
    expect(result.note).toMatch(/in-place mutation/)
    await page.close()
  }, 60000)

  it('reports a healthy store as a fresh reference', async () => {
    const page = await freshPage()
    await page.evaluate(() => {
      let state: any = { total: 0 }
      ;(globalThis as any).__STORE__ = {
        getState: () => state,
        dispatch: (n: number) => {
          state = { ...state, total: state.total + n }
        },
      }
    })
    const result = await storeIdentity({
      page,
      action: () => page.evaluate(() => (globalThis as any).__STORE__.dispatch(3)),
    })
    expect(result.measured).toBe(true)
    if (!result.measured) throw new Error('unreachable')
    expect(result.sameReference).toBe(false)
    expect(result.verdict).toBe('fresh-reference')
    expect(result.changedKeys).toEqual(['total'])
    await page.close()
  }, 60000)

  it('finds a store through the React fiber tree when no global exposes one', async () => {
    const page = await freshPage()
    // A minimal fiber shaped the way react-redux's <Provider store={…}> leaves it.
    // Real React is not needed: the probe walks `return`/`child`/`sibling` and reads
    // `memoizedProps`, which is exactly what is asserted here.
    await page.evaluate(() => {
      const state: any = { cart: { total: 1 }, n: 1 }
      const store = {
        getState: () => state,
        mutate: () => {
          state.n = state.n + 1
        },
      }
      ;(globalThis as any).__test_store = store
      const provider = {
        type: { displayName: 'ReduxProvider' },
        memoizedProps: { store },
        child: null,
        sibling: null,
        return: null as any,
      }
      const hostRoot: any = { type: null, memoizedProps: null, child: provider, sibling: null, return: null }
      provider.return = hostRoot
      const root = (globalThis as any).document.getElementById('root')
      root['__reactFiber$test'] = hostRoot
    })

    const result = await storeIdentity({
      page,
      action: () => page.evaluate(() => (globalThis as any).__test_store.mutate()),
    })
    expect(result.measured).toBe(true)
    if (!result.measured) throw new Error('unreachable')
    expect(result.discovery.via).toBe('react-fiber')
    expect(result.discovery.path).toBe('<ReduxProvider>.props.store')
    expect(result.discovery.pinnedAs).toBe('globalThis.__playwriter_trace_store')
    expect(result.sameReference).toBe(true)
    expect(result.changedKeys).toEqual(['n'])
    // The pinned expression is reusable as a storeExpr afterwards.
    expect(await page.evaluate('typeof globalThis.__playwriter_trace_store.getState')).toBe('function')
    await page.close()
  }, 60000)

  it('uses a caller storeExpr and reports when it throws', async () => {
    const page = await freshPage()
    await page.evaluate(() => {
      ;(globalThis as any).weird = { slice: { a: 1 } }
    })
    const ok = await storeIdentity({ page, action: () => {}, storeExpr: 'globalThis.weird.slice' })
    expect(ok.measured).toBe(true)
    if (ok.measured) {
      expect(ok.discovery.via).toBe('caller-storeExpr')
      expect(ok.sameReference).toBe(true)
    }

    const bad = await storeIdentity({ page, action: () => {}, storeExpr: 'globalThis.nope.deeper' })
    expect(bad.measured).toBe(false)
    if (!bad.measured) {
      expect(bad.reason).toBe('expr-threw')
      expect(bad.detail).toMatch(/nope/)
      expect('sameReference' in bad).toBe(false)
    }
    await page.close()
  }, 60000)

  it('refuses to compare across a navigation instead of reporting a clean pass', async () => {
    const page = await freshPage()
    await page.evaluate(() => {
      const state: any = { a: 1 }
      ;(globalThis as any).store = { getState: () => state }
    })
    const result = await storeIdentity({
      page,
      action: async () => {
        await page.goto(baseUrl + '/?again=1')
      },
    })
    expect(result.measured).toBe(false)
    if (!result.measured) {
      expect(result.reason).toBe('store-vanished')
      expect(result.actionRan).toBe(true)
      expect('sameReference' in result).toBe(false)
    }
    await page.close()
  }, 60000)
})

describe('net.timeline — survives the execute call that created it', () => {
  it('keeps recording and stays readable after the controller is dropped', async () => {
    const page = await freshPage()

    // Simulate the trap: an `execute()` call that starts the probe and keeps only
    // the id (the controller object goes out of scope immediately).
    const id = (() => {
      const controller = netTimeline({ page, urlPattern: '/slow.json' })
      return controller.id
    })()

    expect(listTraceProbes({ live: true }).some((p) => p.id === id)).toBe(true)

    await page.evaluate(async () => {
      await fetch('/slow.json')
    })
    await page.waitForTimeout(200)

    const read = readTraceProbe(id) as { entries: Array<{ phase: string; url: string }>; total: number; dropped: number }
    expect(read.entries.length).toBeGreaterThanOrEqual(2)
    expect(read.entries[0].phase).toBe('request')
    expect(read.entries.some((e) => e.phase === 'response')).toBe(true)
    expect(read.dropped).toBe(0)

    // Passive capture is never reported as a perturbation.
    expect(tracePerturbationWarnings()).toEqual([])

    await stopAllTraceProbes({ kind: 'net.timeline' })
    const info = getTraceProbe(id)!
    expect(info.live).toBe(false)
    expect(info.stoppedReason).toBe('stopAll')
    await page.close()
  }, 60000)

  it('reports dropped entries when the retention cap is hit', async () => {
    const page = await freshPage()
    const timeline = netTimeline({ page, maxEntries: 2 })
    await page.evaluate(async () => {
      await fetch('/slow.json')
      await fetch('/slow.json')
    })
    await page.waitForTimeout(200)
    const stats = timeline.stats()
    expect(stats.total).toBeGreaterThan(2)
    expect(stats.retained).toBe(2)
    expect(stats.dropped).toBe(stats.total - 2)
    timeline.stop()
    await page.close()
  }, 60000)
})

describe('net.delay — a live interceptor cannot hide', () => {
  it('delays matching requests, refuses an overlap, and is visible until stopped', async () => {
    const page = await freshPage()
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))

    const delay = await netDelay({ cdp, urlPattern: '/slow.json', ms: 400 })
    try {
      // A second overlapping delay is REFUSED, naming the live one.
      await expect(netDelay({ cdp, urlPattern: '/slow.json', ms: 10 })).rejects.toThrow(/refusing to start a second net.delay/)
      await expect(netDelay({ cdp, urlPattern: '/slow.json', ms: 10 })).rejects.toThrow(new RegExp(delay.id.replace('#', '#')))

      // Every later trace can see that measurements are being perturbed.
      const warnings = tracePerturbationWarnings()
      expect(warnings.join('\n')).toMatch(/PERTURBING: net\.delay/)
      expect(warnings.join('\n')).toContain(delay.id)

      const elapsed = await page.evaluate(async () => {
        const t0 = Date.now()
        await fetch('/slow.json')
        return Date.now() - t0
      })
      expect(elapsed).toBeGreaterThanOrEqual(350)
      expect(delay.stats().paused).toBeGreaterThanOrEqual(1)
    } finally {
      await delay.stop()
    }

    const info = getTraceProbe(delay.id)!
    expect(info.live).toBe(false)
    expect(info.stoppedReason).toBe('caller')
    expect(tracePerturbationWarnings()).toEqual([])

    // …and the page is fast again.
    const after = await page.evaluate(async () => {
      const t0 = Date.now()
      await fetch('/slow.json')
      return Date.now() - t0
    })
    expect(after).toBeLessThan(350)
    await page.close()
  }, 60000)

  it('auto-expires so a forgotten interceptor cannot poison the session', async () => {
    const page = await freshPage()
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const delay = await netDelay({ cdp, urlPattern: '/slow.json', ms: 50, ttlMs: 300 })
    expect(getTraceProbe(delay.id)!.expiresAt).toBeGreaterThan(Date.now())
    await page.waitForTimeout(700)
    const info = getTraceProbe(delay.id)!
    expect(info.live).toBe(false)
    expect(info.stoppedReason).toBe('ttl')
    expect(tracePerturbationWarnings()).toEqual([])
    await page.close()
  }, 60000)

  it('records an explicitly unbounded delay as unbounded', async () => {
    const page = await freshPage()
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const delay = await netDelay({ cdp, urlPattern: '/slow.json', ms: 10, ttlMs: 0 })
    const info = getTraceProbe(delay.id)!
    expect(info.expiresAt).toBeNull()
    expect(info.spec.unbounded).toBe(true)
    expect(info.describe).toMatch(/unbounded/)
    await delay.stop()
    await page.close()
  }, 60000)
})

describe('fiberSnapshot({ identity: true }) — handler churn across the process boundary', () => {
  // A fake `__bippy` with the same surface the real one exposes, over a synthetic
  // fiber. That keeps the test off a full React build while still exercising the
  // REAL page-side identity walk (the WeakMap token registry, the projection and
  // the nested-function paths), which is the part a synthetic unit test cannot cover.
  const installFakeReact = async (page: Page) => {
    await page.evaluate(() => {
      const g = globalThis as any
      g.__bippy = {
        getFiberFromHostInstance: (el: any) => el.__testFiber ?? null,
        getSource: async () => ({ fileName: 'src/Row.tsx', lineNumber: 10, columnNumber: 1, functionName: 'Row' }),
        getOwnerStack: async () => [],
        getDisplayName: (t: any) => (t && (t.displayName || t.name)) || null,
        isCompositeFiber: (f: any) => !!f.__composite,
        normalizeFileName: (f: string) => f,
        isSourceFile: () => true,
      }
      // Both handler flavours are built by the SAME factory, so a fresh one is
      // byte-identical to the stable one and only the reference differs — the exact
      // shape of the inline-arrow bug.
      const mkHandler = () => (e: any) => e
      const mkRowRender = () => function render() {}
      g.__stable = mkHandler()
      g.__stableRow = mkRowRender()
      const el = g.document.getElementById('root')
      el.__testFiber = {
        __composite: true,
        type: { displayName: 'Row' },
        return: null,
        memoizedProps: null,
      }
      g.__render = (freshHandlers: boolean) => {
        el.__testFiber.memoizedProps = {
          onClick: freshHandlers ? mkHandler() : g.__stable,
          style: { color: 'red' },
          count: 3,
          rows: [{ id: 1, render: freshHandlers ? mkRowRender() : g.__stableRow }],
        }
      }
      g.__render(false)
    })
  }

  it('reports a rebuilt handler as changed-by-identity, and a stable one as unchanged', async () => {
    const page = await freshPage()
    await installFakeReact(page)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const locator = page.locator('#root')

    const before = await fiberSnapshot({ locator, cdp, identity: true })
    expect(before).toBeTruthy()
    expect(before!.identityCaptured).toBe(true)
    expect(before!.props.count).toEqual({ ref: 0, type: 'primitive', value: 3 })
    expect(before!.props.onClick.type).toBe('function')
    expect(before!.props.onClick.ref).toBeGreaterThan(0)
    expect(before!.fnRefs.map((r) => r.path).sort()).toEqual(['onClick', 'rows[0].render'])

    // Re-render with the SAME handler references: identity is unchanged.
    await page.evaluate(() => (globalThis as any).__render(false))
    const sameRefs = await fiberSnapshot({ locator, cdp, identity: true })
    const noChurn = fiberDiff(before, sameRefs)
    // The handler reference is unchanged; the `style` object and the `rows` array
    // ARE rebuilt every render, which is exactly the memoisation-defeating churn.
    expect(noChurn.identityChangedKeys.sort()).toEqual(['rows', 'style'])
    expect(noChurn.unchangedKeys.sort()).toEqual(['count', 'onClick'])
    // The nested render function kept its reference, so it is not reported.
    expect(noChurn.changes.some((c) => c.key === 'rows[0].render')).toBe(false)

    // Re-render with fresh inline arrows of identical shape: identity churn, and it
    // is now visible — through `[function]` serialisation it never was.
    await page.evaluate(() => (globalThis as any).__render(true))
    const fresh = await fiberSnapshot({ locator, cdp, identity: true })
    const churn = fiberDiff(before, fresh)
    expect(churn.identityChangedKeys).toContain('onClick')
    expect(churn.identityChangedKeys).toContain('rows[0].render')
    expect(churn.changes.find((c) => c.key === 'onClick')?.kind).toBe('changed-by-identity')
    expect(churn.unchangedKeys).toContain('count')
    await page.close()
  }, 60000)

  it('the default (non-identity) snapshot is honest that it cannot see function identity', async () => {
    const page = await freshPage()
    await installFakeReact(page)
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const locator = page.locator('#root')

    const before = await fiberSnapshot({ locator, cdp })
    await page.evaluate(() => (globalThis as any).__render(true))
    const after = await fiberSnapshot({ locator, cdp })
    const d = fiberDiff(before, after)
    // The serialiser already flattened both handlers to '[function]'.
    expect(d.unobservableKeys).toContain('onClick')
    expect(d.changes.find((c) => c.key === 'onClick')?.reason).toMatch(/identity: true/)
    // …and it is NOT claimed as unchanged.
    expect(d.unchangedKeys).not.toContain('onClick')
    await page.close()
  }, 60000)
})

describe('setLogpoint on a live page', () => {
  it('logs the expression without ever pausing, and readLogpoints parses it', async () => {
    const page = await freshPage()
    const rawLogs: string[] = []
    page.on('console', (msg) => rawLogs.push(`[${msg.type()}] ${msg.text()}`))

    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const dbg = new Debugger({ cdp })
    await dbg.enable()

    const scripts = await dbg.listScripts({ search: 'app.js' })
    expect(scripts.length).toBeGreaterThan(0)

    // Line 3 of APP_JS: `  var sum = a + b;` (the leading newline makes line 1 empty).
    const bpId = await dbg.setLogpoint({ file: scripts[0].url, line: 3, expr: 'a + b', tag: 'total' })
    expect(bpId).toBeTruthy()
    expect(dbg.listBreakpoints()[0].nonPausing).toBe(true)

    const value = await page.evaluate(() => (globalThis as any).computeTotal(2, 3))
    // Execution was never suspended: the call returned and the debugger is not paused.
    expect(value).toBe(5)
    expect(dbg.isPaused()).toBe(false)

    await page.waitForTimeout(200)
    const read = await readLogpoints({ getLogs: () => rawLogs, tag: 'total' })
    expect(read.hits.length).toBe(1)
    expect(read.hits[0].value).toBe(5)
    expect(read.hits[0].malformed).toBeUndefined()

    await dbg.deleteBreakpoint({ breakpointId: bpId })
    await page.close()
  }, 60000)

  it('reports a page-side stringify failure as malformed instead of dropping it', async () => {
    const page = await freshPage()
    const rawLogs: string[] = []
    page.on('console', (msg) => rawLogs.push(`[${msg.type()}] ${msg.text()}`))

    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const dbg = new Debugger({ cdp })
    await dbg.enable()
    const scripts = await dbg.listScripts({ search: 'app.js' })

    // A circular value: JSON.stringify throws inside the condition. The condition
    // must still not pause, and the failure must arrive as a diagnosable envelope.
    await dbg.setLogpoint({
      file: scripts[0].url,
      line: 3,
      expr: '(function(){var o={};o.self=o;return o})()',
      tag: 'circ',
    })
    await page.evaluate(() => (globalThis as any).computeTotal(1, 1))
    expect(dbg.isPaused()).toBe(false)
    await page.waitForTimeout(200)

    const read = await readLogpoints({ getLogs: () => rawLogs, tag: 'circ' })
    expect(read.hits.length).toBe(1)
    expect(read.hits[0].malformed?.reason).toMatch(/logpoint failed in the page: JSON.stringify threw/)
    await page.close()
  }, 60000)

  it('caps an oversized payload in the page and says so', async () => {
    const page = await freshPage()
    const rawLogs: string[] = []
    page.on('console', (msg) => rawLogs.push(`[${msg.type()}] ${msg.text()}`))
    const cdp = new PlaywrightCDPSessionAdapter(await context.newCDPSession(page))
    const dbg = new Debugger({ cdp })
    await dbg.enable()
    const scripts = await dbg.listScripts({ search: 'app.js' })

    await dbg.setLogpoint({
      file: scripts[0].url,
      line: 3,
      expr: 'new Array(500).join("x")',
      tag: 'big',
      maxPayload: 100,
    })
    await page.evaluate(() => (globalThis as any).computeTotal(1, 1))
    await page.waitForTimeout(200)

    const read = await readLogpoints({ getLogs: () => rawLogs, tag: 'big', maxLen: 30 })
    expect(read.hits.length).toBe(1)
    expect(read.hits[0].malformed?.reason).toMatch(/capped this payload at \d+ chars/)
    expect(read.hits[0].truncated).toBeTruthy()
    await page.close()
  }, 60000)
})
