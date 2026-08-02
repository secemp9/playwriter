import { describe, it, expect } from 'vitest'
import {
  SelfGroupChangeLedger,
  SELF_GROUP_CHANGE_TTL_MS,
  UNGROUPED_TAB_GROUP_ID,
} from './tab-group-events.js'

// ─────────────────────────────────────────────────────────────────────────────────────────
// The extension mutates Chrome tab groups (chrome.tabs.group / ungroup) and also LISTENS to
// chrome.tabs.onUpdated for group changes, because a human dragging a tab in or out of a
// playwriter group is how a user connects or disconnects it by hand. Chrome reports both with
// the same event, so without this ledger the extension acts on its own writes.
//
// WHY A UNIT TEST AND NOT ONLY A BROWSER TEST. Whether the bad interpretation actually fires
// end to end depends on where Chrome's event lands relative to an in-flight attach — a race.
// extension-connection.test.ts drives the real ordering that produced it (see
// 'should survive disconnectEverything followed by an immediate re-enable'), but a test that
// has to win a race cannot be the only guard. These cases state the rule directly, from the
// two orderings measured in the relay log, and fail every run if the rule is weakened.
// ─────────────────────────────────────────────────────────────────────────────────────────

const WORKSPACE_GROUP = 1839453140
const OTHER_GROUP = 483887186

function fixedClock(start = 1_000_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('SelfGroupChangeLedger', () => {
  it('absorbs exactly one event per recorded change and nothing more', () => {
    const ledger = new SelfGroupChangeLedger()
    ledger.note([7], UNGROUPED_TAB_GROUP_ID)

    expect(ledger.consume(7, UNGROUPED_TAB_GROUP_ID)).toBe(true)
    // The next ungroup of the same tab is somebody else's doing and must be acted on.
    expect(ledger.consume(7, UNGROUPED_TAB_GROUP_ID)).toBe(false)
  })

  it('absorbs a group() whose id Chrome only reveals after the event was dispatched', () => {
    // chrome.tabs.group({ tabIds }) creates the group and returns its id in the promise
    // result — which resolves AFTER Chrome has already fired tabs.onUpdated. So the id cannot
    // be recorded in time and 'new-group' stands in for "whatever id it turns out to be".
    const ledger = new SelfGroupChangeLedger()
    ledger.note([7], 'new-group')

    expect(ledger.consume(7, 1967835491)).toBe(true)
  })

  it('does not treat an ungroup as the group creation it was waiting for', () => {
    const unexpected: Array<{ expected: number | 'new-group'; actual: number }> = []
    const ledger = new SelfGroupChangeLedger({
      onUnexpected: ({ expected, actual }) => {
        unexpected.push({ expected, actual })
      },
    })
    ledger.note([7], 'new-group')

    // The event is still absorbed — see `consume`'s doc for why absorbing is the safe
    // direction — but the disagreement must be reported, because it means Chrome's delivery
    // order is not what this module assumes.
    expect(ledger.consume(7, UNGROUPED_TAB_GROUP_ID)).toBe(true)
    expect(unexpected).toEqual([{ expected: 'new-group', actual: UNGROUPED_TAB_GROUP_ID }])
  })

  it('never absorbs an event for a tab it recorded nothing for', () => {
    const ledger = new SelfGroupChangeLedger()
    ledger.note([7], UNGROUPED_TAB_GROUP_ID)

    // A human dragging tab 8 out while we were ungrouping tab 7 must still disconnect tab 8.
    expect(ledger.consume(8, UNGROUPED_TAB_GROUP_ID)).toBe(false)
    expect(ledger.consume(7, UNGROUPED_TAB_GROUP_ID)).toBe(true)
  })

  it('replays one tab several successive changes in the order they were made', () => {
    // The exact sequence syncTabGroups performed on tab 924700787 in the captured failure:
    // added to the workspace group, ungrouped when that group was cleared, put in a freshly
    // created freestyle group, ungrouped again when that one was cleared.
    const unexpected: unknown[] = []
    const strict = new SelfGroupChangeLedger({
      onUnexpected: (info) => {
        unexpected.push(info)
      },
    })
    strict.note([924700787], WORKSPACE_GROUP)
    strict.note([924700787], UNGROUPED_TAB_GROUP_ID)
    strict.note([924700787], 'new-group')
    strict.note([924700787], UNGROUPED_TAB_GROUP_ID)

    expect(strict.consume(924700787, WORKSPACE_GROUP)).toBe(true)
    expect(strict.consume(924700787, UNGROUPED_TAB_GROUP_ID)).toBe(true)
    expect(strict.consume(924700787, 1967835491)).toBe(true)
    expect(strict.consume(924700787, UNGROUPED_TAB_GROUP_ID)).toBe(true)
    expect(strict.consume(924700787, UNGROUPED_TAB_GROUP_ID)).toBe(false)
    expect(unexpected).toEqual([])
  })

  it('records one change per tab for a multi-tab ungroup', () => {
    // Phase 1 clears a whole group in one call: chrome.tabs.ungroup([a, b, c]).
    const ledger = new SelfGroupChangeLedger()
    ledger.note([1, 2, 3], UNGROUPED_TAB_GROUP_ID)

    expect(ledger.consume(2, UNGROUPED_TAB_GROUP_ID)).toBe(true)
    expect(ledger.consume(1, UNGROUPED_TAB_GROUP_ID)).toBe(true)
    expect(ledger.consume(3, UNGROUPED_TAB_GROUP_ID)).toBe(true)
    expect(ledger.consume(1, UNGROUPED_TAB_GROUP_ID)).toBe(false)
  })

  it('stops absorbing once a recorded change has gone unreported past the TTL', () => {
    const clock = fixedClock()
    const undelivered: Array<{ tabId: number; ageMs: number }> = []
    const ledger = new SelfGroupChangeLedger({
      now: clock.now,
      onUndelivered: ({ tabId, ageMs }) => {
        undelivered.push({ tabId, ageMs })
      },
    })
    ledger.note([7], UNGROUPED_TAB_GROUP_ID)

    clock.advance(SELF_GROUP_CHANGE_TTL_MS + 1)

    // Chrome never reported our change. A human drag arriving later must NOT be swallowed by
    // the stale record — otherwise one lost event disables manual disconnect for that tab
    // forever.
    expect(ledger.consume(7, UNGROUPED_TAB_GROUP_ID)).toBe(false)
    expect(undelivered).toEqual([{ tabId: 7, ageMs: SELF_GROUP_CHANGE_TTL_MS + 1 }])
    expect(ledger.pendingCount(7)).toBe(0)
  })

  it('keeps absorbing changes that are still within the TTL', () => {
    const clock = fixedClock()
    const ledger = new SelfGroupChangeLedger({ now: clock.now })
    ledger.note([7], OTHER_GROUP)

    clock.advance(SELF_GROUP_CHANGE_TTL_MS - 1)

    expect(ledger.consume(7, OTHER_GROUP)).toBe(true)
  })

  it('forgets a closed tab so a recycled tab id inherits nothing', () => {
    const ledger = new SelfGroupChangeLedger()
    ledger.note([7], UNGROUPED_TAB_GROUP_ID)
    expect(ledger.pendingCount(7)).toBe(1)

    ledger.forget(7)

    expect(ledger.pendingCount(7)).toBe(0)
    expect(ledger.consume(7, UNGROUPED_TAB_GROUP_ID)).toBe(false)
  })

  // ── The two orderings that were measured failing, stated as the rule they violate ────────

  it('absorbs an ungroup of a tab that is connected at the moment Chrome reports it', () => {
    // Measured: `GRPEVT self-ungroup phase1 … tabs=[…,924700787]` immediately followed by
    // `dispatch#16 tab=924700787 groupId=-1 stateAtDispatch=connected`. Nothing about the
    // tab's state or its live groupId distinguishes this from a human drag-out — the tab
    // really is connected and really is ungrouped. Only the record of who moved it does.
    const ledger = new SelfGroupChangeLedger()
    ledger.note([924700787], UNGROUPED_TAB_GROUP_ID)

    expect(ledger.consume(924700787, UNGROUPED_TAB_GROUP_ID)).toBe(true)
  })

  it('absorbs a group() of a tab that has since been deliberately disconnected', () => {
    // Measured: `dispatch#13 … groupId=1839453140 stateAtDispatch=connected`, then
    // disconnectEverything() untracked the tab, then `process#13 … stateAtProcess=ABSENT` and
    // the handler read it as "Tab manually added to playwriter group" and re-attached the tab
    // as freestyle — invisible to the workspace that had owned it.
    const ledger = new SelfGroupChangeLedger()
    ledger.note([924700787], WORKSPACE_GROUP)

    expect(ledger.consume(924700787, WORKSPACE_GROUP)).toBe(true)
  })
})
