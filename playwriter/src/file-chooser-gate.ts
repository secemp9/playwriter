/**
 * file-chooser-gate.ts — a tab's file dialogs: held back by Chrome while an input of ours can still
 * open one, kept open until answered, and answered the way a person answers a file dialog.
 *
 * Chrome holds a native file chooser back while `Page.setInterceptFileChooserDialog` is on in the
 * session of the renderer that opens it, and sends `Page.fileChooserOpened` instead. The flag is per
 * renderer session: the page's own covers the main frame and its same-process iframes, each
 * out-of-process iframe has its own. It is never left on: in extension mode the tab is the user's
 * too, and their own file dialogs must open. When it is on follows from what Chromium does
 * (measured, CDP):
 *
 *  - A file chooser needs transient user activation: `input.click()` without it opens nothing, even
 *    while intercepting. Activation lasts 5 s after the activating input (measured 5019 ms after a
 *    CDP click) and runs on wall-clock time through a JS dialog (a confirm answered 6 s after the
 *    click left the page without it). So a chooser can follow our input for 5 s and no longer: each
 *    input holds interception until 5 s after it landed, not until its call returns (a timer, or a
 *    confirm answered quickly, can still open one).
 *  - The flag is set by the renderer. While a JS dialog freezes it the toggle waits, and once the
 *    dialog is answered it is applied after the page's resumed task: a chooser that task opens
 *    (`if (confirm(…)) input.click()`) is decided under the state from before the dialog. A toggle is
 *    therefore never waited for while a dialog is open, and a toggle that was not answered in time is
 *    still queued in Chrome — the state it asks for is the state the session ends in.
 *  - The flag is the one Playwright's own session holds (the adapter borrows that session): sandbox
 *    code that listens for `filechooser` makes Playwright set it as well. Interception is not
 *    released while such a listener exists, and is set again when Playwright clears it while an
 *    input of ours still needs it.
 *
 * Every chooser a session reports is recorded. One opened for our input stays open until it is
 * answered — a person faces a file dialog until they pick files or cancel it, and cannot use the
 * page meanwhile. Each record is reported once (`drain`).
 */

import type { Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import type { DialogController } from './dialog-controller.js'
import type { ActionRecord } from './human-actions.js'
import { withDeadline } from './isolated-world.js'
import type { PageFrames } from './page-frames.js'
import { ModelFacingError } from './probe-types.js'

/** How long an input's transient user activation lasts in Chromium (Blink's `kActivationLifespan`; measured 5019 ms). */
export const ACTIVATION_LIFESPAN_MS = 5000
const CDP_TIMEOUT_MS = 5000

/** In the frame's isolated world: whether the input a chooser was opened for is still in its document. */
const INPUT_CONNECTED_FN = 'function (_args, input) { return !!input && input.isConnected }'

export interface FileChooserRecord {
  id: number
  /** Epoch ms the chooser opened. */
  at: number
  /** The frame whose document opened it. */
  frameId: string
  /** Its `<input type=file>`; absent for a picker the page's script opened without one (`showOpenFilePicker`), which CDP cannot fill. */
  backendNodeId?: number
  multiple: boolean
  /** Sandbox code was listening for `filechooser`: Playwright handed the chooser to that code to answer. */
  toCode: boolean
  /** How it ended; absent while it is open. `gone`: its input left the page (a navigation, a re-render). */
  outcome?: 'chosen' | 'cancelled' | 'gone'
}

/** Held while an input of ours may open a file dialog. */
export interface ChooserWindow {
  /**
   * End the window. `lastInputAt` (epoch ms): when its last input landed; interception lasts until
   * that input's activation expired. Without it (nothing was dispatched) the window ends at once.
   */
  close(lastInputAt?: number): void
}

interface SessionState {
  cdp: ICDPSession
  /** The out-of-process frame the session is rooted at; null for the page's own session. */
  rootId: string | null
  /** What the last toggle sent on this session asks for. Chrome applies toggles in order: this is the state it ends in. */
  sent: boolean
  onOpened: (event: Protocol.Page.FileChooserOpenedEvent) => void
}

/** The act record a chooser followed: the last action on its tab that reached the page before it opened. */
export function chooserOpener(history: readonly ActionRecord[], record: FileChooserRecord): ActionRecord | undefined {
  return history.findLast((action) => action.dispatched === true && action.startedAt <= record.at)
}

/**
 * `your click [12] button "Upload photo"`, or `your answer to confirm("Replace your photo?")` when
 * the page opened the dialog as a message box it showed was answered: an act record, as the model
 * reads it in a file dialog's line.
 */
export function describeOpener(action: ActionRecord): string {
  if (action.kind === 'dialog-accept' || action.kind === 'dialog-dismiss') return `your answer to ${action.detail ?? 'a message box'}`
  const target = action.target ? ` [${action.target.ref}] ${action.target.role}${action.target.name ? ` "${action.target.name}"` : ''}` : ''
  return `your ${action.kind}${target}`
}

export class FileChooserGate {
  private readonly page: Page
  private readonly frames: PageFrames
  private readonly dialogs: DialogController
  private readonly sessions: SessionState[] = []
  private readonly records: FileChooserRecord[] = []
  private readonly sessionOf = new Map<number, ICDPSession>()
  private readonly waiters = new Set<(record: FileChooserRecord) => void>()
  private failures: string[] = []
  /** `records` before this index were reported. */
  private reportedUpTo = 0
  private holders = 0
  /** Epoch ms until which the last input's activation can still open a chooser. */
  private tailUntil = 0
  private tailTimer: NodeJS.Timeout | null = null
  private nextId = 1
  private disposed = false
  private readonly unlisten: Array<() => void> = []

  constructor(options: { page: Page; frames: PageFrames; dialogs: DialogController }) {
    this.page = options.page
    this.frames = options.frames
    this.dialogs = options.dialogs
    this.track(this.frames.cdp, null)
    // An out-of-process iframe that appears while an input still needs interception gets it too.
    this.unlisten.push(
      this.frames.onChange((change) => {
        if (change.kind !== 'detached' && this.wanted()) this.rearm(`an iframe ${change.kind === 'attached' ? 'appeared' : 'loaded a new document'}`)
      }),
    )
  }

  /** Hold file dialogs back from now on, until the window is closed (and its last input's activation expired). */
  async open(): Promise<ChooserWindow> {
    if (this.disposed) throw new ModelFacingError('This tab was closed.')
    this.holders += 1
    if (this.tailTimer) clearTimeout(this.tailTimer)
    this.tailTimer = null
    let closed = false
    const window: ChooserWindow = {
      close: (lastInputAt) => {
        if (closed) return
        closed = true
        this.holders -= 1
        if (lastInputAt !== undefined) this.tailUntil = Math.max(this.tailUntil, lastInputAt + ACTIVATION_LIFESPAN_MS)
        this.scheduleRelease()
      },
    }
    try {
      await this.arm()
    } catch (error) {
      window.close()
      throw error
    }
    return window
  }

  /** The file dialogs open on this tab now (input still in its document), oldest first. While a JS dialog freezes the page, the last known state. */
  async openDialogs(): Promise<FileChooserRecord[]> {
    const open = this.records.filter((record) => record.outcome === undefined && !record.toCode)
    if (open.length === 0 || this.dialogs.current()) return open
    for (const record of open) {
      if (record.backendNodeId === undefined) continue
      const connected = await this.inputConnected(record.frameId, record.backendNodeId)
      if (!connected) record.outcome = 'gone'
    }
    return open.filter((record) => record.outcome === undefined)
  }

  /** The first chooser that opened at or after `since` (epoch ms): one already recorded, or the next one. Null once `signal` aborts. */
  next(since: number, signal: AbortSignal): Promise<FileChooserRecord | null> {
    const recorded = this.records.find((record) => record.at >= since)
    if (recorded) return Promise.resolve(recorded)
    const found = Promise.withResolvers<FileChooserRecord | null>()
    const onRecord = (record: FileChooserRecord): void => {
      if (record.at < since) return
      this.waiters.delete(onRecord)
      found.resolve(record)
    }
    this.waiters.add(onRecord)
    signal.addEventListener(
      'abort',
      () => {
        this.waiters.delete(onRecord)
        found.resolve(null)
      },
      { once: true },
    )
    return found.promise
  }

  /** Choose `files` (absolute paths) in an open dialog: set on its input, which fires the page's `input`/`change`. */
  async choose(record: FileChooserRecord, files: string[]): Promise<void> {
    const cdp = this.sessionOf.get(record.id)
    if (record.backendNodeId === undefined || !cdp) {
      throw new ModelFacingError(
        "This file picker was opened by the page's script without a file input (window.showOpenFilePicker): files cannot be chosen in it over this browser connection. act.dialog.dismiss() closes it.",
      )
    }
    await withDeadline(cdp.send('DOM.setFileInputFiles', { files, backendNodeId: record.backendNodeId }), CDP_TIMEOUT_MS, 'choosing the files in the file dialog (DOM.setFileInputFiles)')
    record.outcome = 'chosen'
  }

  /** The person cancels the dialog. Chrome sends no `cancel` event to the page for a dialog it held back, so the page is not told. */
  cancel(record: FileChooserRecord): void {
    record.outcome = 'cancelled'
  }

  /** Every chooser since the last drain (open, answered or handed to code), and every interception failure: each reported once. */
  drain(): { records: FileChooserRecord[]; failures: string[] } {
    const records = this.records.slice(this.reportedUpTo)
    const failures = this.failures
    this.failures = []
    // Reported and finished: nothing will ask for them again. Open ones stay (reported, still open).
    for (const record of this.records) if (record.outcome !== undefined || record.toCode) this.sessionOf.delete(record.id)
    const open = this.records.filter((record) => record.outcome === undefined && !record.toCode)
    this.records.splice(0, this.records.length, ...open)
    this.reportedUpTo = this.records.length
    return { records, failures }
  }

  /**
   * Our client's `filechooser` subscription changed (sandbox code added its first or removed its last
   * listener). `applied` settles once Playwright's server has set the flag on its sessions — the same
   * sessions as ours.
   */
  playwrightToggled(enabled: boolean, applied: Promise<unknown>): void {
    void applied.then(
      () => {
        for (const state of this.sessions) state.sent = enabled
        if (!enabled && this.wanted()) this.rearm('sandbox code stopped listening for file dialogs')
      },
      // Playwright did not apply the change: the flag is as it was, and so is what `sent` says of it.
      () => {},
    )
  }

  /** The tab is gone or no longer watched: release whatever is still held back. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.tailTimer) clearTimeout(this.tailTimer)
    this.tailTimer = null
    for (const off of this.unlisten.splice(0)) off()
    for (const state of this.sessions) {
      state.cdp.off('Page.fileChooserOpened', state.onOpened)
      if (state.sent && !this.page.isClosed() && !this.codeListening()) void state.cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
    }
    this.sessions.length = 0
    for (const waiter of [...this.waiters]) this.waiters.delete(waiter)
  }

  private wanted(): boolean {
    return this.holders > 0 || Date.now() < this.tailUntil
  }

  /**
   * Sandbox code listens for `filechooser` through our Playwright client: Playwright holds the same flag
   * for it. The client's Page is an event emitter at run time; its public type does not say so.
   */
  private codeListening(): boolean {
    const listenerCount: unknown = Reflect.get(this.page, 'listenerCount')
    if (typeof listenerCount !== 'function') {
      throw new Error("This Playwright client's Page has no listenerCount(): whether sandbox code listens for file choosers cannot be known.")
    }
    const count: unknown = Reflect.apply(listenerCount, this.page, ['filechooser'])
    return typeof count === 'number' && count > 0
  }

  private track(cdp: ICDPSession, rootId: string | null): SessionState {
    const known = this.sessions.find((state) => state.cdp === cdp)
    if (known) return known
    const state: SessionState = {
      cdp,
      rootId,
      sent: false,
      onOpened: (event) => this.onOpened(state, event),
    }
    cdp.on('Page.fileChooserOpened', state.onOpened)
    this.sessions.push(state)
    return state
  }

  /** Sessions whose renderer still has frames of this page; the others are forgotten. */
  private async liveSessions(): Promise<SessionState[]> {
    for (const { cdp, rootId } of await this.frames.sessions()) this.track(cdp, rootId === this.frames.mainFrameId() ? null : rootId)
    const frameIds = new Set(this.page.frames().map((frame) => frame.frameId()))
    for (const state of [...this.sessions]) {
      if (state.rootId === null || frameIds.has(state.rootId)) continue
      state.cdp.off('Page.fileChooserOpened', state.onOpened)
      this.sessions.splice(this.sessions.indexOf(state), 1)
    }
    return [...this.sessions]
  }

  /** Turn interception on in every session that does not have it. Waits for Chrome's answer unless a JS dialog freezes the page. */
  private async arm(): Promise<void> {
    if (this.disposed || this.page.isClosed()) return
    const sessions = await this.liveSessions()
    await Promise.all(sessions.filter((state) => !state.sent).map((state) => this.toggle(state, true)))
  }

  /**
   * `arm` started by a page event, which has no caller to hand a failure to: the failure is reported
   * with the next action, like any interception failure. Once the tab is closed or no longer watched
   * nothing is held back, so there is nothing to report.
   */
  private rearm(why: string): void {
    this.arm().catch((error: unknown) => {
      if (this.disposed || this.page.isClosed()) return
      this.failures.push(`holding back the file dialogs of ${this.page.url()} after ${why} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private scheduleRelease(): void {
    if (this.holders > 0 || this.disposed) return
    if (this.tailTimer) clearTimeout(this.tailTimer)
    this.tailTimer = null
    const wait = this.tailUntil - Date.now()
    if (wait > 0) {
      this.tailTimer = setTimeout(() => {
        this.tailTimer = null
        this.scheduleRelease()
      }, wait)
      // A pending release never keeps the process alive; a closing connection ends interception with it.
      this.tailTimer.unref()
      return
    }
    // Sandbox code's own listener keeps Playwright's hold on the same flag: releasing it would cut that code off.
    if (this.codeListening() || this.page.isClosed()) return
    for (const state of this.sessions) {
      if (!state.sent) continue
      // `toggle` reports a failed release itself; this catches what fails around the send.
      this.toggle(state, false).catch((error: unknown) => {
        this.failures.push(`releasing the file dialogs of ${this.page.url()} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  /**
   * Send a toggle and wait for Chrome's answer — but not while a JS dialog freezes the page: the
   * answer comes once the dialog is answered, and the toggle is applied in its turn whatever this
   * side does. A toggle that fails is reported; one whose frame is gone needs nothing.
   */
  private async toggle(state: SessionState, enabled: boolean): Promise<void> {
    state.sent = enabled
    const what = `${enabled ? 'holding back' : 'releasing'} the file dialogs of ${state.rootId === null ? this.page.url() : `an iframe of ${this.page.url()}`}`
    const answered = state.cdp.send('Page.setInterceptFileChooserDialog', { enabled }).then(
      () => 'answered' as const,
      (error: unknown) => {
        if (!this.page.isClosed() && (state.rootId === null || this.page.frames().some((frame) => frame.frameId() === state.rootId))) {
          this.failures.push(`${what} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return 'answered' as const
      },
    )
    const frozen = Promise.withResolvers<'frozen'>()
    const off = this.dialogs.onChange((dialog) => {
      if (dialog) frozen.resolve('frozen')
    })
    if (this.dialogs.current()) frozen.resolve('frozen')
    const late = Promise.withResolvers<'late'>()
    const timer = setTimeout(() => late.resolve('late'), CDP_TIMEOUT_MS)
    const outcome = await Promise.race([answered, frozen.promise, late.promise])
    clearTimeout(timer)
    off()
    if (outcome === 'late') {
      this.failures.push(`${what}: the page did not answer within ${CDP_TIMEOUT_MS / 1000}s (its main thread is busy); it applies once the page answers`)
    }
  }

  private onOpened(state: SessionState, event: Protocol.Page.FileChooserOpenedEvent): void {
    const record: FileChooserRecord = {
      id: this.nextId++,
      at: Date.now(),
      frameId: event.frameId,
      ...(event.backendNodeId !== undefined ? { backendNodeId: event.backendNodeId } : {}),
      multiple: event.mode === 'selectMultiple',
      toCode: this.codeListening(),
    }
    this.records.push(record)
    this.sessionOf.set(record.id, state.cdp)
    for (const waiter of [...this.waiters]) waiter(record)
  }

  private async inputConnected(frameId: string, backendNodeId: number): Promise<boolean> {
    try {
      const frame = await this.frames.handle(frameId)
      return await frame.world.callFunctionOnNodes<boolean>([backendNodeId], INPUT_CONNECTED_FN, { what: 'checking that the file dialog’s input is still on the page' })
    } catch (error) {
      // Its frame left the page: the input went with it.
      if (error instanceof ModelFacingError) return false
      throw error
    }
  }
}
