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
  classifyAsyncBoundary,
  exhaustiveDeps,
  backwardSlice,
  inspectBinding,
  evaluateBinding,
  findMissingDeps,
  locOf,
} from './static-analysis.js'
import type { TraceHop, BindingInfo, Loc } from './static-analysis.js'
import { buildModuleGraph } from './module-graph.js'

// Find the declaring identifier for a binding by name (first declaration).
function bindingIdentifier(code: string, name: string): NodePath {
  const ast = parseModule(code)
  const p = findNodePath(ast, (x) => x.isReferencedIdentifier() && (x.node as any).name === name)
  if (!p) throw new Error(`no reference to ${name}`)
  return p
}

function infoOf(code: string, name: string): BindingInfo {
  return analyzeBinding(bindingIdentifier(code, name))
}

/** Flatten a slice tree depth-first. */
function allHops(hop: TraceHop): TraceHop[] {
  return [hop, ...(hop.children ?? []).flatMap(allHops)]
}

function leaves(hop: TraceHop): TraceHop[] {
  return hop.children?.length ? hop.children.flatMap(leaves) : [hop]
}

/**
 * The aliasing check as it stood before this pass, reproduced verbatim so each
 * new pattern can be shown to have slipped through it. If one of these starts
 * passing, the reproduction has drifted and the proof is worthless.
 */
function legacyAliasingHazard(binding: BindingInfo): 'aliasing' | 'escape' | null {
  const MUT = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear'])
  const isObjectAssign = (callee: any) =>
    callee?.type === 'MemberExpression' &&
    callee.object?.type === 'Identifier' &&
    callee.object.name === 'Object' &&
    callee.property?.type === 'Identifier' &&
    callee.property.name === 'assign'
  const aliasing: Loc[] = []
  const escape: Loc[] = []
  for (const ref of binding.referencePaths) {
    const parent = ref.parentPath
    if (!parent) continue
    if (
      parent.isMemberExpression() &&
      (parent.node as any).object === ref.node &&
      parent.parentPath?.isAssignmentExpression() &&
      (parent.parentPath.node as any).left === parent.node
    ) {
      aliasing.push(locOf(ref.node as any)!)
      continue
    }
    let mutatedByCall = false
    let cur: NodePath = ref
    while (cur.parentPath?.isMemberExpression() && (cur.parentPath.node as any).object === cur.node) {
      const member = cur.parentPath
      const call = member.parentPath
      if (
        call?.isCallExpression() &&
        (call.node as any).callee === member.node &&
        (member.node as any).property?.type === 'Identifier' &&
        MUT.has((member.node as any).property.name) &&
        !(member.node as any).computed
      ) {
        mutatedByCall = true
        break
      }
      cur = cur.parentPath
    }
    if (mutatedByCall) {
      aliasing.push(locOf(ref.node as any)!)
      continue
    }
    if (
      parent.isCallExpression() &&
      isObjectAssign((parent.node as any).callee) &&
      (parent.node as any).arguments[0] === ref.node
    ) {
      aliasing.push(locOf(ref.node as any)!)
      continue
    }
    if (parent.isCallExpression() && (parent.node as any).arguments.includes(ref.node)) {
      escape.push(locOf(ref.node as any)!)
      continue
    }
    if (parent.isReturnStatement()) {
      escape.push(locOf(ref.node as any)!)
      continue
    }
    if (
      parent.isAssignmentExpression() &&
      (parent.node as any).right === ref.node &&
      (parent.node as any).left?.type === 'MemberExpression'
    ) {
      escape.push(locOf(ref.node as any)!)
      continue
    }
    if (parent.isObjectProperty() && (parent.node as any).value === ref.node) {
      escape.push(locOf(ref.node as any)!)
      continue
    }
  }
  if (aliasing.length) return 'aliasing'
  if (escape.length) return 'escape'
  return null
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

// ---------------------------------------------------------------------------
// Defect 8 — the aliasing check is the single most important thing in the
// module. Every pattern below is a way a real mutating reducer hides from it,
// and each is checked against the pre-fix detector to prove the gap was real.
// ---------------------------------------------------------------------------

describe('aliasingHazard closes the mutating-reducer escape hatches', () => {
  const reducer = (body: string) =>
    `export function reducer(state, action) {\n${body}\n  return state\n}\n`

  const cases: { name: string; body: string; pattern: string; legacyCaught: boolean }[] = [
    {
      name: 'direct member assignment',
      body: `  state.total = state.total + action.x`,
      pattern: 'member-assign',
      legacyCaught: true,
    },
    {
      name: 'mutating method on a nested path',
      body: `  state.cart.items.push(action.y)`,
      pattern: 'mutating-method',
      legacyCaught: true,
    },
    {
      name: 'mutation through a destructured alias',
      body: `  const { items } = state\n  items.push(action.y)`,
      pattern: 'mutating-method',
      legacyCaught: false,
    },
    {
      name: 'mutation through a renamed destructured alias',
      body: `  const { rows: list } = state\n  list.sort()`,
      pattern: 'mutating-method',
      legacyCaught: false,
    },
    {
      name: 'mutation through a member alias',
      body: `  const rows = state.rows\n  rows.splice(0, 1)`,
      pattern: 'mutating-method',
      legacyCaught: false,
    },
    {
      // The old check only matched `ref.x = v` — one member link deep — so any
      // index or nesting between the binding and the write slipped past it.
      name: 'assignment through an array index',
      body: `  state.rows[action.i] = action.v`,
      pattern: 'member-assign',
      legacyCaught: false,
    },
    {
      name: 'assignment through a property of an indexed element',
      body: `  state.rows[action.i].x = action.v`,
      pattern: 'member-assign',
      legacyCaught: false,
    },
    {
      name: 'delete of a property',
      body: `  delete state.byId[action.id]`,
      pattern: 'member-delete',
      legacyCaught: false,
    },
    {
      name: 'update expression on a property',
      body: `  state.count++`,
      pattern: 'member-update',
      legacyCaught: false,
    },
    {
      name: 'compound assignment deep in a chain',
      body: `  state.totals.gross += action.x`,
      pattern: 'member-assign',
      legacyCaught: false,
    },
    {
      name: 'Object.assign into the existing object',
      body: `  Object.assign(state, action.patch)`,
      pattern: 'mutating-static-call',
      legacyCaught: true,
    },
    {
      name: 'Object.defineProperty on the object',
      body: `  Object.defineProperty(state, 'k', { value: 1 })`,
      pattern: 'mutating-static-call',
      legacyCaught: false,
    },
    {
      name: 'Reflect.set on the object',
      body: `  Reflect.set(state, 'k', action.v)`,
      pattern: 'mutating-static-call',
      legacyCaught: false,
    },
    {
      name: 'Array.prototype mutator via .call',
      body: `  Array.prototype.push.call(state.items, action.y)`,
      pattern: 'mutating-method-apply',
      legacyCaught: false,
    },
    {
      name: 'Array.prototype mutator via .apply',
      body: `  Array.prototype.splice.apply(state.items, [0, 1])`,
      pattern: 'mutating-method-apply',
      legacyCaught: false,
    },
    {
      name: 'mutation inside a nested closure that escapes',
      body: `  const bump = () => { state.total++ }\n  queueMicrotask(bump)`,
      pattern: 'member-update',
      legacyCaught: false,
    },
    {
      name: 'mutation of an object reached through a getter property',
      body: `  state.config.flags.set('a', 1)`,
      pattern: 'mutating-method',
      legacyCaught: true,
    },
    {
      name: 'mutation through a reassignment alias',
      body: `  let s\n  s = state\n  s.total = 1`,
      pattern: 'member-assign',
      legacyCaught: false,
    },
    {
      name: 'length truncation',
      body: `  state.items.length = 0`,
      pattern: 'member-assign',
      legacyCaught: false,
    },
  ]

  for (const c of cases) {
    it(`flags ${c.name} DESPITE constant: true`, () => {
      const code = reducer(c.body)
      const info = infoOf(code, 'state')
      // Babel's `constant` only means "never reassigned" — the whole reason this
      // check exists.
      expect(info.constant, 'binding is syntactically constant').toBe(true)
      expect(info.constantViolations.length).toBe(0)

      const haz = aliasingHazard(info)
      expect(haz.hazard, `${c.name} must be an aliasing hazard`).toBe('aliasing')
      expect(haz.hazards.map((h) => h.pattern)).toContain(c.pattern)
      expect(haz.aliasingSites.length).toBeGreaterThan(0)
    })
  }

  it('proves each new pattern was invisible to the pre-fix detector', () => {
    const missedByLegacy = cases.filter((c) => !c.legacyCaught)
    expect(missedByLegacy.length).toBeGreaterThan(10)
    for (const c of missedByLegacy) {
      const info = infoOf(reducer(c.body), 'state')
      expect(legacyAliasingHazard(info), `${c.name} should slip past the old check`).not.toBe('aliasing')
      expect(aliasingHazard(info).hazard, `${c.name} must be caught now`).toBe('aliasing')
    }
    // Sanity: the reproduction still catches what it always caught.
    for (const c of cases.filter((x) => x.legacyCaught)) {
      expect(legacyAliasingHazard(infoOf(reducer(c.body), 'state'))).toBe('aliasing')
    }
  })

  it('still does not flag a genuinely immutable reducer', () => {
    const code = `export function reducer(state, action) {\n` +
      `  return { ...state, total: state.total + action.x, items: [...state.items, action.y] }\n` +
      `}\n`
    const info = infoOf(code, 'state')
    expect(aliasingHazard(info).hazard).toBe(null)
  })

  it('does not turn a read of a copied primitive into an escape', () => {
    // `const n = obj.count; return n` says nothing about `obj`; reporting it
    // would make every function that reads a field look hazardous.
    const code = `export function f(obj) {\n  const n = obj.count\n  return n\n}\n`
    expect(aliasingHazard(infoOf(code, 'obj')).hazard).toBe(null)
  })

  it('labels escape and aliasing sites separately instead of one blanket type', () => {
    const code = `export function f(state) {\n  state.items.push(1)\n  send(state)\n}\n`
    const haz = aliasingHazard(infoOf(code, 'state'))
    expect(haz.hazards.map((h) => h.type)).toEqual(['aliasing', 'escape'])
    expect(haz.aliasingSites.length).toBe(1)
    expect(haz.escapeSites.length).toBe(1)
  })

  it('names the alias a mutation was reached through', () => {
    const code = `export function reducer(state) {\n  const { items } = state\n  items.push(1)\n}\n`
    const haz = aliasingHazard(infoOf(code, 'state'))
    expect(haz.hazards[0].viaAlias).toBe('items')
  })

  it('terminates on a self-referential alias chain', () => {
    const code = `export function f(state) {\n  let a = state\n  let b = a\n  a = b\n  b = a\n  return b\n}\n`
    expect(() => aliasingHazard(infoOf(code, 'state'))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Defects 1 + 2 — interprocedural analysis.
// ---------------------------------------------------------------------------

describe('interprocedural analysis: identity, branching, budgets', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-inter-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const write = (name: string, code: string) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, code)
    return p
  }

  it('two files each defining format() with one caller each BOTH resolve, neither blocks', () => {
    const a = write('a.ts', `export function format(v) { return v }\nexport function callA() { return format(11) }\n`)
    const b = write('b.ts', `export function format(v) { return v }\nexport function callB() { return format(22) }\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, b] })

    // The bare-name bucket has two entries — the collision the old index keyed on.
    expect(graph.callSites.get('format')!.length).toBe(2)

    for (const [file, expected] of [[a, 11], [b, 22]] as const) {
      const slice = backwardSlice({ graph, startFile: file, startExpr: 'v' })
      expect(slice.kind, `${file} root kind`).toBe('param-caller')
      expect(slice.blockedBy, `${file} must NOT block as interprocedural`).toBe(null)
      expect(slice.divergence?.agreement).toBe('convergent')
      expect(slice.divergence?.agreedValue).toBe(expected)
      expect(slice.children!.length).toBe(1)
      expect(slice.children![0].evaluated?.value).toBe(expected)
    }
  })

  it('three callers with different literals produce three branches and visible divergence', () => {
    const f = write(
      'three.ts',
      `function target(p) { return p + 1 }\n` +
        `export function d1() { return target(1) }\n` +
        `export function d2() { return target(2) }\n` +
        `export function d3() { return target(3) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'p' })

    expect(slice.children!.length).toBe(3)
    expect(slice.children!.map((c) => c.evaluated?.value).sort()).toEqual([1, 2, 3])
    expect(slice.divergence?.agreement).toBe('divergent')
    expect(slice.divergence!.distinctValues!.sort()).toEqual(['1', '2', '3'])
    expect(slice.divergence!.candidates.length).toBe(3)
    // Divergence IS the finding, so it stays a named blind spot …
    expect(slice.blockedBy).toBe('interprocedural')
    // … and the note says so rather than picking a winner.
    expect(slice.note).toMatch(/DIVERGENT/)
    expect(slice.truncated).toBeUndefined()
  })

  it('maxBreadth actually truncates, and the truncation is reported', () => {
    const f = write(
      'three2.ts',
      `function target(p) { return p + 1 }\n` +
        `export function d1() { return target(1) }\n` +
        `export function d2() { return target(2) }\n` +
        `export function d3() { return target(3) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'p', maxBreadth: 2 })

    expect(slice.children!.length).toBe(2)
    expect(slice.truncated).toEqual({
      of: 'callers',
      shown: 2,
      total: 3,
      resumeWith: { option: 'maxBreadth', current: 2, suggested: 3 },
    })
    expect(slice.note).toMatch(/TRUNCATED: showing 2 of 3 callers/)
    expect(slice.resumable?.option).toBe('maxBreadth')
    // A truncated branch set is never allowed to look complete/convergent.
    expect(slice.blockedBy).toBe('interprocedural')
  })

  it('maxBreadth: 0 drops every branch AND says it dropped them', () => {
    const f = write('breadth0.ts', `function inner(x) { return x }\nexport function outer() { return inner(5) }\n`)
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'x', maxBreadth: 0 })
    expect(slice.children ?? []).toHaveLength(0)
    // A hop that threw away its only caller must not look like one that had none.
    expect(slice.truncated).toEqual({
      of: 'callers',
      shown: 0,
      total: 1,
      resumeWith: { option: 'maxBreadth', current: 0, suggested: 1 },
    })
    expect(slice.blockedBy).toBe('interprocedural')
    expect(slice.note).toMatch(/TRUNCATED: showing 0 of 1 callers/)
  })

  it('lifts the interprocedural block when every caller agrees', () => {
    const f = write(
      'agree.ts',
      `function target(p) { return p + 1 }\n` +
        `export function d1() { return target(7) }\n` +
        `export function d2() { return target(7) }\n` +
        `export function d3() { return target(3 + 4) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'p' })
    expect(slice.children!.length).toBe(3)
    expect(slice.divergence?.agreement).toBe('convergent')
    expect(slice.divergence?.agreedValue).toBe(7)
    expect(slice.blockedBy).toBe(null)
    expect(slice.note).toMatch(/CONVERGENT/)
    // The agreed value is NOT written to `evaluated`: the branches below still matter.
    expect(slice.evaluated).toBe(null)
  })

  it('follows a caller across a file boundary', () => {
    const lib = write('lib2.ts', `export function fmt(v) { return v }\n`)
    const app = write('app2.ts', `import { fmt } from './lib2'\nexport function run() { return fmt(99) }\n`)
    const graph = buildModuleGraph({ root: dir, files: [lib, app] })
    const slice = backwardSlice({ graph, startFile: lib, startExpr: 'v' })
    expect(slice.blockedBy).toBe(null)
    expect(slice.children![0].evaluated?.value).toBe(99)
    expect(slice.children![0].site?.file).toBe(app)
  })

  it('resolves a destructured parameter out of an object-literal argument', () => {
    const f = write(
      'destr.ts',
      `function Row({ label }) { return label }\nexport function App() { return Row({ label: 'hi' }) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'label' })
    expect(slice.kind).toBe('param-caller')
    expect(slice.note).toMatch(/destructured as "label"/)
    expect(slice.children![0].evaluated?.value).toBe('hi')
  })

  it('says a parameter has no resolvable caller instead of implying ambiguity', () => {
    const f = write('nocaller.ts', `export function exported(p) { return p + 1 }\n`)
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'p' })
    expect(slice.blockedBy).toBe('interprocedural')
    expect(slice.note).toMatch(/no resolvable caller/)
  })

  it('terminates a recursive function through cycle detection, not hop exhaustion', () => {
    const f = write(
      'rec.ts',
      `export function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) }\n` +
        `export function run() { return fact(5) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'n', maxHops: 8 })
    const hops = allHops(slice)

    expect(hops.some((h) => h.blockedBy === 'cycle'), 'a cycle must be reported').toBe(true)
    expect(hops.some((h) => h.blockedBy === 'budget-hops'), 'must NOT be a budget stop').toBe(false)
    expect(hops.find((h) => h.blockedBy === 'cycle')!.note).toMatch(/cycle broken/)
    // The non-recursive caller still resolves.
    expect(hops.some((h) => h.evaluated?.value === 5)).toBe(true)
  })

  it('terminates mutual recursion the same way', () => {
    const f = write(
      'mutual.ts',
      `function ping(a) { return pong(a - 1) }\n` +
        `function pong(b) { return ping(b - 1) }\n` +
        `export function run() { return ping(3) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'a', maxHops: 20 })
    const hops = allHops(slice)
    expect(hops.some((h) => h.blockedBy === 'cycle')).toBe(true)
    expect(hops.some((h) => h.blockedBy === 'budget-hops')).toBe(false)
  })

  it('does not call two sibling branches reaching the same node a cycle', () => {
    // A global visited set would report the second `shared` as a cycle.
    const f = write(
      'shared.ts',
      `const shared = 5\n` +
        `function target(p) { return p }\n` +
        `export function d1() { return target(shared) }\n` +
        `export function d2() { return target(shared) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'p' })
    expect(slice.children!.length).toBe(2)
    expect(allHops(slice).some((h) => h.blockedBy === 'cycle')).toBe(false)
    expect(slice.divergence?.agreement).toBe('convergent')
  })
})

// ---------------------------------------------------------------------------
// Defect 3 — budget exhaustion must not masquerade as a runtime blind spot.
// ---------------------------------------------------------------------------

describe('hop budget exhaustion is distinguishable and resumable', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-budget-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports budget-hops with a resume hint, never dynamic', () => {
    const f = path.join(dir, 'chain.ts')
    fs.writeFileSync(
      f,
      `const seed = 5\n` +
        `function f1(a) { return a }\n` +
        `function f2(b) { return f1(b) }\n` +
        `function f3(c) { return f2(c) }\n` +
        `export function run() { return f3(seed) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })

    const tight = backwardSlice({ graph, startFile: f, startExpr: 'a', maxHops: 2 })
    const stopped = leaves(tight)
    expect(stopped.length).toBe(1)
    expect(stopped[0].blockedBy).toBe('budget-hops')
    expect(stopped[0].blockedBy).not.toBe('dynamic')
    expect(stopped[0].resumable).toEqual({ option: 'maxHops', current: 2, suggested: 6 })
    expect(stopped[0].note).toMatch(/RESUMABLE/)
    expect(stopped[0].note).toMatch(/NOT a runtime blind spot/)

    // The hint is truthful: raising the budget really does finish the walk.
    const roomy = backwardSlice({ graph, startFile: f, startExpr: 'a', maxHops: 8 })
    const done = leaves(roomy)
    expect(done.every((h) => h.blockedBy === null)).toBe(true)
    expect(done[0].evaluated?.value).toBe(5)
  })

  it('a truncated-and-budgeted walk reports both stops', () => {
    const f = path.join(dir, 'both.ts')
    fs.writeFileSync(
      f,
      `function inner(x) { return x }\n` +
        `function mid(y) { return inner(y) }\n` +
        `export function c1() { return mid(1) }\n` +
        `export function c2() { return mid(2) }\n` +
        `export function c3() { return mid(3) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'x', maxHops: 2, maxBreadth: 2 })
    const hops = allHops(slice)
    expect(hops.some((h) => h.truncated?.of === 'callers')).toBe(true)
    expect(hops.some((h) => h.blockedBy === 'budget-hops')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Defect 4 — re-export chains reach the real definition.
// Defect 5 — a parse failure is named, not guessed at.
// ---------------------------------------------------------------------------

describe('module-export hops follow re-export chains', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-reexp-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const write = (name: string, code: string) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, code)
    return p
  }

  it('resolves a 3-link chain with a rename in the middle to the definition in c.ts', () => {
    const c = write('c.ts', `export const RATE = 0.41\n`)
    const b = write('b.ts', `export { RATE as MID } from './c'\n`)
    const a = write('a.ts', `export { MID } from './b'\n`)
    const app = write('app.ts', `import { MID } from './a'\nexport function use() { return MID }\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, b, c, app] })

    const slice = backwardSlice({ graph, startFile: app, startExpr: 'MID' })
    expect(slice.kind).toBe('module-export')
    expect(slice.blockedBy).toBe(null)
    expect(slice.evaluated?.confident).toBe(true)
    expect(slice.evaluated?.value).toBe(0.41)
    expect(slice.site?.file).toBe(c)
    expect(slice.reexportChain!.map((s) => s.source)).toEqual(['./b', './c'])
    expect(slice.note).toMatch(/renamed to "RATE"/)
  })

  it('descends into an exported value that does not fold', () => {
    const lib = write('lib.ts', `const base = 2\nexport const derived = base\n`)
    const app = write('app3.ts', `import { derived } from './lib'\nexport function use() { return derived }\n`)
    const graph = buildModuleGraph({ root: dir, files: [lib, app] })
    const slice = backwardSlice({ graph, startFile: app, startExpr: 'derived' })
    // Whether Babel folds this directly or the slice descends, the answer must
    // be the value — never a resolved-but-empty leaf.
    const found = allHops(slice).some((h) => h.evaluated?.value === 2)
    expect(found).toBe(true)
    expect(slice.blockedBy).toBe(null)
  })

  it('reports an `export *` collision explicitly on the hop', () => {
    write('x.ts', `export const dup = 1\n`)
    write('y.ts', `export const dup = 2\n`)
    const idx = write('index.ts', `export * from './x'\nexport * from './y'\n`)
    const app = write('app4.ts', `import { dup } from './index'\nexport function use() { return dup }\n`)
    const graph = buildModuleGraph({ root: dir })

    const slice = backwardSlice({ graph, startFile: app, startExpr: 'dup' })
    expect(slice.blockedBy).toBe('unresolved-module')
    expect(slice.note).toMatch(/AMBIGUOUS/)
    expect(slice.note).toContain('x.ts')
    expect(slice.note).toContain('y.ts')
    expect(idx).toBeTruthy()
  })

  it('marks a cyclic re-export chain as cycle, not as a missing export', () => {
    const a = write('ca.ts', `export { z } from './cb'\n`)
    write('cb.ts', `export { z } from './ca'\n`)
    const app = write('app5.ts', `import { z } from './ca'\nexport function use() { return z }\n`)
    const graph = buildModuleGraph({ root: dir })
    const slice = backwardSlice({ graph, startFile: app, startExpr: 'z' })
    expect(slice.blockedBy).toBe('cycle')
    expect(slice.note).toMatch(/CYCLIC/)
    expect(a).toBeTruthy()
  })

  it('distinguishes an external dependency from a broken path', () => {
    const ext = write('ext.ts', `import { thing } from 'some-pkg'\nexport function use() { return thing }\n`)
    const broken = write('broken.ts', `import { gone } from './nowhere'\nexport function use() { return gone }\n`)
    const graph = buildModuleGraph({ root: dir, files: [ext, broken] })

    const a = backwardSlice({ graph, startFile: ext, startExpr: 'thing' })
    expect(a.blockedBy).toBe('unresolved-module')
    expect(a.note).toMatch(/external \/ blackboxed/)

    const b = backwardSlice({ graph, startFile: broken, startExpr: 'gone' })
    expect(b.blockedBy).toBe('unresolved-module')
    expect(b.note).toMatch(/does not resolve to any file on disk/)
  })

  it('names the file AND the parser position when the target file will not parse', () => {
    const bad = write('bad.ts', `export const cfg = {\n  a: 1,\n`)
    const app = write('app6.ts', `import { cfg } from './bad'\nexport function use() { return cfg }\n`)
    const graph = buildModuleGraph({ root: dir, files: [bad, app] })

    const slice = backwardSlice({ graph, startFile: app, startExpr: 'cfg' })
    expect(slice.blockedBy).toBe('parse-error')
    expect(slice.blockedBy).not.toBe('unresolved-module')
    expect(slice.note).toContain(bad)
    expect(slice.note).toMatch(/FAILED TO PARSE/)
    expect(slice.note).toMatch(/:\d+:\d+/)
    expect(slice.parseError!.file).toBe(bad)
    expect(slice.parseError!.line).toBeGreaterThan(0)
    expect(slice.note).toMatch(/no runtime probe helps/)
  })

  it('reports a start file that will not parse as parse-error', () => {
    const bad = write('badstart.ts', `export function f( {\n`)
    const graph = buildModuleGraph({ root: dir, files: [bad] })
    const slice = backwardSlice({ graph, startFile: bad, startExpr: 'anything' })
    expect(slice.blockedBy).toBe('parse-error')
    expect(slice.parseError!.file).toBe(bad)
  })
})

// ---------------------------------------------------------------------------
// A local binding whose initialiser only NAMES its value. `const x = anImport`
// is one of the most common shapes in component code, and it used to dead-end
// as `dynamic` — the worst available answer, since it sends the agent after
// runtime evidence for a value sitting two files away.
// ---------------------------------------------------------------------------

describe('local aliases of imports hop into the module chain', () => {
  let dir: string
  let a: string
  let graph: ReturnType<typeof buildModuleGraph>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-alias-'))
    const w = (n: string, code: string) => {
      const p = path.join(dir, n)
      fs.writeFileSync(p, code)
      return p
    }
    w('c.ts', `export const seed = 5\nexport const obj = { a: 7, b: 8 }\nexport const pair = [11, 22]\n`)
    w('b.ts', `import { seed } from './c.js'\nexport const mid = seed\n`)
    a = w(
      'a.ts',
      `import { mid } from './b.js'\n` +
        `import { obj, pair } from './c.js'\n` +
        `import * as ns from './c.js'\n` +
        `const top = mid\n` +
        `const top2 = top\n` +
        `const { a: destr } = obj\n` +
        `const [first] = pair\n` +
        `const nsx = ns.seed\n` +
        `const local = { k: 3 }\n` +
        `const lk = local.k\n` +
        `export function show() { return [top, top2, destr, first, nsx, lk] }\n`,
    )
    graph = buildModuleGraph({ root: dir })
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const sliceFor = (expr: string, maxHops = 8) =>
    backwardSlice({ graph, startFile: a, startExpr: expr, maxHops })

  it('`const top = mid` reaches the definition instead of dead-ending as dynamic', () => {
    const slice = sliceFor('top')
    // The pre-fix answer, and the reason it was the worst possible one.
    expect(slice.blockedBy).not.toBe('dynamic')
    expect(slice.kind).toBe('alias')
    expect(slice.blockedBy).toBe(null)
    expect(slice.note).toBe('"top" is a local alias of "mid"')

    // alias(a.ts) -> module-export(b.ts) -> module-export(c.ts) = 5
    const chain = allHops(slice)
    expect(chain.map((h) => h.kind)).toEqual(['alias', 'module-export', 'module-export'])
    expect(chain[2].evaluated).toEqual({ confident: true, value: 5 })
    expect(chain[2].site!.file!.endsWith('c.ts')).toBe(true)
    expect(leaves(slice).every((h) => h.blockedBy === null)).toBe(true)
  })

  it('follows an alias of an alias (two local links) to the same definition', () => {
    const chain = allHops(sliceFor('top2'))
    expect(chain.map((h) => h.kind)).toEqual(['alias', 'alias', 'module-export', 'module-export'])
    expect(chain[0].note).toBe('"top2" is a local alias of "top"')
    expect(chain[1].note).toBe('"top" is a local alias of "mid"')
    expect(chain[3].evaluated?.value).toBe(5)
  })

  it('projects a destructured property out of an imported object literal', () => {
    const slice = sliceFor('destr')
    expect(slice.kind).toBe('alias')
    expect(slice.note).toBe('"destr" is property "a" destructured from "obj"')
    // 7, not the whole { a: 7, b: 8 } — hopping into the object would be wrong.
    expect(slice.children![0].evaluated?.value).toBe(7)
    expect(slice.site!.file!.endsWith('c.ts')).toBe(true)
  })

  it('projects a destructured array element', () => {
    const slice = sliceFor('first')
    expect(slice.note).toBe('"first" is element #0 destructured from "pair"')
    expect(slice.children![0].evaluated?.value).toBe(11)
  })

  it('resolves a member of a namespace import', () => {
    const slice = sliceFor('nsx')
    expect(slice.note).toBe('"nsx" is "seed" of namespace import "ns"')
    expect(slice.children![0].evaluated?.value).toBe(5)
    expect(slice.site!.file!.endsWith('c.ts')).toBe(true)
  })

  it('resolves a member of a local object literal', () => {
    const slice = sliceFor('lk')
    expect(slice.note).toBe('"lk" is property "k" of "local"')
    expect(slice.children![0].evaluated?.value).toBe(3)
  })

  it('the three-file alias chain exhausts a small hop budget as budget-hops', () => {
    // A chain that `path.evaluate()` cannot collapse on its own: each link
    // crosses a module boundary, so each one costs a real hop.
    const tight = sliceFor('top', 1)
    const stopped = leaves(tight)
    expect(stopped.length).toBe(1)
    expect(stopped[0].blockedBy).toBe('budget-hops')
    expect(stopped[0].resumable).toEqual({ option: 'maxHops', current: 1, suggested: 5 })

    expect(leaves(sliceFor('top', 2))[0].blockedBy).toBe('budget-hops')
    // …and the hint is truthful.
    expect(leaves(sliceFor('top', 3))[0].evaluated?.value).toBe(5)
  })

  it('does not treat a call, a literal or an unprojectable pattern as an alias', () => {
    const f = path.join(dir, 'neg.ts')
    fs.writeFileSync(
      f,
      `import { useState } from 'react'\n` +
        `export function C(props) {\n` +
        `  const [items, setItems] = useState([])\n` +
        `  const v = compute(props)\n` +
        `  const { q } = props\n` +
        `  return [items, setItems, v, q]\n` +
        `}\n`,
    )
    const g = buildModuleGraph({ root: dir })
    for (const expr of ['items', 'v', 'q']) {
      const slice = backwardSlice({ graph: g, startFile: f, startExpr: expr })
      expect(slice.kind, `${expr} must not be called an alias`).not.toBe('alias')
    }
  })

  it('breaks a circular alias pair by cycle detection, not by budget', () => {
    const f = path.join(dir, 'circ.ts')
    fs.writeFileSync(f, `const x = y\nconst y = x\nexport function use() { return x }\n`)
    const g = buildModuleGraph({ root: dir })
    const slice = backwardSlice({ graph: g, startFile: f, startExpr: 'x', maxHops: 8 })
    const hops = allHops(slice)
    expect(hops.some((h) => h.blockedBy === 'cycle')).toBe(true)
    expect(hops.some((h) => h.blockedBy === 'budget-hops')).toBe(false)
  })

  it('inspectBinding surfaces the alias hop too', () => {
    const report = inspectBinding({ file: a, graph, name: 'top' })
    expect(report.ok).toBe(true)
    expect(report.hop!.kind).toBe('alias')
    expect(report.hop!.blockedBy).toBe(null)
    expect(JSON.parse(JSON.stringify(report)).hop.note).toContain('local alias of "mid"')
  })
})

// ---------------------------------------------------------------------------
// Defect 6 — async boundary detection beyond three syntactic shapes.
// ---------------------------------------------------------------------------

describe('classifyAsyncBoundary recognises real async arrivals', () => {
  let dir: string
  let graph: ReturnType<typeof buildModuleGraph>
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-async-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const sliceOf = (code: string, startExpr: string) => {
    const f = path.join(dir, 'a.ts')
    fs.writeFileSync(f, code)
    graph = buildModuleGraph({ root: dir, files: [f] })
    return backwardSlice({ graph, startFile: f, startExpr })
  }

  const cases: { name: string; code: string; expr: string; kind: string }[] = [
    {
      name: 'await nested inside the initialiser',
      code: `export async function f() {\n  const n = (await load()).length\n  return n\n}\n`,
      expr: 'n',
      kind: 'await',
    },
    {
      name: 'await on the right of a binary expression',
      code: `export async function f(a) {\n  const n = a + await load()\n  return n\n}\n`,
      expr: 'n',
      kind: 'await',
    },
    {
      name: '.finally chain',
      code: `export function f(p) {\n  const v = p.finally(() => 1)\n  return v\n}\n`,
      expr: 'v',
      kind: 'promise-chain',
    },
    {
      name: 'Promise.all',
      code: `export function f(a, b) {\n  const rs = Promise.all([a, b])\n  return rs\n}\n`,
      expr: 'rs',
      kind: 'promise-combinator',
    },
    {
      name: 'Promise.allSettled',
      code: `export function f(a) {\n  const rs = Promise.allSettled([a])\n  return rs\n}\n`,
      expr: 'rs',
      kind: 'promise-combinator',
    },
    {
      name: 'Promise.race',
      code: `export function f(a) {\n  const rs = Promise.race([a])\n  return rs\n}\n`,
      expr: 'rs',
      kind: 'promise-combinator',
    },
    {
      name: 'new Promise',
      code: `export function f() {\n  const p = new Promise((r) => r(1))\n  return p\n}\n`,
      expr: 'p',
      kind: 'promise-constructor',
    },
    {
      name: 'return value of a locally-visible async function',
      code: `async function load() { return 1 }\nexport function f() {\n  const p = load()\n  return p\n}\n`,
      expr: 'p',
      kind: 'async-call',
    },
    {
      name: 'return value of a locally-visible generator',
      code: `function* gen() { yield 1 }\nexport function f() {\n  const it = gen()\n  return it\n}\n`,
      expr: 'it',
      kind: 'async-call',
    },
    {
      name: 'parameter of a .then callback',
      code: `export function f(p) {\n  p.then((data) => use(data))\n}\n`,
      expr: 'data',
      kind: 'then-callback-param',
    },
    {
      name: 'parameter of a .catch callback',
      code: `export function f(p) {\n  p.catch((err) => use(err))\n}\n`,
      expr: 'err',
      kind: 'then-callback-param',
    },
    {
      name: 'value assigned inside a .then callback',
      code: `export function f(p) {\n  let v\n  p.then((r) => { v = r })\n  return v\n}\n`,
      expr: 'v',
      kind: 'async-writer',
    },
    {
      name: 'for-await binding',
      code: `export async function f(stream) {\n  for await (const chunk of stream) { use(chunk) }\n}\n`,
      expr: 'chunk',
      kind: 'for-await',
    },
    {
      name: 'yield result inside a generator',
      code: `export function* gen() {\n  const v = yield 1\n  return v\n}\n`,
      expr: 'v',
      kind: 'yield',
    },
  ]

  for (const c of cases) {
    it(`classifies ${c.name} as async (${c.kind})`, () => {
      const slice = sliceOf(c.code, c.expr)
      expect(slice.blockedBy, `${c.name} -> blockedBy`).toBe('async')
      expect(slice.note).toContain(`async boundary (${c.kind})`)
    })
  }

  it('does NOT call an ordinary synchronous call async — an honest unknown instead', () => {
    const slice = sliceOf(
      `function compute(a) { return a * 2 }\nexport function f(x) {\n  const v = compute(x)\n  return v\n}\n`,
      'v',
    )
    expect(slice.blockedBy).not.toBe('async')
    expect(slice.blockedBy).toBe('dynamic')
  })

  it('does not attribute an inner function’s await to the outer binding', () => {
    const slice = sliceOf(
      `export function f(items) {\n  const mapped = items.map(async (i) => await load(i))\n  return mapped\n}\n`,
      'mapped',
    )
    // The awaits belong to the arrow, not to `mapped`.
    expect(slice.note).not.toContain('async boundary (await)')
  })

  it('does not call an ordinary function parameter an async arrival', () => {
    const code = `export function plain(v) { return v }\n`
    const info = infoOf(code, 'v')
    expect(classifyAsyncBoundary(info)).toBe(null)
  })

  it('keeps a proven in-place mutation ranked above an async boundary', () => {
    // A `.then` callback param that is ALSO mutated: the mutation is the finding.
    const slice = sliceOf(
      `export function f(p) {\n  p.then((state) => { state.total = 1 })\n}\n`,
      'state',
    )
    expect(slice.blockedBy).toBe('mutation')
    expect(slice.hazards.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Defect 7 — sandbox-facing façades: serialisable, bounded, no NodePaths.
// ---------------------------------------------------------------------------

describe('sandbox façades are serialisable and bounded', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-facade-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const noNodePaths = (value: unknown) => {
    const json = JSON.stringify(value)
    expect(json).toBeTruthy()
    // A leaked NodePath/Node drags these along with it.
    expect(json).not.toMatch(/"parentPath"|"_traverseFlags"|"loc":\{"start":\{"line":\d+,"column":\d+,"index"/)
    return JSON.parse(json!)
  }

  it('inspectBinding reports the mutating-reducer trap over inline code', () => {
    const report = inspectBinding({
      code: `export function reducer(state, action) {\n  state.items.push(action.y)\n  return state\n}\n`,
      name: 'state',
    })
    expect(report.ok).toBe(true)
    expect(report.constant).toBe(true)
    expect(report.hazard).toBe('aliasing')
    expect(report.hazards[0].pattern).toBe('mutating-method')
    expect(report.declSite).toBeTruthy()
    noNodePaths(report)
  })

  it('inspectBinding adds a one-step hop when a graph is supplied', () => {
    const lib = path.join(dir, 'lib.ts')
    const app = path.join(dir, 'app.ts')
    fs.writeFileSync(lib, `export const D = 0.25\n`)
    fs.writeFileSync(app, `import { D } from './lib'\nexport function use() { return D }\n`)
    const graph = buildModuleGraph({ root: dir, files: [lib, app] })
    const report = inspectBinding({ file: app, graph, name: 'D' })
    expect(report.ok).toBe(true)
    expect(report.kind).toBe('module')
    expect(report.hop!.kind).toBe('module-export')
    expect(report.hop!.evaluated?.value).toBe(0.25)
    noNodePaths(report)
  })

  it('inspectBinding explains a missing name instead of throwing', () => {
    const r = inspectBinding({ code: `const a = 1\n`, name: 'zzz' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no occurrence/)
  })

  it('evaluateBinding folds a constant and projects the deopt without a NodePath', () => {
    const good = evaluateBinding({ code: `const k = 2 * 21\nexport const v = k\n`, name: 'k' })
    expect(good.ok).toBe(true)
    expect(good.confident).toBe(true)
    expect(good.value).toBe(42)
    noNodePaths(good)

    const bad = evaluateBinding({ code: `const k = Math.random()\nexport const v = k\n`, name: 'k' })
    expect(bad.confident).toBe(false)
    expect(bad.deoptType).toBeTruthy()
    expect((bad as any).deoptPath).toBeUndefined()
    noNodePaths(bad)
  })

  it('evaluateBinding bounds a huge folded string', () => {
    const r = evaluateBinding({ code: `const big = "${'x'.repeat(900)}"\nexport const v = big\n`, name: 'big' })
    expect(r.confident).toBe(true)
    expect(String(r.value).length).toBeLessThan(300)
    expect(String(r.value)).toMatch(/…\(900\)$/)
  })

  it('findMissingDeps gives exhaustiveDeps a reachable, file-level entry point', () => {
    const report = findMissingDeps({
      code:
        `import { useEffect, useState, useMemo } from 'react'\n` +
        `export function Comp({ userId }) {\n` +
        `  const [count, setCount] = useState(0)\n` +
        `  const [b, setB] = useState(0)\n` +
        `  useEffect(() => { setB(count) }, [userId])\n` +
        `  const memo = useMemo(() => count * 2, [])\n` +
        `  return [b, memo]\n` +
        `}\n`,
      withCodeFrames: true,
    })
    expect(report.ok).toBe(true)
    expect(report.effects.length).toBe(2)
    expect(report.effects.map((e) => e.hook).sort()).toEqual(['useEffect', 'useMemo'])
    expect(report.effects.every((e) => e.missing.includes('count'))).toBe(true)
    expect(report.effects[0].codeFrame).toContain('^')
    noNodePaths(report)
  })

  it('findMissingDeps reports nothing for a correct dependency array', () => {
    const report = findMissingDeps({
      code:
        `import { useEffect, useState } from 'react'\n` +
        `export function Comp() {\n` +
        `  const [c, setC] = useState(0)\n` +
        `  useEffect(() => { console.log(c) }, [c])\n` +
        `  return null\n` +
        `}\n`,
    })
    expect(report.effects).toEqual([])
  })

  it('findMissingDeps names a broken file rather than returning an empty scan', () => {
    const bad = path.join(dir, 'bad.ts')
    fs.writeFileSync(bad, `export const cfg = {\n`)
    const graph = buildModuleGraph({ root: dir, files: [bad] })
    const report = findMissingDeps({ file: bad, graph })
    expect(report.ok).toBe(false)
    expect(report.error).toContain('failed to parse')
  })

  it('a whole slice tree survives JSON with no live Babel objects in it', () => {
    const f = path.join(dir, 'tree.ts')
    fs.writeFileSync(
      f,
      `function target(p) { return p }\n` +
        `export function d1() { return target(1) }\n` +
        `export function d2() { return target('two') }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const slice = backwardSlice({ graph, startFile: f, startExpr: 'p' })
    const round = noNodePaths(slice)
    expect(round.divergence.agreement).toBe('divergent')
    expect(round.children.length).toBe(2)
  })

  it('graph.summary() is a bounded digest, not the graph', () => {
    const f = path.join(dir, 's.ts')
    fs.writeFileSync(f, `export function a() { return b() }\nfunction b() { return fetch('/x') }\n`)
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const s = graph.summary()
    expect(s.fileCount).toBe(1)
    expect(s.callSiteCount).toBeGreaterThan(0)
    expect(s.resolvedCallSiteCount).toBe(1) // b()
    expect(s.unresolvedByReason['no-binding']).toBe(1) // fetch
    noNodePaths(s)
  })
})

// ---------------------------------------------------------------------------
// Pre-fix behaviour, reproduced verbatim, so each defect is shown to have been
// real rather than asserted to have been. If one of these starts disagreeing
// with the original source, the proof has drifted and must be re-derived.
// ---------------------------------------------------------------------------

/** `isAsyncBoundary` as it stood: await at the TOP of the init, or `.then`/`.catch`. */
function legacyIsAsyncBoundary(binding: BindingInfo): boolean {
  const decl = binding.declPath
  if (!decl) return false
  const init = (decl.node as any).init
  if (init?.type === 'AwaitExpression') return true
  if (
    init?.type === 'CallExpression' &&
    init.callee?.type === 'MemberExpression' &&
    init.callee.property?.type === 'Identifier' &&
    (init.callee.property.name === 'then' || init.callee.property.name === 'catch')
  ) {
    return true
  }
  return false
}

/** `nextHopPaths` as it stood: one path, and only when there was exactly one caller. */
function legacyNextHopCount(callerCount: number, paramIndex: number): number {
  return callerCount === 1 && paramIndex >= 0 ? 1 : 0
}

describe('pre-fix behaviour proofs', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-proof-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('Defect 1: the bare-name key gave a one-caller function two callers', () => {
    const a = path.join(dir, 'a.ts')
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(a, `export function format(v) { return v }\nexport function callA() { return format(1) }\n`)
    fs.writeFileSync(b, `export function format(v) { return v }\nexport function callB() { return format(2) }\n`)
    const graph = buildModuleGraph({ root: dir, files: [a, b] })

    // What the old `classifyParam` looked up …
    const legacyCallers = graph.callSites.get('format')!.length
    expect(legacyCallers).toBe(2)
    // … so `callers.length === 1` failed and it reported interprocedural, and
    // `nextHopPaths` returned nothing to recurse into.
    expect(legacyNextHopCount(legacyCallers, 0)).toBe(0)

    // What the identity-keyed index looks up.
    const fn = graph.exportsByFile.get(a)!.get('format')!.node
    expect(graph.callersOfFunction(fn, a).length).toBe(1)
  })

  it('Defect 2: three callers used to yield zero children', () => {
    const f = path.join(dir, 'three3.ts')
    fs.writeFileSync(
      f,
      `function target(p) { return p + 1 }\n` +
        `export function d1() { return target(1) }\n` +
        `export function d2() { return target(2) }\n` +
        `export function d3() { return target(3) }\n`,
    )
    const graph = buildModuleGraph({ root: dir, files: [f] })
    expect(legacyNextHopCount(graph.callSites.get('target')!.length, 0)).toBe(0)

    const slice = backwardSlice({ graph, startFile: f, startExpr: 'p' })
    expect(slice.children!.length).toBe(3)
    // maxBreadth was therefore dead: slicing 3 callers at breadth 1 vs 3 could
    // not differ before, and now does.
    expect(backwardSlice({ graph, startFile: f, startExpr: 'p', maxBreadth: 1 }).children!.length).toBe(1)
  })

  it('Defect 4: the re-export marker the old lookup found points at nothing', () => {
    const c = path.join(dir, 'c.ts')
    const b = path.join(dir, 'b.ts')
    fs.writeFileSync(c, `export const RATE = 0.41\n`)
    fs.writeFileSync(b, `export { RATE as MID } from './c'\n`)
    const graph = buildModuleGraph({ root: dir, files: [b, c] })

    // The old code stopped exactly here, with a `module-export` hop whose
    // `evaluated` was null because the entry has no value node.
    const legacyEntry = graph.exportsByFile.get(b)!.get('MID')!
    expect(legacyEntry.node).toBe(null)
    expect(legacyEntry.path).toBe(null)
    expect(legacyEntry.reexport).toEqual({ source: './c', imported: 'RATE' })

    const res = graph.resolveExport(b, 'MID')
    expect(res.kind).toBe('found')
    if (res.kind === 'found') expect(res.file).toBe(c)
  })

  it('Defect 5: a broken file has no AST at all — the only trace of it is the failure record', () => {
    const bad = path.join(dir, 'bad.ts')
    fs.writeFileSync(bad, `export const cfg = {\n  a: 1,\n`)
    const graph = buildModuleGraph({ root: dir, files: [bad] })
    // The old symptom: nothing. No module, no exports, no explanation.
    expect(graph.getFile(bad)).toBe(null)
    expect(graph.exportsByFile.has(bad)).toBe(false)
    // The diagnosis now survives.
    expect(graph.parseFailures.get(bad)!.line).toBeGreaterThan(0)
  })

  it('Defect 6: the old detector missed every async shape but two', () => {
    const missed: { name: string; code: string; expr: string }[] = [
      { name: 'nested await', code: `async function f() { const n = (await load()).length; return n }`, expr: 'n' },
      { name: '.finally', code: `function f(p) { const v = p.finally(() => 1); return v }`, expr: 'v' },
      { name: 'Promise.all', code: `function f(a) { const rs = Promise.all([a]); return rs }`, expr: 'rs' },
      { name: 'Promise.race', code: `function f(a) { const rs = Promise.race([a]); return rs }`, expr: 'rs' },
      { name: 'new Promise', code: `function f() { const p = new Promise((r) => r(1)); return p }`, expr: 'p' },
      { name: 'async call', code: `async function load() { return 1 }\nfunction f() { const p = load(); return p }`, expr: 'p' },
      { name: 'yield', code: `function* g() { const v = yield 1; return v }`, expr: 'v' },
    ]
    const f = path.join(dir, 'async-proof.ts')
    for (const c of missed) {
      fs.writeFileSync(f, c.code + '\n')
      const graph = buildModuleGraph({ root: dir, files: [f] })
      const info = infoOf(c.code, c.expr)
      expect(legacyIsAsyncBoundary(info), `${c.name} slipped past the old check`).toBe(false)
      expect(classifyAsyncBoundary(info, graph, f), `${c.name} must be recognised now`).not.toBe(null)
    }

    // The two it did catch still work.
    const kept = `async function f() { const d = await load(); return d }`
    expect(legacyIsAsyncBoundary(infoOf(kept, 'd'))).toBe(true)
    expect(classifyAsyncBoundary(infoOf(kept, 'd'))).not.toBe(null)
  })

  it('Defect 6: a then-callback parameter used to be misfiled as interprocedural', () => {
    const f = path.join(dir, 'thenparam.ts')
    fs.writeFileSync(f, `export function f(p) {\n  p.then((data) => use(data))\n}\n`)
    const graph = buildModuleGraph({ root: dir, files: [f] })
    const info = infoOf(fs.readFileSync(f, 'utf8'), 'data')
    // The old ordering hit the `param` branch first, found an anonymous function
    // with no callers, and prescribed a captureArgs probe for a promise result.
    expect(info.kind).toBe('param')
    expect(legacyIsAsyncBoundary(info)).toBe(false)
    // Now it names the right boundary, which selects the race-safe probe.
    expect(backwardSlice({ graph, startFile: f, startExpr: 'data' }).blockedBy).toBe('async')
  })
})
