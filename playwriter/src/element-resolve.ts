/**
 * element-resolve.ts — turn a Playwright Locator / ElementHandle into the CDP node it points at.
 *
 * Playwright never hands a client its handles' CDP ids (the fork's ElementHandle channel has no
 * objectId/backendNodeId), so identity is carried across in two steps:
 *
 *   1. ONE read in the element's own realm through Playwright (`handle.evaluate`): the element's
 *      element-child index path inside its document, split at shadow roots (`computeElementPath`).
 *      It reads `parentElement`/`children`/`getRootNode`, writes nothing and returns plain data.
 *   2. That path is walked in OUR isolated world on the element's frame (invisible to the page),
 *      which returns the node by reference; `DOM.describeNode` turns it into a backendNodeId.
 *      Shadow roots are entered through `DOM.describeNode({ pierce: true })` on the host, so open
 *      and closed roots work alike (a closed root is unreachable from any JS world).
 *
 * Identity, not geometry: no hit-testing, so whatever is painted on top cannot change the answer.
 * The final node's tag is checked against the one the page reported; a DOM change between the two
 * steps fails with an error saying so — there is no retry and no guess.
 *
 * Frames: the element's owner frame decides the session. A same-process iframe is answered by the
 * page session with that frame's world; an out-of-process iframe has its own session
 * (`getCDPSessionForFrame`), which is returned so callers talk to the right target.
 */

import type { ElementHandle, Frame, Locator } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import { getCDPSessionForFrame } from './cdp-session.js'
import type { ICDPSession } from './cdp-session.js'
import { IsolatedWorld, withDeadline } from './isolated-world.js'
import type { RefElement } from './page-probe.js'

const CDP_TIMEOUT_MS = 5000

/**
 * One tree on the way to the element. `document` = the element's own document (path starts at
 * the document element, whose own index is implied), `shadow` = the shadow root of the host the
 * previous hop resolved. `path` is the chain of 0-based ELEMENT child indexes in that tree.
 */
export interface ElementPathHop {
  enter: 'document' | 'shadow'
  path: number[]
}

export interface ElementPathResult {
  hops: ElementPathHop[]
  /** Lowercased tag name of the target, used to verify the walk landed on it. */
  tagName: string
  /** Set when the path cannot be expressed, e.g. a detached element. */
  error?: string
}

/** The DOM surface `computeElementPath` reads; the package compiles without the DOM lib. */
export interface PathNode {
  nodeType: number
  tagName?: string
  parentElement: PathNode | null
  parentNode?: PathNode | null
  children: ArrayLike<PathNode>
  host?: PathNode
  getRootNode?: () => PathNode
}

/**
 * The element's position in its own document as index paths split at shadow-root boundaries.
 *
 * Runs IN THE PAGE (stringified by `evaluate`), so it must stay self-contained: no imports, no
 * closure over module scope. It only reads.
 */
export function computeElementPath(element: PathNode): ElementPathResult {
  const hops: ElementPathHop[] = []
  const tagName = String(element.tagName || '').toLowerCase()
  let node: PathNode = element
  let path: number[] = []
  const elementIndexIn = (parent: PathNode, child: PathNode): number => {
    for (let i = 0; i < parent.children.length; i++) {
      if (parent.children[i] === child) return i
    }
    return -1
  }
  for (let guard = 0; guard < 10000; guard++) {
    const parentElement = node.parentElement
    if (parentElement) {
      const index = elementIndexIn(parentElement, node)
      if (index < 0) return { hops: [], tagName, error: 'element is not among its parent element children' }
      path.unshift(index)
      node = parentElement
      continue
    }
    const root = node.getRootNode ? node.getRootNode() : node.parentNode
    if (root && root.nodeType === 11 && root.host) {
      const index = elementIndexIn(root, node)
      if (index < 0) return { hops: [], tagName, error: 'element is not among its shadow root children' }
      path.unshift(index)
      hops.unshift({ enter: 'shadow', path })
      path = []
      node = root.host
      continue
    }
    if (root && root.nodeType === 9) {
      hops.unshift({ enter: 'document', path })
      return { hops, tagName }
    }
    return { hops: [], tagName, error: 'element is detached from any document' }
  }
  return { hops: [], tagName, error: 'element ancestor chain exceeded 10000 steps' }
}

/** Walks element-child indexes from the document element (isolated world, `this` unused). */
const WALK_FROM_DOCUMENT = `function (path) {
  var node = document.documentElement
  for (var i = 0; node && i < path.length; i++) node = node.children[path[i]] || null
  return node
}`

/** Walks element-child indexes from `this`, a shadow root (isolated world). */
const WALK_FROM_ROOT = `function (path) {
  var node = this
  for (var i = 0; node && i < path.length; i++) node = node.children[path[i]] || null
  return node
}`

export interface ResolvedElement {
  backendNodeId: number
  /** `DOM.describeNode` of the element (localName, attributes, …). */
  node: Protocol.DOM.Node
  /** The session that owns the element's document: the page session, or an OOPIF's own. */
  cdp: ICDPSession
  /** True when `cdp` is an out-of-process iframe's session, not the one passed in. */
  ownSession: boolean
  /** CDP frame id of the element's frame. */
  frameId: string
  /** The element's owner frame. */
  frame: Frame
  /** The isolated world on the element's frame that resolved it (same session as `cdp`). */
  world: IsolatedWorld
}

interface FrameWorld {
  world: IsolatedWorld
  cdp: ICDPSession
  ownSession: boolean
}

const frameWorlds = new WeakMap<Frame, Promise<FrameWorld>>()

async function createFrameWorld(frame: Frame, pageCdp: ICDPSession): Promise<FrameWorld> {
  const own = frame.parentFrame() ? await getCDPSessionForFrame({ frame }) : null
  const cdp = own ?? pageCdp
  const world = new IsolatedWorld({ cdp, getFrameId: () => frame.frameId() })
  if (frame.parentFrame()) {
    const page = frame.page()
    const onDetached = (detached: Frame): void => {
      if (detached !== frame) return
      world.dispose()
      page.off('framedetached', onDetached)
    }
    page.on('framedetached', onDetached)
  }
  return { world, cdp, ownSession: own !== null }
}

function frameWorldFor(frame: Frame, pageCdp: ICDPSession): Promise<FrameWorld> {
  let pending = frameWorlds.get(frame)
  if (!pending) {
    pending = createFrameWorld(frame, pageCdp)
    frameWorlds.set(frame, pending)
    pending.catch(() => frameWorlds.delete(frame))
  }
  return pending
}

/** The node a remote call returned, or a specific error naming what did not resolve. */
function objectIdOf(called: Protocol.Runtime.CallFunctionOnResponse, what: string): string {
  if (called.exceptionDetails) {
    throw new Error(`${what} threw in the isolated world: ${called.exceptionDetails.exception?.description ?? called.exceptionDetails.text}`)
  }
  if (!called.result.objectId) {
    throw new Error(`${what} found no element there: the DOM changed after the element was located. Locate it again.`)
  }
  return called.result.objectId
}

/**
 * What the element readers (styles, React, fiber, snapshot scope, clean HTML) take: a Playwright
 * Locator / ElementHandle — resolved here with Playwright's script in the page, which Playwright runs
 * as a user gesture, so debug mode only — or an element already resolved without touching the page
 * (`refElementTarget`, from a ref).
 */
export type ElementTarget = Locator | ElementHandle | ResolvedElement

/** The element a ref names (`PageProbes.element`), as the readers take it: read through CDP and the frame's isolated world only. */
export function refElementTarget({ probe, target, frame, node }: RefElement): ResolvedElement {
  return {
    backendNodeId: target.backendNodeId,
    node,
    cdp: frame.cdp,
    ownSession: frame.cdp !== probe.cdp,
    frameId: frame.frameId,
    frame: frame.frame,
    world: frame.world,
  }
}

/**
 * Resolve a Locator (waits for the element to be attached, like any Playwright action) or an
 * ElementHandle to its CDP node. `cdp` is the page's session. An already resolved element is
 * returned as it is, so both forms go through the same readers.
 */
export async function resolveElement({ target, cdp }: { target: ElementTarget; cdp: ICDPSession }): Promise<ResolvedElement> {
  if ('backendNodeId' in target) return target
  const handle = 'elementHandle' in target ? await target.elementHandle() : target
  if (!handle) throw new Error('Could not resolve the element over CDP: the locator matched no element')
  try {
    const described = await handle.evaluate(computeElementPath)
    if (described.error) throw new Error(`Could not resolve the element over CDP: ${described.error}`)
    const frame = await handle.ownerFrame()
    if (!frame) throw new Error('Could not resolve the element over CDP: it belongs to no frame (detached)')
    const { world, cdp: session, ownSession } = await frameWorldFor(frame, cdp)
    const frameId = frame.frameId()
    const objectGroup = `playwriter-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      await withDeadline(session.send('DOM.enable'), CDP_TIMEOUT_MS, 'enabling the DOM domain')
      const contextId = await world.getContextId(CDP_TIMEOUT_MS)
      let objectId = ''
      for (const [index, hop] of described.hops.entries()) {
        if (hop.enter === 'document') {
          const what = `walking the element path in frame ${frameId}`
          const called = await withDeadline(
            session.send('Runtime.callFunctionOn', {
              functionDeclaration: WALK_FROM_DOCUMENT,
              executionContextId: contextId,
              arguments: [{ value: hop.path }],
              objectGroup,
            }),
            CDP_TIMEOUT_MS,
            what,
          )
          objectId = objectIdOf(called, what)
          continue
        }
        const host = await withDeadline(
          session.send('DOM.describeNode', { objectId, depth: 1, pierce: true }),
          CDP_TIMEOUT_MS,
          'reading the shadow root of a host on the element path',
        )
        const shadowRoot = (host.node.shadowRoots ?? []).find((root) => root.shadowRootType !== 'user-agent')
        if (!shadowRoot) {
          throw new Error(
            `Could not resolve the element: <${host.node.localName}> on its path has no author shadow root any more (the DOM changed). Locate it again.`,
          )
        }
        const root = await withDeadline(
          session.send('DOM.resolveNode', { backendNodeId: shadowRoot.backendNodeId, executionContextId: contextId, objectGroup }),
          CDP_TIMEOUT_MS,
          'resolving a shadow root on the element path',
        )
        if (!root.object.objectId) throw new Error(`Could not resolve the shadow root of <${host.node.localName}> in the isolated world`)
        const what = `walking the element path inside shadow root ${index}`
        const called = await withDeadline(
          session.send('Runtime.callFunctionOn', {
            functionDeclaration: WALK_FROM_ROOT,
            objectId: root.object.objectId,
            arguments: [{ value: hop.path }],
            objectGroup,
          }),
          CDP_TIMEOUT_MS,
          what,
        )
        objectId = objectIdOf(called, what)
      }
      const { node } = await withDeadline(session.send('DOM.describeNode', { objectId }), CDP_TIMEOUT_MS, 'describing the resolved element')
      if (node.localName.toLowerCase() !== described.tagName) {
        throw new Error(
          `Could not resolve the element: its path now leads to <${node.localName}>, not the <${described.tagName}> the locator points at — the DOM changed while resolving. Locate it again.`,
        )
      }
      return { backendNodeId: node.backendNodeId, node, cdp: session, ownSession, frameId, frame, world }
    } finally {
      session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {})
    }
  } finally {
    if (handle !== target) await handle.dispose()
  }
}
