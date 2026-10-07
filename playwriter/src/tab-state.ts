/**
 * tab-state.ts — what the model must know about the tabs it works in, beyond their content:
 * whether a new one is a popup window or a tab, whether the controlled tab is visible, and why a
 * tab stopped answering.
 *
 * All of it is read without touching the page: `Page.windowOpen` events on the opener's own
 * session (Chrome sends them for window.open and for links that open a new tab), and the
 * extension's report of the tab and its window (tab-visibility.ts) — the page's own
 * `document.visibilityState` reads `visible` under Playwright's focus emulation.
 */

import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import { dialogLabel } from './dialog-controller.js'
import type { JsDialogState } from './probe-types.js'
import { tabIsHidden, type TabVisibilityReport } from './tab-visibility.js'

/**
 * The window features Chrome reports in `Page.windowOpen` are the ENABLED ones after its own
 * popup decision (measured on Chromium 145 and Chrome 149): a tab carries `menubar`, `toolbar`,
 * `status` and `scrollbars` (`<a target=_blank>`, `window.open(url)`, `window.open(url, '_blank',
 * 'noopener')`); a popup window lacks them (`window.open(url, name, 'popup,width=520')` reports
 * `["width=520", "height=420", "resizable"]`).
 */
const TAB_CHROME_FEATURES = ['menubar', 'toolbar', 'status', 'scrollbars']

export interface WindowOpenRecord {
  url: string
  /** Chrome opened it as a popup window (no tab strip, toolbar or menu bar), not as a tab. */
  popup: boolean
  /** Chrome's enabled-feature list for it, e.g. `["width=520", "height=420", "resizable"]`. */
  features: string[]
  at: number
}

/** Every new window or tab a page asked Chrome for, from `Page.windowOpen` on the page's own session. */
export class WindowOpens {
  private readonly cdp: ICDPSession
  private readonly records: WindowOpenRecord[] = []
  private readonly onOpen = (event: Protocol.Page.WindowOpenEvent): void => {
    const popup = TAB_CHROME_FEATURES.some((feature) => !event.windowFeatures.includes(feature))
    this.records.push({ url: event.url, popup, features: event.windowFeatures, at: Date.now() })
    // A page that opens windows in a loop: only the recent requests can still be matched to a page.
    if (this.records.length > 50) this.records.shift()
  }

  constructor(cdp: ICDPSession) {
    this.cdp = cdp
    cdp.on('Page.windowOpen', this.onOpen)
  }

  /**
   * The request that opened a page now at `url`, taken so a second page with the same address
   * matches the next request. A page that redirected away from the address it was asked for is
   * matched only when exactly one request since `since` is left (then there is no other it can
   * be). Undefined when no request is known for it: the page came from elsewhere (an extension,
   * the person), or several are left and none has its address.
   */
  take(url: string, since: number): WindowOpenRecord | undefined {
    let index = this.records.findIndex((record) => record.url === url)
    if (index < 0) {
      const recent = this.records.flatMap((record, at) => (record.at >= since ? [at] : []))
      if (recent.length !== 1) return undefined
      index = recent[0]
    }
    return this.records.splice(index, 1)[0]
  }

  dispose(): void {
    this.cdp.off('Page.windowOpen', this.onOpen)
  }
}

/**
 * The controlled tab's visibility, read from the extension through the relay (tab-visibility.ts);
 * `unreadable` when the relay did not answer or has no report of the tab. A launched browser has no
 * such source and needs none: its background tabs are not throttled (measured, tab-visibility.ts).
 */
export type TabVisibility = { kind: 'read'; report: TabVisibilityReport } | { kind: 'unreadable'; error: string }

/**
 * What a hidden tab costs and how to bring it back. Also said when a slow input ack shows the renderer
 * throttled (human-mouse-driver.ts).
 */
export const HIDDEN_TAB_EFFECT =
  "Chrome throttles a hidden tab's timers and animations and slows its answers to input, and colour and file choosers may not open there — page.bringToFront() brings it to the front."

/** Why the user cannot see the tab, from the extension's report. */
function hiddenBecause(report: TabVisibilityReport): string {
  const causes: string[] = []
  if (!report.active) causes.push(report.frontTab ? `the tab "${report.frontTab}" is in front of it in its window` : 'another tab is in front of it in its window')
  if (report.windowState === 'minimized') causes.push('its window is minimised')
  return causes.join(', and ')
}

/** The line every observation and action report carries while the controlled tab cannot be seen. */
export function hiddenTabNote(report: TabVisibilityReport): string {
  // Measured in headless Chromium: page.bringToFront() focuses a minimised window but leaves it minimised.
  const minimised = report.windowState === 'minimized' ? ' If this line is still here after it, its window stayed minimised: ask the user to restore it.' : ''
  return `HIDDEN  this tab is not visible to the user: ${hiddenBecause(report)}. ${HIDDEN_TAB_EFFECT}${minimised}`
}

const BUSY_ADVICE = "the page's main thread is busy (a long-running script) or the connection to the browser is slow — act.waitForIdle(), then retry."

/**
 * What is known about a tab that did not answer in time: the dialog controller's record (it sees
 * every native dialog the tab opens) and the tab's visibility read just now (null: the browser was
 * launched, its background tabs are not throttled). Only facts: a dialog is named only when one is open.
 */
export function unresponsiveDiagnosis(facts: { dialog: JsDialogState | null; visibility: TabVisibility | null }): string {
  const { dialog, visibility } = facts
  if (dialog) {
    return dialog.handling === 'agent'
      ? `A native ${dialogLabel(dialog)} dialog is open on this tab and freezes it: answer it with act.dialog.accept() or act.dialog.dismiss().`
      : `A native ${dialogLabel(dialog)} dialog is open on this tab and is being answered by the session dialog policy; try again in a moment.`
  }
  const none = 'No native dialog is open on this tab.'
  if (!visibility) return `${none} Tabs of a launched browser are not throttled in the background, so ${BUSY_ADVICE}`
  if (visibility.kind === 'unreadable') {
    return `${none} Whether the tab is visible could not be read (${visibility.error}): if it may be behind another tab, page.bringToFront() brings it to the front; otherwise ${BUSY_ADVICE}`
  }
  if (tabIsHidden(visibility.report)) {
    return `${none} The tab is hidden — ${hiddenBecause(visibility.report)}: Chrome throttles a hidden tab's timers and can delay its answers — page.bringToFront() brings it to the front, then retry.`
  }
  return `${none} The tab is visible, so neither a dialog nor background throttling explains it: ${BUSY_ADVICE}`
}
