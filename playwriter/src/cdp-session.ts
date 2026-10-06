import type { Page, Frame, CDPSession as PlaywrightCDPSession } from '@xmorse/playwright-core'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'
import { withDeadline } from './isolated-world.js'
import { ModelFacingError } from './probe-types.js'
import { openingOwnCdpSession } from './playwright-client-hooks.js'
import { restoreIsChromiumOption } from './playwright-server.js'

/** Borrowing a session is one Playwright protocol round trip; if it does not come back, say so rather than hang. */
const BORROW_TIMEOUT_MS = 10_000

/**
 * Type-safe CDP session interface using devtools-protocol ProtocolMapping.
 * Provides autocomplete and type checking for CDP commands and events.
 * Return types are inferred from the command string (e.g. 'Page.getLayoutMetrics'
 * returns Protocol.Page.GetLayoutMetricsResponse).
 *
 * `send` takes TWO parameters and no more. It used to declare a third, `sessionId`,
 * which `PlaywrightCDPSessionAdapter` never implemented — TypeScript accepts a
 * two-parameter function as a three-parameter type, so the argument was dropped
 * silently at every call site and every "OOPIF-targeted" command actually ran on the
 * page session. There is no honest way to add it back: a Playwright `CDPSession` is
 * bound to ONE CRSession (`crConnection.ts` stamps the sessionId itself), so routing
 * by sessionId is not expressible here. Talk to another target by getting a session
 * FOR that target — see `getCDPSessionForFrame`.
 */
export interface ICDPSession {
  send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
  ): Promise<ProtocolMapping.Commands[K]['returnType']>

  on<K extends keyof ProtocolMapping.Events>(
    event: K,
    callback: (params: ProtocolMapping.Events[K][0]) => void,
  ): unknown

  off<K extends keyof ProtocolMapping.Events>(
    event: K,
    callback: (params: ProtocolMapping.Events[K][0]) => void,
  ): unknown

  detach(): Promise<void>
  getSessionId?(): string | null
}

type AnyListener = (params: never) => void

/**
 * Wraps Playwright's CDPSession (from context.getExistingCDPSession) into an ICDPSession.
 * This reuses Playwright's internal CDP WebSocket instead of creating a new one,
 * which is important for the relay server where Target.attachToTarget is intercepted.
 *
 * Every listener registered through the adapter is remembered, so `release()` can take
 * all of them off Playwright's session at once (the page cache calls it when the page
 * closes). After `release()` the adapter refuses further use instead of quietly never
 * firing.
 */
export class PlaywrightCDPSessionAdapter implements ICDPSession {
  private readonly _playwrightSession: PlaywrightCDPSession
  private readonly _listeners: Array<{ event: string; callback: AnyListener }> = []
  private _releasedBecause: string | null = null

  constructor(playwrightSession: PlaywrightCDPSession) {
    this._playwrightSession = playwrightSession
  }

  async send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
  ): Promise<ProtocolMapping.Commands[K]['returnType']> {
    this.assertLive(`send ${method}`)
    return await this._playwrightSession.send(method as never, params as never)
  }

  on<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this.assertLive(`listen for ${event}`)
    this._playwrightSession.on(event as never, callback as never)
    this._listeners.push({ event, callback })
    return this
  }

  off<K extends keyof ProtocolMapping.Events>(
    event: K,
    callback: (params: ProtocolMapping.Events[K][0]) => void,
  ): this {
    // Mirrors EventEmitter: one `off` removes one registration.
    const index = this._listeners.findIndex((entry) => entry.event === event && entry.callback === callback)
    if (index === -1) return this
    this._listeners.splice(index, 1)
    this._playwrightSession.off(event as never, callback as never)
    return this
  }

  /** Number of listeners currently registered through this adapter. */
  listenerCount(): number {
    return this._listeners.length
  }

  /**
   * Removes every listener registered through this adapter from Playwright's session and
   * makes later `send`/`on` calls throw, naming `reason`. Idempotent.
   */
  release(reason: string): void {
    if (this._releasedBecause !== null) return
    this._releasedBecause = reason
    for (const { event, callback } of this._listeners.splice(0)) {
      this._playwrightSession.off(event as never, callback as never)
    }
  }

  /**
   * Detaches the underlying Playwright session. For a session borrowed with
   * `getExistingCDPSession` (everything `getCDPSessionForPage`/`getCDPSessionForFrame`
   * return) Playwright makes this a no-op: the session is Playwright's own page session
   * and stays attached for as long as the page lives.
   */
  async detach(): Promise<void> {
    await this._playwrightSession.detach()
  }

  private assertLive(action: string): void {
    if (this._releasedBecause === null) return
    throw new ModelFacingError(
      `Cannot ${action}: this CDP session was released because ${this._releasedBecause}. ` +
        `Get a session for a live page with getCDPSession({ page }).`,
    )
  }
}

/**
 * One adapter per page, shared by every caller.
 *
 * Each `getExistingCDPSession` call makes the Playwright fork mint a new
 * `CDPSessionBorrowed` (`crConnection.ts`), whose constructor chains a forwarder onto the
 * page CRSession's `_eventListener` and never unchains it; its dispatcher lives until the
 * browser context closes. Minting one per call therefore made every page event fan out
 * to every wrapper ever created. Borrowing once per page caps that at one, and the
 * adapter is released (its listeners removed) when the page closes.
 *
 * The promise is cached, not the adapter, so concurrent first calls share one borrow.
 */
const pageSessions = new WeakMap<Page, Promise<PlaywrightCDPSessionAdapter>>()

/**
 * Gets THE CDP session for a page: Playwright's own page session, borrowed once and
 * shared by every caller in the process. Nothing here attaches to the target, so it
 * works through the relay, where Target.attachToTarget is intercepted.
 *
 * Shared means: never send `*.disable` on it and never rely on `detach()` — both reach
 * Playwright's own session, which the rest of the process depends on.
 */
export function getCDPSessionForPage({ page }: { page: Page }): Promise<PlaywrightCDPSessionAdapter> {
  const cached = pageSessions.get(page)
  if (cached) return cached
  if (page.isClosed()) {
    return Promise.reject(new ModelFacingError(`Cannot get a CDP session for ${page.url() || 'the page'}: the page is closed.`))
  }
  const opening = borrowForPage(page)
  pageSessions.set(page, opening)
  opening.catch(() => {
    if (pageSessions.get(page) === opening) pageSessions.delete(page)
  })
  return opening
}

async function borrowForPage(page: Page): Promise<PlaywrightCDPSessionAdapter> {
  restoreIsChromiumOption(page.context())
  const session = await withDeadline(
    openingOwnCdpSession.run(true, () => page.context().getExistingCDPSession(page)),
    BORROW_TIMEOUT_MS,
    "borrowing Playwright's CDP session for the page",
  )
  const adapter = new PlaywrightCDPSessionAdapter(session)
  const closedReason = 'its page was closed'
  if (page.isClosed()) {
    adapter.release(closedReason)
    throw new ModelFacingError(`Cannot get a CDP session for ${page.url() || 'the page'}: the page closed while it was being opened.`)
  }
  page.once('close', () => {
    pageSessions.delete(page)
    adapter.release(closedReason)
  })
  return adapter
}

/** Playwright's wording when a frame is rendered by its parent's process. Matched on
 *  because it is the ONE outcome that is not an error: it means "same-process iframe",
 *  which is answered with the page session plus a `frameId` parameter. Any other
 *  failure must keep propagating. */
const NO_SEPARATE_SESSION = 'does not have a separate CDP session'

/**
 * The CDP session that owns a frame's document, or `null` when the frame has none of
 * its own.
 *
 * Measured against real Chromium (`--site-per-process`), the two cases are genuinely
 * different protocols, not two spellings of one:
 *
 *   - CROSS-PROCESS (OOPIF): Playwright already holds a separate CRSession for the
 *     frame. That session answers `DOM.getFlattenedDocument` / `Accessibility.getFullAXTree`
 *     for the iframe's document. The PAGE session cannot: `getFullAXTree({ frameId })`
 *     fails there with "Frame with the given frameId is not found", and unscoped it
 *     returns the TOP document's tree — the parent's content wearing the child's name.
 *   - SAME-PROCESS: no separate session exists (this returns `null`), and the page
 *     session answers for the frame when given `{ frameId }`.
 *
 * This deliberately does NOT call `Target.attachToTarget`. Playwright's own session map
 * is the authority, and the relay (`cdp-relay.ts`) answers `attachToTarget` only for
 * targets already in `connectedTargets` — which never contains iframe targets — so the
 * attach route could not work through the relay at all.
 *
 * An OOPIF's adapter is cached like a page's (same fan-out leak otherwise), but only
 * until the frame navigates or detaches: a cross-process navigation gives the frame a
 * NEW Playwright session, so a cached one could be dead. The dropped adapter is not
 * released — whoever holds it keeps their listeners — it is just not handed out again;
 * every cached frame adapter is released when its page closes. `null` is never cached:
 * a same-process frame becomes an OOPIF by navigating, and asking costs no wrapper.
 */
export function getCDPSessionForFrame({ frame }: { frame: Frame }): Promise<PlaywrightCDPSessionAdapter | null> {
  const cached = frameSessions.get(frame)
  if (cached) return cached
  const opening = borrowForFrame(frame)
  frameSessions.set(frame, opening)
  opening.then(
    (adapter) => {
      if (adapter === null && frameSessions.get(frame) === opening) frameSessions.delete(frame)
    },
    () => {
      if (frameSessions.get(frame) === opening) frameSessions.delete(frame)
    },
  )
  return opening
}

const frameSessions = new WeakMap<Frame, Promise<PlaywrightCDPSessionAdapter | null>>()
/** Every frame adapter borrowed on a page, released together when the page closes. */
const frameAdaptersByPage = new WeakMap<Page, Set<PlaywrightCDPSessionAdapter>>()

async function borrowForFrame(frame: Frame): Promise<PlaywrightCDPSessionAdapter | null> {
  const page = frame.page()
  restoreIsChromiumOption(page.context())
  let playwrightSession: PlaywrightCDPSession
  try {
    playwrightSession = await withDeadline(
      openingOwnCdpSession.run(true, () => page.context().getExistingCDPSession(frame)),
      BORROW_TIMEOUT_MS,
      "borrowing Playwright's CDP session for the frame",
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes(NO_SEPARATE_SESSION)) return null
    throw error
  }
  const adapter = new PlaywrightCDPSessionAdapter(playwrightSession)
  let adapters = frameAdaptersByPage.get(page)
  if (!adapters) {
    const created = new Set<PlaywrightCDPSessionAdapter>()
    adapters = created
    frameAdaptersByPage.set(page, created)
    const forget = (changed: Frame) => frameSessions.delete(changed)
    page.on('framenavigated', forget)
    page.on('framedetached', forget)
    page.once('close', () => {
      page.off('framenavigated', forget)
      page.off('framedetached', forget)
      for (const each of created) each.release('its page was closed')
      created.clear()
    })
  }
  adapters.add(adapter)
  return adapter
}

/** Reading a title is one browser round trip; a tab that does not answer in time is named as such by the caller. */
const TITLE_TIMEOUT_MS = 1500

/**
 * The title of the tab's current document, read in the browser process: its navigation entry's
 * title (`Page.getNavigationHistory`), which the browser keeps in step with `document.title`.
 * Playwright's `page.title()` evaluates in the page as a user gesture — measured: it gives the page
 * transient and sticky user activation, which changes what the page may do afterwards (a "Leave
 * site?" prompt, autoplay with sound, popups, file dialogs) — and cannot answer while a JS dialog
 * freezes the page. This does neither. Not `Target.getTargetInfo`: through the relay that answers
 * from the target list taken when the tab was attached (measured: a stale "about:blank").
 */
export async function tabTitle(page: Page): Promise<string> {
  const cdp = await getCDPSessionForPage({ page })
  const history = await withDeadline(cdp.send('Page.getNavigationHistory'), TITLE_TIMEOUT_MS, 'reading the tab title (Page.getNavigationHistory)')
  const entry = history.entries[history.currentIndex]
  if (!entry) throw new Error(`the tab's history has no entry ${history.currentIndex} (it lists ${history.entries.length})`)
  return entry.title
}
