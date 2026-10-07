/**
 * The action report end to end through the real executor in human mode, on the Browser Lab pages
 * where the hands-on comparison found it wrong (test/fixtures/browser-lab, served here on an
 * ephemeral port). Every assertion is on what the MODEL reads:
 *  - storage.html re-renders all three tables on every button: unchanged rows are not reported as
 *    gone and new, and "Clear all" (three tables each showing "(empty)") is not a possible duplicate;
 *  - spa.html shows skeleton cards in an aria-busy grid while the products load: the settle line
 *    names them once they are gone;
 *  - pointer.html shows a tooltip on hover: the report lists it, and its going.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')
const SPA_ROUTES: Record<string, true> = { '/spa': true, '/spa/': true, '/spa/products': true, '/spa/cart': true }
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }

/**
 * A tooltip shown 700ms after the pointer enters its button: Radix UI's default `delayDuration`
 * (shadcn/ui's tooltips), longer than the lab's 500ms. Its script uses a real timer on purpose:
 * the report must wait for it against the renderer's own clock.
 */
const DELAYED_TOOLTIP = `<!doctype html><html><head><meta charset="utf-8"><title>Delayed tooltip</title>
<style>.wrap { position: relative; display: inline-block; margin: 40px } [role=tooltip] { position: absolute; top: 120%; left: 0; background: #222; color: #fff; padding: 4px 8px; white-space: nowrap } [role=tooltip][hidden] { display: none }</style>
</head><body><main><h1>Settings</h1><p>Plain words.</p>
<span class="wrap"><button id="sync" aria-describedby="tip">Sync now</button><span role="tooltip" id="tip" hidden>Last synced 2 minutes ago</span></span></main>
<script>
  var button = document.getElementById('sync'), tip = document.getElementById('tip'), timer
  button.addEventListener('pointerenter', function () { timer = setTimeout(function () { tip.hidden = false }, 700) })
  button.addEventListener('pointerleave', function () { clearTimeout(timer); tip.hidden = true })
</script></body></html>`

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname === '/api/products') {
      // The lab's own delay, real on purpose: the skeletons must be on screen while settle waits.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ products: [{ id: 'p1', name: 'Mechanical Keyboard', price: 89 }, { id: 'p2', name: 'Wireless Mouse', price: 29 }] }))
      }, 800)
      return
    }
    if (pathname === '/api/items') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ items: [], nextOffset: null }))
      return
    }
    if (pathname === '/delayed-tooltip.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(DELAYED_TOOLTIP)
      return
    }
    const file = path.join(LAB, SPA_ROUTES[pathname] ? 'spa.html' : pathname)
    if (!file.startsWith(LAB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'report-meaning-'))
})

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

/** A fresh human-mode session on a lab page, with what the model saw on it. */
async function openLab(page: string): Promise<{ executor: PlaywrightExecutor; observation: string }> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  executors.push(executor)
  const load = await executor.execute(`await page.goto('${baseUrl}/${page}', { waitUntil: 'domcontentloaded' })`, 30000)
  expect(load.isError, load.text).toBe(false)
  const look = await executor.execute('await observe()', 30000)
  expect(look.isError, look.text).toBe(false)
  return { executor, observation: look.text }
}

/** The ref printed in front of the first line matching `pattern`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

function linesMatching(text: string, pattern: RegExp): string[] {
  return text.split('\n').filter((line) => pattern.test(line))
}

describe('what changed, on pages that re-render', () => {
  it('storage tables re-rendered with the same rows are not reported, and three "(empty)" tables are no duplicate', async () => {
    const { executor, observation } = await openLab('storage.html')
    const cookie = await executor.execute(`await act.click(${refOf(observation, /button "Set cookie"/)})`, 30000)
    expect(cookie.isError, cookie.text).toBe(false)
    expect(cookie.text).toMatch(/^\+ row: "theme \| dark"/m)
    // Only the Cookies table changed: its "(empty)" row went. The other two re-rendered the same.
    expect(linesMatching(cookie.text, /^- row: "\(empty\)"/)).toHaveLength(1)
    expect(linesMatching(cookie.text, /^\+ row: "\(empty\)"/)).toEqual([])

    const local = await executor.execute(`await act.click(${refOf(observation, /button "Set localStorage"/)})`, 30000)
    expect(local.isError, local.text).toBe(false)
    expect(local.text).toMatch(/^\+ row: "lab-pref \| compact"/m)
    expect(local.text).not.toMatch(/theme \| dark/)

    const clear = await executor.execute(`await act.click(${refOf(observation, /button "Clear all"/)})`, 30000)
    expect(clear.isError, clear.text).toBe(false)
    expect(clear.text).toMatch(/^- row: "theme \| dark"/m)
    expect(clear.text).not.toMatch(/possible duplicate/)
  })

  it('the SPA products grid: the settle line names the aria-busy grid and the skeletons it waited through', async () => {
    const { executor, observation } = await openLab('spa/')
    const products = refOf(observation, /link "Products"/)
    const result = await executor.execute(`await act.click(${products})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/^SETTLED \d+ms — page content and network went quiet$/m)
    expect(result.text).toMatch(
      /^ {8}busy while it settled, gone now: area "Products" \[aria-busy\] \(seen \d\.\ds\) · 6 skeleton placeholders \(animation lab-shimmer\) in area "Products" \(seen \d\.\ds\)$/m,
    )
    expect(result.text).toMatch(/Mechanical Keyboard/)
    expect(result.text).not.toMatch(/^BUSY/m)
  })

  it('a tooltip shown by hovering is reported, and so is its going', async () => {
    const { executor, observation } = await openLab('pointer.html')
    const shipping = refOf(observation, /button "Shipping info"/)
    const shown = await executor.execute(`await act.hover(${shipping})`, 30000)
    expect(shown.isError, shown.text).toBe(false)
    expect(shown.text).toMatch(/^\+ tooltip "Free shipping on orders over \$50"/m)
    const heading = refOf(observation, /button "Products ▾"/)
    const gone = await executor.execute(`await act.hover(${heading})`, 30000)
    expect(gone.isError, gone.text).toBe(false)
    expect(gone.text).toMatch(/^- tooltip "Free shipping on orders over \$50"/m)
  })

  // A guard that no extra hover dwell is needed: the settle after a hover outlasts Radix UI's
  // default 700ms tooltip delay (measured: the report lists it without one).
  it('a tooltip that waits 700ms before it shows (Radix UI default) is in the hover report', async () => {
    const { executor, observation } = await openLab('delayed-tooltip.html')
    const shown = await executor.execute(`await act.hover(${refOf(observation, /button "Sync now"/)})`, 30000)
    expect(shown.isError, shown.text).toBe(false)
    expect(shown.text).toMatch(/^\+ tooltip "Last synced 2 minutes ago"/m)
  })
})
