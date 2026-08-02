import { describe, it, expect } from 'vitest'
import { Debugger, buildLogpointCondition, verifyNonPausingCondition, readRemoteObject, newPreviewAccounting } from './debugger.js'
import type { ICDPSession } from './cdp-session.js'

// A minimal mock ICDPSession: records sent commands, lets tests emit events, and
// returns canned responses via a per-test responder.
class MockCdp {
  sent: Array<{ method: string; params: any }> = []
  private listeners = new Map<string, Set<(p: any) => void>>()
  responder: (method: string, params: any) => any

  constructor(responder?: (method: string, params: any) => any) {
    this.responder = responder ?? (() => ({}))
  }

  async send(method: any, params?: any): Promise<any> {
    this.sent.push({ method, params })
    return this.responder(method, params) ?? {}
  }

  on(event: any, cb: any) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
    return this
  }

  off(event: any, cb: any) {
    this.listeners.get(event)?.delete(cb)
    return this
  }

  async detach() {}

  emit(event: string, params: any) {
    for (const cb of this.listeners.get(event) ?? []) cb(params)
  }

  find(method: string) {
    return this.sent.find((s) => s.method === method)
  }
}

function asCdp(mock: MockCdp): ICDPSession {
  return mock as unknown as ICDPSession
}

describe('verifyNonPausingCondition', () => {
  it('accepts the condition the builder generates', () => {
    const c = buildLogpointCondition({ tag: 'total', expr: 'state.total' })
    expect(verifyNonPausingCondition(c)).toEqual({ nonPausing: true, problems: [] })
  })

  it('accepts an expr containing a comma (a sequence expression cannot pause)', () => {
    const c = buildLogpointCondition({ tag: 't', expr: 'a, b' })
    expect(verifyNonPausingCondition(c).nonPausing).toBe(true)
  })

  it('rejects an unbalanced expr that would break out of the wrapper', () => {
    const c = buildLogpointCondition({ tag: 't', expr: '1),true' })
    const check = verifyNonPausingCondition(c)
    expect(check.nonPausing).toBe(false)
    expect(check.problems.join(' ')).toMatch(/does not parse/)
  })

  it('rejects an injected `return true` even when it parses', () => {
    // A hostile expr closing the try block and injecting its own return.
    const c = buildLogpointCondition({ tag: 't', expr: '0)}catch(e){}return true;try{(0' })
    const check = verifyNonPausingCondition(c)
    expect(check.nonPausing).toBe(false)
    expect(check.problems.join(' ')).toMatch(/does not parse|returns `BooleanLiteral`|instead of the literal/)
  })

  it('rejects a `debugger` statement, which pauses regardless of the value', () => {
    const c = buildLogpointCondition({ tag: 't', expr: '(function(){debugger; return 1})()' })
    const check = verifyNonPausingCondition(c)
    expect(check.nonPausing).toBe(false)
    expect(check.problems.join(' ')).toMatch(/`debugger` statement/)
  })

  it('rejects a bare truthy condition and an unconditional breakpoint', () => {
    expect(verifyNonPausingCondition('true').nonPausing).toBe(false)
    expect(verifyNonPausingCondition('x === 1').nonPausing).toBe(false)
    expect(verifyNonPausingCondition('(console.log(1),false)').nonPausing).toBe(false)
  })

  it('sanitizes a tag that would break out of the marker string literal', () => {
    const c = buildLogpointCondition({ tag: 'x"+alert(1)+"', expr: '1' })
    expect(c).not.toContain('alert(1)')
    expect(verifyNonPausingCondition(c).nonPausing).toBe(true)
  })
})

describe('setLogpoint', () => {
  it('refuses a hostile expr instead of installing a pausing breakpoint', async () => {
    const mock = new MockCdp((method) => (method === 'Debugger.setBreakpointByUrl' ? { breakpointId: 'bp-x', locations: [{ scriptId: '1', lineNumber: 0, columnNumber: 0 }] } : {}))
    const dbg = new Debugger({ cdp: asCdp(mock) })
    for (const expr of ['1),true', '0)}catch(e){}return true;try{(0', '(function(){debugger})()', '1; return true']) {
      await expect(dbg.setLogpoint({ file: 'app.js', line: 1, expr })).rejects.toThrow(/not provably non-pausing/)
    }
    // Nothing was sent to the browser.
    expect(mock.find('Debugger.setBreakpointByUrl')).toBeUndefined()
  })

  it('records the breakpoint as non-pausing', async () => {
    const mock = new MockCdp((method) => (method === 'Debugger.setBreakpointByUrl' ? { breakpointId: 'bp-1', locations: [{ scriptId: '1', lineNumber: 0, columnNumber: 0 }] } : {}))
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.setLogpoint({ file: 'app.js', line: 7, expr: 'x' })
    // `bound` / `resolvedLocations` are part of the record now: an id alone does not
    // prove a breakpoint can ever fire (CDP returns one even when nothing binds).
    expect(dbg.listBreakpoints()).toEqual([
      {
        id: 'bp-1',
        file: 'app.js',
        line: 7,
        condition: expect.any(String),
        nonPausing: true,
        bound: true,
        resolvedLocations: [{ scriptId: '1', lineNumber: 0, columnNumber: 0, url: '' }],
      },
    ])
  })

  it('caps the payload in the page at maxPayload', async () => {
    const mock = new MockCdp((method) => (method === 'Debugger.setBreakpointByUrl' ? { breakpointId: 'bp-2', locations: [{ scriptId: '1', lineNumber: 0, columnNumber: 0 }] } : {}))
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.setLogpoint({ file: 'app.js', line: 1, expr: 'x', maxPayload: 128 })
    expect(mock.find('Debugger.setBreakpointByUrl')!.params.condition).toContain('__playwriter_logpoint_truncated')
    expect(mock.find('Debugger.setBreakpointByUrl')!.params.condition).toContain('128')
  })

  it('sends Debugger.setBreakpointByUrl with a non-pausing (…,false) tagged condition', async () => {
    const mock = new MockCdp((method) => {
      if (method === 'Debugger.setBreakpointByUrl') return { breakpointId: 'bp-1', locations: [{ scriptId: '1', lineNumber: 0, columnNumber: 0 }] }
      return {}
    })
    const dbg = new Debugger({ cdp: asCdp(mock) })

    const id = await dbg.setLogpoint({ file: 'app.js', line: 42, expr: 'state.total', tag: 'total' })
    expect(id).toBe('bp-1')

    const call = mock.find('Debugger.setBreakpointByUrl')
    expect(call).toBeTruthy()
    const condition: string = call!.params.condition
    // Never pauses — and that is PROVEN over the assembled string, not asserted by
    // shape-matching the tail.
    expect(verifyNonPausingCondition(condition)).toEqual({ nonPausing: true, problems: [] })
    expect(condition.trim().endsWith('return false})()')).toBe(true)
    // Tagged + carries the expression.
    expect(condition).toContain('[[logpoint:total]]')
    expect(condition).toContain('var __pwV=(state.total)')
    // Correct line (1-based -> 0-based).
    expect(call!.params.lineNumber).toBe(41)
  })

  it('defaults the tag when none is given', async () => {
    const mock = new MockCdp((method) => (method === 'Debugger.setBreakpointByUrl' ? { breakpointId: 'bp-2', locations: [{ scriptId: '1', lineNumber: 0, columnNumber: 0 }] } : {}))
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.setLogpoint({ file: 'app.js', line: 1, expr: 'x' })
    expect(mock.find('Debugger.setBreakpointByUrl')!.params.condition).toContain('[[logpoint:lp]]')
  })
})

describe('getScriptSourceByUrl', () => {
  it('resolves url -> scriptId via the scripts map and returns the source', async () => {
    const mock = new MockCdp((method, params) => {
      if (method === 'Debugger.getScriptSource') {
        return { scriptSource: params.scriptId === 's1' ? 'console.log(1)' : 'other' }
      }
      return {}
    })
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.enable()
    // Populate the scripts map the way the real scriptParsed event would.
    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: 'https://example.com/app.js' })

    const exact = await dbg.getScriptSourceByUrl({ url: 'https://example.com/app.js' })
    expect(exact).toEqual({ url: 'https://example.com/app.js', scriptId: 's1', source: 'console.log(1)' })

    // Substring fallback also resolves.
    const partial = await dbg.getScriptSourceByUrl({ url: 'app.js' })
    expect(partial?.scriptId).toBe('s1')
  })

  it('returns null when no script matches', async () => {
    const mock = new MockCdp()
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.enable()
    expect(await dbg.getScriptSourceByUrl({ url: 'nope.js' })).toBeNull()
  })
})

describe('runNonPausingOnly — the guarantee is structural, not documentary', () => {
  const paused = (mock: MockCdp) =>
    mock.emit('Debugger.paused', {
      callFrames: [
        {
          callFrameId: 'f0',
          functionName: 'top',
          url: 'app.js',
          location: { scriptId: 's1', lineNumber: 0, columnNumber: 0 },
          this: { type: 'undefined' },
          scopeChain: [{ type: 'local', object: { type: 'object', objectId: 'local-0' } }],
        },
      ],
    })

  it('refuses an unconditional breakpoint, and every other pausing surface', async () => {
    const mock = new MockCdp((method) => (method === 'Debugger.setBreakpointByUrl' ? { breakpointId: 'bp-1', locations: [{ scriptId: '1', lineNumber: 0, columnNumber: 0 }] } : {}))
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.runNonPausingOnly(async () => {
      await expect(dbg.setBreakpoint({ file: 'app.js', line: 1 })).rejects.toThrow(/refusing to set a pausing breakpoint/)
      await expect(dbg.setBreakpoint({ file: 'app.js', line: 1, condition: 'x === 1' })).rejects.toThrow(/refusing to set a pausing breakpoint/)
      await expect(dbg.setPauseOnExceptions({ state: 'all' })).rejects.toThrow(/refusing setPauseOnExceptions/)
      await expect(dbg.setXHRBreakpoint({ url: '/api' })).rejects.toThrow(/refusing setXHRBreakpoint/)
      // A verified logpoint is still allowed — that is the whole point.
      await expect(dbg.setLogpoint({ file: 'app.js', line: 1, expr: 'x' })).resolves.toBe('bp-1')
      // 'none' is not a pause.
      await expect(dbg.setPauseOnExceptions({ state: 'none' })).resolves.toBeUndefined()
    }, { reason: 'race-class probe' })

    // Outside the guard, a pausing breakpoint is allowed again.
    expect(dbg.isNonPausingOnly()).toBe(false)
    await expect(dbg.setBreakpoint({ file: 'app.js', line: 1 })).resolves.toBe('bp-1')
  })

  it('names the reason in the refusal and composes when nested', async () => {
    const mock = new MockCdp()
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.runNonPausingOnly(
      async () => {
        await dbg.runNonPausingOnly(async () => {
          expect(dbg.isNonPausingOnly()).toBe(true)
        })
        // Still guarded after the inner scope exits.
        expect(dbg.isNonPausingOnly()).toBe(true)
        await expect(dbg.setBreakpoint({ file: 'a.js', line: 2 })).rejects.toThrow(/ordering under test/)
      },
      { reason: 'ordering under test' },
    )
    expect(dbg.isNonPausingOnly()).toBe(false)
  })

  it('restores the guard even when the body throws', async () => {
    const mock = new MockCdp()
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await expect(
      dbg.runNonPausingOnly(async () => {
        throw new Error('probe failed')
      }),
    ).rejects.toThrow('probe failed')
    expect(dbg.isNonPausingOnly()).toBe(false)
  })

  void paused
})

describe('inspectLocalVariables', () => {
  const pausedFrames = (mock: MockCdp) =>
    mock.emit('Debugger.paused', {
      callFrames: [
        {
          callFrameId: 'f0',
          functionName: 'inner',
          url: 'app.js',
          location: { scriptId: 's1', lineNumber: 9, columnNumber: 4 },
          this: { type: 'undefined' },
          scopeChain: [
            { type: 'local', object: { type: 'object', objectId: 'local-0' } },
            { type: 'closure', object: { type: 'object', objectId: 'closure-0' } },
            { type: 'global', object: { type: 'object', objectId: 'global-0' } },
          ],
        },
        { callFrameId: 'f1', functionName: 'outer', url: 'app.js', location: { scriptId: 's1', lineNumber: 20, columnNumber: 0 }, scopeChain: [] },
      ],
    })

  it('lets the INNERMOST scope win instead of letting a closure overwrite a shadowed local', async () => {
    const mock = new MockCdp((method, params) => {
      if (method === 'Runtime.getProperties') {
        if (params.objectId === 'local-0') {
          return { result: [{ name: 'count', value: { type: 'number', value: 1 }, configurable: true }] }
        }
        if (params.objectId === 'closure-0') {
          return {
            result: [
              { name: 'count', value: { type: 'number', value: 99 }, configurable: true },
              { name: 'captured', value: { type: 'string', value: 'outer' }, configurable: true },
            ],
          }
        }
      }
      return { result: [] }
    })
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.enable()
    pausedFrames(mock)

    const res = await dbg.inspectLocalVariables()
    // The local, not the closure's shadowed copy.
    expect(res.variables.count).toBe(1)
    expect(res.variables.captured).toBe('outer')
    expect(res.scopes.map((s) => s.type)).toEqual(['local', 'closure'])
    expect(res.scopes[1].shadowed).toEqual(['count'])
    expect(res.limits.globalScopeSkipped).toBe(true)
  })

  it('states its limits in the return shape', async () => {
    const mock = new MockCdp((method, params) => {
      if (method === 'Runtime.getProperties' && params.objectId === 'local-0') {
        return {
          result: [
            // Objects used to collapse to the string '[object]' — content is kept now.
            {
              name: 'user',
              configurable: true,
              value: {
                type: 'object',
                preview: { properties: [{ name: 'id', type: 'number', value: 7 }] },
              },
            },
            // Non-configurable properties used to be dropped SILENTLY.
            { name: 'arguments', value: { type: 'string', value: 'kept' }, configurable: false },
          ],
        }
      }
      return { result: [] }
    })
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.enable()
    pausedFrames(mock)

    const res = await dbg.inspectLocalVariables()
    expect(res.variables.user).toEqual({ id: 7 })
    expect(res.variables.arguments).toBe('kept')
    expect(res.frame).toMatchObject({ functionName: 'inner', url: 'app.js', line: 10, column: 4, index: 0, totalFrames: 2 })
    expect(res.limits.topFrameOnly).toBe(true)
    expect(res.limits.note).toMatch(/top frame only \(2 frame\(s\)/)
    expect(res.limits.note).toMatch(/getCallFrames/)
  })

  it('marks an unreadable scope instead of skipping it silently', async () => {
    const mock = new MockCdp(() => {
      throw new Error('detached')
    })
    const dbg = new Debugger({ cdp: asCdp(mock) })
    // enable() itself would throw with this responder, so pause via a working mock.
    const ok = new MockCdp()
    const dbg2 = new Debugger({ cdp: asCdp(ok) })
    await dbg2.enable()
    ok.emit('Debugger.paused', {
      callFrames: [
        {
          callFrameId: 'f0',
          functionName: 'x',
          url: 'a.js',
          location: { scriptId: 's', lineNumber: 0, columnNumber: 0 },
          scopeChain: [{ type: 'local', object: { type: 'object' } }],
        },
      ],
    })
    const res = await dbg2.inspectLocalVariables()
    expect(res.scopes).toEqual([{ type: 'local', variableCount: 0, shadowed: [], unreadable: true }])
    void dbg
  })

  it('throws when not paused', async () => {
    const dbg = new Debugger({ cdp: asCdp(new MockCdp()) })
    await expect(dbg.inspectLocalVariables()).rejects.toThrow(/not paused/)
  })
})

// CDP hands nested values back as STRINGS for every type ("user-friendly property
// value string") with the real type in `type`/`subtype`. Reading `value` without
// consulting `type` turned the number 10 into "10" — a debugger that confirms a
// type bug that does not exist. Fixtures below are verbatim CDP payloads captured
// from Chromium (see debugger-live.test.ts for the same assertions end-to-end).
describe('readRemoteObject — nested values keep their real types', () => {
  const prop = (name: string, type: string, value?: string, subtype?: string) => ({ name, type, value, subtype })

  it('reconstructs every primitive type from a preview', () => {
    const v = readRemoteObject({
      type: 'object',
      className: 'Object',
      description: 'Object',
      objectId: '1',
      preview: {
        type: 'object',
        description: 'Object',
        overflow: false,
        properties: [
          prop('real', 'number', '10'),
          prop('looks', 'string', '10'),
          prop('flag', 'boolean', 'true'),
          prop('off', 'boolean', 'false'),
          prop('nothing', 'object', 'null', 'null'),
          prop('missing', 'undefined', 'undefined'),
          prop('nan', 'number', 'NaN'),
          prop('inf', 'number', '-Infinity'),
          prop('negZero', 'number', '-0'),
          prop('frac', 'number', '0.30000000000000004'),
          prop('big', 'bigint', '9007199254740993n'),
          prop('sym', 'symbol', 'Symbol(tag)'),
          prop('fn', 'function', ''),
          prop('lazy', 'accessor'),
        ] as any,
      },
    } as any) as Record<string, unknown>

    // The load-bearing pair: same text, different types, told apart exactly.
    expect(v.real).toBe(10)
    expect(typeof v.real).toBe('number')
    expect(v.looks).toBe('10')
    expect(typeof v.looks).toBe('string')

    expect(v.flag).toBe(true)
    expect(v.off).toBe(false)
    expect(v.nothing).toBeNull()
    expect(v.missing).toBeUndefined()
    expect(Number.isNaN(v.nan as number)).toBe(true)
    expect(v.inf).toBe(-Infinity)
    expect(Object.is(v.negZero, -0)).toBe(true)
    expect(v.frac).toBe(0.30000000000000004)
    // BigInt cannot be JSON-serialised, so it is a marker carrying the exact literal.
    expect(v.big).toBe('[bigint 9007199254740993n]')
    expect(v.sym).toBe('[symbol Symbol(tag)]')
    expect(v.fn).toBe('[function]')
    // A getter is never invoked: invoking it could mutate the page under measurement.
    expect(v.lazy).toBe('[accessor]')
  })

  it('keeps an array of numbers a number array, and a mixed array exact', () => {
    const arr = (props: any[], overflow = false, description = `Array(${props.length})`) =>
      readRemoteObject({
        type: 'object',
        subtype: 'array',
        description,
        objectId: '1',
        preview: { type: 'object', subtype: 'array', description, overflow, properties: props },
      } as any)

    expect(arr([prop('0', 'number', '10'), prop('1', 'number', '20'), prop('2', 'number', '30')])).toEqual([10, 20, 30])
    expect(
      arr([
        prop('0', 'number', '1'),
        prop('1', 'string', 'two'),
        prop('2', 'boolean', 'true'),
        prop('3', 'object', 'null', 'null'),
        prop('4', 'undefined', 'undefined'),
      ]),
    ).toEqual([1, 'two', true, null, undefined])
  })

  it('reports array truncation WITHOUT lengthening the array', () => {
    const accounting = newPreviewAccounting()
    const value = readRemoteObject(
      {
        type: 'object',
        subtype: 'array',
        description: 'Array(150)',
        objectId: '1',
        preview: {
          type: 'object',
          subtype: 'array',
          description: 'Array(150)',
          overflow: true,
          properties: [prop('0', 'number', '7'), prop('1', 'number', '7')] as any,
        },
      } as any,
      { path: 'many', accounting },
    )
    // The old code appended a synthetic '…' key which Object.values turned into an
    // extra ELEMENT, so the array read as longer than the browser actually sent.
    expect(value).toEqual([7, 7])
    expect((value as unknown[]).length).toBe(2)
    expect(accounting.overflowed).toHaveLength(1)
    expect(accounting.overflowed[0]).toMatch(/many: Array\(150\) — the browser sent only the first 2 item\(s\)/)
  })

  it('keeps a non-index property off the array shape and says so', () => {
    const accounting = newPreviewAccounting()
    const value = readRemoteObject(
      {
        type: 'object',
        subtype: 'array',
        description: 'Array(2)',
        objectId: '1',
        preview: {
          type: 'object',
          subtype: 'array',
          description: 'Array(2)',
          overflow: false,
          properties: [prop('0', 'number', '1'), prop('1', 'number', '2'), prop('foo', 'string', 'bar')] as any,
        },
      } as any,
      { path: 'arr', accounting },
    )
    expect(value).toEqual([1, 2])
    expect(accounting.overflowed[0]).toMatch(/non-index property foo/)
  })

  it('renders a Date as a Date marker, not as an empty object', () => {
    const desc = 'Thu Jan 01 1970 01:00:00 GMT+0100'
    const value = readRemoteObject({
      type: 'object',
      subtype: 'date',
      description: desc,
      objectId: '1',
      preview: { type: 'object', subtype: 'date', description: desc, overflow: false, properties: [] },
    } as any)
    // Reading only `properties` (which is empty for a Date) produced `{}`.
    expect(value).toBe(`[date ${desc}]`)
  })

  it('keeps a Map/Set’s entries instead of reporting only its size', () => {
    const entryPrev = (type: string, description: string) => ({ type, description, overflow: false, properties: [] })
    const map = readRemoteObject({
      type: 'object',
      subtype: 'map',
      description: 'Map(2)',
      objectId: '1',
      preview: {
        type: 'object',
        subtype: 'map',
        description: 'Map(2)',
        overflow: false,
        properties: [prop('size', 'number', '2')] as any,
        entries: [
          { key: entryPrev('string', 'a'), value: entryPrev('number', '1') },
          { key: entryPrev('string', 'b'), value: entryPrev('number', '2') },
        ] as any,
      },
    } as any)
    // Previously: `{ size: "2" }` — the entries were dropped and the size stringified.
    expect(map).toEqual({
      '[collection]': 'Map(2)',
      '[entries]': [
        ['a', 1],
        ['b', 2],
      ],
    })

    const set = readRemoteObject({
      type: 'object',
      subtype: 'set',
      description: 'Set(2)',
      objectId: '1',
      preview: {
        type: 'object',
        subtype: 'set',
        description: 'Set(2)',
        overflow: false,
        properties: [prop('size', 'number', '2')] as any,
        entries: [{ value: entryPrev('number', '1') }, { value: entryPrev('number', '2') }] as any,
      },
    } as any)
    expect(set).toEqual({ '[collection]': 'Set(2)', '[entries]': [1, 2] })
  })

  it('marks a nested container the browser never previewed', () => {
    const value = readRemoteObject({
      type: 'object',
      description: 'Object',
      objectId: '1',
      preview: {
        type: 'object',
        description: 'Object',
        overflow: false,
        properties: [prop('nested', 'object', 'Object'), prop('tags', 'object', 'Array(2)', 'array')] as any,
      },
    } as any) as Record<string, unknown>
    // `'Object'` as a bare value would read as the STRING "Object".
    expect(value.nested).toBe('[object Object]')
    expect(value.tags).toBe('[array Array(2)]')
  })

  it('caps only real strings, and reports both cap kinds', () => {
    const accounting = newPreviewAccounting()
    const long = 'z'.repeat(20000)
    expect(readRemoteObject({ type: 'string', value: long } as any, { path: 'big', accounting })).toBe(
      long.slice(0, 10000) + ' '.repeat(0) + `... (20000 chars)`,
    )
    expect(accounting.cappedStrings[0]).toMatch(/big: capped at 10000 of 20000 chars/)

    // V8 caps preview strings at 100 chars with a mid-string …, and flags nothing.
    const acc2 = newPreviewAccounting()
    const previewCut = 'q'.repeat(50) + '…' + 'q'.repeat(50)
    readRemoteObject(
      {
        type: 'object',
        description: 'Object',
        objectId: '1',
        preview: { type: 'object', description: 'Object', overflow: false, properties: [prop('long', 'string', previewCut)] as any },
      } as any,
      { path: 'o', accounting: acc2 },
    )
    expect(acc2.cappedStrings[0]).toMatch(/o\.long: matches V8's 100-char preview cap/)

    // A number is never routed through the string cap.
    const acc3 = newPreviewAccounting()
    readRemoteObject({ type: 'number', value: 10 } as any, { path: 'n', accounting: acc3 })
    expect(acc3.cappedStrings).toEqual([])
  })

  it('reconstructs top-level unserializable numbers and names functions', () => {
    expect(Number.isNaN(readRemoteObject({ type: 'number', unserializableValue: 'NaN', description: 'NaN' } as any) as number)).toBe(true)
    expect(readRemoteObject({ type: 'number', unserializableValue: '-Infinity', description: '-Infinity' } as any)).toBe(-Infinity)
    expect(readRemoteObject({ type: 'bigint', unserializableValue: '1n', description: '1n' } as any)).toBe('[bigint 1n]')
    expect(readRemoteObject({ type: 'function', description: 'function helperFn(a) { return a }' } as any)).toBe('[function helperFn]')
    expect(readRemoteObject({ type: 'function', description: 'class Foo {}' } as any)).toBe('[function class Foo]')
    expect(readRemoteObject({ type: 'function', description: '(x) => x' } as any)).toBe('[function]')
    // Unparsable number text becomes a marker rather than a wrong number.
    expect(readRemoteObject({ type: 'number', unserializableValue: 'weird' } as any)).toBe('[number weird]')
  })
})

describe('getCallFrames', () => {
  it('reads EVERY frame local/closure scope, not just frame 0', async () => {
    const mock = new MockCdp((method, params) => {
      if (method === 'Runtime.getProperties') {
        if (params.objectId === 'local-0') {
          return { result: [{ name: 'a', value: { type: 'number', value: 1 }, configurable: true }] }
        }
        if (params.objectId === 'local-1') {
          return { result: [{ name: 'b', value: { type: 'string', value: 'hi' }, configurable: true }] }
        }
        if (params.objectId === 'closure-1') {
          return { result: [{ name: 'c', value: { type: 'boolean', value: true }, configurable: true }] }
        }
      }
      return { result: [] }
    })
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await dbg.enable()

    mock.emit('Debugger.paused', {
      callFrames: [
        {
          callFrameId: 'f0',
          functionName: 'top',
          url: 'app.js',
          location: { scriptId: 's1', lineNumber: 9, columnNumber: 2 },
          this: { type: 'undefined' },
          scopeChain: [{ type: 'local', object: { type: 'object', objectId: 'local-0' } }],
        },
        {
          callFrameId: 'f1',
          functionName: 'caller',
          url: 'app.js',
          location: { scriptId: 's1', lineNumber: 20, columnNumber: 0 },
          this: { type: 'undefined' },
          scopeChain: [
            { type: 'local', object: { type: 'object', objectId: 'local-1' } },
            { type: 'closure', object: { type: 'object', objectId: 'closure-1' } },
            { type: 'global', object: { type: 'object', objectId: 'global-1' } },
          ],
        },
      ],
    })

    const frames = await dbg.getCallFrames()
    expect(frames).toHaveLength(2)

    expect(frames[0].functionName).toBe('top')
    expect(frames[0].location.line).toBe(10) // 1-based
    expect(frames[0].scopeChain[0].variables).toEqual({ a: 1 })

    expect(frames[1].functionName).toBe('caller')
    // Local + closure read; global skipped.
    expect(frames[1].scopeChain.map((s) => s.type)).toEqual(['local', 'closure'])
    expect(frames[1].scopeChain[0].variables).toEqual({ b: 'hi' })
    expect(frames[1].scopeChain[1].variables).toEqual({ c: true })
  })

  it('throws when not paused', async () => {
    const mock = new MockCdp()
    const dbg = new Debugger({ cdp: asCdp(mock) })
    await expect(dbg.getCallFrames()).rejects.toThrow(/not paused/)
  })
})
