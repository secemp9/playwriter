/**
 * Per-page pointer bookkeeping (Node side), plus the opt-in live overlay.
 *
 * `attachToPage` gives every page a pointer track (`pointer-track.ts`): the fork's
 * `page.onMouseAction` hook records each Playwright move/down/up/wheel with its
 * coordinates. Recording reads nothing from the page and writes nothing to it — the CDP
 * recorder draws the pointer from this track at encode time.
 *
 * The in-page ghost cursor is a separate, explicit opt-in: only after `show()` are mouse
 * actions also forwarded to the overlay (which `show()` injects into the page). `hide()`
 * stops forwarding and removes it.
 */

import type { BrowserContext, Page } from '@xmorse/playwright-core'
import {
  applyGhostCursorMouseAction,
  disableGhostCursor,
  enableGhostCursor,
  type GhostCursorClientOptions,
} from './ghost-cursor.js'
import { pointerTrackFor, releasePointerTrack, type PointerTrack } from './pointer-track.js'

interface GhostCursorLogger {
  error: (...args: unknown[]) => void
}

interface RecordingTargetOptions {
  page?: Page
  sessionId?: string
}

export class GhostCursorController {
  /** Unsubscribe functions of the overlay forwarders, for pages that were shown. */
  private readonly forwarders = new WeakMap<Page, () => void>()
  private readonly logger: GhostCursorLogger

  constructor(options: { logger: GhostCursorLogger }) {
    this.logger = options.logger
  }

  resolveRecordingTargetPage(options: {
    context: BrowserContext
    defaultPage: Page
    target?: RecordingTargetOptions
  }): Page {
    const { context, defaultPage, target } = options

    if (target?.page) {
      return target.page
    }

    if (target?.sessionId) {
      const pageForSession = context.pages().find((candidatePage) => {
        return candidatePage.sessionId() === target.sessionId
      })

      if (pageForSession) {
        return pageForSession
      }
    }

    return defaultPage
  }

  /** Start recording this page's pointer. Idempotent; touches nothing in the page. */
  attachToPage(options: { page: Page }): void {
    pointerTrackFor(options.page)
  }

  /** The page's pointer timeline (created on first use). */
  pointerTrack(options: { page: Page }): PointerTrack {
    return pointerTrackFor(options.page)
  }

  detachFromPage(options: { page: Page }): void {
    const { page } = options
    this.forwarders.get(page)?.()
    this.forwarders.delete(page)
    releasePointerTrack(page)
  }

  /**
   * Inject and show the live in-page cursor. MODIFIES THE PAGE — see `enableGhostCursor`.
   * From here until `hide()`, every Playwright mouse action is also forwarded to it.
   * Throws when the overlay could not be shown.
   */
  async show(options: { page: Page; cursorOptions?: GhostCursorClientOptions }): Promise<void> {
    const { page, cursorOptions } = options
    await enableGhostCursor({ page, cursorOptions })
    if (this.forwarders.has(page)) return

    // Forwarding is queued per page and never awaited by the action: the overlay is
    // cosmetic and must not slow or fail the click it illustrates. Trajectories recorded
    // with `recordPath` are not forwarded sample by sample — the human-mouse driver hands
    // the whole path to the overlay in one call (`playGhostCursorPath`).
    let queue: Promise<void> = Promise.resolve()
    const unsubscribe = pointerTrackFor(page).onRecord((sample, origin) => {
      if (origin === 'path') return
      const event = { type: sample.kind, x: sample.x, y: sample.y, button: sample.button ?? 'none' } as const
      queue = queue
        .then(() => applyGhostCursorMouseAction({ page, event }))
        .catch((error) => {
          if (!page.isClosed()) this.logger.error('[playwriter] Failed to forward a mouse action to the ghost cursor', error)
        })
    })
    this.forwarders.set(page, unsubscribe)
  }

  /** Stop forwarding and remove the live cursor from the page. */
  async hide(options: { page: Page }): Promise<void> {
    const { page } = options
    this.forwarders.get(page)?.()
    this.forwarders.delete(page)
    await disableGhostCursor({ page })
  }
}
