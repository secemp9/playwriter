/**
 * The human's element picker, started from the browser UI (context menu on the page or on
 * the extension icon) — never from anything injected into the page.
 *
 * It is Chrome's own picker: `Overlay.setInspectMode({ mode: 'searchForNode' })` on the
 * tab's debugger session. Chrome draws the hover highlight in its overlay layer (not the
 * DOM), swallows the click, and reports `Overlay.inspectNodeRequested { backendNodeId }`.
 * That event is ALSO forwarded through the relay like every other CDP event, so a
 * Playwriter session's `PinTracker` (playwriter/src/element-pins.ts) records the pin.
 *
 * Feedback stays out of the page too: the flash is `Overlay.highlightNode` (browser
 * rendered), the clipboard is written by the extension's offscreen document, and the
 * "picking" state shows on the extension icon's badge.
 *
 * Two purposes:
 *   - `pin`: copy `playwriter -e 'inspectPinnedElement({"url":…,"backendNodeId":…})'`.
 *   - `react-source`: copy the `file:line` of the JSX that rendered the element, read from
 *     the React fiber with a read-only `Runtime.callFunctionOn` (no bundle, no globals) and
 *     symbolicated here through the page's source maps (react-source-location.ts).
 */

import { PICKER_HIGHLIGHT_CONFIG } from 'playwriter/src/picker-highlight'
import {
  READ_REACT_FIBER_FUNCTION,
  SOURCE_ONLY_READ,
  formatReactSourceLocation,
  locateReactSource,
  type FiberReadResult,
} from 'playwriter/src/react-source-location'

export type PickPurpose = 'pin' | 'react-source'

/** The human has this long to click before the picker turns itself off. */
const PICK_TIMEOUT_MS = 60_000
const FLASH_MS = 900
const SOURCE_FETCH_TIMEOUT_MS = 5000

const FLASH_OK = { r: 34, g: 197, b: 94 }
const FLASH_FAIL = { r: 239, g: 68, b: 68 }

interface ActivePick {
  purpose: PickPurpose
  timer: ReturnType<typeof setTimeout>
}

export interface ElementPickerDeps {
  /** A bounded CDP command on the tab's root debugger session. */
  send: (tabId: number, method: string, params?: object) => Promise<unknown>
  copyText: (text: string) => Promise<void>
  getTabUrl: (tabId: number) => Promise<string | undefined>
  logger: { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  /** Picking state changed for some tab (the icon badge reflects it). */
  onStateChange: () => void
}

/**
 * The text the `pin` purpose copies. Single quotes are escaped as `\u0027` — valid JSON
 * that parses back to `'` — so the command slots into the shell's `'…'` quoting whatever
 * the URL contains.
 */
export function buildPinnedElementCommand(ref: { url: string; backendNodeId: number }): string {
  return `playwriter -e 'inspectPinnedElement(${JSON.stringify(ref).replace(/'/g, '\\u0027')})'`
}

export interface ElementPicker {
  /** Turn the picker on for a tab. Starting the same purpose again cancels it. */
  start: (tabId: number, purpose: PickPurpose) => Promise<void>
  isPicking: (tabId: number) => boolean
  /** `Overlay.inspectNodeRequested` from the tab's root session. */
  onNodePicked: (tabId: number, backendNodeId: number) => Promise<void>
  /** `Overlay.inspectModeCanceled` — Chrome already left inspect mode. */
  onCancelled: (tabId: number) => void
  /** The tab detached; its debugger session (and inspect mode) is gone. */
  forget: (tabId: number) => void
}

export function createElementPicker(deps: ElementPickerDeps): ElementPicker {
  const active = new Map<number, ActivePick>()

  const drop = (tabId: number): ActivePick | undefined => {
    const pick = active.get(tabId)
    if (!pick) return undefined
    clearTimeout(pick.timer)
    active.delete(tabId)
    deps.onStateChange()
    return pick
  }

  const stop = async (tabId: number): Promise<ActivePick | undefined> => {
    const pick = drop(tabId)
    // Chrome rejects mode 'none' without a highlightConfig ("highlight configuration
    // parameter is missing").
    if (pick) await deps.send(tabId, 'Overlay.setInspectMode', { mode: 'none', highlightConfig: PICKER_HIGHLIGHT_CONFIG })
    return pick
  }

  const flash = async (tabId: number, backendNodeId: number, color: { r: number; g: number; b: number }) => {
    await deps.send(tabId, 'Overlay.highlightNode', {
      backendNodeId,
      highlightConfig: { showInfo: false, contentColor: { ...color, a: 0.3 }, borderColor: { ...color, a: 1 } },
    })
    setTimeout(() => {
      deps.send(tabId, 'Overlay.hideHighlight').catch((error) => deps.logger.debug('Could not clear the pick flash:', error))
    }, FLASH_MS)
  }

  const fetchText = async (url: string): Promise<string> => {
    // The service worker's own fetch: host permissions let it read the page's scripts and
    // source maps without the page making (or seeing) a request.
    const response = await fetch(url, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.text()
  }

  const copyReactSource = async (tabId: number, backendNodeId: number): Promise<void> => {
    const resolved = (await deps.send(tabId, 'DOM.resolveNode', { backendNodeId })) as { object?: { objectId?: string } }
    const objectId = resolved.object?.objectId
    if (!objectId) throw new Error(`DOM.resolveNode returned no object for backendNodeId ${backendNodeId}`)
    let read: FiberReadResult | undefined
    try {
      const called = (await deps.send(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: READ_REACT_FIBER_FUNCTION,
        arguments: [{ value: SOURCE_ONLY_READ }],
        returnByValue: true,
      })) as { result?: { value?: FiberReadResult }; exceptionDetails?: { text: string } }
      if (called.exceptionDetails) throw new Error(`reading the React fiber threw: ${called.exceptionDetails.text}`)
      read = called.result?.value
    } finally {
      deps.send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {})
    }
    if (!read) throw new Error('reading the React fiber returned no value')

    const located = await locateReactSource(read, { fetchText })
    if (!located.ok) {
      deps.logger.warn('React source not found:', located.error)
      await flash(tabId, backendNodeId, FLASH_FAIL)
      return
    }
    const text = formatReactSourceLocation(located.location)
    await deps.copyText(text)
    await flash(tabId, backendNodeId, FLASH_OK)
    deps.logger.debug('Copied React source path:', text, located.location)
  }

  return {
    async start(tabId, purpose) {
      const previous = await stop(tabId)
      if (previous?.purpose === purpose) return

      const timer = setTimeout(() => {
        stop(tabId).catch((error) => deps.logger.debug('Could not end a timed-out element pick:', error))
      }, PICK_TIMEOUT_MS)
      active.set(tabId, { purpose, timer })
      deps.onStateChange()
      try {
        // Overlay refuses to enable before DOM. Neither is disabled afterwards: this is the
        // session Playwright drives the tab through.
        await deps.send(tabId, 'DOM.enable')
        await deps.send(tabId, 'Overlay.enable')
        await deps.send(tabId, 'Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: PICKER_HIGHLIGHT_CONFIG })
      } catch (error) {
        drop(tabId)
        throw error
      }
    },

    isPicking: (tabId) => active.has(tabId),

    async onNodePicked(tabId, backendNodeId) {
      const pick = await stop(tabId)
      // No pick of ours: an agent-initiated PinTracker.pickElement() — the relay delivers it.
      if (!pick) return
      try {
        if (pick.purpose === 'pin') {
          const url = (await deps.getTabUrl(tabId)) ?? ''
          await deps.copyText(buildPinnedElementCommand({ url, backendNodeId }))
          await flash(tabId, backendNodeId, FLASH_OK)
          deps.logger.debug('Pinned element', backendNodeId, 'on', url)
        } else {
          await copyReactSource(tabId, backendNodeId)
        }
      } catch (error) {
        deps.logger.error(`Element pick (${pick.purpose}) failed:`, error instanceof Error ? error.message : error)
        await flash(tabId, backendNodeId, FLASH_FAIL).catch(() => {})
      }
    },

    onCancelled(tabId) {
      drop(tabId)
    },

    forget(tabId) {
      drop(tabId)
    },
  }
}
