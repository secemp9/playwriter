/**
 * code-policy.ts — read the code a model sends to `execute` before it runs, and decide
 * whether a careful person could have done the same thing.
 *
 * Weak text-only models browse inhumanly in a few repeatable ways (see the incident list
 * this layer was designed from): `page.goto` in the middle of a flow, which reloads the
 * document and wipes SWR/React Query/Redux caches so the "repro" is biased; several
 * clicks/fills in one call, so nothing is looked at in between; loops of input; faked
 * conditions (`page.route`, `net.delay`, DOM/style writes, synthetic events from
 * `page.evaluate`); and calling the backend directly instead of using the UI.
 *
 * `analyzeCode` finds those sites with a real parser (Babel) and Babel's scope analysis
 * (`@babel/traverse`), never with regexes over the source and never by names alone:
 *   - a name is a sandbox or page global only when nothing in the code binds it, so a local
 *     `const style = {}` or `const location = …` is the code's own data, not the page's;
 *   - aliases are followed through their bindings (`const a = act`, `const { click } = act`,
 *     `const m = page.mouse`, `const s = el.style`), and computed keys are folded with
 *     `path.evaluate()` (`act['click']`, `el['inner' + 'HTML']`);
 *   - page code is found by resolving the page-function argument of `evaluate` & co. through
 *     its binding; page code that cannot be read (`page.evaluate(jsVar)`, a wrapper's
 *     parameter, `helpers.poke`, `eval` in page code) is reported as unanalysable instead of
 *     being treated as clean;
 *   - an action inside a helper function counts once per call of the helper, and inside a
 *     loop when the helper is called from one.
 * `checkPolicy` turns the sites into a verdict whose refusal text teaches the human way to do
 * the same thing.
 *
 * This static pass gives early, teaching refusals. It is not the enforcement boundary: in human
 * mode the executor also counts dispatched actions at run time (act's own counter and the
 * Playwright client instrumentation tap) and gives the sandbox a read-only CDP session, so code
 * the analysis cannot see through is still held to one action per call.
 *
 * The code runs as the body of `(async () => { CODE })()` in a vm, so it is parsed as a
 * script with top-level `return` and `await` allowed — the same shape the executor's
 * `getAutoReturnExpression` parses.
 */

import { parse, type ParseResult } from '@babel/parser'
import traverse, { type Binding, type NodePath } from '@babel/traverse'
import type { PolicyMode } from './probe-types.js'

export interface CodeSite {
  /** The callee or assignment target as written, e.g. `page.getByRole('button').click`. */
  api: string
  /** 1-based line in the submitted code. */
  line: number
}

/**
 * An input action. `viaAct`: an `act.*` call (human pointer path, busy and cover checks).
 * `viaScript`: a Playwright element action (`locator.click()`, `page.fill(selector, …)`): its
 * actionability checks run Playwright's script in the page as a user gesture, and fill/selectOption/
 * focus/… set values and focus from a script; `instead` is the act.* call that does it as a person.
 * `loop`, when set, names what runs it more than once in one call: a loop, a concurrent
 * callback, or a helper function called more than once.
 */
export type InputActionSite = CodeSite & { viaAct: boolean; viaScript?: { instead: string }; loop?: string }

/**
 * `document` — a new document loads (goto, reload, setContent, act.open, location.href=).
 * `spa` — the URL changes without a new document (act.spaNavigate, history.pushState, location.hash=).
 * `history` — a move through browser history (goBack/goForward, act.back, history.back()).
 * `reason` — the literal `reason` passed to `act.open(url, { reason })`, when there is one.
 * `inPage` — made by code the page evaluates (`page.evaluate(() => history.pushState(…))`).
 */
export type NavigationSite = CodeSite & {
  kind: 'document' | 'spa' | 'history'
  viaAct: boolean
  reason?: string
  inPage?: true
  loop?: string
}

/** Something that fakes the conditions under test. `why` says what it fakes, in plain words. */
export type ForcedStateSite = CodeSite & { why: string }

/** Code the analysis cannot read, so it cannot say what it does. `why` names what is unreadable. */
export type UnanalysableSite = CodeSite & { why: string }

/**
 * A Playwright read that runs Playwright's script in the page (`page.title()`, `locator.textContent()`,
 * `page.evaluate(…)`, `page.screenshot()`): Playwright runs it as a user gesture, so the page counts as
 * clicked afterwards. `note` adds what else it does to the page, when it does more.
 */
export type ScriptReadSite = CodeSite & { note?: string }

export interface CodeAnalysis {
  parseError?: string
  /** A ReturnStatement not inside a nested function (nor inside page-evaluated code). */
  hasTopLevelReturn: boolean
  inputActions: InputActionSite[]
  navigations: NavigationSite[]
  forcedState: ForcedStateSite[]
  apiBypass: CodeSite[]
  waits: CodeSite[]
  scriptReads: ScriptReadSite[]
  unanalysable: UnanalysableSite[]
}

export interface PolicyVerdict {
  allowed: boolean
  refusal?: string
  notes: string[]
}

/** `act.<m>` calls that are input actions. */
export const ACT_INPUT_METHODS: readonly string[] = [
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'select',
  'check',
  'uncheck',
  'hover',
  'scroll',
  'scrollTo',
  'upload',
  'drag',
]

/** `act.<m>` calls that wait for the app; never restricted. */
export const ACT_WAIT_METHODS: readonly string[] = ['waitForIdle', 'wait']

/** `act.<m>` calls that navigate. They count as input actions. */
export const ACT_NAVIGATION_METHODS: readonly string[] = ['open', 'back', 'spaNavigate']

const ACT_NAVIGATION_KIND: Record<string, NavigationSite['kind']> = {
  open: 'document',
  back: 'history',
  spaNavigate: 'spa',
}

/**
 * Playwright Locator/Page/ElementHandle/Frame methods that act on an element (`page.click(selector)`
 * is one too), with the act.* call that does the same as a person. Playwright runs each through its
 * injected script: the actionability checks run in the page as a user gesture, and fill, clear,
 * selectOption, selectText, setInputFiles, focus and blur set values, selection and focus from a
 * script. `type`/`press` need an argument: with none they are getters elsewhere
 * (`ConsoleMessage.type()`), while Playwright's input versions always take one.
 */
const PLAYWRIGHT_INPUT_METHODS: Record<string, { needsArgument: boolean; instead: string }> = {
  click: { needsArgument: false, instead: 'act.click(ref)' },
  dblclick: { needsArgument: false, instead: 'act.dblclick(ref)' },
  tap: { needsArgument: false, instead: 'act.click(ref)' },
  fill: { needsArgument: false, instead: "act.fill(ref, 'text')" },
  type: { needsArgument: true, instead: "act.type(ref, 'text')" },
  press: { needsArgument: true, instead: "act.press('Key', { ref })" },
  pressSequentially: { needsArgument: false, instead: "act.type(ref, 'text')" },
  check: { needsArgument: false, instead: 'act.check(ref)' },
  uncheck: { needsArgument: false, instead: 'act.uncheck(ref)' },
  setChecked: { needsArgument: false, instead: 'act.check(ref) or act.uncheck(ref)' },
  selectOption: { needsArgument: false, instead: "act.select(ref, 'option')" },
  setInputFiles: { needsArgument: false, instead: 'act.upload(ref, path)' },
  hover: { needsArgument: false, instead: 'act.hover(ref)' },
  dragTo: { needsArgument: false, instead: 'act.drag(fromRef, toRef)' },
  dragAndDrop: { needsArgument: false, instead: 'act.drag(fromRef, toRef)' },
  clear: { needsArgument: false, instead: "act.fill(ref, '')" },
  selectText: { needsArgument: false, instead: "act.click(ref), then act.press('Control+A')" },
  focus: { needsArgument: false, instead: "act.click(ref) — a person focuses a field by clicking it — or act.press('Tab')" },
  blur: { needsArgument: false, instead: "act.press('Tab'), or act.click on something else" },
  scrollIntoViewIfNeeded: { needsArgument: false, instead: 'act.scrollTo(ref)' },
}

const MOUSE_METHODS: Record<string, true> = { click: true, dblclick: true, down: true, up: true, move: true, wheel: true }
const KEYBOARD_METHODS: Record<string, true> = { press: true, type: true, down: true, up: true, insertText: true }
const HUMAN_MOUSE_INPUT_METHODS: Record<string, true> = { click: true, moveTo: true, hover: true }

const NAVIGATION_METHODS: Record<string, NavigationSite['kind']> = {
  goto: 'document',
  reload: 'document',
  setContent: 'document',
  goBack: 'history',
  goForward: 'history',
}

const FORCED_STATE_METHODS: Record<string, string> = {
  route: 'intercepts network requests and answers them from the script',
  routeFromHAR: 'answers network requests from a recorded HAR file',
  routeWebSocket: 'intercepts WebSocket traffic from the script',
  fulfill: 'answers a request with a response made up by the script',
  addInitScript: 'injects a script into every document the page loads',
  addStyleTag: 'injects CSS into the page',
  addScriptTag: 'injects a script into the page',
  addCookies: 'writes cookies directly',
  clearCookies: 'deletes cookies directly',
  setOffline: 'forces the browser offline',
  dispatchEvent: 'fires a synthetic event instead of real input',
  exposeBinding: 'adds a global function to the page',
  exposeFunction: 'adds a global function to the page',
  highlight: "draws Playwright's highlight overlay into the page",
  setViewportSize: 'resizes the viewport (the page lays out again and gets a resize event)',
  emulateMedia: 'emulates another media type, color scheme or motion setting',
  setGeolocation: 'fakes the location the page reads',
  grantPermissions: 'changes what the browser lets the page do (permissions)',
  clearPermissions: 'changes what the browser lets the page do (permissions)',
  setExtraHTTPHeaders: 'adds headers to every request the page makes',
  setHTTPCredentials: 'answers HTTP authentication prompts from the script',
  setStorageState: 'writes cookies and storage directly',
  pdf: 'prints the page: its beforeprint and afterprint handlers run and it lays out for paper',
  newCDPSession: "opens a CDP session that can send any command (getCDPSession({ page }) gives the page's session, read-only in human mode)",
  getExistingCDPSession: "opens a CDP session that can send any command (getCDPSession({ page }) gives the page's session, read-only in human mode)",
  newBrowserCDPSession: 'opens a browser CDP session that can send any command to any page',
}

/** `page.clock.*` / `context.clock.*`: Playwright's fake timers. */
const CLOCK_METHODS: Record<string, true> = { install: true, fastForward: true, pauseAt: true, resume: true, runFor: true, setFixedTime: true, setSystemTime: true }

const WAIT_METHODS: Record<string, true> = {
  waitForTimeout: true,
  waitForLoadState: true,
  waitForURL: true,
  waitForResponse: true,
  waitForRequest: true,
  waitForEvent: true,
  waitForNavigation: true,
}

const SCREENSHOT_NOTE = 'unless caret is "initial" it also writes caret-color into the inline style of every text field while it shoots'

/**
 * Playwright reads that run Playwright's script in the page (Locator, Page, Frame, ElementHandle,
 * JSHandle, BrowserContext), which Playwright runs as a user gesture — measured: `page.title()` or
 * `locator.count()` alone leaves a fresh page with `navigator.userActivation.hasBeenActive`. The
 * waits among them poll with that script. `all` is `Locator.all()`; `Promise.all` is told apart by
 * its receiver.
 */
const SCRIPT_READ_METHODS: Record<string, { note?: string }> = {
  textContent: {},
  innerText: {},
  innerHTML: {},
  getAttribute: {},
  inputValue: {},
  isChecked: {},
  isDisabled: {},
  isEditable: {},
  isEnabled: {},
  isHidden: {},
  isVisible: {},
  count: {},
  all: {},
  allTextContents: {},
  allInnerTexts: {},
  boundingBox: {},
  elementHandle: {},
  elementHandles: {},
  evaluate: {},
  evaluateAll: {},
  evaluateHandle: {},
  $eval: {},
  $$eval: {},
  $: {},
  $$: {},
  ariaSnapshot: {},
  _snapshotForAI: {},
  screenshot: { note: SCREENSHOT_NOTE },
  title: {},
  content: {},
  frameElement: {},
  ownerFrame: {},
  jsonValue: {},
  getProperty: {},
  getProperties: {},
  waitForSelector: {},
  waitForFunction: {},
  waitFor: {},
  waitForElementState: {},
  storageState: { note: 'it runs that script in every open page and opens a tab for each other origin it saves' },
}

/** Sandbox globals that are Playwright objects: a script-read name called on any other global (`Promise.all`) is not Playwright's. */
const PLAYWRIGHT_GLOBALS: Record<string, true> = { page: true, context: true, browser: true }

/** Methods whose page-function argument runs inside the page, and the index of that argument. */
const PAGE_FUNCTION_ARGUMENT: Record<string, number> = {
  evaluate: 0,
  evaluateHandle: 0,
  evaluateAll: 0,
  waitForFunction: 0,
  addInitScript: 0,
  $eval: 1,
  $$eval: 1,
}

/** Sandbox globals whose function argument runs inside the page, and the index of that argument. */
const PAGE_FUNCTION_GLOBALS: Record<string, number> = { readPage: 0 }

/** `page.request` / `context.request` — Playwright's APIRequestContext talks to the server directly. */
const API_REQUEST_METHODS: Record<string, true> = { get: true, post: true, put: true, patch: true, delete: true, head: true, fetch: true }

const BYPASS_MODULES: Record<string, true> = {
  http: true,
  https: true,
  'node:http': true,
  'node:https': true,
  child_process: true,
  'node:child_process': true,
}

const ITERATION_METHODS: Record<string, true> = {
  forEach: true,
  map: true,
  flatMap: true,
  reduce: true,
  reduceRight: true,
  some: true,
  every: true,
  filter: true,
  find: true,
  findIndex: true,
  findLast: true,
  findLastIndex: true,
}

const PROMISE_COMBINATORS: Record<string, true> = { all: true, allSettled: true, race: true, any: true }

/** `fn.call(this, …)` / `fn.apply(this, args)` call `fn`. */
const INDIRECT_CALL_METHODS: Record<string, true> = { call: true, apply: true }

// --- page-code vocabulary ---------------------------------------------------------------

const GLOBAL_OBJECT_NAMES: Record<string, true> = { window: true, self: true, globalThis: true, top: true, parent: true }

const DOM_WRITE_PROPERTIES: Record<string, true> = {
  innerHTML: true,
  outerHTML: true,
  textContent: true,
  innerText: true,
  outerText: true,
  nodeValue: true,
  value: true,
  valueAsNumber: true,
  valueAsDate: true,
  checked: true,
  indeterminate: true,
  selected: true,
  selectedIndex: true,
  disabled: true,
  hidden: true,
  className: true,
  src: true,
  href: true,
  contentEditable: true,
  designMode: true,
}

const DOM_WRITE_METHODS: Record<string, true> = {
  appendChild: true,
  append: true,
  prepend: true,
  insertBefore: true,
  insertAdjacentHTML: true,
  insertAdjacentElement: true,
  insertAdjacentText: true,
  remove: true,
  removeChild: true,
  replaceWith: true,
  replaceChildren: true,
  replaceChild: true,
  before: true,
  after: true,
  setAttribute: true,
  setAttributeNS: true,
  removeAttribute: true,
  removeAttributeNS: true,
  toggleAttribute: true,
  setHTMLUnsafe: true,
}

const CLASS_LIST_WRITE_METHODS: Record<string, true> = { add: true, remove: true, toggle: true, replace: true }
const STYLE_WRITE_METHODS: Record<string, true> = { setProperty: true, removeProperty: true }
const STORAGE_WRITE_METHODS: Record<string, true> = { setItem: true, removeItem: true, clear: true }
const SYNTHETIC_EVENT_METHODS: Record<string, true> = {
  dispatchEvent: true,
  click: true,
  focus: true,
  blur: true,
  submit: true,
  requestSubmit: true,
}
const LOCATION_NAVIGATION_METHODS: Record<string, true> = { assign: true, replace: true, reload: true }
const HISTORY_SPA_METHODS: Record<string, true> = { pushState: true, replaceState: true }
const HISTORY_MOVE_METHODS: Record<string, true> = { back: true, go: true, forward: true }
/** Page globals whose own methods are all classified above; anything else called on them is a read. */
const PAGE_API_ROOTS: Record<string, true> = { location: true, history: true, localStorage: true, sessionStorage: true, cookieStore: true }
/** Timers that run a STRING argument as code. */
const STRING_TIMERS: Record<string, true> = { setTimeout: true, setInterval: true }
const REACT_INTERNALS_RE = /__react(Fiber|Props|Container|InternalInstance|EventHandlers)|memoizedState|memoizedProps|pendingProps/

const WHY = {
  domWrite: 'writes the DOM from a script',
  styleWrite: 'changes styles from a script',
  syntheticEvent: 'fires a synthetic event instead of real input',
  handlerCall: 'calls an event handler directly instead of producing the event',
  storageWrite: 'writes browser storage or cookies from a script',
  reactWrite: 'writes React internals',
  pageFetch: 'calls the backend from page code',
  pageGlobal: 'writes a global of the page',
  pageWrite: 'writes a property of a page object from a script',
  redefine: 'redefines properties of page objects',
  force: 'force: true skips the checks that a person could do this (visible, enabled, not covered by something else)',
} as const

const UNREADABLE = {
  eval: 'runs a string as code, and the string is built at run time',
  timerString: 'runs a string as code when the timer fires',
  with: '`with` makes every name inside it ambiguous',
  actComputed: 'calls an act method whose name is computed at run time',
} as const

// --- AST plumbing -----------------------------------------------------------------------

type AnyPath = NodePath

/**
 * Where a traversal reads: the submitted code, or one page-code string parsed on its own.
 * `pageProgram`: every node of this source is page code.
 */
interface Source {
  text: string
  lineOffset: number
  pageProgram: boolean
}

/**
 * What an expression is, as far as its bindings tell: a `global` (a name nothing in the code
 * binds — a sandbox global like `act`/`page`, or in page code a page global like `location`)
 * followed by the properties read off it; or a `local` value — `fresh` when the code itself
 * made it (an object/array literal, `new X()`, `Array(…)`), otherwise unknown (a parameter, a
 * call result, a reassigned variable). `chain` entries are property names; null = a computed
 * key that does not fold to a constant.
 */
type Access =
  | { kind: 'global'; name: string; chain: Array<string | null> }
  | { kind: 'local'; fresh: AnyPath | null; chain: Array<string | null> }

const UNKNOWN: Access = { kind: 'local', fresh: null, chain: [] }

/**
 * Own-key lookup in the tables above. A plain `table[name]` would find
 * `Object.prototype` members, so `x.toString()` would look like a table hit.
 */
function listed(table: Record<string, unknown>, key: string | null | undefined): key is string {
  return typeof key === 'string' && Object.hasOwn(table, key)
}

function parseScript(code: string): ParseResult | { error: string } {
  try {
    return parse(code, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      errorRecovery: false,
    })
  } catch (error) {
    if (error instanceof SyntaxError && 'loc' in error) {
      const loc = error.loc
      const message = error.message.replace(/\s*\(\d+:\d+\)$/, '')
      if (typeof loc === 'object' && loc !== null && 'line' in loc && 'column' in loc) {
        return { error: `${message} (line ${String(loc.line)}, column ${Number(loc.column) + 1})` }
      }
      return { error: message }
    }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** A constant string or number the expression folds to (`'click'`, `'inner' + 'HTML'`, a const), else null. */
function foldedKey(path: AnyPath): string | null {
  const folded = path.evaluate()
  if (!folded.confident) return null
  return typeof folded.value === 'string' || typeof folded.value === 'number' ? String(folded.value) : null
}

/** `a.b` → `b`, `a['b']`/`a[k]` with a constant k → `b`; null for a key that does not fold. */
function propertyKey(member: AnyPath): string | null {
  if (!member.isMemberExpression() && !member.isOptionalMemberExpression()) return null
  const property = member.get('property')
  if (!member.node.computed) {
    if (property.isIdentifier()) return property.node.name
    if (property.isPrivateName()) return `#${property.node.id.name}`
    return null
  }
  return foldedKey(property)
}

/** The key of an object-literal or object-pattern property: written out, or folded. */
function objectKey(property: AnyPath): string | null {
  if (!property.isObjectProperty() && !property.isObjectMethod()) return null
  const key = property.get('key')
  if (property.node.computed) return foldedKey(key)
  if (key.isIdentifier()) return key.node.name
  if (key.isStringLiteral()) return key.node.value
  if (key.isNumericLiteral()) return String(key.node.value)
  return null
}

/** The object and property of `a.b` / `a?.b` / `a[k]`, or null for any other node. */
function memberParts(path: AnyPath): { object: AnyPath; property: AnyPath } | null {
  if (path.isMemberExpression() || path.isOptionalMemberExpression()) return { object: path.get('object'), property: path.get('property') }
  return null
}

/** A value the code creates right there; its properties and methods are the code's own data. */
function isFreshValue(path: AnyPath): boolean {
  if (
    path.isObjectExpression() ||
    path.isArrayExpression() ||
    path.isNewExpression() ||
    path.isStringLiteral() ||
    path.isNumericLiteral() ||
    path.isBooleanLiteral() ||
    path.isNullLiteral() ||
    path.isTemplateLiteral() ||
    path.isRegExpLiteral() ||
    path.isBigIntLiteral() ||
    path.isFunctionExpression() ||
    path.isArrowFunctionExpression() ||
    path.isClassExpression()
  ) {
    return true
  }
  if (!path.isCallExpression()) return false
  // Array(3), Array.from(xs), Array.of(…) — when `Array` is the global.
  const callee = path.get('callee')
  const base = memberParts(callee)?.object ?? callee
  if (!base.isIdentifier() || base.node.name !== 'Array') return false
  return path.scope.getBinding('Array') === undefined
}

/** `[root, ...chain]` of a global access, without `window.`/`globalThis.` prefixes and with `document.location` → `location`. */
function globalNames(access: Access): Array<string | null> | null {
  if (access.kind !== 'global') return null
  const names: Array<string | null> = [access.name, ...access.chain]
  while (names.length > 1 && listed(GLOBAL_OBJECT_NAMES, names[0])) names.shift()
  if (names[0] === 'document' && names[1] === 'location') names.shift()
  return names
}

function lastKey(access: Access): string | null | undefined {
  return access.chain.length > 0 ? access.chain[access.chain.length - 1] : undefined
}

/** The value node of `{ name: value }` in an object literal (non-computed key), or null. */
function objectPropertyValue(node: AnyPath | undefined, name: string): AnyPath | null {
  if (!node?.isObjectExpression()) return null
  for (const property of node.get('properties')) {
    if (!property.isObjectProperty() || property.node.computed) continue
    if (objectKey(property) === name) return property.get('value')
  }
  return null
}

function hasForceTrue(node: AnyPath): boolean {
  const force = objectPropertyValue(node, 'force')
  return !!force?.isBooleanLiteral() && force.node.value === true
}

/** The `reason` of `act.open(url, { reason })` when it folds to a non-empty string. */
function reasonOption(node: AnyPath | undefined): string | undefined {
  const value = objectPropertyValue(node, 'reason')
  if (!value) return undefined
  const folded = value.evaluate()
  const reason = folded.confident && typeof folded.value === 'string' ? folded.value.trim() : ''
  return reason ? reason : undefined
}

/**
 * Calls whose callbacks repeat or run concurrently: `xs.forEach(fn)`, `Promise.all([...])`,
 * `setInterval(fn)`. For Promise combinators every argument counts (`[a.click(), b.click()]`
 * starts both at once); for the others only function arguments.
 */
function repeatingCallLabel(call: AnyPath): { label: string; everyArgument: boolean } | null {
  if (!call.isCallExpression() && !call.isOptionalCallExpression()) return null
  const callee = call.get('callee')
  if (callee.isIdentifier()) {
    return callee.node.name === 'setInterval' && !callee.scope.getBinding('setInterval') ? { label: 'a setInterval callback', everyArgument: false } : null
  }
  const object = memberParts(callee)?.object
  if (!object) return null
  const method = propertyKey(callee)
  if (object.isIdentifier() && object.node.name === 'Promise' && !object.scope.getBinding('Promise') && listed(PROMISE_COMBINATORS, method)) {
    return { label: `Promise.${method}`, everyArgument: true }
  }
  if (listed(ITERATION_METHODS, method)) return { label: `a .${method} callback`, everyArgument: false }
  return null
}

/** The loop or concurrent callback around `path`, walking out to the program. */
function loopLabelOf(path: AnyPath): string | undefined {
  let child: AnyPath = path
  let parent = path.parentPath
  while (parent) {
    if (parent.isForStatement() && child.key !== 'init') return 'a for loop'
    if (parent.isForOfStatement() && child.key !== 'right') return parent.node.await ? 'a for await…of loop' : 'a for…of loop'
    if (parent.isForInStatement() && child.key !== 'right') return 'a for…in loop'
    if (parent.isWhileStatement()) return 'a while loop'
    if (parent.isDoWhileStatement()) return 'a do…while loop'
    if (child.listKey === 'arguments') {
      const repeating = repeatingCallLabel(parent)
      if (repeating && (repeating.everyArgument || child.isFunction())) return repeating.label
    }
    child = parent
    parent = parent.parentPath
  }
  return undefined
}

/** The name and binding a function is called by: `function go() {}` or `const go = () => {}`. */
function functionBinding(fn: AnyPath): { name: string; binding: Binding } | null {
  if (fn.isFunctionDeclaration() && fn.node.id) {
    const name = fn.node.id.name
    const binding = fn.parentPath?.scope.getBinding(name)
    return binding && binding.path.node === fn.node ? { name, binding } : null
  }
  const declarator = fn.parentPath
  if ((fn.isFunctionExpression() || fn.isArrowFunctionExpression()) && declarator?.isVariableDeclarator()) {
    const id = declarator.get('id')
    if (!id.isIdentifier()) return null
    const binding = declarator.scope.getBinding(id.node.name)
    return binding && binding.path.node === declarator.node && binding.constantViolations.length === 0 ? { name: id.node.name, binding } : null
  }
  return null
}

/**
 * What runs `path` more than once in one call: a loop or concurrent callback around it, or a
 * helper function around it that is called more than once, passed to an iteration method, or
 * called from a loop. Calls the analysis cannot see (a helper stored in an object, called through
 * a variable) are the run-time counter's business.
 */
function repetitionOf(path: AnyPath, seen: Set<AnyPath['node']> = new Set()): string | undefined {
  const direct = loopLabelOf(path)
  if (direct) return direct
  for (let fn = path.getFunctionParent(); fn; fn = fn.parentPath?.getFunctionParent() ?? null) {
    if (seen.has(fn.node)) continue
    seen.add(fn.node)
    const bound = functionBinding(fn)
    if (!bound) continue
    const calls: AnyPath[] = []
    for (const reference of bound.binding.referencePaths) {
      const parent = reference.parentPath
      if (reference.listKey === 'arguments' && parent) {
        const repeating = repeatingCallLabel(parent)
        if (repeating) return `${repeating.label} (through helper ${bound.name}() on line ${lineNumber(reference)})`
      }
      if (reference.key === 'callee' && parent && (parent.isCallExpression() || parent.isOptionalCallExpression())) calls.push(reference)
    }
    if (calls.length > 1) return `helper ${bound.name}(), called on lines ${calls.map(lineNumber).join(', ')}`
    if (calls.length === 1) {
      const outer = repetitionOf(calls[0], seen)
      if (outer) return `${outer} (through helper ${bound.name}() on line ${lineNumber(calls[0])})`
    }
  }
  return undefined
}

function lineNumber(path: AnyPath): number {
  return path.node.loc?.start.line ?? 1
}

/** The resolved page-function argument of an `evaluate`-like call. */
type PageArgument = { kind: 'function'; path: AnyPath } | { kind: 'string'; text: string; at: AnyPath } | { kind: 'unreadable'; why: string }

/**
 * The page code an `evaluate`-like call runs: an inline function, a function or a constant
 * string reached through bindings, or a string the expression folds to. Anything else — a
 * parameter, a property of an object, a string built at run time — cannot be read.
 */
function resolvePageArgument(argument: AnyPath, seen: Set<AnyPath['node']> = new Set()): PageArgument {
  if (argument.isFunctionExpression() || argument.isArrowFunctionExpression()) return { kind: 'function', path: argument }
  if (argument.isIdentifier() && !seen.has(argument.node)) {
    seen.add(argument.node)
    const binding = argument.scope.getBinding(argument.node.name)
    if (binding && binding.constantViolations.length === 0) {
      if (binding.path.isFunctionDeclaration()) return { kind: 'function', path: binding.path }
      if (binding.path.isVariableDeclarator() && binding.path.get('id').isIdentifier()) {
        const init = binding.path.get('init')
        if (!Array.isArray(init) && init.node) return resolvePageArgument(init, seen)
      }
    }
  }
  const folded = argument.evaluate()
  if (folded.confident && typeof folded.value === 'string') return { kind: 'string', text: folded.value, at: argument }
  if (argument.isIdentifier()) {
    const binding = argument.scope.getBinding(argument.node.name)
    const what = !binding ? 'a variable from an earlier call' : binding.kind === 'param' ? 'a parameter of the function around it' : 'a value set at run time'
    return { kind: 'unreadable', why: `its page code comes from \`${argument.node.name}\`, ${what}` }
  }
  return { kind: 'unreadable', why: `its page code is \`${argument.toString().slice(0, 60)}\`, which is only known at run time` }
}

class Analyzer {
  readonly result: CodeAnalysis = {
    hasTopLevelReturn: false,
    inputActions: [],
    navigations: [],
    forcedState: [],
    apiBypass: [],
    waits: [],
    scriptReads: [],
    unanalysable: [],
  }
  /** Function nodes the page evaluates: their bodies are page code. */
  private readonly pageRoots = new Set<AnyPath['node']>()

  analyze(file: ParseResult, code: string): void {
    const source: Source = { text: code, lineOffset: 0, pageProgram: false }
    const strings = this.findPageCode(file, source)
    traverse(file, this.visitor(source))
    for (const { text, at } of strings) this.visitPageString(text, at, source)
  }

  /**
   * Resolve the page-function argument of every `evaluate`-like call made by vm code. A call
   * inside page code (`document.evaluate(xpath, …)` in a page function) is the page's own API,
   * and a resolved page function can contain such calls, so resolution repeats without the calls
   * found inside page code until nothing changes.
   */
  private findPageCode(file: ParseResult, source: Source): Array<{ text: string; at: AnyPath }> {
    let calls: AnyPath[] = []
    traverse(file, {
      'CallExpression|OptionalCallExpression': (path: AnyPath) => {
        if (this.pageArgumentIndex(path) !== null) calls.push(path)
      },
    })
    for (;;) {
      const roots = new Set<AnyPath['node']>()
      const strings: Array<{ text: string; at: AnyPath }> = []
      const unreadable: UnanalysableSite[] = []
      for (const call of calls) {
        const index = this.pageArgumentIndex(call) ?? 0
        if (!call.isCallExpression() && !call.isOptionalCallExpression()) continue
        const args = call.get('arguments')
        const callee = call.get('callee')
        const site = { api: this.text(callee, source), line: this.lineOf(callee, source) }
        if (args.slice(0, index + 1).some((arg) => arg.isSpreadElement())) {
          unreadable.push({ ...site, why: 'its page code is passed through a spread argument' })
          continue
        }
        const argument = args[index]
        if (!argument) continue
        const resolved = resolvePageArgument(argument)
        if (resolved.kind === 'function') roots.add(resolved.path.node)
        else if (resolved.kind === 'string') strings.push({ text: resolved.text, at: resolved.at })
        else unreadable.push({ ...site, why: resolved.why })
      }
      const inside = calls.filter((call) => call.findParent((parent) => roots.has(parent.node)) !== null)
      if (inside.length === 0) {
        for (const root of roots) this.pageRoots.add(root)
        this.result.unanalysable.push(...unreadable)
        return strings
      }
      calls = calls.filter((call) => !inside.includes(call))
    }
  }

  private pageArgumentIndex(call: AnyPath): number | null {
    if (!call.isCallExpression() && !call.isOptionalCallExpression()) return null
    const callee = call.get('callee')
    // `readPage(fn)`: the sandbox global, unless the code bound the name itself.
    if (callee.isIdentifier()) {
      const name = callee.node.name
      return listed(PAGE_FUNCTION_GLOBALS, name) && !callee.scope.getBinding(name) ? PAGE_FUNCTION_GLOBALS[name] : null
    }
    const method = propertyKey(callee)
    return listed(PAGE_FUNCTION_ARGUMENT, method) ? PAGE_FUNCTION_ARGUMENT[method] : null
  }

  /** `page.evaluate("document.body.innerHTML = ''")` — the string is page code too. */
  private visitPageString(text: string, at: AnyPath, outer: Source): void {
    // Playwright runs a string that is a function expression as that function; `function () {}`
    // alone does not parse as a script, so it is read as an expression second.
    let parsed = parseScript(text)
    if ('error' in parsed) parsed = parseScript(`(${text}\n)`)
    const site = { api: this.text(at.parentPath ?? at, outer), line: this.lineOf(at, outer) }
    if ('error' in parsed) {
      this.result.unanalysable.push({ ...site, why: `its page code does not parse (${parsed.error})` })
      return
    }
    traverse(parsed, this.visitor({ text, lineOffset: this.lineOf(at, outer) - 1, pageProgram: true }))
  }

  private visitor(source: Source) {
    return {
      ReturnStatement: (path: AnyPath) => {
        if (!source.pageProgram && !path.getFunctionParent()) this.result.hasTopLevelReturn = true
      },
      WithStatement: (path: AnyPath) => {
        this.result.unanalysable.push({ api: 'with', line: this.lineOf(path, source), why: UNREADABLE.with })
      },
      'CallExpression|OptionalCallExpression': (path: AnyPath) => {
        const root = this.pageRootOf(path, source)
        if (root) this.classifyPageCall(path, root, source)
        else this.classifyNodeCall(path, source)
      },
      NewExpression: (path: AnyPath) => {
        this.classifyNew(path, this.pageRootOf(path, source), source)
      },
      AssignmentExpression: (path: AnyPath) => {
        const root = this.pageRootOf(path, source)
        if (root && path.isAssignmentExpression()) this.classifyPageWrite(path.get('left'), root, source)
      },
      UpdateExpression: (path: AnyPath) => {
        const root = this.pageRootOf(path, source)
        if (root && path.isUpdateExpression()) this.classifyPageWrite(path.get('argument'), root, source)
      },
    }
  }

  /** The page function (or page-code program) `path` is inside, or null for vm code. */
  private pageRootOf(path: AnyPath, source: Source): AnyPath | null {
    if (source.pageProgram) return path.scope.getProgramParent().path
    return path.find((candidate) => this.pageRoots.has(candidate.node))
  }

  // --- bindings ------------------------------------------------------------------------------

  /**
   * The binding `name` refers to at `path`. In page code only bindings made inside the page code
   * count: the page function does not close over the vm code's variables, so there `location`
   * is the page's even when the vm code declared one.
   */
  private bindingOf(path: AnyPath, name: string, root: AnyPath | null): Binding | null {
    const binding = path.scope.getBinding(name)
    if (!binding) return null
    if (root && binding.scope.path !== root && !binding.scope.path.isDescendant(root)) return null
    return binding
  }

  private accessOf(path: AnyPath, root: AnyPath | null, seen: Set<AnyPath['node']> = new Set()): Access {
    if (path.isIdentifier()) {
      const binding = this.bindingOf(path, path.node.name, root)
      return binding ? this.accessOfBinding(binding, path.node.name, root, seen) : { kind: 'global', name: path.node.name, chain: [] }
    }
    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      const base = this.accessOf(path.get('object'), root, seen)
      return { ...base, chain: [...base.chain, propertyKey(path)] }
    }
    if (path.isAwaitExpression()) return this.accessOf(path.get('argument'), root, seen)
    if (path.isSequenceExpression()) {
      const expressions = path.get('expressions')
      return this.accessOf(expressions[expressions.length - 1], root, seen)
    }
    if (isFreshValue(path)) return { kind: 'local', fresh: path, chain: [] }
    return UNKNOWN
  }

  /** A binding's value: followed through `const x = <expr>` and destructuring; unknown otherwise. */
  private accessOfBinding(binding: Binding, name: string, root: AnyPath | null, seen: Set<AnyPath['node']>): Access {
    const declarator = binding.path
    if (binding.constantViolations.length > 0 || !declarator.isVariableDeclarator() || seen.has(declarator.node)) return UNKNOWN
    const init = declarator.get('init')
    if (Array.isArray(init) || !init.node) return UNKNOWN
    seen.add(declarator.node)
    const base = this.accessOf(init, root, seen)
    const keys = patternKeys(declarator.get('id'), name)
    if (keys === null) return UNKNOWN
    return { ...base, chain: [...base.chain, ...keys] }
  }

  /**
   * Re-root an access that reads into an object literal at the property's own value
   * (`const ctx = { page }; ctx.page` → `page`). A key the literal does not have was set later
   * to something unknown.
   */
  private settle(access: Access, root: AnyPath | null): Access {
    let current = access
    for (let hops = 0; current.kind === 'local' && current.fresh && current.chain.length > 0; hops++) {
      const key = current.chain[0]
      const value = key === null || hops > 16 ? null : objectPropertyValue(current.fresh, key)
      if (!value) return { kind: 'local', fresh: null, chain: current.chain }
      const base = this.accessOf(value, root)
      current = { ...base, chain: [...base.chain, ...current.chain.slice(1)] }
    }
    return current
  }

  /** The callee as an access, with `fn.call(…)`/`fn.apply(…)` read as a call of `fn`. */
  private calleeAccess(callee: AnyPath, root: AnyPath | null): { access: Access; receiver: Access | null } {
    let target = callee
    const indirect = memberParts(target)
    if (indirect && listed(INDIRECT_CALL_METHODS, propertyKey(target))) target = indirect.object
    const member = memberParts(target)
    if (!member) {
      const access = this.settle(this.accessOf(target, root), root)
      return { access, receiver: access.chain.length > 0 ? { ...access, chain: access.chain.slice(0, -1) } : null }
    }
    const receiver = this.settle(this.accessOf(member.object, root), root)
    return { access: { ...receiver, chain: [...receiver.chain, propertyKey(target)] }, receiver }
  }

  // --- recording ----------------------------------------------------------------------------

  private lineOf(path: AnyPath, source: Source): number {
    const property = memberParts(path)?.property.node
    const anchor = property?.loc ? property : path.node
    return (anchor.loc?.start.line ?? 1) + source.lineOffset
  }

  /** The node as written, with line breaks inside call chains removed; long chains keep their tail. */
  private text(path: AnyPath, source: Source): string {
    const raw = source.text.slice(path.node.start ?? 0, path.node.end ?? 0)
    const text = raw.replace(/\s*\n\s*/g, '').replace(/\s+/g, ' ')
    return text.length > 80 ? `…${text.slice(-79)}` : text
  }

  private pushInput(path: AnyPath, site: CodeSite, viaAct: boolean, viaScript?: { instead: string }): void {
    const loop = repetitionOf(path)
    this.result.inputActions.push({ ...site, viaAct, ...(viaScript ? { viaScript } : {}), ...(loop ? { loop } : {}) })
  }

  private pushNavigation(path: AnyPath, site: CodeSite & { kind: NavigationSite['kind']; viaAct: boolean; reason?: string; inPage?: true }): void {
    const loop = repetitionOf(path)
    this.result.navigations.push({ ...site, ...(loop ? { loop } : {}) })
  }

  // --- the vm side (Playwright, act, net, …) -------------------------------------------

  private classifyNodeCall(path: AnyPath, source: Source): void {
    if (!path.isCallExpression() && !path.isOptionalCallExpression()) return
    const callee = path.get('callee')
    const args = path.get('arguments')
    const line = this.lineOf(callee, source)
    const { access, receiver } = this.calleeAccess(callee, null)
    const names = globalNames(access)

    if (names) {
      const [root, ...rest] = names
      if (rest.length === 0) {
        if (root === 'fetch') this.result.apiBypass.push({ api: 'fetch', line })
        else if (root === 'waitForPageLoad') this.result.waits.push({ api: 'waitForPageLoad', line })
        else if (root === 'eval' || root === 'Function') this.result.unanalysable.push({ api: root, line, why: UNREADABLE.eval })
        else if (root === 'require') {
          const moduleName = args[0]?.isStringLiteral() ? args[0].node.value : null
          if (listed(BYPASS_MODULES, moduleName)) this.result.apiBypass.push({ api: `require('${moduleName}')`, line })
        }
        return
      }
      if (root === 'act') return this.classifyActCall(path, rest, args, line)
      if (root === 'humanMouse') {
        if (rest.length === 1 && listed(HUMAN_MOUSE_INPUT_METHODS, rest[0])) this.pushInput(path, { api: `humanMouse.${rest[0]}`, line }, false)
        return
      }
      if (root === 'net') {
        if (rest.length === 1 && rest[0] === 'delay') this.result.forcedState.push({ api: 'net.delay', line, why: 'delays network responses artificially' })
        return
      }
      if (root === 'ghostCursor') {
        if (rest.length === 1 && rest[0] === 'show') {
          this.result.forcedState.push({
            api: 'ghostCursor.show',
            line,
            why: 'adds a cursor element and a global to the page; recording.startCdp draws the pointer into the video without touching it',
          })
        }
        return
      }
    }

    const method = lastKey(access)
    if (!method || !receiver) return
    // Methods of a value the code made itself (an array's fill, a Map's clear) are not Playwright's.
    if (receiver.kind === 'local' && receiver.fresh && receiver.chain.length === 0) return
    const api = this.text(callee, source)
    const receiverKey = receiver.kind === 'global' && receiver.chain.length === 0 ? receiver.name : lastKey(receiver)

    if (receiverKey === 'mouse') {
      if (listed(MOUSE_METHODS, method)) this.pushInput(path, { api, line }, false)
      return
    }
    if (receiverKey === 'keyboard') {
      if (listed(KEYBOARD_METHODS, method)) this.pushInput(path, { api, line }, false)
      return
    }
    if (receiverKey === 'touchscreen') {
      if (method === 'tap') this.pushInput(path, { api, line }, false)
      return
    }
    if (receiverKey === 'request' && listed(API_REQUEST_METHODS, method)) {
      this.result.apiBypass.push({ api, line })
      return
    }
    if (receiverKey === 'clock') {
      if (listed(CLOCK_METHODS, method)) this.result.forcedState.push({ api, line, why: 'installs fake timers in the page' })
      return
    }
    if (listed(NAVIGATION_METHODS, method)) {
      this.pushNavigation(path, { api, line, kind: NAVIGATION_METHODS[method], viaAct: false })
      return
    }
    if (listed(FORCED_STATE_METHODS, method)) {
      this.result.forcedState.push({ api, line, why: FORCED_STATE_METHODS[method] })
      return
    }
    if (listed(WAIT_METHODS, method)) {
      this.result.waits.push({ api, line })
      return
    }
    if (listed(PLAYWRIGHT_INPUT_METHODS, method) && !(PLAYWRIGHT_INPUT_METHODS[method].needsArgument && args.length === 0)) {
      this.pushInput(path, { api, line }, false, { instead: PLAYWRIGHT_INPUT_METHODS[method].instead })
      if (args.some(hasForceTrue)) this.result.forcedState.push({ api, line, why: WHY.force })
      return
    }
    // A script-read name on a global that is not one of the sandbox's Playwright objects (`Promise.all`) is not Playwright's.
    const otherGlobal = receiver.kind === 'global' && receiver.chain.length === 0 && !listed(PLAYWRIGHT_GLOBALS, receiver.name)
    if (listed(SCRIPT_READ_METHODS, method) && !otherGlobal) {
      const { note } = SCRIPT_READ_METHODS[method]
      this.result.scriptReads.push({ api, line, ...(note ? { note } : {}) })
    }
  }

  private classifyActCall(path: AnyPath, rest: Array<string | null>, args: AnyPath[], line: number): void {
    if (rest.some((key) => key === null)) {
      this.result.unanalysable.push({ api: 'act[…]', line, why: UNREADABLE.actComputed })
      return
    }
    if (rest.length === 2 && rest[0] === 'dialog' && (rest[1] === 'accept' || rest[1] === 'dismiss' || rest[1] === 'chooseFiles')) {
      this.pushInput(path, { api: `act.dialog.${rest[1]}`, line }, true)
      return
    }
    if (rest.length !== 1) return
    const method = rest[0] ?? ''
    if (ACT_INPUT_METHODS.includes(method)) {
      this.pushInput(path, { api: `act.${method}`, line }, true)
    } else if (ACT_NAVIGATION_METHODS.includes(method)) {
      const reason = method === 'open' ? reasonOption(args[1]) : undefined
      this.pushNavigation(path, { api: `act.${method}`, line, kind: ACT_NAVIGATION_KIND[method], viaAct: true, ...(reason ? { reason } : {}) })
    } else if (ACT_WAIT_METHODS.includes(method)) {
      this.result.waits.push({ api: `act.${method}`, line })
    }
  }

  private classifyNew(path: AnyPath, root: AnyPath | null, source: Source): void {
    if (!path.isNewExpression()) return
    const callee = path.get('callee')
    if (!callee.isIdentifier() || this.bindingOf(callee, callee.node.name, root)) return
    const name = callee.node.name
    const line = this.lineOf(path, source)
    if (name === 'XMLHttpRequest') {
      const site = { api: 'new XMLHttpRequest', line }
      this.result.apiBypass.push(site)
      if (root) this.result.forcedState.push({ ...site, why: WHY.pageFetch })
      return
    }
    if (name === 'Function') {
      this.result.unanalysable.push({ api: 'new Function', line, why: UNREADABLE.eval })
      return
    }
    if (root && /Event$/.test(name)) {
      this.result.forcedState.push({ api: `new ${name}`, line, why: WHY.syntheticEvent })
    }
  }

  // --- page code (functions the page evaluates) ----------------------------------------

  private classifyPageCall(path: AnyPath, root: AnyPath, source: Source): void {
    if (!path.isCallExpression() && !path.isOptionalCallExpression()) return
    const callee = path.get('callee')
    const args = path.get('arguments')
    const line = this.lineOf(callee, source)
    const api = this.text(callee, source)
    const forced = (why: string): void => {
      this.result.forcedState.push({ api, line, why })
    }
    const { access, receiver } = this.calleeAccess(callee, root)
    const names = globalNames(access)

    if (names) {
      const [first, second] = names
      if (names.length === 1) {
        if (first === 'fetch') {
          forced(WHY.pageFetch)
          this.result.apiBypass.push({ api: 'fetch', line })
        } else if (first === 'eval' || first === 'Function') {
          this.result.unanalysable.push({ api: first, line, why: UNREADABLE.eval })
        } else if (listed(STRING_TIMERS, first) && args[0] && !args[0].isFunction()) {
          this.result.unanalysable.push({ api: first, line, why: UNREADABLE.timerString })
        }
        return
      }
      if (names.length === 2 && first === 'location') {
        if (listed(LOCATION_NAVIGATION_METHODS, second)) this.pushNavigation(path, { api, line, kind: 'document', viaAct: false, inPage: true })
        return
      }
      if (names.length === 2 && first === 'history') {
        if (listed(HISTORY_SPA_METHODS, second)) this.pushNavigation(path, { api, line, kind: 'spa', viaAct: false, inPage: true })
        else if (listed(HISTORY_MOVE_METHODS, second)) this.pushNavigation(path, { api, line, kind: 'history', viaAct: false, inPage: true })
        return
      }
      if (names.length === 2 && (first === 'localStorage' || first === 'sessionStorage')) {
        if (listed(STORAGE_WRITE_METHODS, second)) forced(WHY.storageWrite)
        return
      }
      if (names.length === 2 && first === 'cookieStore') {
        if (second === 'set' || second === 'delete') forced(WHY.storageWrite)
        return
      }
      if (listed(PAGE_API_ROOTS, first)) return
      if (names.length === 2 && first === 'navigator' && second === 'sendBeacon') {
        forced(WHY.pageFetch)
        this.result.apiBypass.push({ api, line })
        return
      }
      if (names.length === 2 && first === 'Object') {
        if (second === 'defineProperty' || second === 'defineProperties') forced(WHY.redefine)
        else if (second === 'assign' && args[0]) {
          const target = this.settle(this.accessOf(args[0], root), root)
          if (!(target.kind === 'local' && target.fresh && target.chain.length === 0)) forced(WHY.redefine)
        }
        return
      }
      if (names.length === 2 && first === 'document') {
        if (second === 'write' || second === 'writeln') return forced(WHY.domWrite)
        if (second === 'createEvent' || second === 'execCommand') return forced(WHY.syntheticEvent)
      }
    }

    const method = lastKey(access)
    if (!method || !receiver) return
    // The code's own data: `const out = []; out.push(…)`, `const parts = new Set(); parts.add(…)`.
    if (receiver.kind === 'local' && receiver.fresh && receiver.chain.length === 0) return
    const receiverKey = lastKey(receiver)
    if (receiverKey === 'classList') {
      if (listed(CLASS_LIST_WRITE_METHODS, method)) forced(WHY.domWrite)
      return
    }
    if (receiverKey === 'style') {
      if (listed(STYLE_WRITE_METHODS, method)) forced(WHY.styleWrite)
      return
    }
    if (listed(DOM_WRITE_METHODS, method)) return forced(WHY.domWrite)
    if (listed(SYNTHETIC_EVENT_METHODS, method)) return forced(WHY.syntheticEvent)
    if (/^on[A-Za-z]/.test(method)) return forced(WHY.handlerCall)
    if (method === 'setState' || method === 'forceUpdate') return forced(WHY.reactWrite)
    const object = memberParts(callee)?.object
    if (method === 'dispatch' && object && REACT_INTERNALS_RE.test(this.text(object, source))) forced(WHY.reactWrite)
  }

  /**
   * An assignment in page code. Writing into a value the page code made itself (`const row = {};
   * row.value = input.value`) changes nothing on the page; writing a page global, a property of a
   * page object or a DOM/style property does.
   */
  private classifyPageWrite(target: AnyPath, root: AnyPath, source: Source): void {
    const line = this.lineOf(target, source)
    const api = `${this.text(target, source)} =`
    const forced = (why: string): void => {
      this.result.forcedState.push({ api, line, why })
    }
    if (target.isIdentifier()) {
      if (this.bindingOf(target, target.node.name, root)) return
      if (target.node.name === 'location') this.pushNavigation(target, { api, line, kind: 'document', viaAct: false, inPage: true })
      else forced(WHY.pageGlobal)
      return
    }
    if (!target.isMemberExpression() && !target.isOptionalMemberExpression()) return
    const receiver = this.settle(this.accessOf(target.get('object'), root), root)
    if (receiver.kind === 'local' && receiver.fresh && receiver.chain.length === 0) return
    const property = propertyKey(target)
    const full: Access = { ...receiver, chain: [...receiver.chain, property] }
    const names = globalNames(full)
    if (names?.[0] === 'location') {
      this.pushNavigation(target, { api, line, kind: names[1] === 'hash' ? 'spa' : 'document', viaAct: false, inPage: true })
      return
    }
    if (names && names[0] === 'document' && names[1] === 'cookie') return forced(WHY.storageWrite)
    if (names && (names[0] === 'localStorage' || names[0] === 'sessionStorage')) return forced(WHY.storageWrite)
    if (REACT_INTERNALS_RE.test(this.text(target, source))) return forced(WHY.reactWrite)
    if (property === 'style' || property === 'cssText' || full.chain.includes('style')) return forced(WHY.styleWrite)
    if (full.chain.includes('prototype')) return forced(WHY.redefine)
    if (listed(DOM_WRITE_PROPERTIES, property)) return forced(WHY.domWrite)
    if (property && /^on[a-z]+$/.test(property)) return forced(WHY.domWrite)
    if (names) forced(names.length === 1 ? WHY.pageGlobal : WHY.pageWrite)
  }
}

/** The property keys from a destructuring pattern down to the identifier `name`; null when `name` is not in it. */
function patternKeys(pattern: AnyPath, name: string): Array<string | null> | null {
  if (pattern.isIdentifier()) return pattern.node.name === name ? [] : null
  if (pattern.isAssignmentPattern()) return patternKeys(pattern.get('left'), name)
  if (pattern.isObjectPattern()) {
    for (const property of pattern.get('properties')) {
      if (property.isRestElement()) {
        // `const { ...rest } = act`: rest holds the same members.
        if (patternKeys(property.get('argument'), name)) return []
        continue
      }
      if (!property.isObjectProperty()) continue
      const value = property.get('value')
      const inner = patternKeys(value, name)
      if (inner) return [objectKey(property), ...inner]
    }
    return null
  }
  if (pattern.isArrayPattern()) {
    const elements = pattern.get('elements')
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]
      if (!element.node) continue
      if (element.isRestElement()) return null
      const inner = patternKeys(element, name)
      if (inner) return [String(index), ...inner]
    }
  }
  return null
}

// --- public API -------------------------------------------------------------------------

/** Every input, navigation, forced-state, API-bypass, wait, script-read and unreadable site in `code`, by line. */
export function analyzeCode(code: string): CodeAnalysis {
  const parsed = parseScript(code)
  if ('error' in parsed) {
    return {
      parseError: parsed.error,
      hasTopLevelReturn: false,
      inputActions: [],
      navigations: [],
      forcedState: [],
      apiBypass: [],
      waits: [],
      scriptReads: [],
      unanalysable: [],
    }
  }
  const analyzer = new Analyzer()
  analyzer.analyze(parsed, code)
  const result = analyzer.result
  for (const list of [result.inputActions, result.navigations, result.forcedState, result.apiBypass, result.waits, result.scriptReads, result.unanalysable]) {
    list.sort((a: CodeSite, b: CodeSite) => a.line - b.line)
  }
  return result
}

/**
 * Whether the code returns a value from its top level — the executor prints `[return value]`
 * only then. Parsed, not matched: `/\breturn\b/` also fires on `'return'` in a string, on a
 * comment, and on a `return` inside a callback. False when the code does not parse (the vm
 * then reports the SyntaxError itself).
 */
export function hasExplicitReturn(code: string): boolean {
  return analyzeCode(code).hasTopLevelReturn
}

const REFUSED = 'Refused (human mode):'

function siteList(sites: CodeSite[]): string {
  return sites.map((site) => `${site.api} on line ${site.line}`).join(', ')
}

function navigationRefusal(site: NavigationSite): string {
  if (site.api === 'act.open') {
    return (
      `${REFUSED} act.open on line ${site.line} has no reason. A full document load wipes client-side caches and ` +
      'in-memory state (SWR, React Query, Redux), so it is only allowed when that is what you are testing: write ' +
      "act.open(url, { reason: 'why a full reload is the point' }) with the reason as a literal string. To move " +
      "around the app, act.click(ref) a link that observe() lists, or act.spaNavigate('/path') for an in-app route."
    )
  }
  const where = site.inPage ? ' in page code' : ''
  if (site.kind === 'spa') {
    return (
      `${REFUSED} ${site.api}${where} on line ${site.line} changes the URL from a script. The app's router does not ` +
      'take part, so the page does not show what a person who navigated there sees, and the repro is biased. Move ' +
      "the way a person does: act.click(ref) the app's own link that observe() lists, or act.spaNavigate('/path'), " +
      'which clicks a real link to that route.'
    )
  }
  if (site.kind === 'history') {
    return (
      `${REFUSED} ${site.api}${where} on line ${site.line} moves through browser history from a script. Going back ` +
      'can reload the previous document (wiping client-side caches and in-memory state) and it skips what the app ' +
      "does on its own Back controls. If the app shows a Back link or button, act.click(ref) it; to press the browser's " +
      'Back button the way a person does, use act.back().'
    )
  }
  const effect = site.api.endsWith('.setContent')
    ? 'would replace the whole document'
    : site.inPage
      ? 'would load a new document'
      : 'would reload the whole document'
  return (
    `${REFUSED} ${site.api}${where} on line ${site.line} ${effect} — client-side caches and in-memory state (SWR, ` +
    'React Query, Redux) are wiped, which a person clicking around never does, so a repro made this way is biased. ' +
    'Navigate like a user: observe() lists links with their URLs — act.click(ref) the link, or ' +
    "act.spaNavigate('/path') for an in-app route. If a full reload is genuinely what you are testing, use " +
    "act.open(url, { reason: '…' })."
  )
}

function describeAnalysis(analysis: CodeAnalysis): string[] {
  const notes: string[] = []
  if (analysis.inputActions.length > 0) {
    const looped = analysis.inputActions.filter((site) => site.loop)
    notes.push(
      `${analysis.inputActions.length} input action${analysis.inputActions.length === 1 ? '' : 's'}: ${siteList(analysis.inputActions)}` +
        (looped.length > 0 ? ` (${looped.map((site) => `line ${site.line} inside ${site.loop}`).join('; ')})` : ''),
    )
  }
  if (analysis.navigations.length > 0) {
    notes.push(`navigation: ${analysis.navigations.map((site) => `${site.api} on line ${site.line} (${site.kind})`).join(', ')}`)
  }
  if (analysis.forcedState.length > 0) {
    notes.push(`forced state: ${analysis.forcedState.map((site) => `${site.api} on line ${site.line} (${site.why})`).join(', ')}`)
  }
  if (analysis.apiBypass.length > 0) notes.push(`direct backend calls: ${siteList(analysis.apiBypass)}`)
  if (analysis.scriptReads.length > 0) notes.push(`Playwright script in the page (a user gesture): ${siteList(analysis.scriptReads)}`)
  if (analysis.unanalysable.length > 0) {
    notes.push(`not analysable: ${analysis.unanalysable.map((site) => `${site.api} on line ${site.line} (${site.why})`).join(', ')}`)
  }
  return notes
}

/**
 * `debug` allows everything and only describes it. `human` allows one input action per
 * call (navigations count), none in a loop or a repeated helper, no full-document or history
 * navigation once a page is loaded except `act.open(url, { reason })` / `act.back()`, no URL
 * change from page code (only act.spaNavigate / a link click), no forced state, no direct
 * backend calls, no Playwright call that runs Playwright's script in the page (reads, element
 * actions — readPage, observe and act.* do those without it), and no code the analysis cannot
 * read. Waits and reads that do not touch the page are never limited.
 */
export function checkPolicy(analysis: CodeAnalysis, context: { mode: PolicyMode; pageIsBlank: boolean }): PolicyVerdict {
  if (context.mode === 'debug') {
    const notes = describeAnalysis(analysis)
    if (analysis.parseError) notes.unshift(`the code does not parse: ${analysis.parseError}`)
    return { allowed: true, notes }
  }

  if (analysis.parseError) {
    return {
      allowed: false,
      refusal: `${REFUSED} the code does not parse (${analysis.parseError}), so it cannot be checked. Fix the syntax and send it again.`,
      notes: [],
    }
  }

  const reasons: string[] = []
  const notes: string[] = []

  for (const site of analysis.unanalysable) {
    reasons.push(
      `${REFUSED} ${site.api} on line ${site.line} is unanalysable — ${site.why}, so the policy cannot read what it does ` +
        'to the page. Pass the page function inline — readPage((el) => …), with values as its arg: ' +
        "readPage((doc, sel) => doc.querySelector(sel).textContent, { arg: sel }) — and write act calls out (act.click(3)).",
    )
  }

  if (analysis.scriptReads.length > 0) {
    const sites = analysis.scriptReads.map((site) => `${site.api} on line ${site.line}${site.note ? ` (${site.note})` : ''}`).join(', ')
    reasons.push(
      `${REFUSED} ${sites} ${analysis.scriptReads.length === 1 ? 'runs' : 'run'} Playwright's script in the page, and Playwright ` +
        'runs it as a user gesture: the page then counts as clicked (navigator.userActivation), which unlocks popups, file ' +
        'dialogs, sound and "Leave site?" prompts that a person who only looks never unlocks. Read without touching the ' +
        "page: readPage((el) => el.textContent, { ref: 12 }) runs your function in the page under Chrome's side-effect " +
        'check (it can only read; without a ref, el is the document), observe() and find(text) list what is on screen with ' +
        'refs, explain(ref) says what an element does, getPageMarkdown() reads the text. To wait for something, ' +
        'act.waitForIdle() and then observe().',
    )
  }

  const scripted = analysis.inputActions.filter((site) => site.viaScript)
  if (scripted.length > 0) {
    const sites = scripted.map((site) => `${site.api} on line ${site.line} → ${site.viaScript?.instead}`).join('; ')
    reasons.push(
      `${REFUSED} Playwright element actions — ${sites}. Playwright runs them through its injected script: the checks ` +
        'run in the page as a user gesture (a hover or a focus already unlocks what only a click should), and fill, clear, ' +
        'selectOption, selectText, setInputFiles, focus and blur set values, selection and focus from a script instead of ' +
        'producing the input. Do it as a person with the act.* call named after each, with a ref from observe().',
    )
  }

  for (const site of analysis.navigations) {
    if (site.kind === 'spa' && site.viaAct) continue
    if (site.api === 'act.open' && site.reason) {
      notes.push(
        `act.open on line ${site.line} loads a new document (reason: "${site.reason}"): client-side caches and in-memory state start empty.`,
      )
    } else if (site.api === 'act.back') {
      notes.push(`act.back on line ${site.line} goes back in history like the browser's Back button.`)
    } else if (context.pageIsBlank && !site.inPage && site.kind === 'document') {
      notes.push(`${site.api} on line ${site.line} is the first load of a blank tab.`)
    } else {
      reasons.push(navigationRefusal(site))
    }
  }

  const apiBypassKeys = new Set(analysis.apiBypass.map((site) => `${site.line}:${site.api}`))
  const forced = analysis.forcedState.filter((site) => !apiBypassKeys.has(`${site.line}:${site.api}`))
  if (forced.length > 0) {
    reasons.push(
      `${REFUSED} forced state — ${forced.map((site) => `${site.api} on line ${site.line} (${site.why})`).join(', ')}. ` +
        'net.delay/page.route, DOM or style writes and synthetic events fake the conditions the bug needs, so what ' +
        'happens next is not something a user can hit. Reproduce it the way a user would: one act.* step per call, ' +
        'act.waitForIdle() while the app works, then observe() and the backend log to see the outcome. Reading is ' +
        'fine (readPage(fn), getLatestLogs(), net.requests()). Faking conditions on purpose needs ' +
        'debug mode (ask the user).',
    )
  }

  if (analysis.apiBypass.length > 0) {
    reasons.push(
      `${REFUSED} ${siteList(analysis.apiBypass)} ${analysis.apiBypass.length === 1 ? 'calls' : 'call'} the backend ` +
        'directly instead of going through the page — the UI is what is under test; drive it like a user, read the ' +
        'backend log for the server side. To see what the page itself sent and got back, use net.requests() and ' +
        'net.request(id).',
    )
  }

  const actions: Array<InputActionSite | NavigationSite> = [...analysis.inputActions, ...analysis.navigations].sort((a, b) => a.line - b.line)
  const looped = actions.filter((site) => site.loop)
  if (looped.length > 0) {
    const where = looped.map((site) => `${site.api} on line ${site.line} runs inside ${site.loop}`).join('; ')
    reasons.push(
      `${REFUSED} ${where}, so one call would fire it again and again without looking at the page in between. ` +
        'Write the single action, run it, read what changed, then decide whether to do it again.',
    )
  }

  if (actions.length > 1) {
    const first = actions[0]
    reasons.push(
      `${REFUSED} this call does ${actions.length} input actions — ${siteList(actions)}. A person does one thing, ` +
        `then looks at what happened. Do the first one — ${first.api}(…) on line ${first.line} — then read the ` +
        'report and decide the next.',
    )
  }

  if (reasons.length === 0) return { allowed: true, notes }
  return { allowed: false, refusal: `${reasons.join('\n')}\nNothing from this call was run.`, notes }
}
