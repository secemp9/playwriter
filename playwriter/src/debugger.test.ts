import { describe, it, expect } from 'vitest'
import { Debugger } from './debugger.js'
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

describe('setLogpoint', () => {
  it('sends Debugger.setBreakpointByUrl with a non-pausing (…,false) tagged condition', async () => {
    const mock = new MockCdp((method) => {
      if (method === 'Debugger.setBreakpointByUrl') return { breakpointId: 'bp-1', locations: [] }
      return {}
    })
    const dbg = new Debugger({ cdp: asCdp(mock) })

    const id = await dbg.setLogpoint({ file: 'app.js', line: 42, expr: 'state.total', tag: 'total' })
    expect(id).toBe('bp-1')

    const call = mock.find('Debugger.setBreakpointByUrl')
    expect(call).toBeTruthy()
    const condition: string = call!.params.condition
    // Never pauses: the condition evaluates to false.
    expect(condition.trim().endsWith(',false)')).toBe(true)
    // Tagged + carries the expression.
    expect(condition).toContain('[[logpoint:total]]')
    expect(condition).toContain('JSON.stringify((state.total))')
    // Correct line (1-based -> 0-based).
    expect(call!.params.lineNumber).toBe(41)
  })

  it('defaults the tag when none is given', async () => {
    const mock = new MockCdp((method) => (method === 'Debugger.setBreakpointByUrl' ? { breakpointId: 'bp-2' } : {}))
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
