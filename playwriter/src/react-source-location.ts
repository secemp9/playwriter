/**
 * react-source-location.ts — the ONE read-only React fiber reader and the ONE symbolicator
 * for React's debug stacks. Nothing is injected into the page.
 *
 * Consumers: the extension's "Copy React component source" picker (bundled into the service
 * worker, so this module stays free of Node built-ins), `react-source.ts`
 * (`getReactSource` / `getReactComponentInfo`), `element-explain.ts` and `trace.ts`.
 *
 *   1. `REACT_FIBER_READER` is page-side source (function declarations only) embedded in a
 *      `Runtime.callFunctionOn` body whose `this` is a main-world DOM element — React's fiber
 *      expandos (`__reactFiber$…`, `__reactProps$…`) are plain JS properties of the main
 *      world's DOM wrappers, so an isolated world cannot see them. It defines nothing outside
 *      its own call, assigns nothing on page objects, adds no listener and returns plain data:
 *      per fiber, React ≤18's `_debugSource` and React 19's `_debugStack.stack` string; per
 *      composite component, its name, debug records and (on request) serialised props; and,
 *      when the caller collects objects by reference, the `on*` handler props.
 *      `READ_REACT_FIBER_FUNCTION` is the by-value wrapper (`returnByValue: true`).
 *   2. `createSymbolicator` maps a `_debugStack` JSX frame to `file:line` OUTSIDE the page,
 *      through the script's source map fetched by the caller's `fetchText` (the extension's
 *      service worker fetch, or CDP's `Network.loadNetworkResource` from Node — neither is a
 *      request the page makes or sees).
 *
 * Measured React 19.2 shape (host fiber): `_debugStack.stack` is
 * "Error: react-stack-top-frame\n    at exports.jsxDEV (…)\n    at SendButton (url:line:col)…" —
 * the frame right after the jsxDEV/createElement frame is the JSX site, 1-based line/col.
 */

import {
  FlattenMap,
  originalPositionFor,
  type InvalidOriginalMapping,
  type OriginalMapping,
  type TraceMap,
} from '@jridgewell/trace-mapping'

/** A prop value as read out of the page: plain JSON, with markers for what JSON cannot carry. */
export type ReactSerializedProp =
  | string
  | number
  | boolean
  | null
  | ReactSerializedProp[]
  | { [key: string]: ReactSerializedProp }

/** React ≤18's own record of where a fiber's JSX was written (dev builds with the JSX source transform). */
export interface FiberDebugSource {
  fileName: string
  lineNumber?: number
  columnNumber?: number
}

/** One fiber's debug info, nearest the element first. Plain data from the page. */
export interface FiberSourceFrame {
  /** Tag name for host fibers, component name for composite ones. */
  element: string | null
  /** The component whose render created this fiber (`_debugOwner`). */
  owner: string | null
  debugSource: FiberDebugSource | null
  debugStack: string | null
}

/** A composite (function/class/memo/forwardRef) fiber above the element, nearest first. */
export interface FiberComponent {
  name: string | null
  /** 1-based index of the component function among the objects returned by reference; 0 when not collected. */
  fn: number
  debugSource: FiberDebugSource | null
  debugStack: string | null
  /** `memoizedProps`, serialised; null unless the read asked for props. */
  props: ReactSerializedProp
}

/** An `on*` React prop holding a function, on the element, its wrapping components or host ancestors. */
export interface FiberHandlerProp {
  prop: string
  /** 1-based index of the handler among the objects returned by reference. */
  fn: number
  holder: 'host' | 'component'
  /** Host ancestors between the element and the holder (0 = the element itself or its wrappers). */
  depth: number
  label: string
  owner: string | null
}

export interface FiberReadOptions {
  /** Composite components reported, nearest first; further ones are only counted. */
  maxComponents: number
  /** Host ancestors whose handler props are collected (only when objects are collected by reference); -1 = every one up to the root. */
  maxAncestors: number
  /** Serialise each reported component's `memoizedProps`. */
  props: boolean
}

export interface FiberReadResult {
  reactFound: boolean
  frames: FiberSourceFrame[]
  components: FiberComponent[]
  moreComponents: number
  /** Empty unless the reader collected objects by reference. */
  handlers: FiberHandlerProp[]
  hasDebugOwner: boolean
}

/** What the source picker needs: only the fibers' debug records. */
export const SOURCE_ONLY_READ: FiberReadOptions = { maxComponents: 0, maxAncestors: 0, props: false }

/**
 * Page-side source, function declarations only, to be embedded in a `Runtime.callFunctionOn`
 * body. `readReactFiber(el, opts, ref)` walks from `el`'s fiber to the HostRoot; `ref`, when
 * given, turns an object into an index of the objects the caller returns by reference
 * (handlers and component functions are only collected then). Everything here reads: own
 * keys, property gets, `Object.prototype.toString`; the only objects written are the fresh
 * result objects. `el[__reactFiber$x]` is set when the node is created and can be the stale
 * alternate after updates, so the fiber is swapped for its alternate unless its `.return`
 * chain ends at the HostRoot that the FiberRoot currently points at (`root.current`).
 * Prop serialisation: strings capped at 300 chars, 20 array items / object keys, depth 3,
 * and `[undefined]`, `[function]`, `[symbol]`, `<n>n`, `[dom-node]`, `[circular]`,
 * `[max-depth]` for what JSON cannot carry.
 */
export const REACT_FIBER_READER = `
function reactKeyStarting(o, prefix) {
  var keys = Object.keys(o)
  for (var i = 0; i < keys.length; i++) if (keys[i].indexOf(prefix) === 0) return keys[i]
  return null
}
function reactNodeLabel(e) {
  if (!e || e.nodeType !== 1) return e && e.nodeName ? String(e.nodeName).toLowerCase() : '?'
  var s = e.localName
  if (e.id) return s + '#' + e.id
  var cls = typeof e.className === 'string' ? e.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : []
  return cls.length ? s + '.' + cls.join('.') : s
}
function reactTypeName(t) {
  if (!t) return null
  if (typeof t === 'string') return t
  if (typeof t === 'function') return t.displayName || t.name || null
  if (typeof t === 'object') {
    if (t.displayName) return t.displayName
    if (typeof t.render === 'function') return t.render.displayName || t.render.name || null
    if (t.type) return reactTypeName(t.type)
  }
  return null
}
function reactComponentFn(t) {
  if (typeof t === 'function') return t
  if (t && typeof t === 'object') {
    if (typeof t.render === 'function') return t.render
    if (t.type) return reactComponentFn(t.type)
  }
  return null
}
function isCompositeReactFiber(f) {
  return f.tag === 0 || f.tag === 1 || f.tag === 2 || f.tag === 11 || f.tag === 14 || f.tag === 15
}
function isHostReactFiber(f) {
  return f.tag === 5 || f.tag === 26 || f.tag === 27
}
function currentReactFiber(el) {
  var key = reactKeyStarting(el, '__reactFiber$') || reactKeyStarting(el, '__reactInternalInstance$')
  if (!key) return null
  var fiber = el[key]
  if (!fiber) return null
  if (fiber.alternate) {
    var r = fiber
    for (var n = 0; r.return && n < 5000; n++) r = r.return
    if (!(r.tag === 3 && r.stateNode && r.stateNode.current === r)) fiber = fiber.alternate
  }
  var suffix = key.slice(key.indexOf('$'))
  return { fiber: fiber, propsKey: (key.indexOf('__reactFiber$') === 0 ? '__reactProps' : '__reactEventHandlers') + suffix }
}
function serializeReactValue(value, depth, seen) {
  if (value === null) return null
  var t = typeof value
  if (t === 'string') return value.length > 300 ? value.slice(0, 300) + '\\u2026[truncated]' : value
  if (t === 'number' || t === 'boolean') return value
  if (t === 'undefined') return '[undefined]'
  if (t === 'function') return '[function]'
  if (t === 'symbol') return '[symbol]'
  if (t === 'bigint') return value.toString() + 'n'
  if (t !== 'object') return '[' + t + ']'
  var tag = Object.prototype.toString.call(value)
  if (tag.indexOf('Element]') >= 0 || tag === '[object Window]' || tag === '[object Document]') return '[dom-node]'
  if (seen.indexOf(value) >= 0) return '[circular]'
  if (depth >= 3) return '[max-depth]'
  seen.push(value)
  var out
  if (Array.isArray(value)) {
    out = []
    for (var i = 0; i < value.length && i < 20; i++) out.push(serializeReactValue(value[i], depth + 1, seen))
    if (value.length > 20) out.push('\\u2026[' + (value.length - 20) + ' more]')
  } else {
    out = Object.create(null)
    var keys = Object.keys(value)
    for (var k = 0; k < keys.length && k < 20; k++) out[keys[k]] = serializeReactValue(value[keys[k]], depth + 1, seen)
    if (keys.length > 20) out['\\u2026'] = '[' + (keys.length - 20) + ' more keys]'
  }
  seen.pop()
  return out
}
function readReactFiber(el, opts, ref) {
  var read = { reactFound: false, frames: [], components: [], moreComponents: 0, handlers: [], hasDebugOwner: false }
  var found = currentReactFiber(el)
  if (!found) return read
  read.reactFound = true
  var fiber = found.fiber
  read.hasDebugOwner = !!fiber._debugOwner
  function ownerName(f) {
    var o = f._debugOwner
    return o ? reactTypeName(o.type) || (typeof o.name === 'string' ? o.name : null) : null
  }
  function handlerOwner(f) {
    if (f._debugOwner) return ownerName(f)
    for (var p = f.return; p; p = p.return) if (isCompositeReactFiber(p)) return reactTypeName(p.type)
    return null
  }
  function debugSourceOf(f) {
    var s = f._debugSource
    if (!s || typeof s.fileName !== 'string') return null
    return {
      fileName: s.fileName,
      lineNumber: typeof s.lineNumber === 'number' ? s.lineNumber : undefined,
      columnNumber: typeof s.columnNumber === 'number' ? s.columnNumber : undefined,
    }
  }
  function debugStackOf(f) {
    var s = f._debugStack
    return s && typeof s.stack === 'string' ? s.stack.slice(0, 4000) : null
  }
  function collect(props, holder, depth, label, owner) {
    if (!props || typeof props !== 'object') return
    var keys = Object.keys(props)
    for (var k = 0; k < keys.length; k++) {
      if (!/^on[A-Z]/.test(keys[k])) continue
      var v = props[keys[k]]
      if (typeof v !== 'function') continue
      read.handlers.push({ prop: keys[k], fn: ref(v), holder: holder, depth: depth, label: label, owner: owner })
    }
  }
  var hosts = 0
  var lastFn = null
  for (var f = fiber, steps = 0; f && steps < 2000; f = f.return, steps++) {
    if (f.tag === 3) break
    if (read.frames.length < 12) {
      var source = debugSourceOf(f)
      var stack = debugStackOf(f)
      if (source || stack) read.frames.push({ element: reactTypeName(f.type), owner: ownerName(f), debugSource: source, debugStack: stack })
    }
    if (isHostReactFiber(f)) {
      if (f !== fiber) hosts++
      if (ref && (opts.maxAncestors < 0 || hosts <= opts.maxAncestors)) {
        var node = f.stateNode
        collect((node && node[found.propsKey]) || f.memoizedProps, 'host', hosts, reactNodeLabel(node), handlerOwner(f))
      }
    } else if (isCompositeReactFiber(f)) {
      var cf = reactComponentFn(f.type)
      if (cf && cf === lastFn) continue
      lastFn = cf
      var name = reactTypeName(f.type)
      if (read.components.length < opts.maxComponents) {
        read.components.push({
          name: name,
          fn: ref && cf ? ref(cf) : 0,
          debugSource: debugSourceOf(f),
          debugStack: debugStackOf(f),
          props: opts.props ? serializeReactValue(f.memoizedProps, 0, []) : null,
        })
      } else {
        read.moreComponents++
      }
      if (ref && hosts === 0) collect(f.memoizedProps, 'component', 0, name || 'Anonymous', name || 'Anonymous')
    }
  }
  return read
}
`

/**
 * `Runtime.callFunctionOn` body for `returnByValue: true`; `this` is the element (resolved in
 * the main world), the one argument a `FiberReadOptions`. Returns a `FiberReadResult`.
 */
export const READ_REACT_FIBER_FUNCTION = `function (opts) {
${REACT_FIBER_READER}
  return readReactFiber(this, opts, null)
}`

export interface ReactSourceLocation {
  fileName: string
  lineNumber?: number
  columnNumber?: number
  componentName?: string
  /** `debugSource`: React ≤18's own record. `sourcemap`: a 19 stack frame mapped through
   *  the script's source map. `stack`: the unmapped served URL and position (see `note`). */
  via: 'debugSource' | 'sourcemap' | 'stack'
  note?: string
}

export type LocateResult = { ok: true; location: ReactSourceLocation } | { ok: false; error: string }

/** A `url:line:col` frame of a stack trace, 1-based. */
export interface StackSite {
  url: string
  line: number
  column: number
  fn?: string
}

const STACK_FRAME_RE = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/
const JSX_FACTORY_RE = /(?:^|\.)(?:jsxDEV|jsxs?|createElement|jsxWithValidation(?:Dynamic|Static)?)$/
const REACT_RUNTIME_URL_RE = /\/node_modules\/|react-dom|react\.development|jsx-dev-runtime|jsx-runtime/

/**
 * The JSX site in a React 19 `_debugStack`: the frame right after the JSX factory frame,
 * or — when the factory frame is not named — the first frame outside React's own runtime.
 */
export function jsxSiteFromDebugStack(stack: string): StackSite | undefined {
  const sites: StackSite[] = []
  for (const line of stack.split('\n')) {
    const m = STACK_FRAME_RE.exec(line)
    if (!m) continue
    sites.push({ fn: m[1] || undefined, url: m[2], line: Number(m[3]), column: Number(m[4]) })
  }
  const factory = sites.findIndex((s) => s.fn !== undefined && JSX_FACTORY_RE.test(s.fn))
  if (factory >= 0 && factory + 1 < sites.length) return sites[factory + 1]
  return sites.find((s) => !REACT_RUNTIME_URL_RE.test(s.url))
}

/** Strip bundler and server decoration from a source path so it reads as a project path. */
export function cleanSourceFileName(name: string): string {
  let f = name.trim()
  f = f.replace(/^webpack-internal:\/\/\/?/, '').replace(/^webpack:\/\/[^/]*\//, '')
  if (/^https?:\/\//.test(f)) {
    const pathname = new URL(f).pathname
    // Vite serves files outside the root as /@fs/<absolute path>; everything else is
    // root-relative, which is the project path.
    f = pathname.startsWith('/@fs/') ? pathname.slice('/@fs'.length) : pathname.replace(/^\//, '')
  }
  f = f.replace(/^file:\/\//, '')
  f = f.replace(/[?#].*$/, '')
  // Next.js webpack layer prefixes, which sit between `./` segments:
  // `./(app-pages-browser)/./app/x.tsx`, and likewise (ssr), (rsc), (action-browser), …
  f = f.replace(/^\.\//, '').replace(/^\/?\([-\w]+\)\//, '').replace(/^\.\//, '')
  return decodeURIComponent(f)
}

export function formatReactSourceLocation(location: ReactSourceLocation): string {
  return location.lineNumber ? `${location.fileName}:${location.lineNumber}` : location.fileName
}

function decodeDataUrl(url: string): string {
  const comma = url.indexOf(',')
  if (comma < 0) throw new Error('malformed data: URL')
  const meta = url.slice(0, comma)
  const payload = url.slice(comma + 1)
  if (!/;base64$/i.test(meta)) return decodeURIComponent(payload)
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `ok: false` says why: `sourceMap: 'none'` — the script links no source map, so the served
 * position is the only one there is; `'unusable'` — the script or its map could not be
 * fetched or read, or the map has no mapping for the position.
 */
export type SymbolicateResult =
  | { ok: true; fileName: string; line: number; column: number }
  | { ok: false; sourceMap: 'none' | 'unusable'; error: string }

export type Symbolicator = (site: StackSite) => Promise<SymbolicateResult>

type MapLookup = { ok: true; map: TraceMap } | { ok: false; sourceMap: 'none' | 'unusable'; error: string }

/**
 * A stack-site symbolicator over `fetchText` (which must reject on a non-OK response). Each
 * script and each source map is fetched and parsed once per symbolicator, so mapping many
 * fibers of one bundle costs one download.
 */
export function createSymbolicator(fetchText: (url: string) => Promise<string>): Symbolicator {
  const maps = new Map<string, Promise<MapLookup>>()
  const load = async (scriptUrl: string): Promise<MapLookup> => {
    let script: string
    try {
      script = await fetchText(scriptUrl)
    } catch (error) {
      return { ok: false, sourceMap: 'unusable', error: `could not fetch ${scriptUrl}: ${errorText(error)}` }
    }
    const refs = [...script.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/gm)]
    const ref = refs.at(-1)?.[1]
    if (!ref) return { ok: false, sourceMap: 'none', error: `${scriptUrl} has no sourceMappingURL` }
    const mapUrl = ref.startsWith('data:') ? scriptUrl : new URL(ref, scriptUrl).href
    let raw: string
    try {
      raw = ref.startsWith('data:') ? decodeDataUrl(ref) : await fetchText(mapUrl)
    } catch (error) {
      return { ok: false, sourceMap: 'unusable', error: `could not load the source map of ${scriptUrl}: ${errorText(error)}` }
    }
    try {
      return { ok: true, map: new FlattenMap(JSON.parse(raw), mapUrl) }
    } catch (error) {
      return { ok: false, sourceMap: 'unusable', error: `the source map of ${scriptUrl} could not be read: ${errorText(error)}` }
    }
  }
  return async (site) => {
    let pending = maps.get(site.url)
    if (!pending) {
      pending = load(site.url)
      maps.set(site.url, pending)
    }
    const lookup = await pending
    if (!lookup.ok) return lookup
    let traced: OriginalMapping | InvalidOriginalMapping
    try {
      traced = originalPositionFor(lookup.map, { line: site.line, column: site.column - 1 })
    } catch (error) {
      return { ok: false, sourceMap: 'unusable', error: `the source map of ${site.url} could not be read: ${errorText(error)}` }
    }
    if (traced.source === null || traced.line === null) {
      return { ok: false, sourceMap: 'unusable', error: `the source map of ${site.url} has no mapping for ${site.line}:${site.column}` }
    }
    return { ok: true, fileName: traced.source, line: traced.line, column: (traced.column ?? 0) + 1 }
  }
}

/**
 * Nearest fiber with location info wins. `fetchText` must reject on a non-OK response;
 * a symbolication failure is not hidden — the unmapped position is returned with
 * `via: 'stack'` and a `note` naming why. `displayPath` turns a source path or URL into the
 * shown `fileName` (project-relative `cleanSourceFileName` unless the caller has its own
 * convention, e.g. explain's origin-aware paths).
 */
export async function locateReactSource(
  read: Pick<FiberReadResult, 'reactFound' | 'frames'>,
  options: { fetchText: (url: string) => Promise<string>; displayPath?: (source: string) => string },
): Promise<LocateResult> {
  if (!read.reactFound) return { ok: false, error: 'No React fiber on this element. Is this a React app?' }
  const displayPath = options.displayPath ?? cleanSourceFileName
  const symbolicate = createSymbolicator(options.fetchText)
  for (const frame of read.frames) {
    const componentName = frame.owner ?? frame.element ?? undefined
    if (frame.debugSource) {
      const { fileName, lineNumber, columnNumber } = frame.debugSource
      return {
        ok: true,
        location: { fileName: displayPath(fileName), lineNumber, columnNumber, componentName, via: 'debugSource' },
      }
    }
    const site = frame.debugStack ? jsxSiteFromDebugStack(frame.debugStack) : undefined
    if (!site) continue
    const mapped = await symbolicate(site)
    if (mapped.ok) {
      return {
        ok: true,
        location: {
          fileName: displayPath(mapped.fileName),
          lineNumber: mapped.line,
          columnNumber: mapped.column,
          componentName,
          via: 'sourcemap',
        },
      }
    }
    return {
      ok: true,
      location: {
        fileName: displayPath(site.url),
        lineNumber: site.line,
        columnNumber: site.column,
        componentName,
        via: 'stack',
        note: `Position is in the served file, not the original source: ${mapped.error}.`,
      },
    }
  }
  return {
    ok: false,
    error:
      'No React source location found: no fiber carried _debugSource (React ≤18 dev) or _debugStack (React 19 dev). ' +
      'Production builds strip both.',
  }
}
