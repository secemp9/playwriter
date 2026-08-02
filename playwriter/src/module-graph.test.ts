import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildModuleGraph } from './module-graph.js'
import { makeSourceMapResolver, renderCodeFrame } from './source-provenance.js'
import { TraceMap } from '@jridgewell/trace-mapping'

describe('buildModuleGraph', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-graph-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('indexes named, default and function exports', () => {
    const a = path.join(dir, 'a.ts')
    fs.writeFileSync(
      a,
      `export const D = 0.2\n` +
        `export function helper() { return 1 }\n` +
        `const secret = 5\n` +
        `export default secret\n` +
        `export { secret as aliased }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [a] })
    const exports = graph.exportsByFile.get(a)!
    expect(exports.has('D')).toBe(true)
    expect(exports.has('helper')).toBe(true)
    expect(exports.has('default')).toBe(true)
    expect(exports.has('aliased')).toBe(true)
    expect(exports.get('D')!.loc).toBeTruthy()
  })

  it('records re-exports as markers without flattening', () => {
    const a = path.join(dir, 'a.ts')
    const idx = path.join(dir, 'index.ts')
    fs.writeFileSync(a, `export const D = 0.2\n`)
    fs.writeFileSync(idx, `export { D } from './a'\nexport * from './a'\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, idx] })
    const exports = graph.exportsByFile.get(idx)!
    expect(exports.get('D')!.reexport).toEqual({ source: './a', imported: 'D' })
    expect(exports.has('*')).toBe(true)
  })

  it('resolves relative specifiers with extension resolution', () => {
    const a = path.join(dir, 'a.ts')
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(a, `export const D = 1\n`)
    fs.writeFileSync(b, `import { D } from './a'\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, b] })
    const resolved = graph.resolve(b, './a')
    expect(resolved).toEqual({ file: a })
  })

  it('resolves through index files', () => {
    const sub = path.join(dir, 'sub')
    fs.mkdirSync(sub)
    const idx = path.join(sub, 'index.ts')
    fs.writeFileSync(idx, `export const x = 1\n`)
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(b, `import { x } from './sub'\n`)
    const graph = buildModuleGraph({ root: dir, files: [idx, b] })
    expect(graph.resolve(b, './sub')).toEqual({ file: idx })
  })

  it('resolves tsconfig paths aliases', () => {
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } } }),
    )
    const libDir = path.join(dir, 'src', 'lib')
    fs.mkdirSync(libDir, { recursive: true })
    const util = path.join(libDir, 'util.ts')
    fs.writeFileSync(util, `export const u = 1\n`)
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(b, `import { u } from '@lib/util'\n`)
    const graph = buildModuleGraph({ root: dir, files: [util, b] })
    expect(graph.resolve(b, '@lib/util')).toEqual({ file: util })
  })

  it('blackboxes bare node_modules specifiers, and says WHY it blackboxed', () => {
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(b, `import react from 'react'\nimport gone from './nope'\n`)
    const graph = buildModuleGraph({ root: dir, files: [b] })
    // A real dependency and a broken relative path are both unparseable, but
    // they are completely different diagnoses for the agent.
    expect(graph.resolve(b, 'react')).toEqual({
      blackbox: true,
      reason: 'bare-specifier',
      specifier: 'react',
    })
    expect(graph.resolve(b, './nope')).toEqual({
      blackbox: true,
      reason: 'unresolved-path',
      specifier: './nope',
    })
  })

  it('collects call sites keyed by callee name', () => {
    const f = path.join(dir, 'f.ts')
    fs.writeFileSync(f, `function foo(a) { return a }\nfoo(1)\nfoo(2)\n`)
    const graph = buildModuleGraph({ root: dir, files: [f] })
    expect(graph.callSites.get('foo')!.length).toBe(2)
  })

  it('walks a directory tree while ignoring node_modules', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), `export const a = 1\n`)
    const nm = path.join(dir, 'node_modules', 'pkg')
    fs.mkdirSync(nm, { recursive: true })
    fs.writeFileSync(path.join(nm, 'index.js'), `export const b = 2\n`)
    const graph = buildModuleGraph({ root: dir })
    expect(graph.files.some((f) => f.endsWith('a.ts'))).toBe(true)
    expect(graph.files.some((f) => f.includes('node_modules'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Defect 1 — callee identity. The bare-name index collapsed same-named functions
// across files, which inflated caller counts and made one-caller functions look
// ambiguous. These tests pin the resolved index against the name-only one.
// ---------------------------------------------------------------------------

describe('call-site index keys on resolved callee identity', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-callee-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const fnNode = (graph: ReturnType<typeof buildModuleGraph>, file: string, name: string) =>
    graph.exportsByFile.get(file)!.get(name)!.node

  it('does NOT collapse two files that each define format() with one caller each', () => {
    const a = path.join(dir, 'a.ts')
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(a, `export function format(v) { return 'a' + v }\nexport function useA() { return format(1) }\n`)
    fs.writeFileSync(b, `export function format(v) { return 'b' + v }\nexport function useB() { return format(2) }\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, b] })

    // The bare-name bucket still collides — that is exactly the old key, and it
    // is why a one-caller function used to report two callers.
    expect(graph.callSites.get('format')!.length).toBe(2)

    // The identity-keyed index separates them.
    const callersA = graph.callersOfFunction(fnNode(graph, a, 'format'), a)
    const callersB = graph.callersOfFunction(fnNode(graph, b, 'format'), b)
    expect(callersA.length).toBe(1)
    expect(callersB.length).toBe(1)
    expect(callersA[0].file).toBe(a)
    expect(callersB[0].file).toBe(b)
    // …and the two buckets are genuinely distinct keys.
    expect(graph.callSitesByTarget.size).toBe(2)
  })

  it('resolves default, aliased, namespace and re-exported callees to one identity', () => {
    const lib = path.join(dir, 'lib.ts')
    const idx = path.join(dir, 'idx.ts')
    const app = path.join(dir, 'app.ts')
    fs.writeFileSync(
      lib,
      `export function target(v) { return v }\nexport default function dflt(v) { return v }\n`,
    )
    fs.writeFileSync(idx, `export { target as renamed } from './lib'\n`)
    fs.writeFileSync(
      app,
      `import dflt from './lib'\n` +
        `import { renamed } from './idx'\n` +
        `import * as ns from './lib'\n` +
        `const local = renamed\n` +
        `export function run() { return [dflt(1), renamed(2), ns.target(3), local(4)] }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [lib, idx, app] })

    // renamed() (through a rename re-export), ns.target() (namespace member) and
    // local() (a local alias of the import) are all the SAME definition.
    const callers = graph.callersOfFunction(fnNode(graph, lib, 'target'), lib)
    expect(callers.length).toBe(3)
    expect(callers.map((c) => c.name).sort()).toEqual(['local', 'ns.target', 'renamed'])
    expect(new Set(callers.map((c) => (c.callee as any).declKey)).size).toBe(1)

    // The default export is a different identity.
    expect(graph.callersOfFunction(fnNode(graph, lib, 'default'), lib).length).toBe(1)
  })

  it('reports genuinely unresolvable callees in their own bucket, with a reason', () => {
    const f = path.join(dir, 'dyn.ts')
    fs.writeFileSync(
      f,
      `const table = {}\n` +
        `export function run(cb, key) {\n` +
        `  cb(1)\n` +
        `  table[key](2)\n` +
        `  fetch('/x')\n` +
        `  ;(cb || fetch)(3)\n` +
        `}\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const reasons = graph.unresolvedCallSites.map((s) => (s.callee as any).reason)
    expect(reasons).toContain('callback-param') // cb(1)
    expect(reasons).toContain('computed-member') // table[key](2)
    expect(reasons).toContain('no-binding') // fetch('/x')
    expect(reasons).toContain('dynamic-value') // (cb || fetch)(3)
    // None of them polluted a named target bucket.
    expect(graph.callSitesByTarget.size).toBe(0)
    expect(graph.summary().unresolvedByReason['callback-param']).toBe(1)
  })

  it('resolves a callee declared as a const arrow and through a local alias', () => {
    const f = path.join(dir, 'arrow.ts')
    fs.writeFileSync(
      f,
      `const impl = (v) => v * 2\nconst alias = impl\nexport function run() { return [impl(1), alias(2)] }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    expect(graph.callSitesByTarget.size).toBe(1)
    expect([...graph.callSitesByTarget.values()][0].length).toBe(2)
  })

  it('marks a callee whose defining file failed to parse as parse-error, not not-found', () => {
    const bad = path.join(dir, 'bad.ts')
    const app = path.join(dir, 'app.ts')
    fs.writeFileSync(bad, `export function helper(a) {\n  return {\n`)
    fs.writeFileSync(app, `import { helper } from './bad'\nexport function run() { return helper(1) }\n`)
    const graph = buildModuleGraph({ root: dir, files: [bad, app] })
    const site = graph.unresolvedCallSites.find((s) => s.name === 'helper')!
    expect(site).toBeTruthy()
    expect((site.callee as any).reason).toBe('parse-error')
    expect((site.callee as any).detail).toContain('bad.ts')
  })
})

// ---------------------------------------------------------------------------
// Defect 4 — re-export chains were recorded then abandoned.
// ---------------------------------------------------------------------------

describe('resolveExport follows re-export chains', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-reexport-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('follows a 3-link chain with a rename in the middle to the definition', () => {
    const c = path.join(dir, 'c.ts')
    const b = path.join(dir, 'b.ts')
    const a = path.join(dir, 'a.ts')
    fs.writeFileSync(c, `export const VALUE = 41\n`)
    fs.writeFileSync(b, `export { VALUE as MIDDLE } from './c'\n`)
    fs.writeFileSync(a, `export { MIDDLE } from './b'\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, b, c] })

    // The old behaviour: the marker is recorded but points nowhere.
    expect(graph.exportsByFile.get(a)!.get('MIDDLE')!.node).toBe(null)

    const res = graph.resolveExport(a, 'MIDDLE')
    expect(res.kind).toBe('found')
    if (res.kind !== 'found') return
    expect(res.file).toBe(c)
    expect(res.name).toBe('VALUE')
    expect(res.chain.map((s) => s.source)).toEqual(['./b', './c'])
    expect(res.entry.node).toBeTruthy()
  })

  it('resolves a name supplied by a single `export * from`', () => {
    const x = path.join(dir, 'x.ts')
    const idx = path.join(dir, 'index.ts')
    fs.writeFileSync(x, `export const only = 7\nexport default 'ignored'\n`)
    fs.writeFileSync(idx, `export * from './x'\n`)
    const graph = buildModuleGraph({ root: dir, files: [x, idx] })
    const res = graph.resolveExport(idx, 'only')
    expect(res.kind).toBe('found')
    if (res.kind === 'found') expect(res.file).toBe(x)
    // `export *` never forwards `default`, per the module spec.
    expect(graph.resolveExport(idx, 'default').kind).toBe('not-found')
  })

  it('reports an `export *` collision as AMBIGUOUS instead of picking a winner', () => {
    const x = path.join(dir, 'x.ts')
    const y = path.join(dir, 'y.ts')
    const idx = path.join(dir, 'index.ts')
    fs.writeFileSync(x, `export const dup = 1\n`)
    fs.writeFileSync(y, `export const dup = 2\n`)
    fs.writeFileSync(idx, `export * from './x'\nexport * from './y'\n`)
    const graph = buildModuleGraph({ root: dir, files: [x, y, idx] })

    // Both star links are retained: a single '*' map key could not hold two.
    expect(graph.starExportsByFile.get(idx)!.map((s) => s.source)).toEqual(['./x', './y'])

    const res = graph.resolveExport(idx, 'dup')
    expect(res.kind).toBe('ambiguous')
    if (res.kind !== 'ambiguous') return
    expect(res.candidates.map((c) => c.file).sort()).toEqual([x, y].sort())
  })

  it('resolves `export * as ns from` to a namespace', () => {
    const x = path.join(dir, 'x.ts')
    const idx = path.join(dir, 'index.ts')
    fs.writeFileSync(x, `export const k = 1\n`)
    fs.writeFileSync(idx, `export * as space from './x'\n`)
    const graph = buildModuleGraph({ root: dir, files: [x, idx] })
    const res = graph.resolveExport(idx, 'space')
    expect(res.kind).toBe('namespace')
    if (res.kind === 'namespace') expect(res.file).toBe(x)
  })

  it('breaks a cyclic re-export instead of recursing forever', () => {
    const a = path.join(dir, 'a.ts')
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(a, `export { z } from './b'\n`)
    fs.writeFileSync(b, `export { z } from './a'\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, b] })
    const res = graph.resolveExport(a, 'z')
    expect(res.kind).toBe('cycle')
  })

  it('reports a chain that leaves the project as external, naming the specifier', () => {
    const a = path.join(dir, 'a.ts')
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(a, `export { thing } from './b'\n`)
    fs.writeFileSync(b, `export { thing } from 'some-pkg'\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, b] })
    const res = graph.resolveExport(a, 'thing')
    expect(res.kind).toBe('external')
    if (res.kind === 'external') {
      expect(res.specifier).toBe('some-pkg')
      expect(res.fromFile).toBe(b)
    }
  })

  it('parses and indexes a file reached only through resolution', () => {
    const lib = path.join(dir, 'lib.ts')
    const app = path.join(dir, 'app.ts')
    fs.writeFileSync(lib, `export const late = 9\n`)
    fs.writeFileSync(app, `import { late } from './lib'\nexport const use = late\n`)
    // `lib` is deliberately NOT in the file list.
    const graph = buildModuleGraph({ root: dir, files: [app] })
    expect(graph.exportsByFile.has(lib)).toBe(false)
    const res = graph.resolveExport(lib, 'late')
    expect(res.kind).toBe('found')
    expect(graph.exportsByFile.has(lib)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Defect 5 — files that failed to parse used to vanish without a trace.
// ---------------------------------------------------------------------------

describe('parse failures are recorded, not swallowed', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-parse-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('records the file, message and position of a syntax error', () => {
    const bad = path.join(dir, 'bad.ts')
    const good = path.join(dir, 'good.ts')
    fs.writeFileSync(bad, `export const cfg = {\n  a: 1,\n`)
    fs.writeFileSync(good, `export const ok = 1\n`)
    const graph = buildModuleGraph({ root: dir, files: [bad, good] })

    // The index survived the bad file …
    expect(graph.exportsByFile.get(good)!.has('ok')).toBe(true)
    // … and it remembers WHY the bad one is missing.
    const failure = graph.parseFailures.get(bad)!
    expect(failure).toBeTruthy()
    expect(failure.severity).toBe('fatal')
    expect(failure.file).toBe(bad)
    expect(failure.line).toBeGreaterThan(0)
    expect(failure.message).toBeTruthy()
    expect(graph.getFile(bad)).toBe(null)
    expect(graph.summary().parseFailures.map((f) => f.file)).toContain(bad)
  })

  it('resolving into a broken file yields parse-error, not not-found', () => {
    const bad = path.join(dir, 'bad.ts')
    fs.writeFileSync(bad, `export function f( {\n`)
    const graph = buildModuleGraph({ root: dir, files: [bad] })
    const res = graph.resolveExport(bad, 'f')
    expect(res.kind).toBe('parse-error')
    if (res.kind === 'parse-error') {
      expect(res.failure.file).toBe(bad)
      expect(res.failure.line).toBeGreaterThan(0)
    }
  })
})

describe('source-provenance', () => {
  it('maps a generated position back to the original via a source map', () => {
    // Minimal single-mapping source map. Generated (0,0) -> original file
    // "src/foo.ts" line 5 (index 4), column 10, name "value".
    const map = {
      version: 3 as const,
      sources: ['src/foo.ts'],
      names: ['value'],
      // decoded mappings; one segment on generated line 1, col 0:
      // [genCol, srcIdx, srcLine, srcCol, nameIdx]
      mappings: [[[0, 0, 4, 10, 0]]] as any,
    }
    const resolver = makeSourceMapResolver(map)
    const original = resolver.originalPosition({ line: 1, column: 0 })
    expect(original.source).toBe('src/foo.ts')
    expect(original.line).toBe(5)
    expect(original.column).toBe(10)
    expect(original.name).toBe('value')
  })

  it('accepts an existing TraceMap instance', () => {
    const map = new TraceMap({
      version: 3,
      sources: ['a.ts'],
      names: [],
      mappings: [[[0, 0, 0, 0]]] as any,
    })
    const resolver = makeSourceMapResolver(map)
    expect(resolver.originalPosition({ line: 1, column: 0 }).source).toBe('a.ts')
  })

  it('renders a code frame with a caret line', () => {
    const code = `const x = 1\nconst y = compute(x)\nconst z = 3`
    const frame = renderCodeFrame({
      code,
      loc: { line: 2, column: 10, endLine: 2, endColumn: 17 },
      message: 'culprit',
    })
    expect(frame).toContain('^')
    expect(frame).toContain('culprit')
    expect(frame).toContain('compute')
  })
})
