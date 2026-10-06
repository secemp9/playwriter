/**
 * download-match.ts — which chrome.downloads item a tab's CDP download is, and where its file is.
 *
 * Imported by the extension's service worker (no Node APIs here) and unit-tested from playwriter.
 *
 * Playwright reads a finished download from `<its downloads folder>/<guid>`, which Chrome only writes
 * when a DevTools client sets `Browser.setDownloadBehavior allowAndName`. An extension cannot:
 * chrome.debugger refuses `Page.setDownloadBehavior` ("Cannot not access browser-level commands") and
 * has no Browser domain, so Chrome saves the file where the user's settings say, under a name it
 * picks, and the tab's `Page.downloadProgress` carries no path. The extension's `downloads` permission
 * gives chrome.downloads, whose DownloadItem has the final absolute path (`filename`) once the file is
 * complete. chrome.downloads exposes no CDP guid, so the item is found from evidence. Measured on
 * Chromium 151 through the real extension:
 *   - `Page.downloadWillBegin.url` is the URL after redirects: the item's `finalUrl` (its `url` is the
 *     one first requested);
 *   - the item is created in the same moment as `Page.downloadWillBegin`, with `filename: ''`;
 *   - the tab's `Page.downloadProgress completed` arrives about 1ms BEFORE the item's `state` turns
 *     `complete`, with `receivedBytes` equal to the item's `bytesReceived`;
 *   - with Chrome's "Ask where to save each file" on, the item receives all its bytes and stays
 *     `in_progress` with `filename: ''` while the save dialog is open, and no `completed` arrives
 *     until the user picks a place (a headless browser cancels it at once: USER_CANCELED).
 */

/** What the tab's `Page.downloadWillBegin` said, and when (epoch ms) the extension saw it. */
export interface DownloadStart {
  guid: string
  url: string
  suggestedFilename: string
  seenAt: number
}

/** The chrome.downloads.DownloadItem fields the match reads. */
export interface ChromeDownloadItem {
  id: number
  url: string
  finalUrl: string
  /** Absolute path; '' until Chrome has decided it. */
  filename: string
  state: string
  /** ISO time the download started. */
  startTime: string
  bytesReceived: number
  totalBytes: number
}

export type ChromeDownloadState =
  /** The file is complete at `filePath`. */
  | { state: 'saved'; itemId: number; filePath: string }
  /** Chrome has all the bytes and waits for the user to choose where to save them. */
  | { state: 'asking'; itemId: number }
  /** Not decided yet: wait for chrome.downloads to report more. */
  | { state: 'pending'; reason: string }
  /** No item, or several, fit the evidence. */
  | { state: 'unmatched'; reason: string }

/** An item started this long before the tab reported the download can still be it (Chrome creates the item first). */
export const START_SLACK_BEFORE_MS = 10_000
/** …and this long after (both clocks are the browser's own, read in the same process). */
export const START_SLACK_AFTER_MS = 2_000

function baseName(filePath: string): string {
  return filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
}

/**
 * Which chrome.downloads item is the tab's download `start`, and what state its file is in.
 * `claimed`: items already given to other downloads. `completedBytes`: the tab's
 * `Page.downloadProgress completed` receivedBytes, or null while it is not completed.
 */
export function chromeDownloadState({
  start,
  items,
  claimed,
  completedBytes,
}: {
  start: DownloadStart
  items: readonly ChromeDownloadItem[]
  claimed: ReadonlySet<number>
  completedBytes: number | null
}): ChromeDownloadState {
  const sameUrl = items.filter((item) => item.finalUrl === start.url || item.url === start.url)
  const candidates = sameUrl.filter((item) => {
    const startedAt = Date.parse(item.startTime)
    return (
      !claimed.has(item.id) &&
      item.state !== 'interrupted' &&
      startedAt >= start.seenAt - START_SLACK_BEFORE_MS &&
      startedAt <= start.seenAt + START_SLACK_AFTER_MS &&
      // A finished item is this download only if it holds the bytes the tab reported.
      (item.state !== 'complete' || completedBytes === null || item.bytesReceived === completedBytes)
    )
  })
  const describe = (list: readonly ChromeDownloadItem[]): string =>
    list.map((item) => `#${item.id} ${item.state}${item.filename ? ` ${item.filename}` : ''} ${item.bytesReceived}B`).join(', ')
  if (candidates.length === 0) {
    const seen = sameUrl.length === 0 ? 'none' : describe(sameUrl)
    const reason = `no chrome.downloads item of ${start.url} started then${completedBytes === null ? '' : ` with ${completedBytes} bytes`} (items of that URL: ${seen})`
    return completedBytes === null ? { state: 'pending', reason } : { state: 'unmatched', reason }
  }
  let item = candidates[0]!
  if (candidates.length > 1) {
    const named = candidates.filter((candidate) => baseName(candidate.filename) === start.suggestedFilename)
    if (named.length !== 1) {
      const reason = `${candidates.length} chrome.downloads items of ${start.url} fit and nothing tells them apart (${describe(candidates)})`
      return completedBytes === null ? { state: 'pending', reason } : { state: 'unmatched', reason }
    }
    item = named[0]!
  }
  if (item.state === 'complete' && item.filename !== '') return { state: 'saved', itemId: item.id, filePath: item.filename }
  if (item.state === 'in_progress' && item.filename === '' && item.totalBytes > 0 && item.bytesReceived === item.totalBytes) {
    return { state: 'asking', itemId: item.id }
  }
  return { state: 'pending', reason: `chrome.downloads item #${item.id} is ${item.state}${item.filename ? ` at ${item.filename}` : ' with no file name yet'}` }
}
