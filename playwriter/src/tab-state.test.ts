import { describe, expect, it } from 'vitest'
import { analyzeCode, checkPolicy } from './code-policy.js'
import { PageUnresponsiveError } from './isolated-world.js'
import { hiddenTabNote, unresponsiveDiagnosis, type TabVisibility } from './tab-state.js'
import type { TabVisibilityReport } from './tab-visibility.js'

const shown: TabVisibilityReport = { tabId: 7, targetId: 'T7', active: true, windowId: 1, windowState: 'normal', windowFocused: true, frontTab: null }
const read = (report: Partial<TabVisibilityReport>): TabVisibility => ({ kind: 'read', report: { ...shown, ...report } })

describe('a tab that did not answer in time', () => {
  it('states only the timeout, with no guessed dialog', () => {
    const error = new PageUnresponsiveError('reading the page', 3000)
    expect(error.message).toBe('The page did not respond within 3000ms while reading the page.')
  })

  it('names a dialog only when the dialog controller has one open', () => {
    const none = unresponsiveDiagnosis({ dialog: null, visibility: read({ active: false, frontTab: 'Inbox' }) })
    expect(none).not.toMatch(/may be open/)
    expect(none).toBe(
      'No native dialog is open on this tab. The tab is hidden — the tab "Inbox" is in front of it in its window: Chrome throttles a hidden ' +
        "tab's timers and can delay its answers — page.bringToFront() brings it to the front, then retry.",
    )
    const open = unresponsiveDiagnosis({
      dialog: { type: 'prompt', message: 'What is your name?', defaultValue: 'Guest', openedAt: 0, handling: 'agent' },
      visibility: read({}),
    })
    expect(open).toBe(
      'A native prompt("What is your name?", default "Guest") dialog is open on this tab and freezes it: answer it with act.dialog.accept() or act.dialog.dismiss().',
    )
    const busy = unresponsiveDiagnosis({ dialog: null, visibility: read({ windowFocused: false }) })
    expect(busy).toMatch(/^No native dialog is open on this tab\. The tab is visible, so neither a dialog nor background throttling explains it/)
    expect(unresponsiveDiagnosis({ dialog: null, visibility: null })).toMatch(/Tabs of a launched browser are not throttled in the background/)
    expect(unresponsiveDiagnosis({ dialog: null, visibility: { kind: 'unreadable', error: 'relay down' } })).toMatch(
      /Whether the tab is visible could not be read \(relay down\): if it may be behind another tab, page\.bringToFront\(\)/,
    )
  })

  it('says why the tab is hidden, what it costs and the fix', () => {
    expect(hiddenTabNote({ ...shown, windowState: 'minimized' })).toBe(
      'HIDDEN  this tab is not visible to the user: its window is minimised. ' +
        "Chrome throttles a hidden tab's timers and animations and slows its answers to input, and colour and file choosers may not open there — page.bringToFront() brings it to the front. " +
        'If this line is still here after it, its window stayed minimised: ask the user to restore it.',
    )
    expect(hiddenTabNote({ ...shown, active: false, frontTab: null })).toMatch(/^HIDDEN {2}this tab is not visible to the user: another tab is in front of it in its window\. Chrome throttles/)
  })
})

describe('human policy: session settings', () => {
  it('lets act.dialog.policy and act.switchTab go with the call’s one action', () => {
    const verdict = checkPolicy(analyzeCode("await act.dialog.policy('accept', { beforeunload: 'stay' }); await act.switchTab('Orders'); await act.click(3)"), {
      mode: 'human',
      pageIsBlank: false,
    })
    expect(verdict.allowed, verdict.refusal).toBe(true)
  })
})
