/**
 * The journal end to end through the real executor in human mode, at two edges.
 *
 * Early requests of a new out-of-process iframe: the page (served as `localhost`) inserts an iframe
 * from `127.0.0.1` — another site, so its own renderer process and CDP session — whose script POSTs
 * the moment its document runs, before anything outside Playwright's server could subscribe to that
 * session.
 *
 * Requests of dedicated workers: a page whose button posts a message to its worker; the worker
 * POSTs (slowly) and hands on to a worker it started, which POSTs too. Chrome reports a worker's
 * requests on the worker's own session only.
 *
 * A browser whose clock is minutes off: a cloud browser or a remote relay runs Chrome on another
 * machine. Here Chrome runs on this one, so the skew is made on this process's side: `Date.now()` of
 * the test process — the clock every checkpoint, input end, event arrival and act record of the
 * executor is stamped with — is shifted by minutes, while Chrome stamps with the real clock. Every
 * comparison between the two clocks then meets exactly what it meets against a remote browser.
 *
 * Every assertion is on what the model reads: the action report, `net.requests()`, the repeat refusal.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const CHAT_PAGE = (crossOrigin: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Help</title></head>
<body><main><h1>Help center</h1><button id="open">Open chat</button><div id="slot"></div></main>
<script>document.getElementById('open').addEventListener('click', () => {
  const frame = document.createElement('iframe')
  frame.title = 'Support chat'
  frame.src = '${crossOrigin}/widget'
  frame.style.cssText = 'width: 400px; height: 120px'
  document.getElementById('slot').replaceChildren(frame)
})</script></body></html>`

/** Starts a chat session the moment it runs: the POST leaves within the iframe renderer's first milliseconds. */
const WIDGET = `<!doctype html><html><head><meta charset="utf-8"><title>Chat</title></head>
<body><p id="state">Connecting…</p>
<script>fetch('/api/session', { method: 'POST', body: 'start' }).then(() => { document.getElementById('state').textContent = 'Chat ready' })</script>
</body></html>`

/**
 * A status region, a button that announces "Draft restored" there (the action before), a Send
 * button whose POST takes 300ms and announces "Message sent", and a button whose click opens a file
 * dialog 1.2s later (its activation still lets it).
 */
const INBOX = `<!doctype html><html><head><meta charset="utf-8"><title>Inbox</title></head>
<body><main><h1>Inbox</h1><div role="status" id="status"></div>
<button id="restore">Restore draft</button> <button id="send">Send</button> <button id="attach">Attach later</button>
<input id="file" type="file" hidden></main>
<script>
  document.getElementById('restore').addEventListener('click', () => {
    document.getElementById('status').textContent = 'Draft restored'
  })
  document.getElementById('send').addEventListener('click', () => {
    fetch('/api/send', { method: 'POST', body: 'hello' }).then((response) => response.json()).then(() => {
      document.getElementById('status').textContent = 'Message sent'
    })
  })
  document.getElementById('attach').addEventListener('click', () => {
    setTimeout(() => document.getElementById('file').click(), 1200)
  })
</script></body></html>`

/** A page whose "Sync drafts" button asks its worker to sync; the worker's nested worker answers "Synced" at the end. */
const SYNC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Drafts</title></head>
<body><main><h1>Drafts</h1><p role="status" id="status"></p><button id="sync">Sync drafts</button></main>
<script>
  const worker = new Worker('/sync-worker.js')
  worker.onmessage = (event) => { document.getElementById('status').textContent = event.data }
  document.getElementById('sync').addEventListener('click', () => worker.postMessage('sync'))
</script></body></html>`

const SYNC_WORKER = `const audit = new Worker('/audit-worker.js')
audit.onmessage = (event) => postMessage(event.data)
onmessage = () => {
  fetch('/api/sync', { method: 'POST', body: 'drafts' }).then(() => audit.postMessage('audit'))
}`

const AUDIT_WORKER = `onmessage = () => {
  fetch('/api/audit', { method: 'POST', body: 'sync done' }).then(() => postMessage('Synced'))
}`

/** A page whose "Import" button hands a file to its parser worker, which logs an error and then throws. */
const IMPORT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Import</title></head>
<body><main><h1>Import</h1><button id="import">Import</button></main>
<script>
  const parser = new Worker('/parse-worker.js')
  document.getElementById('import').addEventListener('click', () => parser.postMessage('rows.csv'))
</script></body></html>`

const PARSE_WORKER = `onmessage = (event) => {
  console.error('parser worker: bad row 7 in ' + event.data)
  throw new Error('parser worker crashed on row 7')
}`

/**
 * A release page whose "zip" link redirects to another origin that answers with an attachment: the
 * navigation becomes a download. Like GitHub's, the page first tries the link with fetch(), which its
 * Content Security Policy refuses at the cross-origin redirect, and then navigates to it.
 */
const TAGS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="connect-src 'self'"><title>Tags</title></head>
<body><main><h1>Tags</h1><p>3.0.1 <a id="zip" href="/archive.zip">zip</a></p></main>
<script>document.getElementById('zip').addEventListener('click', (event) => {
  event.preventDefault()
  fetch(event.currentTarget.href).catch(() => { location.href = '/archive.zip' })
})</script></body></html>`

let server: http.Server
let port = 0
let cwd = ''
const sessions: string[] = []
const sent: string[] = []
const synced: string[] = []
const audited: string[] = []
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    const html = (body: string): void => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
    }
    const json = (log: string[], answer: string, delayMs: number): void => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString()))
      req.on('end', () => {
        log.push(body)
        // A real timer: the response has to stay open while the page waits for it, in Chrome's time.
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(answer)
        }, delayMs)
      })
    }
    if (url.pathname === '/api/session' && req.method === 'POST') return json(sessions, '{"session":"s1"}', 0)
    if (url.pathname === '/api/send' && req.method === 'POST') return json(sent, '{"ok":true}', 300)
    if (url.pathname === '/') return html(CHAT_PAGE(`http://127.0.0.1:${port}`))
    if (url.pathname === '/widget') return html(WIDGET)
    if (url.pathname === '/inbox') return html(INBOX)
    // The worker's POST takes 600ms: longer than the quiet windows, so only a settle that sees it waits for it.
    if (url.pathname === '/api/sync' && req.method === 'POST') return json(synced, '{"ok":true}', 600)
    if (url.pathname === '/api/audit' && req.method === 'POST') return json(audited, '{"ok":true}', 0)
    if (url.pathname === '/drafts') return html(SYNC_PAGE)
    if (url.pathname === '/import') return html(IMPORT_PAGE)
    if (url.pathname === '/tags') return html(TAGS_PAGE)
    // GitHub's shape: the archive link answers 302 to another origin, which answers with an attachment.
    if (url.pathname === '/archive.zip') {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/codeload/archive.zip` })
      res.end()
      return
    }
    if (url.pathname === '/codeload/archive.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="is-odd-3.0.1.zip"' })
      res.end('PK fake zip')
      return
    }
    const scripts: Record<string, string> = { '/sync-worker.js': SYNC_WORKER, '/audit-worker.js': AUDIT_WORKER, '/parse-worker.js': PARSE_WORKER }
    if (scripts[url.pathname] !== undefined) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(scripts[url.pathname])
      return
    }
    res.writeHead(404)
    res.end()
  })
  // Every interface: the page is loaded as `localhost`, its chat iframe as `127.0.0.1`.
  const listening = Promise.withResolvers<void>()
  server.listen(0, () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  port = address.port
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-clock-'))
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

function newExecutor(): PlaywrightExecutor {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
  executors.push(executor)
  return executor
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

/** The POST records `net.requests()` gives the model. */
async function postsOf(executor: PlaywrightExecutor): Promise<Array<{ url: string; frame?: string; worker?: string; status?: number; startedAt: number }>> {
  const journal = await executor.execute(`return JSON.stringify(await net.requests({ method: 'POST' }))`, 30000)
  expect(journal.isError, journal.text).toBe(false)
  return JSON.parse(journal.text.replace(/^\[return value\] /, ''))
}

/** Let `ms` pass in Chrome: the page's own timers have to run. */
async function realDelay(ms: number): Promise<void> {
  const elapsed = Promise.withResolvers<void>()
  setTimeout(() => elapsed.resolve(), ms)
  await elapsed.promise
}

describe('requests of a new out-of-process iframe', () => {
  it('journals the POST its script sends at startup, names the iframe, and refuses to send it again', async () => {
    const executor = newExecutor()
    const loaded = await executor.execute(`await page.goto('http://localhost:${port}/', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)
    const open = refOf(look.text, /button "Open chat"/)

    const clicked = await executor.execute(`await act.click(${open})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/Chat ready/)
    expect(sessions).toEqual(['start'])

    expect(await postsOf(executor)).toEqual([
      expect.objectContaining({ url: `http://127.0.0.1:${port}/api/session`, frame: `http://127.0.0.1:${port}/widget`, status: 200 }),
    ])

    // The click sent a data-changing request (through the iframe it opened): doing it again would send it again.
    const again = await executor.execute(`await act.click(${open})`, 30000)
    expect(again.isError).toBe(true)
    expect(again.text).toMatch(/sent POST \/api\/session — requests that change data/)
    expect(sessions).toHaveLength(1)
  })

  it('settles once the iframe document has loaded, and journals that document as finished', async () => {
    const executor = newExecutor()
    const loaded = await executor.execute(`await page.goto('http://localhost:${port}/', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)

    const clicked = await executor.execute(`await act.click(${refOf(look.text, /button "Open chat"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/^SETTLED \d+ms/m)
    expect(clicked.text).not.toMatch(/runner|\/widget \(/)

    const journal = await executor.execute(`return JSON.stringify(await net.requests({ urlIncludes: '/widget' }))`, 30000)
    expect(journal.isError, journal.text).toBe(false)
    const documents: Array<{ id: string; url: string; resourceType?: string; status?: number; frame?: string; endedAt?: number }> = JSON.parse(
      journal.text.replace(/^\[return value\] /, ''),
    )
    expect(documents).toEqual([
      expect.objectContaining({ url: `http://127.0.0.1:${port}/widget`, resourceType: 'Document', status: 200, frame: `http://127.0.0.1:${port}/widget`, endedAt: expect.any(Number) }),
    ])
    const body = await executor.execute(`return (await net.request('${documents[0]!.id}')).body`, 30000)
    expect(body.isError, body.text).toBe(false)
    expect(body.text).toContain('Connecting…')
  })
})

describe('a navigation that becomes a download', () => {
  it('settles on it, reports the download, and journals every hop as ended — the navigation as the download, not as a failure', async () => {
    const executor = newExecutor()
    const loaded = await executor.execute(`await page.goto('http://localhost:${port}/tags', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)

    const clicked = await executor.execute(`await act.click(${refOf(look.text, /link "zip"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/^SETTLED \d+ms/m)
    expect(clicked.text).toMatch(/^DOWNLOAD \[d1\] is-odd-3\.0\.1\.zip from http:\/\/127\.0\.0\.1:\d+\/codeload\/archive\.zip — completed/m)
    // The one real failure: the page's own fetch, refused by its CSP at the redirect. Not the navigation that became the download.
    expect(clicked.text).toMatch(/^ERRORS {2}request failed GET \/codeload\/archive\.zip: blocked: csp \(r\d+\)$/m)
    expect(clicked.text).not.toMatch(/canceled|undefined/)

    const journal = await executor.execute(`return JSON.stringify(await net.requests({ urlIncludes: 'archive.zip' }))`, 30000)
    expect(journal.isError, journal.text).toBe(false)
    const hops: Array<{ url: string; resourceType?: string; status?: number; failed?: string; download?: string; endedAt?: number; redirectedFrom?: string }> = JSON.parse(
      journal.text.replace(/^\[return value\] /, ''),
    )
    const origin = `http://localhost:${port}`
    const other = `http://127.0.0.1:${port}`
    expect(hops.map(({ url, resourceType, status, failed, download, endedAt, redirectedFrom }) => ({ url, resourceType, status, failed, download, ended: endedAt !== undefined, hop: redirectedFrom !== undefined }))).toEqual([
      // The page's fetch: Chrome moved it on without reporting the redirect response, then the CSP refused it.
      { url: `${origin}/archive.zip`, resourceType: 'Fetch', status: undefined, failed: undefined, download: undefined, ended: true, hop: false },
      { url: `${other}/codeload/archive.zip`, resourceType: 'Fetch', status: undefined, failed: 'blocked: csp', download: undefined, ended: true, hop: true },
      // The navigation: answered 302, then the attachment that became the download.
      { url: `${origin}/archive.zip`, resourceType: 'Document', status: 302, failed: undefined, download: undefined, ended: true, hop: false },
      { url: `${other}/codeload/archive.zip`, resourceType: 'Document', status: 200, failed: undefined, download: 'is-odd-3.0.1.zip', ended: true, hop: true },
    ])
  })
})

describe('requests of dedicated workers', () => {
  it('settles on the POSTs a click makes a worker and its nested worker send, names each worker, and refuses to send them again', async () => {
    const executor = newExecutor()
    const loaded = await executor.execute(`await page.goto('http://localhost:${port}/drafts', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)
    const sync = refOf(look.text, /button "Sync drafts"/)

    const clicked = await executor.execute(`await act.click(${sync})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    // Settled only after the worker's 600ms POST and the nested worker's POST that follows it.
    const settledMs = Number(/SETTLED (\d+)ms/.exec(clicked.text)?.[1])
    expect(settledMs, clicked.text).toBeGreaterThanOrEqual(600)
    expect(clicked.text).toMatch(/LIVE {4}status "Synced"/)
    expect(synced).toEqual(['drafts'])
    expect(audited).toEqual(['sync done'])

    expect(await postsOf(executor)).toEqual([
      expect.objectContaining({ url: `http://localhost:${port}/api/sync`, worker: `http://localhost:${port}/sync-worker.js`, status: 200 }),
      expect.objectContaining({ url: `http://localhost:${port}/api/audit`, worker: `http://localhost:${port}/audit-worker.js`, status: 200 }),
    ])

    const again = await executor.execute(`await act.click(${sync})`, 30000)
    expect(again.isError).toBe(true)
    expect(again.text).toMatch(/sent POST \/api\/sync, POST \/api\/audit — requests that change data/)
    expect(synced).toHaveLength(1)
  })

  it("reports the error a worker logs and the exception it throws after a click, at the worker's script, and getLatestLogs has both", async () => {
    const executor = newExecutor()
    const loaded = await executor.execute(`await page.goto('http://localhost:${port}/import', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)

    const clicked = await executor.execute(`await act.click(${refOf(look.text, /button "Import"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    const worker = `http://localhost:${port}/parse-worker.js`
    expect(clicked.text).toContain(`ERRORS  console.error: parser worker: bad row 7 in rows.csv (${worker}:2:11)\n        uncaught: Uncaught Error: parser worker crashed on row 7 (${worker}:3:9)`)

    // A search returns its matches with the lines around them (here the favicon's 404).
    const logs = await executor.execute('return JSON.stringify(await getLatestLogs({ search: /parser worker/ }))', 30000)
    expect(logs.isError, logs.text).toBe(false)
    // Each entry keeps where it was logged on its following lines; an exception keeps its stack frames.
    expect(JSON.parse(logs.text.replace(/^\[return value\] /, ''))).toEqual(
      expect.arrayContaining([
        `[error] parser worker: bad row 7 in rows.csv\n    at http://localhost:${port}/parse-worker.js:2:11`,
        expect.stringMatching(new RegExp(`^\\[pageerror\\] parser worker crashed on row 7\\n    at .*parse-worker\\.js:3:\\d+`)),
      ]),
    )
  })
})

describe.each([
  { label: '5 minutes behind', processAheadMs: 5 * 60_000 },
  { label: '5 minutes ahead of', processAheadMs: -5 * 60_000 },
])("a browser whose clock is $label this process's", ({ processAheadMs }) => {
  const realNow = Date.now.bind(Date)
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + processAheadMs)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('settles on the action’s own request, reports only what it announced, times the request and the late file dialog right, and refuses the repeat', async () => {
    sent.length = 0
    const executor = newExecutor()
    const loaded = await executor.execute(`await page.goto('http://localhost:${port}/inbox', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const look = await executor.execute('await observe()', 30000)
    expect(look.isError, look.text).toBe(false)

    const restored = await executor.execute(`await act.click(${refOf(look.text, /button "Restore draft"/)})`, 30000)
    expect(restored.isError, restored.text).toBe(false)
    expect(restored.text).toMatch(/LIVE {4}status "Draft restored"/)

    const send = refOf(look.text, /button "Send"/)
    const clickedAt = Date.now()
    const clicked = await executor.execute(`await act.click(${send})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    // Quiet once the POST answered (300ms) and the page announced it.
    const settledMs = Number(/SETTLED (\d+)ms/.exec(clicked.text)?.[1])
    expect(settledMs, clicked.text).toBeGreaterThanOrEqual(300)
    expect(settledMs, clicked.text).toBeLessThan(3000)
    expect(clicked.text).toMatch(/LIVE {4}status "Message sent"/)
    // Announced by the action before: not this one's (the diff still says the text was replaced).
    expect(clicked.text).not.toMatch(/LIVE .*Draft restored/)
    expect(sent).toEqual(['hello'])

    // Its start, on this process's clock: issued after the click began, before the report came back.
    const [post] = await postsOf(executor)
    expect(post).toMatchObject({ url: `http://localhost:${port}/api/send`, status: 200 })
    expect(post!.startedAt).toBeGreaterThanOrEqual(clickedAt)
    expect(post!.startedAt).toBeLessThanOrEqual(Date.now())

    const again = await executor.execute(`await act.click(${send})`, 30000)
    expect(again.isError).toBe(true)
    expect(again.text).toMatch(/sent POST \/api\/send — requests that change data/)
    expect(sent).toHaveLength(1)

    const attach = refOf(look.text, /button "Attach later"/)
    const attached = await executor.execute(`await act.click(${attach})`, 30000)
    expect(attached.isError, attached.text).toBe(false)
    expect(attached.text).not.toMatch(/FILE DIALOG/)
    // Chrome's own timer opens the dialog 1.2s after the click, between this call and the next; nothing
    // in this process can advance it.
    await realDelay(2000)
    const waited = await executor.execute('await act.wait(100)', 30000)
    expect(waited.isError, waited.text).toBe(false)
    const late = /FILE DIALOG OPEN, opened by your click \[\d+\] button "Attach later", (\d+\.\d)s after that action ended/.exec(waited.text)
    expect(late, waited.text).not.toBeNull()
    expect(Number(late![1])).toBeGreaterThanOrEqual(0.9)
    expect(Number(late![1])).toBeLessThanOrEqual(1.6)
    const dismissed = await executor.execute('await act.dialog.dismiss()', 30000)
    expect(dismissed.isError, dismissed.text).toBe(false)
  })
})
