/**
 * react-source.ts — `getReactSource` / `getReactComponentInfo`: which component rendered an
 * element, where its JSX is written, and with which props. Read-only.
 *
 * Built on the shared fiber reader and symbolicator (react-source-location.ts): the element is
 * resolved to a main-world object (`DOM.resolveNode`, no executionContextId — React's fiber
 * expandos are only visible there), one `Runtime.callFunctionOn` reads the fiber chain and returns
 * plain JSON, and React 19 `_debugStack` frames are mapped through the scripts' source maps from
 * Node with `Network.loadNetworkResource` (`loadResourceText`), which the page neither makes nor
 * sees. Nothing is injected: no bundle, no global, no hook, no listener, no page fetch.
 *
 * `null` means "nothing to report": no React fiber on the element, no composite component above
 * it, or (for `getReactSource`) a build without debug records. A read that FAILS — a protocol
 * error or timeout, a page-side exception, a source map that exists but cannot be fetched, read
 * or does not map the position — throws an Error that names it.
 */

import type { Locator, ElementHandle } from '@xmorse/playwright-core'
import type { ICDPSession } from './cdp-session.js'
import { resolveElement } from './element-resolve.js'
import { PageUnresponsiveError, withDeadline } from './isolated-world.js'
import {
  READ_REACT_FIBER_FUNCTION,
  SOURCE_ONLY_READ,
  cleanSourceFileName,
  createSymbolicator,
  jsxSiteFromDebugStack,
  type FiberDebugSource,
  type FiberReadOptions,
  type FiberReadResult,
  type ReactSerializedProp,
  type Symbolicator,
} from './react-source-location.js'
import { loadResourceText } from './source-provenance.js'

export type { ReactSerializedProp }

export interface ReactSourceLocation {
  fileName: string | null
  lineNumber: number | null
  columnNumber: number | null
  componentName: string | null
}

export interface ReactComponentHierarchyItem {
  componentName: string | null
  source: Omit<ReactSourceLocation, 'componentName'> | null
  props: ReactSerializedProp
}

export interface ReactComponentInfo {
  componentName: string | null
  source: Omit<ReactSourceLocation, 'componentName'> | null
  hierarchy: ReactComponentHierarchyItem[]
  props: ReactSerializedProp
}

/**
 * The element to read: a Playwright locator / element handle (resolved through
 * `resolveElement`), or a node the caller already knows by `backendNodeId` on `cdp` — then
 * nothing runs in the page except the fiber read itself. `frameId` names the node's frame for
 * fetching source maps; the session's main frame when omitted.
 */
export type ReactElementTarget =
  | { locator: Locator | ElementHandle; cdp: ICDPSession }
  | { backendNodeId: number; frameId?: string; cdp: ICDPSession }

const CDP_TIMEOUT_MS = 5000
const MAX_SOURCE_BYTES = 40_000_000
const COMPONENT_INFO_READ: FiberReadOptions = { maxComponents: 20, maxAncestors: 0, props: true }

interface ElementFiber {
  read: FiberReadResult
  symbolicate: Symbolicator
}

async function readElementFiber(target: ReactElementTarget, options: FiberReadOptions): Promise<ElementFiber> {
  let cdp: ICDPSession
  let backendNodeId: number
  let frameId: string
  if ('locator' in target) {
    const resolved = await resolveElement({ target: target.locator, cdp: target.cdp })
    cdp = resolved.cdp
    backendNodeId = resolved.backendNodeId
    frameId = resolved.frameId
  } else {
    cdp = target.cdp
    backendNodeId = target.backendNodeId
    frameId =
      target.frameId ??
      (await withDeadline(cdp.send('Page.getFrameTree'), CDP_TIMEOUT_MS, 'reading the frame tree')).frameTree.frame.id
  }

  const objectGroup = `playwriter-react-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let read: FiberReadResult
  try {
    await withDeadline(cdp.send('DOM.enable'), CDP_TIMEOUT_MS, 'enabling the DOM domain')
    let objectId: string | undefined
    try {
      // No executionContextId: the main world, the only realm that sees React's expandos.
      const resolved = await withDeadline(cdp.send('DOM.resolveNode', { backendNodeId, objectGroup }), CDP_TIMEOUT_MS, `resolving node ${backendNodeId}`)
      objectId = resolved.object.objectId
    } catch (error) {
      if (error instanceof PageUnresponsiveError) throw error
      throw new Error(
        `Node ${backendNodeId} is not on this page session any more (${error instanceof Error ? error.message : String(error)}). ` +
          'It was removed, the page navigated, or it lives in an out-of-process iframe; locate the element again.',
      )
    }
    if (!objectId) throw new Error(`Node ${backendNodeId} could not be resolved to an object in the page.`)
    const called = await withDeadline(
      cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: READ_REACT_FIBER_FUNCTION,
        arguments: [{ value: options }],
        returnByValue: true,
        objectGroup,
      }),
      CDP_TIMEOUT_MS,
      `reading the React fiber of node ${backendNodeId}`,
    )
    if (called.exceptionDetails) {
      throw new Error(`Reading the React fiber threw in the page: ${called.exceptionDetails.exception?.description ?? called.exceptionDetails.text}`)
    }
    // Shape produced by READ_REACT_FIBER_FUNCTION, serialised by CDP (returnByValue).
    const value: FiberReadResult | undefined = called.result.value
    if (!value || typeof value !== 'object') throw new Error('Reading the React fiber returned no value.')
    read = value
  } finally {
    cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {})
  }

  const symbolicate = createSymbolicator((url) =>
    loadResourceText({ cdp, frameId, url, maxBytes: MAX_SOURCE_BYTES, timeoutMs: CDP_TIMEOUT_MS }),
  )
  return { read, symbolicate }
}

/**
 * Where one fiber's JSX is written, or null when the fiber carries no usable debug record. A
 * script without a source map is its own source, so its served position is returned; a source
 * map that cannot be used is an error.
 */
async function fiberSite(
  fiber: { debugSource: FiberDebugSource | null; debugStack: string | null },
  symbolicate: Symbolicator,
): Promise<Omit<ReactSourceLocation, 'componentName'> | null> {
  if (fiber.debugSource) {
    return {
      fileName: cleanSourceFileName(fiber.debugSource.fileName),
      lineNumber: fiber.debugSource.lineNumber ?? null,
      columnNumber: fiber.debugSource.columnNumber ?? null,
    }
  }
  const site = fiber.debugStack ? jsxSiteFromDebugStack(fiber.debugStack) : undefined
  if (!site) return null
  const mapped = await symbolicate(site)
  if (mapped.ok) return { fileName: cleanSourceFileName(mapped.fileName), lineNumber: mapped.line, columnNumber: mapped.column }
  if (mapped.sourceMap === 'none') return { fileName: cleanSourceFileName(site.url), lineNumber: site.line, columnNumber: site.column }
  throw new Error(`Could not map React's JSX site ${site.url}:${site.line}:${site.column} to its source: ${mapped.error}`)
}

/** The `file:line` of the JSX that rendered the element, and the component whose render it is. */
export async function getReactSource(target: ReactElementTarget): Promise<ReactSourceLocation | null> {
  const { read, symbolicate } = await readElementFiber(target, SOURCE_ONLY_READ)
  if (!read.reactFound) {
    console.warn('[getReactSource] no fiber found - is this a React element?')
    return null
  }
  for (const frame of read.frames) {
    const site = await fiberSite(frame, symbolicate)
    if (site) return { ...site, componentName: frame.owner ?? frame.element }
  }
  console.warn('[getReactSource] no source location found - is this a React dev build?')
  return null
}

/**
 * The composite components above the element, nearest first (up to 20), each with the JSX site
 * that created it and its props.
 */
export async function getReactComponentInfo(target: ReactElementTarget): Promise<ReactComponentInfo | null> {
  const { read, symbolicate } = await readElementFiber(target, COMPONENT_INFO_READ)
  const hierarchy = await Promise.all(
    read.components.map(
      async (component): Promise<ReactComponentHierarchyItem> => ({
        componentName: component.name,
        source: await fiberSite(component, symbolicate),
        props: component.props,
      }),
    ),
  )
  const nearest = hierarchy[0]
  if (!nearest) return null
  return { componentName: nearest.componentName, source: nearest.source, hierarchy, props: nearest.props }
}
