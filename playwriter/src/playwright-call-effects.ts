/**
 * playwright-call-effects.ts — what each Playwright protocol call does to the page under test.
 *
 * Every Playwright API call reaches the browser as one or more protocol calls (`Frame.textContent`,
 * `Page.screenshot`, …) through `Connection.sendMessageToServer`, where the executor's human-mode
 * guard reads them (playwright-client-hooks.ts). This table says, for every protocol method the
 * client can send (`methodMetainfo`; a test keeps the two in step), what the call does to the page.
 * Read from Playwright's server (playwright-core/src/server) and measured on Chromium:
 *
 *   - `pageScript`: Playwright runs its script in the page through `CRExecutionContext.
 *     evaluateWithArguments`, which hard-codes `userGesture: true`. Measured on a fresh page:
 *     `page.title()`, every locator read, `frame.frameElement()` (the new handle's preview is computed
 *     in the page), `page.screenshot()` and `context.storageState()` each turn
 *     `navigator.userActivation.hasBeenActive` true — the page then counts as clicked.
 *   - `elementInput`: Playwright's element actions. Their actionability checks are that same script
 *     (a hover or a focus already activates the page), and fill/selectOption/selectText/focus/blur/
 *     setInputFiles set values, selection and focus from a script instead of producing the input.
 *   - `pageWrite`: adds something to the page (scripts, styles, globals, overlays, synthetic events).
 *   - `forced`: changes the conditions the page runs under (network, cookies, permissions,
 *     emulation, viewport, printing — measured: `page.pdf()` runs the page's beforeprint/afterprint
 *     handlers, `setViewportSize` fires resize).
 *   - `rawCdp`: a CDP session that can send any command.
 *   - `backend`: a request to the backend that does not go through the page.
 *   - `input` / `navigation` / `none`: real CDP input (`Input.dispatch*`, no script: measured, a
 *     mouse move or a wheel leaves the page unactivated), navigations (policed elsewhere), and calls
 *     that do nothing to the page (browser-side reads like cookies or console messages, waits, tabs).
 */

import { ALLOWED_IN_FAST_OR_DEBUG } from './code-policy.js'

/** What a refused call does, in plain words, completing "it …". */
export type CallEffect =
  | { kind: 'none' }
  | { kind: 'input' }
  | { kind: 'navigation' }
  | { kind: 'pageScript'; does?: string }
  | { kind: 'elementInput'; instead: string }
  | { kind: 'pageWrite'; does: string }
  | { kind: 'forced'; does: string }
  | { kind: 'rawCdp' }
  | { kind: 'backend' }

export type RefusedCallEffect = Exclude<CallEffect, { kind: 'none' | 'input' | 'navigation' }>

type EffectRule = CallEffect | ((params: unknown) => CallEffect)

const NONE: CallEffect = { kind: 'none' }
const INPUT: CallEffect = { kind: 'input' }
const NAVIGATION: CallEffect = { kind: 'navigation' }
const SCRIPT: CallEffect = { kind: 'pageScript' }
const RAW_CDP: CallEffect = { kind: 'rawCdp' }

const forced = (does: string): CallEffect => ({ kind: 'forced', does })
const write = (does: string): CallEffect => ({ kind: 'pageWrite', does })
const element = (instead: string): CallEffect => ({ kind: 'elementInput', instead })

const ROUTE = forced('intercepts network requests and answers them from the script')
const WEBSOCKET_ROUTE = forced('intercepts WebSocket traffic and answers it from the script')
const PERMISSIONS = forced('changes what the browser lets the page do (permissions)')
const FAKE_CLOCK = forced('installs fake timers in the page')

/** `JSHandle` methods, which `ElementHandle` inherits. */
const JS_HANDLE: Record<string, EffectRule> = {
  dispose: NONE,
  evaluateExpression: SCRIPT,
  evaluateExpressionHandle: SCRIPT,
  // Element-valued properties come back as element handles, whose previews are computed in the page.
  getPropertyList: SCRIPT,
  getProperty: SCRIPT,
  jsonValue: SCRIPT,
}

/**
 * The page-facing protocol interfaces, method by method. A method missing here is unknown: human
 * mode refuses it (see `callEffect`), and `playwright-call-effects.test.ts` fails until it is added.
 */
const PAGE_FACING: Record<string, Record<string, EffectRule>> = {
  Page: {
    waitForEventInfo: NONE,
    addInitScript: write('injects a script into every document the page loads'),
    close: NONE,
    consoleMessages: NONE,
    emulateMedia: forced('emulates another media type, color scheme or motion setting for the page'),
    exposeBinding: write('adds a global function to the page'),
    goBack: NAVIGATION,
    goForward: NAVIGATION,
    requestGC: NONE,
    registerLocatorHandler: NONE,
    resolveLocatorHandlerNoReply: NONE,
    unregisterLocatorHandler: NONE,
    reload: NAVIGATION,
    expectScreenshot: SCRIPT,
    screenshot: {
      kind: 'pageScript',
      does:
        "runs Playwright's script in the page as a user gesture (the page then counts as clicked: navigator.userActivation), " +
        'and unless caret is "initial" it writes caret-color into the inline style of every text field while it shoots',
    },
    setExtraHTTPHeaders: forced('adds headers to every request the page makes'),
    setNetworkInterceptionPatterns: ROUTE,
    setWebSocketInterceptionPatterns: WEBSOCKET_ROUTE,
    setViewportSize: forced('resizes the viewport: the page lays out again and gets a resize event'),
    keyboardDown: INPUT,
    keyboardUp: INPUT,
    keyboardInsertText: INPUT,
    keyboardType: INPUT,
    keyboardPress: INPUT,
    mouseMove: INPUT,
    mouseDown: INPUT,
    mouseUp: INPUT,
    mouseClick: INPUT,
    mouseWheel: INPUT,
    setOnMouseAction: NONE,
    mouseActionDone: NONE,
    touchscreenTap: INPUT,
    pageErrors: NONE,
    pdf: forced("prints the page: its beforeprint and afterprint handlers run and it lays out for paper"),
    requests: NONE,
    snapshotForAI: SCRIPT,
    startJSCoverage: NONE,
    stopJSCoverage: NONE,
    startCSSCoverage: NONE,
    stopCSSCoverage: NONE,
    bringToFront: NONE,
    videoStart: NONE,
    videoStop: NONE,
    updateSubscription: NONE,
    agent: element('act.click(ref), act.fill(ref, text) and the other act.* steps, one per call'),
  },
  Frame: {
    evalOnSelector: SCRIPT,
    evalOnSelectorAll: SCRIPT,
    addScriptTag: write('adds a <script> to the page'),
    addStyleTag: write('adds a <style> to the page'),
    ariaSnapshot: SCRIPT,
    blur: element("act.press('Tab'), or act.click(ref) on something else"),
    check: element('act.check(ref)'),
    click: element('act.click(ref)'),
    content: SCRIPT,
    dragAndDrop: element('act.drag(fromRef, toRef)'),
    dblclick: element('act.dblclick(ref)'),
    dispatchEvent: write('fires a synthetic event instead of real input'),
    evaluateExpression: SCRIPT,
    evaluateExpressionHandle: SCRIPT,
    fill: element("act.fill(ref, 'text')"),
    focus: element("act.click(ref) — a person focuses a field by clicking it — or act.press('Tab')"),
    frameElement: SCRIPT,
    resolveSelector: SCRIPT,
    highlight: write("draws Playwright's highlight overlay into the page"),
    getAttribute: SCRIPT,
    goto: NAVIGATION,
    hover: element('act.hover(ref)'),
    innerHTML: SCRIPT,
    innerText: SCRIPT,
    inputValue: SCRIPT,
    isChecked: SCRIPT,
    isDisabled: SCRIPT,
    isEnabled: SCRIPT,
    isHidden: SCRIPT,
    isVisible: SCRIPT,
    isEditable: SCRIPT,
    press: element("act.press('Key', { ref })"),
    querySelector: SCRIPT,
    querySelectorAll: SCRIPT,
    queryCount: SCRIPT,
    selectOption: element("act.select(ref, 'option')"),
    setContent: NAVIGATION,
    setInputFiles: element('act.upload(ref, path)'),
    tap: element('act.click(ref)'),
    textContent: SCRIPT,
    title: SCRIPT,
    type: element("act.type(ref, 'text')"),
    uncheck: element('act.uncheck(ref)'),
    waitForTimeout: NONE,
    waitForFunction: SCRIPT,
    waitForSelector: SCRIPT,
    expect: SCRIPT,
  },
  JSHandle: JS_HANDLE,
  ElementHandle: {
    ...JS_HANDLE,
    evalOnSelector: SCRIPT,
    evalOnSelectorAll: SCRIPT,
    // DOM.getBoxModel: no script (an element handle is only reachable through script, though).
    boundingBox: NONE,
    check: element('act.check(ref)'),
    click: element('act.click(ref)'),
    contentFrame: SCRIPT,
    dblclick: element('act.dblclick(ref)'),
    dispatchEvent: write('fires a synthetic event instead of real input'),
    fill: element("act.fill(ref, 'text')"),
    focus: element("act.click(ref) — a person focuses a field by clicking it — or act.press('Tab')"),
    getAttribute: SCRIPT,
    hover: element('act.hover(ref)'),
    innerHTML: SCRIPT,
    innerText: SCRIPT,
    inputValue: SCRIPT,
    isChecked: SCRIPT,
    isDisabled: SCRIPT,
    isEditable: SCRIPT,
    isEnabled: SCRIPT,
    isHidden: SCRIPT,
    isVisible: SCRIPT,
    ownerFrame: SCRIPT,
    press: element("act.press('Key', { ref })"),
    querySelector: SCRIPT,
    querySelectorAll: SCRIPT,
    screenshot: SCRIPT,
    scrollIntoViewIfNeeded: element('act.scrollTo(ref)'),
    selectOption: element("act.select(ref, 'option')"),
    selectText: element("act.click(ref), then act.press('Control+A')"),
    setInputFiles: element('act.upload(ref, path)'),
    tap: element('act.click(ref)'),
    textContent: SCRIPT,
    type: element("act.type(ref, 'text')"),
    uncheck: element('act.uncheck(ref)'),
    waitForElementState: SCRIPT,
    waitForSelector: SCRIPT,
  },
  BrowserContext: {
    waitForEventInfo: NONE,
    addCookies: forced('writes cookies directly'),
    addInitScript: write('injects a script into every document the pages load'),
    clearCookies: forced('deletes cookies directly'),
    clearPermissions: PERMISSIONS,
    close: NONE,
    cookies: NONE,
    exposeBinding: write('adds a global function to every page'),
    grantPermissions: PERMISSIONS,
    newPage: NONE,
    registerSelectorEngine: NONE,
    setTestIdAttributeName: NONE,
    setExtraHTTPHeaders: forced('adds headers to every request the pages make'),
    setGeolocation: forced('fakes the location the page reads'),
    setHTTPCredentials: forced('answers HTTP authentication prompts from the script'),
    setNetworkInterceptionPatterns: ROUTE,
    setWebSocketInterceptionPatterns: WEBSOCKET_ROUTE,
    setOffline: forced('forces the browser offline'),
    storageState: {
      kind: 'pageScript',
      does:
        "reads local storage and IndexedDB by running Playwright's script in every page as a user gesture (each page then counts as clicked: navigator.userActivation), " +
        'and opens a tab for each other origin it saves',
    },
    setStorageState: forced('writes cookies and storage directly'),
    pause: NONE,
    enableRecorder: write("injects Playwright's recorder into the page"),
    disableRecorder: NONE,
    exposeConsoleApi: write("adds Playwright's `playwright` global to the page"),
    newCDPSession: RAW_CDP,
    getExistingCDPSession: RAW_CDP,
    harStart: NONE,
    harExport: NONE,
    createTempFiles: NONE,
    updateSubscription: NONE,
    clockFastForward: FAKE_CLOCK,
    clockInstall: FAKE_CLOCK,
    clockPauseAt: FAKE_CLOCK,
    clockResume: FAKE_CLOCK,
    clockRunFor: FAKE_CLOCK,
    clockSetFixedTime: FAKE_CLOCK,
    clockSetSystemTime: FAKE_CLOCK,
  },
  Browser: {
    close: NONE,
    killForTests: NONE,
    defaultUserAgentForTest: NONE,
    newContext: NONE,
    newContextForReuse: NONE,
    disconnectFromReusedContext: NONE,
    newBrowserCDPSession: RAW_CDP,
    startTracing: NONE,
    stopTracing: NONE,
  },
  Worker: {
    waitForEventInfo: NONE,
    evaluateExpression: write("runs a script in one of the page's workers"),
    evaluateExpressionHandle: write("runs a script in one of the page's workers"),
    updateSubscription: NONE,
  },
  Tracing: {
    // Trace snapshots inject a recorder global into every page (snapshotter.ts: init script + evaluate in all frames).
    tracingStart: (params) => (snapshotsRequested(params) ? write('injects a trace-snapshot recorder global into every page') : NONE),
    tracingStartChunk: NONE,
    tracingGroup: NONE,
    tracingGroupEnd: NONE,
    tracingStopChunk: NONE,
    tracingStop: NONE,
  },
  Route: {
    redirectNavigationRequest: ROUTE,
    abort: ROUTE,
    continue: ROUTE,
    fulfill: ROUTE,
  },
  WebSocketRoute: {
    connect: WEBSOCKET_ROUTE,
    ensureOpened: WEBSOCKET_ROUTE,
    sendToPage: WEBSOCKET_ROUTE,
    sendToServer: WEBSOCKET_ROUTE,
    closePage: WEBSOCKET_ROUTE,
    closeServer: WEBSOCKET_ROUTE,
  },
  APIRequestContext: {
    fetch: { kind: 'backend' },
    fetchResponseBody: NONE,
    fetchLog: NONE,
    storageState: NONE,
    disposeAPIResponse: NONE,
    dispose: NONE,
  },
  PageAgent: {
    waitForEventInfo: NONE,
    perform: element('act.click(ref), act.fill(ref, text) and the other act.* steps, one per call'),
    expect: SCRIPT,
    extract: SCRIPT,
    dispose: NONE,
    usage: NONE,
  },
  DebugController: {
    initialize: NONE,
    setReportStateChanged: NONE,
    setRecorderMode: write("injects Playwright's recorder into the page"),
    highlight: write("draws Playwright's highlight overlay into the page"),
    hideHighlight: NONE,
    resume: NONE,
    kill: NONE,
  },
  CDPSession: {
    // The sandbox's session (getCDPSession) refuses page-changing commands itself in human mode, and a raw
    // session cannot be opened (rawCdp above).
    send: NONE,
    detach: NONE,
  },
  Dialog: {
    accept: NONE,
    dismiss: NONE,
  },
}

/**
 * Interfaces that never act on the page under test: transport and bookkeeping objects, network
 * records, downloads, other browsers and devices. Every method of these is `none`.
 */
const NOT_PAGE_FACING = new Set([
  'LocalUtils',
  'Root',
  'Playwright',
  'SocksSupport',
  'BrowserType',
  'EventTarget',
  'WebSocket',
  'Request',
  'Response',
  'BindingCall',
  'Artifact',
  'Stream',
  'WritableStream',
  'JsonPipe',
  'Electron',
  'ElectronApplication',
  'Android',
  'AndroidSocket',
  'AndroidDevice',
])

function snapshotsRequested(params: unknown): boolean {
  return typeof params === 'object' && params !== null && Reflect.get(params, 'snapshots') === true
}

/**
 * What the protocol call `type.method` with `params` does to the page, or null when the method is
 * unknown to this table (a Playwright upgrade added it): nothing says what it does, so human mode
 * must not run it.
 */
export function callEffect(type: string, method: string, params: unknown): CallEffect | null {
  if (NOT_PAGE_FACING.has(type)) return NONE
  const rule = PAGE_FACING[type]?.[method]
  if (rule === undefined) return null
  return typeof rule === 'function' ? rule(params) : rule
}

/** Whether `type.method` is classified (method by method, or as a whole interface). */
export function isClassified(type: string, method: string): boolean {
  return NOT_PAGE_FACING.has(type) || PAGE_FACING[type]?.[method] !== undefined
}

export function isRefusedEffect(effect: CallEffect): effect is RefusedCallEffect {
  return effect.kind !== 'none' && effect.kind !== 'input' && effect.kind !== 'navigation'
}

const GESTURE =
  "runs Playwright's script in the page, as a user gesture: the page then counts as clicked (navigator.userActivation), " +
  'which unlocks popups, file dialogs, sound and "Leave site?" prompts that a person who only looks never unlocks'

/**
 * The human-mode refusal for a call with a refused effect. Playwright prefixes the API the code
 * called (`locator.textContent: …`) when the error reaches the code; `protocol` names the call that
 * went out, which is what was checked.
 */
export function refusalFor(effect: RefusedCallEffect, protocol: string): string {
  const head = `Refused (human mode): it (Playwright protocol call ${protocol})`
  switch (effect.kind) {
    case 'pageScript':
      return (
        `${head} ${effect.does ?? GESTURE}. Read without touching the page: readPage((el) => …, { ref }) runs a read-only ` +
        'function in the page (Chrome checks that it changes nothing), observe() and find(text) list what is on screen, ' +
        'explain(ref) says what an element does. It was not run.'
      )
    case 'elementInput':
      return (
        `${head} acts on an element through Playwright's injected script: its checks run in the page as a user gesture ` +
        '(a hover or a focus already unlocks what only a click should), and fill, selectOption, selectText, focus, blur and ' +
        `setInputFiles set values, selection and focus from a script instead of producing the input. Do it as a person: ` +
        `${effect.instead}, with a ref from observe(). It was not run.`
      )
    case 'pageWrite':
      return `${head} ${effect.does}, which a person browsing cannot do. Changing the page on purpose needs ${ALLOWED_IN_FAST_OR_DEBUG}. It was not run.`
    case 'forced':
      return (
        `${head} ${effect.does}: the conditions under test become ones a user cannot hit. Faking conditions on purpose ` +
        `needs ${ALLOWED_IN_FAST_OR_DEBUG}. It was not run.`
      )
    case 'rawCdp':
      return (
        `${head} opens a CDP session that can send any command, page-changing ones included. getCDPSession({ page }) gives ` +
        "the page's session, read-only in human mode. It was not run."
      )
    case 'backend':
      return (
        `${head} calls the backend directly instead of going through the page. Drive the UI like a user; to see what the ` +
        'page itself sent and got back, use net.requests() and net.request(id). It was not run.'
      )
  }
}

/** The human-mode refusal for a protocol call this table does not know. */
export function unclassifiedRefusal(protocol: string): string {
  return (
    `Refused (human mode): Playwright protocol call ${protocol} is not classified in playwright-call-effects.ts, so ` +
    'what it does to the page is unknown and human mode does not run it. It was not run.'
  )
}
