/**
 * playwright-server.ts — what playwriter needs from Playwright's server, which runs in this process
 * (`chromium.connectOverCDP` and `chromium.launch` go through Playwright's in-process factory). Two
 * servers can be loaded, once per process (`getChromium`): `@xmorse/playwright-core` (the default) and
 * `@playwriter/patchright-core` (`PLAYWRITER_PATCHRIGHT=1`), whose server is one bundle, coreBundle.js.
 *
 * 1. Element previews without a user gesture and without Playwright's injected script.
 *    Playwright's server describes every element handle it creates (`ElementHandle._initializePreview`
 *    in server/dom.ts): it builds Playwright's injected script in the element's world and calls its
 *    `previewNode` with `Runtime.callFunctionOn` and `userGesture: true`. The page itself makes the
 *    server create such handles — every `console.log(element)` (crPage.ts `_onConsoleAPI`) and every
 *    file chooser. Measured: once the page logged an element, `navigator.userActivation.hasBeenActive`
 *    was true, and the injected script's constructor had added capture listeners for pointer, mouse
 *    and touch events and a MutationObserver to the page's own world. The replacement computes the
 *    same text with a self-contained function, in the handle's own context, under V8's side-effect
 *    check and without a gesture: nothing is built or installed in the page. Both servers have the
 *    same `_initializePreview`; patchright's bundle exports no `ElementHandle`, so its class is taken
 *    from the first handle the server constructs, before that handle previews itself (see
 *    `installPatchrightPreview`).
 *
 * 2. The page-world execution context of a frame, as the server tracks it. readPage bounds its run
 *    with V8's own time limit, which only `Runtime.evaluate` takes, and `Runtime.evaluate` reaches a
 *    same-process iframe's page world only by context id.
 *
 * 3. Borrowing the page's own CDP session (`getExistingCDPSession`, a playwriter addition to both
 *    servers). Patchright's copy still checks `browser.options.isChromium`, which Playwright 1.61 no
 *    longer sets (every other check in its bundle reads `options.browserType`), so it refused its own
 *    Chromium.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import type { BrowserContext, Frame } from '@xmorse/playwright-core'
import { ModelFacingError } from './probe-types.js'

/** The Playwright server loaded in this process; `getChromium` loads exactly one and prepares it. */
export type ServerEngine = 'playwright' | 'patchright'

let preparedEngine: ServerEngine | undefined

/**
 * Playwright's `previewNode` (injectedScript.ts), as one function over `this` that only reads: the same
 * text for elements (attributes but style, shortest first, cut at 500; text when at most five children
 * that are all text, cut at 50), text nodes and other nodes.
 */
const PREVIEW_NODE_FN = `function () {
  var node = this
  var oneLine = function (s) { return s.replace(/\\n/g, '↵').replace(/\\t/g, '⇆') }
  var trim = function (input, cap) {
    if (input.length <= cap) return input
    var chars = [...input]
    if (chars.length > cap) return chars.slice(0, cap - 1).join('') + '…'
    return chars.join('')
  }
  if (node.nodeType === 3) return oneLine('#text=' + (node.nodeValue || ''))
  if (node.nodeType !== 1) return oneLine('<' + node.nodeName.toLowerCase() + ' />')
  var booleanAttributes = ['checked', 'selected', 'disabled', 'readonly', 'multiple']
  var autoClosingTags = ['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'MENUITEM', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']
  var attrs = []
  for (var i = 0; i < node.attributes.length; i++) {
    var attribute = node.attributes[i]
    if (attribute.name === 'style') continue
    if (!attribute.value && booleanAttributes.indexOf(attribute.name) !== -1) attrs.push(' ' + attribute.name)
    else attrs.push(' ' + attribute.name + '="' + attribute.value + '"')
  }
  attrs.sort(function (a, b) { return a.length - b.length })
  var attrText = trim(attrs.join(''), 500)
  var tag = node.nodeName.toLowerCase()
  if (autoClosingTags.indexOf(node.nodeName) !== -1) return oneLine('<' + tag + attrText + '/>')
  var children = node.childNodes
  var onlyText = false
  if (children.length <= 5) {
    onlyText = true
    for (var j = 0; j < children.length; j++) onlyText = onlyText && children[j].nodeType === 3
  }
  var text = onlyText ? (node.textContent || '') : (children.length ? '…' : '')
  return oneLine('<' + tag + attrText + '>' + trim(text, 50) + '</' + tag + '>')
}`

/** The part of Playwright's server CDP session the preview uses. */
interface ServerSession {
  send(method: string, params: object): Promise<unknown>
}

function isServerSession(value: unknown): value is ServerSession {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'send') === 'function'
}

/** A property of an object or a function (a class), without trusting its type. */
export function field(value: unknown, name: string): unknown {
  return (typeof value === 'object' && value !== null) || typeof value === 'function' ? Reflect.get(value, name) : undefined
}

/** The replacement of `ElementHandle.prototype._initializePreview` (`this` is the server handle). */
async function previewWithoutGesture(this: object): Promise<void> {
  const objectId = field(this, '_objectId')
  const session = field(field(field(this, '_context'), 'delegate'), '_client')
  const setPreview = field(this, '_setPreview')
  if (typeof objectId !== 'string' || !isServerSession(session) || typeof setPreview !== 'function') {
    throw new Error('playwright-server: the element handle has no object id, CDP session or preview setter where Playwright keeps them.')
  }
  const response = await session.send('Runtime.callFunctionOn', {
    functionDeclaration: PREVIEW_NODE_FN,
    objectId,
    returnByValue: true,
    throwOnSideEffect: true,
  })
  const exception = field(response, 'exceptionDetails')
  const value = field(field(response, 'result'), 'value')
  if (exception !== undefined || typeof value !== 'string') {
    throw new Error(`playwright-server: the element preview could not be read: ${JSON.stringify(exception ?? value)}`)
  }
  Reflect.apply(setPreview, this, [`JSHandle@${value}`])
}

/** Put the replacement on `prototype`, the server's `ElementHandle.prototype`. Idempotent. */
function replacePreview(prototype: unknown, where: string): void {
  const current = field(prototype, '_initializePreview')
  if (typeof prototype !== 'object' || prototype === null || typeof current !== 'function') {
    throw new Error(
      `playwright-server: ${where} has no ElementHandle.prototype._initializePreview. ` +
        "Playwright's server moved the element preview; playwriter must replace it before connecting, or the page's own " +
        'console.log(element) gives it user activation.',
    )
  }
  if (current === previewWithoutGesture) return
  Reflect.set(prototype, '_initializePreview', previewWithoutGesture)
}

/** `@xmorse/playwright-core` ships its server as modules: `ElementHandle` is server/dom.js's export. */
function installPlaywrightPreview(): void {
  const require = createRequire(import.meta.url)
  const packageDir = path.dirname(require.resolve('@xmorse/playwright-core/package.json'))
  const domPath = path.join(packageDir, 'lib', 'server', 'dom.js')
  const dom: unknown = require(domPath)
  replacePreview(field(field(dom, 'ElementHandle'), 'prototype'), domPath)
}

/**
 * The field the server's `ElementHandle` constructor assigns before it calls `this._initializePreview()`
 * (coreBundle.js: `super(...)`, `this.__elementhandle = true`, `_page`, `_frame`, `_initializePreview()`).
 */
const ELEMENT_HANDLE_BRAND = '__elementhandle'

/**
 * `@playwriter/patchright-core` ships its server as one bundle that exports `server.Page` but not
 * `ElementHandle`, which only lives in the bundle's closure. Every server handle is an `SdkObject`, and
 * `SdkObject.prototype` is reachable before any connection as `server.Page`'s parent prototype. A
 * one-shot setter for the brand there runs inside the FIRST element handle's constructor, before that
 * handle previews itself: it replaces the preview on the prototype that owns it, makes the brand the
 * handle's own data property (what the assignment would have made), and removes itself. No handle,
 * including the first, ever runs the original preview.
 */
function installPatchrightPreview(): void {
  const require = createRequire(import.meta.url)
  const bundlePath = require.resolve('@playwriter/patchright-core/lib/coreBundle')
  const bundle: unknown = require(bundlePath)
  const pagePrototype = field(field(field(bundle, 'server'), 'Page'), 'prototype')
  const sdkObjectPrototype: unknown = typeof pagePrototype === 'object' && pagePrototype !== null ? Object.getPrototypeOf(pagePrototype) : undefined
  if (typeof sdkObjectPrototype !== 'object' || sdkObjectPrototype === null || field(field(sdkObjectPrototype, 'constructor'), 'name') !== 'SdkObject') {
    throw new Error(
      `playwright-server: ${bundlePath} has no server.Page extending SdkObject. Patchright's server moved; playwriter cannot ` +
        "replace its element preview before connecting, and the page's own console.log(element) would give the page user activation.",
    )
  }
  if (Object.hasOwn(sdkObjectPrototype, ELEMENT_HANDLE_BRAND)) return
  Object.defineProperty(sdkObjectPrototype, ELEMENT_HANDLE_BRAND, {
    configurable: true,
    get: () => undefined,
    set(this: object, value: unknown) {
      let owner: object | null = Object.getPrototypeOf(this)
      while (owner !== null && !Object.hasOwn(owner, '_initializePreview')) owner = Object.getPrototypeOf(owner)
      replacePreview(owner, `${bundlePath} (the first object assigning ${ELEMENT_HANDLE_BRAND})`)
      Reflect.deleteProperty(sdkObjectPrototype, ELEMENT_HANDLE_BRAND)
      Object.defineProperty(this, ELEMENT_HANDLE_BRAND, { value, writable: true, enumerable: true, configurable: true })
    },
  })
}

/**
 * Prepare the server `getChromium` just loaded, before any connection: replace its element preview
 * (see the module comment). Throws when the server is not laid out as expected, so an upgrade that
 * moves the preview cannot silently bring the page's activation back.
 */
export function prepareServer(engine: ServerEngine): void {
  if (engine === 'playwright') installPlaywrightPreview()
  else installPatchrightPreview()
  preparedEngine = engine
}

/** The in-process server object behind a client object (the in-process factory's `toImpl`). */
export function serverObject(client: object, what: string): unknown {
  const connection = field(client, '_connection')
  const toImpl = field(connection, 'toImpl')
  if (typeof toImpl !== 'function') {
    throw new Error(`playwright-server: this Playwright connection does not run its server in this process (no toImpl), so ${what} cannot be found.`)
  }
  return Reflect.apply(toImpl, connection, [client])
}

/**
 * Let `context.getExistingCDPSession` serve patchright's Chromium (module comment, 3). The only read
 * of `options.isChromium` in patchright's bundle is that check; this restores the value Playwright
 * 1.59 sets for Chromium, from the browser's own `browserType`. The default server sets it itself
 * (`_innerLaunch` and `_connectOverCDPInternal`), so nothing is touched there.
 */
export function restoreIsChromiumOption(context: BrowserContext): void {
  if (preparedEngine !== 'patchright') return
  const options = field(field(serverObject(context, "the context's browser"), '_browser'), 'options')
  if (typeof options !== 'object' || options === null) throw new Error("playwright-server: patchright's server context has no browser options.")
  if (field(options, 'browserType') === 'chromium' && field(options, 'isChromium') !== true) Reflect.set(options, 'isChromium', true)
}

/** The server frame's page-world context getter: Playwright 1.59's `_mainContext`, patchright's `mainContext`. */
const MAIN_CONTEXT_METHOD: Record<ServerEngine, string> = { playwright: '_mainContext', patchright: 'mainContext' }

/**
 * The id of `frame`'s page-world execution context in its renderer session, as Playwright's server
 * tracks it. Playwright's server waits for the context while the frame is between documents;
 * patchright's resolves it with one `Runtime.evaluate` and has none while there is no document.
 */
export async function pageWorldContextId(frame: Frame): Promise<number> {
  if (preparedEngine === undefined) throw new Error("playwright-server: getChromium() has not loaded a Playwright server, so a frame's page world cannot be found.")
  const method = MAIN_CONTEXT_METHOD[preparedEngine]
  const serverFrame = serverObject(frame, "a frame's page world")
  const mainContext = field(serverFrame, method)
  if (typeof mainContext !== 'function') throw new Error(`playwright-server: the ${preparedEngine} server frame has no ${method}().`)
  const context: unknown = await Reflect.apply(mainContext, serverFrame, [])
  if (context === undefined) {
    throw new ModelFacingError(`The page world of the frame at ${frame.url()} is not available right now (a document in its tab is loading); read again once the page has loaded.`)
  }
  const contextId = field(field(context, 'delegate'), '_contextId')
  if (typeof contextId !== 'number') throw new Error("playwright-server: the frame's page-world context has no CDP context id.")
  return contextId
}
