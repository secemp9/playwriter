/**
 * The tap on Playwright's server sessions, against a stand-in server laid out like Playwright's:
 * sessions are event emitters that create their children with `createChildSession`; a page's
 * `delegate` holds its main frame session and a target id → `FrameSession` map, the page its
 * `_workers`, each frame session its `_workerSessions`; and Playwright's own `Target.attachedToTarget`
 * handler (registered before the tap) creates the child session — a nested worker's under the frame's
 * session, from the attach heard on its parent worker's. A child's events are emitted the moment it
 * exists, as a resumed renderer or worker reports them, before anyone takes the session. The
 * journal's use of the tap, end to end, is in journal-clock-live.test.ts.
 */

import { EventEmitter } from 'node:events'
import type { Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageSessionTap, type TappedWorker } from './session-tap.js'

class FakeSession extends EventEmitter {
  /** Commands sent on this session. */
  readonly sent: string[] = []

  constructor(
    private readonly all: Map<string, FakeSession>,
    private readonly id: string,
  ) {
    super()
  }

  createChildSession(sessionId: string): FakeSession {
    const child = new FakeSession(this.all, sessionId)
    this.all.set(sessionId, child)
    return child
  }

  sessionId(): string {
    return this.id
  }

  async send(method: string): Promise<{ body: string; base64Encoded: boolean }> {
    this.sent.push(method)
    return { body: `answered by ${this.id}`, base64Encoded: false }
  }
}

interface FakeFrameSession {
  _client: FakeSession
  _workerSessions: Map<string, FakeSession>
}

function fakeServer() {
  const sessions = new Map<string, FakeSession>()
  const frameSessions = new Map<string, FakeFrameSession>()
  const workers = new Map<string, { url: string }>()
  const main: FakeFrameSession = { _client: new FakeSession(sessions, 'MAIN'), _workerSessions: new Map() }
  frameSessions.set('MAIN_TARGET', main)
  /** Sessions whose FrameSession is still initializing: Playwright buffers their attaches (`_bufferedAttachedToTargetEvents`). */
  const initializing = new Map<FakeSession, Protocol.Target.AttachedToTargetEvent[]>()
  /** Playwright's `FrameSession._onAttachedToTarget`: the child session is always created under the frame's session. */
  const create = (frameSession: FakeFrameSession, event: Protocol.Target.AttachedToTargetEvent): void => {
    const child = frameSession._client.createChildSession(event.sessionId)
    if (event.targetInfo.type === 'iframe') {
      const childFrame: FakeFrameSession = { _client: child, _workerSessions: new Map() }
      frameSessions.set(event.targetInfo.targetId, childFrame)
      attachUnder(childFrame)
      return
    }
    if (event.targetInfo.type !== 'worker') return
    frameSession._workerSessions.set(event.sessionId, child)
    workers.set(event.sessionId, { url: event.targetInfo.url })
    child.on('Target.attachedToTarget', (nested: Protocol.Target.AttachedToTargetEvent) => create(frameSession, nested))
    child.on('Target.detachedFromTarget', (gone: Protocol.Target.DetachedFromTargetEvent) => detach(frameSession, gone))
  }
  const detach = (frameSession: FakeFrameSession, event: Protocol.Target.DetachedFromTargetEvent): void => {
    frameSession._workerSessions.delete(event.sessionId)
    workers.delete(event.sessionId)
  }
  const attachUnder = (frameSession: FakeFrameSession): void => {
    frameSession._client.on('Target.attachedToTarget', (event: Protocol.Target.AttachedToTargetEvent) => {
      const queue = initializing.get(frameSession._client)
      if (queue) queue.push(event)
      else create(frameSession, event)
    })
    frameSession._client.on('Target.detachedFromTarget', (event: Protocol.Target.DetachedFromTargetEvent) => detach(frameSession, event))
  }
  attachUnder(main)
  const serverPage = { delegate: { _mainFrameSession: main, _sessions: frameSessions }, _workers: workers }
  const page = { _connection: { toImpl: () => serverPage } } as unknown as Page
  /** Chrome attaches a target on `parent`; returns the session Playwright created for it (none while it buffers). */
  const attach = (parent: FakeSession, sessionId: string, targetId: string, type = 'iframe', url = ''): FakeSession | undefined => {
    parent.emit('Target.attachedToTarget', { sessionId, targetInfo: { targetId, type, url }, waitingForDebugger: true })
    return sessions.get(sessionId)
  }
  /** Hold `parent`'s attaches until `initialized(parent)`, as Playwright does until it has the frame tree. */
  const initializingFrom = (parent: FakeSession): void => {
    initializing.set(parent, [])
  }
  const initialized = (parent: FakeSession): void => {
    const queue = initializing.get(parent) ?? []
    initializing.delete(parent)
    const frameSession = [...frameSessions.values()].find((candidate) => candidate._client === parent)!
    for (const event of queue) create(frameSession, event)
  }
  return { main: main._client, page, sessions, attach, initializingFrom, initialized }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Options for a tap on a page that starts no worker. */
const noWorkers = {
  onWorker: (worker: TappedWorker) => expect.fail(`unexpected worker ${worker.url}`),
  onError: (error: unknown) => expect.fail(String(error)),
}

describe('PageSessionTap', () => {
  it("holds a new iframe's events from its first one and hands them over in order, with when each arrived, then live", () => {
    const { main, page, attach } = fakeServer()
    const tap = new PageSessionTap({ page, ...noWorkers })
    const attachedAt = Date.now()
    const iframe = attach(main, 'S1', 'F1')!
    // The renderer runs as soon as Playwright resumed it.
    iframe.emit('Network.requestWillBeSent', { requestId: 'early' })
    vi.advanceTimersByTime(30)
    iframe.emit('Network.loadingFinished', { requestId: 'early' })

    const session = tap.session('F1')!
    const seen: string[] = []
    session.on('Network.requestWillBeSent', (event, at) => seen.push(`sent ${event.requestId} +${at - attachedAt}`))
    session.on('Network.loadingFinished', (event, at) => seen.push(`finished ${event.requestId} +${at - attachedAt}`))
    expect(seen).toEqual([])
    session.start()
    expect(seen).toEqual(['sent early +0', 'finished early +30'])
    vi.advanceTimersByTime(10)
    iframe.emit('Network.requestWillBeSent', { requestId: 'later' })
    expect(seen.at(-1)).toBe('sent later +40')
    expect(tap.session('F1')).toBe(session)
    tap.dispose()
  })

  it("holds the iframes an iframe embeds, and an iframe whose session Playwright creates after buffering its attach", () => {
    const { main, page, sessions, attach, initializingFrom, initialized } = fakeServer()
    const tap = new PageSessionTap({ page, ...noWorkers })
    const outer = attach(main, 'S1', 'F1')!
    const inner = attach(outer, 'S2', 'F2')!
    inner.emit('Network.requestWillBeSent', { requestId: 'inner' })
    // Playwright buffers the attaches that arrive while a frame session initializes, and creates their sessions later.
    initializingFrom(outer)
    expect(attach(outer, 'S3', 'F3')).toBeUndefined()
    initialized(outer)
    sessions.get('S3')!.emit('Network.requestWillBeSent', { requestId: 'buffered' })
    for (const [frameId, expected] of [['F2', 'inner'], ['F3', 'buffered']] as const) {
      const seen: string[] = []
      const session = tap.session(frameId)!
      session.on('Network.requestWillBeSent', (event) => seen.push(event.requestId))
      session.start()
      expect(seen).toEqual([expected])
    }
    tap.dispose()
  })

  it('holds nothing of other targets, and lets go of a detached iframe, of one nobody takes, and of everything on dispose', () => {
    const { main, page, attach } = fakeServer()
    const tap = new PageSessionTap({ page, ...noWorkers })
    const serviceWorker = attach(main, 'W1', 'T-service-worker', 'service_worker')!
    expect(serviceWorker.listenerCount('Network.requestWillBeSent')).toBe(0)

    const removed = attach(main, 'S1', 'F1')!
    expect(removed.listenerCount('Network.requestWillBeSent')).toBe(1)
    main.emit('Target.detachedFromTarget', { sessionId: 'S1' })
    expect(removed.listenerCount('Network.requestWillBeSent')).toBe(0)

    const untaken = attach(main, 'S2', 'F2')!
    untaken.emit('Network.requestWillBeSent', { requestId: 'unread' })
    tap.discard('F2')
    expect(untaken.listenerCount('Network.requestWillBeSent')).toBe(0)
    // Asked for again, it is followed from then on: what was let go is gone.
    const seen: string[] = []
    const again = tap.session('F2')!
    again.on('Network.requestWillBeSent', (event) => seen.push(event.requestId))
    again.start()
    untaken.emit('Network.requestWillBeSent', { requestId: 'next' })
    expect(seen).toEqual(['next'])

    tap.dispose()
    expect(untaken.listenerCount('Network.requestWillBeSent')).toBe(0)
    // Only Playwright's own attach handler is left on the page's session.
    expect(main.listenerCount('Target.attachedToTarget')).toBe(1)
  })

  it('follows an iframe session that existed before the tap from when it is asked for', () => {
    const { main, page, attach } = fakeServer()
    const before = attach(main, 'S1', 'F1')!
    before.emit('Network.requestWillBeSent', { requestId: 'before the watch' })
    const tap = new PageSessionTap({ page, ...noWorkers })
    const seen: string[] = []
    const session = tap.session('F1')!
    session.on('Network.requestWillBeSent', (event) => seen.push(event.requestId))
    session.start()
    before.emit('Network.requestWillBeSent', { requestId: 'after' })
    expect(seen).toEqual(['after'])
    // Its detach is noticed too.
    main.emit('Target.detachedFromTarget', { sessionId: 'S1' })
    expect(before.listenerCount('Network.requestWillBeSent')).toBe(0)
    tap.dispose()
  })

  it("hands over each dedicated worker as Playwright creates its session — a nested one too — with its events from the first one", async () => {
    const { main, page, attach } = fakeServer()
    const workers: TappedWorker[] = []
    const tap = new PageSessionTap({ page, onWorker: (worker) => workers.push(worker), onError: noWorkers.onError })
    const sync = attach(main, 'W1', 'T-sync', 'worker', 'http://app.test/sync.js')!
    // The worker runs as soon as Playwright resumed it.
    sync.emit('Network.requestWillBeSent', { requestId: 'sync' })
    // A worker it starts attaches on its session; Playwright creates that session under the frame's.
    const audit = attach(sync, 'W2', 'T-audit', 'worker', 'http://app.test/audit.js')!
    audit.emit('Network.requestWillBeSent', { requestId: 'audit' })
    expect(workers.map((worker) => worker.url)).toEqual(['http://app.test/sync.js', 'http://app.test/audit.js'])
    const seen = workers.map((worker) => {
      const requests: string[] = []
      worker.session.on('Network.requestWillBeSent', (event) => requests.push(event.requestId))
      worker.session.start()
      return requests
    })
    expect(seen).toEqual([['sync'], ['audit']])
    // A response body is asked for on the worker's own session.
    expect(await workers[1]!.cdp.send('Network.getResponseBody', { requestId: 'audit' })).toEqual({ body: 'answered by W2', base64Encoded: false })
    expect(audit.sent).toEqual(['Network.getResponseBody'])
    await expect(workers[1]!.cdp.detach()).rejects.toThrow('never detached')
    tap.dispose()
  })

  it('hands over the workers already running when it starts, and lets go of one that ended, telling the watch, and of the rest on dispose', () => {
    const { main, page, attach } = fakeServer()
    const running = attach(main, 'W0', 'T-running', 'worker', 'http://app.test/running.js')!
    const workers: TappedWorker[] = []
    const tap = new PageSessionTap({ page, onWorker: (worker) => workers.push(worker), onError: noWorkers.onError })
    expect(workers.map((worker) => worker.url)).toEqual(['http://app.test/running.js'])
    const later = attach(main, 'W1', 'T-later', 'worker', 'http://app.test/later.js')!
    const ended: string[] = []
    workers.forEach((worker) => worker.session.onClose(() => ended.push(worker.url)))
    expect(later.listenerCount('Network.requestWillBeSent')).toBe(1)
    main.emit('Target.detachedFromTarget', { sessionId: 'W1' })
    expect(later.listenerCount('Network.requestWillBeSent')).toBe(0)
    expect(ended).toEqual(['http://app.test/later.js'])
    tap.dispose()
    expect(running.listenerCount('Network.requestWillBeSent')).toBe(0)
    expect(ended).toEqual(['http://app.test/later.js', 'http://app.test/running.js'])
  })
})
