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

  it('blackboxes bare node_modules specifiers', () => {
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(b, `import react from 'react'\n`)
    const graph = buildModuleGraph({ root: dir, files: [b] })
    expect(graph.resolve(b, 'react')).toEqual({ blackbox: true })
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
