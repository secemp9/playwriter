/**
 * read-page.ts — `readPage(fn, { ref, arg })`: run a function that reads the page, in the page, in a
 * way that cannot change it.
 *
 * Human mode refuses Playwright's own reads (they run Playwright's script as a user gesture, so the
 * page counts as clicked). This is the read path that touches nothing:
 *
 *   - The function runs in the page's own JavaScript world, in the frame of the element it reads, as
 *     `fn(el, arg)` — `el` is the element of `ref`, or the page's `document` without one — through
 *     `Runtime.evaluate` without `userGesture`: measured, `navigator.userActivation` stays false.
 *     `Runtime.evaluate` because it is the only call V8 bounds in time itself (see below); it receives
 *     the element of a ref as `$_`, the console helper Chrome sets to the result of a call made in the
 *     console group, so a read with a ref runs with Chrome's console helpers defined, as a DevTools
 *     console expression does ($, $$, keys…; they are gone when it returns).
 *   - Under V8's side-effect check (`throwOnSideEffect`, the check DevTools' eager evaluation uses):
 *     V8 aborts the call before anything with an effect runs — a DOM or style write, a storage write, an
 *     event, focus, scrolling, a request, a global write, a write into a page object, a timer, a
 *     promise. Measured on Chromium: every write tried was refused, in the page's world as well as in
 *     an isolated one, and the page's MutationObserver saw nothing. This is the enforcement; the static
 *     policy only refuses what it can read earlier.
 *   - The page's own world, not an isolated one: measured, the first touch of another frame's window
 *     from an isolated world under the check wedges the renderer (the page stops answering), while
 *     the page's world already has a context in every frame. It also lets a read see the app's own
 *     state (`window.store.getState()`); under the check nothing it calls can change it.
 *   - V8's check refuses some reads Chrome has not marked read-only. The common ones are rewritten
 *     (AST) to exact read-only equivalents run in the same check: `closest`, `matches`,
 *     `getRootNode`, `Storage#getItem/key`, `DOMRect#toJSON`, `getPropertyValue` of standard
 *     properties, `Object.fromEntries`; each falls back to the native call (and V8's refusal) where
 *     it could differ. `console.*` is collected and printed with the call's output.
 *   - Synchronous only (V8 refuses promises under the check). Every loop iteration and function
 *     entry checks a time budget, so a loop that never ends stops instead of freezing the tab; code
 *     the checks cannot reach — a function of the page it calls, a regular expression that
 *     backtracks — is stopped by V8 itself a second later (`Runtime.evaluate`'s `timeout`, scoped to
 *     that evaluation, so nothing else on the page is ever stopped).
 *   - V8 says nothing about where its check stopped a function. readPage finds it: the function is
 *     run again (under the check, so again changing nothing) with each call counted as a start and an
 *     end event, stopped at event n, and the last event reached is found by doubling then halving n.
 *     The model gets the call in a code frame of its own function, why Chrome stopped it, and what to
 *     read instead.
 *   - Data comes back as JSON; elements (the result itself, or an array or list of them) come back
 *     as the refs observe() gives them.
 */

import { parse } from '@babel/parser'
import traverse, { type NodePath } from '@babel/traverse'
import { codeFrameColumns } from '@babel/code-frame'
import type { BrowserContext, Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import { withDeadline } from './isolated-world.js'
import { pageWorldContextId } from './playwright-server.js'
import { ModelFacingError } from './probe-types.js'
import { renderLocatedNode, type PageProbes } from './page-probe.js'
import type { FrameHandle } from './page-frames.js'

/** How long the function may run. A read that needs longer reads too much at once. */
export const READ_BUDGET_MS = 5000

/** Beyond the budget: the renderer itself did not answer (a native call that does not return). */
const CDP_MARGIN_MS = 5000
const CDP_TIMEOUT_MS = 5000
/**
 * V8 stops the evaluation this long after the budget, wherever it is: the budget checks only run in
 * the function's own code, and a function of the page or a regular expression never reaches them.
 */
const STOP_AFTER_BUDGET_MS = 1000
/** The object group whose last call result Chrome exposes to console expressions as `$_`. */
const CONSOLE_GROUP = 'console'
/** Thrown by the expression when `$_` is not the element this read handed over. */
const CARRIER_MARK = '__playwriterReadCarrier__'
/** Called on the element of a ref, in the console group: `$_` becomes `{ element, nonce }` in its page world. */
const CARRIER_FN = 'function (nonce) { return { element: this, nonce: nonce } }'

const HELPER = '__playwriterRead'
const BUDGET_MARK = '__playwriterReadBudget__'
const RESULT_MARK = '__playwriterReadResult__: '
/** Thrown (as a string) by a locate run when it reaches the event it was told to stop at. */
const SITE_MARK = '__playwriterReadSite__:'
/** How long re-running a refused function to find where Chrome stopped it may take, in all. */
const LOCATE_BUDGET_MS = 3000

export interface ReadPageOptions {
  /** A ref from observe()/find(): the function gets that element, and runs in its frame. */
  ref?: number | string
  /** Data for the function's second parameter: JSON (strings, numbers, booleans, null, arrays, plain objects). */
  arg?: unknown
  /** The tab to read without a ref (default: the current page). */
  page?: Page
}

export interface ReadPageDeps {
  probes: PageProbes
  context: BrowserContext
  /** The sandbox's current page, read at call time. */
  currentPage: () => Page
  /** Prints one `console.*` call the function made. */
  log: (level: string, text: string) => void
}

/** One element a read returned: its ref when observe() lists it (or an element containing it), and the line observe() would print. */
export interface ReadElement {
  ref?: number
  text: string
}

// ---------------------------------------------------------------------------------------------
// In-page code. It runs under V8's side-effect check, so it only reads and writes values it made.
// ---------------------------------------------------------------------------------------------

/**
 * The helper object the instrumented function calls (`__playwriterRead.tick()`, `.closest(el, s)`…).
 * Each shim returns exactly what the native call returns, or makes the native call (and lets V8
 * refuse it) where it cannot be sure: a selector with `:scope`, an element outside any document, a
 * storage key hidden by a Storage member, a custom property, an `Object.prototype` accessor.
 */
const PRELUDE = `(function (target, budgetMs, stopAt) {
  var budgetEnd = performance.now() + budgetMs
  var logs = []
  var targetDocument = target.nodeType === 9 ? target : target.ownerDocument
  var brand = function (value) { return Object.prototype.toString.call(value) }
  // Locate runs (stopAt > 0): every call the function makes counts as two events, its start and its
  // end, and the run stops by throwing at event number stopAt. A stop the page's code catches is
  // thrown again at the next event, and at the result.
  var events = 0
  var stopped = null
  var stop = function (event) {
    if (stopped === null) {
      events++
      if (events !== stopAt) return
      stopped = '${SITE_MARK}' + event
    }
    throw stopped
  }
  var isNode = function (value) {
    return typeof value === 'object' && value !== null && typeof value.nodeType === 'number' && typeof value.nodeName === 'string'
  }
  var isElement = function (value) { return isNode(value) && value.nodeType === 1 && typeof value.querySelectorAll === 'function' }
  var treeRoot = function (node) { var root = node; while (root.parentNode) root = root.parentNode; return root }
  var queryRoot = function (el, selector) {
    if (!isElement(el) || typeof selector === 'symbol' || String(selector).indexOf(':scope') !== -1) return null
    var root = treeRoot(el)
    return root.nodeType === 9 || root.nodeType === 11 ? root : null
  }
  var hint = function (kind, value) {
    if (kind === 'Map') return 'return [...it] or Object.fromEntries(it)'
    if (kind === 'Set') return 'return [...it]'
    if (kind === 'Date') return 'return it.toISOString()'
    if (kind === 'DOMRect' || kind === 'DOMRectReadOnly') return 'return it.toJSON()'
    if (kind === 'CSSStyleDeclaration') return 'return the properties you need (style.color, style.display)'
    if (kind === 'RegExp') return 'return String(it)'
    if (kind.slice(-5) === 'Error') return 'return it.message'
    return 'copy the fields you need into a plain object'
  }
  var check = function (value, path, stack) {
    var type = typeof value
    if (value === null || value === undefined || type === 'string' || type === 'boolean') return
    if (type === 'number') {
      if (!isFinite(value)) throw new TypeError('${RESULT_MARK}' + path + ' is ' + String(value) + ', which JSON cannot carry; return String(it), or check for it in the function')
      return
    }
    if (type !== 'object') throw new TypeError('${RESULT_MARK}' + path + ' is a ' + type + '; return data: strings, numbers, booleans, null, arrays and plain objects')
    if (isNode(value)) {
      throw new TypeError('${RESULT_MARK}' + path + ' is a page element inside other data. Return elements on their own (an element, or an array of them) to get their refs, or read what you need from them (el.textContent, el.getAttribute(...))')
    }
    if (stack.indexOf(value) !== -1) throw new TypeError('${RESULT_MARK}' + path + ' refers back to an object that contains it (a cycle)')
    if (Array.isArray(value)) {
      stack.push(value)
      for (var i = 0; i < value.length; i++) check(value[i], path + '[' + i + ']', stack)
      stack.pop()
      return
    }
    var proto = Object.getPrototypeOf(value)
    var kind = brand(value).slice(8, -1)
    if (kind !== 'Object' || (proto !== null && Object.getPrototypeOf(proto) !== null)) {
      var name = kind === 'Object' && proto && proto.constructor && proto.constructor.name ? proto.constructor.name : kind
      throw new TypeError('${RESULT_MARK}' + path + ' is a ' + name + ', not data: ' + hint(kind, value))
    }
    stack.push(value)
    var keys = Object.keys(value)
    for (var j = 0; j < keys.length; j++) check(value[keys[j]], path + '.' + keys[j], stack)
    stack.pop()
  }
  var describe = function (value) {
    if (typeof value === 'string') return value
    if (value === undefined) return 'undefined'
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
    if (typeof value === 'symbol') return value.toString()
    if (typeof value === 'function') return '[function ' + (value.name || 'anonymous') + ']'
    if (isElement(value)) {
      return '<' + value.localName + (value.id ? '#' + value.id : '') + (value.classList && value.classList.length ? '.' + Array.from(value.classList).join('.') : '') + '>'
    }
    if (isNode(value)) return value.nodeName
    try { return JSON.stringify(value) } catch (error) { return brand(value) }
  }
  var nodeList = function (value) {
    if (isNode(value)) return { list: [value], single: true }
    var kind = brand(value)
    if (kind === '[object NodeList]' || kind === '[object HTMLCollection]' || kind === '[object RadioNodeList]' || kind === '[object HTMLOptionsCollection]') {
      return { list: Array.from(value), single: false }
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isNode)) return { list: value.slice(), single: false }
    return null
  }
  // An Object.prototype accessor or read-only property would make a plain write differ from defining the key.
  var definesThroughPrototype = function (key) {
    var inherited = Object.getOwnPropertyDescriptor(Object.prototype, key)
    return inherited !== undefined && (inherited.get !== undefined || inherited.set !== undefined || inherited.writable === false)
  }
  var ownEnumerableKeys = function (from) {
    return Object.keys(from).concat(Object.getOwnPropertySymbols(from).filter(function (symbol) { return Object.prototype.propertyIsEnumerable.call(from, symbol) }))
  }
  // The native spread, kept out of the shim's own bytecode (V8 refuses spread outright): V8 refuses it, as it should here.
  var nativeSpread = function (parts) { return parts.reduce(function (out, part) { return { ...out, ...part } }, {}) }
  // No shim reads \`arguments\`: a function that does is refused by V8's check whatever path it takes.
  return {
    target: target,
    tick: function () { if (performance.now() > budgetEnd) throw new RangeError('${BUDGET_MARK}') },
    begin: function (site) { stop('b' + site) },
    end: function (site, value) { stop('e' + site); return value },
    closest: function (el, ...rest) {
      var root = rest.length === 0 ? null : queryRoot(el, rest[0])
      if (root === null) return el.closest(...rest)
      var matching = new Set(root.querySelectorAll(rest[0]))
      for (var node = el; node; node = node.parentElement) if (matching.has(node)) return node
      return null
    },
    matches: function (el, ...rest) {
      var root = rest.length === 0 ? null : queryRoot(el, rest[0])
      if (root === null) return el.matches(...rest)
      return new Set(root.querySelectorAll(rest[0])).has(el)
    },
    webkitMatchesSelector: function (el, ...rest) {
      var root = rest.length === 0 ? null : queryRoot(el, rest[0])
      if (root === null) return el.webkitMatchesSelector(...rest)
      return new Set(root.querySelectorAll(rest[0])).has(el)
    },
    getRootNode: function (node, ...rest) {
      if (!isNode(node)) return node.getRootNode(...rest)
      var composed = Boolean(rest[0] && rest[0].composed)
      var root = treeRoot(node)
      while (composed && root.nodeType === 11 && root.host) root = treeRoot(root.host)
      return root
    },
    getElementById: function (root, ...rest) {
      if (!isNode(root) || (root.nodeType !== 9 && root.nodeType !== 11) || rest.length === 0 || typeof rest[0] === 'symbol') return root.getElementById(...rest)
      var id = String(rest[0])
      if (id === '') return null
      var found = Array.from(root.querySelectorAll('[id]')).find(function (element) { return element.id === id })
      return found === undefined ? null : found
    },
    isSameNode: function (node, ...rest) {
      if (!isNode(node) || rest.length === 0 || (rest[0] !== null && !isNode(rest[0]))) return node.isSameNode(...rest)
      return node === rest[0]
    },
    toString: function (value, ...rest) {
      if (rest.length === 0 && brand(value) === '[object Location]') return value.href
      return value.toString(...rest)
    },
    getItem: function (storage, ...rest) {
      if (brand(storage) !== '[object Storage]' || rest.length === 0 || typeof rest[0] === 'symbol') return storage.getItem(...rest)
      var name = String(rest[0])
      if (Object.prototype.hasOwnProperty.call(storage, name)) return storage[name]
      return name in storage ? storage.getItem(name) : null
    },
    key: function (storage, ...rest) {
      if (brand(storage) !== '[object Storage]' || rest.length === 0) return storage.key(...rest)
      var names = Object.keys(storage)
      if (names.length !== storage.length) return storage.key(...rest)
      var at = rest[0] >>> 0
      return at < names.length ? names[at] : null
    },
    toJSON: function (value, ...rest) {
      var kind = brand(value)
      if (kind !== '[object DOMRect]' && kind !== '[object DOMRectReadOnly]') return value.toJSON(...rest)
      return { x: value.x, y: value.y, width: value.width, height: value.height, top: value.top, right: value.right, bottom: value.bottom, left: value.left }
    },
    getPropertyValue: function (style, ...rest) {
      if (brand(style) !== '[object CSSStyleDeclaration]' || rest.length === 0 || typeof rest[0] === 'symbol') return style.getPropertyValue(...rest)
      var property = String(rest[0]).toLowerCase()
      if (/^-?[a-z][a-z0-9-]*$/.test(property) && property in style && typeof style[property] === 'string') return style[property]
      return style.getPropertyValue(...rest)
    },
    fromEntries: function (iterable) {
      var entries = Array.from(iterable)
      var out = {}
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        if (Object(entry) !== entry) throw new TypeError('Iterator value ' + String(entry) + ' is not an entry object')
        var key = entry[0]
        var name = typeof key === 'symbol' ? key : String(key)
        if (definesThroughPrototype(name)) return Object.fromEntries(entries)
        out[name] = entry[1]
      }
      return out
    },
    assign: function (target, ...sources) {
      if (target === null || target === undefined) return Object.assign(target, ...sources)
      var to = Object(target)
      for (var i = 0; i < sources.length; i++) {
        if (sources[i] === null || sources[i] === undefined) continue
        var from = Object(sources[i])
        var keys = ownEnumerableKeys(from)
        for (var j = 0; j < keys.length; j++) to[keys[j]] = from[keys[j]]
      }
      return to
    },
    spread: function (...parts) {
      var out = {}
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] === null || parts[i] === undefined) continue
        var from = Object(parts[i])
        var keys = ownEnumerableKeys(from)
        for (var j = 0; j < keys.length; j++) {
          if (definesThroughPrototype(keys[j])) return nativeSpread(parts)
          out[keys[j]] = from[keys[j]]
        }
      }
      return out
    },
    log: function (level, ...values) {
      logs.push([level, values.map(describe).join(' ')])
    },
    // \`x?.closest(s)\`, \`x.closest?.(s)\`: the shim as a function, or undefined where the chain short-circuits.
    member: function (receiver, name, receiverOptional, callOptional) {
      if (receiver === null || receiver === undefined) {
        if (receiverOptional) return undefined
        throw new TypeError('Cannot read properties of ' + receiver + " (reading '" + name + "')")
      }
      var method = receiver[name]
      if (method === null || method === undefined) {
        if (callOptional) return undefined
        throw new TypeError(name + ' is not a function')
      }
      var shim = this[name]
      return function (...args) { return shim(receiver, ...args) }
    },
    finish: function (value) {
      stop('r')
      var nodes = nodeList(value)
      if (nodes) return { kind: 'nodes', nodes: nodes.list, single: nodes.single, logs: logs, targetDocument: targetDocument }
      check(value, 'the result', [])
      return { kind: 'value', json: value === undefined ? undefined : JSON.stringify(value), logs: logs }
    },
  }
})`

/** What the second call reads from the wrapper's result: everything but the nodes, as plain data. */
const RESULT_SUMMARY_FN = `function () {
  var self = this
  var doc = self.targetDocument
  return {
    kind: self.kind,
    json: self.json,
    logs: self.logs,
    single: self.single,
    nodes: self.kind === 'nodes'
      ? self.nodes.map(function (node) {
          var element = node.nodeType === 1 ? node : node.parentElement
          var text = element ? (element.innerText || element.textContent || '') : (node.textContent || '')
          return {
            sameDocument: (node.nodeType === 9 ? node : node.ownerDocument) === doc,
            tag: element ? element.localName : node.nodeName.toLowerCase(),
            text: text.replace(/\\s+/g, ' ').trim().slice(0, 160),
          }
        })
      : null,
  }
}`

const NODES_FN = 'function () { return this.nodes }'

// ---------------------------------------------------------------------------------------------
// The function, read and instrumented (AST).
// ---------------------------------------------------------------------------------------------

/** Rewritten calls: `x.<name>(…)` → `__playwriterRead.<name>(x, …)`. */
const SHIMMED_METHODS = new Set([
  'closest',
  'matches',
  'webkitMatchesSelector',
  'getRootNode',
  'getElementById',
  'isSameNode',
  'toString',
  'getItem',
  'key',
  'toJSON',
  'getPropertyValue',
])

/** Rewritten `Object.<name>(…)` calls of the global `Object` → `__playwriterRead.<shim>(…)`. */
const SHIMMED_OBJECT_METHODS: Record<string, string> = { fromEntries: 'fromEntries', assign: 'assign' }

/** `console.<level>(…)` calls collected instead of logged. */
const CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'])

/**
 * Reads Chrome has not marked read-only, which V8's side-effect check refuses, with what to read
 * instead (measured). Named in the refusal when the function calls one.
 */
const UNMARKED_READS: Record<string, string> = {
  getClientRects: 'getBoundingClientRect()',
  elementFromPoint: 'explain(ref) or observe(), which say what covers an element',
  elementsFromPoint: 'explain(ref) or observe(), which say what covers an element',
  checkVisibility: 'getComputedStyle(el).display / .visibility and getBoundingClientRect()',
  compareDocumentPosition: 'a.contains(b), or walking parentNode',
  isEqualNode: 'comparing the fields you need',
  getAttributeNode: 'getAttribute(name)',
  getAnimations: 'getComputedStyle(el).animationName',
  computedStyleMap: 'getComputedStyle(el)',
  namedItem: "querySelector('[name=\"…\"]') or the item's index",
  checkValidity: 'el.validity.valid and el.validationMessage',
  reportValidity: 'el.validity.valid and el.validationMessage',
  matchMedia: 'innerWidth / innerHeight for the viewport',
  getEntries: 'net.requests(), which lists what the page fetched',
  getEntriesByType: 'net.requests(), which lists what the page fetched',
  getEntriesByName: 'net.requests(), which lists what the page fetched',
  evaluate: 'querySelector / querySelectorAll (XPath is not read-only in Chrome)',
  matchAll: 'match() with a /g regex',
  random: 'a fixed value',
  structuredClone: 'JSON.parse(JSON.stringify(value))',
  atob: 'the encoded string itself',
  btoa: 'the string itself',
  escape: 'the selector text itself',
}
const UNMARKED_CONSTRUCTORS: Record<string, string> = {
  URL: "a link's own parts (a.pathname, a.search, a.hash, a.host) or location.*",
  URLSearchParams: 'location.search, or a.search, split on & and =',
  FormData: 'form.elements and each field.value',
}

interface Edit {
  /** Offset in the original source. */
  at: number
  /** Original characters replaced from `at` on (0 for an insertion). */
  remove: number
  insert: string
  /**
   * Order among edits at the same offset: text ending there (closers, inner first), then text
   * starting there (openers, outer first), then the replacement of the original text starting there.
   */
  rank: number
}

const closerRank = (depth: number): number => -depth
const openerRank = (depth: number): number => depth
const REPLACEMENT_RANK = 1e9

/**
 * A call the function makes, as a locate run counts it (its start and its end are events): where it
 * is in the source, how to name it, and the call it is an argument (or the callee) of, if any.
 */
export interface ReadSite {
  /** Offsets of the call in the source. */
  start: number
  end: number
  line: number
  /** The call as written, on one line. */
  call: string
  /** The method or function name, when it is written as one (`get` of `mw.config.get(…)`). */
  name: string | null
  /** The object the method is called on, as written (`mw.config`), for a method call. */
  receiver: string | null
  /** `new X(…)`. */
  construct: boolean
  /** The call whose arguments or callee this one is in, without a function in between: it is still running when this one ends. */
  enclosing: number | null
}

/** The function, ready to run: its source, the instrumented source, and the map back. */
export interface PreparedRead {
  source: string
  instrumented: string
  /** Offset in `instrumented` → offset in `source`. */
  toSource: (offset: number) => number
  /** Calls the function makes that V8's check refuses, with what to use instead, by line. */
  unmarked: Array<{ call: string; line: number; instead: string }>
  /** The calls a locate run counts, by site number (empty unless prepared to locate). */
  sites: ReadSite[]
}

function readError(message: string): ModelFacingError {
  return new ModelFacingError(`readPage: ${message}`)
}

/** Depth of a path in its tree: openers of outer nodes go before inner ones at the same offset. */
function depthOf(path: NodePath): number {
  let depth = 0
  for (let current: NodePath | null = path.parentPath; current; current = current.parentPath) depth++
  return depth
}

/**
 * Read `fn` (its source, through `Function.prototype.toString`), refuse what cannot run under the
 * check before anything is sent, and instrument it: a budget tick at every function entry and loop
 * iteration, the shimmed reads and `console.*` rewritten to the helper object. To `locate`, every
 * call is also wrapped in a start and an end event (`end(k, (begin(k), call))`), so that a run can be
 * stopped at any event and the event where Chrome's check stops it can be found.
 */
export function prepareRead(fn: unknown, { locate = false }: { locate?: boolean } = {}): PreparedRead {
  if (typeof fn !== 'function') {
    throw readError(`its first argument must be a function that reads the page, like readPage((el) => el.textContent, { ref: 12 }); got ${fn === null ? 'null' : typeof fn}.`)
  }
  const source = Function.prototype.toString.call(fn)
  // `(source\n)`: the source as an expression; the newline keeps a trailing line comment from eating the paren.
  const wrapped = `(${source}\n)`
  let ast
  try {
    ast = parse(wrapped, { sourceType: 'script', errorRecovery: false })
  } catch {
    throw readError('pass the function written inline — readPage((el) => …) or readPage(function (el) { … }). A method, a class or a built-in cannot be read and sent to the page.')
  }
  const statement = ast.program.body[0]
  const root = statement?.type === 'ExpressionStatement' ? statement.expression : null
  if (!root || (root.type !== 'ArrowFunctionExpression' && root.type !== 'FunctionExpression') || ast.program.body.length !== 1) {
    throw readError('pass the function written inline — readPage((el) => …) or readPage(function (el) { … }).')
  }

  const edits: Edit[] = []
  const unmarked: PreparedRead['unmarked'] = []
  const offset = (position: number | null | undefined): number => (position ?? 0) - 1
  const lineOf = (path: NodePath): number => path.node.loc?.start.line ?? 1
  /** Why the function cannot run under the check, found while reading it; the first one is reported. */
  const refusals: string[] = []

  const tickAtEntry = (path: NodePath, body: NodePath): void => {
    const depth = depthOf(path)
    if (body.isBlockStatement()) {
      const directives = body.node.directives
      const after = directives.length > 0 ? directives[directives.length - 1].end : (body.node.start ?? 0) + 1
      edits.push({ at: offset(after), remove: 0, insert: `${HELPER}.tick();`, rank: openerRank(depth) })
      return
    }
    edits.push({ at: offset(body.node.start), remove: 0, insert: `(${HELPER}.tick(), `, rank: openerRank(depth) })
    edits.push({ at: offset(body.node.end), remove: 0, insert: ')', rank: closerRank(depth) })
  }
  const tickInLoop = (path: NodePath, body: NodePath): void => {
    const depth = depthOf(path)
    if (body.isBlockStatement()) {
      edits.push({ at: offset(body.node.start) + 1, remove: 0, insert: `${HELPER}.tick();`, rank: openerRank(depth) })
      return
    }
    edits.push({ at: offset(body.node.start), remove: 0, insert: `{${HELPER}.tick();`, rank: openerRank(depth) })
    edits.push({ at: offset(body.node.end), remove: 0, insert: '}', rank: closerRank(depth) })
  }

  /** A name the function does not bind itself: a global of the page. */
  const isGlobal = (path: NodePath, name: string): boolean => path.scope.getBinding(name) === undefined

  const sites: ReadSite[] = []
  const siteOf = new Map<object, number>()
  const oneLine = (from: number, to: number): string => {
    const text = source.slice(from, to).replace(/\s+/g, ' ')
    return text.length > 100 ? `${text.slice(0, 99)}…` : text
  }
  /** Wrap a call in its start and end events. Not a link inside an optional chain (wrapping it would end the chain's short-circuit early). */
  const markSite = (path: NodePath): void => {
    const node = path.node
    const callee =
      node.type === 'CallExpression' || node.type === 'OptionalCallExpression' || node.type === 'NewExpression' ? node.callee : node.type === 'TaggedTemplateExpression' ? node.tag : null
    if (callee === null || callee.type === 'Super' || callee.type === 'Import') return
    const parent = path.parent
    if ((parent.type === 'OptionalMemberExpression' && parent.object === node) || (parent.type === 'OptionalCallExpression' && parent.callee === node)) return
    let enclosing: number | null = null
    for (let up = path.parentPath; up && !up.isFunction(); up = up.parentPath) {
      const id = siteOf.get(up.node)
      if (id !== undefined) {
        enclosing = id
        break
      }
    }
    const site = sites.length
    siteOf.set(node, site)
    const start = offset(node.start)
    const end = offset(node.end)
    const member = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression' ? callee : null
    const property = member?.property
    const name =
      callee.type === 'Identifier'
        ? callee.name
        : member && !member.computed && property?.type === 'Identifier'
          ? property.name
          : member && member.computed && property?.type === 'StringLiteral'
            ? property.value
            : null
    sites.push({
      start,
      end,
      line: lineOf(path),
      call: oneLine(start, end),
      name,
      receiver: member && member.object.type !== 'Super' ? oneLine(offset(member.object.start), offset(member.object.end)) : null,
      construct: node.type === 'NewExpression',
      enclosing,
    })
    const depth = depthOf(path)
    // Outside every other edit of this node at the same offsets: before its openers, after its closers.
    edits.push({ at: start, remove: 0, insert: `${HELPER}.end(${site}, (${HELPER}.begin(${site}), `, rank: openerRank(depth) - 0.5 })
    edits.push({ at: end, remove: 0, insert: '))', rank: closerRank(depth) + 0.5 })
  }

  // Its own pass: a `A|B` visitor key replaces (does not join) the visitors of A and B in one traversal.
  if (locate) {
    traverse(ast, {
      'CallExpression|OptionalCallExpression|NewExpression|TaggedTemplateExpression'(path: NodePath) {
        markSite(path)
      },
    })
  }

  traverse(ast, {
    Identifier(path) {
      if (path.node.name === HELPER) refusals.push(`its code uses the name ${HELPER}, which readPage reserves; rename it.`)
      if (path.node.name === 'arguments' && path.isReferencedIdentifier() && isGlobal(path, 'arguments')) {
        unmarked.push({ call: 'arguments', line: lineOf(path), instead: 'rest parameters ((...args) => …)' })
      }
    },
    Function(path) {
      if (path.node.async) refusals.push('its function (or one inside it) is async. readPage runs synchronously — DOM reads are synchronous; remove async/await.')
      else if (path.node.generator) refusals.push("it uses a generator function, which Chrome's side-effect check refuses; use a loop.")
      else tickAtEntry(path, path.get('body'))
    },
    AwaitExpression() {
      refusals.push('its function awaits. readPage runs synchronously — DOM reads are synchronous; remove async/await.')
    },
    'ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement'(path: NodePath) {
      if (path.isForOfStatement() && path.node.await) {
        refusals.push('its function uses for await, which needs promises; readPage runs synchronously.')
        return
      }
      const body = path.get('body')
      if (!Array.isArray(body) && body.isStatement()) tickInLoop(path, body)
    },
    ObjectPattern(path) {
      if (path.node.properties.some((property) => property.type === 'RestElement')) {
        unmarked.push({ call: 'object rest ({ a, ...rest } = obj)', line: lineOf(path), instead: 'reading the keys you need' })
      }
    },
    ObjectExpression(path) {
      const properties = path.node.properties
      if (!properties.some((property) => property.type === 'SpreadElement')) return
      // Only plain `key: value` entries keep their meaning when copied: a getter, a method or a
      // `__proto__: x` entry next to a spread is left to V8 (which refuses spread) and named.
      const plain = properties.every(
        (property) =>
          property.type === 'SpreadElement' ||
          (property.type === 'ObjectProperty' &&
            (property.computed ||
              !((property.key.type === 'Identifier' && property.key.name === '__proto__') || (property.key.type === 'StringLiteral' && property.key.value === '__proto__')))),
      )
      if (!plain) {
        unmarked.push({ call: 'object spread ({ ...obj })', line: lineOf(path), instead: 'Object.assign({}, obj) or copying the keys you need' })
        return
      }
      const startOf = (index: number): number => {
        const property = properties[index]
        return offset(property.type === 'SpreadElement' ? property.argument.start : property.start)
      }
      const endOf = (index: number): number => {
        const property = properties[index]
        return offset(property.type === 'SpreadElement' ? property.argument.end : property.end)
      }
      const isSpread = (index: number): boolean => properties[index].type === 'SpreadElement'
      const objectStart = offset(path.node.start)
      const objectEnd = offset(path.node.end)
      edits.push({ at: objectStart, remove: startOf(0) - objectStart, insert: `${HELPER}.spread(${isSpread(0) ? '' : '{'}`, rank: REPLACEMENT_RANK })
      for (let index = 0; index + 1 < properties.length; index++) {
        if (!isSpread(index) && !isSpread(index + 1)) continue
        const separator = isSpread(index) ? (isSpread(index + 1) ? ', ' : ', {') : '}, '
        edits.push({ at: endOf(index), remove: startOf(index + 1) - endOf(index), insert: separator, rank: REPLACEMENT_RANK })
      }
      const last = properties.length - 1
      edits.push({ at: endOf(last), remove: objectEnd - endOf(last), insert: `${isSpread(last) ? '' : '}'})`, rank: REPLACEMENT_RANK })
    },
    CallExpression(path) {
      const callee = path.get('callee')
      const args = path.node.arguments
      const name = callee.isMemberExpression() ? memberName(callee) : null
      if (name !== null && callee.isMemberExpression()) {
        const object = callee.get('object')
        if (Object.hasOwn(UNMARKED_READS, name)) unmarked.push({ call: `${name}()`, line: lineOf(path), instead: UNMARKED_READS[name] })
        const first = args[0]
        if (name === 'getPropertyValue' && first?.type === 'StringLiteral' && first.value.startsWith('--')) {
          unmarked.push({
            call: `getPropertyValue('${first.value}')`,
            line: lineOf(path),
            instead: 'the computed value of a property that uses it (custom properties have no read-only path in Chrome)',
          })
        }
        if (object.isIdentifier() && isGlobal(path, object.node.name)) {
          if (object.node.name === 'console' && CONSOLE_LEVELS.has(name)) {
            const level = name === 'dir' || name === 'table' || name === 'trace' ? 'log' : name
            const depth = depthOf(path)
            edits.push({ at: offset(callee.node.start), remove: (callee.node.end ?? 0) - (callee.node.start ?? 0), insert: `${HELPER}.log`, rank: REPLACEMENT_RANK })
            if (args.length > 0) edits.push({ at: offset(args[0].start), remove: 0, insert: `'${level}', `, rank: openerRank(depth) })
            else edits.push({ at: offset(path.node.end) - 1, remove: 0, insert: `'${level}'`, rank: openerRank(depth) })
            return
          }
          if (object.node.name === 'Object' && Object.hasOwn(SHIMMED_OBJECT_METHODS, name)) {
            edits.push({ at: offset(callee.node.start), remove: (callee.node.end ?? 0) - (callee.node.start ?? 0), insert: `${HELPER}.${SHIMMED_OBJECT_METHODS[name]}`, rank: REPLACEMENT_RANK })
            return
          }
        }
        if (SHIMMED_METHODS.has(name) && !object.isSuper()) {
          const depth = depthOf(path)
          // The receiver's whole extent: from its outermost `(` when parenthesized (`(a || b).closest(…)`),
          // up to the `.` or `[` of the access, so the parentheses stay inside the shim call.
          const parenStart: unknown = object.node.extra?.parenStart
          const receiverStart = typeof parenStart === 'number' && object.node.extra?.parenthesized === true ? offset(parenStart) : offset(object.node.start)
          const receiverEnd = source.lastIndexOf(callee.node.computed ? '[' : '.', offset(callee.node.property.start))
          edits.push({ at: receiverStart, remove: 0, insert: `${HELPER}.${name}(`, rank: openerRank(depth) })
          if (args.length > 0) edits.push({ at: receiverEnd, remove: offset(args[0].start) - receiverEnd, insert: ', ', rank: REPLACEMENT_RANK })
          else edits.push({ at: receiverEnd, remove: offset(path.node.end) - receiverEnd, insert: ')', rank: REPLACEMENT_RANK })
        }
      }
      if (callee.isIdentifier() && isGlobal(path, callee.node.name)) {
        const called = callee.node.name
        if (Object.hasOwn(UNMARKED_READS, called)) unmarked.push({ call: `${called}()`, line: lineOf(path), instead: UNMARKED_READS[called] })
      }
    },
    // `x?.closest(s)`, `x.closest?.(s)`, `x?.closest?.(s)`: the chain keeps its short-circuit — the
    // helper hands back the shim as a function, or undefined where the chain stops, and `?.(` calls it.
    OptionalCallExpression(path) {
      const callee = path.get('callee')
      if (!callee.isOptionalMemberExpression() && !callee.isMemberExpression()) return
      const property = callee.node.property
      const name = !callee.node.computed && property.type === 'Identifier' ? property.name : callee.node.computed && property.type === 'StringLiteral' ? property.value : null
      if (name === null || !SHIMMED_METHODS.has(name)) return
      const object = callee.get('object')
      if (object.isSuper()) return
      // After an earlier `?.` (`x?.a.closest(s)`), a nullish link either short-circuits the chain or is a
      // TypeError, and which one cannot be told from the receiver alone: left to V8, and named.
      if (object.isOptionalMemberExpression() || object.isOptionalCallExpression()) {
        unmarked.push({ call: `${name}() after ?. in the same chain`, line: lineOf(path), instead: `a variable for the part before it (const row = x?.a; row && row.${name}(…))` })
        return
      }
      const args = path.node.arguments
      const receiverOptional = callee.isOptionalMemberExpression() && callee.node.optional
      const parenStart: unknown = object.node.extra?.parenStart
      const receiverStart = typeof parenStart === 'number' && object.node.extra?.parenthesized === true ? offset(parenStart) : offset(object.node.start)
      const token = receiverOptional ? '?.' : callee.node.computed ? '[' : '.'
      const receiverEnd = source.lastIndexOf(token, offset(property.start))
      const tail = `, '${name}', ${receiverOptional}, ${path.node.optional})?.(`
      edits.push({ at: receiverStart, remove: 0, insert: `${HELPER}.member(`, rank: openerRank(depthOf(path)) })
      if (args.length > 0) edits.push({ at: receiverEnd, remove: offset(args[0].start) - receiverEnd, insert: tail, rank: REPLACEMENT_RANK })
      else edits.push({ at: receiverEnd, remove: offset(path.node.end) - receiverEnd, insert: `${tail})`, rank: REPLACEMENT_RANK })
    },
    NewExpression(path) {
      const callee = path.get('callee')
      if (callee.isIdentifier() && isGlobal(path, callee.node.name) && Object.hasOwn(UNMARKED_CONSTRUCTORS, callee.node.name)) {
        unmarked.push({ call: `new ${callee.node.name}()`, line: lineOf(path), instead: UNMARKED_CONSTRUCTORS[callee.node.name] })
      }
    },
  })
  if (refusals.length > 0) throw readError(refusals[0])

  edits.sort((a, b) => a.at - b.at || a.rank - b.rank)
  let instrumented = ''
  /** [instrumented start, source start, length] of each run of original text. */
  const runs: Array<[number, number, number]> = []
  let cursor = 0
  for (const edit of edits) {
    if (edit.at > cursor) {
      runs.push([instrumented.length, cursor, edit.at - cursor])
      instrumented += source.slice(cursor, edit.at)
      cursor = edit.at
    }
    instrumented += edit.insert
    cursor += edit.remove
  }
  runs.push([instrumented.length, cursor, source.length - cursor])
  instrumented += source.slice(cursor)

  const toSource = (position: number): number => {
    let mapped = 0
    for (const [start, from, length] of runs) {
      if (position < start) break
      mapped = position < start + length ? from + (position - start) : from + length
    }
    return mapped
  }
  return { source, instrumented, toSource, unmarked, sites }
}

/** `a.b` / `a['b']` → `b`; null for a computed key that is not a string literal. */
function memberName(member: NodePath): string | null {
  if (!member.isMemberExpression()) return null
  const property = member.node.property
  if (!member.node.computed && property.type === 'Identifier') return property.name
  if (member.node.computed && property.type === 'StringLiteral') return property.value
  return null
}

/** The function sent to the page: the helper object, then the instrumented function on lines of its own. */
function wrapperFor(prepared: PreparedRead): { declaration: string; firstLine: number } {
  const head = `function (payload) {\nvar ${HELPER} = ${PRELUDE}(this, ${READ_BUDGET_MS}, payload.stopAt)\nvar __playwriterFn = (\n`
  const firstLine = head.split('\n').length - 1
  const tail = `\n)\nreturn ${HELPER}.finish(__playwriterFn(this, payload.has ? payload.value : undefined))\n}`
  return { declaration: `${head}${prepared.instrumented}${tail}`, firstLine }
}

/** What the function receives besides its target: the model's `arg`, and the event a locate run stops at (0: none). */
interface ReadPayload {
  has: boolean
  value: unknown
  stopAt: number
}

/**
 * The expression readPage evaluates: the wrapper applied to the page's `document`, or to the element
 * handed over in `$_` when `nonce` is set (checked, so a `$_` the page defines itself is never read as
 * the element). The wrapper starts on the expression's first line, so its line numbers stay its own.
 */
function expressionFor(prepared: PreparedRead, payload: ReadPayload, nonce: string | null): string {
  const { declaration } = wrapperFor(prepared)
  const data = JSON.stringify(payload)
  if (nonce === null) return `(${declaration}).call(document, ${data})`
  return (
    `(function (carrier) { if (carrier === null || typeof carrier !== 'object' || carrier.nonce !== ${JSON.stringify(nonce)}) ` +
    `throw new TypeError(${JSON.stringify(CARRIER_MARK)}); return (${declaration}).call(carrier.element, ${data}) })($_)`
  )
}

/** Validate `arg` as JSON data, naming the first part that is not. */
function checkArg(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw readError(`${path} is ${String(value)}, which cannot be sent to the page as data.`)
    return
  }
  if (typeof value !== 'object') throw readError(`${path} is a ${typeof value}; arg carries data only (strings, numbers, booleans, null, arrays, plain objects).`)
  if (seen.has(value)) throw readError(`${path} refers back to an object that contains it (a cycle).`)
  if (Array.isArray(value)) {
    seen.add(value)
    value.forEach((item, index) => checkArg(item, `${path}[${index}]`, seen))
    seen.delete(value)
    return
  }
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw readError(`${path} is a ${Object.prototype.toString.call(value).slice(8, -1)}, not plain data: pass the values the function needs (a Playwright object cannot be sent to the page — pass a ref instead).`)
  }
  seen.add(value)
  for (const [key, item] of Object.entries(value)) checkArg(item, `${path}.${key}`, seen)
  seen.delete(value)
}

function isRef(value: unknown): value is number | string {
  return typeof value === 'number' || typeof value === 'string'
}

/** A Playwright Page of this client (a channel owner of type Page). */
function isPage(value: unknown): value is Page {
  return typeof value === 'object' && value !== null && Reflect.get(value, '_type') === 'Page' && typeof Reflect.get(value, 'mainFrame') === 'function'
}

function checkOptions(options: unknown): ReadPageOptions {
  if (options === undefined) return {}
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw readError('its second argument is an options object: { ref, arg, page }.')
  }
  const unknown = Object.keys(options).filter((key) => key !== 'ref' && key !== 'arg' && key !== 'page')
  if (unknown.length > 0) throw readError(`unknown option${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}; the options are { ref, arg, page }.`)
  const ref: unknown = Reflect.get(options, 'ref')
  const page: unknown = Reflect.get(options, 'page')
  const arg: unknown = Reflect.get(options, 'arg')
  if (ref !== undefined && !isRef(ref)) throw readError('ref is the number observe() or find() printed in brackets, like { ref: 12 }.')
  if (page !== undefined && !isPage(page)) throw readError('page must be a Playwright page (a tab), like state.page.')
  if (ref !== undefined && page !== undefined) throw readError('pass either ref (refs know their tab) or page, not both.')
  checkArg(arg, 'arg', new Set())
  return { ...(ref !== undefined ? { ref } : {}), ...(page !== undefined ? { page } : {}), arg }
}

// ---------------------------------------------------------------------------------------------
// Running it.
// ---------------------------------------------------------------------------------------------

interface Summary {
  kind: 'value' | 'nodes'
  json?: string
  logs: Array<[string, string]>
  single?: boolean
  nodes: Array<{ sameDocument: boolean; tag: string; text: string }> | null
}

function isSummary(value: unknown): value is Summary {
  return typeof value === 'object' && value !== null && (Reflect.get(value, 'kind') === 'value' || Reflect.get(value, 'kind') === 'nodes') && Array.isArray(Reflect.get(value, 'logs'))
}

const SIDE_EFFECT_RE = /^EvalError: Possible side-effect in debug-evaluate/

function isSideEffect(details: Protocol.Runtime.ExceptionDetails): boolean {
  return SIDE_EFFECT_RE.test((details.exception?.description ?? details.text).split('\n')[0])
}

const SIDE_EFFECT_HEAD = "Chrome's side-effect check stopped the function before anything on the page changed."
const SIDE_EFFECT_TAIL = 'readPage only reads; act.* changes the page the way a person does.'

/** Chrome's answer when V8 stopped the evaluation at its `timeout`. */
const TERMINATED_RE = /Execution was terminated/
/** Chrome's answer when the frame's page world is gone (it loaded another document). */
const DEAD_CONTEXT_RE = /Cannot find context with specified id/

const STOPPED_BY_TIME_LIMIT =
  `the function was still running ${(READ_BUDGET_MS + STOP_AFTER_BUDGET_MS) / 1000}s after it started, inside code readPage cannot ` +
  'stop from within — a function of the page it called, or a regular expression that backtracks — so Chrome stopped it there. ' +
  'Nothing changed (it could only read), and the page went on running. Read less, or leave that call or pattern out.'

/** The model-facing error when the evaluation itself failed (rather than the function throwing in it). */
function runFailure(error: unknown, target: ReadTarget): unknown {
  const message = error instanceof Error ? error.message : String(error)
  if (TERMINATED_RE.test(message)) return readError(STOPPED_BY_TIME_LIMIT)
  if (DEAD_CONTEXT_RE.test(message)) {
    return readError(`${target.element ? `the frame of [${target.element.ref}]` : 'the page'} loaded another document while it was being read. Call observe() again.`)
  }
  return error
}

/** The model-facing error for an exception the function (or the check) raised in the page. */
function failureOf(details: Protocol.Runtime.ExceptionDetails, prepared: PreparedRead, firstLine: number): ModelFacingError {
  const description = details.exception?.description ?? details.text
  const head = description.split('\n')[0]
  if (SIDE_EFFECT_RE.test(head)) return readError(`${SIDE_EFFECT_HEAD} ${unlocatedSideEffect(prepared, null)} ${SIDE_EFFECT_TAIL}`)
  if (head.includes(CARRIER_MARK)) {
    return readError(
      "the element could not be handed to the function: this page defines its own $_, which hides Chrome's console helper " +
        'readPage hands the element over with. Read without a ref, starting from the document (document.querySelector(…)).',
    )
  }
  if (head.includes(BUDGET_MARK)) {
    return readError(
      `the function was still running after ${READ_BUDGET_MS}ms and was stopped. The page cannot change while it runs (its own ` +
        'code waits for yours), so a loop waiting for something to appear never ends: read once, return, then act.waitForIdle() and ' +
        'call readPage again. If it is a big read, read less (one section, the first N items).',
    )
  }
  const resultAt = head.indexOf(RESULT_MARK)
  if (resultAt !== -1) return readError(`${head.slice(resultAt + RESULT_MARK.length)}.`)
  const frame = codeFrameAt(details, prepared, firstLine)
  const hint = head.startsWith('ReferenceError')
    ? ' The function runs in the page and cannot see the variables of your code: pass values with { arg: … } and read them as its second parameter.'
    : ''
  return readError(`the function threw: ${head}.${hint}${frame ? `\n${frame}` : ''}`)
}

/** Where a locate run stopped: at the start or the end of a call (`site`), or at the result. */
type LocateEvent = { kind: 'begin' | 'end'; site: number } | { kind: 'result' }

/** What one locate run did: stopped where it was told to, was stopped by the check, or neither. */
type LocateOutcome = { kind: 'stopped'; event: LocateEvent } | { kind: 'side-effect' } | { kind: 'other' }

function locateOutcome(called: { exceptionDetails?: Protocol.Runtime.ExceptionDetails }): LocateOutcome {
  const details = called.exceptionDetails
  if (!details) return { kind: 'other' }
  const thrown: unknown = details.exception?.value
  if (typeof thrown === 'string' && thrown.startsWith(SITE_MARK)) {
    const event = thrown.slice(SITE_MARK.length)
    if (event === 'r') return { kind: 'stopped', event: { kind: 'result' } }
    const site = Number(event.slice(1))
    if ((event[0] === 'b' || event[0] === 'e') && Number.isInteger(site)) return { kind: 'stopped', event: { kind: event[0] === 'b' ? 'begin' : 'end', site } }
    return { kind: 'other' }
  }
  return isSideEffect(details) ? { kind: 'side-effect' } : { kind: 'other' }
}

/**
 * Find the last event a locate run reaches before Chrome's check stops it. A run stopped at event n
 * throws there if the check has not stopped it before (`stopped`), so the answer is the largest such
 * n: doubled until a run is stopped by the check, then halved down. Every run only reads (the check
 * holds for each). `null` event: stopped before its first call. A string: why it was not found.
 */
async function locateSideEffect(run: (stopAt: number) => Promise<{ exceptionDetails?: Protocol.Runtime.ExceptionDetails }>): Promise<{ event: LocateEvent | null } | string> {
  const started = performance.now()
  const probe = async (stopAt: number): Promise<LocateOutcome | string> => {
    if (performance.now() - started > LOCATE_BUDGET_MS) {
      return `re-running it to find the spot took more than ${LOCATE_BUDGET_MS / 1000}s (it makes too many calls before it is stopped)`
    }
    try {
      return locateOutcome(await run(stopAt))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (TERMINATED_RE.test(message)) return `a run to find it reached the ${(READ_BUDGET_MS + STOP_AFTER_BUDGET_MS) / 1000}s time limit`
      throw error
    }
  }
  const unstable = 'it did not stop the same way when it was run again (the page changed between the runs)'
  /** The largest event number known to be reached, and that event; the smallest known not to be. */
  let reached = 0
  let event: LocateEvent | null = null
  let failed = 0
  for (let stopAt = 1; failed === 0; stopAt *= 2) {
    const outcome = await probe(stopAt)
    if (typeof outcome === 'string') return outcome
    if (outcome.kind === 'other') return unstable
    if (outcome.kind === 'side-effect') failed = stopAt
    else {
      reached = stopAt
      event = outcome.event
    }
  }
  while (failed - reached > 1) {
    const stopAt = Math.floor((reached + failed) / 2)
    const outcome = await probe(stopAt)
    if (typeof outcome === 'string') return outcome
    if (outcome.kind === 'other') return unstable
    if (outcome.kind === 'side-effect') failed = stopAt
    else {
      reached = stopAt
      event = outcome.event
    }
  }
  return { event }
}

/** Line and 1-based column of a source offset. */
function positionOf(source: string, at: number): { line: number; column: number } {
  const before = source.slice(0, at).split('\n')
  return { line: before.length, column: before[before.length - 1].length + 1 }
}

/** Why a call was refused, and what to read instead. */
function refusedCall(site: ReadSite): string {
  if (site.name !== null && !site.construct && Object.hasOwn(UNMARKED_READS, site.name)) {
    return `${site.name}() is a read Chrome has not marked read-only — use ${UNMARKED_READS[site.name]} instead.`
  }
  if (site.name !== null && site.construct && Object.hasOwn(UNMARKED_CONSTRUCTORS, site.name)) {
    return `new ${site.name}() is not read-only in Chrome — use ${UNMARKED_CONSTRUCTORS[site.name]} instead.`
  }
  return (
    'Chrome runs what that call runs only when it can tell it changes nothing: a function of the page that writes, caches, logs or ' +
    'reads `arguments` (common in app code), or a built-in Chrome has not marked read-only, is stopped.' +
    (site.receiver !== null ? ` Read the data instead of calling it: Object.keys(${site.receiver}) lists what ${site.receiver} holds.` : '')
  )
}

/** Where the check stopped the function, as found by `locateSideEffect`, with a code frame. */
function locatedSideEffect(located: PreparedRead, event: LocateEvent | null): string {
  const frameAt = (at: number, end?: number): string =>
    codeFrameColumns(located.source, { start: positionOf(located.source, at), ...(end === undefined ? {} : { end: positionOf(located.source, end) }) }, { highlightCode: false })
  if (event === null) {
    return (
      'It stopped before its first call: a property it reads runs a getter of the page, or a value it converts (`${x}`, `+x`, `x == y`) ' +
      "runs a page object's toString or valueOf, and Chrome cannot tell that changes nothing. Read plain fields: Object.keys(obj) lists them."
    )
  }
  if (event.kind === 'result') {
    return (
      'It stopped while your result was turned into data: a toJSON method or a getter of a page object in it may change something. ' +
      'Return plain values copied from those objects.'
    )
  }
  const site = located.sites[event.site]
  if (event.kind === 'begin') {
    return `It stopped in \`${site.call}\` (line ${site.line}):\n${frameAt(site.start, site.end)}\n${refusedCall(site)}`
  }
  if (site.enclosing !== null) {
    const outer = located.sites[site.enclosing]
    return (
      `It stopped in \`${outer.call}\` (line ${outer.line}), after \`${site.call}\` returned — in the rest of its arguments, or the call itself:\n` +
      `${frameAt(outer.start, outer.end)}\n${refusedCall(outer)}`
    )
  }
  return (
    `It stopped right after \`${site.call}\` (line ${site.line}) returned, before its next call:\n${frameAt(site.end)}\n` +
    "A property read there runs a getter of the page, or a conversion (`${x}`, `+x`, `x == y`) runs a page object's toString or " +
    'valueOf, and Chrome cannot tell that changes nothing. Read plain fields: Object.keys(obj) lists them.'
  )
}

/** The refusal when where it happened is not known: the calls known to be refused, or how to narrow it down. */
function unlocatedSideEffect(prepared: PreparedRead, why: string | null): string {
  const named = prepared.unmarked.map((site) => `${site.call} on line ${site.line} — use ${site.instead} instead`)
  return (
    'Something it runs could change the page (a write, focus, scrolling, an event, a request, a function of the page that caches or ' +
    "logs), or is a read Chrome has not marked read-only. " +
    (named.length > 0 ? `It calls ${named.join('; ')}.` : `Where it stopped is not known${why === null ? '' : `: ${why}`}. Narrow it down by returning intermediate values.`)
  )
}

/** Where in the model's own function the exception was thrown, as a code frame. */
function codeFrameAt(details: Protocol.Runtime.ExceptionDetails, prepared: PreparedRead, firstLine: number): string | null {
  const line = details.lineNumber - firstLine
  const lines = prepared.instrumented.split('\n')
  if (line < 0 || line >= lines.length) return null
  let offset = details.columnNumber
  for (let index = 0; index < line; index++) offset += lines[index].length + 1
  const at = prepared.toSource(offset)
  const before = prepared.source.slice(0, at).split('\n')
  return codeFrameColumns(prepared.source, { start: { line: before.length, column: before[before.length - 1].length + 1 } }, { highlightCode: false })
}

/** What a read runs against: the page's document, or the element of a ref in its frame's session and page world. */
interface ReadTarget {
  page: Page
  cdp: ICDPSession
  frame: FrameHandle
  /** The page world of a same-process iframe, by id; undefined for the session's own top document (its default context). */
  contextId: number | undefined
  /** The element of a ref, resolved in its frame's page world; null to read the document. */
  element: { ref: number; objectId: string } | null
}

async function targetOf(options: ReadPageOptions, deps: ReadPageDeps, objectGroup: string): Promise<ReadTarget> {
  if (options.ref !== undefined) {
    const element = await deps.probes.element(options.ref)
    const { frame } = element
    await withDeadline(frame.cdp.send('DOM.enable'), CDP_TIMEOUT_MS, 'enabling the DOM domain')
    const resolved = await withDeadline(
      frame.cdp.send('DOM.resolveNode', { backendNodeId: element.target.backendNodeId, objectGroup }),
      CDP_TIMEOUT_MS,
      `resolving [${element.target.ref}] in the page`,
    )
    if (!resolved.object.objectId) throw readError(`[${element.target.ref}] is no longer in the page. Call observe() again.`)
    // The top document of a session is its default context; an iframe in the same process is reached by id.
    const contextId =
      frame.sessionRootId === frame.frameId
        ? undefined
        : await withDeadline(pageWorldContextId(frame.frame), CDP_TIMEOUT_MS, `finding the page world of the frame of [${element.target.ref}]`)
    return { page: element.page, cdp: frame.cdp, frame, contextId, element: { ref: element.target.ref, objectId: resolved.object.objectId } }
  }
  const page = options.page ?? deps.currentPage()
  const probe = await deps.probes.get(page)
  const dialog = probe.dialogs.current()
  if (dialog) {
    throw new ModelFacingError(
      `A native ${dialog.type}("${dialog.message}") dialog is open and freezes the page, so it cannot be read. Handle it first, like a ` +
        'person would: act.dialog.accept() or act.dialog.dismiss().',
    )
  }
  return { page, cdp: probe.cdp, frame: probe.frames.main, contextId: undefined, element: null }
}

/** The read in progress on each session: `$_` is one slot per page world, so reads on a session take turns. */
const readsInProgress = new WeakMap<ICDPSession, Promise<void>>()

async function inTurn<T>(cdp: ICDPSession, read: () => Promise<T>): Promise<T> {
  const previous = readsInProgress.get(cdp) ?? Promise.resolve()
  const done = Promise.withResolvers<void>()
  const turn = previous.then(() => done.promise)
  readsInProgress.set(cdp, turn)
  await previous
  try {
    return await read()
  } finally {
    done.resolve()
    if (readsInProgress.get(cdp) === turn) readsInProgress.delete(cdp)
  }
}

/**
 * Evaluate the read — and, when Chrome's check stops it, run it again to find where — with the element of
 * a ref handed over in `$_`. Resolves with the evaluation that returned; throws the model-facing error.
 */
async function evaluateRead(fn: unknown, prepared: PreparedRead, options: ReadPageOptions, target: ReadTarget, objectGroup: string): Promise<Protocol.Runtime.EvaluateResponse> {
  const { cdp, element } = target
  const nonce = element === null ? null : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  if (element !== null) {
    await withDeadline(
      cdp.send('Runtime.callFunctionOn', {
        objectId: element.objectId,
        functionDeclaration: CARRIER_FN,
        arguments: [{ value: nonce }],
        objectGroup: CONSOLE_GROUP,
        returnByValue: false,
        throwOnSideEffect: true,
      }),
      CDP_TIMEOUT_MS,
      `handing [${element.ref}] to the function`,
    )
  }
  try {
    const run = async (code: PreparedRead, stopAt: number): Promise<Protocol.Runtime.EvaluateResponse> =>
      await withDeadline(
        cdp.send('Runtime.evaluate', {
          expression: expressionFor(code, { has: options.arg !== undefined, value: options.arg ?? null, stopAt }, nonce),
          ...(target.contextId === undefined ? {} : { contextId: target.contextId }),
          includeCommandLineAPI: element !== null,
          throwOnSideEffect: true,
          timeout: READ_BUDGET_MS + STOP_AFTER_BUDGET_MS,
          returnByValue: false,
          objectGroup,
        }),
        READ_BUDGET_MS + STOP_AFTER_BUDGET_MS + CDP_MARGIN_MS,
        'running the readPage function',
      )
    let called: Protocol.Runtime.EvaluateResponse
    try {
      called = await run(prepared, 0)
    } catch (error) {
      throw runFailure(error, target)
    }
    if (called.exceptionDetails && isSideEffect(called.exceptionDetails)) {
      // V8 reports no position for its check: run the function again, counting its calls, to find it.
      const located = prepareRead(fn, { locate: true })
      const found = await locateSideEffect((stopAt) => run(located, stopAt))
      throw readError(`${SIDE_EFFECT_HEAD} ${typeof found === 'string' ? unlocatedSideEffect(prepared, found) : locatedSideEffect(located, found.event)}\n${SIDE_EFFECT_TAIL}`)
    }
    if (called.exceptionDetails) throw failureOf(called.exceptionDetails, prepared, wrapperFor(prepared).firstLine)
    return called
  } finally {
    // Releasing the console group also clears `$_`.
    if (element !== null) {
      await withDeadline(cdp.send('Runtime.releaseObjectGroup', { objectGroup: CONSOLE_GROUP }), CDP_TIMEOUT_MS, 'releasing the element handed to the function').catch(() => {})
    }
  }
}

/** `readPage(fn, { ref, arg, page })` — see the module comment. */
export async function readPage(fn: unknown, rawOptions: unknown, deps: ReadPageDeps): Promise<unknown> {
  const prepared = prepareRead(fn)
  const options = checkOptions(rawOptions)
  const objectGroup = `playwriter-read-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const target = await targetOf(options, deps, objectGroup)
  const { cdp } = target
  try {
    const called = await inTurn(cdp, () => evaluateRead(fn, prepared, options, target, objectGroup))
    const resultId = called.result.objectId
    if (!resultId) throw readError('the page returned no result object.')
    const summarized = await withDeadline(
      cdp.send('Runtime.callFunctionOn', { functionDeclaration: RESULT_SUMMARY_FN, objectId: resultId, returnByValue: true, throwOnSideEffect: true, objectGroup }),
      CDP_TIMEOUT_MS,
      'reading the readPage result',
    )
    if (summarized.exceptionDetails) throw failureOf(summarized.exceptionDetails, prepared, wrapperFor(prepared).firstLine)
    const summary: unknown = summarized.result.value
    if (!isSummary(summary)) throw readError('the page returned a result readPage cannot read.')
    for (const [level, text] of summary.logs) deps.log(level, text)
    if (summary.kind === 'value') return summary.json === undefined ? undefined : JSON.parse(summary.json)
    const elements = await elementsOf({ resultId, summary, target, deps, objectGroup })
    return summary.single ? elements[0] : elements
  } finally {
    await withDeadline(cdp.send('Runtime.releaseObjectGroup', { objectGroup }), CDP_TIMEOUT_MS, 'releasing the readPage objects').catch(() => {})
  }
}

/** The elements a read returned, as observe() names them: refs for the listed ones and what contains the rest. */
async function elementsOf({
  resultId,
  summary,
  target,
  deps,
  objectGroup,
}: {
  resultId: string
  summary: Summary
  target: { page: Page; cdp: ICDPSession; frame: FrameHandle }
  deps: ReadPageDeps
  objectGroup: string
}): Promise<ReadElement[]> {
  const described = summary.nodes ?? []
  if (described.length === 0) return []
  const list = await withDeadline(
    target.cdp.send('Runtime.callFunctionOn', { functionDeclaration: NODES_FN, objectId: resultId, returnByValue: false, objectGroup }),
    CDP_TIMEOUT_MS,
    'reading the returned elements',
  )
  if (!list.result.objectId) throw readError('the returned elements could not be read.')
  const { result: properties } = await withDeadline(
    target.cdp.send('Runtime.getProperties', { objectId: list.result.objectId, ownProperties: true }),
    CDP_TIMEOUT_MS,
    'listing the returned elements',
  )
  const objectIds = new Map<number, string>()
  for (const property of properties) {
    const objectId = property.value?.objectId
    if (/^\d+$/.test(property.name) && objectId) objectIds.set(Number(property.name), objectId)
  }
  const observation = described.some((node) => node.sameDocument) ? await deps.probes.observe(target.page, deps.context, {}, false) : null
  const elements: ReadElement[] = []
  for (const [index, node] of described.entries()) {
    const objectId = objectIds.get(index)
    if (!node.sameDocument || !observation || !objectId) {
      elements.push({ text: `${node.tag}${node.text ? ` "${node.text}"` : ''} — in another document than the one read; read it with a ref from that frame` })
      continue
    }
    const { node: domNode } = await withDeadline(target.cdp.send('DOM.describeNode', { objectId }), CDP_TIMEOUT_MS, 'identifying a returned element')
    const located = await deps.probes.locateNode(target.page, observation, domNode.backendNodeId, target.frame)
    elements.push(located.kind === 'element' ? { ref: located.element.ref, text: renderLocatedNode(located) } : { text: renderLocatedNode(located) })
  }
  return elements
}
