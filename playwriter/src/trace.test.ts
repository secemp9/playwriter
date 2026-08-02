import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildModuleGraph } from './module-graph.js'
import { backwardSlice } from './static-analysis.js'
import type { TraceHop } from './static-analysis.js'
import {
  traceValue,
  readLogpoints,
  replayPure,
  replayPureAsync,
  fiberDiff,
  HANDLED_BLOCKED_REASONS,
} from './trace.js'
import type { TraceDeps, FiberIdentitySnapshot } from './trace.js'

// Build a real M3 slice from an inline source string (no browser needed).
function sliceOf(dir: string, filename: string, code: string, startExpr: string) {
  const file = path.join(dir, filename)
  fs.writeFileSync(file, code)
  const graph = buildModuleGraph({ root: dir, files: [file] })
  return backwardSlice({ graph, startFile: file, startExpr })
}

describe('traceValue — blind-spot -> probe arming', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('arms a storeIdentity probe on a mutating-reducer (in-place mutation) leaf', async () => {
    const slice = sliceOf(
      dir,
      'reducer.ts',
      `export function reducer(state, action) {\n` +
        `  state.total = state.total + action.x\n` +
        `  state.items.push(action.y)\n` +
        `  return state\n` +
        `}\n`,
      'state',
    )
    const result = await traceValue({ slice })
    const mutation = result.blocked.find((b) => b.blockedBy === 'mutation')
    expect(mutation).toBeTruthy()
    expect(mutation!.probe?.type).toBe('storeIdentity')
    expect(mutation!.probe?.pausing).toBe(false)
    expect(mutation!.hazards.length).toBeGreaterThan(0)
  })

  it('arms a captureArgs probe on an interprocedural (multi-caller param) leaf', async () => {
    const slice = sliceOf(
      dir,
      'inter.ts',
      `function inner(x) { return x + 1 }\n` +
        `export function a() { return inner(1) }\n` +
        `export function b() { return inner(2) }\n`,
      'x',
    )
    const result = await traceValue({ slice })
    const leaf = result.blocked.find((b) => b.blockedBy === 'interprocedural')
    expect(leaf).toBeTruthy()
    expect(leaf!.probe?.type).toBe('captureArgs')
    // The function name is recovered from the slice note for the probe spec.
    expect(leaf!.probe?.spec.fn).toBe('inner')
  })

  it('arms a passive, race-class netTimeline probe on an async boundary leaf', async () => {
    const slice = sliceOf(
      dir,
      'async.ts',
      `export async function load() {\n` +
        `  const data = await fetch('/x')\n` +
        `  const n = data.length\n` +
        `  return n\n` +
        `}\n`,
      'data',
    )
    const result = await traceValue({ slice })
    const leaf = result.blocked.find((b) => b.blockedBy === 'async')
    expect(leaf).toBeTruthy()
    expect(leaf!.probe?.type).toBe('netTimeline')
    expect(leaf!.probe?.passive).toBe(true)
    expect(leaf!.probe?.raceClass).toBe(true)
    expect(leaf!.probe?.pausing).toBe(false)
  })

  // The static lane owns `BlockedReason` and is growing new variants (hop-budget
  // exhaustion, finer async classes). A new variant must NOT quietly inherit the
  // `dynamic` logpoint probe: that answers a different question and reads like a
  // real result.
  it('refuses to guess a probe for an unhandled blockedBy variant', async () => {
    const slice: TraceHop = {
      kind: 'blocked',
      site: { file: '/tmp/x.ts', line: 3, column: 1 },
      blockedBy: 'hop-budget-exhausted' as any,
      hazards: [],
      evaluated: null,
      note: 'hop budget exhausted',
    }
    const result = await traceValue({ slice })
    const leaf = result.blocked[0]
    expect(leaf.probe?.type).toBe('unknown-blind-spot')
    expect(leaf.probe?.spec.unhandledBlockedBy).toBe('hop-budget-exhausted')
    expect(leaf.probe?.spec.handledReasons).toEqual([...HANDLED_BLOCKED_REASONS])
    // Running it throws instead of returning something plausible.
    await expect(leaf.probe!.run()).rejects.toThrow(/no probe is armed for blockedBy 'hop-budget-exhausted'/)
    // And the trace itself says so.
    expect(result.warnings.join('\n')).toMatch(/hop-budget-exhausted/)
    expect(result.render()).toMatch(/hop-budget-exhausted/)
  })

  // The static lane cuts a slice short for reasons no runtime probe can answer.
  // Those leaves must not get a plausible-looking probe, and must not get a bare
  // `probe: null` either — that reads as "nothing to investigate".
  it.each([
    ['budget-hops', /larger `maxHops`/],
    ['cycle', /narrower `startExpr`/],
    ['parse-error', /failed to PARSE/],
  ])('arms a static-remedy (not a runtime probe) for blockedBy %s', async (reason, remedy) => {
    const slice: TraceHop = {
      kind: 'blocked',
      site: { file: '/tmp/x.ts', line: 1, column: 0 },
      blockedBy: reason as any,
      hazards: [],
      evaluated: null,
    }
    const result = await traceValue({ slice })
    const probe = result.blocked[0].probe!
    expect(probe.type).toBe('static-remedy')
    expect(String(probe.spec.remedy)).toMatch(remedy)
    await expect(probe.run()).rejects.toThrow(/no runtime probe applies/)
    // A handled variant is not an "unhandled variant" warning.
    expect(result.warnings).toEqual([])
  })

  it('still arms the logpoint probe for the real `dynamic` variant', async () => {
    const slice: TraceHop = {
      kind: 'blocked',
      site: { file: '/tmp/x.ts', line: 3, column: 1 },
      blockedBy: 'dynamic',
      hazards: [],
      evaluated: null,
      note: 'dynamic',
    }
    const result = await traceValue({ slice })
    expect(result.blocked[0].probe?.type).toBe('logpoint')
    expect(result.warnings).toEqual([])
  })
})

describe('traceValue — render + expand', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-r-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('collapses a confident branch to a single `= value` line and stays <=60 lines', async () => {
    const slice = sliceOf(dir, 'const.ts', `const D = 0.2\nexport function f() { return D }\n`, 'D')
    const result = await traceValue({ slice })
    const rendered = result.render()
    const lines = rendered.split('\n')
    expect(lines.length).toBeLessThanOrEqual(60)
    // Confident constant collapses to a one-liner ending in `= 0.2`.
    expect(rendered).toMatch(/= 0\.2/)
    // No children/code-frame lines for a collapsed confident branch.
    expect(lines.length).toBe(1)
  })

  it('render is a method and takes options (maxLines, codeFrames)', async () => {
    const slice = sliceOf(
      dir,
      'reducer.ts',
      `export function reducer(state, action) {\n` +
        `  state.total = state.total + action.x\n` +
        `  return state\n` +
        `}\n`,
      'state',
    )
    const result = await traceValue({ slice })
    expect(typeof result.render).toBe('function')
    expect(result.render().split('\n').length).toBeGreaterThan(2)
    const tight = result.render({ maxLines: 2 })
    expect(tight.split('\n').length).toBeLessThanOrEqual(2)
    expect(tight).toMatch(/more lines collapsed/)
    expect(result.render({ codeFrames: false })).not.toMatch(/^\s+\| /m)
  })

  it('expand({ depth: 2 }) returns a real two-level subtree in ONE call', async () => {
    const slice = sliceOf(
      dir,
      'salvage2.ts',
      `const seed = 5\n` +
        `function inner(x) { return x + 1 }\n` +
        `function mid(y) { return inner(y + 0) }\n` +
        `export function a() { return mid(seed) }\n`,
      'x',
    )
    const result = await traceValue({ slice })

    // Default is bounded: one level of children, and it SAYS what it cut.
    const shallow = result.expand('0')!
    expect(shallow.id).toBe('0')
    expect(shallow.children.length).toBe(1)
    expect(shallow.children[0].children.length).toBe(0)
    expect(shallow.children[0].omittedChildren).toBeGreaterThan(0)
    expect(shallow.children[0].complete).toBe(false)

    // depth: 2 brings the grandchild back in one round-trip.
    const deep = result.expand('0', { depth: 2 })!
    expect(deep.children[0].children.length).toBe(1)
    const grandchild = deep.children[0].children[0]
    expect(grandchild.id).toBe('0.0.0')
    expect(grandchild.evaluated?.confident).toBe(true)
    expect(grandchild.evaluated?.value).toBe(5)
    expect(deep.complete).toBe(true)

    // depth: 0 is the hop alone, and says how many children it left behind.
    const bare = result.expand('0', { depth: 0 })!
    expect(bare.children).toEqual([])
    expect(bare.omittedChildren).toBe(1)

    expect(result.expand('9.9')).toBeNull()
    expect(result.hopIds).toContain('0.0.0')
  })

  it('expand(hopId) drills into a child hop of the lossless tree', async () => {
    const slice = sliceOf(
      dir,
      'salvage.ts',
      `const seed = 5\n` +
        `function inner(x) { return x + 1 }\n` +
        `export function a() { return inner(seed) }\n`,
      'x',
    )
    const result = await traceValue({ slice })
    expect(result.tree.kind).toBe('param-caller')
    const child = result.expand('0.0')
    expect(child).toBeTruthy()
    expect(child!.evaluated?.confident).toBe(true)
    expect(child!.evaluated?.value).toBe(5)
    expect(result.expand('9.9')).toBeNull()
  })

  it('degrades cleanly when no anchor and no start expression are available', async () => {
    const result = await traceValue({})
    expect(result.tree.blockedBy).toBe('dynamic')
    expect(result.render()).toContain('could not determine a start')
  })
})

describe('readLogpoints', () => {
  it('reports the TRUE hit count next to the returned window', async () => {
    const logs: string[] = []
    for (let i = 0; i < 30; i++) logs.push(`[log] [[logpoint:t]] ${i}`)
    logs.push('[log] [[logpoint:other]] "skip"')
    logs.push('[log] a plain unrelated line')

    const read = await readLogpoints({ getLogs: () => logs, tag: 't' })
    expect(read.hits.length).toBe(20)
    // The drop is VISIBLE: 30 matched, 20 returned, 10 dropped.
    expect(read.totalHits).toBe(30)
    expect(read.droppedHits).toBe(10)
    expect(read.caps).toEqual({ maxHits: 20, maxLen: 50 })
    expect(read.linesScanned).toBe(32)
    expect(read.cursor).toBe(32)
    // Keeps the most-recent hits (10..29) and parses the JSON payload.
    expect(read.hits[0].value).toBe(10)
    expect(read.hits[read.hits.length - 1].value).toBe(29)
    expect(read.hits.every((h) => h.tag === 't')).toBe(true)
    // Nothing was cut, so no hit carries a truncation marker.
    expect(read.hits.every((h) => h.truncated === undefined)).toBe(true)
  })

  it('marks a capped value as truncated and states both lengths', async () => {
    const big = 'x'.repeat(500)
    const read = await readLogpoints({ getLogs: () => [`[log] [[logpoint:t]] ${JSON.stringify(big)}`] })
    expect(read.hits.length).toBe(1)
    const hit = read.hits[0]
    expect(String(hit.value).length).toBeLessThan(120)
    expect(hit.truncated).toEqual({ originalLength: 500, keptLength: 50 })
    expect(read.totalHits).toBe(1)
    expect(read.droppedHits).toBe(0)
  })

  it('honours configurable caps while still reporting them', async () => {
    const logs = ['[log] [[logpoint:t]] "abcdefghij"', '[log] [[logpoint:t]] 2', '[log] [[logpoint:t]] 3']
    const read = await readLogpoints({ getLogs: () => logs, maxHits: 2, maxLen: 4 })
    expect(read.hits.length).toBe(2)
    expect(read.totalHits).toBe(3)
    expect(read.droppedHits).toBe(1)
    expect(read.caps).toEqual({ maxHits: 2, maxLen: 4 })
  })

  it('diagnoses the payloads the page could not serialise instead of dropping them', async () => {
    const read = await readLogpoints({
      getLogs: () => [
        '[log] [[logpoint:t]] undefined',
        '[log] [[logpoint:t]] {"__playwriter_logpoint_error":"JSON.stringify threw: Converting circular structure to JSON"}',
        '[log] [[logpoint:t]] {"__playwriter_logpoint_truncated":9000,"head":"{\\"a\\":1"}',
        '[log] [[logpoint:t]] {"a":1,"b":',
      ],
    })
    expect(read.hits.length).toBe(4)
    expect(read.malformedHits).toBe(4)
    expect(read.hits[0].malformed?.reason).toMatch(/bare word `undefined`/)
    expect(read.hits[1].malformed?.reason).toMatch(/circular structure/)
    expect(read.hits[2].malformed?.reason).toMatch(/capped this payload at 9000/)
    expect(read.hits[3].malformed?.reason).toMatch(/cut by the log pipeline/)
    // The raw text is always kept so the failure is diagnosable.
    expect(read.hits[3].malformed?.raw).toContain('{"a":1,"b":')
  })

  it('records a marker line whose tag cannot be read', async () => {
    const read = await readLogpoints({ getLogs: () => ['[log] [[logpoint: broken]] 1'] })
    expect(read.hits).toEqual([])
    expect(read.unparsableLines.length).toBe(1)
  })

  it('sinceCursor skips already-read lines and returns the next cursor', async () => {
    const logs = ['[log] [[logpoint:t]] 1', '[log] [[logpoint:t]] 2']
    const first = await readLogpoints({ getLogs: () => logs })
    expect(first.cursor).toBe(2)
    logs.push('[log] [[logpoint:t]] 3')
    const second = await readLogpoints({ getLogs: () => logs, sinceCursor: first.cursor })
    expect(second.hits.map((h) => h.value)).toEqual([3])
    expect(second.linesScanned).toBe(1)
    expect(second.hits[0].lineIndex).toBe(2)
  })
})

describe('replayPure', () => {
  it('runs a pure function with captured args', () => {
    const r = replayPure({ fn: '(a, b) => a + b', args: [2, 3] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe(5)
      expect(r.logs).toEqual([])
      expect(r.evaluatedIn).toBe('node-executor-process')
      expect(r.note).toMatch(/NODE EXECUTOR PROCESS/)
    }
  })

  it('replays a function that logs, returning the captured console calls', () => {
    const r = replayPure({
      fn: '(items) => { console.log("count", items.length); console.warn("hm"); return items.length }',
      args: [[1, 2, 3]],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value).toBe(3)
    expect(r.logs.map((l) => l.level)).toEqual(['log', 'warn'])
    expect(r.logs[0].args).toEqual(['count', 3])
    expect(r.logsCapped).toBe(false)
    expect(r.allowed).toContain('console')
  })

  it('caps captured logs visibly', () => {
    const r = replayPure({
      fn: '() => { for (let i = 0; i < 10; i++) console.log(i); return "done" }',
      maxLogs: 3,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.logs.length).toBe(3)
    expect(r.logsDropped).toBe(7)
    expect(r.logsCapped).toBe(true)
  })

  it('refuses a function that touches the network, with position and category', () => {
    const r = replayPure({ fn: '(u) => fetch(u).then(r => r.json())' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe('purity')
    expect(r.freeIdentifiers).toContain('fetch')
    const fetchOffender = r.offending.find((o) => o.name === 'fetch')!
    expect(fetchOffender.line).toBe(1)
    expect(fetchOffender.column).toBeGreaterThan(0)
    expect(fetchOffender.category).toBe('network')
    expect(fetchOffender.admissible).toBe(false)
    expect(r.categoricallyUnsafe).toContain('fetch')
    expect(r.reason).toMatch(/CATEGORICALLY UNSAFE/)
  })

  it('splits offenders into admissible (closure/import) and categorically unsafe', () => {
    const r = replayPure({ fn: '(x) => x * TAX_RATE + window.innerWidth' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.admissible).toContain('TAX_RATE')
    expect(r.categoricallyUnsafe).toContain('window')
    expect(r.reason).toMatch(/bindings: \{ TAX_RATE/)
  })

  it('admits a closure capture through `bindings` and injects its value', () => {
    const r = replayPure({ fn: '(x) => x * TAX_RATE', args: [10], bindings: { TAX_RATE: 0.2 } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBeCloseTo(2)
      expect(r.allowed).toContain('TAX_RATE')
    }
  })

  it('refuses `allow` entries that this process cannot honour', () => {
    const r = replayPure({ fn: '() => fetch("/x")', allow: ['fetch'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/cannot admit fetch/)
    expect(r.categoricallyUnsafe).toContain('fetch')
  })

  it('rejects a statement (not an expression) with a clear reason', () => {
    const r = replayPure({ fn: 'const total = items.reduce((a, b) => a + b, 0)' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe('parse')
    expect(r.reason).toMatch(/function EXPRESSION/)
  })

  it('rejects a non-function expression', () => {
    const r = replayPure({ fn: '{ a: 1 }' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.stage).toBe('parse')
  })

  it('does not pretend to have a value when the function returned a Promise', () => {
    const r = replayPure({ fn: 'async (x) => x + 1', args: [1] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/replayPureAsync/)
  })

  it('replayPureAsync awaits the result and keeps the logs', async () => {
    const r = await replayPureAsync({ fn: 'async (x) => { console.log("in", x); return x + 1 }', args: [1] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe(2)
      expect(r.logs[0].args).toEqual(['in', 1])
    }
  })

  it('allows whitelisted safe globals', () => {
    const r = replayPure({ fn: '(x) => Math.max(x, JSON.parse("1"))', args: [0] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(1)
  })

  it('reports a throwing replay as an execution failure, with the logs so far', () => {
    const r = replayPure({ fn: '() => { console.log("before"); throw new Error("boom") }' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe('execution')
    expect(r.reason).toMatch(/boom/)
    expect(r.logs?.[0].args).toEqual(['before'])
  })
})

describe('fiberDiff', () => {
  const snap = (props: unknown, componentName = 'X') => ({ componentName, source: null, hierarchy: [], props }) as any

  it('reports nothing changed for identical props', () => {
    const props = { a: 1, b: 'x' }
    const d = fiberDiff(snap(props), snap({ ...props }))
    expect(d.changes).toEqual([])
    expect(d.unchangedKeys.sort()).toEqual(['a', 'b'])
    expect(d.changedProps).toEqual([])
    expect(d.identityChangedKeys).toEqual([])
  })

  it('reports a new inline arrow with an identical body as changed-by-IDENTITY', () => {
    const before = snap({ onClick: () => 1, label: 'go' })
    const after = snap({ onClick: () => 1, label: 'go' })
    const d = fiberDiff(before, after)
    expect(d.identityChangedKeys).toEqual(['onClick'])
    const change = d.changes.find((c) => c.key === 'onClick')!
    expect(change.kind).toBe('changed-by-identity')
    expect(change.fn?.name).toBe('onClick')
    expect(change.fn?.sameSource).toBe(true)
    // Still surfaced in the legacy convenience array.
    expect(d.changedProps).toEqual(['onClick'])
    expect(d.unchangedKeys).toEqual(['label'])
  })

  it('distinguishes a changed function body from identity churn', () => {
    const d = fiberDiff(snap({ onClick: () => 1 }), snap({ onClick: () => 2 }))
    expect(d.changes[0].kind).toBe('changed-by-value')
    expect(d.changes[0].fn?.sameSource).toBe(false)
  })

  it('reports a changed primitive as changed-by-VALUE', () => {
    const d = fiberDiff(snap({ a: 1, b: 2 }), snap({ a: 1, b: 3 }))
    expect(d.changes.map((c) => [c.key, c.kind])).toEqual([['b', 'changed-by-value']])
    expect(d.changes[0].before).toBe('2')
    expect(d.changes[0].after).toBe('3')
  })

  it('reports added and removed props', () => {
    const d = fiberDiff(snap({ a: 1, gone: true }), snap({ a: 1, fresh: 2 }))
    expect(d.addedProps).toEqual(['fresh'])
    expect(d.removedProps).toEqual(['gone'])
    expect(d.sameComponent).toBe(true)
  })

  it('separates `undefined` from missing', () => {
    const withUndef = fiberDiff(snap({ a: undefined }), snap({}))
    expect(withUndef.removedProps).toEqual(['a'])
    const stillUndef = fiberDiff(snap({ a: undefined }), snap({ a: undefined }))
    expect(stillUndef.changes).toEqual([])
  })

  it('handles a deep-equal object literal rebuilt every render', () => {
    const d = fiberDiff(snap({ style: { color: 'red' } }), snap({ style: { color: 'red' } }))
    expect(d.identityChangedKeys).toEqual(['style'])
  })

  it('compares Date / Map / Set / NaN / class instances structurally', () => {
    class Point {
      constructor(public x: number) {}
    }
    const d = fiberDiff(
      snap({
        when: new Date(5),
        m: new Map([['a', 1]]),
        s: new Set([1]),
        n: NaN,
        p: new Point(1),
      }),
      snap({
        when: new Date(5),
        m: new Map([['a', 1]]),
        s: new Set([1]),
        n: NaN,
        p: new Point(1),
      }),
    )
    // All deep-equal but rebuilt: identity churn, NOT "unchanged" and NOT "value".
    expect(d.identityChangedKeys.sort()).toEqual(['m', 'p', 's', 'when'])
    // NaN compares equal to NaN (Object.is), so it is genuinely unchanged.
    expect(d.unchangedKeys).toEqual(['n'])

    const changed = fiberDiff(snap({ when: new Date(5) }), snap({ when: new Date(6) }))
    expect(changed.changes[0].kind).toBe('changed-by-value')

    const otherClass = fiberDiff(snap({ p: new Point(1) }), snap({ p: { x: 1 } }))
    expect(otherClass.changes[0].kind).toBe('changed-by-value')
  })

  it('does not throw on a cyclic props object', () => {
    const a: any = { n: 1 }
    a.self = a
    const b: any = { n: 1 }
    b.self = b
    expect(() => fiberDiff(snap(a), snap(b))).not.toThrow()
    const d = fiberDiff(snap(a), snap(b))
    expect(d.identityChangedKeys).toEqual(['self'])
    expect(d.unchangedKeys).toEqual(['n'])

    const c: any = { n: 2 }
    c.self = c
    const changed = fiberDiff(snap(a), snap(c))
    expect(changed.changes.map((x) => x.key).sort()).toEqual(['n', 'self'])
  })

  it('reports serialised `[function]` placeholders as UNOBSERVABLE, never unchanged', () => {
    // This is what a default (non-identity) fiberSnapshot actually yields: the page
    // serialiser has already replaced every function with the string `[function]`.
    const d = fiberDiff(snap({ onClick: '[function]', a: 1 }), snap({ onClick: '[function]', a: 1 }))
    expect(d.unobservableKeys).toEqual(['onClick'])
    expect(d.unchangedKeys).toEqual(['a'])
    const change = d.changes.find((c) => c.key === 'onClick')!
    expect(change.kind).toBe('unobservable')
    expect(change.reason).toMatch(/identity: true/)
  })

  it('reports truncation / depth markers as unobservable too', () => {
    const long = 'y'.repeat(300) + '…[truncated]'
    const d = fiberDiff(snap({ text: long, deep: '[max-depth]' }), snap({ text: long, deep: '[max-depth]' }))
    expect(d.unobservableKeys.sort()).toEqual(['deep', 'text'])
  })

  it('caps its own output and says how many changes it dropped', () => {
    const before: Record<string, number> = {}
    const after: Record<string, number> = {}
    for (let i = 0; i < 30; i++) {
      before[`k${i}`] = i
      after[`k${i}`] = i + 1
    }
    const d = fiberDiff(snap(before), snap(after), { maxChanges: 5 })
    expect(d.changes.length).toBe(5)
    expect(d.caps.changesOmitted).toBe(25)
    expect(d.caps.notes.join(' ')).toMatch(/omitted by the 5-change output cap/)
  })

  it('marks a comparison that hit the depth cap as unobservable', () => {
    const deep = (n: number): any => (n === 0 ? { leaf: 1 } : { nest: deep(n - 1) })
    const d = fiberDiff(snap({ tree: deep(12) }), snap({ tree: deep(12) }), { maxDepth: 3 })
    expect(d.unobservableKeys).toEqual(['tree'])
    expect(d.caps.hitCap).toBe(true)
  })

  it('uses page-side identity tokens when both sides are identity snapshots', () => {
    const mk = (onClickRef: number, rowsRef: number, rowFnRef: number): FiberIdentitySnapshot => ({
      identityCaptured: true,
      componentName: 'Row',
      source: null,
      hierarchy: [],
      props: {
        onClick: { ref: onClickRef, type: 'function', value: '[fn onClick/1]', fnName: 'onClick', arity: 1, fnSource: '(e) => go(e)' },
        rows: { ref: rowsRef, type: 'array', value: [{ id: 1, render: '[fn render/0]' }] },
        count: { ref: 0, type: 'primitive', value: 3 },
      },
      fnRefs: [
        { path: 'onClick', ref: onClickRef, name: 'onClick', arity: 1 },
        { path: 'rows[0].render', ref: rowFnRef, name: 'render', arity: 0 },
      ],
      caps: { maxKeys: 60, maxDepth: 3, keysOmitted: 0, fnRefsOmitted: 0 },
      note: '',
    })

    const same = fiberDiff(mk(1, 2, 3), mk(1, 2, 3))
    expect(same.changes).toEqual([])
    expect(same.unchangedKeys.sort()).toEqual(['count', 'onClick', 'rows'])

    const churned = fiberDiff(mk(1, 2, 3), mk(9, 8, 7))
    expect(churned.identityChangedKeys.sort()).toEqual(['onClick', 'rows', 'rows[0].render'])
    expect(churned.changes.find((c) => c.key === 'rows[0].render')?.valueType).toBe('function')
  })
})

describe('opaque markers vs identity projections', () => {
  const snap = (props: unknown) => ({ componentName: 'X', source: null, hierarchy: [], props }) as any

  // `debugger.ts`'s readRemoteObject emits `[function name]`, `[object Object]`,
  // `[array Array(3)]`, `[map Map(2)]`, `[accessor]`, `[symbol …]` for values whose
  // CONTENT the browser never sent. Equal markers must never read as equal values —
  // otherwise a locals view fed to fiberDiff produces phantom "unchanged" props.
  it.each([
    ['[function helperFn]'],
    ['[function]'],
    ['[accessor]'],
    ['[object Object]'],
    ['[array Array(3)]'],
    ['[map Map(2)]'],
    ['[symbol Symbol(tag)]'],
  ])('treats %s as unobservable on both sides', (m) => {
    const d = fiberDiff(snap({ v: m }), snap({ v: m }))
    expect(d.unobservableKeys).toEqual(['v'])
    expect(d.unchangedKeys).toEqual([])
  })

  // Markers whose description IS the value stay comparable.
  it.each([
    ['[date Thu Jan 01 1970 00:00:00 GMT+0000]'],
    ['[bigint 9007199254740993n]'],
    ['[regexp /ab+/gi]'],
  ])('keeps %s comparable', (m) => {
    expect(fiberDiff(snap({ v: m }), snap({ v: m })).unchangedKeys).toEqual(['v'])
    expect(fiberDiff(snap({ v: m }), snap({ v: '[date other]' })).changedProps).toEqual(['v'])
  })

  // The identity projection uses `[fn …]` precisely so it does NOT collide with the
  // opaque `[function …]` family: its content IS captured (paired with a ref token).
  it('keeps the `[fn name/arity]` identity projection comparable', () => {
    const d = fiberDiff(snap({ v: '[fn render/0]' }), snap({ v: '[fn render/0]' }))
    expect(d.unchangedKeys).toEqual(['v'])
    expect(d.unobservableKeys).toEqual([])
  })
})

// Type-only touch so unused import is intentional in the suite.
const _depsType: TraceDeps = {}
void _depsType
