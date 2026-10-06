/**
 * cdp-domains.ts — ONE owner per CDP session for the stateful domains several features
 * share: Debugger (scripts, the skip-all-pauses policy) and CSS (stylesheet headers).
 *
 * The session these run on is usually Playwright's own page session
 * (`getCDPSessionForPage`), shared with everything else in the process. Two rules follow:
 *
 *  - A domain is enabled ONCE and never disabled. `Debugger.disable` drops every
 *    breakpoint and the skip flag of every other Debugger user on the session;
 *    `CSS.disable` drops the stylesheet bookkeeping styles.ts relies on.
 *  - The data an enable replays (`Debugger.scriptParsed` for every parsed script,
 *    `CSS.styleSheetAdded` for every sheet) arrives ONLY on the enable that turns the
 *    domain on — a second enable is a no-op. So the owner listens from before that
 *    enable, for as long as the session lives, and every feature reads the owner's maps
 *    instead of collecting its own. Both replays arrive before the enable's response
 *    (Chromium flushes notifications before a response), so `enable()` resolving means
 *    the maps are complete.
 *
 * Pause policy: enabling the Debugger makes every `debugger;` statement in the page
 * pause it, indefinitely — nobody is there to resume. The owner sets
 * `Debugger.setSkipAllPauses(true)` BEFORE `Debugger.enable` (measured: V8 accepts it on
 * a disabled agent and keeps it through the enable), so there is no window — not even
 * one in which an enable that timed out answers late — where the page can pause. It
 * lifts the flag only while some caller holds a pause lease (`allowPauses`), i.e. while
 * a `createDebugger` user has a pausing breakpoint, pause on exceptions, an XHR
 * breakpoint or `debugger;` statements armed. The last lease released restores it.
 * A pause that still arrives while nobody holds a lease (another client's
 * `Debugger.pause`, or one that raced a lease release) is answered with
 * `Debugger.resume` at once and recorded in `takeResumeNotes()`.
 * Logpoints need no lease: V8 evaluates a breakpoint condition before asking whether to
 * pause, so a non-pausing condition still runs while pauses are skipped.
 */

import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import { withDeadline } from './isolated-world.js'

/** Every command here is one protocol round trip; enabling CSS waits for the page's sheets to load. */
const COMMAND_TIMEOUT_MS = 10_000

export interface PauseLease {
  readonly reason: string
  /** Gives the lease back; the last one out restores skip-all-pauses. Idempotent. */
  release(): Promise<void>
}

export class DebuggerDomain {
  private readonly cdp: ICDPSession
  private readonly parsed = new Map<string, Protocol.Debugger.ScriptParsedEvent>()
  private enabling: Promise<void> | null = null
  private replayed: number | null = null
  private readonly leases = new Set<PauseLease>()
  /** The skip flag the browser last acknowledged; null before the first send. */
  private appliedSkip: boolean | null = null
  /** Serialises skip-flag sends so a later change can never be overtaken by an earlier one. */
  private skipQueue: Promise<void> = Promise.resolve()
  /** Pauses nobody asked for, and what was done about them, until drained. */
  private readonly resumeNotes: string[] = []

  constructor(cdp: ICDPSession) {
    this.cdp = cdp
    cdp.on('Debugger.scriptParsed', this.onScriptParsed)
    // Runtime is enabled on Playwright's page session by Playwright itself, so these
    // arrive without us enabling anything; they keep the map to live documents.
    cdp.on('Runtime.executionContextDestroyed', this.onContextDestroyed)
    cdp.on('Runtime.executionContextsCleared', this.onContextsCleared)
    cdp.on('Debugger.paused', this.onPaused)
  }

  /** Every script parsed in a live execution context, by scriptId. */
  get scripts(): ReadonlyMap<string, Protocol.Debugger.ScriptParsedEvent> {
    return this.parsed
  }

  /**
   * How many scripts the enable replayed, or null before `enable()` resolved. Zero on a
   * page that has scripts means another client enabled the Debugger on this session
   * first, so scripts parsed before that are unknown here.
   */
  get scriptsReplayedOnEnable(): number | null {
    return this.replayed
  }

  /** True while at least one pause lease is held. */
  get pausesAllowed(): boolean {
    return this.leases.size > 0
  }

  /**
   * Notes about pauses that arrived while no caller held a pause lease and were
   * resumed by the owner. Drains them: each note is returned once.
   */
  takeResumeNotes(): string[] {
    return this.resumeNotes.splice(0)
  }

  /** Enables the Debugger once for this session (pauses skipped); concurrent callers share it. */
  enable(): Promise<void> {
    if (!this.enabling) {
      const enabling = this.doEnable()
      this.enabling = enabling
      enabling.catch(() => {
        if (this.enabling === enabling) this.enabling = null
      })
    }
    return this.enabling
  }

  /**
   * Lift skip-all-pauses until the returned lease is released. Enables the Debugger first.
   * `reason` names what needs to pause (e.g. `breakpoint app.js:42`).
   */
  async allowPauses(reason: string): Promise<PauseLease> {
    await this.enable()
    const lease: PauseLease = {
      reason,
      release: async () => {
        if (!this.leases.delete(lease)) return
        await this.applySkip()
      },
    }
    this.leases.add(lease)
    try {
      await this.applySkip()
    } catch (error) {
      this.leases.delete(lease)
      throw error
    }
    return lease
  }

  private async doEnable(): Promise<void> {
    await this.applySkip()
    const before = this.parsed.size
    await withDeadline(this.cdp.send('Debugger.enable', {}), COMMAND_TIMEOUT_MS, 'enabling the Debugger domain')
    this.replayed = this.parsed.size - before
    // A Node target started with --inspect-brk waits for this; on a page it is a no-op
    // (Playwright already sent it).
    await withDeadline(
      this.cdp.send('Runtime.runIfWaitingForDebugger'),
      COMMAND_TIMEOUT_MS,
      'resuming a target that waits for the debugger',
    )
  }

  private applySkip(): Promise<void> {
    const sync = async (): Promise<void> => {
      const skip = this.leases.size === 0
      if (skip === this.appliedSkip) return
      await withDeadline(
        this.cdp.send('Debugger.setSkipAllPauses', { skip }),
        COMMAND_TIMEOUT_MS,
        skip ? 'telling the Debugger not to pause the page' : 'allowing the Debugger to pause the page',
      )
      this.appliedSkip = skip
    }
    // Runs after the previous send settles either way; the previous failure was already
    // delivered to whoever awaited it.
    const next = this.skipQueue.then(sync, sync)
    this.skipQueue = next
    return next
  }

  private readonly onScriptParsed = (event: Protocol.Debugger.ScriptParsedEvent): void => {
    this.parsed.set(event.scriptId, event)
  }

  private readonly onContextDestroyed = (event: Protocol.Runtime.ExecutionContextDestroyedEvent): void => {
    for (const [id, script] of this.parsed) {
      if (script.executionContextId === event.executionContextId) this.parsed.delete(id)
    }
  }

  private readonly onContextsCleared = (): void => {
    this.parsed.clear()
  }

  private readonly onPaused = (event: Protocol.Debugger.PausedEvent): void => {
    if (this.leases.size > 0) return
    const top = event.callFrames[0]
    const where = top ? `${top.url || '(inline script)'}:${top.location.lineNumber + 1}` : 'an unknown location'
    const what = `the page paused at ${where} (reason: ${event.reason}) although no debugger user had asked for pauses`
    withDeadline(this.cdp.send('Debugger.resume'), COMMAND_TIMEOUT_MS, 'resuming a pause nobody asked for').then(
      () => this.resumeNotes.push(`${what}; it was resumed`),
      (error: unknown) =>
        this.resumeNotes.push(
          `${what}; resuming it FAILED (${error instanceof Error ? error.message : String(error)}), so the page may still be frozen`,
        ),
    )
  }
}

export class CssDomain {
  private readonly cdp: ICDPSession
  private readonly headers = new Map<string, Protocol.CSS.CSSStyleSheetHeader>()
  private enabling: Promise<void> | null = null

  constructor(cdp: ICDPSession) {
    this.cdp = cdp
    cdp.on('CSS.styleSheetAdded', this.onAdded)
    // Measured: a reload emits styleSheetRemoved for the old document's sheets before
    // Page.frameNavigated, then styleSheetAdded for the new ones — so this alone keeps
    // the map to live documents.
    cdp.on('CSS.styleSheetRemoved', this.onRemoved)
  }

  /** Every stylesheet header of the live documents, by styleSheetId. */
  get styleSheets(): ReadonlyMap<string, Protocol.CSS.CSSStyleSheetHeader> {
    return this.headers
  }

  /** Enables DOM (CSS requires it) and CSS once for this session; concurrent callers share it. */
  enable(): Promise<void> {
    if (!this.enabling) {
      const enabling = this.doEnable()
      this.enabling = enabling
      enabling.catch(() => {
        if (this.enabling === enabling) this.enabling = null
      })
    }
    return this.enabling
  }

  private async doEnable(): Promise<void> {
    await withDeadline(this.cdp.send('DOM.enable'), COMMAND_TIMEOUT_MS, 'enabling the DOM domain')
    await withDeadline(this.cdp.send('CSS.enable'), COMMAND_TIMEOUT_MS, 'enabling the CSS domain')
  }

  private readonly onAdded = (event: Protocol.CSS.StyleSheetAddedEvent): void => {
    this.headers.set(event.header.styleSheetId, event.header)
  }

  private readonly onRemoved = (event: Protocol.CSS.StyleSheetRemovedEvent): void => {
    this.headers.delete(event.styleSheetId)
  }
}

const debuggerDomains = new WeakMap<ICDPSession, DebuggerDomain>()
const cssDomains = new WeakMap<ICDPSession, CssDomain>()

/**
 * The Debugger owner of `cdp`. Keyed by session object, so callers must share the
 * session object too — `getCDPSessionForPage` returns one per page.
 */
export function debuggerDomainFor(cdp: ICDPSession): DebuggerDomain {
  let domain = debuggerDomains.get(cdp)
  if (!domain) {
    domain = new DebuggerDomain(cdp)
    debuggerDomains.set(cdp, domain)
  }
  return domain
}

/** The CSS owner of `cdp`; see `debuggerDomainFor` for the keying. */
export function cssDomainFor(cdp: ICDPSession): CssDomain {
  let domain = cssDomains.get(cdp)
  if (!domain) {
    domain = new CssDomain(cdp)
    cssDomains.set(cdp, domain)
  }
  return domain
}
