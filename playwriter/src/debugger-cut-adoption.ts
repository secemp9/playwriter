/**
 * The session's side of a debugger cut (debugger-cut.ts). Over the relay, a page that closes may be a
 * tab Chrome only took the extension's debugger off: the tab is still open, and the extension
 * re-attaches it as soon as Chrome allows. `pageClosed` holds the closed controlled page; `settle`
 * asks the relay what became of its tab and, when it is back, finds the SAME tab's new page — never
 * another tab. What the model reads comes with the verdict.
 */

import type { BrowserContext, Page } from '@xmorse/playwright-core'
import { debuggerCutHead, describeDebuggerCut, parseDebuggerCutStatus, type DebuggerCutStatus } from './debugger-cut.js'
import type { PageProbes } from './page-probe.js'

/** Where the relay answers, and its token. */
export interface RelayEndpoint {
  httpBaseUrl: string
  token: string | undefined
}

/**
 * - `closed`: the tab is gone or no longer controlled; the caller picks the page to control next.
 *   `notice` (or null) says what the model should know beyond that.
 * - `reattached`: `replacement` is the same tab's new page.
 * - `still-cut`: the tab is open but has no debugger yet; `notice` says why and what to do.
 */
export type ClosedPageVerdict =
  | { kind: 'closed'; page: Page; notice: string | null }
  | { kind: 'reattached'; page: Page; replacement: Page; notice: string }
  | { kind: 'still-cut'; page: Page; notice: string }

/**
 * How long a call waits for a cut tab to come back. A password manager menu that leaves at once
 * (Bitwarden's: ~26 ms) is back, with its page set up again in this session, well within it; a menu
 * that stays is reported after it rather than waited on.
 */
export const CUT_WAIT_MS = 2000

/** Time the relay may take on top of a wait: its re-attach request to the extension is bounded at 5 s. */
const RELAY_ANSWER_SLACK_MS = 7000

export class DebuggerCutAdoption {
  private closed: { page: Page; targetId: Promise<string | null> } | null = null
  /** Closed pages whose tab Chrome only took the debugger off. */
  private readonly cutPages = new WeakSet<Page>()
  private readonly relay: () => RelayEndpoint
  private readonly probes: PageProbes

  constructor(options: { relay: () => RelayEndpoint; probes: PageProbes }) {
    this.relay = options.relay
    this.probes = options.probes
  }

  /** A closed controlled page awaits a verdict. */
  get pending(): boolean {
    return this.closed !== null
  }

  /** The page closed because Chrome took the debugger off its tab, which stayed open (known once settled). */
  wasCut(page: Page): boolean {
    return this.cutPages.has(page)
  }

  /** The controlled page closed: held until `settle` says what became of its tab. */
  pageClosed(page: Page): void {
    this.closed = {
      page,
      // The page's probe read its target id when the page was first seen; a page never probed has none.
      targetId: this.probes.get(page).then(
        (probe) => probe.targetId,
        () => null,
      ),
    }
  }

  /** The connection the closed page belonged to is gone (reset, disconnect): no verdict is awaited any more. */
  forget(): void {
    this.closed = null
  }

  /**
   * What became of the closed page's tab, waiting up to `waitMs` for a cut tab to come back (asking
   * the extension to try at once). Null: no closed page awaits a verdict.
   */
  async settle({ context, waitMs }: { context: BrowserContext; waitMs: number }): Promise<ClosedPageVerdict | null> {
    const closed = this.closed
    if (!closed) return null
    const { page } = closed
    const deadline = Date.now() + waitMs
    const targetId = await closed.targetId
    if (!targetId) return this.verdict({ kind: 'closed', page, notice: null })
    let status: DebuggerCutStatus | null
    try {
      status = await this.ask(targetId, 0, false)
      if (status && (status.state === 'reattaching' || status.state === 'waiting')) {
        status = await this.ask(targetId, Math.max(0, deadline - Date.now()), true)
      }
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      return this.verdict({
        kind: 'closed',
        page,
        notice: `The controlled tab's page closed, and the relay could not say whether Chrome only took the debugger off that tab (${cause}); it is treated as closed.`,
      })
    }
    // The relay knows no cut of it: the tab really closed.
    if (!status) return this.verdict({ kind: 'closed', page, notice: null })
    if (status.state === 'ended') {
      return this.verdict({ kind: 'closed', page, notice: status.endedBecause === 'disconnected' ? describeDebuggerCut(status) : null })
    }
    this.cutPages.add(page)
    // Its refs say why they no longer work, whatever comes next.
    this.probes.registry.debuggerCut(targetId)
    if (status.state !== 'reattached') return { kind: 'still-cut', page, notice: describeDebuggerCut(status) }
    const replacement = await this.pageOfTarget({ context, targetId, closedPage: page, ms: Math.max(0, deadline - Date.now()) })
    if (!replacement) {
      return {
        kind: 'still-cut',
        page,
        notice: `${debuggerCutHead(status.cause)} Re-attached after ${((status.reattachedAfterMs ?? status.cutAgoMs) / 1000).toFixed(1)} s, but the tab's page has not reached this session yet; call again.`,
      }
    }
    return this.verdict({ kind: 'reattached', page, replacement, notice: describeDebuggerCut(status) })
  }

  /** A final verdict: nothing awaits one any more. */
  private verdict(verdict: ClosedPageVerdict): ClosedPageVerdict {
    this.closed = null
    return verdict
  }

  private async ask(targetId: string, waitMs: number, retry: boolean): Promise<DebuggerCutStatus | null> {
    const { httpBaseUrl, token } = this.relay()
    const url = `${httpBaseUrl}/debugger-cuts/${encodeURIComponent(targetId)}?waitMs=${Math.round(waitMs)}${retry ? '&retry=1' : ''}`
    const response = await fetch(url, {
      signal: AbortSignal.timeout(waitMs + RELAY_ANSWER_SLACK_MS),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`the relay at ${httpBaseUrl} answered HTTP ${response.status}`)
    const status = parseDebuggerCutStatus(await response.json())
    if ('invalid' in status) throw new Error(`the relay at ${httpBaseUrl} answered something that is not a debugger cut status (${status.invalid})`)
    return status
  }

  /** The open page of tab `targetId` in `context`, as soon as Playwright has it; null after `ms`. */
  private async pageOfTarget({ context, targetId, closedPage, ms }: { context: BrowserContext; targetId: string; closedPage: Page; ms: number }): Promise<Page | null> {
    const found = Promise.withResolvers<Page | null>()
    const check = async (candidate: Page): Promise<void> => {
      if (candidate === closedPage || candidate.isClosed()) return
      const probe = await this.probes.get(candidate).catch(() => null)
      if (probe?.targetId === targetId && !candidate.isClosed()) found.resolve(candidate)
    }
    const onPage = (candidate: Page): void => {
      void check(candidate)
    }
    context.on('page', onPage)
    const timer = setTimeout(() => found.resolve(null), ms)
    try {
      for (const candidate of context.pages()) void check(candidate)
      return await found.promise
    } finally {
      clearTimeout(timer)
      context.off('page', onPage)
    }
  }
}
