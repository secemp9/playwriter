/**
 * audit() against a real headless Chromium, through the executor: the lab's accessibility page
 * (seven planted problems), a page with a same-process iframe, an out-of-process iframe and a
 * frame nested in it, a page under a strict CSP, and the proof that auditing leaves nothing the
 * page can see — no global, no DOM mutation, no stylesheet, no event, no listener, no request.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { auditCatalog } from './page-audit.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

/**
 * The page's own witness, written the way a page would watch for a tool: every DOM mutation (the
 * document and an open shadow root), new window globals, stylesheets, events of every kind a read
 * could cause, requests, scroll, focus and user activation.
 */
const WITNESS = `<script>
(() => {
  const start = new Set(Object.getOwnPropertyNames(window))
  let mutations = 0
  const events = {}
  const longTasks = []
  const watch = (root) => new MutationObserver((records) => { mutations += records.length }).observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
  watch(document)
  for (const type of ['scroll', 'focus', 'blur', 'focusin', 'focusout', 'message', 'click', 'pointerdown', 'pointermove', 'mousedown', 'mousemove', 'mouseover', 'keydown', 'wheel', 'resize', 'selectionchange', 'visibilitychange', 'load', 'error'])
    window.addEventListener(type, () => { events[type] = (events[type] || 0) + 1 }, true)
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration)) }).observe({ type: 'longtask' })
  window.__witnessShadow = (root) => watch(root)
  Object.defineProperty(window, '__witness', { enumerable: false, value: () => {
    const host = document.getElementById('host')
    const shadow = host && host.shadowRoot
    return JSON.stringify({
      mutations,
      events,
      globals: Object.getOwnPropertyNames(window).filter((name) => !start.has(name) && name !== '__witnessShadow'),
      sheets: document.styleSheets.length + document.adoptedStyleSheets.length + (shadow ? shadow.styleSheets.length + shadow.adoptedStyleSheets.length : 0),
      resources: performance.getEntriesByType('resource').map((entry) => entry.name),
      scroll: [scrollX, scrollY],
      active: document.activeElement ? document.activeElement.tagName : null,
      activated: navigator.userActivation.hasBeenActive,
      axe: typeof window.axe,
      longTasks,
    })
  } })
})()
</script>`

const PURE_PAGE = `<!doctype html><html lang="en"><head><title>Purity</title>${WITNESS}
<style>.faint { color: #ccc }</style></head>
<body><main><h1>Purity</h1><h4>Skipped levels</h4>
<img src="/pixel.svg"><p class="faint">faint text</p>
<input placeholder="Search"><div id="go" class="go">Go</div>
<div id="host"></div>
<div style="height: 3000px">tall</div>
<iframe id="inner" src="/pure-frame" title="inner"></iframe></main>
<script>
  const shadow = document.getElementById('host').attachShadow({ mode: 'open' })
  shadow.innerHTML = '<button class="in-shadow"></button>'
  window.__witnessShadow(shadow)
  document.getElementById('go').addEventListener('click', () => {})
</script></body></html>`

const PURE_FRAME = `<!doctype html><html lang="en"><head><title>Inner</title>${WITNESS}</head><body><button></button><img src="/pixel.svg"></body></html>`

const FRAMES_PAGE = (port: number) => `<!doctype html><html lang="en"><head><title>Frames</title></head>
<body><main><h1>Frames</h1>
<iframe id="same" src="/same" title="same-origin"></iframe>
<iframe id="cross" src="http://127.0.0.1:${port}/cross" title="cross-site"></iframe>
<iframe id="hidden" src="/hidden" title="hidden" style="display: none"></iframe>
</main></body></html>`

const SAME_FRAME = `<!doctype html><html lang="en"><head><title>Same</title></head><body><h3>Late heading</h3><button id="nameless"></button></body></html>`
const CROSS_FRAME = `<!doctype html><html lang="en"><head><title>Cross</title></head><body>
<img src="/pixel.svg"><input placeholder="Card number" id="card">
<iframe id="nested" src="/nested" title="nested"></iframe></body></html>`
const NESTED_FRAME = `<!doctype html><html lang="en"><head><title>Nested</title></head><body>
<div id="pay" style="width: 80px; height: 30px">Pay</div>
<script>document.getElementById('pay').addEventListener('click', () => {})</script></body></html>`
const HIDDEN_FRAME = `<!doctype html><html lang="en"><head><title>Hidden</title></head><body><button></button></body></html>`

const CSP_PAGE = `<!doctype html><html lang="en"><head><title>Strict</title></head><body><main><h1>Strict CSP</h1><button></button></main></body></html>`

const PIXEL = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="teal"/></svg>'

let server: http.Server
let port = 0
let cwd = ''
const executors: PlaywrightExecutor[] = []

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const pages: Record<string, string> = {
      '/pure': PURE_PAGE,
      '/pure-frame': PURE_FRAME,
      '/frames': FRAMES_PAGE(port),
      '/same': SAME_FRAME,
      '/cross': CROSS_FRAME,
      '/nested': NESTED_FRAME,
      '/hidden': HIDDEN_FRAME,
      '/csp': CSP_PAGE,
    }
    if (url.pathname === '/pixel.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      res.end(PIXEL)
      return
    }
    const page = pages[url.pathname]
    if (page) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...(url.pathname === '/csp' ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self'" } : {}),
      })
      res.end(page)
      return
    }
    const file = path.join(LAB, path.normalize(url.pathname))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    res.end(fs.readFileSync(file))
  })
  // Every interface: pages load as `localhost`, the cross-site iframe as `127.0.0.1` (another site,
  // so headless Chromium's site isolation puts it in its own renderer process).
  const listening = Promise.withResolvers<void>()
  server.listen(0, () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'page-audit-'))
})

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

async function open(policy: 'human' | 'debug', pathname: string): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('http://localhost:${port}${pathname}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

/** The line of `text` that names `pattern`, and the ref on it. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

/** The rule's block in the printed report: its heading line and the element lines under it. */
function ruleBlock(text: string, id: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^\\[[a-z ]+\\] ${id}\\b`).test(line))
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && !line.startsWith('  '))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('audit()', () => {
  it("finds all seven problems planted on the lab's accessibility page, each named by its ref", async () => {
    const executor = await open('human', '/a11y.html')
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)
    const result = await executor.execute('await audit()', 60000)
    expect(result.isError, result.text).toBe(false)
    const text = result.text
    expect(text).toMatch(/^AUDIT http:\/\/localhost:\d+\/a11y\.html · axe-core 4\.14\.0 \+ playwriter checks · 1 frame, \d+ elements checked by axe in [\d.]+ s \([\d.]+ s in all, with placing them among observe's refs\)$/m)
    // 1. The email field is named only by its placeholder (axe's own `label` rule passes it).
    expect(ruleBlock(text, 'placeholder-only-label')).toMatch(/^\[serious\] placeholder-only-label \(playwriter check\) — .*\n {2}\[\d+\] textbox "Email"/m)
    // 2. The chart image has no alt.
    expect(ruleBlock(text, 'image-alt')).toMatch(/^\[critical\] image-alt — Images must have alternative text — https:\/\/dequeuniversity\.com\/rules\/axe\/4\.14\/image-alt\n {2}.*chart\.svg/m)
    // 3. The trash button has no name, and the line carries the ref observe gave it.
    const trash = refOf(look.text, /\] button(?! ")/)
    expect(ruleBlock(text, 'button-name')).toContain(`[${trash}] button (unnamed) — Element does not have inner text that is visible to screen readers`)
    // 4. "Offer ends at midnight." is #c4c4c4 on white: 1.74:1.
    expect(ruleBlock(text, 'color-contrast')).toMatch(/Offer ends at midnight\..*insufficient color contrast of 1\.74/)
    // 5. Two elements share the id "promo" (axe's duplicate-id, off by default in axe, is on).
    expect(ruleBlock(text, 'duplicate-id')).toContain('promo')
    // 6. "Subscribe" is a <div> with a click listener: not focusable, no role.
    expect(ruleBlock(text, 'clickable-without-keyboard')).toMatch(/\[\d+\] clickable div#subscribe\.fake-button "Subscribe" — It responds to clicks but is not focusable/)
    // 7. The headings jump from h1 to h4.
    expect(ruleBlock(text, 'heading-order')).toMatch(/Monthly digest/)
    expect(text).toMatch(/NOT RUN: .*target-size.*\(off by default in axe\)/)
  }, 120000)

  it('leaves the page nothing to see: no global, mutation, stylesheet, event, listener, request or activation', async () => {
    const executor = await open('debug', '/pure')
    const witness = async (): Promise<Record<string, Record<string, unknown>>> => {
      const read = await executor.execute(
        `const cdp = await getCDPSession({ page })
         const out = {}
         // Raw CDP evaluate in the main world: no Playwright script, so no user gesture from the read itself.
         const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.__witness()', returnByValue: true })
         out.main = JSON.parse(result.value)
         const win = await cdp.send('Runtime.evaluate', { expression: 'window' })
         out.main.listeners = (await cdp.send('DOMDebugger.getEventListeners', { objectId: win.result.objectId })).listeners.length
         const doc = await cdp.send('Runtime.evaluate', { expression: 'document' })
         out.main.documentListeners = (await cdp.send('DOMDebugger.getEventListeners', { objectId: doc.result.objectId, depth: -1 })).listeners.length
         const frame = await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("inner").contentWindow.__witness()', returnByValue: true })
         out.frame = JSON.parse(frame.result.value)
         console.log('WITNESS ' + JSON.stringify(out))`,
        30000,
      )
      expect(read.isError, read.text).toBe(false)
      const line = read.text.split('\n').find((candidate) => candidate.includes('WITNESS '))
      if (!line) throw new Error(`no witness in ${read.text}`)
      return JSON.parse(line.slice(line.indexOf('WITNESS ') + 'WITNESS '.length))
    }
    const before = await witness()
    const result = await executor.execute('await audit()', 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/2 frames, \d+ elements checked/)
    // The button in the open shadow root, and the one in the iframe.
    expect(ruleBlock(result.text, 'button-name')).toMatch(/\[\d+\] button \(unnamed\) \(after "Go"\) — /)
    expect(ruleBlock(result.text, 'button-name')).toMatch(new RegExp(`\\[\\d+\\] button \\(unnamed\\) \\(in iframe "inner"\\) · in iframe http://localhost:${port}/pure-frame`))
    const after = await witness()
    for (const side of ['main', 'frame']) {
      const { longTasks: _beforeLong, ...was } = before[side]
      const { longTasks: afterLong, ...now } = after[side]
      // Everything the page can observe is unchanged, except main-thread time: axe's work shows up as
      // `longtask` entries (measured; reported, not asserted away).
      expect(now, side).toEqual(was)
      expect(now.axe).toBe('undefined')
      expect(Array.isArray(afterLong)).toBe(true)
    }
  }, 120000)

  it('audits a same-process iframe, an out-of-process iframe and the frame nested in it, judging page-wide rules across them', async () => {
    const executor = await open('human', '/frames')
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)
    const frameButton = refOf(look.text, /\] button(?! ")/)
    const result = await executor.execute('await audit()', 60000)
    expect(result.isError, result.text).toBe(false)
    const text = result.text
    expect(text).toMatch(/· 4 frames, \d+ elements checked/)
    expect(text).toMatch(new RegExp(`frame http://127\\.0\\.0\\.1:${port}/cross: \\d+ elements`))
    expect(text).toMatch(new RegExp(`frame http://127\\.0\\.0\\.1:${port}/nested: \\d+ elements`))
    // Same-process iframe: the nameless button, with its ref.
    expect(ruleBlock(text, 'button-name')).toContain(`[${frameButton}] button (unnamed)`)
    expect(ruleBlock(text, 'button-name')).toContain(`in iframe http://localhost:${port}/same`)
    // Out-of-process iframe: the image without alt and the placeholder-only field.
    expect(ruleBlock(text, 'image-alt')).toContain(`in iframe http://127.0.0.1:${port}/cross`)
    expect(ruleBlock(text, 'placeholder-only-label')).toMatch(new RegExp(`textbox "Card number".*in iframe http://127\\.0\\.0\\.1:${port}/cross`))
    // The frame nested in the out-of-process one: a clickable div.
    expect(ruleBlock(text, 'clickable-without-keyboard')).toMatch(new RegExp(`clickable div#pay "Pay" · in iframe http://127\\.0\\.0\\.1:${port}/nested — It responds to clicks`))
    // Heading order is judged across frames: the h1 of the page, then the frame's h3.
    expect(ruleBlock(text, 'heading-order')).toMatch(/Late heading/)
    // Page-wide rules are not applied to each frame as if it were a page.
    expect(ruleBlock(text, 'page-has-heading-one')).toBe('')
    expect(ruleBlock(text, 'landmark-one-main')).toBe('')
    // The hidden iframe is named, with why.
    expect(text).toMatch(new RegExp(`NOT AUDITED:\\n {2}iframe http://localhost:${port}/hidden — axe does not audit it: its <iframe> is hidden from screen readers`))
  }, 120000)

  it('limits the audit to one element with a ref, and to rules or tags', async () => {
    const executor = await open('human', '/a11y.html')
    const look = await executor.execute('await observe()', 30000)
    const trash = refOf(look.text, /\] button(?! ")/)
    const scoped = await executor.execute(`await audit({ ref: ${trash} })`, 60000)
    expect(scoped.isError, scoped.text).toBe(false)
    expect(scoped.text).toMatch(new RegExp(`^AUDIT .* — only \\[${trash}\\] button · .* 1 frame, [1-9] elements`, 'm'))
    expect(ruleBlock(scoped.text, 'button-name')).toContain(`[${trash}] button (unnamed)`)
    expect(ruleBlock(scoped.text, 'image-alt')).toBe('')
    expect(ruleBlock(scoped.text, 'clickable-without-keyboard')).toBe('')
    expect(scoped.text).toMatch(/bypass \(judged over the whole page; not for one element\)/)

    const rules = await executor.execute(`return JSON.stringify((await audit({ rules: ['color-contrast', 'clickable-without-keyboard'] })).violations.map((rule) => rule.id))`, 60000)
    expect(rules.isError, rules.text).toBe(false)
    // Most severe first; both are serious, so by id.
    expect(rules.text).toContain('["clickable-without-keyboard","color-contrast"]')
    expect(rules.text).toMatch(/NOT RUN: \d+ other rules \(not in `rules`\)/)

    const tags = await executor.execute(`return JSON.stringify((await audit({ tags: ['wcag111'] })).violations.map((rule) => rule.id))`, 60000)
    expect(tags.isError, tags.text).toBe(false)
    expect(tags.text).toContain('["image-alt"]')
  }, 120000)

  it('runs in human mode as a read: an action may follow it in the same call', async () => {
    const executor = await open('human', '/a11y.html')
    const look = await executor.execute('await observe()', 30000)
    const subscribe = refOf(look.text, /clickable div#subscribe\.fake-button "Subscribe"/)
    const result = await executor.execute(`await audit({ rules: ['image-alt'] })\nawait act.click(${subscribe})`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('[critical] image-alt')
    expect(result.text).toContain('Enter an email first')
  }, 120000)

  it('names a wrong option, an unknown rule or tag, and refuses the rule that would re-fetch stylesheets', async () => {
    const executor = await open('human', '/a11y.html')
    const wrongKey = await executor.execute(`await audit({ selector: 'main' })`, 30000)
    expect(wrongKey.isError).toBe(true)
    expect(wrongKey.text).toContain('audit: unknown option `selector`. Options: ref, rules, tags, page.')
    const wrongRule = await executor.execute(`await audit({ rules: ['colour-contrast'] })`, 30000)
    expect(wrongRule.isError).toBe(true)
    expect(wrongRule.text).toMatch(/audit: no rule "colour-contrast"\. The rules: .*color-contrast/)
    const wrongTag = await executor.execute(`await audit({ tags: ['wcag9'] })`, 30000)
    expect(wrongTag.isError).toBe(true)
    expect(wrongTag.text).toMatch(/audit: no rule has the tag "wcag9"\. The tags: .*wcag2aa/)
    const cssom = await executor.execute(`await audit({ rules: ['css-orientation-lock'] })`, 30000)
    expect(cssom.isError).toBe(true)
    expect(cssom.text).toContain("css-orientation-lock needs axe to download the page's cross-origin stylesheets again")
    const both = await executor.execute(`await audit({ rules: ['image-alt'], tags: ['wcag2a'] })`, 30000)
    expect(both.isError).toBe(true)
    expect(both.text).toContain('audit: pass `rules` or `tags`, not both')
  }, 120000)

  it("works under a page CSP that forbids eval: the isolated world is not bound by it", async () => {
    const executor = await open('human', '/csp')
    const result = await executor.execute('await audit()', 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/\[critical\] button-name/)
  }, 120000)
})

describe('auditCatalog', () => {
  it("reads axe-core 4.14.0's rules, marks the cross-frame ones, and adds the two playwriter checks", () => {
    const { version, rules } = auditCatalog()
    expect(version).toBe('4.14.0')
    expect(rules.get('heading-order')?.crossFrame).toBe(true)
    expect(rules.get('region')?.crossFrame).toBe(true)
    expect(rules.get('color-contrast')?.crossFrame).toBe(false)
    expect(rules.get('bypass')?.pageLevel).toBe(true)
    expect(rules.get('duplicate-id')?.enabledByDefault).toBe(false)
    expect(rules.get('placeholder-only-label')?.source).toBe('playwriter')
    expect(rules.get('clickable-without-keyboard')?.source).toBe('playwriter')
    expect(rules.get('button-name')?.helpUrl).toBe('https://dequeuniversity.com/rules/axe/4.14/button-name')
  })
})
