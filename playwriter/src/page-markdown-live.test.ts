/**
 * getPageMarkdown through the real executor in human mode, on closed shadow roots: script cannot
 * reach them, so their text has to come through CDP. The page is served from `localhost` and holds
 * an open root, a closed root with a nested closed root, a same-origin iframe and a `127.0.0.1`
 * iframe (another site: out of process under Chromium's site isolation), each iframe with a closed
 * root of its own. Every document and every closed root counts its own mutation records, so the
 * test sees that reading them changed nothing.
 */

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

/** Defines `tag` as an element with a closed shadow root holding `html`; the page's mutation counter watches that root too. */
const closedElement = (tag: string, html: string): string =>
  `customElements.define('${tag}', class extends HTMLElement {
    constructor() {
      super()
      const root = this.attachShadow({ mode: 'closed' })
      root.innerHTML = ${JSON.stringify(html)}
      watch(root)
    }
  })`

/** The page's own mutation counter over its document (and, through `watch`, its closed roots). */
const COUNT_MUTATIONS = `
  window.__mutations = 0
  const counter = new MutationObserver((records) => { window.__mutations += records.length })
  const watch = (node) => counter.observe(node, { subtree: true, childList: true, attributes: true, characterData: true })
  watch(document)`

const PAGE = (crossOrigin: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Closed roots</title></head><body>
<h1>Store front</h1>
<p>Light text before the hosts.</p>
<open-card></open-card>
<closed-card></closed-card>
<p>Light text between the hosts and the frames.</p>
<iframe title="Same origin widget" src="/widget"></iframe>
<iframe title="Cross site widget" src="${crossOrigin}/widget"></iframe>
<p>Light text after the frames.</p>
<script>${COUNT_MUTATIONS}
  customElements.define('open-card', class extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: 'open' }).innerHTML = '<p>Open root paragraph.</p>'
    }
  })
  ${closedElement('closed-card', '<article><h2>Closed story</h2><p>Closed article paragraph.</p><nested-card></nested-card></article>')}
  ${closedElement('nested-card', '<p>Nested closed paragraph.</p>')}
</script></body></html>`

const WIDGET = `<!doctype html><html><head><meta charset="utf-8"><title>Widget</title></head><body>
<p>Widget light text.</p><widget-card></widget-card><button>Widget button</button>
<script>${COUNT_MUTATIONS}
  ${closedElement('widget-card', '<p>Widget closed text.</p>')}
</script></body></html>`

let server: http.Server
let port = 0
let cwd = ''
let executor: PlaywrightExecutor

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const html = req.url === '/' ? PAGE(`http://127.0.0.1:${port}`) : req.url === '/widget' ? WIDGET : null
    res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html ?? 'not found')
  })
  // Every interface: the page is loaded as `localhost`, its cross-site iframe as `127.0.0.1`.
  const listening = Promise.withResolvers<void>()
  server.listen(0, () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-closed-'))
  executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
})

afterAll(async () => {
  await executor?.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

/** The ref printed in front of every line matching `pattern`. */
function refsOf(text: string, pattern: RegExp): number[] {
  return text
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => Number(/\[(\d+)\]/.exec(line)?.[1]))
}

describe('getPageMarkdown on closed shadow roots (human mode)', () => {
  it('reads every closed root at its host, nested ones and those in same-origin and cross-site iframes, without changing any document', async () => {
    const loaded = await executor.execute(`await page.goto('http://localhost:${port}/', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)
    // One button per iframe: a ref to read each frame's own mutation counter with.
    const buttons = refsOf(look.text, /button "Widget button"/)
    expect(buttons).toHaveLength(2)
    // A plain read: the observer's callback has run (a microtask) before readPage's own task.
    const counters = `return await Promise.all([undefined, ${buttons.join(', ')}].map((ref) => readPage(() => window.__mutations, ref === undefined ? {} : { ref })))`
    const before = await executor.execute(counters, 30000)
    expect(before.isError, before.text).toBe(false)

    const result = await executor.execute('return await getPageMarkdown({})', 30000)
    expect(result.isError, result.text).toBe(false)
    const widget = (name: string): string[] => [
      `[iframe "${name}"]`,
      'Widget light text.',
      'Widget closed text.',
      'Widget button',
      `[end of iframe "${name}"]`,
    ]
    expect(result.text).toContain(
      [
        '# Store front',
        'Light text before the hosts.',
        'Open root paragraph.',
        '## Closed story',
        'Closed article paragraph.',
        'Nested closed paragraph.',
        'Light text between the hosts and the frames.',
        ...widget('Same origin widget'),
        ...widget('Cross site widget'),
        'Light text after the frames.',
      ].join('\n\n'),
    )

    const after = await executor.execute(counters, 30000)
    expect(after.text).toBe(before.text)
    expect(before.text).toMatch(/\[\s*0,\s*0,\s*0\s*\]/)
  })
})
