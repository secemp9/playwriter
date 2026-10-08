/**
 * element-explain.ts — "what is this element, and what will interacting with it do?"
 *
 * A model without vision sees `button "Send"` and has to guess what clicking it does.
 * This answers from the page's own code, read-only:
 *   - tag, attributes, a label, the browser's default action (link / form submit);
 *   - the React component chain (nearest first) with each component's definition site;
 *   - every handler that can run when the element is used: React `on*` props on the element,
 *     its wrapping components and its host ancestors, and native listeners
 *     (`DOMDebugger.getEventListeners`) on the element, its descendants (the click lands on
 *     them) and every node of the composed event path (assigned slots, shadow roots, hosts,
 *     `document`, `window`) — so a listener delegated to `#app` or `body` is found;
 *   - for each handler: its name, original `file:line` (through the script's sourcemap when
 *     there is one), a short code frame, and a Babel summary of what it does (requests,
 *     navigations, state setters, preventDefault), including what the functions it calls do.
 *
 * Calls are followed at RUN TIME, not by name: a callee is evaluated against the live closure
 * (`[[Scopes]]` of the function object, `Runtime.getProperties`), bound functions are unwrapped
 * through `[[TargetFunction]]`/`[[BoundThis]]`/`[[BoundArgs]]`, and the function found is
 * located through its `[[FunctionLocation]]` — in any script, so an imported helper in another
 * module is followed. A visited set ends recursion; nothing is cut by depth. Platform APIs
 * (`fetch`, `history.pushState`, …) and framework state setters are recognised by Babel scope
 * bindings (a global reference, an `useState`-style array pattern initialised from an import),
 * never by names. Library code is what the sourcemap puts on its `ignoreList`
 * (`x_google_ignoreList`): a library listener (a framework's event dispatcher) is followed
 * through the values it reads (`this`, the event, its closure, properties of page objects —
 * never a getter) to the page handler it dispatches to; a call from page code into a library is
 * reported at the call site with the platform effect the library performs.
 *
 * Nothing is written to the page. React's fiber expandos and framework expandos live on
 * main-world DOM wrappers, so they are READ in the main world through `DOM.resolveNode` (no
 * executionContextId) + `Runtime.callFunctionOn` with an anonymous function built on the
 * shared fiber reader (react-source-location.ts): no global, no listener, no element is created.
 * `[[FunctionLocation]]` and `[[Scopes]]` are present without the Debugger domain; only the
 * scriptId → URL/sourcemap mapping needs `Debugger.scriptParsed`, so the Debugger is enabled
 * lazily through the session's one Debugger owner (`debuggerDomainFor`, cdp-domains.ts): enabled
 * once, never disabled, with skip-all-pauses on. Explain never takes a pause lease.
 *
 * Scripts and sourcemaps are fetched with `Network.loadNetworkResource` (`loadResourceText`):
 * no `Network.requestWillBeSent`, no Playwright `request` event. A failed load is a note naming
 * the URL and the cause, never a page-unresponsive error. Parsed scripts and sources are cached
 * per page (served scripts by scriptId + content hash) and parsed whole, whatever their size.
 */

import type { Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import _traverse from '@babel/traverse'
import type { NodePath } from '@babel/traverse'
import { parse } from '@babel/parser'
import type { ParserPlugin } from '@babel/parser'
import { AnyMap, isIgnored, sourceContentFor } from '@jridgewell/trace-mapping'
import type { TraceMap } from '@jridgewell/trace-mapping'
import type { ICDPSession } from './cdp-session.js'
import type { PageFrames } from './page-frames.js'
import { debuggerDomainFor, type DebuggerDomain } from './cdp-domains.js'
import { ModelFacingError, type JsDialogState } from './probe-types.js'
import { PageUnresponsiveError, withDeadline } from './isolated-world.js'
import type { ParsedFile } from './static-analysis.js'
import { ResourceLoadError, loadResourceText, makeSourceMapResolver, renderCodeFrame } from './source-provenance.js'
import type { SourceMapResolver } from './source-provenance.js'
import {
  REACT_FIBER_READER,
  formatReactSourceLocation,
  locateReactSource,
  type FiberHandlerProp,
  type FiberReadResult,
} from './react-source-location.js'

// @babel/traverse is CJS with a double default under ESM interop (static-analysis.ts handles the same).
const nestedTraverse: unknown = Reflect.get(_traverse, 'default')
// Only the shape of the module object varies; the function itself is @babel/traverse.
const traverse = typeof nestedTraverse === 'function' ? (nestedTraverse as typeof _traverse) : _traverse

// ---------------------------------------------------------------------------
// Public API (integration contract; the extra fields are optional and additive)
// ---------------------------------------------------------------------------

export interface HandlerSummary {
  /** Every call in the body as written (`fetch`, `setDraft`, `event.preventDefault`, …), deduplicated. */
  calls: string[]
  /** `POST /api/messages`, `GET ${url}`, `WebSocket wss://…` — including ones reached through called functions (`(via deleteItem)`). */
  network: string[]
  /** `history.pushState → /saved`, `location.href = /login`, `router.push('/x') → history.pushState`, … */
  navigation: string[]
  /** `setDraft('')`, `this.setState({…})`, … */
  stateSetters: string[]
  preventsDefault: boolean
}

export interface ExplainedHandler {
  /** React prop name for `react-prop` (`onClick`, `onSend`); DOM event type for `dom` (`click`, `keydown (capture)`). */
  event: string
  origin: 'dom' | 'react-prop'
  /** For a prop on a DOM element: the component that rendered that element. For a prop on a wrapping component: that component. */
  component?: string
  functionName?: string
  /** Original `file:line` through the sourcemap, else `scriptUrl:line:col` of the served code. */
  source?: string
  frame?: string
  summary?: HandlerSummary
  /** Where the handler is attached when it is not the element itself: `form.composer`, `<SendButton>`, `div#app`, `document`, `window`. */
  target?: string
  /** A native listener on a node of the element's event path above it (an ancestor, a shadow host, `document`, `window`): it runs because the event propagates through that node. */
  delegated?: boolean
  /** A native listener on a node inside the element: it runs when the event lands on that node. */
  descendant?: boolean
  /** The library listener (on the sourcemap's ignoreList) that dispatches to this handler: `eventProxy (preact/src/diff/props.js:12)`. */
  dispatchedBy?: string
  /** The handler itself is library code (on the sourcemap's ignoreList) whose dispatch to page code could not be followed. */
  library?: boolean
}

export interface ElementExplanation {
  backendNodeId: number
  tag: string
  attributes: Record<string, string>
  /** aria-label / label / visible text / button value / title / alt / placeholder (never an input's typed value). */
  name?: string
  /** What the browser itself does on activation: `follows link → /pricing`, `submits form.login → POST /session`. */
  defaultAction?: string
  react?: {
    components: Array<{ name: string; source?: string }>
    /** Where this element's JSX is written (`_debugSource` on React ≤18 dev, `_debugStack` on React 19 dev). */
    renderedAt?: string
  }
  handlers: ExplainedHandler[]
  /** Handlers found but not listed because of `maxHandlers`. */
  omittedHandlers?: number
  notes: string[]
}

/** The node cannot be explained at all (gone, or not an element). */
export class ExplainError extends ModelFacingError {
  constructor(message: string) {
    super(message)
    this.name = 'ExplainError'
  }
}

// ---------------------------------------------------------------------------
// Limits (every one that drops results is reported in the explanation)
// ---------------------------------------------------------------------------

const CDP_TIMEOUT_MS = 3000
/** A script or sourcemap load fails (as a note) when one step makes no progress for this long. */
const RESOURCE_STALL_MS = 15_000
/** Larger scripts/sourcemaps are not loaded; the note names the URL and this bound. */
const MAX_RESOURCE_BYTES = 64_000_000
const DEFAULT_MAX_HANDLERS = 12
/** Components listed in the chain; further ones are counted in a note. */
const MAX_COMPONENTS = 12
/** Caches only (dropping an entry costs a reload/reparse, never a result). */
const MAX_CACHED_SOURCEMAPS = 6
const MAX_CACHED_PARSES = 16
const SNIPPET_MAX = 60
const CALLS_SHOWN = 6
/**
 * Functions entered while following one handler's calls. A visited set already ends recursion;
 * this bounds the protocol round trips when a handler calls into a large library served without
 * an ignoreList (each function entered costs a few, and a relayed session pays ~10ms each).
 * Reaching it is reported in the notes with the number of calls left unfollowed.
 */
const MAX_FOLLOWED_FUNCTIONS = 200

/** Bubbling input events: a listener for these on an ancestor/descendant runs when the element is used. */
const INTERACTION_EVENTS: Record<string, true> = {
  click: true, dblclick: true, auxclick: true, contextmenu: true, mousedown: true, mouseup: true,
  pointerdown: true, pointerup: true, touchstart: true, touchend: true, keydown: true, keyup: true,
  keypress: true, beforeinput: true, input: true, change: true, submit: true, focusin: true, focusout: true,
}
/** React prop event names that differ from the DOM event they listen to (React's onFocus/onBlur bubble). */
const REACT_PROP_DOM_EVENT: Record<string, string> = { doubleclick: 'dblclick', focus: 'focusin', blur: 'focusout' }
const NATIVE_CODE = /\{\s*\[native code\]\s*\}\s*$/
/** A listener whose whole source is an empty function does nothing (React's iOS click no-op is one). */
const EMPTY_FUNCTION = /^(?:function\s*[\w$]*\s*\(\s*\)\s*\{\s*\}|\(\s*\)\s*=>\s*\{\s*\})$/
const MINIFIED_NAMES_NOTE = 'Names are minified in this build; the names shown come from the original source through the sourcemap.'

// ---------------------------------------------------------------------------
// Per-page caches: sourcemaps by URL, parsed code by script (id + content hash) or original source
// ---------------------------------------------------------------------------

type ScriptMeta = Protocol.Debugger.ScriptParsedEvent

interface LoadedSourceMap {
  url: string
  map: TraceMap
  resolver: SourceMapResolver
}

/** Insertion-ordered map that drops its least recently used entries past `max`. A cache, never a result bound. */
class LruCache<V> {
  private readonly entries = new Map<string, V>()
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, value)
    }
    return value
  }

  set(key: string, value: V): void {
    this.entries.set(key, value)
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break
      this.entries.delete(oldest)
    }
  }

  delete(key: string): void {
    this.entries.delete(key)
  }
}

interface ParsedCode {
  code: string
  file: string
  ast: ParsedFile
  /** Every function in the file, in traversal order (outer before inner). */
  functions: NodePath[]
}

type ParseOutcome = { ok: true; parsed: ParsedCode } | { ok: false; reason: string }

interface PageCodeCache {
  sourceMaps: LruCache<Promise<LoadedSourceMap>>
  /**
   * Reads of served scripts' sources still in flight, by their parse key. The handlers and components
   * of one explain are located together and usually live in one bundle: they share one read. Two reads
   * of a 1 MB bundle used to overlap, and the first one's Babel parse — seconds of this thread under a
   * full test run's load — outlasted the second one's deadline although Chrome had answered it
   * ("The page did not respond within 3000ms while reading the source of …/app.js").
   */
  sourceReads: Map<string, Promise<string>>
  parsed: LruCache<ParseOutcome>
}

const pageCodeCaches = new WeakMap<Page, PageCodeCache>()

// ---------------------------------------------------------------------------
// Main-world reads (anonymous functions with `this` = a page node)
// ---------------------------------------------------------------------------

interface PathEntry {
  /** 1-based index of the node among the objects returned by reference. */
  ref: number
  label: string
  kind: 'element' | 'shadow-root' | 'document' | 'window' | 'other'
}

interface PageRead {
  name: string
  /** The composed event path above the element, nearest first, up to `window`. */
  path: PathEntry[]
  reactRoot: string | null
  defaultAction: { kind: 'link'; href: string; target: string | null } | { kind: 'submit'; form: string; method: string; action: string } | null
  /** The shared fiber read (handlers and component functions by reference); null without a fiber. */
  react: FiberReadResult | null
}

/**
 * The composed event path (DOM "get the parent"): a slotted node's assigned slot, a shadow
 * root's host, the document's window. `assignedSlot` is null for slots in CLOSED shadow roots;
 * the caller repairs those hops with `DOM.describeNode`'s `assignedSlot` (which sees them).
 */
const EVENT_PATH_READER = `
function composedParent(n) {
  if (n.nodeType === undefined) return null
  if (n.assignedSlot) return n.assignedSlot
  if (n.nodeType === 11 && n.host) return n.host
  if (n.nodeType === 9) return n.defaultView || null
  return n.parentNode || null
}
function pathEntry(n, ref) {
  if (n.nodeType === 1) return { ref: ref(n), label: reactNodeLabel(n), kind: 'element' }
  if (n.nodeType === 11) return { ref: ref(n), label: '#shadow-root of ' + reactNodeLabel(n.host), kind: 'shadow-root' }
  if (n.nodeType === 9) return { ref: ref(n), label: 'document', kind: 'document' }
  if (n.nodeType === undefined) return { ref: ref(n), label: 'window', kind: 'window' }
  return { ref: ref(n), label: String(n.nodeName || '?').toLowerCase(), kind: 'other' }
}
function eventPathAbove(start, ref) {
  var out = []
  for (var n = composedParent(start); n; n = composedParent(n)) out.push(pathEntry(n, ref))
  return out
}
`

const REF_COLLECTOR = `
  var objects = []
  var index = new Map()
  function ref(o) {
    if (index.has(o)) return index.get(o)
    objects.push(o)
    index.set(o, objects.length)
    return objects.length
  }
`

/**
 * Returns `[JSON meta, ...objects]`; meta refers to objects by 1-based array index. Objects are
 * functions (handlers, component types) and event-path nodes, handed back by reference so their
 * [[FunctionLocation]] / listeners can be read. Only reads: Object.keys, property gets,
 * getAttribute, innerText. The React part is the shared `readReactFiber`.
 */
const PAGE_READ_FUNCTION = `function (opts) {
  var el = this
${REF_COLLECTOR}
${REACT_FIBER_READER}
${EVENT_PATH_READER}
  function clean(s) {
    return String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
  }
  function isContainer(e) {
    return !!(e.nodeType === 1 && (reactKeyStarting(e, '__reactContainer$') || reactKeyStarting(e, '_reactRootContainer')))
  }

  var meta = { name: '', path: [], reactRoot: null, defaultAction: null, react: null }
  var tag = el.localName
  var type = String(el.type || '').toLowerCase()
  var buttonLike = tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')
  var labelText = el.labels && el.labels.length ? el.labels[0].innerText : ''
  var text = tag !== 'input' && tag !== 'select' && tag !== 'textarea' ? el.innerText || el.textContent || '' : ''
  meta.name = clean(el.getAttribute('aria-label') || labelText || text || (buttonLike ? el.value : '') ||
    el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '')

  meta.path = eventPathAbove(el, ref)
  for (var r = el; r; r = composedParent(r)) {
    if (isContainer(r)) { meta.reactRoot = reactNodeLabel(r); break }
  }

  if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) {
    meta.defaultAction = { kind: 'link', href: el.getAttribute('href'), target: el.getAttribute('target') }
  } else if (el.form && ((tag === 'button' && type === 'submit') || (tag === 'input' && (type === 'submit' || type === 'image')))) {
    meta.defaultAction = {
      kind: 'submit',
      form: reactNodeLabel(el.form),
      method: String(el.getAttribute('formmethod') || el.form.getAttribute('method') || 'get').toUpperCase(),
      action: el.getAttribute('formaction') || el.form.getAttribute('action') || '',
    }
  }

  var react = readReactFiber(el, { maxComponents: opts.maxComponents, maxAncestors: -1, props: false }, ref)
  if (react.reactFound) meta.react = react
  return [JSON.stringify(meta)].concat(objects)
}`

/** `this` (a slot) and the composed path above it, as `[JSON PathEntry[], ...objects]`. */
const PATH_FROM_FUNCTION = `function () {
${REF_COLLECTOR}
${REACT_FIBER_READER}
${EVENT_PATH_READER}
  return [JSON.stringify([pathEntry(this, ref)].concat(eventPathAbove(this, ref)))].concat(objects)
}`

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function oneLine(text: string, max = SNIPPET_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

async function send<T>(promise: Promise<T>, what: string): Promise<T> {
  return await withDeadline(promise, CDP_TIMEOUT_MS, what)
}

interface V8Location {
  scriptId: string
  lineNumber: number
  columnNumber: number
}

function isV8Location(value: unknown): value is V8Location {
  return (
    !!value &&
    typeof value === 'object' &&
    'scriptId' in value &&
    typeof value.scriptId === 'string' &&
    'lineNumber' in value &&
    typeof value.lineNumber === 'number' &&
    'columnNumber' in value &&
    typeof value.columnNumber === 'number'
  )
}

/** `tag#id` / `tag.a.b` for a node described by CDP. */
function describedLabel(node: Protocol.DOM.Node): string {
  const tag = (node.localName || node.nodeName).toLowerCase()
  const flat = node.attributes ?? []
  const attrs = new Map<string, string>()
  for (let i = 0; i + 1 < flat.length; i += 2) attrs.set(flat[i], flat[i + 1])
  const id = attrs.get('id')
  if (id) return `${tag}#${id}`
  const classes = (attrs.get('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
  return classes.length ? `${tag}.${classes.join('.')}` : tag
}

// ---------------------------------------------------------------------------
// Explain context: one per explainElement call, holding the page caches and CDP read caches
// ---------------------------------------------------------------------------

interface ExplainContext {
  cdp: ICDPSession
  debuggerDomain: DebuggerDomain
  cache: PageCodeCache
  objectGroup: string
  notes: string[]
  noted: Set<string>
  /** `Runtime.getProperties(ownProperties)` by objectId. */
  properties: Map<string, Promise<Protocol.Runtime.GetPropertiesResponse>>
  functions: Map<string, Promise<RuntimeFunction>>
  /** The node's frame: resource loads (sourcemaps) go through it so they carry its origin, cookies and referrer. */
  frameId: string
  /** Origin of the node's own document: same-origin sources display as paths. */
  documentOrigin: string | null
  renamed: boolean
}

function note(ctx: ExplainContext, text: string): void {
  if (ctx.noted.has(text)) return
  ctx.noted.add(text)
  ctx.notes.push(text)
}

function ownProperties(ctx: ExplainContext, objectId: string): Promise<Protocol.Runtime.GetPropertiesResponse> {
  let pending = ctx.properties.get(objectId)
  if (!pending) {
    pending = send(ctx.cdp.send('Runtime.getProperties', { objectId, ownProperties: true }), 'reading properties of a page object')
    ctx.properties.set(objectId, pending)
  }
  return pending
}

/** A script or sourcemap of the explained element's frame, through the shared DevTools-style loader on that frame's session. */
async function fetchText(ctx: ExplainContext, url: string): Promise<string> {
  return await loadResourceText({ cdp: ctx.cdp, frameId: ctx.frameId, url, maxBytes: MAX_RESOURCE_BYTES, timeoutMs: RESOURCE_STALL_MS })
}

// ---------------------------------------------------------------------------
// Values: what the follower knows about an expression at run time
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'remote'; object: Protocol.Runtime.RemoteObject }
  | { kind: 'primitive'; value: string | number | boolean | null | undefined }
  | { kind: 'event'; type: string; currentTarget: Value }
  /** A function written in the served code being walked, closed over `frame`. */
  | { kind: 'local'; path: NodePath; frame: Frame }
  | { kind: 'unknown' }

const UNKNOWN: Value = { kind: 'unknown' }

function valueOf(remote: Protocol.Runtime.RemoteObject | undefined): Value {
  if (!remote) return UNKNOWN
  if (remote.objectId && (remote.type === 'object' || remote.type === 'function')) return { kind: 'remote', object: remote }
  if (remote.type === 'object' && remote.subtype === 'null') return { kind: 'primitive', value: null }
  if (remote.type === 'undefined') return { kind: 'primitive', value: undefined }
  const value: unknown = remote.value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { kind: 'primitive', value }
  return UNKNOWN
}

/** JS truthiness when it is known. */
function truthy(value: Value): boolean | null {
  if (value.kind === 'primitive') return Boolean(value.value)
  if (value.kind === 'remote' || value.kind === 'event' || value.kind === 'local') return true
  return null
}

/** A function object as V8 runs it: bound wrappers unwrapped, with what they bind. */
interface RuntimeFunction {
  object: Protocol.Runtime.RemoteObject
  name?: string
  description?: string
  location?: V8Location
  native: boolean
  /** objectId of `[[Scopes]]`. */
  scopes?: string
  bound: boolean
  boundThis: Value
  boundArgs: Value[]
}

function inspectFunction(ctx: ExplainContext, remote: Protocol.Runtime.RemoteObject): Promise<RuntimeFunction> {
  const objectId = remote.objectId
  if (!objectId) return Promise.reject(new Error('the function has no remote object id'))
  let pending = ctx.functions.get(objectId)
  if (!pending) {
    pending = readFunction(ctx, remote, objectId)
    ctx.functions.set(objectId, pending)
  }
  return pending
}

async function readFunction(ctx: ExplainContext, remote: Protocol.Runtime.RemoteObject, objectId: string): Promise<RuntimeFunction> {
  const props = await ownProperties(ctx, objectId)
  const nameValue = props.result.find((p) => p.name === 'name')?.value?.value
  const name = typeof nameValue === 'string' && nameValue ? nameValue : undefined
  const internal = new Map((props.internalProperties ?? []).map((p) => [p.name, p.value]))
  const target = internal.get('[[TargetFunction]]')
  if (target?.objectId) {
    const inner = await inspectFunction(ctx, target)
    const boundArgsObject = internal.get('[[BoundArgs]]')
    const ownArgs = boundArgsObject?.objectId
      ? (await ownProperties(ctx, boundArgsObject.objectId)).result
          .filter((p) => /^\d+$/.test(p.name))
          .sort((a, b) => Number(a.name) - Number(b.name))
          .map((p) => valueOf(p.value))
      : []
    // f.bind(t1, a).bind(t2, b) calls f with this = t1 and (a, b, …call args).
    return {
      ...inner,
      name: inner.name ?? name,
      bound: true,
      boundThis: inner.bound ? inner.boundThis : valueOf(internal.get('[[BoundThis]]')),
      boundArgs: [...inner.boundArgs, ...ownArgs],
    }
  }
  const locationValue = internal.get('[[FunctionLocation]]')?.value
  const location = isV8Location(locationValue) ? locationValue : undefined
  return {
    object: remote,
    name,
    description: remote.description,
    location,
    native: !location && NATIVE_CODE.test(remote.description ?? ''),
    scopes: internal.get('[[Scopes]]')?.objectId,
    bound: false,
    boundThis: UNKNOWN,
    boundArgs: [],
  }
}

/** A variable as the function's live closure sees it (`[[Scopes]]`, innermost first, through to the global object). Getters are never run. */
async function scopeLookup(ctx: ExplainContext, fn: RuntimeFunction, name: string): Promise<Value> {
  if (!fn.scopes) return UNKNOWN
  const scopes = (await ownProperties(ctx, fn.scopes)).result
    .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
    .sort((a, b) => Number(a.name) - Number(b.name))
  for (const scope of scopes) {
    const variables = await ownProperties(ctx, scope.value!.objectId!)
    const found = variables.result.find((p) => p.name === name)
    if (!found) continue
    return found.value ? valueOf(found.value) : UNKNOWN
  }
  return UNKNOWN
}

/**
 * A module namespace object (`import * as api`), recognised by its spec shape: null prototype,
 * a non-configurable `Symbol.toStringTag` of "Module", V8 class Module. Its exports are exposed
 * as native accessors whose [[Get]] only reads the export binding: the object is exotic and
 * non-extensible, so page code cannot intercept the read.
 */
function isModuleNamespace(object: Protocol.Runtime.RemoteObject, props: Protocol.Runtime.GetPropertiesResponse): boolean {
  if (object.className !== 'Module' || props.internalProperties?.some((p) => p.name === '[[Prototype]]')) return false
  const tag = props.result.find((p) => p.symbol && p.name === 'Symbol(Symbol.toStringTag)')
  return tag?.value?.value === 'Module' && tag.configurable === false && tag.writable === false
}

/**
 * `object[key]` without running page code: own data properties, then up the `[[Prototype]]`
 * chain. An accessor is read only when its getter is native: a module namespace export (read
 * directly, see isModuleNamespace) or another native getter under V8's side-effect check
 * (`throwOnSideEffect`, which aborts any read that could change state). A page-defined getter is
 * never run; its value is unknown.
 */
async function propertyOf(ctx: ExplainContext, object: Protocol.Runtime.RemoteObject, key: string): Promise<Value> {
  const seen = new Set<string>()
  for (let current: Protocol.Runtime.RemoteObject | undefined = object; current?.objectId && !seen.has(current.objectId); ) {
    seen.add(current.objectId)
    const props = await ownProperties(ctx, current.objectId)
    const found = props.result.find((p) => p.name === key && !p.symbol)
    if (found?.value) return valueOf(found.value)
    if (found) {
      if (!found.get || !NATIVE_CODE.test(found.get.description ?? '')) return UNKNOWN
      const namespace = current === object && isModuleNamespace(object, props)
      const read = await send(
        ctx.cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: 'function (key) { return this[key] }',
          arguments: [{ value: key }],
          throwOnSideEffect: !namespace,
          objectGroup: ctx.objectGroup,
        }),
        `reading ${key} through a native getter`,
      )
      return read.exceptionDetails ? UNKNOWN : valueOf(read.result)
    }
    current = props.internalProperties?.find((p) => p.name === '[[Prototype]]')?.value
  }
  return { kind: 'primitive', value: undefined }
}

// ---------------------------------------------------------------------------
// Locating code: scriptId → served script AST (+ sourcemap → original source AST)
// ---------------------------------------------------------------------------

interface CodeSide {
  parsed: ParsedCode
  fn: NodePath
}

interface ScriptMap {
  script: ScriptMeta
  sourceMap: LoadedSourceMap
}

interface LocatedCode {
  /** What V8 runs (names and properties as at run time): calls are followed here. */
  served: CodeSide | null
  /** What the author wrote (through the sourcemap); the served side when there is no map. Summaries and frames come from here. */
  original: CodeSide | null
  /** Human location: `file:line` (original) or `url:line:col` (served code); '' when unknown. */
  display: string
  /** The original source is on the sourcemap's ignoreList (library/framework code). */
  library: boolean
  map: ScriptMap | null
}

function parsePlugins(file: string): ParserPlugin[] {
  const path = file.replace(/[?#].*$/, '')
  if (/\.tsx$/i.test(path)) return ['typescript', 'jsx']
  if (/\.[mc]?ts$/i.test(path)) return ['typescript']
  return ['jsx']
}

function parseCode(code: string, file: string, plugins: ParserPlugin[]): ParsedCode {
  const ast = parse(code, { sourceType: 'unambiguous', errorRecovery: true, allowReturnOutsideFunction: true, sourceFilename: file, plugins })
  const functions: NodePath[] = []
  traverse(ast, {
    Function(path) {
      functions.push(path)
    },
  })
  return { code, file, ast, functions }
}

function cachedParse(ctx: ExplainContext, key: string, parseIt: () => ParsedCode): ParseOutcome {
  const cached = ctx.cache.parsed.get(key)
  if (cached) return cached
  let outcome: ParseOutcome
  try {
    outcome = { ok: true, parsed: parseIt() }
  } catch (error) {
    outcome = { ok: false, reason: errorText(error) }
  }
  ctx.cache.parsed.set(key, outcome)
  return outcome
}

function scriptName(script: ScriptMeta): string {
  return script.url || `(anonymous script ${script.scriptId})`
}

/** The served script, parsed whole and padded so Babel positions equal V8 document positions (inline scripts start mid-document). */
async function servedCode(ctx: ExplainContext, script: ScriptMeta): Promise<ParsedCode | null> {
  const key = `served:${script.scriptId}:${script.hash}`
  let outcome = ctx.cache.parsed.get(key)
  if (!outcome) {
    let reading = ctx.cache.sourceReads.get(key)
    if (!reading) {
      const read = send(ctx.cdp.send('Debugger.getScriptSource', { scriptId: script.scriptId }), `reading the source of ${scriptName(script)}`).then(
        (answer) => answer.scriptSource,
      )
      const forget = (): void => {
        if (ctx.cache.sourceReads.get(key) === read) ctx.cache.sourceReads.delete(key)
      }
      read.then(forget, forget)
      ctx.cache.sourceReads.set(key, read)
      reading = read
    }
    let source: string
    try {
      source = await reading
    } catch (error) {
      if (error instanceof PageUnresponsiveError) throw error
      note(ctx, `The source of ${scriptName(script)} could not be read (${errorText(error)}); its functions are located but not summarised.`)
      return null
    }
    const padded = '\n'.repeat(script.startLine) + ' '.repeat(script.startColumn) + source
    outcome = cachedParse(ctx, key, () => parseCode(padded, scriptName(script), []))
  }
  if (!outcome.ok) {
    note(ctx, `Could not parse ${scriptName(script)} with Babel (${outcome.reason}); its functions are located but not summarised.`)
    return null
  }
  return outcome.parsed
}

/** The script's sourcemap (V8 reports the `sourceMappingURL` comment in scriptParsed), or null with a note naming the URL and the cause. */
async function sourceMapFor(ctx: ExplainContext, script: ScriptMeta): Promise<LoadedSourceMap | null> {
  const reference = script.sourceMapURL
  if (!reference) return null
  let mapUrl: string
  try {
    mapUrl = reference.startsWith('data:') ? reference : new URL(reference, script.url || undefined).href
  } catch {
    note(ctx, `Cannot resolve the sourcemap reference "${oneLine(reference, 80)}" of ${scriptName(script)}.`)
    return null
  }
  let loading = ctx.cache.sourceMaps.get(mapUrl)
  if (!loading) {
    const pending = fetchText(ctx, mapUrl).then((text) => {
      const map = new AnyMap(text, mapUrl.startsWith('data:') ? script.url || undefined : mapUrl)
      return { url: mapUrl, map, resolver: makeSourceMapResolver(map) }
    })
    loading = pending
    ctx.cache.sourceMaps.set(mapUrl, pending)
    pending.catch(() => ctx.cache.sourceMaps.delete(mapUrl))
  }
  try {
    return await loading
  } catch (error) {
    const shown = mapUrl.startsWith('data:') ? 'The inline sourcemap' : `Sourcemap ${mapUrl}`
    const cause = error instanceof ResourceLoadError ? error.message.slice(`Loading ${error.url} failed: `.length) : errorText(error)
    note(ctx, `${shown} of ${scriptName(script)} could not be loaded (${cause}); locations and summaries for it are from the served code.`)
    return null
  }
}

/** Short, openable path for an original source: same-origin URLs become their pathname, bundler schemes are stripped. */
function displaySource(resolved: string, pageOrigin: string | null): string {
  let shown = resolved
  try {
    const url = new URL(resolved)
    if (url.protocol === 'file:') shown = decodeURIComponent(url.pathname)
    else if ((url.protocol === 'http:' || url.protocol === 'https:') && (pageOrigin === null || url.origin === pageOrigin)) {
      shown = decodeURIComponent(url.pathname)
    } else if (/^(webpack|webpack-internal|turbopack|rollup|vite):$/.test(url.protocol)) {
      shown = resolved.replace(/^[a-z-]+:\/\/\/?[^/]*\//i, '').replace(/^(\.\/)+/, '')
    }
  } catch {
    // Not a URL (a map without a URL of its own): shown as written.
  }
  return shown.replace(/^\/@fs(?=\/)/, '').replace(/^\/?\([\w-]+\)\//, '').replace(/[?#].*$/, '')
}

/** An original source of a sourcemap, parsed (cached per page), or null with a note. */
function originalCode(ctx: ExplainContext, map: ScriptMap, source: string, file: string): ParsedCode | null {
  const content = sourceContentFor(map.sourceMap.map, source)
  if (content == null) {
    note(ctx, `The sourcemap of ${scriptName(map.script)} has no sourcesContent for ${file}; summaries come from the served code.`)
    return null
  }
  const outcome = cachedParse(ctx, `original:${map.sourceMap.url}\n${source}`, () => parseCode(content, file, parsePlugins(source)))
  if (!outcome.ok) {
    note(ctx, `Could not parse ${file} with Babel (${outcome.reason}); summaries come from the served code.`)
    return null
  }
  return outcome.parsed
}

/** Script-relative 0-based position of a document position (V8 and padded Babel lines are document-relative). */
function scriptRelative(script: ScriptMeta, line0: number, column: number): { line: number; column: number } {
  const line = line0 - script.startLine
  return { line, column: line === 0 ? column - script.startColumn : column }
}

/**
 * Where served code at a document position (0-based line) comes from: its original source,
 * line and column, and whether that source is ignore-listed. Null without a usable mapping.
 */
function originalPositionOf(map: ScriptMap, line0: number, column: number): { source: string; line: number; column: number } | null {
  const rel = scriptRelative(map.script, line0, column)
  const original = map.sourceMap.resolver.originalPosition({ line: rel.line + 1, column: rel.column })
  if (!original.source || original.line == null) return null
  return { source: original.source, line: original.line, column: original.column ?? 0 }
}

/**
 * A served function (or a V8 position whose function could not be found in the served code)
 * with its original counterpart through the sourcemap. Every gap is noted, nothing is guessed.
 */
async function describeServed(
  ctx: ExplainContext,
  script: ScriptMeta,
  served: CodeSide | null,
  position: { line0: number; column: number },
  runtimeName: string | undefined,
): Promise<LocatedCode> {
  const urlShown = scriptName(script)
  const servedDisplay = `${urlShown}:${position.line0 + 1}:${position.column + 1}`
  const sourceMap = await sourceMapFor(ctx, script)
  if (sourceMap) {
    const map = { script, sourceMap }
    const original = originalPositionOf(map, position.line0, position.column)
    if (original) {
      const file = displaySource(original.source, ctx.documentOrigin)
      const library = isIgnored(sourceMap.map, original.source)
      const parsed = originalCode(ctx, map, original.source, file)
      const fn = parsed ? findFunctionAt(parsed, original.line, original.column, runtimeName) : null
      if (parsed && !fn) note(ctx, `No function found at ${file}:${original.line} in the original source; summaries come from the served code.`)
      return { served, original: parsed && fn ? { parsed, fn } : served, display: `${file}:${original.line}`, library, map }
    }
    note(ctx, `The sourcemap of ${urlShown} does not map some handlers; their locations are in the served code.`)
    return { served, original: served, display: servedDisplay, library: false, map }
  }
  if (script.url && !/^(chrome|devtools|extensions::)/.test(script.url) && !script.sourceMapURL) {
    note(ctx, `No sourcemap for ${urlShown}; locations and summaries are from the served code.`)
  }
  return { served, original: served, display: servedDisplay, library: false, map: null }
}

function descriptionCode(ctx: ExplainContext, description: string | undefined): LocatedCode | null {
  if (!description || NATIVE_CODE.test(description)) return null
  // A function's own text is an expression only once wrapped; methods need an object or class around them.
  for (const code of [`(${description})`, `({${description}})`, `(class{${description}})`]) {
    try {
      const parsed = parseCode(code, 'handler.js', ['jsx'])
      if (parsed.ast.errors?.length) continue
      const fn = parsed.functions[0]
      if (fn) return { served: null, original: { parsed, fn }, display: '', library: false, map: null }
    } catch {
      // Try the next wrapping.
    }
  }
  note(ctx, 'Could not parse the source text of a handler with Babel; it is located but not summarised.')
  return null
}

/** Where a runtime function is, in the served script and (through the sourcemap) the original source. */
async function locateFunction(ctx: ExplainContext, fn: RuntimeFunction): Promise<LocatedCode | null> {
  const location = fn.location
  if (!location) return descriptionCode(ctx, fn.description)
  await ctx.debuggerDomain.enable()
  const script = ctx.debuggerDomain.scripts.get(location.scriptId)
  if (!script) {
    note(
      ctx,
      ctx.debuggerDomain.scriptsReplayedOnEnable === 0
        ? 'Script URLs are unknown for scripts parsed before explain first ran: the Debugger domain was already enabled by another client, so they were not replayed.'
        : `Script ${location.scriptId} is no longer loaded (the page navigated or the script was collected).`,
    )
    return descriptionCode(ctx, fn.description)
  }
  const parsed = await servedCode(ctx, script)
  const servedFn = parsed ? findFunctionAt(parsed, location.lineNumber + 1, location.columnNumber, fn.name) : null
  if (parsed && !servedFn) note(ctx, `No function found at ${scriptName(script)}:${location.lineNumber + 1} in the served code.`)
  const served = parsed && servedFn ? { parsed, fn: servedFn } : null
  return await describeServed(ctx, script, served, { line0: location.lineNumber, column: location.columnNumber }, fn.name)
}

/** A function written inside already-located served code (a local helper): same script, its own original counterpart. */
async function locateLocal(ctx: ExplainContext, code: LocatedCode, fn: NodePath): Promise<LocatedCode> {
  const served = code.served ? { parsed: code.served.parsed, fn } : null
  const start = fn.node.loc?.start
  if (!code.map || !start) return { served, original: served, display: code.display, library: code.library, map: code.map }
  return await describeServed(ctx, code.map.script, served, { line0: start.line - 1, column: start.column }, declaredName(fn))
}

// ---------------------------------------------------------------------------
// Babel: functions, names, and what a body does
// ---------------------------------------------------------------------------

type BabelNode = NodePath['node']
type CallLike = Extract<BabelNode, { type: 'CallExpression' | 'OptionalCallExpression' | 'NewExpression' }>

/** The name a function is declared under: `function f`, `const f = …`, `f() {}`, `f: …`, `const f = useCallback(…)`. */
function declaredName(path: NodePath): string | undefined {
  const node = path.node
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id) return node.id.name
  if (node.type === 'ObjectMethod' || node.type === 'ClassMethod') {
    if (node.key.type === 'Identifier') return node.key.name
    if (node.key.type === 'StringLiteral') return node.key.value
  }
  if (node.type === 'ClassPrivateMethod') return `#${node.key.id.name}`
  const holder = path.parentPath?.node
  if (!holder) return undefined
  if (holder.type === 'VariableDeclarator' && holder.id.type === 'Identifier') return holder.id.name
  if ((holder.type === 'ObjectProperty' || holder.type === 'ClassProperty') && holder.key.type === 'Identifier') return holder.key.name
  if (holder.type === 'AssignmentExpression' && holder.left.type === 'Identifier') return holder.left.name
  // useCallback(() => …) / useMemo: the declarator one level further up names it.
  const grand = path.parentPath?.parentPath?.node
  if (holder.type === 'CallExpression' && grand?.type === 'VariableDeclarator' && grand.id.type === 'Identifier') return grand.id.name
  return undefined
}

/** declaredName, else `inline onClick handler` for a JSX attribute value. */
function functionLabel(path: NodePath): string | undefined {
  const declared = declaredName(path)
  if (declared) return declared
  const holder = path.parentPath?.node
  const grand = path.parentPath?.parentPath?.node
  if (holder?.type === 'JSXExpressionContainer' && grand?.type === 'JSXAttribute' && grand.name.type === 'JSXIdentifier') {
    return `inline ${grand.name.name} handler`
  }
  return undefined
}

function before(a: { line: number; column: number }, b: { line: number; column: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.column <= b.column)
}

function nodeSize(node: BabelNode): number {
  return (node.end ?? 0) - (node.start ?? 0)
}

/**
 * The function V8 means by a location. [[FunctionLocation]] points into the function (its
 * parameter list), and a sourcemap may snap it to the nearest earlier segment, so: prefer a
 * function with the runtime name that starts on that line or contains the position; else the
 * innermost function containing the position; else the first function starting later on that line.
 */
function findFunctionAt(parsed: ParsedCode, line: number, column: number, runtimeName: string | undefined): NodePath | null {
  const pos = { line, column }
  const wanted = runtimeName?.replace(/^bound /, '')
  let innermost: NodePath | null = null
  let sameLineAfter: NodePath | null = null
  let named: NodePath | null = null
  for (const path of parsed.functions) {
    const loc = path.node.loc
    if (!loc) continue
    const contains = before(loc.start, pos) && before(pos, loc.end)
    if (contains && (!innermost || nodeSize(path.node) < nodeSize(innermost.node))) innermost = path
    if (loc.start.line === line && loc.start.column >= column && !sameLineAfter) sameLineAfter = path
    if (wanted && (loc.start.line === line || contains) && functionLabel(path) === wanted) {
      if (!named || nodeSize(path.node) < nodeSize(named.node)) named = path
    }
  }
  return named ?? innermost ?? sameLineAfter
}

/** `a.b.c` for member chains rooted at an identifier/this; `[…]` for computed members; null for anything else. */
function chainText(node: BabelNode | null | undefined): string | null {
  if (!node) return null
  switch (node.type) {
    case 'Identifier':
      return node.name
    case 'ThisExpression':
      return 'this'
    case 'Super':
      return 'super'
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const object = chainText(node.object)
      if (object === null) return null
      const property = node.property
      if (!node.computed && property.type === 'Identifier') return `${object}.${property.name}`
      if (property.type === 'PrivateName') return `${object}.#${property.id.name}`
      if (property.type === 'StringLiteral') return `${object}.${property.value}`
      return `${object}[…]`
    }
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const callee = chainText(node.callee)
      return callee === null ? null : `${callee}()`
    }
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return chainText(node.expression)
    default:
      return null
  }
}

function rootIdentifier(node: BabelNode): string | null {
  switch (node.type) {
    case 'Identifier':
      return node.name
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return rootIdentifier(node.object)
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return rootIdentifier(node.expression)
    default:
      return null
  }
}

/**
 * The member chain of `node` when its root identifier is a global (no binding in scope at
 * `path`), with global-object receivers stripped (`window.fetch` → `fetch`,
 * `document.location.href` → `location.href`); null for anything local.
 */
function globalChain(path: NodePath, node: BabelNode): string | null {
  const chain = chainText(node)
  const root = rootIdentifier(node)
  if (chain === null || root === null || path.scope.getBinding(root)) return null
  return chain.replace(/^(window|globalThis|self)\./, '').replace(/^document\.(?=location\b)/, '')
}

function sourceOf(code: string, node: BabelNode | null | undefined): string {
  if (node?.start == null || node.end == null) return '…'
  return code.slice(node.start, node.end)
}

/** A URL argument as a reader would write it: literals verbatim, dynamic parts as `${expr}`. */
function urlText(code: string, node: BabelNode | null | undefined): string {
  if (!node) return '?'
  switch (node.type) {
    case 'StringLiteral':
      return node.value
    case 'TemplateLiteral': {
      let out = ''
      node.quasis.forEach((quasi, i) => {
        out += quasi.value.cooked ?? quasi.value.raw
        if (i < node.expressions.length) out += '${' + oneLine(sourceOf(code, node.expressions[i]), 30) + '}'
      })
      return out
    }
    case 'BinaryExpression':
      if (node.operator === '+') return urlText(code, node.left) + urlText(code, node.right)
      break
    case 'NewExpression':
      if (chainText(node.callee) === 'URL' && node.arguments[0]) return urlText(code, node.arguments[0])
      break
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return urlText(code, node.expression)
  }
  return '${' + oneLine(sourceOf(code, node), 30) + '}'
}

function objectProp(node: BabelNode | undefined, name: string): BabelNode | undefined {
  if (node?.type !== 'ObjectExpression') return undefined
  for (const prop of node.properties) {
    if (prop.type !== 'ObjectProperty' || prop.computed) continue
    const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : null
    if (key === name) return prop.value
  }
  return undefined
}

function methodText(code: string, node: BabelNode | undefined, fallback: string): string {
  if (node === undefined) return fallback
  if (node.type === 'StringLiteral') return node.value.toUpperCase()
  return '${' + oneLine(sourceOf(code, node), 20) + '}'
}

interface Effect {
  text: string
  /** Functions the effect was reached through, outermost first. */
  via: string[]
  /** The platform API (or `state setter`) that performs it. */
  api: string
}

interface CallEffect {
  kind: 'network' | 'navigation' | 'stateSetters'
  text: string
  api: string
}

/** A `new XMLHttpRequest()` bound to the receiver of `xhr.open(…)`. */
function isXhrReceiver(path: NodePath<CallLike>): boolean {
  const callee = path.node.callee
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return false
  const declarator = path.scope.getBinding(callee.object.name)?.path
  if (!declarator?.isVariableDeclarator()) return false
  const init = declarator.get('init')
  return init.isNewExpression() && globalChain(init, init.node.callee) === 'XMLHttpRequest'
}

/**
 * A framework state setter, by bindings: element 1 of an array pattern initialised by a call to
 * an imported function (`const [x, setX] = useState(…)`, `useReducer`, a library's hook), or a
 * method a class inherits from an imported superclass without defining it (`this.setState`).
 */
function isFrameworkStateSetter(path: NodePath<CallLike>): boolean {
  const callee = path.node.callee
  if (callee.type === 'Identifier') {
    const binding = path.scope.getBinding(callee.name)
    const declarator = binding?.path
    if (!binding || !declarator?.isVariableDeclarator()) return false
    const { id, init } = declarator.node
    if (id.type !== 'ArrayPattern' || id.elements[1] !== binding.identifier) return false
    if (init?.type !== 'CallExpression') return false
    const hook = rootIdentifier(init.callee)
    return hook !== null && declarator.scope.getBinding(hook)?.kind === 'module'
  }
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'ThisExpression' || callee.computed || callee.property.type !== 'Identifier') {
    return false
  }
  const method = callee.property.name
  const owner = path.findParent((p) => (p.isFunction() && !p.isArrowFunctionExpression()) || p.isClassProperty() || p.isClassPrivateProperty())
  if (!owner || !(owner.isClassMethod() || owner.isClassPrivateMethod() || owner.isClassProperty() || owner.isClassPrivateProperty())) return false
  const classPath = owner.parentPath?.parentPath
  if (!classPath || !(classPath.isClassDeclaration() || classPath.isClassExpression())) return false
  const superClass = classPath.node.superClass
  const superRoot = superClass ? rootIdentifier(superClass) : null
  if (superRoot === null || classPath.scope.getBinding(superRoot)?.kind !== 'module') return false
  return !classPath.node.body.body.some(
    (member) => (member.type === 'ClassMethod' || member.type === 'ClassProperty') && member.key.type === 'Identifier' && member.key.name === method,
  )
}

/** What a call does by itself, decided by bindings: a global platform API, or a framework state setter. */
function callEffect(code: string, path: NodePath<CallLike>): CallEffect | null {
  const node = path.node
  const args = node.arguments
  const callee = globalChain(path, node.callee)
  if (node.type === 'NewExpression') {
    return callee === 'WebSocket' || callee === 'EventSource' ? { kind: 'network', text: `${callee} ${urlText(code, args[0])}`, api: callee } : null
  }
  if (callee === 'fetch') {
    const options = args[1]
    const text =
      options && options.type !== 'ObjectExpression'
        ? `fetch ${urlText(code, args[0])} (method in ${oneLine(sourceOf(code, options), 20)})`
        : `${methodText(code, objectProp(options, 'method'), 'GET')} ${urlText(code, args[0])}`
    return { kind: 'network', text, api: 'fetch' }
  }
  if (callee === 'navigator.sendBeacon') return { kind: 'network', text: `POST ${urlText(code, args[0])} (sendBeacon)`, api: 'navigator.sendBeacon' }
  if (callee === 'history.pushState' || callee === 'history.replaceState') {
    return { kind: 'navigation', text: args[2] ? `${callee} → ${urlText(code, args[2])}` : callee, api: callee }
  }
  if (callee === 'history.back' || callee === 'history.forward' || callee === 'history.go') return { kind: 'navigation', text: `${callee}()`, api: callee }
  if (callee === 'location.assign' || callee === 'location.replace') return { kind: 'navigation', text: `${callee} → ${urlText(code, args[0])}`, api: callee }
  if (callee === 'location.reload') return { kind: 'navigation', text: 'location.reload()', api: callee }
  if (callee === 'open') return { kind: 'navigation', text: `window.open → ${urlText(code, args[0])}`, api: 'window.open' }
  if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' && node.callee.property.name === 'open' && isXhrReceiver(path)) {
    return { kind: 'network', text: `${methodText(code, args[0], '?')} ${urlText(code, args[1])} (XMLHttpRequest)`, api: 'XMLHttpRequest' }
  }
  if (isFrameworkStateSetter(path)) return { kind: 'stateSetters', text: oneLine(sourceOf(code, node)), api: 'state setter' }
  return null
}

const LOCATION_TARGET = /^location(\.(href|pathname|search|hash))?$/

interface RawSummary {
  calls: string[]
  network: Effect[]
  navigation: Effect[]
  stateSetters: Effect[]
  preventsDefault: boolean
}

function emptySummary(): RawSummary {
  return { calls: [], network: [], navigation: [], stateSetters: [], preventsDefault: false }
}

function addEffect(list: Effect[], effect: Effect): void {
  if (!list.some((item) => item.text === effect.text)) list.push(effect)
}

/** What the function's own body does (nested callbacks included); called functions are followed separately. */
function directSummary(side: CodeSide): RawSummary {
  const code = side.parsed.code
  const out = emptySummary()
  const visitCall = (path: NodePath<CallLike>): void => {
    const chain = chainText(path.node.callee)
    if (chain !== null && !out.calls.includes(chain)) out.calls.push(chain)
    if (chain !== null && /\.preventDefault$/.test(chain)) out.preventsDefault = true
    const effect = callEffect(code, path)
    if (effect) addEffect(out[effect.kind], { text: effect.text, via: [], api: effect.api })
  }
  side.fn.traverse({
    CallExpression: visitCall,
    OptionalCallExpression: visitCall,
    NewExpression: visitCall,
    AssignmentExpression(path) {
      const target = globalChain(path, path.node.left)
      if (target && LOCATION_TARGET.test(target)) {
        addEffect(out.navigation, { text: `${target} = ${urlText(code, path.node.right)}`, via: [], api: target })
      }
    },
  })
  return out
}

function finishSummary(raw: RawSummary): HandlerSummary {
  const render = (items: Effect[]): string[] => items.map((item) => (item.via.length ? `${item.text} (via ${item.via.join(' › ')})` : item.text))
  return {
    calls: raw.calls,
    network: render(raw.network),
    navigation: render(raw.navigation),
    stateSetters: render(raw.stateSetters),
    preventsDefault: raw.preventsDefault,
  }
}

// ---------------------------------------------------------------------------
// Following calls at run time
// ---------------------------------------------------------------------------

/** One function being walked: its served code, the closure that answers free names, and its `this`/arguments. */
interface Frame {
  parent: Frame | null
  /** The runtime function whose [[Scopes]] resolve names free in this frame (static local frames inherit it). */
  runtime: RuntimeFunction | null
  code: LocatedCode
  side: CodeSide
  thisValue: Value
  args: Value[]
}

interface Walk {
  ctx: ExplainContext
  /** Served function nodes already entered: ends recursion (no depth bound). */
  visited: WeakSet<object>
  /** `summary`: page code, effects collected. `library`: inside ignore-listed code reached from page code. `dispatch`: a library listener, looking for the page handlers it calls. */
  mode: 'summary' | 'library' | 'dispatch'
  /** Dispatch mode: the page functions the library listener was followed to. */
  reached: RuntimeFunction[]
  /** Shared by every walk from one handler: functions that may still be entered, and calls left unfollowed once none may. */
  budget: { left: number; cut: number }
}

/** Take one function from the walk's budget; false (and counted) once it is spent. */
function enterFunction(walk: Walk): boolean {
  if (walk.budget.left === 0) {
    walk.budget.cut++
    return false
  }
  walk.budget.left--
  return true
}

function noteBudget(ctx: ExplainContext, walk: Walk, what: string): void {
  if (walk.budget.cut === 0) return
  note(
    ctx,
    `Following the calls of ${what} stopped after ${MAX_FOLLOWED_FUNCTIONS} functions (the follow bound); ${walk.budget.cut} further call(s) were not followed, so their effects are not shown.`,
  )
}

/** The frame (this one or an enclosing one) whose function declares the scope `scopePath`. */
function frameDeclaring(frame: Frame, scopePath: NodePath): Frame | null {
  for (let f: Frame | null = frame; f; f = f.parent) {
    if (scopePath === f.side.fn || scopePath.isDescendant(f.side.fn)) return f
  }
  return null
}

function runtimeOf(frame: Frame): RuntimeFunction | null {
  for (let f: Frame | null = frame; f; f = f.parent) if (f.runtime) return f.runtime
  return null
}

/** The value of an expression in the walked served code, as far as it can be known without running anything. */
async function evaluate(walk: Walk, frame: Frame, path: NodePath, stack: Set<object> = new Set()): Promise<Value> {
  const node = path.node
  if (stack.has(node)) return UNKNOWN
  stack.add(node)
  try {
    switch (node.type) {
      case 'StringLiteral':
      case 'NumericLiteral':
      case 'BooleanLiteral':
        return { kind: 'primitive', value: node.value }
      case 'NullLiteral':
        return { kind: 'primitive', value: null }
      case 'TemplateLiteral': {
        let out = ''
        const expressions = path.get('expressions')
        for (let i = 0; i < node.quasis.length; i++) {
          out += node.quasis[i].value.cooked ?? node.quasis[i].value.raw
          const expression = expressions[i]
          if (!expression) continue
          const value = await evaluate(walk, frame, expression, stack)
          if (value.kind !== 'primitive') return UNKNOWN
          out += String(value.value)
        }
        return { kind: 'primitive', value: out }
      }
      case 'ThisExpression': {
        // Arrows take `this` from where they are written.
        let owner = path.getFunctionParent()
        while (owner?.isArrowFunctionExpression()) owner = owner.parentPath.getFunctionParent()
        for (let f: Frame | null = frame; f; f = f.parent) if (owner && f.side.fn === owner) return f.thisValue
        return UNKNOWN
      }
      case 'Identifier':
        return await evaluateIdentifier(walk, frame, path, node.name, stack)
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const object = await evaluate(walk, frame, path.get('object') as NodePath, stack)
        let key: string | null = null
        if (!node.computed && node.property.type === 'Identifier') key = node.property.name
        else if (node.computed) {
          const computed = await evaluate(walk, frame, path.get('property') as NodePath, stack)
          if (computed.kind === 'primitive') key = String(computed.value)
        }
        if (key === null) return UNKNOWN
        if (object.kind === 'event') {
          if (key === 'type') return { kind: 'primitive', value: object.type }
          if (key === 'currentTarget') return object.currentTarget
          return UNKNOWN
        }
        if (object.kind === 'remote') return await propertyOf(walk.ctx, object.object, key)
        return UNKNOWN
      }
      case 'BinaryExpression': {
        if (node.operator !== '+') return UNKNOWN
        const left = await evaluate(walk, frame, path.get('left') as NodePath, stack)
        const right = await evaluate(walk, frame, path.get('right') as NodePath, stack)
        if (left.kind !== 'primitive' || right.kind !== 'primitive') return UNKNOWN
        if (typeof left.value === 'number' && typeof right.value === 'number') return { kind: 'primitive', value: left.value + right.value }
        if (typeof left.value !== 'string' && typeof right.value !== 'string') return UNKNOWN
        return { kind: 'primitive', value: String(left.value) + String(right.value) }
      }
      case 'LogicalExpression': {
        const left = await evaluate(walk, frame, path.get('left') as NodePath, stack)
        if (node.operator === '??') {
          if (left.kind === 'primitive' && left.value == null) return await evaluate(walk, frame, path.get('right') as NodePath, stack)
          return left.kind === 'unknown' ? UNKNOWN : left
        }
        const test = truthy(left)
        if (test === null) return UNKNOWN
        if (node.operator === '||') return test ? left : await evaluate(walk, frame, path.get('right') as NodePath, stack)
        return test ? await evaluate(walk, frame, path.get('right') as NodePath, stack) : left
      }
      case 'ConditionalExpression': {
        const test = truthy(await evaluate(walk, frame, path.get('test') as NodePath, stack))
        if (test === null) return UNKNOWN
        return await evaluate(walk, frame, path.get(test ? 'consequent' : 'alternate') as NodePath, stack)
      }
      case 'SequenceExpression': {
        const expressions = path.get('expressions') as NodePath[]
        const last = expressions[expressions.length - 1]
        return last ? await evaluate(walk, frame, last, stack) : UNKNOWN
      }
      case 'AssignmentExpression':
        return node.operator === '=' ? await evaluate(walk, frame, path.get('right') as NodePath, stack) : UNKNOWN
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
        return await evaluate(walk, frame, path.get('expression') as NodePath, stack)
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return { kind: 'local', path, frame }
      default:
        return UNKNOWN
    }
  } finally {
    stack.delete(node)
  }
}

async function evaluateIdentifier(walk: Walk, frame: Frame, path: NodePath, name: string, stack: Set<object>): Promise<Value> {
  const binding = path.scope.getBinding(name)
  if (binding) {
    const owner = frameDeclaring(frame, binding.scope.path)
    if (owner) {
      // Declared inside a walked function: its value comes from the frame, not from a closure.
      if (binding.kind === 'param') {
        const index = paramIndex(owner.side.fn, binding.identifier)
        if (index < 0) return UNKNOWN
        return owner.args[index] ?? { kind: 'primitive', value: undefined }
      }
      if (binding.path.isFunctionDeclaration()) return { kind: 'local', path: binding.path, frame: owner }
      if (binding.constant && binding.path.isVariableDeclarator() && binding.path.node.id === binding.identifier) {
        const init = binding.path.get('init')
        if (init.node) return await evaluate(walk, owner, init as NodePath, stack)
      }
      return UNKNOWN
    }
  } else if (name === 'undefined') {
    return { kind: 'primitive', value: undefined }
  }
  // A closure variable, a module binding (imports included) or a global: ask the live closure.
  const runtime = runtimeOf(frame)
  return runtime ? await scopeLookup(walk.ctx, runtime, name) : UNKNOWN
}

/** Index of a plain (or defaulted) identifier parameter; -1 for patterns and rest parameters. */
function paramIndex(fn: NodePath, identifier: BabelNode): number {
  const node = fn.node
  if (!('params' in node)) return -1
  return node.params.findIndex((param) => param === identifier || (param.type === 'AssignmentPattern' && param.left === identifier))
}

/** The call expression in the original code that a served call was compiled from, through the sourcemap. */
function originalCallOf(code: LocatedCode, call: NodePath<CallLike>): { path: NodePath<CallLike>; code: string } | null {
  const original = code.original
  if (!original) return null
  if (!code.map || original === code.served) return { path: call, code: original.parsed.code }
  const calleeStart = call.node.callee.loc?.start
  if (!calleeStart) return null
  const position = originalPositionOf(code.map, calleeStart.line - 1, calleeStart.column)
  if (!position) return null
  let exact: NodePath<CallLike> | null = null
  let innermost: NodePath<CallLike> | null = null
  const visit = (path: NodePath<CallLike>): void => {
    const callee = path.node.callee.loc
    const whole = path.node.loc
    if (!callee || !whole) return
    if (callee.start.line === position.line && callee.start.column === position.column) exact ??= path
    if (before(whole.start, position) && before(position, whole.end) && (!innermost || nodeSize(path.node) < nodeSize(innermost.node))) innermost = path
  }
  original.fn.traverse({ CallExpression: visit, OptionalCallExpression: visit, NewExpression: visit })
  const found = exact ?? innermost
  return found ? { path: found, code: original.parsed.code } : null
}

interface CallTarget {
  callee: Value
  thisPath: NodePath | null
  thisValue: Value | null
  argPaths: NodePath[]
}

/** What a served call invokes: `f(…)`, `o.m(…)`, and `f.call(t, …)` / `f.apply(t, [...])` (the target is `f`). */
async function callTargetOf(walk: Walk, frame: Frame, call: NodePath<CallLike>): Promise<CallTarget> {
  const callee = call.get('callee') as NodePath
  const args = call.get('arguments') as NodePath[]
  const node = callee.node
  if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed && node.property.type === 'Identifier') {
    const objectPath = callee.get('object') as NodePath
    const method = node.property.name
    if (method === 'call' || method === 'apply') {
      const target = await evaluate(walk, frame, objectPath)
      if (target.kind === 'remote' || target.kind === 'local') {
        const thisPath = args[0] ?? null
        if (method === 'call') return { callee: target, thisPath, thisValue: null, argPaths: args.slice(1) }
        const list = args[1]
        return { callee: target, thisPath, thisValue: null, argPaths: list?.isArrayExpression() ? (list.get('elements') as NodePath[]) : [] }
      }
    }
    return { callee: await evaluate(walk, frame, callee), thisPath: objectPath, thisValue: null, argPaths: args }
  }
  return { callee: await evaluate(walk, frame, callee), thisPath: null, thisValue: UNKNOWN, argPaths: args }
}

/** The name a followed function is shown under: its original declared name, else the runtime name. */
function followedName(code: LocatedCode, runtimeName: string | undefined): string {
  return (code.original && declaredName(code.original.fn)) || runtimeName || '(anonymous)'
}

/**
 * Walk the served function of `frame`: direct effects from its original code, then every call
 * that is not itself an effect is evaluated against the live closure and followed —
 * page code into its own summary (`via`), library code into one call-site effect, and in
 * dispatch mode library code onward until page handlers are reached.
 */
async function walkFunction(walk: Walk, frame: Frame): Promise<RawSummary> {
  walk.visited.add(frame.side.fn.node)
  const out = walk.mode === 'dispatch' || !frame.code.original ? emptySummary() : directSummary(frame.code.original)
  const calls: Array<NodePath<CallLike>> = []
  frame.side.fn.traverse({
    CallExpression(path) {
      calls.push(path)
    },
    OptionalCallExpression(path) {
      calls.push(path)
    },
  })
  const followed = await Promise.all(calls.map((call) => followCall(walk, frame, call)))
  for (const inner of followed) {
    if (!inner) continue
    for (const key of ['network', 'navigation', 'stateSetters'] as const) for (const effect of inner[key]) addEffect(out[key], effect)
    if (inner.preventsDefault) out.preventsDefault = true
  }
  return out
}

async function followCall(walk: Walk, frame: Frame, call: NodePath<CallLike>): Promise<RawSummary | null> {
  const ctx = walk.ctx
  const original = walk.mode === 'dispatch' ? null : originalCallOf(frame.code, call)
  // An effect at the call site is already known; its callee (a platform API, a framework setter) is not walked.
  if (original && callEffect(original.code, original.path)) return null
  const target = await callTargetOf(walk, frame, call)
  const callee = target.callee
  if (callee.kind !== 'remote' && callee.kind !== 'local') return null

  const thisValue = async (): Promise<Value> => target.thisValue ?? (target.thisPath ? await evaluate(walk, frame, target.thisPath) : UNKNOWN)
  const argValues = async (): Promise<Value[]> => await Promise.all(target.argPaths.map((arg) => evaluate(walk, frame, arg)))

  if (callee.kind === 'local') {
    if (walk.visited.has(callee.path.node) || !enterFunction(walk)) return null
    walk.visited.add(callee.path.node)
    const code = await locateLocal(ctx, frame.code, callee.path)
    const inner = await walkFunction(walk, {
      parent: callee.frame,
      runtime: null,
      code,
      side: { parsed: frame.side.parsed, fn: callee.path },
      thisValue: await thisValue(),
      args: await argValues(),
    })
    return viaSummary(inner, followedName(code, undefined))
  }

  if (callee.object.type !== 'function') return null
  const fn = await inspectFunction(ctx, callee.object)
  if (fn.native) {
    if (walk.mode === 'dispatch') return null
    return await nativeCallEffect(ctx, fn, await thisValue(), original?.code ?? frame.side.parsed.code, original?.path ?? call)
  }
  const code = await locateFunction(ctx, fn)
  if (!code?.served || walk.visited.has(code.served.fn.node)) return null
  const pageCode = !code.library
  if (walk.mode === 'dispatch' && pageCode) {
    walk.reached.push(fn)
    return null
  }
  // Library code calling back into page code runs it later, not as this call's effect.
  if (walk.mode === 'library' && pageCode) return null
  if (!enterFunction(walk)) return null
  const innerWalk: Walk = walk.mode === 'summary' && !pageCode ? { ...walk, mode: 'library' } : walk
  const args = await argValues()
  const inner = await walkFunction(innerWalk, {
    parent: null,
    runtime: fn,
    code,
    side: code.served,
    thisValue: fn.bound ? fn.boundThis : await thisValue(),
    args: [...fn.boundArgs, ...args],
  })
  if (walk.mode === 'summary' && !pageCode) {
    // Page code calling into a library: the effect is reported where the page calls it.
    const callText = oneLine(sourceOf(original?.code ?? frame.side.parsed.code, (original?.path ?? call).node))
    const collapsed = emptySummary()
    for (const key of ['network', 'navigation', 'stateSetters'] as const) {
      const apis = [...new Set(inner[key].map((effect) => effect.api))]
      if (apis.length) collapsed[key].push({ text: `${callText} → ${apis.join(', ')}`, via: [], api: apis.join(', ') })
    }
    return collapsed
  }
  return viaSummary(inner, followedName(code, fn.name))
}

function viaSummary(inner: RawSummary, name: string): RawSummary {
  const out = emptySummary()
  for (const key of ['network', 'navigation', 'stateSetters'] as const) {
    for (const effect of inner[key]) out[key].push({ ...effect, via: [name, ...effect.via] })
  }
  out.preventsDefault = inner.preventsDefault
  return out
}

/** A native method called on a form (`form.submit()` / `form.requestSubmit()`): a navigation, known from the receiver's class. */
async function nativeCallEffect(
  ctx: ExplainContext,
  fn: RuntimeFunction,
  receiver: Value,
  code: string,
  call: NodePath<CallLike>,
): Promise<RawSummary | null> {
  if (receiver.kind !== 'remote' || receiver.object.className !== 'HTMLFormElement') return null
  if (fn.name !== 'submit' && fn.name !== 'requestSubmit') return null
  const out = emptySummary()
  out.navigation.push({ text: `${oneLine(sourceOf(code, call.node))} (form submission)`, via: [], api: `form.${fn.name}` })
  return out
}

// ---------------------------------------------------------------------------
// Explaining one handler
// ---------------------------------------------------------------------------

type LocatedFunction = Pick<ExplainedHandler, 'functionName' | 'source' | 'frame' | 'summary'>

/** How a handler is invoked: `this` and the arguments before any bound ones are prepended. */
interface Invocation {
  thisValue: Value
  args: Value[]
}

/** Name, location, code frame and summary of a page function; every gap is noted, nothing is guessed. */
async function explainPageFunction(ctx: ExplainContext, fn: RuntimeFunction, code: LocatedCode | null, invocation: Invocation): Promise<LocatedFunction> {
  const result: LocatedFunction = {}
  if (fn.name) result.functionName = fn.name
  if (!code) return result
  if (code.display) result.source = code.display
  const original = code.original
  if (!original) return result
  const originalName = declaredName(original.fn)
  const servedName = code.served ? declaredName(code.served.fn) : undefined
  if (code.map && original !== code.served && originalName && servedName && originalName !== servedName) {
    // The served function is declared under another name than the source: a minifier renamed it.
    result.functionName = originalName
    ctx.renamed = true
  } else if (!result.functionName) {
    const label = functionLabel(original.fn)
    if (label) result.functionName = label
  }
  const start = original.fn.node.loc?.start
  if (start && code.display) {
    const nearby = original.parsed.code.split('\n').slice(Math.max(0, start.line - 3), start.line + 3)
    if (nearby.every((line) => line.length <= 240)) {
      result.frame = renderCodeFrame({ code: original.parsed.code, loc: { line: start.line, column: start.column } })
    } else {
      note(ctx, `${original.parsed.file} is minified; code frames are omitted for it.`)
    }
  }
  if (code.served) {
    const walk: Walk = { ctx, visited: new WeakSet(), mode: 'summary', reached: [], budget: { left: MAX_FOLLOWED_FUNCTIONS, cut: 0 } }
    const raw = await walkFunction(walk, {
      parent: null,
      runtime: fn,
      code,
      side: code.served,
      thisValue: fn.bound ? fn.boundThis : invocation.thisValue,
      args: [...fn.boundArgs, ...invocation.args],
    })
    noteBudget(ctx, walk, result.functionName ?? `the handler at ${code.display}`)
    result.summary = finishSummary(raw)
  } else {
    result.summary = finishSummary(directSummary(original))
  }
  return result
}

interface PendingHandler {
  handler: ExplainedHandler
  /** The listener/prop value as registered (a bound function, an object with handleEvent, a function). */
  registered: Protocol.Runtime.RemoteObject
  /** For an object listener: the `handleEvent` function DOMDebugger resolved. */
  effective?: Protocol.Runtime.RemoteObject
  /** Listener-provided location (DOMDebugger), used when the function itself reports none. */
  location?: V8Location
  invocation: Invocation
}

/** The handler entries a registered listener/prop stands for: itself, or the page handlers a library dispatcher routes to. */
async function explainHandler(ctx: ExplainContext, entry: PendingHandler): Promise<ExplainedHandler[]> {
  const objectListener = entry.registered.type === 'object' && entry.effective
  const fn = await inspectFunction(ctx, objectListener ? entry.effective! : entry.registered)
  const invocation: Invocation = objectListener ? { ...entry.invocation, thisValue: valueOf(entry.registered) } : entry.invocation
  if (!fn.location && entry.location) fn.location = entry.location
  if (fn.native) {
    note(ctx, `A handler is a native/host function (${fn.name ?? 'anonymous'}); there is no page source for it.`)
    return [{ ...entry.handler, ...(fn.name ? { functionName: fn.name } : {}) }]
  }
  const code = await locateFunction(ctx, fn)
  if (!code?.library || !code.served) return [{ ...entry.handler, ...(await explainPageFunction(ctx, fn, code, invocation)) }]

  // Library code (on the sourcemap's ignoreList): follow its dispatch to the page handlers it calls.
  const walk: Walk = { ctx, visited: new WeakSet(), mode: 'dispatch', reached: [], budget: { left: MAX_FOLLOWED_FUNCTIONS, cut: 0 } }
  await walkFunction(walk, {
    parent: null,
    runtime: fn,
    code,
    side: code.served,
    thisValue: fn.bound ? fn.boundThis : invocation.thisValue,
    args: [...fn.boundArgs, ...invocation.args],
  })
  noteBudget(ctx, walk, `the library listener at ${code.display}`)
  const dispatcherName = followedName(code, fn.name)
  const dispatchedBy = `${dispatcherName}${code.display ? ` (${code.display})` : ''}`
  if (walk.reached.length === 0) {
    note(
      ctx,
      `${dispatcherName} (${code.display}) is library code (on its sourcemap's ignoreList) listening for ${entry.handler.event}; the page handler it dispatches to could not be followed from the values it reads.`,
    )
    return [{ ...entry.handler, functionName: dispatcherName, source: code.display, library: true }]
  }
  const seen = new Set<string>()
  const handlers: ExplainedHandler[] = []
  for (const reached of walk.reached) {
    const at = reached.location
    const key = at ? `${at.scriptId}:${at.lineNumber}:${at.columnNumber}` : (reached.object.objectId ?? '')
    if (seen.has(key)) continue
    seen.add(key)
    const reachedCode = await locateFunction(ctx, reached)
    const located = await explainPageFunction(ctx, reached, reachedCode, { thisValue: UNKNOWN, args: invocation.args })
    handlers.push({ ...entry.handler, ...located, dispatchedBy })
  }
  return handlers
}

// ---------------------------------------------------------------------------
// explainElement
// ---------------------------------------------------------------------------

interface PathNode {
  objectId: string
  label: string
  kind: PathEntry['kind']
  backendNodeId?: number
}

/** Read `[JSON, ...objects]` returned by reference: the parsed JSON and the objects by 1-based index. */
async function readByReference(ctx: ExplainContext, result: Protocol.Runtime.CallFunctionOnResponse, what: string): Promise<{ json: unknown; slot: Map<number, Protocol.Runtime.RemoteObject> }> {
  if (result.exceptionDetails || !result.result.objectId) {
    const reason = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? 'no result'
    throw new Error(`${what} failed in the page: ${reason}`)
  }
  const slots = await send(ctx.cdp.send('Runtime.getProperties', { objectId: result.result.objectId, ownProperties: true }), `reading the result of ${what}`)
  const slot = new Map<number, Protocol.Runtime.RemoteObject>()
  for (const prop of slots.result) {
    if (/^\d+$/.test(prop.name) && prop.value) slot.set(Number(prop.name), prop.value)
  }
  return { json: JSON.parse(String(slot.get(0)?.value ?? 'null')), slot }
}

function pathNodes(entries: PathEntry[], slot: Map<number, Protocol.Runtime.RemoteObject>): PathNode[] {
  const nodes: PathNode[] = []
  for (const entry of entries) {
    const objectId = slot.get(entry.ref)?.objectId
    if (objectId) nodes.push({ objectId, label: entry.label, kind: entry.kind })
  }
  return nodes
}

/**
 * Give every path node its backendNodeId and repair the hops the main world cannot see: a node
 * slotted into a CLOSED shadow root has `assignedSlot === null` in the page, while
 * `DOM.describeNode` reports the slot; the path is re-read from that slot.
 */
async function completeEventPath(ctx: ExplainContext, element: PathNode, path: PathNode[]): Promise<PathNode[]> {
  const describe = async (node: PathNode): Promise<Protocol.DOM.Node | null> => {
    if (node.kind === 'window') return null
    return (await send(ctx.cdp.send('DOM.describeNode', { objectId: node.objectId }), `describing ${node.label}`)).node
  }
  let chain = [element, ...path]
  let described = await Promise.all(chain.map(describe))
  for (let i = 0; i < chain.length; i++) {
    const node = described[i]
    if (node) chain[i].backendNodeId = node.backendNodeId
    const slot = node?.assignedSlot
    if (!slot || described[i + 1]?.backendNodeId === slot.backendNodeId) continue
    const resolved = await send(ctx.cdp.send('DOM.resolveNode', { backendNodeId: slot.backendNodeId, objectGroup: ctx.objectGroup }), 'resolving an assigned slot')
    if (!resolved.object.objectId) continue
    const called = await send(
      ctx.cdp.send('Runtime.callFunctionOn', { objectId: resolved.object.objectId, functionDeclaration: PATH_FROM_FUNCTION, returnByValue: false, objectGroup: ctx.objectGroup }),
      'reading the event path from a closed shadow root slot',
    )
    const read = await readByReference(ctx, called, 'reading the event path')
    // Shape produced by PATH_FROM_FUNCTION above, serialised by the page itself.
    const tail = pathNodes(read.json as PathEntry[], read.slot)
    chain = [...chain.slice(0, i + 1), ...tail]
    described = [...described.slice(0, i + 1), ...(await Promise.all(tail.map(describe)))]
  }
  return chain.slice(1)
}

/** A listener bound (Function.prototype.bind) with the very node it listens on among its arguments. */
async function boundToNode(ctx: ExplainContext, fn: RuntimeFunction, backendNodeId: number | undefined): Promise<boolean> {
  if (backendNodeId === undefined) return false
  for (const arg of fn.boundArgs) {
    if (arg.kind !== 'remote' || arg.object.subtype !== 'node' || !arg.object.objectId) continue
    const described = await send(ctx.cdp.send('DOM.describeNode', { objectId: arg.object.objectId }), 'describing a bound listener argument')
    if (described.node.backendNodeId === backendNodeId) return true
  }
  return false
}

/** DOM event a React prop listens to (`onClickCapture` → `click`, `onDoubleClick` → `dblclick`). */
function reactPropEvent(prop: string): string {
  const name = prop.replace(/^on/, '').replace(/Capture$/, '').toLowerCase()
  return REACT_PROP_DOM_EVENT[name] ?? name
}

/**
 * Explains the element `backendNodeId` of frame `frameId`. Every call for the node runs on the session that owns the
 * frame's document (an OOPIF's own session; the page session for same-process frames), because backendNodeIds,
 * objectIds and scriptIds are scoped to the renderer process. The event path ends at the frame's own window: DOM
 * events do not propagate across a frame boundary, so the parent document's listeners never see this element's events.
 */
export async function explainElement(options: {
  page: Page
  frames: PageFrames
  frameId: string
  backendNodeId: number
  maxHandlers?: number
  /** The open native dialog, when the caller tracks one: the page cannot answer while it is open. */
  jsDialog?: JsDialogState | null
}): Promise<ElementExplanation> {
  const { page, frames, frameId, backendNodeId } = options
  const maxHandlers = options.maxHandlers ?? DEFAULT_MAX_HANDLERS
  const dialog = options.jsDialog
  if (dialog && !dialog.outcome) {
    throw new Error(
      `Cannot explain while a native ${dialog.type} dialog is open ("${oneLine(dialog.message, 80)}"): the page answers nothing until it is accepted or dismissed.`,
    )
  }
  const handle = await frames.handle(frameId)
  const cdp = handle.cdp
  // The frame's own document address (Playwright's frame.url() is '' for an iframe that loaded
  // before a relay tab was attached). An opaque origin (about:, data:) has nothing to shorten against.
  const documentUrl = await frames.documentUrl(frameId)
  const origin = URL.canParse(documentUrl) ? new URL(documentUrl).origin : 'null'
  const documentOrigin: string | null = origin === 'null' ? null : origin
  let cache = pageCodeCaches.get(page)
  if (!cache) {
    cache = { sourceMaps: new LruCache(MAX_CACHED_SOURCEMAPS), sourceReads: new Map(), parsed: new LruCache(MAX_CACHED_PARSES) }
    pageCodeCaches.set(page, cache)
  }
  const objectGroup = `playwriter-explain-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const ctx: ExplainContext = {
    cdp,
    debuggerDomain: debuggerDomainFor(cdp),
    cache,
    objectGroup,
    notes: [],
    noted: new Set(),
    properties: new Map(),
    functions: new Map(),
    frameId,
    documentOrigin,
    renamed: false,
  }
  try {
    await send(cdp.send('DOM.enable', {}), 'enabling the DOM domain')
    let described: Protocol.DOM.DescribeNodeResponse
    try {
      described = await send(cdp.send('DOM.describeNode', { backendNodeId }), `describing node ${backendNodeId}`)
    } catch (error) {
      if (error instanceof PageUnresponsiveError) throw error
      throw new ExplainError(`Node ${backendNodeId} is not on the page any more (${errorText(error)}). Observe the page again and use a fresh ref.`)
    }
    const node = described.node
    if (node.nodeType !== 1) throw new ExplainError(`Node ${backendNodeId} is a ${node.nodeName} node, not an element.`)
    const attributes: Record<string, string> = {}
    const flat = node.attributes ?? []
    for (let i = 0; i + 1 < flat.length; i += 2) attributes[flat[i]] = flat[i + 1]
    const tag = (node.localName || node.nodeName).toLowerCase()

    // Main world (no executionContextId): the only realm that sees React's and other frameworks' expandos.
    const resolved = await send(cdp.send('DOM.resolveNode', { backendNodeId, objectGroup }), `resolving node ${backendNodeId}`)
    const elementId = resolved.object.objectId
    if (!elementId) throw new ExplainError(`Node ${backendNodeId} could not be resolved in the page.`)
    const called = await send(
      cdp.send('Runtime.callFunctionOn', {
        objectId: elementId,
        functionDeclaration: PAGE_READ_FUNCTION,
        arguments: [{ value: { maxComponents: MAX_COMPONENTS } }],
        returnByValue: false,
        objectGroup,
      }),
      'reading the element, its React fiber and its event path',
    )
    const pageRead = await readByReference(ctx, called, 'reading the element')
    const slot = pageRead.slot
    // Shape produced by PAGE_READ_FUNCTION above, serialised by the page itself.
    const read = pageRead.json as PageRead | null
    if (!read) throw new Error('The element probe returned nothing.')

    const explanation: ElementExplanation = { backendNodeId, tag, attributes, handlers: [], notes: ctx.notes }
    if (read.name) explanation.name = read.name
    const action = read.defaultAction
    if (action?.kind === 'link') {
      explanation.defaultAction = `follows link → ${action.href}${action.target ? ` (target=${action.target})` : ''}`
    } else if (action?.kind === 'submit') {
      explanation.defaultAction = `submits ${action.form} → ${action.method} ${action.action || '(this page URL)'}`
    }

    // ---- handlers, in the order they matter: on the element, its wrappers, inside it, then up the event path
    const react = read.react
    const seenFns = new Set<number>()
    const propHandlers = (filter: (p: FiberHandlerProp) => boolean): PendingHandler[] => {
      const out: PendingHandler[] = []
      for (const p of react?.handlers ?? []) {
        const fn = slot.get(p.fn)
        if (!filter(p) || seenFns.has(p.fn) || !fn) continue
        seenFns.add(p.fn)
        const handler: ExplainedHandler = { event: p.prop, origin: 'react-prop' }
        if (p.holder === 'component') {
          handler.component = p.label
          handler.target = `<${p.label}>`
        } else {
          if (p.owner) handler.component = p.owner
          if (p.depth > 0) handler.target = p.label
        }
        out.push({ handler, registered: fn, invocation: { thisValue: UNKNOWN, args: [UNKNOWN] } })
      }
      return out
    }

    const element: PathNode = { objectId: elementId, label: tag, kind: 'element', backendNodeId }
    const path = await completeEventPath(ctx, element, pathNodes(read.path, slot))
    // The element with its whole subtree (shadow roots included): a click lands on its deepest node.
    // Above it, only the listeners on each path node itself run.
    const listenerLists = await Promise.all(
      [element, ...path].map(async (target, index) => {
        const params = index === 0 ? { objectId: target.objectId, depth: -1, pierce: true } : { objectId: target.objectId, depth: 0 }
        try {
          return (await send(cdp.send('DOMDebugger.getEventListeners', params), `reading listeners of ${target.label}`)).listeners
        } catch (error) {
          if (error instanceof PageUnresponsiveError) throw error
          note(ctx, `Native listeners of ${target.label} could not be read (${errorText(error)}).`)
          return []
        }
      }),
    )
    // Playwright's own injected script (installed in the MAIN world by any locator wait) is only
    // recognisable by its marker listener `__playwright_global_listeners_check__` on window;
    // every other listener from that script is automation, not page code.
    const automationScripts = new Set<string>()
    for (const listener of listenerLists.flat()) if (listener.type.startsWith('__playwright')) automationScripts.add(listener.scriptId)
    const skipped = { automation: 0, otherWorld: 0, empty: 0, reactDispatch: new Set<string>(), reactDirect: new Set<string>() }
    const descendantLabels = new Map<number, Promise<string>>()
    const labelOfDescendant = (id: number): Promise<string> => {
      let pending = descendantLabels.get(id)
      if (!pending) {
        pending = send(cdp.send('DOM.describeNode', { backendNodeId: id }), 'describing a node inside the element').then((r) => describedLabel(r.node))
        descendantLabels.set(id, pending)
      }
      return pending
    }

    const nativeGroups = await Promise.all(
      [element, ...path].map(async (target, index): Promise<{ own: PendingHandler[]; inside: PendingHandler[] }> => {
        const grouped = new Map<string, PendingHandler>()
        const own: PendingHandler[] = []
        const inside: PendingHandler[] = []
        for (const listener of listenerLists[index]) {
          const onDescendant = index === 0 && listener.backendNodeId !== undefined && listener.backendNodeId !== backendNodeId
          // Away from the element itself, only bubbling input events concern it.
          if ((index > 0 || onDescendant) && !INTERACTION_EVENTS[listener.type]) continue
          if (automationScripts.has(listener.scriptId)) {
            skipped.automation++
            continue
          }
          if (!listener.handler) {
            // getEventListeners wraps handlers in the realm of the queried object (the main
            // world); a listener added from an isolated world comes back without one.
            skipped.otherWorld++
            continue
          }
          if (EMPTY_FUNCTION.test(listener.handler.description ?? '')) {
            skipped.empty++
            continue
          }
          const registered = listener.originalHandler ?? listener.handler
          if (react && registered.type === 'function') {
            // React's event system binds its listener wrapper to the node it listens on (the
            // root container, or the element for non-delegated events) and dispatches to props.
            const listening = onDescendant ? listener.backendNodeId : target.backendNodeId
            if (await boundToNode(ctx, await inspectFunction(ctx, registered), listening)) {
              if (index === 0 && !onDescendant) skipped.reactDirect.add(listener.type)
              else skipped.reactDispatch.add(listener.type)
              continue
            }
          }
          const event = listener.useCapture ? `${listener.type} (capture)` : listener.type
          // One function registered for several events (common with jQuery/analytics) is one entry.
          const key = `${listener.backendNodeId ?? index}:${listener.scriptId}:${listener.lineNumber}:${listener.columnNumber}`
          const existing = grouped.get(key)
          if (existing) {
            existing.handler.event += `, ${event}`
            continue
          }
          const handler: ExplainedHandler = { event, origin: 'dom' }
          let currentTarget: Value = { kind: 'remote', object: { type: 'object', subtype: 'node', objectId: target.objectId } }
          if (onDescendant) {
            handler.target = await labelOfDescendant(listener.backendNodeId!)
            handler.descendant = true
            currentTarget = UNKNOWN
          } else if (index > 0) {
            handler.target = target.label
            handler.delegated = true
          }
          if (onDescendant && listener.backendNodeId !== undefined) {
            const node = await send(cdp.send('DOM.resolveNode', { backendNodeId: listener.backendNodeId, objectGroup }), 'resolving a node inside the element')
            if (node.object.objectId) currentTarget = { kind: 'remote', object: node.object }
          }
          const pending: PendingHandler = {
            handler,
            registered,
            effective: listener.handler,
            location: { scriptId: listener.scriptId, lineNumber: listener.lineNumber, columnNumber: listener.columnNumber },
            invocation: { thisValue: currentTarget, args: [{ kind: 'event', type: listener.type, currentTarget }] },
          }
          grouped.set(key, pending)
          ;(onDescendant ? inside : own).push(pending)
        }
        return { own, inside }
      }),
    )

    // React props: on the element and its wrapping components always; on host ancestors only
    // for the bubbling input events that reach them from the element.
    const pending: PendingHandler[] = [
      ...propHandlers((p) => p.holder === 'host' && p.depth === 0),
      ...nativeGroups[0].own,
      ...propHandlers((p) => p.holder === 'component'),
      ...nativeGroups[0].inside,
      ...propHandlers((p) => p.holder === 'host' && p.depth > 0 && INTERACTION_EVENTS[reactPropEvent(p.prop)] === true),
      ...nativeGroups.slice(1).flatMap((group) => group.own),
    ]

    let omitted = 0
    if (pending.length > maxHandlers) {
      omitted = pending.length - maxHandlers
      pending.length = maxHandlers
    }
    const reactRoot = read.reactRoot
    if (react && (reactRoot || skipped.reactDispatch.size > 0)) {
      note(
        ctx,
        `React handles events through its own listeners on the root container ${reactRoot ?? '(unknown)'} and dispatches them to the React props listed here; those root listeners are React's dispatcher, not handlers of this element.`,
      )
    }
    if (skipped.reactDirect.size > 0) {
      note(ctx, `React also listens for ${[...skipped.reactDirect].join(', ')} directly on this element; that is React's dispatcher, not a page handler.`)
    }
    if (skipped.automation > 0) note(ctx, `${skipped.automation} listener(s) installed by Playwright's injected script (the automation layer) are not shown.`)
    if (skipped.empty > 0) note(ctx, `${skipped.empty} empty listener(s) (a function with no body, e.g. React's iOS click no-op) are not shown.`)
    if (skipped.otherWorld > 0) {
      note(ctx, `${skipped.otherWorld} listener(s) belong to another JavaScript world (a browser extension or the automation layer) and are not shown.`)
    }

    // ---- locate + summarise handlers and components
    const located = await Promise.all(
      pending.map(async (entry): Promise<ExplainedHandler[]> => {
        try {
          return await explainHandler(ctx, entry)
        } catch (error) {
          if (error instanceof PageUnresponsiveError) throw error
          note(ctx, `Handler ${entry.handler.event} could not be located (${errorText(error)}).`)
          return [entry.handler]
        }
      }),
    )
    // A wrapper's prop can hold an older closure of the same function (props of a fiber that
    // did not re-render): same source and name means the same handler, listed once.
    const listed = new Set<string>()
    const handlers = located.flat().filter((h) => {
      if (h.origin !== 'react-prop' || !h.source) return true
      const key = `${h.source}|${h.functionName ?? ''}`
      if (listed.has(key)) return false
      listed.add(key)
      return true
    })
    if (handlers.length > maxHandlers) {
      // A dispatcher can route to more page handlers than it occupied slots.
      omitted += handlers.length - maxHandlers
      handlers.length = maxHandlers
    }
    explanation.handlers = handlers
    if (omitted > 0) explanation.omittedHandlers = omitted

    if (react) {
      const components = await Promise.all(
        react.components.map(async (component) => {
          const out: { name: string; source?: string } = { name: component.name ?? 'Anonymous' }
          const fnObject = slot.get(component.fn)
          if (fnObject) {
            try {
              const fn = await inspectFunction(ctx, fnObject)
              const code = await locateFunction(ctx, fn)
              if (code?.display) out.source = code.display
              const originalName = code?.original ? declaredName(code.original.fn) : undefined
              const servedName = code?.served ? declaredName(code.served.fn) : undefined
              if (code?.map && code.original !== code.served && originalName && servedName && originalName !== servedName) {
                out.name = originalName
                ctx.renamed = true
              }
            } catch (error) {
              if (error instanceof PageUnresponsiveError) throw error
              note(ctx, `Component ${out.name} could not be located (${errorText(error)}).`)
            }
          }
          if (!out.source && component.debugSource) {
            const fileName = displaySource(component.debugSource.fileName, ctx.documentOrigin)
            out.source = component.debugSource.lineNumber ? `${fileName}:${component.debugSource.lineNumber}` : fileName
          }
          return out
        }),
      )
      explanation.react = { components }
      if (react.moreComponents > 0) note(ctx, `${react.moreComponents} outer component(s) omitted from the chain (the chain lists ${MAX_COMPONENTS}).`)
      if (react.frames.length > 0) {
        const locatedSource = await locateReactSource(react, {
          fetchText: (url) => fetchText(ctx, url),
          displayPath: (source) => displaySource(source, ctx.documentOrigin),
        })
        if (locatedSource.ok) {
          explanation.react.renderedAt = formatReactSourceLocation(locatedSource.location)
          if (locatedSource.location.note) note(ctx, `Render site: ${locatedSource.location.note}`)
        } else {
          note(ctx, locatedSource.error)
        }
      } else if (react.hasDebugOwner) {
        note(ctx, 'React dev build without _debugSource/_debugStack on this element (React 19 without owner stacks?); its render site is unknown.')
      } else {
        note(ctx, 'Production React build: no _debugSource/_debugStack, so render sites are unknown and component names may be minified.')
      }
    }
    if (ctx.renamed) note(ctx, MINIFIED_NAMES_NOTE)
    // Pauses the Debugger owner resumed on its own (a `debugger;` statement, a breakpoint nobody holds) while explain had it enabled.
    for (const resumed of ctx.debuggerDomain.takeResumeNotes()) note(ctx, resumed)
    return explanation
  } finally {
    cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// renderExplanation
// ---------------------------------------------------------------------------

/**
 * Short text for a weak model. A file path is shown in full the first time and as
 * `basename:line` afterwards when that basename is unambiguous.
 */
export function renderExplanation(explanation: ElementExplanation): string {
  const fileOf = (source: string): string => source.replace(/:\d+(:\d+)?$/, '')
  const baseOf = (file: string): string => file.slice(file.lastIndexOf('/') + 1)
  const sources = [
    ...(explanation.react?.components.map((c) => c.source) ?? []),
    explanation.react?.renderedAt,
    ...explanation.handlers.map((h) => h.source),
  ].filter((s): s is string => !!s)
  const filesByBase = new Map<string, Set<string>>()
  for (const source of sources) {
    const file = fileOf(source)
    const files = filesByBase.get(baseOf(file)) ?? new Set<string>()
    files.add(file)
    filesByBase.set(baseOf(file), files)
  }
  const shownFiles = new Set<string>()
  const where = (source: string): string => {
    const file = fileOf(source)
    if (!shownFiles.has(file)) {
      shownFiles.add(file)
      return source
    }
    return filesByBase.get(baseOf(file))?.size === 1 ? baseOf(file) + source.slice(file.length) : source
  }

  const attrs = explanation.attributes
  let label = explanation.tag
  if (attrs.id) label += `#${attrs.id}`
  else if (attrs.class) label += attrs.class.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('')
  let head = explanation.name ? `${explanation.tag} "${explanation.name}" (${label})` : label
  const react = explanation.react
  if (react && react.components.length) {
    const shown = react.components.slice(0, 6).map((c) => (c.source ? `${c.name} (${where(c.source)})` : c.name))
    const more = react.components.length > 6 ? ` › … (+${react.components.length - 6})` : ''
    head += ` — React: ${shown.join(' › ')}${more}`
  }
  const lines = [head]
  if (react?.renderedAt) lines.push(`  rendered at ${where(react.renderedAt)}`)
  if (explanation.defaultAction) lines.push(`  default: ${explanation.defaultAction}`)
  for (const handler of explanation.handlers) {
    let on = ''
    if (handler.delegated) on = ` (delegated: listens on ${handler.target})`
    else if (handler.descendant) on = ` on ${handler.target} (inside the element)`
    else if (handler.target) on = ` on ${handler.target}`
    const at = handler.source ? ` (${where(handler.source)})` : ''
    // V8 names an inline JSX arrow after its prop (`onChange: (e) => …`), which reads as a tautology.
    const fnLabel = !handler.functionName ? '(anonymous)' : handler.functionName === handler.event ? 'inline function' : handler.functionName
    const dispatched = handler.dispatchedBy ? `, dispatched by ${handler.dispatchedBy}` : ''
    const library = handler.library ? ' [library code; its page handler could not be followed]' : ''
    lines.push(`  ${handler.event}${on} → ${fnLabel}${at}${dispatched}${library}`)
    const s = handler.summary
    if (!s) continue
    const effects = [...(s.preventsDefault ? ['preventDefault'] : []), ...s.network, ...s.navigation, ...s.stateSetters]
    if (effects.length) lines.push(`    ${effects.join(' · ')}`)
    else if (s.calls.length) {
      const more = s.calls.length > CALLS_SHOWN ? ` (+${s.calls.length - CALLS_SHOWN} more)` : ''
      lines.push(`    calls ${s.calls.slice(0, CALLS_SHOWN).map((c) => `${c}()`).join(', ')}${more}`)
    } else lines.push('    (no calls)')
  }
  if (explanation.omittedHandlers) lines.push(`  +${explanation.omittedHandlers} handlers not shown (maxHandlers)`)
  if (explanation.handlers.length === 0 && !explanation.omittedHandlers) lines.push('  no handlers found on the element, inside it, or on its event path')
  for (const text of explanation.notes) lines.push(`  note: ${text}`)
  return lines.join('\n')
}
