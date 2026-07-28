import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildModuleGraph } from './module-graph.js'
import { backwardSlice } from './static-analysis.js'
import { traceValue, readLogpoints, replayPure, fiberDiff } from './trace.js'
import type { TraceDeps } from './trace.js'

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

  it('arms a passive netTimeline probe on an async boundary leaf', async () => {
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
    // Root is a single-caller param salvage with a child hopping into `seed`.
    expect(result.tree.kind).toBe('param-caller')
    const child = result.expand('0.0')
    expect(child).toBeTruthy()
    expect(child!.evaluated?.confident).toBe(true)
    expect(child!.evaluated?.value).toBe(5)
    // Unknown id yields null.
    expect(result.expand('9.9')).toBeNull()
  })

  it('degrades cleanly when no anchor and no start expression are available', async () => {
    const result = await traceValue({})
    expect(result.tree.blockedBy).toBe('dynamic')
    expect(result.render()).toContain('could not determine a start')
  })
})

describe('readLogpoints', () => {
  it('parses tagged JSON lines, filters by tag and caps to 20 hits', async () => {
    const logs: string[] = []
    for (let i = 0; i < 30; i++) logs.push(`[log] [[logpoint:t]] ${i}`)
    logs.push('[log] [[logpoint:other]] "skip"')
    logs.push('[log] a plain unrelated line')

    const hits = await readLogpoints({ getLogs: () => logs, tag: 't' })
    expect(hits.length).toBe(20) // capped
    // Keeps the most-recent hits (10..29) and parses the JSON payload.
    expect(hits[0].value).toBe(10)
    expect(hits[hits.length - 1].value).toBe(29)
    expect(hits.every((h) => h.tag === 't')).toBe(true)
  })

  it('caps oversized values to the per-hit char budget', async () => {
    const big = 'x'.repeat(500)
    const hits = await readLogpoints({ getLogs: () => [`[log] [[logpoint:t]] ${JSON.stringify(big)}`] })
    expect(hits.length).toBe(1)
    expect(String(hits[0].value).length).toBeLessThan(120)
  })
})

describe('replayPure', () => {
  it('runs a pure function with captured args', () => {
    const r = replayPure({ fn: '(a, b) => a + b', args: [2, 3] })
    expect(r.ok).toBe(true)
    expect(r.value).toBe(5)
  })

  it('refuses an impure function that reaches for ambient state', () => {
    const r = replayPure({ fn: '() => window.location.href' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/window/)
    expect(r.freeIdentifiers).toContain('window')
  })

  it('allows whitelisted safe globals', () => {
    const r = replayPure({ fn: '(x) => Math.max(x, JSON.parse("1"))', args: [0] })
    expect(r.ok).toBe(true)
    expect(r.value).toBe(1)
  })
})

describe('fiberDiff', () => {
  it('reports changed/added/removed props between two snapshots', () => {
    const a = { componentName: 'X', source: null, hierarchy: [], props: { a: 1, b: 2 } } as any
    const b = { componentName: 'X', source: null, hierarchy: [], props: { a: 1, b: 3, c: 4 } } as any
    const d = fiberDiff(a, b)
    expect(d.sameComponent).toBe(true)
    expect(d.changedProps).toEqual(['b'])
    expect(d.addedProps).toEqual(['c'])
    expect(d.removedProps).toEqual([])
  })
})

// Type-only touch so unused import is intentional in the suite.
const _depsType: TraceDeps = {}
void _depsType
