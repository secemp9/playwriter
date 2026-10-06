/**
 * session-tap.ts — the CDP events of a page's out-of-process iframes and dedicated workers, from the
 * first one.
 *
 * Playwright's server attaches to every new iframe and worker target paused (`waitForDebuggerOnStart`)
 * and, in one synchronous run (`FrameSession._onAttachedToTarget`, crPage.ts), creates the target's
 * session, enables Network (and Runtime) on it and sends `Runtime.runIfWaitingForDebugger`: the
 * iframe's document or the worker's script starts running right then, and Chrome reports their
 * requests on that session only. playwriter learns of an iframe from Playwright's client events and
 * borrows its session with a client→server round trip (`getExistingCDPSession`), so what Chrome
 * reported before the borrow never reached the journal (measured: a POST an iframe's script sent as
 * its document started was missing from `net.requests()`); a worker's session it could not borrow at
 * all (measured: a click whose worker POSTed settled before the POST answered, and the POST was in
 * neither the report nor `net.requests()`).
 *
 * Playwright's server runs in this process. A watched page's server sessions are tapped: the server's
 * `CRSession.prototype.createChildSession` is wrapped (taken from the page's own session, so a server
 * shipped as one bundle is reached too), and when a tapped session gets the session of an iframe or
 * worker target — the type is read from `Target.attachedToTarget`, heard before Playwright's own
 * handler — the child is tapped in that same synchronous run: before Playwright resumes it, so before
 * Chrome can report anything on it. A worker's session is followed for the workers it starts too
 * (Playwright creates their sessions under the frame's, from attaches it hears on the worker's).
 * Events are held, in order and with the time each arrived, until the watch takes them
 * (`TappedSession.start`); after that they are passed on as they arrive. An iframe's session is taken
 * when the watch follows the frame; a worker's is handed to the watch as it is created
 * (`onWorker`), and the workers that already run when the tap starts are handed over then. Held
 * events go with their session when its target detaches, or when the watch gives up on the frame
 * (`discard`).
 */

import type { Page } from '@xmorse/playwright-core'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'
import type { ICDPSession } from './cdp-session.js'
import { field, serverObject } from './playwright-server.js'

/** The events the journal follows on an iframe's or a worker's session. */
export const TAPPED_EVENTS = [
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.dataReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.requestServedFromCache',
  'Network.webSocketCreated',
  'Network.webSocketClosed',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  // A frame's navigation whose response became a download (the navigation request is canceled for it).
  'Page.downloadWillBegin',
] as const

export type TappedEvent = (typeof TAPPED_EVENTS)[number]

/** A listener of a tapped session: the event, and when it reached this process (epoch ms, this process's clock). */
export type TapListener<K extends TappedEvent> = (params: ProtocolMapping.Events[K][0], arrivedAt: number) => void

/** An out-of-process iframe's or a worker's session, as the tap holds it. */
export interface TappedSession {
  on<K extends TappedEvent>(event: K, listener: TapListener<K>): void
  off<K extends TappedEvent>(event: K, listener: TapListener<K>): void
  /** Hand the held events to the listeners, in the order they arrived, then every later one as it arrives. */
  start(): void
  /** Called once the tap stops following the session: its target detached, or the tap was disposed. */
  onClose(listener: () => void): void
}

/** A dedicated worker of the page, nested ones included. */
export interface TappedWorker {
  /** Its script's address. */
  url: string
  session: TappedSession
  /** Commands to the worker's session (Playwright's own, in its server): there is no client session for a worker. */
  cdp: ICDPSession
}

/** What the journal needs of a page's tap. */
export interface SessionTap {
  /**
   * The session of out-of-process iframe `frameId` now: the tapped one, holding its events from its
   * first, or — for a session that existed before the tap — one tapped from now on. The same object
   * for as long as the frame keeps that session. Null when the frame has no session of its own (it is
   * rendered by its parent's process).
   */
  session(frameId: string): TappedSession | null
  /** Drop what the current session of `frameId` holds, unless it was started: nobody will take it. */
  discard(frameId: string): void
  dispose(): void
}

/** The part of Playwright's server `CRSession` the tap uses: an event emitter of the session's CDP events that sends commands. */
interface ServerSession {
  on<K extends keyof ProtocolMapping.Events>(event: K, listener: (params: ProtocolMapping.Events[K][0]) => void): unknown
  off<K extends keyof ProtocolMapping.Events>(event: K, listener: (params: ProtocolMapping.Events[K][0]) => void): unknown
  prependListener<K extends keyof ProtocolMapping.Events>(event: K, listener: (params: ProtocolMapping.Events[K][0]) => void): unknown
  send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
  ): Promise<ProtocolMapping.Commands[K]['returnType']>
}

function isServerSession(value: unknown): value is ServerSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof field(value, 'on') === 'function' &&
    typeof field(value, 'off') === 'function' &&
    typeof field(value, 'prependListener') === 'function' &&
    typeof field(value, 'send') === 'function' &&
    typeof field(value, 'createChildSession') === 'function'
  )
}

/** The taps that follow each server session's new children. */
const tapsOf = new WeakMap<object, Set<PageSessionTap>>()
/** `CRSession` prototypes whose `createChildSession` is wrapped. */
const wrapped = new WeakSet<object>()

/** Wrap `createChildSession` on the prototype `session` was built from, once: every tap of the parent hears of each child. */
function wrapCreateChildSession(session: ServerSession): void {
  const prototype: unknown = Object.getPrototypeOf(session)
  const original = field(prototype, 'createChildSession')
  if (typeof prototype !== 'object' || prototype === null || typeof original !== 'function') {
    throw new Error("session-tap: Playwright's server session has no createChildSession on its prototype; the first events of new iframes and workers cannot be journaled.")
  }
  if (wrapped.has(prototype)) return
  wrapped.add(prototype)
  Reflect.set(prototype, 'createChildSession', function createChildSession(this: unknown, ...args: unknown[]): unknown {
    const child: unknown = Reflect.apply(original, this, args)
    const taps = typeof this === 'object' && this !== null ? tapsOf.get(this) : undefined
    if (taps) for (const tap of [...taps]) tap.childCreated(args[0], child)
    return child
  })
}

/** Commands through a server session. Playwright owns it: it is never detached from here. */
class ServerSessionCommands implements ICDPSession {
  constructor(private readonly server: ServerSession) {}

  async send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
  ): Promise<ProtocolMapping.Commands[K]['returnType']> {
    return await this.server.send(method, params)
  }

  on<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this.server.on(event, callback)
    return this
  }

  off<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this.server.off(event, callback)
    return this
  }

  async detach(): Promise<void> {
    throw new Error("session-tap: a worker's session belongs to Playwright's server and is never detached by playwriter.")
  }
}

type AnyTapListener = (params: never, arrivedAt: number) => void

class Tapped implements TappedSession {
  /** Events not handed on yet; null once started or closed. */
  private held: Array<{ event: TappedEvent; params: unknown; arrivedAt: number }> | null = []
  started = false
  private readonly listeners = new Map<TappedEvent, Set<AnyTapListener>>()
  private readonly closeListeners: Array<() => void> = []
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    readonly server: ServerSession,
    /** Its session id under the parent, so its detach is noticed (null when the server keeps none). */
    readonly sessionId: string | null,
  ) {
    for (const event of TAPPED_EVENTS) {
      const arrive = (params: unknown): void => this.arrive(event, params, Date.now())
      server.on(event, arrive)
      this.unsubscribe.push(() => server.off(event, arrive))
    }
  }

  on<K extends TappedEvent>(event: K, listener: TapListener<K>): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
  }

  off<K extends TappedEvent>(event: K, listener: TapListener<K>): void {
    this.listeners.get(event)?.delete(listener)
  }

  start(): void {
    const held = this.held
    if (this.started || held === null) return
    this.started = true
    this.held = null
    for (const { event, params, arrivedAt } of held) this.dispatch(event, params, arrivedAt)
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }

  /** Stop listening to the server session and drop what is held. */
  close(): void {
    for (const off of this.unsubscribe.splice(0)) off()
    this.held = null
    this.started = false
    for (const listener of this.closeListeners.splice(0)) listener()
  }

  private arrive(event: TappedEvent, params: unknown, arrivedAt: number): void {
    if (this.held !== null) this.held.push({ event, params, arrivedAt })
    else if (this.started) this.dispatch(event, params, arrivedAt)
  }

  private dispatch(event: TappedEvent, params: unknown, arrivedAt: number): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) Reflect.apply(listener, undefined, [params, arrivedAt])
  }
}

/** The session id `CRSession.sessionId()` returns, or null when the server keeps none. */
function sessionIdOf(server: ServerSession): string | null {
  const idOf = field(server, 'sessionId')
  const id: unknown = typeof idOf === 'function' ? Reflect.apply(idOf, server, []) : undefined
  return typeof id === 'string' ? id : null
}

/**
 * The sessions of one watched page in Playwright's in-process server: the page's own, its
 * out-of-process iframes' and its workers', each followed for the iframe and worker sessions it creates.
 */
export class PageSessionTap implements SessionTap {
  /** Server sessions followed for the children they create, with what stops following each. */
  private readonly parents = new Map<ServerSession, () => void>()
  /** Session id → an iframe or worker target that attached and whose session is not created yet. */
  private readonly attaching = new Map<string, { type: 'iframe' | 'worker'; url: string }>()
  private readonly children = new Map<ServerSession, Tapped>()
  /** Playwright's `CRPage._sessions`: target id → `FrameSession`, the page's and each out-of-process iframe's. */
  private readonly frameSessions: Map<unknown, unknown>
  private readonly onWorker: (worker: TappedWorker) => void
  private readonly onError: (error: unknown) => void
  private disposed = false

  /**
   * Tap `page`'s server sessions. `onWorker` is handed every worker that runs now, then each new one
   * as Playwright creates its session — inside Playwright's attach, so it must not call into
   * Playwright. `onError` hears what went wrong there, where nothing may be thrown. Throws when
   * Playwright's server is not in this process or not laid out as expected.
   */
  constructor(options: { page: Page; onWorker: (worker: TappedWorker) => void; onError: (error: unknown) => void }) {
    this.onWorker = options.onWorker
    this.onError = options.onError
    const serverPage = serverObject(options.page, "the page's renderer sessions")
    const crPage = field(serverPage, 'delegate')
    const mainFrameSession = field(crPage, '_mainFrameSession')
    const main = field(mainFrameSession, '_client')
    const sessions = field(crPage, '_sessions')
    const workers = field(serverPage, '_workers')
    if (!isServerSession(main) || !(sessions instanceof Map) || !(workers instanceof Map)) {
      throw new Error(
        "session-tap: Playwright's server page has no _mainFrameSession._client session, _sessions map or _workers map; the first events of new iframes and the requests of workers cannot be journaled.",
      )
    }
    this.frameSessions = sessions
    wrapCreateChildSession(main)
    const running: TappedWorker[] = []
    for (const frameSession of new Set([mainFrameSession, ...sessions.values()])) {
      const client = field(frameSession, '_client')
      const workerSessions = field(frameSession, '_workerSessions')
      if (!isServerSession(client) || !(workerSessions instanceof Map)) {
        throw new Error("session-tap: a Playwright frame session has no _client session or _workerSessions map; the requests of workers cannot be journaled.")
      }
      // Iframe sessions that exist already create theirs too.
      this.follow(client)
      for (const [sessionId, workerSession] of workerSessions) {
        const url = field(workers.get(sessionId), 'url')
        if (typeof sessionId !== 'string' || !isServerSession(workerSession) || typeof url !== 'string') {
          throw new Error(`session-tap: Playwright's server keeps worker session ${String(sessionId)} without a worker script address; its requests cannot be journaled.`)
        }
        running.push(this.tapWorker(workerSession, sessionId, url))
      }
    }
    for (const worker of running) this.onWorker(worker)
  }

  session(frameId: string): TappedSession | null {
    if (this.disposed) return null
    const client = field(this.frameSessions.get(frameId), '_client')
    if (!isServerSession(client)) return null
    const known = this.children.get(client)
    if (known) return known
    // Tapped after it attached: its id under the parent, so its detach is noticed too.
    const tapped = new Tapped(client, sessionIdOf(client))
    this.children.set(client, tapped)
    this.follow(client)
    return tapped
  }

  discard(frameId: string): void {
    const client = field(this.frameSessions.get(frameId), '_client')
    const tapped = isServerSession(client) ? this.children.get(client) : undefined
    if (!tapped || tapped.started) return
    tapped.close()
    this.children.delete(tapped.server)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const children = [...this.children.values()]
    this.children.clear()
    for (const stop of this.parents.values()) stop()
    this.parents.clear()
    this.attaching.clear()
    for (const tapped of children) tapped.close()
  }

  /** Called by the wrapped `createChildSession` of a session this tap follows. Never throws into Playwright. */
  childCreated(sessionId: unknown, child: unknown): void {
    try {
      if (this.disposed || typeof sessionId !== 'string' || !isServerSession(child)) return
      const target = this.attaching.get(sessionId)
      if (target === undefined) return
      this.attaching.delete(sessionId)
      if (target.type === 'worker') {
        this.onWorker(this.tapWorker(child, sessionId, target.url))
        return
      }
      this.children.set(child, new Tapped(child, sessionId))
      this.follow(child)
    } catch (error) {
      this.onError(error)
    }
  }

  private tapWorker(server: ServerSession, sessionId: string, url: string): TappedWorker {
    const tapped = new Tapped(server, sessionId)
    this.children.set(server, tapped)
    // The workers it starts attach on its session.
    this.follow(server)
    return { url, session: tapped, cdp: new ServerSessionCommands(server) }
  }

  /** Learn the iframe and worker targets `session` attaches (before Playwright creates their sessions), and drop the ones it detaches. */
  private follow(session: ServerSession): void {
    if (this.parents.has(session)) return
    const onAttached = (event: ProtocolMapping.Events['Target.attachedToTarget'][0]): void => {
      const { type, url } = event.targetInfo
      if (type === 'iframe' || type === 'worker') this.attaching.set(event.sessionId, { type, url })
    }
    const onDetached = (event: ProtocolMapping.Events['Target.detachedFromTarget'][0]): void => {
      this.attaching.delete(event.sessionId)
      for (const [server, tapped] of [...this.children]) {
        if (tapped.sessionId !== event.sessionId) continue
        this.children.delete(server)
        // A detached session creates no more children.
        this.parents.get(server)?.()
        this.parents.delete(server)
        tapped.close()
      }
    }
    // Before Playwright's own handler, which creates the child session.
    session.prependListener('Target.attachedToTarget', onAttached)
    session.on('Target.detachedFromTarget', onDetached)
    let taps = tapsOf.get(session)
    if (!taps) {
      taps = new Set()
      tapsOf.set(session, taps)
    }
    taps.add(this)
    const followers = taps
    this.parents.set(session, () => {
      session.off('Target.attachedToTarget', onAttached)
      session.off('Target.detachedFromTarget', onDetached)
      followers.delete(this)
    })
  }
}
