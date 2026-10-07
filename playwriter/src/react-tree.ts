/**
 * react-tree.ts — `react.tree()` and `react.suspense()`: the whole React component tree of a page,
 * and its Suspense boundaries, read from React's fibers. Read-only; nothing installed, nothing
 * reloaded.
 *
 * React keeps its fiber tree on expando properties of DOM nodes (`__reactContainer$…` on each root
 * container, `__reactFiber$…` on each rendered node), which only the page's main world sees. The
 * tree is read the way getReactComponentInfo reads one element's chain (react-source.ts): one
 * `Runtime.callFunctionOn` in the main world on the document (or on the ref's element), which only
 * reads own keys and properties and returns plain data plus the DOM nodes the components render
 * (their refs come from observe()'s registry). React 19 `_debugStack` frames are mapped to source
 * files through the scripts' source maps from Node (`Network.loadNetworkResource`, which the page
 * neither makes nor sees).
 *
 * Without React DevTools' global hook — which must exist before React loads, i.e. an init script,
 * a page modification — React reports no commits, so renders cannot be counted here (see
 * docs: Known limits).
 */

import type { BrowserContext, Page } from '@xmorse/playwright-core'
import util from 'node:util'
import type { ICDPSession } from './cdp-session.js'
import { withDeadline } from './isolated-world.js'
import { quote } from './page-observe.js'
import type { PageProbe, PageProbes } from './page-probe.js'
import { ModelFacingError } from './probe-types.js'
import { REACT_FIBER_READER, cleanSourceFileName, createSymbolicator, jsxSiteFromDebugStack, type Symbolicator } from './react-source-location.js'
import { loadResourceText } from './source-provenance.js'

const CDP_TIMEOUT_MS = 5000
const MAX_SOURCE_BYTES = 40_000_000
/** Components printed by one react.tree() call; the rest are counted, with how to see them. */
const TREE_MAX_SHOWN = 300

/**
 * Page-side helpers shared by both reads (appended to `REACT_FIBER_READER`): the root containers
 * of the document, a fiber's first rendered DOM node, a one-line props summary and a component's
 * debug record. Everything only reads.
 */
const TREE_HELPERS = `
function reactRoots(doc) {
  var roots = []
  var walker = doc.createTreeWalker(doc, 1)
  for (var el = walker.nextNode(); el; el = walker.nextNode()) {
    var key = reactKeyStarting(el, '__reactContainer$')
    var host = key ? el[key] : null
    var root = host && host.stateNode && host.stateNode.current ? host.stateNode.current : null
    if (!root && el._reactRootContainer && el._reactRootContainer._internalRoot) root = el._reactRootContainer._internalRoot.current
    if (root && roots.every(function (r) { return r.fiber !== root })) roots.push({ container: el, fiber: root })
  }
  return roots
}
function reactFirstHost(fiber) {
  var stack = [fiber]
  var steps = 0
  while (stack.length && steps++ < 5000) {
    var f = stack.pop()
    if ((f.tag === 5 || f.tag === 26 || f.tag === 27) && f.stateNode) return f.stateNode
    var children = []
    for (var c = f.child; c; c = c.sibling) children.push(c)
    for (var i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return null
}
function reactShort(v) {
  if (v === null) return 'null'
  var t = typeof v
  if (t === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 39) + '\\u2026' : v)
  if (t === 'number' || t === 'boolean') return String(v)
  if (t === 'bigint') return String(v) + 'n'
  if (t === 'undefined') return 'undefined'
  if (t === 'function') return '\\u0192' + (v.name ? ' ' + v.name : '')
  if (t === 'symbol') return 'symbol'
  if (Array.isArray(v)) return '[' + v.length + ' items]'
  var tag = Object.prototype.toString.call(v)
  if (tag.indexOf('Element]') >= 0) return '<' + String(v.localName || v.nodeName).toLowerCase() + ' element>'
  if (typeof v.$$typeof === 'symbol') return '<' + (reactTypeName(v.type) || 'element') + '>'
  return '{' + Object.keys(v).slice(0, 4).join(', ') + (Object.keys(v).length > 4 ? ', \\u2026' : '') + '}'
}
function reactProps(props) {
  if (!props || typeof props !== 'object') return ''
  var keys = Object.keys(props).filter(function (k) { return k !== 'children' })
  var parts = []
  for (var i = 0; i < keys.length && i < 6; i++) parts.push(keys[i] + ': ' + reactShort(props[keys[i]]))
  if (keys.length > 6) parts.push('+' + (keys.length - 6) + ' more')
  return parts.join(', ')
}
function reactDebug(f) {
  var s = f._debugSource
  if (s && typeof s.fileName === 'string') return { source: { fileName: s.fileName, lineNumber: typeof s.lineNumber === 'number' ? s.lineNumber : null }, stack: null }
  var e = f._debugStack
  if (e && typeof e.stack === 'string') return { source: null, stack: e.stack.split('\\n').slice(0, 14).join('\\n') }
  return { source: null, stack: null }
}
function reactSuspenseState(f) {
  var state = f.memoizedState
  if (state === null || state === undefined) return 'resolved'
  return state.dehydrated ? 'dehydrated' : 'suspended'
}
function reactOwnerName(f) {
  for (var p = f.return; p; p = p.return) if (isCompositeReactFiber(p)) return reactTypeName(p.type) || 'Anonymous'
  return null
}
function reactIsDev(f) {
  return f._debugOwner !== undefined || f._debugStack !== undefined || f._debugSource !== undefined
}
`

/** One component (or Suspense boundary) of the tree, as the page read it. */
interface TreeNode {
  depth: number
  name: string
  key: string | null
  props: string
  /** Set for Suspense boundaries. */
  suspense: 'resolved' | 'suspended' | 'dehydrated' | null
  source: { fileName: string; lineNumber: number | null } | null
  stack: string | null
  /** 1-based index of its first rendered DOM node among the returned nodes; 0 when it renders none. */
  host: number
}

interface TreeRead {
  reactFound: boolean
  dev: boolean
  roots: number
  /** Components above the start (nearest last), when the tree was started at a ref. */
  breadcrumb: string[]
  total: number
  depth: number
  shown: TreeNode[]
  deeper: number
  overCap: number
  /** The walk stopped at this many fibers (a safety bound against a corrupted tree); 0 when it walked them all. */
  truncatedAt: number
}

/** `this`: the document or the ref's element (main world). Returns `[json, ...nodes]`. */
const TREE_FN = `function (opts) {
${REACT_FIBER_READER}
${TREE_HELPERS}
  var nodes = []
  var read = { reactFound: false, dev: false, roots: 0, breadcrumb: [], total: 0, depth: 0, shown: [], deeper: 0, overCap: 0, truncatedAt: 0 }
  var starts = []
  if (this.nodeType === 9) {
    var roots = reactRoots(this)
    read.roots = roots.length
    for (var r = 0; r < roots.length; r++) starts.push(roots[r].fiber)
  } else {
    var found = currentReactFiber(this)
    if (found) {
      var start = found.fiber
      while (start && !isCompositeReactFiber(start) && start.tag !== 3) start = start.return
      if (start && start.tag !== 3) {
        starts.push(start)
        for (var up = start.return; up; up = up.return) if (isCompositeReactFiber(up)) read.breadcrumb.unshift(reactTypeName(up.type) || 'Anonymous')
      } else if (start) starts.push(start)
    }
  }
  read.reactFound = starts.length > 0
  var MAX_FIBERS = 200000
  var visited = 0
  var counts = []
  function shownKind(f) { return isCompositeReactFiber(f) || f.tag === 13 }
  function walk(f, depth, visit) {
    if (visited++ > MAX_FIBERS) { read.truncatedAt = MAX_FIBERS; return }
    var d = depth
    if (shownKind(f)) { d = depth + 1; visit(f, d) }
    for (var c = f.child; c; c = c.sibling) walk(c, d, visit)
  }
  for (var s = 0; s < starts.length; s++) walk(starts[s], 0, function (f, d) {
    counts[d] = (counts[d] || 0) + 1
    read.total++
    if (!read.dev && reactIsDev(f)) read.dev = true
  })
  var depth = opts.depth
  if (depth === null) {
    depth = 0
    var sum = 0
    for (var level = 1; level < counts.length; level++) {
      sum += counts[level] || 0
      if (sum > opts.max && depth > 0) break
      depth = level
    }
  }
  read.depth = depth
  visited = 0
  for (var t = 0; t < starts.length; t++) walk(starts[t], 0, function (f, d) {
    if (d > depth) { read.deeper++; return }
    if (read.shown.length >= opts.max) { read.overCap++; return }
    var debug = reactDebug(f)
    var host = reactFirstHost(f)
    if (host) nodes.push(host)
    read.shown.push({
      depth: d,
      name: f.tag === 13 ? 'Suspense' : reactTypeName(f.type) || 'Anonymous',
      key: f.key === null || f.key === undefined ? null : String(f.key),
      props: reactProps(f.memoizedProps),
      suspense: f.tag === 13 ? reactSuspenseState(f) : null,
      source: debug.source,
      stack: debug.stack,
      host: host ? nodes.length : 0,
    })
  })
  return [JSON.stringify(read)].concat(nodes)
}`

interface SuspenseBoundary {
  owner: string | null
  state: 'resolved' | 'suspended' | 'dehydrated'
  /** The fallback prop, summarised (`<Spinner>`). */
  fallback: string
  source: { fileName: string; lineNumber: number | null } | null
  stack: string | null
  host: number
}

interface SuspenseRead {
  reactFound: boolean
  roots: number
  boundaries: SuspenseBoundary[]
}

const SUSPENSE_FN = `function () {
${REACT_FIBER_READER}
${TREE_HELPERS}
  var nodes = []
  var roots = reactRoots(this)
  var read = { reactFound: roots.length > 0, roots: roots.length, boundaries: [] }
  var visited = 0
  function walk(f) {
    if (visited++ > 200000) return
    if (f.tag === 13) {
      var debug = reactDebug(f)
      var host = reactFirstHost(f)
      if (host) nodes.push(host)
      read.boundaries.push({
        owner: reactOwnerName(f),
        state: reactSuspenseState(f),
        fallback: f.memoizedProps && 'fallback' in f.memoizedProps ? reactShort(f.memoizedProps.fallback) : 'none',
        source: debug.source,
        stack: debug.stack,
        host: host ? nodes.length : 0,
      })
    }
    for (var c = f.child; c; c = c.sibling) walk(c)
  }
  for (var r = 0; r < roots.length; r++) walk(roots[r].fiber)
  return [JSON.stringify(read)].concat(nodes)
}`

/**
 * Runs `fn` in the page's main world on `objectId` and splits its `[json, ...nodes]` answer into the
 * parsed data and the nodes' backend ids.
 */
async function callMainWorld(cdp: ICDPSession, objectId: string, fn: string, args: unknown, objectGroup: string, what: string): Promise<{ json: string; nodeIds: Array<number | null> }> {
  const called = await withDeadline(
    cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: [{ value: args }], returnByValue: false, objectGroup }),
    CDP_TIMEOUT_MS,
    what,
  )
  if (called.exceptionDetails) throw new Error(`${what} threw in the page: ${called.exceptionDetails.exception?.description ?? called.exceptionDetails.text}`)
  if (!called.result.objectId) throw new Error(`${what}: the page returned no array.`)
  const { result: properties } = await withDeadline(cdp.send('Runtime.getProperties', { objectId: called.result.objectId, ownProperties: true }), CDP_TIMEOUT_MS, `${what} (listing the result)`)
  const json = properties.find((property) => property.name === '0')?.value?.value
  if (typeof json !== 'string') throw new Error(`${what}: the page returned no data.`)
  const length = properties.find((property) => property.name === 'length')?.value?.value
  const nodeIds: Array<number | null> = Array.from({ length: typeof length === 'number' ? Math.max(0, length - 1) : 0 }, () => null)
  await Promise.all(
    properties.map(async (property) => {
      const index = /^\d+$/.test(property.name) ? Number(property.name) : 0
      const nodeObject = property.value?.objectId
      if (index === 0 || property.value?.subtype !== 'node' || !nodeObject) return
      const described = await withDeadline(cdp.send('DOM.describeNode', { objectId: nodeObject }), CDP_TIMEOUT_MS, `${what} (identifying node ${index})`)
      nodeIds[index - 1] = described.node.backendNodeId
    }),
  )
  return { json, nodeIds }
}

/**
 * The object a read starts from, in the main world: the ref's element, or the document. Released
 * with `objectGroup`.
 */
async function startObject(probes: PageProbes, page: Page, probe: PageProbe, ref: number | string | undefined, objectGroup: string): Promise<string> {
  if (ref !== undefined) {
    const element = await probes.element(ref)
    if (element.page !== page) throw new ModelFacingError(`[${element.target.ref}] is in another tab; react.tree() reads the tab it is given (page option) or the controlled one.`)
    if (element.frame.frameId !== probe.frames.mainFrameId()) {
      throw new ModelFacingError(`[${element.target.ref}] is inside an iframe; react.tree() reads React roots of the top document only.`)
    }
    // No executionContextId: the main world, the only realm that sees React's expandos.
    const resolved = await withDeadline(probe.cdp.send('DOM.resolveNode', { backendNodeId: element.target.backendNodeId, objectGroup }), CDP_TIMEOUT_MS, `resolving [${element.target.ref}]`)
    if (!resolved.object.objectId) throw new ModelFacingError(`[${element.target.ref}] could not be resolved in the page. observe() again.`)
    return resolved.object.objectId
  }
  const evaluated = await withDeadline(
    probe.cdp.send('Runtime.evaluate', { expression: 'document', objectGroup, throwOnSideEffect: true }),
    CDP_TIMEOUT_MS,
    "reading the page's document",
  )
  if (!evaluated.result.objectId) throw new Error("The page's main world returned no document object.")
  return evaluated.result.objectId
}

/** `src/App.tsx:12` for a component's debug record, or null when the build carries none / it cannot be mapped. */
async function sourceOf(
  record: { source: { fileName: string; lineNumber: number | null } | null; stack: string | null },
  symbolicate: Symbolicator,
): Promise<{ text: string | null; problem: string | null }> {
  if (record.source) return { text: `${cleanSourceFileName(record.source.fileName)}${record.source.lineNumber !== null ? `:${record.source.lineNumber}` : ''}`, problem: null }
  const site = record.stack ? jsxSiteFromDebugStack(record.stack) : undefined
  if (!site) return { text: null, problem: null }
  const mapped = await symbolicate(site)
  if (mapped.ok) return { text: `${cleanSourceFileName(mapped.fileName)}:${mapped.line}`, problem: null }
  if (mapped.sourceMap === 'none') return { text: `${cleanSourceFileName(site.url)}:${site.line}`, problem: null }
  return { text: `${cleanSourceFileName(site.url)}:${site.line}`, problem: mapped.error }
}

/** For each host (null: none), the index of the first candidate inside it, or -1. Runs in the isolated world. */
const FIRST_INSIDE_FN = `function (args) {
  var nodes = Array.prototype.slice.call(arguments, 1)
  var hosts = nodes.slice(0, args.hosts)
  var candidates = nodes.slice(args.hosts)
  return hosts.map(function (host) {
    if (!host) return -1
    for (var i = 0; i < candidates.length; i++) if (candidates[i] && host.contains(candidates[i])) return i
    return -1
  })
}`

/** Where a component is among the refs: its own element's ref, or the first listed element inside it. */
interface HostPlace {
  ref: number
  /** `[12] article "Hub"` (the element it renders) or `contains [3] button "Buy"` (the first one inside it). */
  text: string
}

/**
 * Places the DOM node each component renders (`hosts`: 1-based indexes into `nodeIds`, 0 = none)
 * among the refs: the node's own live ref, else the first element of the tab's last observation
 * (observe()'s order) that lies inside it. Null when neither exists.
 */
async function placeHosts(probes: PageProbes, probe: PageProbe, nodeIds: Array<number | null>, hosts: number[]): Promise<Array<HostPlace | null>> {
  const mainFrame = probe.frames.mainFrameId()
  const nodeOf = (host: number): number | null => (host > 0 ? (nodeIds[host - 1] ?? null) : null)
  const placed = hosts.map((host): HostPlace | null => {
    const nodeId = nodeOf(host)
    const target = nodeId === null ? null : probes.registry.refFor(probe.targetId, mainFrame, nodeId)
    if (!target || !probes.registry.resolve(target.ref).ok) return null
    return { ref: target.ref, text: `[${target.ref}] ${target.role}${target.name ? ` ${quote(target.name, 60)}` : ''}` }
  })
  const candidates = (probe.lastFullObservation?.elements ?? []).filter((element) => element.frameId === mainFrame && probes.registry.resolve(element.ref).ok)
  const missing = hosts.flatMap((host, index) => {
    const nodeId = nodeOf(host)
    return placed[index] === null && nodeId !== null ? [{ index, nodeId }] : []
  })
  if (missing.length === 0 || candidates.length === 0) return placed
  const firsts = await probe.frames.main.world.callFunctionOnNodes<number[]>(
    [...missing.map((entry) => entry.nodeId), ...candidates.map((element) => element.backendNodeId)],
    FIRST_INSIDE_FN,
    { args: { hosts: missing.length }, what: 'placing React components among the refs' },
  )
  missing.forEach(({ index }, position) => {
    const element = candidates[firsts[position]]
    if (element) placed[index] = { ref: element.ref, text: `contains [${element.ref}] ${element.role}${element.name ? ` ${quote(element.name, 60)}` : ''}` }
  })
  return placed
}

function quiet<T extends object>(value: T, summary: string): T {
  Object.defineProperty(value, util.inspect.custom, { value: () => summary, enumerable: false })
  return value
}

export interface ReactDeps {
  probes: PageProbes
  context: BrowserContext
  currentPage: () => Page
  print: (text: string) => void
}

export interface ReactTreeResult {
  roots: number
  components: number
  depth: number
  shown: Array<{ depth: number; name: string; key: string | null; props: string; source: string | null; ref: number | null; suspense: string | null }>
  text: string
}

function checkOptions(call: string, options: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (options === undefined) return {}
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new ModelFacingError(`${call} takes an options object ({ ${allowed.join(', ')} }). Nothing was run.`)
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new ModelFacingError(`${call} does not take ${unknown.map((key) => `\`${key}\``).join(', ')}; its options are { ${allowed.join(', ')} }. Nothing was run.`)
  return Object.fromEntries(Object.entries(options))
}

async function tree(deps: ReactDeps, options: unknown): Promise<ReactTreeResult> {
  const opts = checkOptions('react.tree', options, ['ref', 'depth', 'page'])
  const ref = opts.ref
  if (ref !== undefined && typeof ref !== 'number' && typeof ref !== 'string') throw new ModelFacingError('react.tree: `ref` is a ref from observe(), like 12. Nothing was run.')
  const depth = opts.depth
  if (depth !== undefined && (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1)) throw new ModelFacingError('react.tree: `depth` is a whole number of component levels, 1 or more. Nothing was run.')
  const page = opts.page === undefined ? deps.currentPage() : deps.context.pages().find((candidate) => candidate === opts.page && !candidate.isClosed())
  if (!page) throw new ModelFacingError('react.tree: `page` must be an open tab of this session (state.page or one of context.pages()). Nothing was run.')
  const probe = await deps.probes.get(page)
  const dialog = probe.dialogs.current()
  if (dialog?.handling === 'agent') throw new ModelFacingError(`react.tree: a native ${dialog.type} dialog freezes the page. Answer it first (act.dialog.accept() / act.dialog.dismiss()).`)
  const objectGroup = `playwriter-react-tree-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let read: TreeRead
  let nodeIds: Array<number | null>
  try {
    const start = await startObject(deps.probes, page, probe, ref === undefined ? undefined : ref, objectGroup)
    const answer = await callMainWorld(probe.cdp, start, TREE_FN, { depth: depth ?? null, max: TREE_MAX_SHOWN }, objectGroup, 'reading the React component tree')
    read = JSON.parse(answer.json)
    nodeIds = answer.nodeIds
  } finally {
    await withDeadline(probe.cdp.send('Runtime.releaseObjectGroup', { objectGroup }), CDP_TIMEOUT_MS, 'releasing the React tree objects').catch(() => {})
  }
  const where = ref === undefined ? page.url() : `[${String(ref).replace(/^\[|\]$/g, '')}]`
  if (!read.reactFound) {
    const text =
      ref === undefined
        ? `REACT   no React root in ${where}: no element carries React's root marker (__reactContainer$, or _reactRootContainer for React ≤17). The page does not use React in its top document, or React has not rendered yet.`
        : `REACT   ${where} was not rendered by React (it carries no React fiber).`
    deps.print(text)
    return quiet({ roots: 0, components: 0, depth: 0, shown: [], text }, '[react.tree() — printed above]')
  }
  const symbolicate = createSymbolicator((url) => loadResourceText({ cdp: probe.cdp, frameId: probe.frames.mainFrameId(), url, maxBytes: MAX_SOURCE_BYTES, timeoutMs: CDP_TIMEOUT_MS }))
  const problems = new Set<string>()
  const places = await placeHosts(deps.probes, probe, nodeIds, read.shown.map((node) => node.host))
  const shown = await Promise.all(
    read.shown.map(async (node, index) => {
      const source = await sourceOf(node, symbolicate)
      if (source.problem) problems.add(source.problem)
      return { node, source: source.text, place: places[index] }
    }),
  )
  const lines: string[] = []
  const scope = ref === undefined ? `${read.roots} root${read.roots === 1 ? '' : 's'} in ${where}` : `the component that rendered ${where}${read.breadcrumb.length ? ` (inside ${read.breadcrumb.slice(-6).join(' › ')})` : ''}`
  lines.push(
    `REACT TREE  ${scope} — ${read.total} component${read.total === 1 ? '' : 's'}` +
      `${read.dev ? '' : ' — a production build: names are as the bundle has them (often minified) and there are no source locations'}` +
      (probe.lastFullObservation ? '' : ' — observe() first to see refs next to the components'),
  )
  // A ref is printed where it changes: a wrapper whose first control is its parent's says nothing new.
  const refAtDepth: Array<number | undefined> = []
  for (const { node, source, place } of shown) {
    const inherited = refAtDepth.slice(0, node.depth).findLast((value) => value !== undefined)
    refAtDepth[node.depth] = place?.ref
    refAtDepth.length = node.depth + 1
    const suffix = place && (place.ref !== inherited || !place.text.startsWith('contains')) ? ` → ${place.text}` : ''
    const head = `${'  '.repeat(node.depth)}${node.suspense ? `Suspense (${node.suspense === 'suspended' ? 'SUSPENDED: showing its fallback' : node.suspense === 'dehydrated' ? 'dehydrated: server HTML not hydrated yet' : 'resolved'})` : node.name}`
    lines.push(`${head}${node.key !== null ? ` key=${JSON.stringify(node.key)}` : ''}${node.props ? ` {${node.props}}` : ''}${source ? `  ${source}` : ''}${suffix}`)
  }
  if (read.deeper > 0) lines.push(`(+${read.deeper} components deeper than level ${read.depth} — react.tree({ ref }) on an element of one part, or react.tree({ depth: ${read.depth + 2} }))`)
  if (read.overCap > 0) lines.push(`(+${read.overCap} more components at levels 1–${read.depth} not printed: ${TREE_MAX_SHOWN} is the most one call prints — react.tree({ ref }) on an element of one part)`)
  if (read.truncatedAt > 0) lines.push(`(the walk stopped after ${read.truncatedAt} fibers; the counts above are lower bounds)`)
  for (const problem of problems) lines.push(`(source locations shown as served positions: ${problem})`)
  const text = lines.join('\n')
  deps.print(text)
  return quiet(
    {
      roots: read.roots,
      components: read.total,
      depth: read.depth,
      shown: shown.map(({ node, source, place }) => ({ depth: node.depth, name: node.name, key: node.key, props: node.props, source, ref: place?.ref ?? null, suspense: node.suspense })),
      text,
    },
    '[react.tree() — printed above]',
  )
}

export interface ReactSuspenseResult {
  boundaries: Array<{ owner: string | null; state: string; fallback: string; source: string | null; ref: number | null }>
  text: string
}

async function suspense(deps: ReactDeps, options: unknown): Promise<ReactSuspenseResult> {
  const opts = checkOptions('react.suspense', options, ['page'])
  const page = opts.page === undefined ? deps.currentPage() : deps.context.pages().find((candidate) => candidate === opts.page && !candidate.isClosed())
  if (!page) throw new ModelFacingError('react.suspense: `page` must be an open tab of this session (state.page or one of context.pages()). Nothing was run.')
  const probe = await deps.probes.get(page)
  const dialog = probe.dialogs.current()
  if (dialog?.handling === 'agent') throw new ModelFacingError(`react.suspense: a native ${dialog.type} dialog freezes the page. Answer it first (act.dialog.accept() / act.dialog.dismiss()).`)
  const objectGroup = `playwriter-react-suspense-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let read: SuspenseRead
  let nodeIds: Array<number | null>
  try {
    const start = await startObject(deps.probes, page, probe, undefined, objectGroup)
    const answer = await callMainWorld(probe.cdp, start, SUSPENSE_FN, null, objectGroup, 'reading the React Suspense boundaries')
    read = JSON.parse(answer.json)
    nodeIds = answer.nodeIds
  } finally {
    await withDeadline(probe.cdp.send('Runtime.releaseObjectGroup', { objectGroup }), CDP_TIMEOUT_MS, 'releasing the React Suspense objects').catch(() => {})
  }
  if (!read.reactFound) {
    const text = `REACT   no React root in ${page.url()}: no element carries React's root marker. The page does not use React in its top document, or React has not rendered yet.`
    deps.print(text)
    return quiet({ boundaries: [], text }, '[react.suspense() — printed above]')
  }
  const symbolicate = createSymbolicator((url) => loadResourceText({ cdp: probe.cdp, frameId: probe.frames.mainFrameId(), url, maxBytes: MAX_SOURCE_BYTES, timeoutMs: CDP_TIMEOUT_MS }))
  const places = await placeHosts(deps.probes, probe, nodeIds, read.boundaries.map((boundary) => boundary.host))
  const boundaries = await Promise.all(
    read.boundaries.map(async (boundary, index) => ({ boundary, source: (await sourceOf(boundary, symbolicate)).text, place: places[index] })),
  )
  const suspended = read.boundaries.filter((boundary) => boundary.state !== 'resolved').length
  const lines = [
    `REACT SUSPENSE  ${read.boundaries.length} boundar${read.boundaries.length === 1 ? 'y' : 'ies'} in ${read.roots} root${read.roots === 1 ? '' : 's'} — ${suspended} not showing their content`,
    ...boundaries.map(({ boundary, source, place }) => {
      const state =
        boundary.state === 'suspended'
          ? `SUSPENDED: showing its fallback ${boundary.fallback}`
          : boundary.state === 'dehydrated'
            ? 'dehydrated: the server HTML is shown and not hydrated yet'
            : `resolved: showing its content (fallback ${boundary.fallback})`
      return `  Suspense${boundary.owner ? ` in ${boundary.owner}` : ''} — ${state}${source ? `  ${source}` : ''}${place ? ` → ${place.text}` : ''}`
    }),
  ]
  const text = lines.join('\n')
  deps.print(text)
  return quiet(
    {
      boundaries: boundaries.map(({ boundary, source, place }) => ({ owner: boundary.owner, state: boundary.state, fallback: boundary.fallback, source, ref: place?.ref ?? null })),
      text,
    },
    '[react.suspense() — printed above]',
  )
}

export interface ReactApi {
  tree: (options?: { ref?: number | string; depth?: number; page?: Page }) => Promise<ReactTreeResult>
  suspense: (options?: { page?: Page }) => Promise<ReactSuspenseResult>
}

/** The `react` sandbox global. */
export function createReactGlobals(deps: ReactDeps): ReactApi {
  return {
    tree: (options) => tree(deps, options),
    suspense: (options) => suspense(deps, options),
  }
}
