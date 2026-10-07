/**
 * tab-visibility.ts — whether the user can see a tab the extension controls, as Chrome's tabs and
 * windows APIs say.
 *
 * The page cannot be asked. Playwright enables `Emulation.setFocusEmulationEnabled` on every page it
 * attaches, over the relay too, and on Chrome 149 that makes `document.visibilityState` read `visible`
 * in a background tab (measured with raw CDP). The extension can: `chrome.tabs` says whether the tab is
 * the active one of its window, `chrome.windows` whether that window is minimised and focused.
 *
 * MEASURED (Chromium, new headless, with an extension): `chrome.tabs.update(id, { active: true })` fires
 * `tabs.onActivated`; `chrome.windows.update(id, { state: 'minimized' })` changes the window's `state`
 * but fires neither `windows.onBoundsChanged` nor `windows.onFocusChanged`. So the extension reports on
 * every event it sees AND re-reads when the relay asks: the relay asks before it answers.
 *
 * MEASURED (same browser launched by Playwright, no extension): a background tab is not throttled —
 * 32 requestAnimationFrame callbacks in 500 ms, like the front tab, and unthrottled timers. A launched
 * browser therefore has no hidden tab to report.
 *
 * Flow: extension `tabVisibility` message (extension/src/tab-visibility.ts) → the relay keeps the
 * latest report per target (`RelayTabVisibility`, served at `GET /tab-visibility/:targetId`, which
 * first asks the extension to re-read: READ_TAB_VISIBILITY) → the executor reads it at every
 * observation and when the tab does not answer in time (page-probe.ts, tab-state.ts).
 *
 * This module is shared: the extension imports its types, READ_TAB_VISIBILITY and isWindowState only.
 */

/** `chrome.windows.WindowState`. */
export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen'

/** The extension's report of an attached tab (extension → relay `tabVisibility` message). */
export interface TabVisibilityReport {
  tabId: number
  /** The tab's CDP target id. */
  targetId: string
  /** The tab is the selected tab of its window. */
  active: boolean
  windowId: number
  windowState: WindowState
  /** Its window has the keyboard focus (false while another window or application is in front). */
  windowFocused: boolean
  /** The title (or address) of the tab in front of it in its window; null when it is that tab. */
  frontTab: string | null
}

/** What the relay answers `GET /tab-visibility/:targetId` with: the latest report, aged on the relay's clock. */
export interface TabVisibilityStatus extends TabVisibilityReport {
  /** Since the relay received the report. */
  ageMs: number
}

/** Relay → extension request: read the tab's visibility now. Answered with its TabVisibilityReport, or null when the target is not an attached tab. */
export const READ_TAB_VISIBILITY = 'readTabVisibility'

/** The user cannot see the tab: another tab is in front of it, or its window is minimised. */
export function tabIsHidden(report: Pick<TabVisibilityReport, 'active' | 'windowState'>): boolean {
  return !report.active || report.windowState === 'minimized'
}

/** The relay's latest report of every attached tab, by target id, for `GET /tab-visibility/:targetId`. */
export class RelayTabVisibility {
  private readonly records = new Map<string, { report: TabVisibilityReport; extensionId: string; at: number }>()

  report(extensionId: string, report: TabVisibilityReport, now = Date.now()): void {
    this.records.set(report.targetId, { report, extensionId, at: now })
  }

  status(targetId: string, now = Date.now()): TabVisibilityStatus | null {
    const record = this.records.get(targetId)
    return record ? { ...record.report, ageMs: now - record.at } : null
  }

  /** The extension connection left: its reports describe tabs it no longer controls. */
  forgetExtension(extensionId: string): void {
    for (const [targetId, record] of this.records) {
      if (record.extensionId === extensionId) this.records.delete(targetId)
    }
  }
}

const WINDOW_STATES: Record<WindowState, true> = { normal: true, minimized: true, maximized: true, fullscreen: true, 'locked-fullscreen': true }

/** `chrome.windows` answers a WindowState; the relay's JSON is checked, not trusted. */
export function isWindowState(value: unknown): value is WindowState {
  return typeof value === 'string' && Object.hasOwn(WINDOW_STATES, value)
}

/** Reads the relay's answer; anything else is named, never guessed into a status. */
export function parseTabVisibilityStatus(value: unknown): TabVisibilityStatus | { invalid: string } {
  if (typeof value !== 'object' || value === null) return { invalid: 'not an object' }
  const field = (name: string): unknown => (name in value ? Reflect.get(value, name) : undefined)
  const tabId = field('tabId')
  const targetId = field('targetId')
  const active = field('active')
  const windowId = field('windowId')
  const windowState = field('windowState')
  const windowFocused = field('windowFocused')
  const frontTab = field('frontTab')
  const ageMs = field('ageMs')
  if (typeof targetId !== 'string' || typeof tabId !== 'number' || typeof windowId !== 'number') return { invalid: 'no targetId/tabId/windowId' }
  if (typeof active !== 'boolean' || typeof windowFocused !== 'boolean') return { invalid: 'no active/windowFocused' }
  if (!isWindowState(windowState)) return { invalid: `unknown windowState ${String(windowState)}` }
  if (frontTab !== null && typeof frontTab !== 'string') return { invalid: 'frontTab is not a string' }
  if (typeof ageMs !== 'number') return { invalid: 'no ageMs' }
  return { tabId, targetId, active, windowId, windowState, windowFocused, frontTab, ageMs }
}
