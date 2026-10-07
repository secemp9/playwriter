/**
 * cookies() / storage() / saveState() / loadState() / setCookies() / clearCookies() / setStorage() /
 * clearStorage() / clipboard.read() in a headless browser playwriter launched, through execute(),
 * in human and debug mode. Every assertion is on what the model reads, plus what the page could
 * observe of the reads (user activation, the clipboard-read permission, focus).
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

let server: http.Server
let port = 0
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const file = path.join(LAB, path.normalize(url.pathname).replace(/^\/+/, ''))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8',
    }
    // A server session cookie the page's script cannot see, and one scoped to a path the page is not on.
    if (url.pathname === '/storage.html' || url.pathname === '/storage-frames.html') {
      headers['Set-Cookie'] = ['sid=secret-session-id; Path=/; HttpOnly; SameSite=Lax', 'adminpref=wide; Path=/admin']
    }
    res.writeHead(200, headers)
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'page-storage-'))
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

async function open(policy: 'human' | 'debug', at: string): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await page.goto('http://127.0.0.1:${port}/${at}', { waitUntil: 'load' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

async function run(executor: PlaywrightExecutor, code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

async function fails(executor: PlaywrightExecutor, code: string): Promise<string> {
  const result = await executor.execute(code, 30000)
  expect(result.isError, result.text).toBe(true)
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

describe('reads in human mode', () => {
  it('cookies() lists httpOnly cookies with their attributes, values hidden unless asked', async () => {
    const human = await open('human', 'storage.html')
    const seen = await run(human, 'console.log(await observe())')
    await run(human, `await act.click(${refOf(seen, /button "Set cookie"/)})`)
    const listed = await run(human, 'return await cookies()')
    expect(listed).toContain("name: 'sid'")
    expect(listed).toContain("value: '<17 chars>'")
    expect(listed).toContain('httpOnly: true')
    expect(listed).toContain("name: 'theme'")
    expect(listed).toContain("sameSite: 'Lax'")
    expect(listed).toContain("expires: 'session'")
    expect(listed).not.toContain('secret-session-id')
    // Network.getCookies gives what this URL sends: the /admin cookie is not among them.
    expect(listed).not.toContain('adminpref')
    const values = await run(human, 'return await cookies({ values: true })')
    expect(values).toContain("value: 'secret-session-id'")
    const admin = await run(human, `return await cookies({ urls: ['http://127.0.0.1:${port}/admin/x'] })`)
    expect(admin).toContain("name: 'adminpref'")
    const wrong = await fails(human, "return await cookies({ url: 'x' })")
    expect(wrong).toContain("cookies: unknown option 'url'")
  }, 60000)

  it('storage() reads localStorage and sessionStorage through the isolated world, without activating the page', async () => {
    const human = await open('human', 'storage.html')
    const seen = await run(human, 'console.log(await observe())')
    await run(human, `await act.click(${refOf(seen, /button "Set localStorage"/)})`)
    await run(human, `await act.click(${refOf(seen, /button "Set sessionStorage"/)})`)
    const both = await run(human, 'return await storage()')
    expect(both).toContain(`origin: 'http://127.0.0.1:${port}'`)
    expect(both).toContain("local: { 'lab-pref': 'compact' }")
    expect(both).toContain("session: { 'lab-step': '2' }")
    const local = await run(human, "return await storage('local')")
    expect(local).toContain("local: { 'lab-pref': 'compact' }")
    expect(local).not.toContain('session:')
    const wrong = await fails(human, "return await storage('cookies')")
    expect(wrong).toContain("must be 'local' (localStorage) or 'session' (sessionStorage)")
  }, 60000)

  it('the reads leave a fresh page unactivated', async () => {
    const human = await open('human', 'storage-frames.html')
    await run(human, `await cookies(); await storage(); await saveState({ path: '${path.join(cwd, 'fresh.json')}' })`)
    const activation = await run(human, 'return await readPage(() => navigator.userActivation.hasBeenActive)')
    expect(activation).toContain('false')
  }, 60000)

  it('storage({ frame }) reads an iframe, and saveState keeps first-party storage and every path of the page’s cookies', async () => {
    const human = await open('human', `storage-frames.html?cross=http://localhost:${port}`)
    const same = await run(human, "return await storage('local', { frame: 'who=same' })")
    expect(same).toContain("'inner-same': 'same-value'")
    expect(same).toContain("'top-key': 'top-value'")
    // Third-party storage partitioning is on (as in a user's Chrome): the cross-site iframe's storage is kept under
    // the top-level site. storage() reads what the frame sees; saveState leaves it out (one storage per origin).
    const cross = await run(human, "return await storage('local', { frame: 'who=cross' })")
    expect(cross).toContain(`origin: 'http://localhost:${port}'`)
    expect(cross).toContain("'inner-cross': 'cross-value'")
    const sandboxed = await fails(human, "return await storage('local', { frame: 'sandboxed-frame' })")
    expect(sandboxed).toContain(`localStorage of http://127.0.0.1:${port}/storage-frame-inner.html?who=sandboxed cannot be used`)
    expect(sandboxed).toContain('the document has an opaque origin (a sandboxed iframe or a data: URL), which has no Web Storage')
    const ambiguous = await fails(human, "return await storage('local', { frame: 'storage-frame-inner' })")
    expect(ambiguous).toContain('matches 3 frames')
    const missing = await fails(human, "return await storage('local', { frame: 'nowhere' })")
    expect(missing).toContain("no frame of this tab matches { frame: 'nowhere' }")

    const file = path.join(cwd, 'frames-state.json')
    const saved = await run(human, `return await saveState({ path: '${file}' })`)
    expect(saved).toContain('adminpref (127.0.0.1 path /admin)')
    expect(saved).toContain(`http://127.0.0.1:${port}: 2 localStorage key(s)`)
    expect(saved).toMatch(/localStorage of http:\/\/localhost:\d+\/storage-frame-inner\.html\?who=cross: it is partitioned \(storage key http:\/\/localhost:\d+\/\^0http:\/\/127\.0\.0\.1/)
    const state: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(state).toMatchObject({
      cookies: expect.arrayContaining([
        expect.objectContaining({ name: 'sid', value: 'secret-session-id', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax', expires: -1 }),
        expect.objectContaining({ name: 'adminpref', path: '/admin', sameSite: 'Lax' }),
      ]),
      origins: [{ origin: `http://127.0.0.1:${port}`, localStorage: expect.arrayContaining([{ name: 'top-key', value: 'top-value' }, { name: 'inner-same', value: 'same-value' }]) }],
    })
    const outside = await fails(human, "return await saveState({ path: '/etc/playwriter-state.json' })")
    expect(outside).toContain('is outside the directories the sandbox may write')
  }, 60000)

  it('storage() refuses while a JS dialog freezes the page; cookies() still answers', async () => {
    const human = await open('human', 'dialogs.html')
    const seen = await run(human, 'console.log(await observe())')
    await run(human, `await act.click(${refOf(seen, /button "Ask confirm"/)})`)
    const frozen = await fails(human, 'return await storage()')
    expect(frozen).toContain('a confirm dialog ("Discard draft?") is open on this tab')
    expect(frozen).toContain('act.dialog.accept() or act.dialog.dismiss()')
    await run(human, 'return await cookies()')
  }, 60000)
})

describe('writes are debug-only', () => {
  it('human mode refuses every write before anything runs', async () => {
    const human = await open('human', 'storage.html')
    for (const [code, api] of [
      ["await setCookies('a=b')", 'setCookies'],
      ['await clearCookies()', 'clearCookies'],
      ["await setStorage('local', { a: 'b' })", 'setStorage'],
      ["await clearStorage('local')", 'clearStorage'],
      ["await loadState('state.json')", 'loadState'],
    ]) {
      const refused = await fails(human, code)
      expect(refused).toContain(`Refused (human mode): forced state — ${api} on line 1`)
      expect(refused).toContain('Nothing from this call was run.')
    }
  }, 60000)

  it('human mode refuses a write the static policy cannot see, when it is called', async () => {
    const human = await open('human', 'storage.html')
    const refused = await fails(human, "const api = { write: globalThis[['set', 'Cookies'].join('')] }\nawait api.write('a=b')")
    expect(refused).toContain('Refused (human mode): setCookies() writes cookies directly: forged state the page never made')
    expect(refused).toContain('It was not run.')
    expect(await run(human, 'return await cookies()')).not.toContain("name: 'a'")
  }, 60000)

  it('debug mode writes and clears cookies and Web Storage, and says which cookie Chrome refused', async () => {
    const debug = await open('debug', 'storage.html')
    const set = await run(debug, "return await setCookies('alpha=1; beta=two')")
    expect(set).toContain(`alpha (http://127.0.0.1:${port}/storage.html)`)
    const listed = await run(debug, 'return await cookies({ values: true })')
    expect(listed).toMatch(/name: 'alpha',\s+value: '1'/)
    expect(listed).toMatch(/name: 'beta',\s+value: 'two'/)
    const refused = await fails(debug, "return await setCookies([{ name: 'loose', value: 'x', sameSite: 'None' }])")
    expect(refused).toContain('setCookies: Chrome did not store loose')
    const cleared = await run(debug, "return await clearCookies({ names: ['alpha', 'nope'] })")
    expect(cleared).toContain('alpha (127.0.0.1 path /)')
    expect(cleared).toContain('nope: this page sends no cookie of that name')
    expect(await run(debug, 'return await cookies()')).not.toContain("name: 'alpha'")

    const stored = await run(debug, "return await setStorage('local', { theme: 'dark', size: 'xl' })")
    expect(stored).toContain("local: { size: 'xl', theme: 'dark' }")
    await run(debug, "await setStorage({ kind: 'session', entries: { step: '3' } })")
    expect(await run(debug, "return await storage('session')")).toContain("step: '3'")
    expect(await run(debug, "return await clearStorage('session')")).toContain('session: {}')
    const badEntries = await fails(debug, "return await setStorage('local', { n: 1 })")
    expect(badEntries).toContain('setStorage:')
  }, 60000)

  it('debug mode: loadState restores what saveState saved, and names the origins this tab cannot take', async () => {
    const debug = await open('debug', 'storage-frames.html')
    const file = path.join(cwd, 'roundtrip.json')
    await run(debug, `await saveState('${file}')`)
    await run(debug, "await clearCookies(); await clearStorage('local')")
    expect(await run(debug, 'return await cookies()')).not.toContain("name: 'sid'")
    const loaded = await run(debug, `return await loadState('${file}')`)
    expect(loaded).toContain('sid (127.0.0.1 path /)')
    expect(loaded).toContain(`http://127.0.0.1:${port}: 2 localStorage key(s)`)
    expect(await run(debug, 'return await cookies({ values: true })')).toContain("value: 'secret-session-id'")
    expect(await run(debug, "return await storage('local')")).toContain("'top-key': 'top-value'")

    fs.writeFileSync(path.join(cwd, 'other.json'), JSON.stringify({ cookies: [], origins: [{ origin: 'https://elsewhere.example', localStorage: [{ name: 'k', value: 'v' }] }] }))
    const other = await run(debug, `return await loadState('${path.join(cwd, 'other.json')}')`)
    expect(other).toContain('https://elsewhere.example: no frame of this tab shows that origin with first-party storage')
    fs.writeFileSync(path.join(cwd, 'broken.json'), JSON.stringify({ cookies: [{ name: 'x' }], origins: [] }))
    const broken = await fails(debug, `return await loadState('${path.join(cwd, 'broken.json')}')`)
    expect(broken).toContain("The file must be Playwright's storage-state format")
  }, 60000)
})

describe('clipboard.read()', () => {
  it('returns what the page copied, through a private context the page cannot observe', async () => {
    const human = await open('human', 'clipboard-watch.html')
    const seen = await run(human, 'console.log(await observe())')
    const copied = await run(human, `await act.click(${refOf(seen, /button "Copy command"/)})`)
    expect(copied).toContain('Copied')
    const read = await run(human, 'return await clipboard.read()')
    expect(read).toContain('git clone https://example.com/lab.git')
    // playwriter's own reader page is not one of the code's actions, and not a tab of the session.
    expect(read).not.toContain('playwriter-clipboard')
    expect(read).not.toMatch(/ACTION|TAB /)
    const log = await run(human, "return await readPage(() => [...document.querySelectorAll('#log li')].map((li) => li.textContent))")
    expect(log).toContain('permission prompt')
    expect(log).not.toContain('permission changed')
    expect(log).not.toContain('blur')
    expect(log).not.toContain('visibility')
  }, 60000)

  it('is a read in human mode for the static policy too', async () => {
    const human = await open('human', 'clipboard-watch.html')
    const text = await run(human, 'const text = await clipboard.read()\nreturn typeof text')
    expect(text).toContain('string')
  }, 60000)

  it('reads the same way in debug mode', async () => {
    const debug = await open('debug', 'clipboard-watch.html')
    const seen = await run(debug, 'console.log(await observe())')
    await run(debug, `await act.click(${refOf(seen, /button "Copy command"/)})`)
    expect(await run(debug, 'return await clipboard.read()')).toContain('git clone https://example.com/lab.git')
  }, 60000)
})
