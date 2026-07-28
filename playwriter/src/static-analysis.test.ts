import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NodePath } from '@babel/traverse'
import {
  parseModule,
  findNodePath,
  analyzeBinding,
  aliasingHazard,
  probeValue,
  classifyDeopt,
  exhaustiveDeps,
  backwardSlice,
} from './static-analysis.js'
import { buildModuleGraph } from './module-graph.js'

// Find the declaring identifier for a binding by name (first declaration).
function bindingIdentifier(code: string, name: string): NodePath {
  const ast = parseModule(code)
  const p = findNodePath(ast, (x) => x.isReferencedIdentifier() && (x.node as any).name === name)
  if (!p) throw new Error(`no reference to ${name}`)
  return p
}

describe('analyzeBinding + aliasingHazard', () => {
  it('mutating reducer trap: constant binding but aliasing hazard flagged', () => {
    const code = `
      function reducer(state, action) {
        switch (action.type) {
          case 'ADD':
            state.total += action.x
            state.items.push(action.y)
            return state
        }
      }
    `
    const ref = bindingIdentifier(code, 'state')
    const info = analyzeBinding(ref)
    // state is a param, never reassigned -> Babel reports it as constant.
    expect(info.constant).toBe(true)
    expect(info.constantViolations.length).toBe(0)

    const haz = aliasingHazard(info)
    // But it is mutated in place / escapes, so a hazard MUST be reported.
    expect(haz.hazard).toBe('aliasing')
    expect(haz.sites.length).toBeGreaterThan(0)
  })

  it('does not flag a genuinely constant, unmutated binding', () => {
    const code = `
      function f() {
        const config = { a: 1 }
        return config.a
      }
    `
    const ref = bindingIdentifier(code, 'config')
    const info = analyzeBinding(ref)
    const haz = aliasingHazard(info)
    // Only a read of config.a — no mutation, no escape.
    expect(haz.hazard).toBe(null)
    expect(haz.sites.length).toBe(0)
  })

  it('flags Object.assign target as aliasing', () => {
    const code = `
      function f(opts) {
        const base = {}
        Object.assign(base, opts)
        return 1
      }
    `
    const info = analyzeBinding(bindingIdentifier(code, 'base'))
    expect(aliasingHazard(info).hazard).toBe('aliasing')
  })

  it('flags escape when a binding is passed as a call argument', () => {
    const code = `
      function f() {
        const data = { n: 1 }
        send(data)
      }
    `
    const info = analyzeBinding(bindingIdentifier(code, 'data'))
    expect(aliasingHazard(info).hazard).toBe('escape')
  })
})

describe('probeValue', () => {
  it('is confident for a literal chain', () => {
    const code = `const y = 2 * 3 + 1`
    const ast = parseModule(code)
    const init = findNodePath(ast, (p) => p.isBinaryExpression())!
    const probe = probeValue(init)
    expect(probe.confident).toBe(true)
    expect(probe.value).toBe(7)
  })

  it('is not confident for a call result and surfaces the deopt loc', () => {
    const code = `
      function g() { return Math.random() }
      const x = g()
      use(x)
    `
    const ast = parseModule(code)
    const callInit = findNodePath(
      ast,
      (p) => p.isCallExpression() && (p.node as any).callee?.name === 'g',
    )!
    const probe = probeValue(callInit)
    expect(probe.confident).toBe(false)
    expect(probe.deoptLoc).toBeTruthy()
    // deopt points at the call expression itself.
    expect(probe.deoptLoc!.line).toBe(callInit.node.loc!.start.line)
  })
})

describe('exhaustiveDeps', () => {
  it('reports a reactive var referenced but missing from deps', () => {
    const code = `
      import { useEffect, useState } from 'react'
      function compute(n) { return n * 2 }
      function Comp({ userId }) {
        const [b, setB] = useState(0)
        const [count, setCount] = useState(0)
        useEffect(() => {
          setB(compute(count))
        }, [userId])
        return null
      }
    `
    const ast = parseModule(code)
    const effect = findNodePath(
      ast,
      (p) => p.isCallExpression() && (p.node as any).callee?.name === 'useEffect',
    )!
    const result = exhaustiveDeps(effect)
    expect(result.missing).toEqual(['count'])
    expect(result.effectLoc.line).toBeGreaterThan(0)
  })

  it('returns no missing deps when everything reactive is listed', () => {
    const code = `
      import { useEffect, useState } from 'react'
      function Comp() {
        const [count, setCount] = useState(0)
        useEffect(() => {
          console.log(count)
        }, [count])
        return null
      }
    `
    const ast = parseModule(code)
    const effect = findNodePath(
      ast,
      (p) => p.isCallExpression() && (p.node as any).callee?.name === 'useEffect',
    )!
    expect(exhaustiveDeps(effect).missing).toEqual([])
  })
})

// Cross-module + classifyDeopt tests need a real graph on disk.
describe('classifyDeopt (cross-module + params)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-static-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('resolves a cross-module const through buildModuleGraph and folds the literal', () => {
    const a = path.join(dir, 'a.ts')
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(a, `export const D = 0.2\n`)
    fs.writeFileSync(b, `import { D } from './a'\nexport function use() { return D }\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, b] })

    const mod = graph.getFile(b)!
    const ref = findNodePath(
      mod.ast,
      (p) => p.isReferencedIdentifier() && (p.node as any).name === 'D',
    )!
    const info = analyzeBinding(ref)
    expect(info.kind).toBe('module')

    const hop = classifyDeopt(ref, info, graph)
    expect(hop.kind).toBe('module-export')
    expect(hop.blockedBy).toBe(null)
    expect(hop.evaluated?.confident).toBe(true)
    expect(hop.evaluated?.value).toBe(0.2)
    // site points into a.ts
    expect(hop.site?.file).toBe(a)
  })

  it('blocks on an unresolved / external module import', () => {
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(b, `import { thing } from 'some-pkg'\nexport function use() { return thing }\n`)
    const graph = buildModuleGraph({ root: dir, files: [b] })
    const mod = graph.getFile(b)!
    const ref = findNodePath(
      mod.ast,
      (p) => p.isReferencedIdentifier() && (p.node as any).name === 'thing',
    )!
    const hop = classifyDeopt(ref, analyzeBinding(ref), graph)
    expect(hop.blockedBy).toBe('unresolved-module')
  })

  it('single-caller param salvage hops into the argument', () => {
    const f = path.join(dir, 'f.ts')
    fs.writeFileSync(
      f,
      `function target(p) { return p + 1 }\nexport function driver() { return target(42) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const mod = graph.getFile(f)!
    const ref = findNodePath(
      mod.ast,
      (p) => p.isReferencedIdentifier() && (p.node as any).name === 'p',
    )!
    const info = analyzeBinding(ref)
    expect(info.kind).toBe('param')
    const hop = classifyDeopt(ref, info, graph)
    expect(hop.kind).toBe('param-caller')
    expect(hop.blockedBy).toBe(null)
  })

  it('blocks interprocedural when a param has multiple callers', () => {
    const f = path.join(dir, 'f.ts')
    fs.writeFileSync(
      f,
      `function target(p) { return p + 1 }\n` +
        `export function d1() { return target(1) }\n` +
        `export function d2() { return target(2) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const mod = graph.getFile(f)!
    const ref = findNodePath(
      mod.ast,
      (p) => p.isReferencedIdentifier() && (p.node as any).name === 'p',
    )!
    const hop = classifyDeopt(ref, analyzeBinding(ref), graph)
    expect(hop.blockedBy).toBe('interprocedural')
  })
})

describe('backwardSlice', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-slice-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('collapses a confident constant to a value leaf', () => {
    const f = path.join(dir, 'c.ts')
    fs.writeFileSync(f, `const rate = 0.5\nexport const total = rate\n`)
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'rate' })
    expect(slice.kind).toBe('value')
    expect(slice.evaluated?.value).toBe(0.5)
    expect(slice.codeFrame).toContain('^')
  })

  it('produces a blocked mutation leaf for a mutated constant binding', () => {
    const f = path.join(dir, 'r.ts')
    fs.writeFileSync(
      f,
      `export function reducer(state, action) {\n` +
        `  state.total += action.x\n` +
        `  return state\n` +
        `}\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'state' })
    expect(slice.blockedBy).toBe('mutation')
    expect(slice.hazards.length).toBeGreaterThan(0)
  })
})
