/**
 * playwright-server.ts — what playwriter needs from Playwright's server, which runs in this process
 * (`chromium.connectOverCDP` and `chromium.launch` go through Playwright's in-process factory).
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
 *    check and without a gesture: nothing is built or installed in the page.
 *
 * 2. The page-world execution context of a frame, as the server tracks it. readPage bounds its run
 *    with V8's own time limit, which only `Runtime.evaluate` takes, and `Runtime.evaluate` reaches a
 *    same-process iframe's page world only by context id.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import type { Frame } from '@xmorse/playwright-core'

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
function field(value: unknown, name: string): unknown {
  return (typeof value === 'object' && value !== null) || typeof value === 'function' ? Reflect.get(value, name) : undefined
}

/** The replacement of `ElementHandle.prototype._initializePreview` (`this` is the server handle). */
async function previewWithoutGesture(this: object): Promise<void> {
  const objectId = field(this, '_objectId')
  const session = field(field(field(this, '_context'), 'delegate'), '_client')
  const setPreview = field(this, '_setPreview')
  if (typeof objectId !== 'string' || !isServerSession(session) || typeof setPreview !== 'function') {
    throw new Error('playwright-server: the element handle has no object id, CDP session or preview setter where Playwright 1.59 keeps them.')
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

/**
 * Replace Playwright's element preview in `@xmorse/playwright-core`'s server (see the module comment).
 * Idempotent; throws when the server is not laid out as expected, so a Playwright upgrade that moves
 * it cannot silently bring the page's activation back.
 */
export function installElementPreviewWithoutGesture(): void {
  const require = createRequire(import.meta.url)
  const packageDir = path.dirname(require.resolve('@xmorse/playwright-core/package.json'))
  const dom: unknown = require(path.join(packageDir, 'lib', 'server', 'dom.js'))
  const elementHandle = field(dom, 'ElementHandle')
  const prototype = typeof elementHandle === 'function' ? field(elementHandle, 'prototype') : undefined
  const current = field(prototype, '_initializePreview')
  if (typeof prototype !== 'object' || prototype === null || typeof current !== 'function') {
    throw new Error(
      `playwright-server: ${path.join(packageDir, 'lib/server/dom.js')} has no ElementHandle.prototype._initializePreview. ` +
        "Playwright's server moved the element preview; playwriter must replace it before connecting, or the page's own " +
        'console.log(element) gives it user activation.',
    )
  }
  if (current === previewWithoutGesture) return
  Reflect.set(prototype, '_initializePreview', previewWithoutGesture)
}

/**
 * The id of `frame`'s page-world execution context in its renderer session, as Playwright's server
 * tracks it. Waits for the context while the frame is between documents.
 */
export async function pageWorldContextId(frame: Frame): Promise<number> {
  const connection = field(frame, '_connection')
  const toImpl = field(connection, 'toImpl')
  if (typeof toImpl !== 'function') {
    throw new Error("playwright-server: this Playwright connection does not run its server in this process (no toImpl), so a frame's page world cannot be found.")
  }
  const serverFrame: unknown = Reflect.apply(toImpl, connection, [frame])
  const mainContext = field(serverFrame, '_mainContext')
  if (typeof mainContext !== 'function') throw new Error("playwright-server: Playwright's server frame has no _mainContext().")
  const context: unknown = await Reflect.apply(mainContext, serverFrame, [])
  const contextId = field(field(context, 'delegate'), '_contextId')
  if (typeof contextId !== 'number') throw new Error("playwright-server: the frame's page-world context has no CDP context id.")
  return contextId
}
