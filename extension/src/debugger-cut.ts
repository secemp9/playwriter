/**
 * Keeps a tab Chrome took our debugger off while it stayed open, and re-attaches it as soon as Chrome
 * allows. What Chrome does, measured: playwriter/src/debugger-cut.ts.
 *
 * Nothing tells an extension that the frame which blocks the debugger has left the page, so the
 * re-attach is tried: at once and on a short backoff after the cut (each refused attempt costs a
 * browser-side check and reaches no page), on events of that tab (it navigated, finished loading, was
 * made the active tab), and whenever the relay asks (a client's next call). The extension's own timer
 * stops after RETRY_WINDOW_MS; events and requests still try after that. A tab is never touched to
 * make the attach succeed: the other extension's frame is the user's, not ours to remove. An attach
 * Chrome lets through while that frame is still loading is refused again the moment it has loaded, so
 * it does not count as a re-attach (LoadingFrame).
 */

import type { DebuggerCutCause, DebuggerCutReport } from 'playwriter/src/debugger-cut'

/** Delays of the extension's own attempts after a cut; the last one repeats until the window ends. */
const RETRY_DELAYS_MS = [0, 25, 50, 100, 200, 400, 800, 1000]
/** How long after a cut the extension keeps trying on its own timer. */
export const RETRY_WINDOW_MS = 5 * 60_000
/** A forbidden address seen loading in the tab this soon before a detach is taken as its cause. */
const CAUSE_WINDOW_MS = 2_000
/**
 * A frame that still holds no document of its own this long after it began loading another
 * extension's page is no longer loading it (the load was cancelled): a re-attach then counts (see
 * Cut.loading).
 */
const LOADING_FRAME_MS = 10_000
/** Pages no extension may debug: a tab that goes to one is cut like by a foreign extension frame. */
const RESTRICTED_PREFIXES = ['chrome://', 'chrome-untrusted://', 'devtools://', 'edge://', 'https://chromewebstore.google.com/', 'https://chrome.google.com/webstore']

/** One re-attach attempt: the tab's new session, or why not (`ended` when the tab is gone or no longer ours). */
export type ReattachOutcome = { ok: true; sessionId: string } | { ok: false; error: string; ended?: 'tab-closed' | 'disconnected' }

interface Sighting {
  cause: Extract<DebuggerCutCause, { url: string }>
  /** The frame that began loading it, when the event named one. */
  frameId: string | null
  at: number
}

/**
 * The frame whose load of another extension's page cut the tab, and when that load began. MEASURED
 * (Chromium 145, a probe extension re-attaching right after a password manager's menu iframe cut it):
 * Chrome lets `chrome.debugger.attach` through, and answers Page.enable, Target.getTargetInfo and
 * Page.getFrameTree, until that load commits (~15 ms later on an idle machine, `Page.frameDetached`
 * reason `swap`); from then on it refuses every command of that session with "Cannot access a
 * chrome-extension:// URL of different extension". Until the commit, Page.getFrameTree lists the frame
 * with no document of its own (url ":"). The extension's own first attempt lands in that window on
 * every debugger-cut-relay run (attach and Page.enable answered, Target.getTargetInfo refused); in a
 * full test run it got Target.getTargetInfo answered as well, so the tab was announced re-attached
 * ("Re-attached after 0.1 s") while every read of it was then refused.
 */
export interface LoadingFrame {
  frameId: string
  url: string
  since: number
}

interface Cut {
  tabId: number
  targetId: string
  cause: DebuggerCutCause
  cutAt: number
  attempts: number
  lastError: string | null
  /** Index of the next delay in RETRY_DELAYS_MS. */
  backoff: number
  /** Cancels the pending timer attempt; null when none is pending. */
  stopTimer: (() => void) | null
  inFlight: Promise<DebuggerCutReport> | null
  state: 'reattaching' | 'waiting'
  /** Set when the cut came from another extension's frame that began loading in the tab: see LoadingFrame. */
  loading: LoadingFrame | null
}

function loadingOf(sighting: Sighting): LoadingFrame | null {
  return sighting.cause.kind === 'extension-frame' && sighting.frameId ? { frameId: sighting.frameId, url: sighting.cause.url, since: sighting.at } : null
}

export class DebuggerCuts {
  private readonly sightings = new Map<number, Sighting>()
  private readonly cuts = new Map<number, Cut>()
  private readonly ownExtensionId: string
  private readonly send: (report: DebuggerCutReport) => void
  private readonly reattach: (tabId: number, loading: LoadingFrame | null) => Promise<ReattachOutcome>
  private readonly log: (...args: unknown[]) => void

  constructor(options: {
    ownExtensionId: string
    send: (report: DebuggerCutReport) => void
    /**
     * Attach the debugger to the tab again without touching the page, and announce it to the relay —
     * unless `loading` (the frame that cut the tab) is still loading another extension's page.
     */
    reattach: (tabId: number, loading: LoadingFrame | null) => Promise<ReattachOutcome>
    log: (...args: unknown[]) => void
  }) {
    this.ownExtensionId = options.ownExtensionId
    this.send = options.send
    this.reattach = options.reattach
    this.log = options.log
  }

  /** The tab events that may mean Chrome allows the debugger again, and the commits that name a cause. */
  listen(): void {
    chrome.webNavigation.onCommitted.addListener((details) => {
      this.noteNavigation(details.tabId, details.url)
      if (details.frameId === 0) this.nudge(details.tabId)
    })
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status !== undefined || changeInfo.url !== undefined) this.nudge(tabId)
    })
    chrome.tabs.onActivated.addListener((activeInfo) => this.nudge(activeInfo.tabId))
  }

  /**
   * A frame of the tab started loading `url` (CDP `Page.frameRequestedNavigation` /
   * `Page.frameStartedNavigating` / `Page.frameNavigated`, or `webNavigation.onCommitted`). Remembers
   * the addresses no other extension's debugger may be in, and the frame loading one; one committing
   * after a cut names its cause.
   */
  noteNavigation(tabId: number, url: string | undefined, frameId?: string): void {
    if (!url) return
    const cause = this.forbiddenCause(url)
    if (!cause) return
    const sighting: Sighting = { cause, frameId: frameId ?? null, at: Date.now() }
    this.sightings.set(tabId, sighting)
    const cut = this.cuts.get(tabId)
    if (cut?.cause.kind === 'unnamed') {
      cut.cause = cause
      cut.loading = loadingOf(sighting)
      this.send(this.reportOf(cut, cut.state))
    }
  }

  isCut(tabId: number): boolean {
    return this.cuts.has(tabId)
  }

  tabOf(targetId: string): number | null {
    for (const cut of this.cuts.values()) if (cut.targetId === targetId) return cut.tabId
    return null
  }

  /**
   * Chrome detached with `detachReason` from a tab that is still open. Reports the cut — before the
   * caller tells the relay the tab's session is gone, so the relay knows why by then. `start` begins
   * the attempts.
   */
  begin({ tabId, targetId, detachReason }: { tabId: number; targetId: string; detachReason: string }): void {
    const sighting = this.sightings.get(tabId)
    this.sightings.delete(tabId)
    const now = Date.now()
    const named = sighting && now - sighting.at <= CAUSE_WINDOW_MS ? sighting : null
    const cause: DebuggerCutCause = named ? named.cause : { kind: 'unnamed', detachReason }
    this.cuts.get(tabId)?.stopTimer?.()
    const cut: Cut = {
      tabId,
      targetId,
      cause,
      cutAt: now,
      attempts: 0,
      lastError: null,
      backoff: 0,
      stopTimer: null,
      inFlight: null,
      state: 'reattaching',
      loading: named ? loadingOf(named) : null,
    }
    this.cuts.set(tabId, cut)
    this.log('debugger cut: tab', tabId, 'target', targetId, 'cause', JSON.stringify(cause))
    this.send(this.reportOf(cut, 'reattaching'))
  }

  start(tabId: number): void {
    const cut = this.cuts.get(tabId)
    if (cut) this.schedule(cut)
  }

  /** Try now, unless an attempt is already running (then its result). Null: the tab is not cut. */
  attempt(tabId: number): Promise<DebuggerCutReport> | null {
    const cut = this.cuts.get(tabId)
    if (!cut) return null
    if (cut.inFlight) return cut.inFlight
    cut.stopTimer?.()
    cut.stopTimer = null
    const running = this.run(cut)
    cut.inFlight = running
    void running.finally(() => {
      if (cut.inFlight === running) cut.inFlight = null
    })
    return running
  }

  /** The tab went away, or the user disconnected it, before it came back. */
  end(tabId: number, because: 'tab-closed' | 'disconnected'): void {
    this.sightings.delete(tabId)
    const cut = this.cuts.get(tabId)
    if (!cut) return
    cut.stopTimer?.()
    this.cuts.delete(tabId)
    this.send({ ...this.reportOf(cut, 'ended'), endedBecause: because })
  }

  /** The relay connection closed: every record it held is gone with it, and reconnecting re-attaches the tabs. */
  clear(): void {
    for (const cut of this.cuts.values()) cut.stopTimer?.()
    this.cuts.clear()
    this.sightings.clear()
  }

  private nudge(tabId: number): void {
    const cut = this.cuts.get(tabId)
    if (!cut || cut.inFlight) return
    void this.attempt(tabId)
  }

  private schedule(cut: Cut): void {
    if (cut.state !== 'reattaching' || this.cuts.get(cut.tabId) !== cut) return
    if (Date.now() - cut.cutAt >= RETRY_WINDOW_MS) {
      cut.state = 'waiting'
      this.log('debugger cut: tab', cut.tabId, 'still refused after', RETRY_WINDOW_MS, 'ms; retrying on tab events and requests only')
      this.send(this.reportOf(cut, 'waiting'))
      return
    }
    const delay = RETRY_DELAYS_MS[Math.min(cut.backoff, RETRY_DELAYS_MS.length - 1)]
    cut.backoff++
    const timer = setTimeout(() => {
      cut.stopTimer = null
      void this.attempt(cut.tabId)
    }, delay)
    cut.stopTimer = () => clearTimeout(timer)
  }

  private async run(cut: Cut): Promise<DebuggerCutReport> {
    cut.attempts++
    const loading = cut.loading && Date.now() - cut.loading.since < LOADING_FRAME_MS ? cut.loading : null
    const outcome = await this.reattach(cut.tabId, loading).catch((error: unknown): ReattachOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    if (outcome.ok) {
      if (this.cuts.get(cut.tabId) === cut) this.cuts.delete(cut.tabId)
      const report: DebuggerCutReport = { ...this.reportOf(cut, 'reattached'), reattachedAfterMs: Date.now() - cut.cutAt, sessionId: outcome.sessionId }
      this.log('debugger cut: tab', cut.tabId, 're-attached after', report.reattachedAfterMs, 'ms and', cut.attempts, 'attempts')
      this.send(report)
      return report
    }
    cut.lastError = outcome.error
    if (outcome.ended) {
      if (this.cuts.get(cut.tabId) === cut) this.end(cut.tabId, outcome.ended)
      return { ...this.reportOf(cut, 'ended'), endedBecause: outcome.ended }
    }
    const report = this.reportOf(cut, cut.state)
    if (this.cuts.get(cut.tabId) === cut) {
      this.send(report)
      this.schedule(cut)
    }
    return report
  }

  private forbiddenCause(url: string): Sighting['cause'] | null {
    if (url.startsWith('chrome-extension://')) {
      return url.startsWith(`chrome-extension://${this.ownExtensionId}/`) ? null : { kind: 'extension-frame', url }
    }
    return RESTRICTED_PREFIXES.some((prefix) => url.startsWith(prefix)) ? { kind: 'restricted-page', url } : null
  }

  private reportOf(cut: Cut, state: DebuggerCutReport['state']): DebuggerCutReport {
    return {
      tabId: cut.tabId,
      targetId: cut.targetId,
      state,
      cause: cut.cause,
      attempts: cut.attempts,
      lastError: cut.lastError,
      reattachedAfterMs: null,
      sessionId: null,
      endedBecause: null,
      retryWindowMs: RETRY_WINDOW_MS,
    }
  }
}
