/**
 * The two human-mode refusals must agree: the static policy (code-policy.ts) reads Playwright calls by
 * their client API names, the run-time guard (executor.ts) by the protocol calls that go out
 * (playwright-call-effects.ts). Each case here runs a real Playwright call against a real page, records
 * the protocol calls it sends, and checks both: the static analysis of the same code refuses it, and
 * the first protocol call it makes is one the guard refuses. A name the static tables miss, or a
 * protocol method the table marks harmless, fails here.
 */

import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { getChromium } from './playwright-import.js'
import { resolveBrowserExecutablePath } from './browser-config.js'
import { analyzeCode } from './code-policy.js'
import { callEffect, isRefusedEffect } from './playwright-call-effects.js'
import { outgoingCallsOf } from './playwright-client-hooks.js'

const PAGE = `<!doctype html><html><head><title>Calls</title></head><body>
<h1 id="h">Hello</h1><input id="q" value="x"><input id="c" type="checkbox"><input id="f" type="file">
<select id="s"><option>a</option><option>b</option></select><button id="b">Go</button>
<div id="drag" draggable="true">drag</div><div id="drop">drop</div>
<iframe srcdoc="<p>inner</p>"></iframe></body></html>`

type Category = 'read' | 'element' | 'forced'

const CASES: Array<[Category, string]> = [
  ['read', 'await page.title()'],
  ['read', 'await page.content()'],
  ['read', 'await page.evaluate(() => 1)'],
  ['read', 'await page.evaluateHandle(() => document)'],
  ['read', "await page.$('h1')"],
  ['read', "await page.$$('h1')"],
  ['read', "await page.$eval('h1', (e) => e.id)"],
  ['read', "await page.$$eval('h1', (e) => e.length)"],
  ['read', "await page.waitForSelector('h1')"],
  ['read', 'await page.waitForFunction(() => true)'],
  ['read', "await page.screenshot({ caret: 'initial' })"],
  ['read', "await page.locator('h1').textContent()"],
  ['read', "await page.locator('h1').innerText()"],
  ['read', "await page.locator('h1').innerHTML()"],
  ['read', "await page.locator('h1').getAttribute('id')"],
  ['read', "await page.locator('#q').inputValue()"],
  ['read', "await page.locator('#c').isChecked()"],
  ['read', "await page.locator('#q').isDisabled()"],
  ['read', "await page.locator('#q').isEditable()"],
  ['read', "await page.locator('#q').isEnabled()"],
  ['read', "await page.locator('h1').isHidden()"],
  ['read', "await page.locator('h1').isVisible()"],
  ['read', "await page.locator('h1').count()"],
  ['read', "await page.locator('h1').all()"],
  ['read', "await page.locator('h1').allTextContents()"],
  ['read', "await page.locator('h1').allInnerTexts()"],
  ['read', "await page.locator('h1').boundingBox()"],
  ['read', "await page.locator('h1').elementHandle()"],
  ['read', "await page.locator('h1').elementHandles()"],
  ['read', "await page.locator('h1').evaluate((e) => e.id)"],
  ['read', "await page.locator('h1').evaluateAll((e) => e.length)"],
  ['read', "await page.locator('h1').ariaSnapshot()"],
  ['read', "await page.locator('h1').screenshot()"],
  ['read', "await page.locator('h1').waitFor()"],
  ['read', 'await page.frames()[1].frameElement()'],
  ['read', 'await context.storageState()'],
  ['element', "await page.locator('#b').click()"],
  ['element', "await page.locator('#b').dblclick()"],
  ['element', "await page.locator('#b').hover()"],
  ['element', "await page.locator('#q').fill('y')"],
  ['element', "await page.locator('#q').pressSequentially('y')"],
  ['element', "await page.locator('#q').press('a')"],
  ['element', "await page.locator('#c').check()"],
  ['element', "await page.locator('#c').uncheck()"],
  ['element', "await page.locator('#c').setChecked(true)"],
  ['element', "await page.locator('#s').selectOption('b')"],
  ['element', "await page.locator('#q').clear()"],
  ['element', "await page.locator('#q').selectText()"],
  ['element', "await page.locator('#q').focus()"],
  ['element', "await page.locator('#q').blur()"],
  ['element', "await page.locator('#b').scrollIntoViewIfNeeded()"],
  ['element', "await page.locator('#f').setInputFiles([])"],
  ['element', "await page.locator('#drag').dragTo(page.locator('#drop'))"],
  ['element', "await page.click('#b')"],
  ['element', "await page.fill('#q', 'y')"],
  ['forced', "await page.locator('h1').highlight()"],
  ['forced', "await page.locator('h1').dispatchEvent('click')"],
  ['forced', "await page.addStyleTag({ content: 'h1 {}' })"],
  ['forced', "await page.addScriptTag({ content: '1' })"],
  ['forced', 'await page.addInitScript(() => 1)'],
  ['forced', "await page.exposeFunction('f', () => 1)"],
  ['forced', 'await page.setViewportSize({ width: 800, height: 600 })'],
  ['forced', "await page.emulateMedia({ media: 'print' })"],
  ['forced', 'await page.pdf()'],
  ['forced', 'await context.newCDPSession(page)'],
  ['forced', 'await page.clock.install()'],
  ['forced', "await context.grantPermissions(['geolocation'])"],
  ['forced', 'await context.setExtraHTTPHeaders({ a: "b" })'],
  ['forced', "await context.addCookies([{ name: 'a', value: 'b', url: 'http://127.0.0.1/' }])"],
  ['forced', 'await context.clearCookies()'],
  ['forced', "await page.route('**/nothing', (route) => route.continue())"],
  ['forced', 'await context.setOffline(false)'],
]

/** How the static policy classifies `code`. */
function staticCategory(code: string): Category | null {
  const analysis = analyzeCode(code)
  if (analysis.scriptReads.length > 0) return 'read'
  if (analysis.inputActions.some((site) => site.viaScript)) return 'element'
  if (analysis.forcedState.length > 0) return 'forced'
  return null
}

const AsyncFunction: FunctionConstructor = Object.getPrototypeOf(async function () {}).constructor

let server: http.Server
let url = ''
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  url = `http://127.0.0.1:${address.port}/`
  const chromium = await getChromium()
  browser = await chromium.launch({ headless: true, executablePath: resolveBrowserExecutablePath() })
})

afterAll(async () => {
  await browser.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('static and run-time human-mode refusals agree', () => {
  for (const [category, code] of CASES) {
    it(`${category}: ${code}`, async () => {
      expect(staticCategory(code)).toBe(category)
      const context: BrowserContext = await browser.newContext()
      const page: Page = await context.newPage()
      await page.goto(url)
      const sent: string[] = []
      const listeners = outgoingCallsOf(page)
      if (!listeners) throw new Error('no outgoing-call hook')
      const listener = ({ owner, method }: { owner: object; method: string }): undefined => {
        sent.push(`${String(Reflect.get(owner, '_type'))}.${method}`)
        return undefined
      }
      listeners.add(listener)
      try {
        await Reflect.apply(new AsyncFunction('page', 'context', code), undefined, [page, context])
      } finally {
        listeners.delete(listener)
        await context.close()
      }
      const first = sent.find((call) => !call.endsWith('.updateSubscription'))
      expect(first, `${code} sent ${sent.join(', ')}`).toBeDefined()
      const [type, method] = (first ?? '').split('.')
      const effect = callEffect(type, method, {})
      expect(effect !== null && isRefusedEffect(effect), `${first} (first call of ${code}) must be refused at run time`).toBe(true)
    })
  }
})
