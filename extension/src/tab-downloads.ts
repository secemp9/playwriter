/**
 * Where Chrome saved the downloads of attached tabs, for the relay (playwriter/src/download-file.ts).
 *
 * chrome.debugger cannot tell Chrome where to save a download (it refuses Page.setDownloadBehavior and
 * has no Browser domain), and the tab's Page.downloadProgress carries no path. chrome.downloads (the
 * `downloads` permission) has the file's final absolute path once it is complete. This finds the
 * chrome.downloads item each tab download is (playwriter/src/download-match.ts: same URL, started
 * then, not given to another download, holding the bytes the tab reported), and:
 *   - when the tab reports `completed`, says where the file is — or why it cannot tell — on that
 *     event, which the background holds until then (bounded by DOWNLOAD_FILE_WAIT_MS);
 *   - tells the relay when Chrome waits for the user to choose where to save it ("Ask where to save
 *     each file"), and when it no longer does.
 */

import { chromeDownloadState, START_SLACK_BEFORE_MS, type ChromeDownloadItem, type ChromeDownloadState, type DownloadStart } from 'playwriter/src/download-match'
import type { DownloadFileReport, ExtensionDownloadStateMessage } from 'playwriter/src/protocol'

/**
 * How long a completed download's forward waits for chrome.downloads to report the file. Measured on
 * Chromium 151: the item turns `complete` about 1ms after the tab's `completed`.
 */
export const DOWNLOAD_FILE_WAIT_MS = 5000

interface TabDownload {
  start: DownloadStart
  tabId: number
  /** The session its events are forwarded on. */
  sessionId: string
  /** Whether the relay was last told that Chrome waits for the user's choice. */
  asking: boolean
}

function itemOf(item: chrome.downloads.DownloadItem): ChromeDownloadItem {
  return {
    id: item.id,
    url: item.url,
    finalUrl: item.finalUrl,
    filename: item.filename,
    state: item.state,
    startTime: item.startTime,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
  }
}

export class TabDownloads {
  private readonly downloads = new Map<string, TabDownload>()
  /** chrome.downloads items given to a download, with when (epoch ms): an item is never given twice. */
  private readonly claimed = new Map<number, number>()
  /** Completed downloads waiting for chrome.downloads to report their file; woken on every change. */
  private readonly waiters = new Set<() => void>()

  constructor(private readonly sendState: (message: ExtensionDownloadStateMessage) => void) {}

  /** The tab's Page.downloadWillBegin. */
  began({ tabId, sessionId, guid, url, suggestedFilename }: { tabId: number; sessionId: string; guid: string; url: string; suggestedFilename: string }): void {
    this.downloads.set(guid, { start: { guid, url, suggestedFilename, seenAt: Date.now() }, tabId, sessionId, asking: false })
  }

  /** The tab's Page.downloadProgress `canceled`: nothing more to find. */
  canceled(guid: string): void {
    this.downloads.delete(guid)
  }

  /** The tab went away: its downloads report nothing more through it. */
  forgetTab(tabId: number): void {
    for (const [guid, download] of this.downloads) {
      if (download.tabId === tabId) this.downloads.delete(guid)
    }
  }

  /** chrome.downloads.onChanged: wake the completed downloads waiting for their file, and report a save dialog. */
  onChromeDownloadChanged(): void {
    for (const wake of [...this.waiters]) wake()
    void this.reportAsking()
  }

  /**
   * The tab's Page.downloadProgress `completed` with `receivedBytes`: where Chrome saved the file, from
   * chrome.downloads, waiting up to DOWNLOAD_FILE_WAIT_MS for it to report the file complete — or why
   * it cannot tell. Never rejects.
   */
  async fileOf(guid: string, receivedBytes: number): Promise<DownloadFileReport> {
    const download = this.downloads.get(guid)
    this.downloads.delete(guid)
    if (!download) return { problem: `the extension did not see this download (${guid}) begin on an attached tab` }
    if (typeof chrome.downloads === 'undefined') {
      return { problem: "the extension has no 'downloads' permission, so it cannot see where Chrome saved files" }
    }
    const deadline = Date.now() + DOWNLOAD_FILE_WAIT_MS
    for (;;) {
      // Registered before the search, so a change between the two is not missed.
      const changed = Promise.withResolvers<void>()
      this.waiters.add(changed.resolve)
      let state: ChromeDownloadState
      try {
        state = chromeDownloadState({ start: download.start, items: await this.items([download]), claimed: this.claimedIds(), completedBytes: receivedBytes })
      } catch (error) {
        this.waiters.delete(changed.resolve)
        return { problem: `chrome.downloads.search failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (state.state === 'saved') {
        this.waiters.delete(changed.resolve)
        this.claimed.set(state.itemId, Date.now())
        return { filePath: state.filePath }
      }
      if (state.state === 'unmatched') {
        this.waiters.delete(changed.resolve)
        return { problem: state.reason }
      }
      const left = deadline - Date.now()
      if (left <= 0) {
        this.waiters.delete(changed.resolve)
        const reason = state.state === 'asking' ? 'Chrome still waits for the user to choose where to save it' : state.reason
        return { problem: `Chrome reported the download finished, but chrome.downloads did not report its file within ${DOWNLOAD_FILE_WAIT_MS}ms: ${reason}` }
      }
      const timer = setTimeout(changed.resolve, left)
      await changed.promise
      clearTimeout(timer)
      this.waiters.delete(changed.resolve)
    }
  }

  private async reportAsking(): Promise<void> {
    const open = [...this.downloads.values()]
    if (open.length === 0 || typeof chrome.downloads === 'undefined') return
    let items: ChromeDownloadItem[]
    try {
      items = await this.items(open)
    } catch {
      // The next change asks again; a completed download reports its own search failure.
      return
    }
    for (const download of open) {
      if (this.downloads.get(download.start.guid) !== download) continue
      const asking = chromeDownloadState({ start: download.start, items, claimed: this.claimedIds(), completedBytes: null }).state === 'asking'
      if (asking === download.asking) continue
      download.asking = asking
      this.sendState({ method: 'downloadState', params: { sessionId: download.sessionId, guid: download.start.guid, asking } })
    }
  }

  /** The chrome.downloads items that can be any of `downloads`: started inside their matching window. */
  private async items(downloads: readonly TabDownload[]): Promise<ChromeDownloadItem[]> {
    const earliest = Math.min(...downloads.map((download) => download.start.seenAt)) - START_SLACK_BEFORE_MS - 1
    const found = await chrome.downloads.search({ startedAfter: new Date(earliest).toISOString() })
    return found.map(itemOf)
  }

  private claimedIds(): Set<number> {
    // An item given away earlier than the matching window reaches back can match nothing any more.
    const horizon = Date.now() - 2 * START_SLACK_BEFORE_MS
    for (const [id, at] of this.claimed) {
      if (at < horizon) this.claimed.delete(id)
    }
    return new Set(this.claimed.keys())
  }
}
