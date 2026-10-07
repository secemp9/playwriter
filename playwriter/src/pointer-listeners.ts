/**
 * pointer-listeners.ts — which elements of a document listen for pointer input other than a
 * click, read without touching the page.
 *
 * DOMSnapshot's `isClickable` already marks elements with a click listener. A card that opens its
 * own menu on right-click (`contextmenu`), a title renamed on double-click (`dblclick`), a canvas
 * or a custom slider driven by `pointerdown` are targets a person acts on too, and nothing in the
 * accessibility tree or the layout snapshot says so. `DOMDebugger.getEventListeners` on the
 * document with `depth: -1` lists every listener of every node under it (with `pierce`, inside
 * shadow roots too) in one call, each with the `backendNodeId` it is on: a read of the inspector's
 * listener table. Nothing runs in the page and nothing is added to it, and the objects the call wraps
 * (the document, every handler function) are released afterwards.
 *
 * The document is resolved in the frame's main world (`DOM.resolveNode` without a context): a
 * reference to the page's own document object, used only as the argument of this read. Resolved in
 * the isolated world instead, the same call with `pierce: true` crashed the renderer (SIGSEGV,
 * `Target.targetCrashed` errorCode 139) a few seconds later during the observe/settle polling of
 * human-mode-live's chat test, on Chromium 133 and Chrome 149. The main-world resolve, and the
 * isolated world without `pierce`, did not crash. `pierce` is needed for listeners inside shadow
 * roots.
 *
 * Cost, measured on Chromium 149 headless: 18–70 ms and 240–930 KB of protocol JSON on react.dev,
 * MDN, Wikipedia and a GitHub repository page (436–1297 listeners; the handlers' source text is
 * most of the bytes).
 */

import type { ICDPSession } from './cdp-session.js'
import { withDeadline } from './isolated-world.js'

/** Pointer events, besides click, whose listener makes an element something a person acts on. */
export const POINTER_LISTENER_TYPES: Record<string, true> = {
  contextmenu: true,
  dblclick: true,
  auxclick: true,
  mousedown: true,
  mouseup: true,
  pointerdown: true,
  pointerup: true,
  touchstart: true,
  touchend: true,
}

const DEAD_OBJECTS_RE = /Cannot find context with specified id|Execution context was destroyed|Cannot find execution context|Inspected target navigated or closed/i

/**
 * The pointer listener types (`POINTER_LISTENER_TYPES`) of every element under the document
 * `documentBackendId`, by backend node id, each list sorted. `cdp` is the session that owns the
 * frame.
 */
export async function readPointerListeners({
  cdp,
  documentBackendId,
  timeoutMs,
}: {
  cdp: ICDPSession
  documentBackendId: number
  timeoutMs: number
}): Promise<Map<number, string[]>> {
  const objectGroup = `playwriter-listeners-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    const { object } = await withDeadline(
      cdp.send('DOM.resolveNode', { backendNodeId: documentBackendId, objectGroup }),
      timeoutMs,
      'resolving the document to read its event listeners',
    )
    if (!object.objectId) throw new Error('DOM.resolveNode returned the document without an object id; its event listeners cannot be read.')
    const { listeners } = await withDeadline(
      cdp.send('DOMDebugger.getEventListeners', { objectId: object.objectId, depth: -1, pierce: true }),
      timeoutMs,
      'reading the event listeners of the page (DOMDebugger.getEventListeners)',
    )
    const byNode = new Map<number, Set<string>>()
    for (const listener of listeners) {
      if (listener.backendNodeId === undefined || !POINTER_LISTENER_TYPES[listener.type]) continue
      const types = byNode.get(listener.backendNodeId) ?? new Set<string>()
      types.add(listener.type)
      byNode.set(listener.backendNodeId, types)
    }
    return new Map([...byNode].map(([id, types]) => [id, [...types].sort()]))
  } finally {
    // A context that died with a navigation took its objects with it; nothing is left to release.
    await withDeadline(cdp.send('Runtime.releaseObjectGroup', { objectGroup }), timeoutMs, 'releasing the event listener objects').catch((error: unknown) => {
      if (!DEAD_OBJECTS_RE.test(error instanceof Error ? error.message : String(error))) throw error
    })
  }
}
