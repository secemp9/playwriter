/**
 * probe-types.ts — the data shapes shared by the "browse like a human" layer:
 * page-observe (what is on screen), page-watch (what happened / is it settled),
 * dialog-controller (JS dialogs), human-actions (act.*) and the executor that wires them.
 *
 * Kept in one dependency-free module so every producer and consumer agrees on one
 * definition. Nothing here talks to the browser.
 */

/**
 * An error whose message is written for the model and complete on its own: what failed, why, and
 * what to do instead. The executor prints it as is — no stack, no generic "call reset" hint, which
 * would send a weak model after the wrong cause.
 */
export class ModelFacingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ModelFacingError'
  }
}

/**
 * `human` — the default for model-facing entry points (MCP, CLI sessions). One input
 * action per execute call, no page.goto/reload after the first load, no forced state
 * (route/fulfill, DOM/style writes, synthetic events, direct API calls). Every input
 * action is followed by a settle and a "what changed" report.
 *
 * `debug` — everything allowed (multi-step scripts, network perturbation, DOM probes);
 * the same reports are still produced.
 */
export type PolicyMode = 'human' | 'debug'

/** Something on the page that tells a person "it is still working, wait". */
export interface BusySignal {
  /**
   * `strong` — the page itself says it is working: an element the accessibility tree marks
   * busy (aria-busy), an indeterminate progressbar or one whose value is moving (since the
   * action, or within the last 2 s without one), an endlessly repeating animation on screen that
   * started since the action and stands for loading — a spinner, or skeleton placeholders —,
   * content still streaming in, a response body still arriving. `weak` — worth reporting,
   * never a reason to wait or refuse: a spinner or skeleton that was already running before the
   * action, a status text announced since the action, a request the server holds open without
   * answering. A determinate progressbar standing still (a chart, a language bar, a finished
   * upload) is no busy signal at all.
   */
  strength: 'strong' | 'weak'
  kind: 'aria-busy' | 'progressbar' | 'status-text' | 'spinner' | 'skeleton' | 'dom-streaming' | 'network-streaming' | 'network-waiting'
  /** What a person would notice, e.g. `region "Search results" [aria-busy]`, `progressbar "Upload" (indeterminate)` or `6 skeleton placeholders (animation shimmer) in area "Products"`. */
  label: string
}

/** A native JS dialog (alert/confirm/prompt/beforeunload). While one is open the page's JS is frozen. */
export interface JsDialogState {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  defaultValue?: string
  openedAt: number
  /**
   * Who answers it: `auto` = answered at once without the agent (an alert always; a confirm or
   * prompt under the session policy `accept`/`dismiss`; a beforeunload only under an explicit
   * `beforeunload: 'leave' | 'stay'`); `agent` = it stays open until
   * `act.dialog.accept()`/`dismiss()`.
   */
  handling: 'agent' | 'auto'
  /** Set once the dialog is gone. `auto-accepted` = an alert acknowledged automatically (it has only one button). */
  outcome?: 'accepted' | 'dismissed' | 'auto-accepted'
  /** Answered by the session dialog policy (`act.dialog.policy`) as it opened, not by the agent. */
  answeredBy?: 'policy'
  /** The text a prompt was accepted with (its default when the answer gave none). */
  promptText?: string
  closedAt?: number
}

export interface NetworkRecord {
  /** Short id for the model: `r1`, `r2`, … unique per page for the session. */
  id: string
  /** CDP Network.RequestId — needed for Network.getResponseBody. */
  requestId: string
  seq: number
  method: string
  url: string
  /** Address of the iframe document that sent it; absent for the main frame's and for a worker's. */
  frame?: string
  /** Script address of the dedicated worker that sent it (nested workers included); absent for a document's. */
  worker?: string
  /**
   * CDP ResourceType: Document, XHR, Fetch, Script, Stylesheet, Image, EventSource, WebSocket, …
   * Absent until Chrome states it (requestWillBeSent, the response, or the failure).
   */
  resourceType?: string
  /** When the renderer issued it: epoch ms on this process's clock (the browser's stamp, converted with the measured offset between the clocks). */
  startedAt: number
  /** When this process learned it ended (epoch ms, this process's clock). */
  endedAt?: number
  status?: number
  /** The status line's text (`OK`, `Not Found`) Chrome reported with the status. */
  statusText?: string
  /** How long it took, from Chrome's own monotonic stamps: issued → last byte (or failure, or the redirect). */
  durationMs?: number
  /** Bytes received for it, headers included (Chrome's `encodedDataLength` when it finished). */
  bytes?: number
  /**
   * Why it failed: `CORS: <Chrome's reason> (<fetch|XMLHttpRequest|…> from <origin> to <url>)`,
   * `canceled`, CDP's errorText (`net::ERR_…`) or `blocked: <Chrome's reason>` (`csp`,
   * `mixed-content`, …). Absent when the request did not fail — also for a response with an error
   * status whose body Chrome stopped reading (a script that answered 404): that is `status` 404.
   */
  failed?: string
  /**
   * The browser turned its response into a download (the file name it suggested). Chrome cancels a
   * navigation for that; the request ended, it did not fail.
   */
  download?: string
  fromCache?: boolean
  /** Id of the previous hop when this request is a redirect target (POST /form → 303 → GET /done is two records). */
  redirectedFrom?: string
  /**
   * Set when Chrome stopped reporting this request before it finished, with why: the
   * out-of-process iframe that sent it was removed or moved to another renderer process, or the
   * worker that sent it ended, and its session went with it. `endedAt` is when that happened; how
   * the request ended is unknown.
   */
  lost?: string
}

export interface ConsoleRecord {
  seq: number
  at: number
  level: 'error' | 'warning' | 'exception'
  text: string
  /** `url:line:col` of the call site when CDP reported one. */
  location?: string
  /** URL of the iframe whose own code produced it; absent for the main frame and for a worker. */
  frame?: string
  /** Script address of the dedicated worker (nested ones included) whose code produced it. */
  worker?: string
}

export interface NavigationRecord {
  seq: number
  at: number
  /**
   * `cross-document` — a new document loaded (page.goto, reload, a full-page link, a form
   * POST): every client-side cache (SWR/React Query/Redux) and in-memory state is gone.
   * `restored` — a document restored from the back/forward cache: a different document than
   * before, but exactly as it was left (JS heap, in-memory app state and caches preserved).
   * `same-document` — history.pushState/replaceState/hash change: an SPA route change.
   */
  kind: 'cross-document' | 'restored' | 'same-document'
  url: string
  /**
   * Chrome's navigation type when it reported one: for a new document the
   * `Page.frameStartedNavigating` type (`differentDocument`, `reload`, `historyDifferentDocument`,
   * `restore`, …), for a same-document one the `Page.navigatedWithinDocument` type
   * (`historyApi`, `fragment`, `other`).
   */
  navigationType?: string
}

/** Text shown by a live region (status/alert/log/aria-live/output), a dialog, or a newly inserted top-layer or fixed overlay — including ones that vanished again. */
export interface LiveTextRecord {
  seq: number
  /** When it was shown: epoch ms on this process's clock (the page's stamp, converted). */
  at: number
  role: string
  text: string
  /** The element was already gone when the journal was read: a toast a slow reader would miss. */
  transient?: boolean
  /** URL of the iframe it was shown in; absent for the main frame. */
  frame?: string
}

/** A point in the page's event journal. `since(checkpoint)` returns what happened after it. */
export interface WatchCheckpoint {
  seq: number
  at: number
}

/** One WebSocket frame, as Chrome reports it on the page's session or an out-of-process iframe's. */
export interface WebSocketFrameRecord {
  requestId: string
  /** The socket URL from Network.webSocketCreated; absent for a socket opened before the watch started (Chrome states it only then). */
  url?: string
  direction: 'sent' | 'received'
  at: number
  /** WebSocket opcode: 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
  opcode: number
  /** Payload size in bytes. */
  bytes: number
}

export interface WatchEvents {
  /** Requests that started after the checkpoint (finished or not). */
  network: NetworkRecord[]
  /** Subset of `network`: HTTP status >= 400 or a network-level failure. */
  failedRequests: NetworkRecord[]
  console: ConsoleRecord[]
  navigations: NavigationRecord[]
  dialogs: JsDialogState[]
  live: LiveTextRecord[]
  /** Content mutations (childList/characterData) vs cosmetic ones (style/class) observed after the checkpoint. */
  mutations: { content: number; cosmetic: number }
  /** WebSocket frames sent or received after the checkpoint. */
  webSockets: WebSocketFrameRecord[]
  /**
   * Journals that dropped entries newer than the checkpoint (their caps were reached before
   * this was read): what is listed for them is a lower bound. Absent when nothing was dropped.
   */
  dropped?: Array<'network' | 'console' | 'navigations' | 'webSockets' | 'live' | 'mutations'>
}

export interface PendingRequest {
  method: string
  url: string
  /** CDP ResourceType when Chrome stated it. */
  resourceType?: string
  ageMs: number
}

export interface SettleResult {
  settled: boolean
  waitedMs: number
  /**
   * quiet — DOM content and network both quiet for their windows (and, for waitForIdle,
   * no strong busy signal). timeout — the cap was reached. js-dialog — a native dialog
   * blocks the page. page-closed — the page went away.
   */
  reason: 'quiet' | 'timeout' | 'js-dialog' | 'page-closed'
  pendingRequests: PendingRequest[]
  /**
   * Requests still open that the action did not cause (started before it: a long-poll, a
   * stream, a poller's call): listed, never waited on.
   */
  uncaused?: PendingRequest[]
  /**
   * Elements whose churn was excluded from "content quiet": timer/marquee/aria-live=off
   * regions, and elements that were already changing continuously before the action (a
   * clock, a ticker, a reply that was still streaming). Listed once so nothing is hidden.
   */
  ambient?: string[]
  /** Label of the element whose content was still changing when the cap hit. */
  domChangingIn?: string
  msSinceLastContentMutation?: number
  /**
   * The busy signals when the wait ended. Read only when waiting for idle (a strong one keeps it
   * waiting) and empty when the page was closed or a dialog blocks it; a plain settle does not read
   * them (the action report takes them from the picture it takes right after).
   */
  busy?: BusySignal[]
  /**
   * Loading indicators the settle step saw while it waited that were gone when it ended — an
   * aria-busy element, skeleton placeholders, a spinner — with how long they were seen (from the
   * first to the last poll that saw them: a lower bound). Ones still shown are in the busy signals
   * of the page now.
   */
  busyWhileSettling?: Array<{ label: string; seenMs: number }>
  /** The open dialog when reason is js-dialog. */
  dialog?: JsDialogState
}
