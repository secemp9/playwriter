/**
 * debugger-cut.ts — a tab Chrome took the extension's debugger off while the tab stayed open.
 *
 * MEASURED (Chromium 145 with the Playwriter extension and a minimal password manager side by side,
 * debugger-cut-relay.test.ts; the same with a bare probe extension), when another extension puts a
 * `chrome-extension://` iframe into a tab — Bitwarden's inline autofill menu, opened by focusing an
 * email or password field:
 *   - the tab's debugger session gets `Page.frameAttached`, `Page.frameRequestedNavigation` and
 *     `Page.frameStartedNavigating` for `chrome-extension://<id>/…`, and ~2 ms later
 *     `chrome.debugger.onDetach` with reason `target_closed` — while `chrome.tabs.get` still finds the
 *     tab (a real close fires `tabs.onRemoved` first, and `tabs.get` then fails);
 *   - while the iframe is there, `chrome.debugger.attach` — by tabId or by targetId — and every
 *     `sendCommand` fail with "Cannot access a chrome-extension:// URL of different extension";
 *   - the iframe leaving the page fires no event an extension can see (`webNavigation.getAllFrames`
 *     never lists it either); the next attach then succeeds at once, on the same targetId.
 * A navigation to a page no extension may debug (`chrome://…`) cuts the same way (reason
 * `target_closed`, then "Cannot access a chrome:// URL").
 *
 * The extension keeps such a tab, reports the cut (`debuggerCut` message), and re-attaches as soon as
 * Chrome allows (extension/src/debugger-cut.ts). The relay keeps the latest report per tab
 * (`RelayDebuggerCuts`, served at `GET /debugger-cuts/:targetId`); the executor asks it when its page
 * closes, re-adopts the same tab when it comes back, and tells the model (`describeDebuggerCut`).
 *
 * This module is shared: the extension imports its types only.
 */

/** What made Chrome take the debugger off the tab, as far as the extension saw it. */
export type DebuggerCutCause =
  /** Another extension's frame came into the page (`url` is that frame's address). */
  | { kind: 'extension-frame'; url: string }
  /** The tab went to a page no extension may debug (`chrome://…`, the Web Store). */
  | { kind: 'restricted-page'; url: string }
  /** Nothing the extension saw names a cause; `detachReason` is all Chrome said. */
  | { kind: 'unnamed'; detachReason: string }

/**
 * - `reattaching`: the extension is trying again on its own timer, within its retry window;
 * - `waiting`: that window is over — it tries again on tab events and when a client asks;
 * - `reattached`: the debugger is back on the same tab, under a new session;
 * - `ended`: the tab was closed, or the user disconnected Playwriter from it, before it came back.
 */
export type DebuggerCutState = 'reattaching' | 'waiting' | 'reattached' | 'ended'

/** The extension's report of a cut tab (extension → relay `debuggerCut` message). */
export interface DebuggerCutReport {
  tabId: number
  /** The tab's CDP target id: the same before the cut and after the re-attach. */
  targetId: string
  state: DebuggerCutState
  cause: DebuggerCutCause
  /** Re-attach attempts so far. */
  attempts: number
  /** What Chrome answered the latest failed attempt; null before the first. */
  lastError: string | null
  /** `reattached`: how long the tab was without a debugger, on the extension's clock. */
  reattachedAfterMs: number | null
  /** `reattached`: the tab's new session. When it detaches with no cut reported first, the tab really went away. */
  sessionId: string | null
  /** `ended`: why. */
  endedBecause: 'tab-closed' | 'disconnected' | null
  /** How long the extension retries on its own timer after a cut. */
  retryWindowMs: number
}

/** What the relay answers `GET /debugger-cuts/:targetId` with: the latest report, aged on the relay's clock. */
export interface DebuggerCutStatus extends DebuggerCutReport {
  /** Since the relay heard of the cut. */
  cutAgoMs: number
  /** Since the relay heard of the latest failed attempt; null before the first. */
  lastAttemptAgoMs: number | null
}

/**
 * Relay → extension request: try to re-attach the cut tab now. Answered with the tab's
 * DebuggerCutReport after the attempt, or null when the extension has no cut for that target.
 */
export const REATTACH_CUT_TAB = 'reattachCutTab'

/** Reports in a final state are dropped this long after they arrived. */
const FINAL_REPORT_TTL_MS = 10 * 60_000

interface CutRecord {
  report: DebuggerCutReport
  extensionId: string
  cutAt: number
  lastAttemptAt: number | null
  updatedAt: number
}

const isOpen = (state: DebuggerCutState): boolean => state === 'reattaching' || state === 'waiting'

/** The relay's record of every cut tab, by target id, for `GET /debugger-cuts/:targetId`. */
export class RelayDebuggerCuts {
  private readonly records = new Map<string, CutRecord>()
  private readonly waiters = new Map<string, Set<() => void>>()

  /** A report from extension connection `extensionId`. A new cut (attempts 0, still open) restarts the record. */
  report(extensionId: string, report: DebuggerCutReport, now = Date.now()): void {
    this.prune(now)
    const previous = this.records.get(report.targetId)
    const fresh = !previous || !isOpen(previous.report.state) || (report.attempts === 0 && isOpen(report.state))
    const attempted = report.attempts > 0 && report.attempts !== previous?.report.attempts
    this.records.set(report.targetId, {
      report,
      extensionId,
      cutAt: fresh || !previous ? now : previous.cutAt,
      lastAttemptAt: report.attempts === 0 ? null : attempted ? now : (previous?.lastAttemptAt ?? now),
      updatedAt: now,
    })
    const waiting = this.waiters.get(report.targetId)
    if (!waiting) return
    this.waiters.delete(report.targetId)
    for (const wake of waiting) wake()
  }

  status(targetId: string, now = Date.now()): DebuggerCutStatus | null {
    const record = this.records.get(targetId)
    if (!record) return null
    return { ...record.report, cutAgoMs: now - record.cutAt, lastAttemptAgoMs: record.lastAttemptAt === null ? null : now - record.lastAttemptAt }
  }

  /** The extension connection that reported the tab's cut, while it is open. */
  extensionOf(targetId: string): string | null {
    const record = this.records.get(targetId)
    return record && isOpen(record.report.state) ? record.extensionId : null
  }

  /** The tab's status once it is no longer open (re-attached or ended), or as it is after `ms`. */
  async settled(targetId: string, ms: number): Promise<DebuggerCutStatus | null> {
    const deadline = Date.now() + ms
    for (;;) {
      const status = this.status(targetId)
      const left = deadline - Date.now()
      if (!status || !isOpen(status.state) || left <= 0) return status
      const changed = Promise.withResolvers<void>()
      const wake = (): void => changed.resolve()
      let waiting = this.waiters.get(targetId)
      if (!waiting) {
        waiting = new Set()
        this.waiters.set(targetId, waiting)
      }
      waiting.add(wake)
      // The cap (a): a change of this tab's cut (its waiters) wakes the wait first.
      const timer = setTimeout(wake, left)
      await changed.promise
      clearTimeout(timer)
      this.waiters.get(targetId)?.delete(wake)
    }
  }

  /** The extension connection left: its open cuts can no longer come back through it. */
  forgetExtension(extensionId: string): void {
    for (const [targetId, record] of this.records) {
      if (record.extensionId !== extensionId || !isOpen(record.report.state)) continue
      this.records.delete(targetId)
      const waiting = this.waiters.get(targetId)
      this.waiters.delete(targetId)
      for (const wake of waiting ?? []) wake()
    }
  }

  /**
   * A tab session detached. A cut reports itself before its session detaches, so the detach of the
   * session a re-attach announced is no cut: the tab closed or was let go, and its record goes — a
   * client asking about that tab then hears it closed, not that it came back.
   */
  sessionDetached(sessionId: string): void {
    for (const [targetId, record] of this.records) {
      if (record.report.state === 'reattached' && record.report.sessionId === sessionId) this.records.delete(targetId)
    }
  }

  private prune(now: number): void {
    for (const [targetId, record] of this.records) {
      if (!isOpen(record.report.state) && now - record.updatedAt > FINAL_REPORT_TTL_MS) this.records.delete(targetId)
    }
  }
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1)

/** The first sentence of every DEBUGGER CUT line: what Chrome did, and why as far as the extension saw. */
export function debuggerCutHead(cause: DebuggerCutCause): string {
  let why: string
  switch (cause.kind) {
    case 'extension-frame': {
      const id = cause.url.slice('chrome-extension://'.length).split('/')[0]
      why = `because another extension's frame (chrome-extension://${id}, e.g. a password manager's autofill menu) is in the page`
      break
    }
    case 'restricted-page':
      why = `because it went to ${cause.url}, a page Chrome lets no extension debug`
      break
    case 'unnamed':
      why = `(Chrome named no cause, only "${cause.detachReason}")`
      break
  }
  return `DEBUGGER CUT — Chrome took the debugger off this tab ${why}; the tab is still open.`
}

/** What the model reads about a cut tab. */
export function describeDebuggerCut(status: DebuggerCutStatus): string {
  const head = debuggerCutHead(status.cause)
  if (status.state === 'reattached') {
    return `${head} Re-attached after ${seconds(status.reattachedAfterMs ?? status.cutAgoMs)} s; refs from before are gone — observe() again.`
  }
  if (status.state === 'ended') {
    return status.endedBecause === 'disconnected'
      ? `${head} The user then disconnected Playwriter from that tab, so it is no longer controlled.`
      : `${head} The tab was then closed.`
  }
  const tries =
    status.lastError === null
      ? 'no attempt yet'
      : `${status.attempts} ${status.attempts === 1 ? 'try' : 'tries'} in ${seconds(status.cutAgoMs)} s; the last, ${seconds(status.lastAttemptAgoMs ?? 0)} s ago, got "${status.lastError}"`
  const retry =
    status.state === 'reattaching'
      ? 'Playwriter re-attaches by itself the moment Chrome allows it; your next call reports it.'
      : `Playwriter stopped retrying on its own after ${Math.round(status.retryWindowMs / 1000)} s; each of your calls tries again.`
  const direct = 'A Playwriter session over Chrome\'s own remote debugging (PLAYWRITER_DIRECT, chrome://inspect) is not subject to this.'
  switch (status.cause.kind) {
    case 'extension-frame':
      return (
        `${head} Not re-attached yet (${tries}): Chrome lets no other extension debug a tab while that frame is in it. ` +
        'Such a frame is usually an autofill menu that opens when an email or password field gets focus: ask the user to close it ' +
        "(Escape, or a click elsewhere in that tab), or to turn off that extension's inline autofill menu for this site. " +
        `${retry} ${direct}`
      )
    case 'restricted-page':
      return `${head} Not re-attached yet (${tries}): ask the user to take the tab back to a normal web page. ${retry}`
    case 'unnamed':
      return `${head} Not re-attached yet (${tries}). ${retry} If it stays like this, ask the user what happened in that tab. ${direct}`
  }
}

/** Reads the relay's answer; anything else is named, never guessed into a status. */
export function parseDebuggerCutStatus(value: unknown): DebuggerCutStatus | { invalid: string } {
  if (typeof value !== 'object' || value === null) return { invalid: 'not an object' }
  const field = (name: string): unknown => (name in value ? Reflect.get(value, name) : undefined)
  const targetId = field('targetId')
  const tabId = field('tabId')
  const state = field('state')
  const attempts = field('attempts')
  const lastError = field('lastError')
  const reattachedAfterMs = field('reattachedAfterMs')
  const sessionId = field('sessionId')
  const endedBecause = field('endedBecause')
  const retryWindowMs = field('retryWindowMs')
  const cutAgoMs = field('cutAgoMs')
  const lastAttemptAgoMs = field('lastAttemptAgoMs')
  const rawCause = field('cause')
  if (typeof targetId !== 'string' || typeof tabId !== 'number') return { invalid: 'no targetId/tabId' }
  if (state !== 'reattaching' && state !== 'waiting' && state !== 'reattached' && state !== 'ended') return { invalid: `unknown state ${String(state)}` }
  if (typeof attempts !== 'number' || typeof retryWindowMs !== 'number' || typeof cutAgoMs !== 'number') return { invalid: 'no attempts/retryWindowMs/cutAgoMs' }
  if (lastError !== null && typeof lastError !== 'string') return { invalid: 'lastError is not a string' }
  if (reattachedAfterMs !== null && typeof reattachedAfterMs !== 'number') return { invalid: 'reattachedAfterMs is not a number' }
  if (sessionId !== null && typeof sessionId !== 'string') return { invalid: 'sessionId is not a string' }
  if (lastAttemptAgoMs !== null && typeof lastAttemptAgoMs !== 'number') return { invalid: 'lastAttemptAgoMs is not a number' }
  if (endedBecause !== null && endedBecause !== 'tab-closed' && endedBecause !== 'disconnected') return { invalid: `unknown endedBecause ${String(endedBecause)}` }
  if (typeof rawCause !== 'object' || rawCause === null || !('kind' in rawCause)) return { invalid: 'no cause' }
  let cause: DebuggerCutCause
  if ((rawCause.kind === 'extension-frame' || rawCause.kind === 'restricted-page') && 'url' in rawCause && typeof rawCause.url === 'string') {
    cause = { kind: rawCause.kind, url: rawCause.url }
  } else if (rawCause.kind === 'unnamed' && 'detachReason' in rawCause && typeof rawCause.detachReason === 'string') {
    cause = { kind: 'unnamed', detachReason: rawCause.detachReason }
  } else {
    return { invalid: `unknown cause ${String(rawCause.kind)}` }
  }
  return { targetId, tabId, state, cause, attempts, lastError, reattachedAfterMs, sessionId, endedBecause, retryWindowMs, cutAgoMs, lastAttemptAgoMs }
}
