/**
 * Whether the user can see each attached tab, for the relay (playwriter/src/tab-visibility.ts): the tab
 * is the active one of its window, and that window's state and focus. Chrome throttles a tab the user
 * cannot see, and some of its UI (colour and file choosers) does not open there; the page itself reads
 * `visible` under Playwright's focus emulation, so only these APIs can tell.
 *
 * Reports go out on every tab and window event that can change it, only when it changed, and on every
 * `read(…, { force: true })` (the relay asks before it answers: minimising a window fires no event).
 */

import { isWindowState, type TabVisibilityReport } from 'playwriter/src/tab-visibility'

export class TabVisibilityTracker {
  /** The latest report sent for each tab, as JSON: an event that changes nothing sends nothing. */
  private readonly sent = new Map<number, string>()
  private readonly attachedTabs: () => Array<{ tabId: number; targetId: string }>
  private readonly send: (report: TabVisibilityReport) => void
  private readonly log: (...args: unknown[]) => void

  constructor(options: {
    /** The tabs the debugger is attached to, with their CDP target ids. */
    attachedTabs: () => Array<{ tabId: number; targetId: string }>
    send: (report: TabVisibilityReport) => void
    log: (...args: unknown[]) => void
  }) {
    this.attachedTabs = options.attachedTabs
    this.send = options.send
    this.log = options.log
  }

  listen(): void {
    const refresh = (): void => {
      void this.refreshAll()
    }
    chrome.tabs.onActivated.addListener(refresh)
    chrome.tabs.onAttached.addListener(refresh)
    chrome.tabs.onDetached.addListener(refresh)
    // The tab in front is named by its title.
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (changeInfo.title !== undefined) refresh()
    })
    chrome.windows.onFocusChanged.addListener(refresh)
    chrome.windows.onBoundsChanged.addListener(refresh)
  }

  /** Read the tab's visibility now; sent when it changed, or always with `force`. Rejects when the tab is gone. */
  async read(tabId: number, targetId: string, { force = false }: { force?: boolean } = {}): Promise<TabVisibilityReport> {
    const tab = await chrome.tabs.get(tabId)
    const window = await chrome.windows.get(tab.windowId)
    const [front] = tab.active ? [] : await chrome.tabs.query({ windowId: tab.windowId, active: true })
    const report: TabVisibilityReport = {
      tabId,
      targetId,
      active: tab.active,
      windowId: tab.windowId,
      windowState: isWindowState(window.state) ? window.state : 'normal',
      windowFocused: window.focused,
      frontTab: front ? front.title || front.url || null : null,
    }
    const key = JSON.stringify(report)
    if (force || this.sent.get(tabId) !== key) {
      this.sent.set(tabId, key)
      this.send(report)
    }
    return report
  }

  private async refreshAll(): Promise<void> {
    const attached = this.attachedTabs()
    for (const tabId of this.sent.keys()) {
      if (!attached.some((tab) => tab.tabId === tabId)) this.sent.delete(tabId)
    }
    for (const { tabId, targetId } of attached) {
      await this.read(tabId, targetId).catch((error: unknown) => {
        this.log(`tab visibility: reading tab ${tabId} failed:`, error instanceof Error ? error.message : String(error))
      })
    }
  }
}
