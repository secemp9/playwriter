/**
 * read-page: the function the model passes is rewritten (AST) before it runs in the page — a budget
 * tick at every function entry and loop iteration, Chrome's unmarked reads routed to exact shims,
 * console.* collected, object spread copied by a shim. A rewrite that changes what the function
 * computes would make readPage answer wrongly with no sign of it, so each case runs the original and
 * the instrumented source side by side in Node, with a helper whose shims call the native methods,
 * and requires the same result.
 */

import { describe, expect, it } from 'vitest'
import { prepareRead } from './read-page.js'

interface Calls {
  ticks: number
  shims: string[]
  logs: Array<[string, string]>
  /** Locate events: `b<site>` when a call starts, `e<site>` when it ends. */
  events: string[]
}

/** The instrumented source as a function, with a helper that records what it was asked and answers natively. */
function instrumented(fn: Function, locate = false): { run: (...args: unknown[]) => unknown; calls: Calls } {
  const { instrumented: source } = prepareRead(fn, { locate })
  const calls: Calls = { ticks: 0, shims: [], logs: [], events: [] }
  const native = (name: string) => (receiver: Record<string, (...args: unknown[]) => unknown>, ...args: unknown[]) => {
    calls.shims.push(name)
    return receiver[name](...args)
  }
  const helper = {
    tick: () => {
      calls.ticks++
    },
    begin: (site: number) => {
      calls.events.push(`b${site}`)
    },
    end: (site: number, value: unknown) => {
      calls.events.push(`e${site}`)
      return value
    },
    closest: native('closest'),
    matches: native('matches'),
    webkitMatchesSelector: native('webkitMatchesSelector'),
    getRootNode: native('getRootNode'),
    getElementById: native('getElementById'),
    isSameNode: native('isSameNode'),
    toString: native('toString'),
    getItem: native('getItem'),
    key: native('key'),
    toJSON: native('toJSON'),
    getPropertyValue: native('getPropertyValue'),
    fromEntries: (entries: Iterable<readonly [PropertyKey, unknown]>) => {
      calls.shims.push('fromEntries')
      return Object.fromEntries(entries)
    },
    assign: (target: object, ...sources: object[]) => {
      calls.shims.push('assign')
      return Object.assign(target, ...sources)
    },
    spread: (...parts: object[]) => {
      calls.shims.push('spread')
      return parts.reduce((out, part) => ({ ...out, ...part }), {})
    },
    log: (level: string, ...values: unknown[]) => {
      calls.logs.push([level, values.map(String).join(' ')])
    },
    member: (receiver: unknown, name: string, receiverOptional: boolean, callOptional: boolean) => {
      if (receiver === null || receiver === undefined) {
        if (receiverOptional) return undefined
        throw new TypeError(`Cannot read properties of ${String(receiver)} (reading '${name}')`)
      }
      if (Reflect.get(Object(receiver), name) == null) {
        if (callOptional) return undefined
        throw new TypeError(`${name} is not a function`)
      }
      const shim: unknown = Reflect.get(helper, name)
      if (typeof shim !== 'function') throw new Error(`no shim ${name}`)
      return (...args: unknown[]) => Reflect.apply(shim, undefined, [receiver, ...args])
    },
  }
  const build = new Function('__playwriterRead', `return (\n${source}\n)`)
  const run: unknown = build(helper)
  if (typeof run !== 'function') throw new Error(`the instrumented source is not a function:\n${source}`)
  return { run: (...args: unknown[]) => Reflect.apply(run, undefined, args), calls }
}

/** A receiver with the shimmed methods, answering from plain data. */
const element = {
  id: 'buy',
  closest: (selector: string) => (selector === 'tr' ? { id: 'row', closest: (inner: string) => ({ id: `table of ${inner}` }) } : null),
  matches: (selector: string) => selector === '#buy',
  getItem: (key: string) => (key === 'cart' ? '3 items' : null),
  toString: () => 'element',
}

describe('readPage instrumentation keeps what the function computes', () => {
  const cases: Array<{ name: string; fn: Function; args?: unknown[]; shims: string[] }> = [
    { name: 'a shimmed call', fn: (el: typeof element) => el.closest('tr')?.id, args: [element], shims: ['closest'] },
    { name: 'shimmed calls in a chain, the second after ?.', fn: (el: typeof element) => el.closest('tr')?.closest('table'), args: [element], shims: ['closest', 'closest'] },
    { name: '?. on the receiver, receiver present', fn: (el: typeof element | null) => el?.closest('tr')?.id, args: [element], shims: ['closest'] },
    {
      name: '?. on the receiver, receiver null: the whole chain stops',
      fn: (el: { closest: (selector: string) => { id: string } } | null) => el?.closest('tr').id,
      args: [null],
      shims: [],
    },
    { name: '?.( on the call, method present', fn: (el: typeof element) => el.matches?.('#buy'), args: [element], shims: ['matches'] },
    { name: '?.( on the call, method missing', fn: (el: { id: string; matches?: (s: string) => boolean }) => el.matches?.('#buy'), args: [{ id: 'x' }], shims: [] },
    {
      name: 'a shim after an earlier ?. in the chain stays native',
      fn: (el: { inner?: typeof element }) => el?.inner?.closest('tr')?.id,
      args: [{ inner: element }],
      shims: [],
    },
    { name: 'a parenthesized receiver', fn: (el: typeof element) => (el || null).matches('#buy'), args: [element], shims: ['matches'] },
    { name: 'a computed member', fn: (el: typeof element) => el['getItem']('cart'), args: [element], shims: ['getItem'] },
    { name: 'no arguments', fn: (el: typeof element) => el.toString(), args: [element], shims: ['toString'] },
    { name: 'a number with a radix', fn: () => (255).toString(16), shims: ['toString'] },
    {
      name: 'object spread with entries around it',
      fn: () => {
        const maybe = (present: boolean): object | null => (present ? { e: 6 } : null)
        return { a: 1, ...{ b: 2, c: 3 }, c: 4, ...maybe(false), d: [5], ...maybe(true) }
      },
      shims: ['spread'],
    },
    { name: 'object spread first and last', fn: () => ({ ...{ x: 1 }, y: 2, ...{ z: 3 } }), shims: ['spread'] },
    { name: 'object spread inside a shim call', fn: (el: typeof element) => el.closest({ ...{ s: 'tr' } }.s)?.id, args: [element], shims: ['spread', 'closest'] },
    { name: 'Object.fromEntries and Object.assign', fn: () => [Object.fromEntries([['a', 1]]), Object.assign({}, { b: 2 })], shims: ['fromEntries', 'assign'] },
    {
      name: 'loops of every kind, labelled, with bodies that are not blocks',
      fn: () => {
        let total = 0
        outer: for (let i = 0; i < 3; i++) for (const n of [1, 2]) {
          if (n === 2) continue outer
          total += n
        }
        let k = 0
        while (k < 2) k++
        do k++
        while (k < 4)
        for (const key in { a: 1, b: 2 }) total += key.length
        for (;;) break
        return total + k
      },
      shims: [],
    },
    {
      name: 'directives, getters, methods and nested functions',
      fn: function () {
        'use strict'
        const data = { get double() { return 2 * this.base }, base: 21, half() { return this.base / 2 } }
        const inner = (n: number) => n + 1
        return [data.double, data.half(), inner(1)]
      },
      shims: [],
    },
    { name: 'a shim name on a local function is still the same call', fn: () => { const matches = (s: string) => s; return matches('x') }, shims: [] },
  ]
  for (const testCase of cases) {
    for (const locate of [false, true]) {
      it(`${testCase.name}${locate ? ' (instrumented to locate a refusal)' : ''}`, () => {
        const args = testCase.args ?? []
        const { run, calls } = instrumented(testCase.fn, locate)
        expect(run(...args)).toEqual(Reflect.apply(testCase.fn, undefined, args))
        expect(calls.shims).toEqual(testCase.shims)
        expect(calls.ticks).toBeGreaterThan(0)
        // Every call counted to locate a refusal starts and ends, in order.
        if (locate) expect(calls.events.filter((event) => event.startsWith('b')).length).toBe(calls.events.filter((event) => event.startsWith('e')).length)
      })
    }
  }

  it('counts each call as a start and an end, an inner call inside the outer one, and names them', () => {
    const config = { values: { title: 'Read me' }, get(key: 'title') { return this.values[key] } }
    const doc = { querySelector: (selector: string) => ({ id: selector === 'h1' ? 'title' : 'other' }) }
    const fn = (page: { doc: typeof doc; config: typeof config }) => page.config.get(page.doc.querySelector('h1').id === 'title' ? 'title' : 'title')
    const { run, calls } = instrumented(fn, true)
    expect(run({ doc, config })).toBe('Read me')
    expect(calls.events).toEqual(['b0', 'b1', 'e1', 'e0'])
    const { sites } = prepareRead(fn, { locate: true })
    // The test transpiler may requote string literals: compare the calls with one quote style.
    expect(sites.map(({ call, name, receiver, enclosing, construct }) => ({ call: call.replaceAll('"', "'"), name, receiver, enclosing, construct }))).toEqual([
      { call: "page.config.get(page.doc.querySelector('h1').id === 'title' ? 'title' : 'title')", name: 'get', receiver: 'page.config', enclosing: null, construct: false },
      { call: "page.doc.querySelector('h1')", name: 'querySelector', receiver: 'page.doc', enclosing: 0, construct: false },
    ])
  })

  it('keeps an optional chain short-circuiting when locating: only its outermost call is counted', () => {
    type Link = { f: () => { g: () => string } }
    const fn = (o: Link | null) => o?.f().g()
    const located = instrumented(fn, true)
    expect(located.run(null)).toBeUndefined()
    expect(located.run({ f: () => ({ g: () => 'ok' }) })).toBe('ok')
    expect(located.calls.events).toEqual(['b0', 'e0', 'b0', 'e0'])
    expect(prepareRead(fn, { locate: true }).sites.map((site) => site.call)).toEqual(['o?.f().g()'])
  })

  it('ticks on every loop iteration and every call, so an endless loop reaches the budget', () => {
    const { run, calls } = instrumented(() => {
      let n = 0
      const step = () => n++
      while (n < 5) step()
      return n
    })
    expect(run()).toBe(5)
    // The function itself, 5 iterations, 5 calls of step.
    expect(calls.ticks).toBe(11)
  })

  it('collects console.* with its level instead of logging', () => {
    const { run, calls } = instrumented(() => {
      console.log('a', 1)
      console.warn()
      console.table([1])
      return 0
    })
    expect(run()).toBe(0)
    expect(calls.logs).toEqual([
      ['log', 'a 1'],
      ['warn', ''],
      ['log', '1'],
    ])
  })

  it('leaves a console or Object the function binds itself alone', () => {
    const { run, calls } = instrumented(() => {
      const console = { log: (s: string) => `own ${s}` }
      const Object = { assign: () => 'own assign' }
      return [console.log('x'), Object.assign()]
    })
    expect(run()).toEqual(['own x', 'own assign'])
    expect(calls.logs).toEqual([])
    expect(calls.shims).toEqual([])
  })
})

describe('readPage refuses what cannot run under the check before sending it', () => {
  it.each([
    ['async', async () => 1, 'is async'],
    ['await inside', () => async function () { await 1 }, 'is async'],
    ['generator', () => { function* g() { yield 1 } return g }, 'generator function'],
    ['not a function', 'document.title', 'must be a function'],
    ['a method', { read() { return 1 } }.read, 'written inline'],
    ['a built-in', Math.max, 'written inline'],
  ])('%s', (_name, fn, says) => {
    expect(() => prepareRead(fn)).toThrow(says)
  })

  it('names the calls V8 refuses, by line, with what to use', () => {
    const { unmarked } = prepareRead(function (el: { getClientRects: () => unknown[] }) {
      const rects = el.getClientRects()
      return { ...[rects.length] }.length ? new URL('/x', 'http://x').pathname : arguments.length
    })
    expect(unmarked.map((site) => `${site.call}@${site.line}`)).toEqual(['getClientRects()@2', 'new URL()@3', 'arguments@3'])
  })
})
