/**
 * A ledger of the tab-group changes the Playwriter extension performs on Chrome ITSELF.
 *
 * WHY THIS EXISTS
 * ---------------
 * The extension keeps each workspace's connected tabs inside a Chrome tab group
 * (`syncTabGroups` in extension/src/background.ts). It also listens to
 * `chrome.tabs.onUpdated` for `changeInfo.groupId`, because a HUMAN dragging a tab out of a
 * playwriter group means "disconnect this tab" and dragging one in means "connect it".
 *
 * Those two facts collide: Chrome fires the exact same `chrome.tabs.onUpdated` event for a
 * group change the extension made with `chrome.tabs.group()` / `chrome.tabs.ungroup()` as it
 * does for one a human made by dragging. Nothing on the event distinguishes them — not the
 * group id, not the tab's live `groupId`, not the tab's connection state. So the extension
 * was reading its own writes back as user intent and acting on them.
 *
 * MEASURED, not assumed. Two failures were captured in a relay log (see the group-event
 * instrumentation in the run that produced tmp/relay-server-19990.log), both from one
 * `disconnectEverything()` immediately followed by re-enabling the extension on one tab:
 *
 *   1. Our own `chrome.tabs.group()` read back as a human drag-IN. The extension had just
 *      added a freshly attached tab to its workspace group; `disconnectEverything()` then
 *      untracked every tab; and only afterwards did the queued group event get handled:
 *          GRPEVT dispatch#13 tab=924700787 groupId=1839453140 stateAtDispatch=connected
 *          Disconnecting tab 924700785 / 924700786 / 924700787   (disconnectEverything)
 *          GRPEVT process#13 tab=924700787 groupId=1839453140 stateAtProcess=ABSENT
 *          Tab manually added to playwriter group: 924700787
 *          Starting connection to tab 924700787        <- re-attached, workspaceKey: null
 *      A deliberately disconnected tab was resurrected as a FREESTYLE tab, i.e. owned by no
 *      workspace, so the agent that owned it could never see it again.
 *
 *   2. Our own `chrome.tabs.ungroup()` read back as a human drag-OUT. `syncTabGroups`
 *      ungrouped a tab that was, at that instant, genuinely connected:
 *          GRPEVT self-ungroup phase1 key=wt:… groupId=1839453140 tabs=[…,924700787]
 *          GRPEVT dispatch#16 tab=924700787 groupId=-1 stateAtDispatch=connected
 *      and the sibling ordering, where the tab was untracked when we ungrouped it and had
 *      re-attached by the time the handler read the store:
 *          GRPEVT dispatch#8 tab=924700781 groupId=-1 stateAtDispatch=ABSENT
 *          Starting connection to tab 924700781
 *          GRPEVT process#8 tab=924700781 groupId=-1 stateAtProcess=connecting
 *      The handler's `state === 'connecting'` guard caught that last one by a few
 *      milliseconds. One attach faster and it reads 'connected' and tears the tab down.
 *
 * WHY THE OBVIOUS FIXES DO NOT WORK
 * ---------------------------------
 * Reading the tab's LIVE `groupId` at handling time instead of trusting the event's snapshot
 * was tried and measured NOT to help, and the logs above say why: in every failing case the
 * live value EQUALS the event's value. In (1) the tab really is in one of our groups; in (2)
 * it really is ungrouped. The event's snapshot was never stale in its VALUE — what is missing
 * is who caused the change.
 *
 * A sequence/generation number stamped on queued events, discarded when the tab has
 * re-attached since, does not cover (2) either: `dispatch#16` was produced AFTER the tab's
 * current attach completed, so no generation has changed.
 *
 * Only the identity of the actor separates these cases, and the extension is the one actor it
 * can know about with certainty. So every group mutation it performs is recorded here first,
 * and the `onUpdated` listener consumes the record instead of acting on the event.
 *
 * ORDERING
 * --------
 * Chrome delivers one `tabs.onUpdated` groupId event per tab per membership change, in the
 * order the changes happened, and dispatches them BEFORE the `chrome.tabs.group()` /
 * `ungroup()` promise resolves. Both were observed directly: a single `ungroup([a, b, c])`
 * produced dispatches for a, b, c in that order and all three landed between the call and its
 * completion log; and one tab's four successive mutations arrived in mutation order. A plain
 * FIFO per tab therefore lines up with delivery, and consuming at dispatch (rather than when
 * the queued handler runs) keeps the ledger and the event stream in the same order.
 */

/**
 * Chrome's "this tab is in no group" sentinel — the value of `chrome.tabGroups.TAB_GROUP_ID_NONE`
 * and of `changeInfo.groupId` after an ungroup. Spelled out here so this module stays free of
 * the chrome typings and can be unit-tested in plain Node.
 */
export const UNGROUPED_TAB_GROUP_ID = -1

/**
 * What we expect Chrome to report for a change we are about to make: the exact group id when
 * we know it (`chrome.tabs.group({ tabIds, groupId })` and every ungroup, which reports
 * {@link UNGROUPED_TAB_GROUP_ID}), or `'new-group'` when we are creating a group and Chrome
 * only tells us its id in the promise result — which resolves AFTER the event has already been
 * dispatched, so the id cannot be known in time.
 */
export type ExpectedGroupChange = number | 'new-group'

type PendingChange = { expected: ExpectedGroupChange; at: number }

/**
 * How long a recorded change stays eligible to absorb an event.
 *
 * This is not a timing guess about how the fix works — matching is by FIFO position, not by
 * clock. It exists only so that a change which Chrome never reports (a mutation that failed
 * part-way, a tab destroyed mid-move) cannot sit at the head of a tab's queue forever and
 * silently swallow a genuine human drag later on. Measured delivery latency is sub-millisecond
 * (the events land inside the ungroup call that caused them), so five seconds is roughly four
 * orders of magnitude of headroom while still bounding the damage of a lost event to one
 * five-second window.
 */
export const SELF_GROUP_CHANGE_TTL_MS = 5000

export type SelfGroupChangeLedgerOptions = {
  /** Injectable clock, so the TTL is testable without waiting. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Called when a recorded change is dropped because Chrome never reported it within the TTL.
   * That means an assumption in this module did not hold, so it is worth a log line — but it
   * is not an error we can act on.
   */
  onUndelivered?: (info: { tabId: number; expected: ExpectedGroupChange; ageMs: number }) => void
  /**
   * Called when the event we absorb does not carry the group id we recorded. The event is
   * still absorbed (see `consume`), but the disagreement means Chrome's delivery order or our
   * bookkeeping is not what this module assumes, and that must be visible.
   */
  onUnexpected?: (info: { tabId: number; expected: ExpectedGroupChange; actual: number }) => void
}

export class SelfGroupChangeLedger {
  private readonly pending = new Map<number, PendingChange[]>()
  private readonly now: () => number
  private readonly onUndelivered: SelfGroupChangeLedgerOptions['onUndelivered']
  private readonly onUnexpected: SelfGroupChangeLedgerOptions['onUnexpected']

  constructor(options: SelfGroupChangeLedgerOptions = {}) {
    this.now = options.now ?? Date.now
    this.onUndelivered = options.onUndelivered
    this.onUnexpected = options.onUnexpected
  }

  /**
   * Record that we are about to move `tabIds` into `expected`. MUST be called BEFORE the
   * `chrome.tabs.group()` / `ungroup()` call, because Chrome dispatches the resulting events
   * while that call is still pending.
   *
   * Deliberately NOT undone when the mutation rejects. A failed `ungroup([a, b, c])` may still
   * have moved a prefix of the tabs, and Chrome does not say which — so removing the records
   * would risk reading a real self-inflicted event as a human drag-out, which is exactly the
   * failure this ledger exists to stop. Leaving them risks the far milder opposite (one
   * ignored human drag inside the TTL), and the TTL cleans them up.
   */
  note(tabIds: readonly number[], expected: ExpectedGroupChange): void {
    const at = this.now()
    for (const tabId of tabIds) {
      const queue = this.pending.get(tabId)
      if (queue) {
        queue.push({ expected, at })
        continue
      }
      this.pending.set(tabId, [{ expected, at }])
    }
  }

  /**
   * Absorb one group-change event for `tabId` if we caused it. Returns true when the caller
   * must ignore the event entirely.
   *
   * On a group-id disagreement the event is still absorbed and `onUnexpected` fires. Absorbing
   * is the safe direction: the two ways to be wrong are "ignore a human drag" (the tab keeps
   * working; the user can drag again) and "tear down a live agent tab" (the page vanishes with
   * no error and the client is silently handed a fresh about:blank). Only the second is the
   * defect this module exists to prevent.
   */
  consume(tabId: number, groupId: number): boolean {
    const queue = this.pending.get(tabId)
    if (!queue) {
      return false
    }

    const now = this.now()
    while (queue.length > 0 && now - queue[0].at > SELF_GROUP_CHANGE_TTL_MS) {
      const dropped = queue.shift()!
      this.onUndelivered?.({ tabId, expected: dropped.expected, ageMs: now - dropped.at })
    }

    const head = queue.shift()
    if (queue.length === 0) {
      this.pending.delete(tabId)
    }
    if (!head) {
      return false
    }

    const matches =
      head.expected === 'new-group' ? groupId !== UNGROUPED_TAB_GROUP_ID : head.expected === groupId
    if (!matches) {
      this.onUnexpected?.({ tabId, expected: head.expected, actual: groupId })
    }
    return true
  }

  /**
   * Drop everything recorded for a tab. Called when the tab is closed: a closed tab can emit no
   * further events, so its records would leak (and a recycled tab id would inherit them).
   */
  forget(tabId: number): void {
    this.pending.delete(tabId)
  }

  /** Number of changes still awaiting an event for this tab. Diagnostics and tests only. */
  pendingCount(tabId: number): number {
    return this.pending.get(tabId)?.length ?? 0
  }
}
