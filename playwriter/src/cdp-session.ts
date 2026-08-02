import type { Page, Frame, CDPSession as PlaywrightCDPSession } from '@xmorse/playwright-core'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'

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

/**
 * Wraps Playwright's CDPSession (from context.getExistingCDPSession) into an ICDPSession.
 * This reuses Playwright's internal CDP WebSocket instead of creating a new one,
 * which is important for the relay server where Target.attachToTarget is intercepted.
 */
export class PlaywrightCDPSessionAdapter implements ICDPSession {
  private _playwrightSession: PlaywrightCDPSession

  constructor(playwrightSession: PlaywrightCDPSession) {
    this._playwrightSession = playwrightSession
  }

  async send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
  ): Promise<ProtocolMapping.Commands[K]['returnType']> {
    return await this._playwrightSession.send(method as never, params as never)
  }

  on<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this._playwrightSession.on(event as never, callback as never)
    return this
  }

  off<K extends keyof ProtocolMapping.Events>(
    event: K,
    callback: (params: ProtocolMapping.Events[K][0]) => void,
  ): this {
    this._playwrightSession.off(event as never, callback as never)
    return this
  }

  async detach(): Promise<void> {
    await this._playwrightSession.detach()
  }
}

/**
 * Gets a CDP session for a page by reusing Playwright's internal existing CDP session.
 * This uses the same WebSocket Playwright already has, avoiding new connections.
 * Works through the relay because it doesn't call Target.attachToTarget.
 */
export async function getCDPSessionForPage({ page }: { page: Page }): Promise<PlaywrightCDPSessionAdapter> {
  const context = page.context()
  const playwrightSession = await context.getExistingCDPSession(page)
  return new PlaywrightCDPSessionAdapter(playwrightSession)
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
 */
export async function getCDPSessionForFrame({ frame }: { frame: Frame }): Promise<PlaywrightCDPSessionAdapter | null> {
  const context = frame.page().context()
  try {
    const playwrightSession = await context.getExistingCDPSession(frame)
    return new PlaywrightCDPSessionAdapter(playwrightSession)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes(NO_SEPARATE_SESSION)) return null
    throw error
  }
}
