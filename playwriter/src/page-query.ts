/**
 * page-query.ts — query handlers for `find()` and `readPage(fn, { query })`: find elements by role,
 * label, placeholder, text, alt text, title, test id, CSS through every shadow root, or XPath, the
 * grammar omp's browser tool and Puppeteer use — without composing CSS or JavaScript, and without
 * running anything in the page's own JavaScript world:
 *
 *   role/<role>[name="…"]   Chrome's accessibility tree: the computed role and accessible name (a
 *                           name contains the text, ignoring case; ` exact` inside the brackets: the
 *                           whole name). `role/img` and `role/image` are the same role.
 *   aria/<name>[role="…"]   Puppeteer's form: the whole accessible name, case included.
 *   label/<text>            elements named by a <label>, aria-label or aria-labelledby containing it.
 *   placeholder/ alt/ title/ <text>   that attribute contains the text (case ignored).
 *   testid/<id>             data-testid equals it.
 *   text/<text>             the innermost elements whose text contains it (case and spacing ignored).
 *   pierce/<css>            CSS matched in the document and inside every shadow root, closed ones too.
 *   xpath/<expr>            XPath on each frame's document.
 *
 * Every frame of the page is searched (out-of-process iframes too). The accessibility tree and the
 * DOM come from CDP (`Accessibility.getFullAXTree`, `DOM.getDocument` with `pierce`, which reaches
 * closed shadow roots, and `DOM.querySelectorAll` on each root); XPath runs in playwriter's isolated
 * world. Each match gets a ref: the one observe() lists for it, or one adopted for it
 * (`RefRegistry.adopt`) so act.*, readPage, explain and getCleanHTML can use it.
 */

import type { BrowserContext, Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import { axStatesFromNode, formatAxStates } from './ax-states.js'
import { REACHES_TARGET_FN } from './composed-hit.js'
import { isNodeGoneError, withDeadline } from './isolated-world.js'
import { ModelFacingError } from './probe-types.js'
import type { PageProbe, PageProbes } from './page-probe.js'
import type { FrameEntry, UnreadableFrame } from './page-frames.js'
import { describeElement, describeWhere, quote, type Observation, type ObservedElement } from './page-observe.js'

const CDP_TIMEOUT_MS = 5000
/** Rows printed by default; the count covers every match. */
const DEFAULT_LIMIT = 20

const HANDLERS = ['role', 'aria', 'label', 'placeholder', 'text', 'alt', 'title', 'testid', 'pierce', 'xpath'] as const
type HandlerKind = (typeof HANDLERS)[number]
const QUERY_RE = new RegExp(`^(${HANDLERS.join('|')})/([\\s\\S]*)$`)

/** A query in the handler grammar. */
export interface ParsedQuery {
  kind: HandlerKind
  /** The query as the model wrote it. */
  source: string
  /** role/aria: the role (lowercase); empty when aria/ names no role. */
  role: string
  /** role/aria: the accessible name to match; undefined to match any. Other handlers: the text after the slash. */
  value: string | undefined
  /** role/: the whole name must match (` exact`). aria/: always. */
  exact: boolean
}

const ROLE_GRAMMAR =
  'role/<role> or role/<role>[name="…"], with exact inside the brackets for the whole name: role/button[name="Save" exact]'

/** Roles Chrome reports under another name than ARIA's. */
const ROLE_ALIASES: Record<string, string> = { img: 'image', image: 'image' }

/** `null` when `query` is plain text (find's word search); throws, naming the grammar, when a handler query is malformed. */
export function parseQuery(query: string): ParsedQuery | null {
  const match = QUERY_RE.exec(query.trim())
  if (!match) return null
  const kind = HANDLERS.find((handler) => handler === match[1])
  if (kind === undefined) return null
  const rest = match[2].trim()
  const source = query.trim()
  if (kind === 'role') {
    const parts = /^([A-Za-z][\w-]*)\s*(?:\[\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]\s"']+))\s*(exact)?\s*\])?$/i.exec(rest)
    if (!parts) throw new ModelFacingError(`find(${quote(source, 200)}): not a role query. The form is ${ROLE_GRAMMAR}.`)
    const name = parts[2] ?? parts[3] ?? parts[4]
    return { kind, source, role: parts[1].toLowerCase(), value: name === undefined ? undefined : name.replace(/\\(.)/g, '$1'), exact: parts[5] !== undefined }
  }
  if (kind === 'aria') {
    const parts = /^([\s\S]*?)\s*(?:\[\s*role\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+))\s*\])?$/.exec(rest)
    const name = parts?.[1].trim() ?? ''
    const role = (parts?.[2] ?? parts?.[3] ?? parts?.[4] ?? '').trim().toLowerCase()
    if (!parts || (name === '' && role === '')) {
      throw new ModelFacingError(`find(${quote(source, 200)}): aria/ takes the whole accessible name, and optionally a role: aria/Submit order[role="button"].`)
    }
    return { kind, source, role, value: name === '' ? undefined : name, exact: true }
  }
  if (rest === '') {
    throw new ModelFacingError(`find(${quote(source, 200)}): nothing after "${kind}/". Write what to look for, like ${kind}/${EXAMPLES[kind]}.`)
  }
  return { kind, source, role: '', value: rest, exact: false }
}

const EXAMPLES: Record<HandlerKind, string> = {
  role: 'button[name="Save"]',
  aria: 'Save',
  label: 'Email',
  placeholder: 'Search',
  text: 'Order placed',
  alt: 'Logo',
  title: 'Close',
  testid: 'submit-button',
  pierce: '.toolbar button',
  xpath: '//table//tr[2]',
}

/** Case and runs of spaces ignored. */
function loose(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** One element a query matched: its frame and its node. */
interface Hit {
  frame: FrameEntry
  backendNodeId: number
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

/** The accessible name a role/aria/label query compares, by the node's AX data. */
function axMatches(query: ParsedQuery, node: Protocol.Accessibility.AXNode): boolean {
  if (node.ignored || node.backendDOMNodeId === undefined) return false
  const role = String(node.role?.value ?? '').toLowerCase()
  const name = typeof node.name?.value === 'string' ? node.name.value : ''
  if (query.kind === 'label') {
    const wanted = loose(query.value ?? '')
    return (node.name?.sources ?? []).some((source) => {
      const labelled =
        source.attribute === 'aria-label' ||
        source.attribute === 'aria-labelledby' ||
        source.nativeSource === 'label' ||
        source.nativeSource === 'labelfor' ||
        source.nativeSource === 'labelwrapped'
      const text = source.value?.value
      return labelled && typeof text === 'string' && loose(text).includes(wanted)
    })
  }
  if (query.role !== '' && role !== (ROLE_ALIASES[query.role] ?? query.role)) return false
  if (query.value === undefined) return true
  if (query.kind === 'aria') return name.replace(/\s+/g, ' ').trim() === query.value.replace(/\s+/g, ' ').trim()
  return query.exact ? loose(name) === loose(query.value) : loose(name).includes(loose(query.value))
}

/** A frame's part of a session's pierced DOM tree: its document and shadow roots, and its elements in document order. */
interface FrameDom {
  /** nodeIds of the document and of every author shadow root (open and closed), for querySelectorAll. */
  roots: number[]
  elements: Protocol.DOM.Node[]
}

/** Not text a person reads. */
const UNREAD_TEXT: Record<string, true> = { script: true, style: true, noscript: true, template: true, head: true }

/**
 * Split a session's pierced document into its frames (the session's root frame and the same-process
 * iframes inside it). User-agent shadow roots (an <input>'s inner editor) are not the page's.
 */
function framesOfDocument(root: Protocol.DOM.Node, rootFrameId: string): Map<string, FrameDom> {
  const frames = new Map<string, FrameDom>()
  const visitDocument = (document: Protocol.DOM.Node, frameId: string): void => {
    let frame = frames.get(frameId)
    if (!frame) {
      frame = { roots: [], elements: [] }
      frames.set(frameId, frame)
    }
    frame.roots.push(document.nodeId)
    for (const child of document.children ?? []) visit(child, frame)
  }
  const visit = (node: Protocol.DOM.Node, frame: FrameDom): void => {
    if (node.nodeType !== 1) return
    frame.elements.push(node)
    for (const shadow of node.shadowRoots ?? []) {
      if (shadow.shadowRootType === 'user-agent') continue
      frame.roots.push(shadow.nodeId)
      for (const child of shadow.children ?? []) visit(child, frame)
    }
    if (node.contentDocument && node.frameId) visitDocument(node.contentDocument, node.frameId)
    for (const child of node.children ?? []) visit(child, frame)
  }
  visitDocument(root, rootFrameId)
  return frames
}

function attribute(node: Protocol.DOM.Node, name: string): string | undefined {
  const attributes = node.attributes ?? []
  for (let index = 0; index + 1 < attributes.length; index += 2) if (attributes[index] === name) return attributes[index + 1]
  return undefined
}

/**
 * text/: the innermost elements whose text contains the query. CDP leaves whitespace-only text nodes
 * out of the DOM tree it sends, so the words of `<b>Hello</b> <i>World</i>` arrive without the space
 * between them: text is compared with every space removed, case ignored.
 */
function textMatches(elements: Protocol.DOM.Node[], wanted: string): number[] {
  const needle = wanted.replace(/\s+/g, '').toLowerCase()
  const texts = new Map<number, string>()
  const textOf = (node: Protocol.DOM.Node): string => {
    if (node.nodeType === 3) return (node.nodeValue ?? '').replace(/\s+/g, '').toLowerCase()
    if (node.nodeType !== 1 || UNREAD_TEXT[node.localName]) return ''
    const known = texts.get(node.nodeId)
    if (known !== undefined) return known
    const text = (node.children ?? []).map(textOf).join('')
    texts.set(node.nodeId, text)
    return text
  }
  const found: number[] = []
  for (const element of elements) {
    if (!textOf(element).includes(needle)) continue
    if ((element.children ?? []).some((child) => child.nodeType === 1 && textOf(child).includes(needle))) continue
    found.push(element.backendNodeId)
  }
  return found
}

const XPATH_FN = `function (args) {
  const result = document.evaluate(args.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
  const found = []
  for (let index = 0; index < result.snapshotLength; index++) {
    let node = result.snapshotItem(index)
    if (node.nodeType === Node.ATTRIBUTE_NODE) node = node.ownerElement
    else if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement
    if (node && !found.includes(node)) found.push(node)
  }
  return found
}`

/** Every element of every readable frame `query` matches, frames in tree order, each frame's in document order. */
async function hitsOf(probe: PageProbe, query: ParsedQuery): Promise<{ hits: Hit[]; frames: FrameEntry[]; unreadable: UnreadableFrame[] }> {
  const { frames, unreadable } = await probe.frames.list()
  const hits: Hit[] = []
  if (query.kind === 'role' || query.kind === 'aria' || query.kind === 'label') {
    const enabled = new Set<ICDPSession>()
    for (const frame of frames) {
      if (!enabled.has(frame.cdp)) {
        await withDeadline(frame.cdp.send('Accessibility.enable'), CDP_TIMEOUT_MS, 'enabling the Accessibility domain')
        enabled.add(frame.cdp)
      }
      const { nodes } = await withDeadline(
        frame.cdp.send('Accessibility.getFullAXTree', { frameId: frame.frameId }),
        CDP_TIMEOUT_MS,
        `reading the accessibility tree of ${frame.depth === 0 ? 'the page' : `the iframe ${frame.url}`}`,
      )
      const seen = new Set<number>()
      for (const node of nodes) {
        if (!axMatches(query, node) || node.backendDOMNodeId === undefined || seen.has(node.backendDOMNodeId)) continue
        seen.add(node.backendDOMNodeId)
        hits.push({ frame, backendNodeId: node.backendDOMNodeId })
      }
    }
    return { hits, frames, unreadable }
  }
  if (query.kind === 'xpath') {
    for (const frame of frames) {
      let ids: Array<number | null>
      try {
        ids = await frame.world.nodesReturnedBy([], XPATH_FN, { args: { xpath: query.value }, what: 'evaluating the XPath' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/evaluate|XPath/i.test(message) && !/did not respond/.test(message)) {
          throw new ModelFacingError(`find(${quote(query.source, 200)}): Chrome cannot evaluate this XPath: ${message.replace(/^evaluating the XPath: /, '')}`)
        }
        throw error
      }
      for (const id of ids) if (id !== null) hits.push({ frame, backendNodeId: id })
    }
    return { hits, frames, unreadable }
  }
  // DOM handlers: one pierced document per renderer session covers its same-process iframes.
  const sessions = new Map<ICDPSession, Map<string, FrameDom>>()
  for (const frame of frames) {
    let doms = sessions.get(frame.cdp)
    if (!doms) {
      await withDeadline(frame.cdp.send('DOM.enable'), CDP_TIMEOUT_MS, 'enabling the DOM domain')
      const { root } = await withDeadline(
        frame.cdp.send('DOM.getDocument', { depth: -1, pierce: true }),
        CDP_TIMEOUT_MS,
        `reading the document of ${frame.depth === 0 ? 'the page' : `the iframe ${frame.url}`} (DOM.getDocument)`,
      )
      doms = framesOfDocument(root, frame.sessionRootId)
      sessions.set(frame.cdp, doms)
    }
    const dom = doms.get(frame.frameId)
    if (!dom) continue
    const wanted = query.value ?? ''
    if (query.kind === 'text') {
      for (const id of textMatches(dom.elements, wanted)) hits.push({ frame, backendNodeId: id })
      continue
    }
    if (query.kind === 'pierce') {
      const found = new Set<number>()
      for (const rootId of dom.roots) {
        let nodeIds: number[]
        try {
          ;({ nodeIds } = await withDeadline(frame.cdp.send('DOM.querySelectorAll', { nodeId: rootId, selector: wanted }), CDP_TIMEOUT_MS, 'matching the CSS selector'))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/DOM Error|selector/i.test(message)) throw new ModelFacingError(`find(${quote(query.source, 200)}): ${quote(wanted, 120)} is not a valid CSS selector.`)
          throw error
        }
        for (const nodeId of nodeIds) found.add(nodeId)
      }
      // In document order: the elements of the document and of every shadow root, in tree order.
      for (const element of dom.elements) if (found.has(element.nodeId)) hits.push({ frame, backendNodeId: element.backendNodeId })
      continue
    }
    const needle = loose(wanted)
    for (const element of dom.elements) {
      const value =
        query.kind === 'testid' ? attribute(element, 'data-testid') : attribute(element, query.kind)
      if (value === undefined) continue
      if (query.kind === 'testid' ? value === wanted : loose(value).includes(needle)) hits.push({ frame, backendNodeId: element.backendNodeId })
    }
  }
  return { hits, frames, unreadable }
}

// ---------------------------------------------------------------------------------------------
// What each match is and where it is
// ---------------------------------------------------------------------------------------------

/** One match as find() reports it. */
export interface QueryMatch {
  ref?: number
  role: string
  name: string
  /** `in view`, `partly in view`, `covered by …`, `above`, `below`, `left`, `right`, `hidden`. */
  visibility: string
  /** Where it is drawn, in CSS px of the main viewport (0,0: its top-left corner); absent when it has no layout box. */
  box?: { x: number; y: number; width: number; height: number }
  /** The ref of the iframe it is in, when observe() lists that iframe. */
  iframe?: number
}

export interface QueryResult {
  text: string
  /** Every element the query matched, shown or not. */
  count: number
  /** The matches shown (the first `limit`). */
  matches: QueryMatch[]
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right <= x || bottom <= y ? null : { x, y, width: right - x, height: bottom - y }
}

/** The part of the main viewport that shows `frameId`'s content: the viewport cut to every iframe around it. */
async function visibleAreaOf(probe: PageProbe, frameId: string, viewport: Rect): Promise<Rect | null> {
  let area: Rect | null = viewport
  for (let id: string | null = frameId; id !== null && id !== probe.frames.mainFrameId() && area; id = (await probe.frames.handle(id)).parentId) {
    const box = await probe.frames.box(id)
    area = intersect(area, { x: box.x, y: box.y, width: box.width * box.scale, height: box.height * box.scale })
  }
  return area
}

/** Where an element no observation lists is, measured: its box, and whether a click at its centre would reach it. */
async function measure(probe: PageProbe, hit: Hit, viewport: Rect): Promise<{ visibility: string; box?: Rect }> {
  let rects: Rect[]
  try {
    rects = await probe.frames.contentRects(hit.frame, hit.backendNodeId, 'measuring a matched element (DOM.getContentQuads)')
  } catch (error) {
    if (isNodeGoneError(error)) return { visibility: 'gone (removed while it was measured)' }
    if (/Could not compute content quads/i.test(error instanceof Error ? error.message : String(error))) return { visibility: 'hidden (no layout box: not rendered)' }
    throw error
  }
  if (rects.length === 0) return { visibility: 'hidden (no layout box: not rendered)' }
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const box = {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(Math.max(...rects.map((rect) => rect.x + rect.width)) - left),
    height: Math.round(Math.max(...rects.map((rect) => rect.y + rect.height)) - top),
  }
  const area = await visibleAreaOf(probe, hit.frame.frameId, viewport)
  const shown = area ? rects.map((rect) => intersect(rect, area)).filter((rect): rect is Rect => rect !== null) : []
  if (shown.length === 0) {
    // Screens from the top of the viewport, as observe() counts them.
    const screens = viewport.height > 0 ? Math.round((Math.abs(box.y) / viewport.height) * 10) / 10 : undefined
    if (area && box.y + box.height <= area.y) return { visibility: `above, ${screens ?? '?'} screens up (scroll up)`, box }
    if (area && box.y >= area.y + area.height) return { visibility: `below, ${screens ?? '?'} screens down (scroll down)`, box }
    if (area && box.x + box.width <= area.x) return { visibility: 'off to the left (scroll horizontally)', box }
    if (area && box.x >= area.x + area.width) return { visibility: 'off to the right (scroll horizontally)', box }
    return { visibility: 'cut off by a container around it (act.scrollTo(ref) brings it into view when that container scrolls)', box }
  }
  const shownArea = shown.reduce((sum, rect) => sum + rect.width * rect.height, 0)
  const fullArea = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0)
  const largest = shown.reduce((best, rect) => (rect.width * rect.height > best.width * best.height ? rect : best))
  const where = shownArea >= fullArea - 1 ? 'in view' : 'partly in view'
  // Would a click at the centre of its visible part reach it? The hit test runs in the element's own session.
  const centre = { x: largest.x + largest.width / 2, y: largest.y + largest.height / 2 }
  const origin = await probe.frames.sessionBox(hit.frame)
  const x = Math.round((centre.x - origin.x) / origin.scale)
  const y = Math.round((centre.y - origin.y) / origin.scale)
  const located = await withDeadline(
    hit.frame.cdp.send('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }),
    CDP_TIMEOUT_MS,
    'hit-testing a matched element (DOM.getNodeForLocation)',
  ).catch((error: unknown) => {
    if (/No node found/i.test(error instanceof Error ? error.message : String(error))) return null
    throw error
  })
  if (!located || located.backendNodeId === hit.backendNodeId || (located.frameId !== undefined && located.frameId !== hit.frame.frameId)) return { visibility: where, box }
  // The point in the element's own frame's viewport, where REACHES_TARGET_FN measures slotted text.
  const frameBox = await probe.frames.box(hit.frame.frameId)
  const reaches = await hit.frame.world.callFunctionOnNodes<boolean | null>([hit.backendNodeId, located.backendNodeId], REACHES_TARGET_FN, {
    args: { x: (centre.x - frameBox.x) / frameBox.scale, y: (centre.y - frameBox.y) / frameBox.scale },
    what: 'checking what a click on a matched element would hit',
  })
  if (reaches !== false) return { visibility: where, box }
  const { node } = await withDeadline(hit.frame.cdp.send('DOM.describeNode', { backendNodeId: located.backendNodeId }), CDP_TIMEOUT_MS, 'describing what covers a matched element')
  const id = attribute(node, 'id')
  const className = attribute(node, 'class')?.trim().split(/\s+/)[0]
  const cover = `${node.localName || node.nodeName.toLowerCase()}${id ? `#${id}` : ''}${className ? `.${className}` : ''}`
  return { visibility: `${where}, but covered by ${cover} at its centre — a click would hit that instead`, box }
}

/**
 * What a matched element is, read the way act reads it before acting: its own accessibility node (role,
 * name, states; null when Chrome lists none, as for an element that is not rendered) and its tag.
 */
async function identify(hit: Hit): Promise<{ ax: Protocol.Accessibility.AXNode | null; tag: string; role: string; name: string }> {
  const { nodes } = await withDeadline(
    hit.frame.cdp.send('Accessibility.getPartialAXTree', { backendNodeId: hit.backendNodeId, fetchRelatives: false }),
    CDP_TIMEOUT_MS,
    'reading the accessibility node of a matched element',
  )
  const ax = nodes.find((node) => node.backendDOMNodeId === hit.backendNodeId) ?? null
  const { node } = await withDeadline(hit.frame.cdp.send('DOM.describeNode', { backendNodeId: hit.backendNodeId }), CDP_TIMEOUT_MS, 'describing a matched element')
  const tag = node.localName || node.nodeName.toLowerCase()
  const role = ax && typeof ax.role?.value === 'string' && ax.role.value !== '' ? ax.role.value : tag
  return { ax, tag, role, name: ax && typeof ax.name?.value === 'string' ? ax.name.value : '' }
}

function boxText(box: Rect | undefined): string {
  return box ? ` · box x=${box.x} y=${box.y} w=${box.width} h=${box.height}` : ''
}

// ---------------------------------------------------------------------------------------------
// Running a query
// ---------------------------------------------------------------------------------------------

export interface QueryDeps {
  probes: PageProbes
  context: BrowserContext
}

/** The observation a query's refs are placed in; refused while a native dialog freezes the page. */
async function observed(deps: QueryDeps, page: Page, remember: boolean): Promise<{ probe: PageProbe; observation: Observation }> {
  const probe = await deps.probes.get(page)
  const dialog = probe.dialogs.current()
  if (dialog) {
    throw new ModelFacingError(
      `A native ${dialog.type}("${dialog.message}") dialog is open and freezes the page, so it cannot be searched. Handle it first, like a person would: act.dialog.accept() or act.dialog.dismiss().`,
    )
  }
  return { probe, observation: await deps.probes.observe(page, deps.context, {}, remember) }
}

/** The ref of a match: observe()'s when it lists the element, else one adopted for it. */
function refOf(probe: PageProbe, observation: Observation, hit: Hit, binding: { role: string; name: string }): number | null {
  const documentId = observation.documentId
  if (documentId === undefined) return null
  return probe.registry.adopt(probe.targetId, documentId, {
    role: binding.role,
    name: binding.name,
    nodeKey: `${hit.frame.frameId}:${hit.backendNodeId}`,
    frameId: hit.frame.frameId,
    frameDocumentId: hit.frame.loaderId,
    backendNodeId: hit.backendNodeId,
  })
}

/**
 * `find('role/…')` and the other handlers: every match, the first `limit` as lines with refs, states,
 * where each one is and its box.
 */
export async function runQuery(deps: QueryDeps, page: Page, query: ParsedQuery, options: { limit?: number } = {}): Promise<QueryResult> {
  const limit = options.limit ?? DEFAULT_LIMIT
  const { probe, observation } = await observed(deps, page, true)
  const { hits, frames, unreadable } = await hitsOf(probe, query)
  const metrics = await withDeadline(probe.cdp.send('Page.getLayoutMetrics'), CDP_TIMEOUT_MS, 'reading the viewport size (Page.getLayoutMetrics)')
  const viewport = { x: 0, y: 0, width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight }
  const iframeRefOf = new Map(observation.elements.flatMap((element) => (element.frame ? [[element.frame.frameId, element.ref] as const] : [])))
  const lines: string[] = []
  const matches: QueryMatch[] = []
  for (const hit of hits.slice(0, limit)) {
    const listed: ObservedElement | undefined = observation.elements.find(
      (element) => element.frameId === hit.frame.frameId && element.backendNodeId === hit.backendNodeId,
    )
    const geometry = await measure(probe, hit, viewport)
    const iframe = iframeRefOf.get(hit.frame.frameId)
    const inIframe = iframe !== undefined ? ` · in iframe [${iframe}]` : ''
    if (listed) {
      lines.push(`  ${describeElement({ ...listed, isNew: false }, observation)} — ${describeWhere(listed, observation)}${boxText(geometry.box)}${listed.region ? ` · ${listed.region}` : ''}${inIframe}`)
      matches.push({ ref: listed.ref, role: listed.role, name: listed.name, visibility: describeWhere(listed, observation), ...(geometry.box ? { box: geometry.box } : {}), ...(iframe !== undefined ? { iframe } : {}) })
      continue
    }
    const { ax, tag, role, name } = await identify(hit)
    const inTree = ax !== null && !ax.ignored
    const ref = refOf(probe, observation, hit, { role, name })
    const states = ax ? formatAxStates(axStatesFromNode(ax), role.toLowerCase()) : ''
    const value = ax && typeof ax.value?.value === 'string' && ax.value.value !== '' ? ` = ${quote(ax.value.value, 60)}` : ''
    const visibility = inTree || !geometry.visibility.startsWith('in view') ? geometry.visibility : `${geometry.visibility} (not in the accessibility tree: assistive technology skips it)`
    const head = ref === null ? `(no ref: the page changed while it was searched — find again) ${role}` : `[${ref}] ${role}`
    lines.push(`  ${head}${role !== tag ? ` <${tag}>` : ''}${name ? ` ${quote(name)}` : ''}${states}${value} — ${visibility}${boxText(geometry.box)}${inIframe}`)
    matches.push({ ...(ref !== null ? { ref } : {}), role, name, visibility, ...(geometry.box ? { box: geometry.box } : {}), ...(iframe !== undefined ? { iframe } : {}) })
  }
  const searched = `${frames.length} frame${frames.length === 1 ? '' : 's'} searched`
  const notSearched =
    unreadable.length > 0
      ? `\n  Not searched: ${unreadable.map((frame) => `the iframe ${frame.url || frame.name || frame.frameId} (${frame.reason})`).join('; ')}.`
      : ''
  let text: string
  if (hits.length === 0) {
    const why =
      query.kind === 'role' || query.kind === 'aria' || query.kind === 'label'
        ? ' (the accessibility tree: an element that is hidden — display:none, the hidden attribute, a closed <dialog> — is not in it)'
        : ''
    text = `No element matches ${quote(query.source, 200)} on this page${why} — ${searched}.${notSearched}`
  } else {
    const more = hits.length > lines.length ? [`  … ${hits.length - lines.length} more not shown (find(${quote(query.source, 200)}, { limit: ${hits.length} }) lists them)`] : []
    text = [`${hits.length} match${hits.length === 1 ? '' : 'es'} for ${quote(query.source, 200)} (${searched}):`, ...lines, ...more].join('\n') + notSearched
  }
  return { text, count: hits.length, matches }
}

/** `readPage(fn, { query })`: the ref of the one element the query matches; refused, naming the count, otherwise. */
export async function queryRef(deps: QueryDeps, page: Page, source: string): Promise<number> {
  const query = parseQuery(source)
  if (!query) {
    throw new ModelFacingError(
      `readPage: query ${quote(source, 200)} is not a handler query. Use one of ${HANDLERS.map((kind) => `${kind}/…`).join(', ')} — like role/button[name="Save"] — or find(${quote(source, 200)}) for a word search and then readPage(fn, { ref }).`,
    )
  }
  const { probe, observation } = await observed(deps, page, false)
  const { hits } = await hitsOf(probe, query)
  if (hits.length === 0) throw new ModelFacingError(`readPage: no element matches ${quote(source, 200)} on this page. find(${quote(source, 200)}) says what was searched.`)
  if (hits.length > 1) {
    throw new ModelFacingError(
      `readPage: ${hits.length} elements match ${quote(source, 200)}, and readPage reads one. find(${quote(source, 200)}) lists them with refs: then readPage(fn, { ref }), or narrow the query (role/<role>[name="…" exact]).`,
    )
  }
  const [hit] = hits
  const listed = observation.elements.find((element) => element.frameId === hit.frame.frameId && element.backendNodeId === hit.backendNodeId)
  if (listed) return listed.ref
  const { role, name } = await identify(hit)
  const ref = refOf(probe, observation, hit, { role, name })
  if (ref === null) throw new ModelFacingError(`readPage: the page changed while ${quote(source, 200)} was searched (a frame loaded a new document). Call it again.`)
  return ref
}
