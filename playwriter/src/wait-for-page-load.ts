/**
 * The result shape of the sandbox's `waitForPageLoad`.
 *
 * `waitForPageLoad` itself lives on the page journal (executor.ts → PageWatch.settle). The
 * polling implementation that used to be here read `performance.getEntriesByType('resource')`,
 * which lists a request only after it has FINISHED, so an in-flight fetch was invisible and the
 * helper reported "loaded" in the middle of one. Which requests are waited on is decided by
 * PageWatch from Chrome's own request facts (resource type, ad tagging) and causality, never
 * from host or file-extension lists.
 */

/** What the sandbox's `waitForPageLoad({ page, timeout, minWait })` returns. */
export interface WaitForPageLoadResult {
  /** Page content and the requests the code caused were both quiet before the timeout. */
  success: boolean
  /** `document.readyState`, or `js-dialog` / `page-closed` when the page could not be read. */
  readyState: string
  /** `METHOD url` of every request still holding the wait when it returned. */
  pendingRequests: string[]
  waitTimeMs: number
  timedOut: boolean
}
