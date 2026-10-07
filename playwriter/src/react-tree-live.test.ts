/**
 * react.tree() and react.suspense() on a REAL React 19.2.7 development build
 * (test/fixtures/react-tree, bundled here with bun and a linked sourcemap), driven through the
 * executor in human mode the way a model drives it: the whole component tree with keys, props, JSX
 * sites mapped to the original .tsx and refs; a tree scoped to one element; the Suspense boundaries
 * and whether each is suspended, before and after the promise resolves; and the page's own realm left
 * as it was.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/react-tree')
const fixtureSource = fs.readFileSync(path.join(fixtureDir, 'App.tsx'), 'utf8')

/** 1-based line of the first line containing `needle` in the fixture. */
function lineOf(needle: string): number {
  const index = fixtureSource.split('\n').findIndex((line) => line.includes(needle))
  if (index < 0) throw new Error(`fixture has no line containing ${needle}`)
  return index + 1
}

let server: http.Server
let baseUrl = ''
let bundleDir = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-tree-'))
  execFileSync('bun', [path.join(fixtureDir, 'build.ts'), bundleDir], { stdio: 'pipe' })
  server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/app.js' || url === '/app.js.map') {
      res.writeHead(200, { 'Content-Type': url.endsWith('.map') ? 'application/json' : 'text/javascript' })
      res.end(fs.readFileSync(path.join(bundleDir, url.slice(1))))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      url === '/plain'
        ? '<!doctype html><html><head><title>plain</title></head><body><h1>No React here</h1><button>Plain button</button></body></html>'
        : '<!doctype html><html><head><meta charset="utf-8"><title>react tree</title></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
    )
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'react-tree-cwd-'))
}, 120000)

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  await closed.promise
  fs.rmSync(bundleDir, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
})

async function open(policy: 'human' | 'debug', at: string): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('${baseUrl}${at}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

async function run(executor: PlaywrightExecutor, code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

const OWN_NAMES = "return await readPage(() => Object.getOwnPropertyNames(window).sort().join(','))"

describe('react.tree() and react.suspense() in human mode', () => {
  let human: PlaywrightExecutor
  let observed = ''
  beforeAll(async () => {
    human = await open('human', '/')
    observed = await run(human, 'await observe()')
  }, 60000)

  it('prints the whole tree: names, keys, props, the JSX site in App.tsx and the element refs', async () => {
    const before = await run(human, OWN_NAMES)
    const text = await run(human, 'await react.tree()')
    expect(text).toMatch(/REACT TREE {2}1 root in http:\/\/127\.0\.0\.1:\d+\/ — \d+ components/)
    expect(text).not.toContain('production build')
    const hubBuy = refOf(observed, /button "Buy USB-C Hub/)
    const mouseBuy = refOf(observed, /button "Buy Wireless Mouse/)
    expect(text).toMatch(new RegExp(`\\n {2}App {2}\\S*App\\.tsx:${lineOf('render(<App />)')} → contains \\[${hubBuy}\\] button "Buy USB-C Hub for \\$45"`))
    // ProductList's first control is App's too: nothing new to say there.
    expect(text).toMatch(new RegExp(`\\n {4}ProductList \\{products: \\[2 items\\], onBuy: ƒ[^}]*\\} {2}\\S*App\\.tsx:${lineOf('<ProductList')}\\n`))
    expect(text).toMatch(new RegExp(`\\n {6}ProductCard key="hub" \\{name: "USB-C Hub", price: 45, onBuy: ƒ[^}]*\\} {2}\\S*App\\.tsx:${lineOf('<ProductCard key')}\\n`))
    expect(text).toMatch(new RegExp(`\\n {6}ProductCard key="mouse" \\{name: "Wireless Mouse", price: 29, onBuy: ƒ[^}]*\\} {2}\\S*App\\.tsx:\\d+ → contains \\[${mouseBuy}\\] button "Buy Wireless Mouse for \\$29"`))
    expect(text).toMatch(/ProductCard key="mouse" \{name: "Wireless Mouse", price: 29/)
    expect(text).toMatch(/\n {4}Suspense \(SUSPENDED: showing its fallback\) \{fallback: <Spinner>\}/)
    expect(text).toMatch(/\n {6}Spinner /)
    expect(text).toMatch(/\n {4}Suspense \(resolved\) \{fallback: <Spinner>\}/)
    expect(await run(human, OWN_NAMES)).toBe(before)
    // Reading the fibers is no user gesture: the page still counts as never clicked.
    expect(await run(human, 'return await readPage(() => navigator.userActivation.hasBeenActive)')).toContain('[return value] false')
  }, 60000)

  it('scopes the tree to the component that rendered a ref', async () => {
    const buy = refOf(observed, /button "Buy Wireless Mouse/)
    const text = await run(human, `await react.tree({ ref: ${buy} })`)
    expect(text).toMatch(new RegExp(`REACT TREE {2}the component that rendered \\[${buy}\\] \\(inside App › ProductList\\) — 1 component`))
    expect(text).toMatch(/\n {2}ProductCard key="mouse"/)
    expect(text).not.toContain('USB-C Hub')
  }, 60000)

  it('lists the Suspense boundaries and whether each is suspended, then sees one resolve', async () => {
    const text = await run(human, 'await react.suspense()')
    expect(text).toContain('REACT SUSPENSE  2 boundaries in 1 root — 1 not showing their content')
    expect(text).toMatch(new RegExp(`Suspense in App — SUSPENDED: showing its fallback <Spinner> {2}\\S*App\\.tsx:${lineOf('<Suspense fallback')}`))
    expect(text).toMatch(/Suspense in App — resolved: showing its content \(fallback <Spinner>\)/)
    await run(human, `await act.click(${refOf(observed, /button "Load details"/)})`)
    const after = await run(human, 'await react.suspense()')
    expect(after).toContain('REACT SUSPENSE  2 boundaries in 1 root — 0 not showing their content')
  }, 60000)

  it('says when a page has no React root, or a ref no fiber', async () => {
    const plain = await open('human', '/plain')
    const text = await run(plain, 'await react.tree()')
    expect(text).toContain("REACT   no React root in")
    const button = refOf(await run(plain, 'await observe()'), /button "Plain button"/)
    expect(await run(plain, `await react.tree({ ref: ${button} })`)).toContain(`REACT   [${button}] was not rendered by React`)
    const suspense = await run(plain, 'await react.suspense()')
    expect(suspense).toContain('REACT   no React root in')
  }, 60000)

  it('refuses unknown options', async () => {
    const result = await human.execute('await react.tree({ maxDepth: 3 })', 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('react.tree does not take `maxDepth`; its options are { ref, depth, page }')
  }, 60000)
})

describe('debug mode', () => {
  it('reads the same tree', async () => {
    const debug = await open('debug', '/')
    const text = await run(debug, 'await react.tree({ depth: 1 })')
    expect(text).toMatch(/REACT TREE {2}1 root .* — \d+ components/)
    expect(text).toMatch(/\n {2}App /)
    expect(text).toMatch(/\(\+\d+ components deeper than level 1/)
  }, 60000)
})
