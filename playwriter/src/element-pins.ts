/**
 * element-pins.ts — elements the HUMAN pointed at, through Chrome's own element picker.
 *
 * The picker is `Overlay.setInspectMode({ mode: 'searchForNode' })`: Chrome draws the hover
 * highlight in its overlay layer (browser-rendered, not DOM) and swallows the click, then
 * reports the node as `Overlay.inspectNodeRequested { backendNodeId }`. Nothing is injected
 * into the page and no page listener sees the pick.
 *
 * Two ways in:
 *   - the human starts it from the Playwriter extension (context menu "Pin an element for
 *     Playwriter"). The extension runs the picker on the tab's debugger session, and the
 *     resulting `Overlay.inspectNodeRequested` is forwarded through the relay like every
 *     other event, so `start()` collects it into `pins()`;
 *   - the AGENT asks: `pickElement()` turns the picker on, waits for the human's click and
 *     always turns it off again.
 *
 * A `backendNodeId` is stable for the life of the node in that document; resolve it with
 * `DOM.resolveNode` / `DOM.describeNode` (or map it to an observe() ref).
 */

import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import { withDeadline } from './isolated-world.js'
import { PICKER_HIGHLIGHT_CONFIG } from './picker-highlight.js'
import { ModelFacingError } from './probe-types.js'

export interface ElementPin {
  backendNodeId: number
  /** Epoch ms the pick arrived. */
  at: number
  /** The page URL at that moment, when `getUrl` was supplied. */
  url?: string
}

/** Pins kept per page; the oldest are dropped. */
export const MAX_PINS = 100

const COMMAND_TIMEOUT_MS = 5000
const DEFAULT_PICK_TIMEOUT_MS = 120_000

export class PickTimeoutError extends ModelFacingError {
  constructor(timeoutMs: number) {
    super(
      `No element was picked within ${timeoutMs}ms: the human did not click an element in the tab while ` +
        "Chrome's element picker was active. The picker has been turned off; call pickElement() again to retry.",
    )
    this.name = 'PickTimeoutError'
  }
}

/** The human pressed Esc in the picker: they chose not to point at anything. */
export class PickCancelledError extends ModelFacingError {
  constructor() {
    super('The human cancelled the element picker (Esc) without picking an element. Ask them what they meant instead.')
    this.name = 'PickCancelledError'
  }
}

interface PendingPick {
  resolve: (pick: { backendNodeId: number }) => void
  reject: (error: Error) => void
}

export class PinTracker {
  private readonly cdp: ICDPSession
  private readonly getUrl?: () => string | undefined
  private readonly collected: ElementPin[] = []
  private pending: PendingPick | null = null
  private started = false

  constructor(options: { cdp: ICDPSession; getUrl?: () => string | undefined }) {
    this.cdp = options.cdp
    this.getUrl = options.getUrl
  }

  /** Listen for picks. Idempotent and cheap: it only subscribes to two CDP events. */
  start(): void {
    if (this.started) return
    this.started = true
    this.cdp.on('Overlay.inspectNodeRequested', this.onInspectNodeRequested)
    this.cdp.on('Overlay.inspectModeCanceled', this.onInspectModeCanceled)
  }

  dispose(): void {
    if (this.started) {
      this.cdp.off('Overlay.inspectNodeRequested', this.onInspectNodeRequested)
      this.cdp.off('Overlay.inspectModeCanceled', this.onInspectModeCanceled)
      this.started = false
    }
    this.pending?.reject(new Error('The pin tracker was disposed (page closed or session ended) before an element was picked.'))
    this.pending = null
  }

  /** Every element the human pinned from the extension, oldest first. */
  pins(): ElementPin[] {
    return this.collected.map((pin) => ({ ...pin }))
  }

  /** Drop a pin whose node is gone (removed, or its document replaced): it can never resolve again. */
  forget(backendNodeId: number): void {
    for (let index = this.collected.length - 1; index >= 0; index--) {
      if (this.collected[index].backendNodeId === backendNodeId) this.collected.splice(index, 1)
    }
  }

  /**
   * Ask the human to click the element they mean. Turns Chrome's element picker on, resolves
   * with the clicked node, and always turns the picker off again — on success, on timeout
   * (`PickTimeoutError`), on Esc, and on failure.
   */
  async pickElement(options?: { timeoutMs?: number }): Promise<{ backendNodeId: number }> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_PICK_TIMEOUT_MS
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
      throw new Error(`pickElement: timeoutMs must be a positive finite number of ms, got ${timeoutMs}.`)
    }
    if (this.pending) {
      throw new Error('pickElement is already waiting for the human to pick an element on this page.')
    }
    this.start()

    // Armed BEFORE inspect mode is on, so a click that lands immediately cannot be missed.
    const { promise: picked, resolve, reject } = Promise.withResolvers<{ backendNodeId: number }>()
    this.pending = { resolve, reject }
    const timer = setTimeout(() => reject(new PickTimeoutError(timeoutMs)), timeoutMs)
    // A rejection can land while the setup commands below are still in flight (Esc, dispose);
    // it is observed by the `await picked` that follows, not lost as an unhandled rejection.
    picked.catch(() => {})

    let failure: Error | undefined
    try {
      // Overlay refuses to enable until DOM is enabled ("DOM should be enabled first").
      // Neither is ever disabled here: the session is shared with Playwright.
      await withDeadline(this.cdp.send('DOM.enable'), COMMAND_TIMEOUT_MS, 'enabling the DOM domain for the element picker')
      await withDeadline(this.cdp.send('Overlay.enable'), COMMAND_TIMEOUT_MS, 'enabling the Overlay domain for the element picker')
      await withDeadline(
        this.cdp.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: PICKER_HIGHLIGHT_CONFIG }),
        COMMAND_TIMEOUT_MS,
        "turning on Chrome's element picker",
      )
      return await picked
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      throw failure
    } finally {
      clearTimeout(timer)
      this.pending = null
      // Always turned off, and a failure to do so is never swallowed: a picker left on
      // would swallow the human's next click in the tab. Chrome rejects mode 'none' without
      // a highlightConfig ("highlight configuration parameter is missing"), so it is passed.
      try {
        await withDeadline(
          this.cdp.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: PICKER_HIGHLIGHT_CONFIG }),
          COMMAND_TIMEOUT_MS,
          "turning Chrome's element picker off (it may still be active — clicks in the tab would be swallowed)",
        )
      } catch (restoreError) {
        if (!failure) throw restoreError
        throw new Error(`${failure.message} Turning the picker off also failed: ${restoreError.message}`, { cause: failure })
      }
    }
  }

  private readonly onInspectNodeRequested = (event: Protocol.Overlay.InspectNodeRequestedEvent): void => {
    if (this.pending) {
      // The agent asked for this one; it is the answer, not a standing pin.
      this.pending.resolve({ backendNodeId: event.backendNodeId })
      this.pending = null
      return
    }
    const url = this.getUrl?.()
    this.collected.push({ backendNodeId: event.backendNodeId, at: Date.now(), ...(url ? { url } : {}) })
    if (this.collected.length > MAX_PINS) this.collected.splice(0, this.collected.length - MAX_PINS)
  }

  private readonly onInspectModeCanceled = (): void => {
    this.pending?.reject(new PickCancelledError())
    this.pending = null
  }
}
