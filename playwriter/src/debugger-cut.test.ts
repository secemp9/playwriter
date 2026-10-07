/**
 * The relay's record of tabs Chrome took the debugger off (debugger-cut.ts), what the model reads
 * about them, and what becomes of their refs. Live behaviour: debugger-cut-relay.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeDebuggerCut, parseDebuggerCutStatus, RelayDebuggerCuts, type DebuggerCutReport, type DebuggerCutStatus } from './debugger-cut.js'
import { RefRegistry } from './ref-registry.js'

const MENU = 'chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu-list.html'

const report = (overrides: Partial<DebuggerCutReport> = {}): DebuggerCutReport => ({
  tabId: 7,
  targetId: 'T1',
  state: 'reattaching',
  cause: { kind: 'extension-frame', url: MENU },
  attempts: 0,
  lastError: null,
  reattachedAfterMs: null,
  sessionId: null,
  endedBecause: null,
  retryWindowMs: 300_000,
  ...overrides,
})

const status = (overrides: Partial<DebuggerCutStatus> = {}): DebuggerCutStatus => ({ ...report(), cutAgoMs: 4100, lastAttemptAgoMs: 1000, ...overrides })

afterEach(() => {
  vi.useRealTimers()
})

describe('RelayDebuggerCuts', () => {
  it('answers a waiting client the moment the tab is back, ages on its own clock, and restarts on a new cut', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const cuts = new RelayDebuggerCuts()
    cuts.report('ext', report())
    expect(cuts.extensionOf('T1')).toBe('ext')
    vi.advanceTimersByTime(500)
    cuts.report('ext', report({ attempts: 3, lastError: 'Cannot access a chrome-extension:// URL of different extension' }))
    vi.advanceTimersByTime(200)
    expect(cuts.status('T1')).toMatchObject({ state: 'reattaching', attempts: 3, cutAgoMs: 700, lastAttemptAgoMs: 200 })

    const waiting = cuts.settled('T1', 10_000)
    vi.advanceTimersByTime(300)
    cuts.report('ext', report({ state: 'reattached', attempts: 4, reattachedAfterMs: 1000 }))
    await expect(waiting).resolves.toMatchObject({ state: 'reattached', reattachedAfterMs: 1000, cutAgoMs: 1000 })
    expect(cuts.extensionOf('T1')).toBeNull()

    vi.advanceTimersByTime(5000)
    cuts.report('ext', report())
    expect(cuts.status('T1')).toMatchObject({ state: 'reattaching', attempts: 0, cutAgoMs: 0, lastAttemptAgoMs: null })
  })

  it('answers with the open record when the wait runs out, and nothing for a tab it never heard of', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const cuts = new RelayDebuggerCuts()
    cuts.report('ext', report())
    const waiting = cuts.settled('T1', 2000)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(waiting).resolves.toMatchObject({ state: 'reattaching', cutAgoMs: 2000 })
    await expect(cuts.settled('nope', 2000)).resolves.toBeNull()
  })

  it('forgets the open cuts of an extension that left, waking whoever waits on them', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const cuts = new RelayDebuggerCuts()
    cuts.report('ext', report())
    const waiting = cuts.settled('T1', 10_000)
    cuts.forgetExtension('ext')
    await expect(waiting).resolves.toBeNull()
  })

  it('drops a re-attached tab whose session then detaches with no cut reported: that tab really went away', () => {
    const cuts = new RelayDebuggerCuts()
    cuts.report('ext', report())
    cuts.report('ext', report({ state: 'reattached', attempts: 1, reattachedAfterMs: 40, sessionId: 'pw-tab-2' }))
    cuts.sessionDetached('pw-tab-1')
    expect(cuts.status('T1')).toMatchObject({ state: 'reattached' })
    cuts.sessionDetached('pw-tab-2')
    expect(cuts.status('T1')).toBeNull()
  })
})

describe('describeDebuggerCut', () => {
  it('names the frame, the re-attach and the lost refs', () => {
    expect(describeDebuggerCut(status({ state: 'reattached', reattachedAfterMs: 1234 }))).toBe(
      "DEBUGGER CUT — Chrome took the debugger off this tab because another extension's frame (chrome-extension://nngceckbapebfimnlniiiahkandclblb, e.g. a password manager's autofill menu) is in the page; the tab is still open. Re-attached after 1.2 s; refs from before are gone — observe() again.",
    )
  })

  it('says what to do while the frame stays, and which transport is not subject to it', () => {
    const text = describeDebuggerCut(status({ attempts: 9, lastError: 'Cannot access a chrome-extension:// URL of different extension' }))
    expect(text).toContain('Not re-attached yet (9 tries in 4.1 s; the last, 1.0 s ago, got "Cannot access a chrome-extension:// URL of different extension")')
    expect(text).toContain("ask the user to close it (Escape, or a click elsewhere in that tab), or to turn off that extension's inline autofill menu for this site")
    expect(text).toContain('Playwriter re-attaches by itself the moment Chrome allows it; your next call reports it.')
    expect(text).toContain("A Playwriter session over Chrome's own remote debugging (PLAYWRITER_DIRECT, chrome://inspect) is not subject to this.")
    expect(describeDebuggerCut(status({ state: 'waiting', attempts: 300, lastError: 'x' }))).toContain('Playwriter stopped retrying on its own after 300 s; each of your calls tries again.')
  })

  it('names a restricted page, and says when nothing named the cause', () => {
    expect(describeDebuggerCut(status({ cause: { kind: 'restricted-page', url: 'chrome://settings/' } }))).toMatch(
      /^DEBUGGER CUT — Chrome took the debugger off this tab because it went to chrome:\/\/settings\/, a page Chrome lets no extension debug; the tab is still open\. Not re-attached yet \(no attempt yet\): ask the user to take the tab back to a normal web page\./,
    )
    expect(describeDebuggerCut(status({ cause: { kind: 'unnamed', detachReason: 'target_closed' } }))).toMatch(/^DEBUGGER CUT — Chrome took the debugger off this tab \(Chrome named no cause, only "target_closed"\); the tab is still open\./)
  })
})

describe('parseDebuggerCutStatus', () => {
  it('reads what the relay sends, and names what it cannot read', () => {
    const sent = status({ state: 'reattached', reattachedAfterMs: 80, attempts: 2, lastError: 'Cannot access a chrome-extension:// URL of different extension' })
    expect(parseDebuggerCutStatus(JSON.parse(JSON.stringify(sent)))).toEqual(sent)
    expect(parseDebuggerCutStatus({ ...sent, state: 'gone' })).toEqual({ invalid: 'unknown state gone' })
    expect(parseDebuggerCutStatus({ ...sent, cause: { kind: 'extension-frame' } })).toEqual({ invalid: 'unknown cause extension-frame' })
  })
})

describe('refs of a cut tab', () => {
  it('say the debugger was cut, not that the tab closed; a tab that really closed still says closed', () => {
    const registry = new RefRegistry()
    const element = { role: 'textbox', name: 'Email', nodeKey: 'F:5' as const, frameId: 'F', frameDocumentId: 'L1', backendNodeId: 5 }
    const cutTab = registry.begin('T1', 'L1')
    const cutRef = cutTab.assign(element)
    cutTab.commit({ absent: new Map(), shown: true, frameDocuments: new Map([['F', 'L1']]) })
    const closedTab = registry.begin('T2', 'L2')
    const closedRef = closedTab.assign({ ...element, frameId: 'G', frameDocumentId: 'L2', nodeKey: 'G:5' as const })
    closedTab.commit({ absent: new Map(), shown: true, frameDocuments: new Map([['G', 'L2']]) })

    // Both pages close (what Playwright reports for a cut too); only T1's tab is still open.
    registry.closeTab('T1')
    registry.closeTab('T2')
    registry.debuggerCut('T1')

    expect(registry.resolve(cutRef)).toMatchObject({
      ok: false,
      reason: 'closed',
      error: `Ref [${cutRef}] is from before Chrome took the debugger off this tab (DEBUGGER CUT); the tab is the same, but its elements must be read again. Call observe() to get new refs.`,
    })
    expect(registry.resolve(closedRef)).toMatchObject({ ok: false, reason: 'closed', error: `Ref [${closedRef}] is from a tab that has been closed. Call observe() to get refs for the page you are on.` })
  })
})
