/**
 * PageWatch journal and settle semantics that do not need a browser: which open requests
 * hold a settle (the action's own, by Chrome's request facts) and which are only reported,
 * how redirects, WebSocket frames, failures, console messages of the page's own world,
 * navigations and dialogs are recorded and attributed to a checkpoint, and that a page frozen
 * by a dialog the agent must answer is never probed.
 *
 * Events are fed through an in-memory session that behaves like Playwright's page session
 * (on/off/send). The frames are a real PageFrames over a one-document stand-in page; its main
 * isolated world answers through that session with an empty journal, and every probe of it is
 * counted, so an accidental probe of a frozen or closed page is visible. Dialogs come from an
 * in-memory stand-in for DialogController. Settle's poll loop runs on vitest's fake clock. The
 * in-page journal itself, iframes included, is exercised against real Chromium in
 * page-watch-live.test.ts.
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@xmorse/playwright-core'
import type { ICDPSession } from './cdp-session.js'
import { PageFrames } from './page-frames.js'
import { PageWatch, type WatchDialogs } from './page-watch.js'
import type { JsDialogState } from './probe-types.js'
import type { TappedWorker } from './session-tap.js'

const MAIN = 'MAIN_FRAME'
/** The execution context of the isolated world PageFrames creates on the main frame. */
const WORLD = 99

function fakeDialogs() {
  let open: JsDialogState | null = null
  const history: JsDialogState[] = []
  const listeners = new Set<(state: JsDialogState | null) => void>()
  const notify = (): void => {
    for (const listener of listeners) listener(open && { ...open })
  }
  const dialogs: WatchDialogs = {
    current: () => open && { ...open },
    history: () => history.map((state) => ({ ...state })),
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    dialogs,
    show(state: Omit<JsDialogState, 'openedAt'>): void {
      open = { ...state, openedAt: Date.now() }
      history.push(open)
      notify()
    },
    close(outcome: NonNullable<JsDialogState['outcome']>): void {
      open!.outcome = outcome
      open!.closedAt = Date.now()
      open = null
      notify()
    },
  }
}

/**
 * `browserAheadMs`: how far the browser's clock (the isolated world's `Date.now()`, Chrome's
 * `wallTime`) is ahead of this process's — a browser on another machine. The journal is read in
 * timed round trips, as against a real browser; every stamp it hands out is on the browser's clock.
 * `ticker`: an element changes its content every 50ms from setup on — the in-page journal's churn
 * rule (three changes, each within 2s of the last) makes it ambient for a cutoff after its third.
 */
function setup(options: { closed?: () => boolean; browserAheadMs?: number; ticker?: boolean } = {}) {
  const emitter = new EventEmitter()
  const probes: string[] = []
  const browserNow = (): number => Date.now() + (options.browserAheadMs ?? 0)
  const tickerFrom = browserNow()
  /** Live text the page showed, stamped by the page. */
  const live: Array<{ id: number; at: number; updatedAt: number | null; role: string; text: string; transient: boolean }> = []
  // The isolated world's journal: installed long ago, no mutations but the ticker's, the live text above.
  const journal = (expression: string): unknown => {
    probes.push(expression)
    const now = browserNow()
    if (expression === 'Date.now()') return now
    const read = /\.read\((-?[\d.e+]+)\)/.exec(expression)
    if (read) {
      const from = Number(read[1])
      return { now, ok: true, value: { token: 'doc', now, live: live.filter((rec) => rec.at >= from), batches: [], droppedAt: null, liveDroppedAt: null } }
    }
    if (expression.includes('.busy(')) return { now, ok: true, value: { streaming: null, announced: [], spinners: { set: 1, list: [] } } }
    if (expression.includes('.sweep(')) return { now, ok: true, value: 'doc' }
    const state = /\.state\((\{.*\})\)/.exec(expression)
    const cutoff: unknown = state ? JSON.parse(state[1]!).cutoff : null
    const churningBefore = typeof cutoff === 'number' && tickerFrom + 100 < cutoff
    const lastTick = now - ((now - tickerFrom) % 50)
    const lastContentAt = options.ticker && !churningBefore ? lastTick : null
    return { now, ok: true, value: { token: 'doc', now, installedAt: now - 10000, lastContentAt, hot: null, ambient: [], content: 0, cosmetic: 0 } }
  }
  // Contexts that existed before start() are identified through their `document`: every context
  // here shows the one main document; the main world's object is `doc-main`, context 3 is that
  // main world, any other context is another world.
  const worldOf: Record<string, string> = { 'doc-main': 'main', 'doc-3': 'main' }
  const cdp = {
    on: (event: string, cb: (p: unknown) => void) => emitter.on(event, cb),
    off: (event: string, cb: (p: unknown) => void) => emitter.off(event, cb),
    send: async (
      method: string,
      params: { contextId?: number; expression?: string; objectId?: string; arguments?: Array<{ objectId: string }> } = {},
    ) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: MAIN, loaderId: 'LOADER_0', url: 'http://app.test/' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: WORLD }
      if (method === 'DOMSnapshot.captureSnapshot') return { documents: [], strings: [] }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      if (method === 'Runtime.releaseObjectGroup') return {}
      if (method === 'Runtime.evaluate') {
        if (params.contextId === WORLD) return { result: { type: 'object', value: journal(params.expression!) } }
        return { result: { type: 'object', subtype: 'node', objectId: `doc-${params.contextId ?? 'main'}` } }
      }
      if (method === 'DOM.describeNode') return { node: { nodeId: 0, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '', nodeValue: '', documentURL: 'http://app.test/' } }
      if (method === 'DOM.resolveNode') return { object: { type: 'object', subtype: 'node', objectId: 'doc-main' } }
      if (method === 'Runtime.callFunctionOn') {
        if (worldOf[params.objectId!] !== worldOf[params.arguments![0]!.objectId]) {
          throw new Error('Protocol error (Runtime.callFunctionOn): Argument should belong to the same JavaScript world as target object')
        }
        return { result: { type: 'boolean', value: true } }
      }
      throw new Error(`${method} is not available in this unit test`)
    },
    detach: async () => {},
  } as unknown as ICDPSession
  const frameOf = (frameId: string, url: string) => ({
    frameId: () => frameId,
    url: () => url,
    name: () => '',
    parentFrame: () => null,
    childFrames: () => [],
    isDetached: () => false,
  })
  const mainFrame = frameOf(MAIN, 'http://app.test/')
  // An iframe of the page, for console attribution. The frame tree (childFrames) leaves it out,
  // so no journal is read in it.
  const childFrame = frameOf('CHILD', 'http://ads.test/frame')
  const page = { mainFrame: () => mainFrame, frames: () => [mainFrame, childFrame], on: () => {}, off: () => {} } as unknown as Page
  const errors: unknown[][] = []
  const fake = fakeDialogs()
  // A dedicated worker the page runs, handed over at start as the tap does. Its session is a stand-in
  // that records every command sent to it.
  const workerEvents = new EventEmitter()
  const workerCommands: string[] = []
  const worker: TappedWorker = {
    url: 'http://app.test/parser.js',
    session: {
      on(event, listener) {
        workerEvents.on(event, listener)
      },
      off(event, listener) {
        workerEvents.off(event, listener)
      },
      start() {},
      onClose() {},
    },
    cdp: {
      send: async (method: string) => {
        workerCommands.push(method)
        return method === 'Network.getResponseBody' ? { body: 'held by the worker session', base64Encoded: false } : {}
      },
      on: () => {},
      off: () => {},
      detach: async () => {},
    } as unknown as ICDPSession,
  }
  const watch = new PageWatch({
    frames: new PageFrames({ page, cdp }),
    dialogs: fake.dialogs,
    isClosed: options.closed,
    logger: { error: (...args: unknown[]) => errors.push(args) },
    // No out-of-process iframes in this stand-in page; one worker.
    openSessionTap: (onWorker) => {
      onWorker(worker)
      return { session: () => null, discard: () => {}, dispose: () => {} }
    },
  })
  watch.start()
  const emitWorker = (event: string, params: unknown) => workerEvents.emit(event, params, Date.now())
  const emit = (event: string, params: unknown) => emitter.emit(event, params)
  let n = 0
  const request = (url: string, type: string | null = 'Fetch', method = 'GET', extra: Record<string, unknown> = {}) => {
    const requestId = `req-${++n}`
    emit('Network.requestWillBeSent', {
      requestId,
      loaderId: 'LOADER_0',
      wallTime: browserNow() / 1000,
      ...(type ? { type } : {}),
      frameId: MAIN,
      request: { url, method, ...extra },
    })
    return requestId
  }
  const finish = (requestId: string, type = 'Fetch', status = 200) => {
    emit('Network.responseReceived', { requestId, type, response: { status, mimeType: 'application/json' } })
    emit('Network.loadingFinished', { requestId })
  }
  /** The page shows `text` in a live region now. */
  const announce = (text: string): void => {
    live.push({ id: live.length + 1, at: browserNow(), updatedAt: null, role: 'status', text, transient: false })
  }
  return { emit, emitWorker, workerCommands, request, finish, announce, watch, probes, errors, dialog: fake }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

async function settled<T>(work: Promise<T>, ms: number): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms)
  return await work
}

describe('which requests hold a settle', () => {
  it('only the action’s own requests that a person waits on; older open ones are reported, not waited on', async () => {
    const { request, watch } = setup()
    request('http://app.test/channel/poll')
    vi.advanceTimersByTime(50)
    const cp = watch.checkpoint()
    vi.advanceTimersByTime(10)
    request('http://app.test/api/save', 'Fetch', 'POST')
    request('http://app.test/beacon', 'Ping', 'POST')
    request('http://app.test/favicon.ico', 'Other')
    request('http://ads.example/bid', 'Fetch', 'GET', { isAdRelated: true })
    request('ws://app.test/live', 'WebSocket')
    request('http://app.test/events', 'EventSource')
    const result = await settled(watch.settle({ since: cp, timeoutMs: 400 }), 500)
    expect(result).toMatchObject({ settled: false, reason: 'timeout' })
    expect(result.pendingRequests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST http://app.test/api/save'])
    expect(result.uncaused?.map((r) => `${r.method} ${r.url}`)).toEqual(['GET http://app.test/channel/poll'])
  })

  it('a host name is not a reason to ignore a request: an app on a "tracking."/"ads." host is waited for', async () => {
    const { request, watch } = setup()
    const cp = watch.checkpoint()
    request('https://uploads.example.com/files', 'XHR', 'PUT')
    request('https://tracking.myshop.example/api/orders', 'Fetch', 'POST')
    const result = await settled(watch.settle({ since: cp, timeoutMs: 300 }), 400)
    expect(result.pendingRequests.map((r) => r.url)).toEqual(['https://uploads.example.com/files', 'https://tracking.myshop.example/api/orders'])
  })

  it('a stalled image stops holding; a request with no type stated yet holds until Chrome says otherwise', async () => {
    const { request, watch } = setup()
    const cp = watch.checkpoint()
    request('http://app.test/hero.png', 'Image')
    request('http://app.test/unknown', null)
    const early = await settled(watch.settle({ since: cp, timeoutMs: 300 }), 400)
    expect(early.pendingRequests.map((r) => [r.url, r.resourceType])).toEqual([
      ['http://app.test/hero.png', 'Image'],
      ['http://app.test/unknown', undefined],
    ])
    vi.advanceTimersByTime(3000)
    const later = await settled(watch.settle({ since: cp, timeoutMs: 300 }), 400)
    expect(later.pendingRequests.map((r) => r.url)).toEqual(['http://app.test/unknown'])
  })

  it('a long-poll that reconnects after the action is the page’s channel, not the action’s effect', async () => {
    const { request, finish, watch } = setup()
    const first = request('http://app.test/channel/poll')
    vi.advanceTimersByTime(10)
    const cp = watch.checkpoint()
    vi.advanceTimersByTime(20)
    finish(first)
    request('http://app.test/channel/poll')
    const result = await settled(watch.settle({ since: cp, timeoutMs: 1000 }), 1100)
    expect(result).toMatchObject({ settled: true, reason: 'quiet', pendingRequests: [] })
    expect(result.uncaused?.map((r) => r.url)).toEqual(['http://app.test/channel/poll'])
  })

  it('quiet is measured from the end of the last input: a request finishing 200ms after it pushes the settle back', async () => {
    const { request, finish, watch } = setup()
    const cp = watch.checkpoint()
    const save = request('http://app.test/api/save', 'Fetch', 'POST')
    const origin = Date.now()
    const settling = watch.settle({ since: cp, origin, timeoutMs: 5000 })
    await vi.advanceTimersByTimeAsync(200)
    finish(save)
    const result = await settled(settling, 1000)
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    // 500ms of network quiet after the POST ended at +200ms.
    expect(result.waitedMs).toBeGreaterThanOrEqual(700)
  })
})

describe('request journal', () => {
  it('a POST answered with 303 stays a POST record; the GET it leads to is its own record', async () => {
    const { emit, request, finish, watch } = setup()
    const cp = watch.checkpoint()
    const submit = request('http://app.test/form', 'Document', 'POST')
    emit('Network.requestWillBeSent', {
      requestId: submit,
      loaderId: 'LOADER_0',
      wallTime: Date.now() / 1000,
      type: 'Document',
      request: { url: 'http://app.test/done', method: 'GET' },
      redirectResponse: { status: 303, mimeType: 'text/html' },
    })
    finish(submit, 'Document')
    const events = await watch.since(cp)
    expect(events.network.map((r) => ({ id: r.id, method: r.method, url: r.url, status: r.status, redirectedFrom: r.redirectedFrom }))).toEqual([
      { id: 'r1', method: 'POST', url: 'http://app.test/form', status: 303, redirectedFrom: undefined },
      { id: 'r2', method: 'GET', url: 'http://app.test/done', status: 200, redirectedFrom: 'r1' },
    ])
    expect(events.network.every((r) => r.endedAt !== undefined)).toBe(true)
    await expect(watch.responseBody('r1')).rejects.toThrow('a redirect has no body. Read r2')
  })

  it('failures and HTTP errors are journaled as failed; a type Chrome has not stated yet stays absent', async () => {
    const { emit, request, finish, watch } = setup()
    const missing = request('http://app.test/api/missing')
    finish(missing, 'Fetch', 404)
    const refused = request('http://127.0.0.1:1/x', null)
    expect(watch.requests().find((r) => r.requestId === refused)!.resourceType).toBeUndefined()
    emit('Network.loadingFailed', { requestId: refused, type: 'Fetch', errorText: 'net::ERR_CONNECTION_REFUSED' })
    const aborted = request('http://app.test/api/typeahead')
    emit('Network.loadingFailed', { requestId: aborted, type: 'Fetch', errorText: 'net::ERR_ABORTED', canceled: true })

    expect(watch.requests().map((r) => [r.id, r.url, r.resourceType, r.status, r.failed])).toEqual([
      ['r1', 'http://app.test/api/missing', 'Fetch', 404, undefined],
      ['r2', 'http://127.0.0.1:1/x', 'Fetch', undefined, 'net::ERR_CONNECTION_REFUSED'],
      ['r3', 'http://app.test/api/typeahead', 'Fetch', undefined, 'canceled'],
    ])
    expect(watch.requests({ failedOnly: true }).map((r) => r.id)).toEqual(['r1', 'r2', 'r3'])
    expect(watch.requests({ urlIncludes: '/api/', limit: 1 }).map((r) => r.id)).toEqual(['r3'])
    expect(watch.requests({ method: 'post' })).toEqual([])
  })

  it('responseBody names why a body is unavailable', async () => {
    const { request, watch } = setup()
    request('http://app.test/api/slow')
    await expect(watch.responseBody('r1')).rejects.toThrow('has not finished yet')
    await expect(watch.responseBody('r99')).rejects.toThrow('No request r99 in the journal')
  })

  it('says so when the request journal dropped entries newer than the checkpoint', async () => {
    const { request, watch } = setup()
    const cp = watch.checkpoint()
    for (let i = 0; i < 501; i++) request(`http://app.test/api/item/${i}`)
    const events = await watch.since(cp)
    expect(events.network).toHaveLength(500)
    expect(events.dropped).toEqual(['network'])
    expect((await watch.since(watch.checkpoint())).dropped).toBeUndefined()
  })

  it('journals WebSocket frames both ways with their size; a socket opened before the watch has no URL', async () => {
    const { emit, watch } = setup()
    emit('Network.webSocketCreated', { requestId: 'ws-1', url: 'wss://chat.test/socket' })
    const cp = watch.checkpoint()
    emit('Network.webSocketFrameSent', { requestId: 'ws-1', timestamp: 1, response: { opcode: 1, mask: true, payloadData: '{"text":"héllo"}' } })
    emit('Network.webSocketFrameReceived', { requestId: 'ws-1', timestamp: 2, response: { opcode: 2, mask: false, payloadData: 'AAEC' } })
    emit('Network.webSocketFrameSent', { requestId: 'ws-old', timestamp: 3, response: { opcode: 1, mask: true, payloadData: 'ping' } })
    const events = await watch.since(cp)
    expect(events.webSockets.map(({ requestId, url, direction, opcode, bytes }) => ({ requestId, url, direction, opcode, bytes }))).toEqual([
      { requestId: 'ws-1', url: 'wss://chat.test/socket', direction: 'sent', opcode: 1, bytes: 17 },
      { requestId: 'ws-1', url: 'wss://chat.test/socket', direction: 'received', opcode: 2, bytes: 3 },
      { requestId: 'ws-old', url: undefined, direction: 'sent', opcode: 1, bytes: 4 },
    ])
  })
})

describe('console, navigation and dialogs', () => {
  it('keeps console errors and exceptions of the page’s own code in every frame, never of other worlds, with their call site', async () => {
    const { emit, watch } = setup()
    emit('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true, type: 'default', frameId: MAIN } } })
    emit('Runtime.executionContextCreated', { context: { id: 2, auxData: { isDefault: false, type: 'isolated', frameId: MAIN } } })
    emit('Runtime.executionContextCreated', { context: { id: 5, auxData: { isDefault: true, type: 'default', frameId: 'CHILD' } } })
    const frame = { url: 'http://app.test/app.js', lineNumber: 41, columnNumber: 9, functionName: 'save', scriptId: '1' }
    emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 1, args: [{ type: 'string', value: 'ignored' }], stackTrace: { callFrames: [frame] } })
    emit('Runtime.consoleAPICalled', {
      type: 'error',
      executionContextId: 1,
      args: [
        { type: 'string', value: 'Save failed' },
        {
          type: 'object',
          className: 'Object',
          description: 'Object',
          preview: { type: 'object', overflow: false, properties: [{ name: 'code', type: 'number', value: '500' }] },
        },
        { type: 'number', value: 3 },
      ],
      stackTrace: { callFrames: [frame] },
    })
    emit('Runtime.consoleAPICalled', { type: 'error', executionContextId: 2, args: [{ type: 'string', value: 'probe noise' }] })
    emit('Runtime.consoleAPICalled', { type: 'error', executionContextId: 5, args: [{ type: 'string', value: 'iframe noise' }] })
    // Contexts 3 and 4 existed before the watch started: 3 is the main world, 4 an extension's world.
    emit('Runtime.consoleAPICalled', { type: 'warning', executionContextId: 3, args: [{ type: 'object', description: 'Map(2)' }] })
    emit('Runtime.consoleAPICalled', { type: 'error', executionContextId: 4, args: [{ type: 'string', value: 'extension noise' }] })
    emit('Runtime.consoleAPICalled', { type: 'assert', executionContextId: 1, args: [{ type: 'string', value: 'cart is empty' }] })
    emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 9,
        columnNumber: 4,
        url: 'http://app.test/cart.js',
        executionContextId: 1,
        exception: { type: 'object', description: 'TypeError: items is undefined\n    at render (cart.js:10:5)' },
      },
    })
    const events = await watch.since({ seq: 0, at: 0 })
    expect(events.console.map(({ level, text, location, frame }) => ({ level, text, location, frame }))).toEqual([
      { level: 'error', text: 'Save failed {code: 500} 3', location: 'http://app.test/app.js:42:10', frame: undefined },
      // The iframe's own code is the page's code too, and says where it ran.
      { level: 'error', text: 'iframe noise', location: undefined, frame: 'http://ads.test/frame' },
      { level: 'warning', text: 'Map(2)', location: undefined, frame: undefined },
      { level: 'error', text: 'Assertion failed: cart is empty', location: undefined, frame: undefined },
      { level: 'exception', text: 'Uncaught TypeError: items is undefined', location: 'http://app.test/cart.js:10:5', frame: undefined },
    ])
  })

  it('tells a document load, a back/forward-cache restore and an SPA route change apart', () => {
    const { emit, watch } = setup()
    const cp = watch.checkpoint()
    emit('Page.navigatedWithinDocument', { frameId: MAIN, url: 'http://app.test/threads/2', navigationType: 'historyApi' })
    emit('Page.navigatedWithinDocument', { frameId: 'CHILD', url: 'http://ads.test/x', navigationType: 'fragment' })
    emit('Page.frameNavigated', { frame: { id: 'CHILD', parentId: MAIN, loaderId: 'L-child', url: 'http://ads.test/' }, type: 'Navigation' })
    emit('Page.frameStartedNavigating', { frameId: MAIN, url: 'http://app.test/home', loaderId: 'LOADER_1', navigationType: 'reload' })
    emit('Page.frameNavigated', { frame: { id: MAIN, loaderId: 'LOADER_1', url: 'http://app.test/home' }, type: 'Navigation' })
    emit('Page.frameStartedNavigating', { frameId: MAIN, url: 'http://app.test/threads/2', loaderId: 'LOADER_2', navigationType: 'historyDifferentDocument' })
    emit('Page.frameNavigated', { frame: { id: MAIN, loaderId: 'LOADER_0', url: 'http://app.test/threads/2' }, type: 'BackForwardCacheRestore' })
    expect(watch.documentId()).toBe('LOADER_0')
    expect(watch.navigations().map(({ kind, url, navigationType }) => ({ kind, url, navigationType }))).toEqual([
      { kind: 'same-document', url: 'http://app.test/threads/2', navigationType: 'historyApi' },
      { kind: 'cross-document', url: 'http://app.test/home', navigationType: 'reload' },
      // Chrome restores the cached document under its old loaderId, not the one the navigation started with.
      { kind: 'restored', url: 'http://app.test/threads/2', navigationType: undefined },
    ])
    expect(watch.navigations().every((n) => n.seq > cp.seq)).toBe(true)
  })

  it('a dialog the agent must answer: settle reports it at once and never probes the frozen page', async () => {
    const { watch, probes, dialog } = setup()
    dialog.show({ type: 'confirm', message: 'Delete this thread?', handling: 'agent' })
    const before = probes.length
    const result = await watch.settle({ timeoutMs: 5000 })
    expect(result).toMatchObject({ settled: false, reason: 'js-dialog', dialog: { type: 'confirm', message: 'Delete this thread?' } })
    expect(result.waitedMs).toBe(0)
    await expect(watch.busySignals()).rejects.toThrow('a native confirm dialog is open ("Delete this thread?")')
    expect((await watch.since({ seq: 0, at: 0 })).dialogs).toEqual([expect.objectContaining({ type: 'confirm', handling: 'agent' })])
    expect(probes.length).toBe(before)

    dialog.close('dismissed')
    expect((await watch.since({ seq: 0, at: 0 })).dialogs[0]).toMatchObject({ type: 'confirm', outcome: 'dismissed' })
  })

  it('a dialog the policy answers: settle waits for it to close, then measures quiet afresh', async () => {
    const { watch, probes, dialog } = setup()
    const cp = watch.checkpoint()
    dialog.show({ type: 'alert', message: 'Saved', handling: 'auto' })
    const before = probes.length
    const settling = watch.settle({ since: cp, timeoutMs: 5000 })
    await vi.advanceTimersByTimeAsync(200)
    expect(probes.length).toBe(before)
    dialog.close('auto-accepted')
    const result = await settled(settling, 1000)
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    // 200ms frozen, then a full 500ms network-quiet window after the close.
    expect(result.waitedMs).toBeGreaterThanOrEqual(700)
    expect((await watch.since(cp)).dialogs).toEqual([expect.objectContaining({ type: 'alert', outcome: 'auto-accepted', handling: 'auto' })])
  })

  it('settle reports a closed page without probing it', async () => {
    let closed = false
    const { watch, probes } = setup({ closed: () => closed })
    closed = true
    const before = probes.length
    const result = await watch.settle()
    expect(result).toMatchObject({ settled: false, reason: 'page-closed' })
    expect(probes.length).toBe(before)
  })
})

// A cloud browser or a remote relay runs Chrome on another machine: its clock can be minutes off
// this process's, either way. Every comparison must come out as on one machine.
describe.each([
  { label: '5 minutes ahead', browserAheadMs: 5 * 60_000 },
  { label: '5 minutes behind', browserAheadMs: -5 * 60_000 },
])('a browser whose clock is $label', ({ browserAheadMs }) => {
  it('the action’s own request holds the settle and an older open one is only reported, with their true ages', async () => {
    const { request, watch } = setup({ browserAheadMs })
    request('http://app.test/channel/poll')
    vi.advanceTimersByTime(50)
    const cp = watch.checkpoint()
    vi.advanceTimersByTime(10)
    request('http://app.test/api/save', 'Fetch', 'POST')
    const result = await settled(watch.settle({ since: cp, timeoutMs: 400 }), 500)
    expect(result).toMatchObject({ settled: false, reason: 'timeout' })
    expect(result.pendingRequests.map((r) => `${r.method} ${r.url} ${r.ageMs}`)).toEqual([`POST http://app.test/api/save ${result.waitedMs}`])
    expect(result.uncaused?.map((r) => `${r.method} ${r.url} ${r.ageMs}`)).toEqual([`GET http://app.test/channel/poll ${result.waitedMs + 60}`])
  })

  it('quiet is measured from the end of the last input: the POST ending 200ms after it pushes the settle back by exactly that', async () => {
    const { request, finish, watch } = setup({ browserAheadMs })
    const cp = watch.checkpoint()
    const save = request('http://app.test/api/save', 'Fetch', 'POST')
    const origin = Date.now()
    const settling = watch.settle({ since: cp, origin, timeoutMs: 5000 })
    await vi.advanceTimersByTimeAsync(200)
    finish(save)
    const result = await settled(settling, 1000)
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    // 500ms of network quiet after the POST ended at +200ms, found by the next 75ms poll.
    expect(result.waitedMs).toBeGreaterThanOrEqual(700)
    expect(result.waitedMs).toBeLessThan(800)
  })

  it('an element that was already changing before the action does not hold the settle', async () => {
    const { watch } = setup({ browserAheadMs, ticker: true })
    vi.advanceTimersByTime(500)
    const cp = watch.checkpoint()
    const result = await settled(watch.settle({ since: cp, timeoutMs: 2000 }), 2100)
    expect(result).toMatchObject({ settled: true, reason: 'quiet' })
    expect(result.waitedMs).toBeLessThan(600)
  })

  it('live text is the action’s when the page showed it after the checkpoint, and is reported at this process’s time', async () => {
    const { announce, watch } = setup({ browserAheadMs })
    announce('Draft restored')
    vi.advanceTimersByTime(20)
    const cp = watch.checkpoint()
    vi.advanceTimersByTime(30)
    const shownAt = Date.now()
    announce('Message sent')
    const events = await watch.since(cp)
    expect(events.live.map(({ text, at }) => ({ text, at }))).toEqual([{ text: 'Message sent', at: shownAt }])
  })

  it('a request starts when it was issued, on this process’s clock', () => {
    const { request, watch } = setup({ browserAheadMs })
    const issuedAt = Date.now()
    request('http://app.test/api/save', 'Fetch', 'POST')
    expect(watch.requests().map((r) => r.startedAt)).toEqual([issuedAt])
  })
})

describe('a dedicated worker', () => {
  it('its console errors and uncaught exceptions are the page’s own, named by the worker, and read without asking its session anything', async () => {
    const { emitWorker, workerCommands, watch } = setup()
    const cp = watch.checkpoint()
    const frame = { url: 'http://app.test/parser.js', lineNumber: 1, columnNumber: 10, functionName: 'onmessage', scriptId: '9' }
    emitWorker('Runtime.consoleAPICalled', { type: 'log', executionContextId: 1, args: [{ type: 'string', value: 'parsing' }], stackTrace: { callFrames: [frame] } })
    emitWorker('Runtime.consoleAPICalled', { type: 'error', executionContextId: 1, args: [{ type: 'string', value: 'bad row 7' }], stackTrace: { callFrames: [frame] } })
    emitWorker('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 2,
        columnNumber: 8,
        url: 'http://app.test/parser.js',
        executionContextId: 1,
        exception: { type: 'object', description: 'Error: crashed on row 7\n    at onmessage (parser.js:3:9)' },
      },
    })
    const events = await watch.since(cp)
    expect(events.console.map(({ level, text, location, frame: inFrame, worker }) => ({ level, text, location, frame: inFrame, worker }))).toEqual([
      { level: 'error', text: 'bad row 7', location: 'http://app.test/parser.js:2:11', frame: undefined, worker: 'http://app.test/parser.js' },
      { level: 'exception', text: 'Uncaught Error: crashed on row 7', location: 'http://app.test/parser.js:3:9', frame: undefined, worker: 'http://app.test/parser.js' },
    ])
    expect(workerCommands).toEqual([])
  })
})

describe('a request reported on two of the page’s sessions', () => {
  // Measured: a cross-site iframe's document is announced (requestWillBeSent, responseReceived) on
  // the parent's session; its data and its end arrive on the iframe's own session, under the same
  // Chrome request id (the document's loader id). Here the second session is the worker's stand-in.
  it('is one record, which ends when the other session says so, and whose body is read where it arrived', async () => {
    const { emit, emitWorker, workerCommands, watch } = setup()
    const cp = watch.checkpoint()
    const announced = {
      requestId: 'LOADER_IFRAME',
      loaderId: 'LOADER_IFRAME',
      wallTime: Date.now() / 1000,
      type: 'Document',
      frameId: 'CHILD',
      documentURL: 'http://ads.test/frame',
      request: { url: 'http://ads.test/frame', method: 'GET' },
    }
    emit('Network.requestWillBeSent', announced)
    // The same hop announced again by the other session is the same request.
    emitWorker('Network.requestWillBeSent', announced)
    emit('Network.responseReceived', { requestId: 'LOADER_IFRAME', type: 'Document', response: { status: 200, mimeType: 'text/html' } })
    emitWorker('Network.dataReceived', { requestId: 'LOADER_IFRAME', dataLength: 10, encodedDataLength: 10 })
    vi.advanceTimersByTime(30)
    emitWorker('Network.loadingFinished', { requestId: 'LOADER_IFRAME' })
    const result = await settled(watch.settle({ since: cp, timeoutMs: 2000 }), 2100)
    expect(result).toMatchObject({ settled: true, reason: 'quiet', pendingRequests: [] })
    expect(watch.requests().map(({ id, url, resourceType, status, frame, endedAt }) => ({ id, url, resourceType, status, frame, ended: endedAt !== undefined }))).toEqual([
      { id: 'r1', url: 'http://ads.test/frame', resourceType: 'Document', status: 200, frame: 'http://ads.test/frame', ended: true },
    ])
    expect(await watch.responseBody('r1')).toMatchObject({ body: 'held by the worker session' })
    expect(workerCommands).toEqual(['Network.getResponseBody'])
  })

  it('a redirect announced on both sessions is one more hop, not two', () => {
    const { emit, emitWorker, watch } = setup()
    const first = { requestId: 'LOADER_R', loaderId: 'LOADER_R', wallTime: Date.now() / 1000, type: 'Document', frameId: 'CHILD', documentURL: 'http://ads.test/a', request: { url: 'http://ads.test/a', method: 'GET' } }
    emit('Network.requestWillBeSent', first)
    vi.advanceTimersByTime(5)
    const hop = {
      ...first,
      wallTime: Date.now() / 1000,
      documentURL: 'http://ads.test/b',
      request: { url: 'http://ads.test/b', method: 'GET' },
      redirectResponse: { status: 302, mimeType: 'text/html' },
    }
    emit('Network.requestWillBeSent', hop)
    emitWorker('Network.requestWillBeSent', hop)
    emitWorker('Network.loadingFinished', { requestId: 'LOADER_R' })
    expect(watch.requests().map(({ url, status, redirectedFrom, endedAt }) => ({ url, status, redirectedFrom, ended: endedAt !== undefined }))).toEqual([
      { url: 'http://ads.test/a', status: 302, redirectedFrom: undefined, ended: true },
      { url: 'http://ads.test/b', status: undefined, redirectedFrom: 'r1', ended: true },
    ])
  })
})

// The event sequences measured on GitHub's archive link (and reproduced in journal-clock-live): the
// page fetches the link, which its CSP refuses at the cross-origin redirect, then navigates to it,
// and the navigation's response becomes a download.
describe('a link that redirects to a download', () => {
  it('a fetch Chrome moves on to its redirect target without reporting the redirect closes the first hop; the block is its reason', async () => {
    const { emit, watch } = setup()
    const cp = watch.checkpoint()
    const wallTime = Date.now() / 1000
    emit('Network.requestWillBeSent', { requestId: '7.205', loaderId: 'LOADER_0', wallTime, type: 'Fetch', frameId: MAIN, request: { url: 'http://app.test/archive.zip', method: 'GET' } })
    vi.advanceTimersByTime(5)
    emit('Network.requestWillBeSent', { requestId: '7.205', loaderId: 'LOADER_0', wallTime: Date.now() / 1000, type: 'Fetch', frameId: MAIN, request: { url: 'http://codeload.test/archive.zip', method: 'GET' } })
    emit('Network.loadingFailed', { requestId: '7.205', type: 'Fetch', errorText: '', canceled: false, blockedReason: 'csp' })
    emit('Network.loadingFailed', { requestId: '7.205', type: 'Fetch', errorText: 'net::ERR_ABORTED', canceled: true })
    const result = await settled(watch.settle({ since: cp, timeoutMs: 2000 }), 2100)
    expect(result).toMatchObject({ settled: true, reason: 'quiet', pendingRequests: [] })
    expect(watch.requests().map(({ url, status, failed, redirectedFrom, endedAt }) => ({ url, status, failed, redirectedFrom, ended: endedAt !== undefined }))).toEqual([
      { url: 'http://app.test/archive.zip', status: undefined, failed: undefined, redirectedFrom: undefined, ended: true },
      { url: 'http://codeload.test/archive.zip', status: undefined, failed: 'blocked: csp', redirectedFrom: 'r1', ended: true },
    ])
    await expect(watch.responseBody('r1')).rejects.toThrow('was redirected (Chrome did not report the redirect response) to r2')
  })

  it('a navigation canceled because its response became a download ended as that download, and is not a failure', async () => {
    const { emit, watch } = setup()
    const cp = watch.checkpoint()
    const navigation = { requestId: 'NAV', loaderId: 'NAV', type: 'Document', frameId: MAIN, documentURL: 'http://app.test/archive.zip' }
    emit('Network.requestWillBeSent', { ...navigation, wallTime: Date.now() / 1000, request: { url: 'http://app.test/archive.zip', method: 'GET' } })
    vi.advanceTimersByTime(5)
    emit('Network.requestWillBeSent', {
      ...navigation,
      wallTime: Date.now() / 1000,
      request: { url: 'http://codeload.test/archive.zip', method: 'GET' },
      redirectResponse: { status: 302, mimeType: 'text/html' },
    })
    emit('Network.responseReceived', { requestId: 'NAV', type: 'Document', response: { status: 200, mimeType: 'application/zip' } })
    emit('Network.loadingFailed', { requestId: 'NAV', type: 'Document', errorText: 'net::ERR_ABORTED', canceled: true })
    emit('Page.downloadWillBegin', { frameId: MAIN, guid: 'g1', url: 'http://codeload.test/archive.zip', suggestedFilename: 'archive.zip' })
    const events = await watch.since(cp)
    expect(events.failedRequests).toEqual([])
    expect(events.network.map(({ url, status, failed, download, endedAt }) => ({ url, status, failed, download, ended: endedAt !== undefined }))).toEqual([
      { url: 'http://app.test/archive.zip', status: 302, failed: undefined, download: undefined, ended: true },
      { url: 'http://codeload.test/archive.zip', status: 200, failed: undefined, download: 'archive.zip', ended: true },
    ])
    await expect(watch.responseBody('r2')).rejects.toThrow('became the download "archive.zip"')
  })

  it('a canceled navigation with no download for its frame and address stays a failure', async () => {
    const { emit, watch } = setup()
    const cp = watch.checkpoint()
    emit('Network.requestWillBeSent', { requestId: 'NAV', loaderId: 'NAV', type: 'Document', frameId: MAIN, wallTime: Date.now() / 1000, request: { url: 'http://app.test/next', method: 'GET' } })
    emit('Network.loadingFailed', { requestId: 'NAV', type: 'Document', errorText: 'net::ERR_ABORTED', canceled: true })
    emit('Page.downloadWillBegin', { frameId: 'CHILD', guid: 'g2', url: 'http://app.test/next', suggestedFilename: 'next' })
    emit('Page.downloadWillBegin', { frameId: MAIN, guid: 'g3', url: 'http://app.test/other.zip', suggestedFilename: 'other.zip' })
    expect((await watch.since(cp)).failedRequests.map(({ url, failed, download }) => ({ url, failed, download }))).toEqual([
      { url: 'http://app.test/next', failed: 'canceled', download: undefined },
    ])
  })
})
