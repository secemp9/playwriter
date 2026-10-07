/**
 * Live-Chromium tests for DialogController together with PageWatch.
 *
 * Consumer-visible claims:
 *  - a confirm stays open (Playwright no longer silently dismisses it), PageWatch.settle
 *    says `js-dialog` immediately instead of probing the frozen page, and the page receives
 *    the agent's answer once accept() is called;
 *  - a beforeunload ("Leave site?") stays open too, holding the navigation, until the agent
 *    dismisses it (the page stays) or accepts it (the navigation goes ahead);
 *  - an alert is acknowledged automatically and recorded as auto-accepted;
 *  - a dialog answered by other code is recorded as closed (with the button CDP reports)
 *    without any error escaping the listener;
 *  - switching the policy answers a dialog that is waiting.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import { DialogController } from './dialog-controller.js'
import { PageFrames } from './page-frames.js'
import { PageWatch } from './page-watch.js'

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>dialogs</title></head>
<body><h1>Thread</h1><p id="state">idle</p></body></html>`

/** A page with unsaved work: it asks before being left, as editors do. */
const UNSAVED_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>draft</title></head>
<body><h1>Draft</h1><script>addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = '' })</script></body></html>`

let browser: Browser
let context: BrowserContext
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(req.url === '/unsaved' ? UNSAVED_HTML : FIXTURE_HTML)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext()
}, 120000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
  await new Promise<void>((r) => server?.close(() => r()))
})

async function open(path = '/', { bind = true }: { bind?: boolean } = {}): Promise<{ page: Page; dialogs: DialogController; watch: PageWatch }> {
  const page = await context.newPage()
  const cdp = await getCDPSessionForPage({ page })
  const dialogs = new DialogController({ page })
  dialogs.attach()
  if (bind) dialogs.bindSession(cdp)
  await page.goto(baseUrl + path)
  const watch = new PageWatch({ frames: new PageFrames({ page, cdp }), dialogs, isClosed: () => page.isClosed() })
  watch.start()
  await watch.settle()
  return { page, dialogs, watch }
}

/**
 * Open a dialog from page code. The page script defers with setTimeout(0) because a dialog
 * blocks the script that opens it: called directly, page.evaluate itself would not return
 * until the dialog closed.
 */
async function openDialog(page: Page, script: string): Promise<void> {
  const opened = page.waitForEvent('dialog')
  await page.evaluate(`setTimeout(function () { ${script} }, 0)`)
  await opened
}

describe('confirm and prompt wait for the agent', () => {
  it('a confirm stays open, settle reports js-dialog, accept() answers it', async () => {
    const { page, dialogs, watch } = await open()
    await openDialog(page, "window.answer = confirm('Delete this thread?'); document.getElementById('state').textContent = 'answered'")

    expect(dialogs.current()).toMatchObject({ type: 'confirm', message: 'Delete this thread?' })
    const blocked = await watch.settle({ timeoutMs: 5000 })
    expect(blocked).toMatchObject({ settled: false, reason: 'js-dialog', dialog: { type: 'confirm', message: 'Delete this thread?' } })
    expect(blocked.waitedMs).toBeLessThan(100)
    // Still waiting for the agent after the settle.
    expect(dialogs.current()).toMatchObject({ type: 'confirm' })

    const answered = await dialogs.accept()
    expect(answered).toMatchObject({ type: 'confirm', outcome: 'accepted' })
    expect(answered.closedAt).toEqual(expect.any(Number))
    expect(dialogs.current()).toBeNull()
    expect(await page.evaluate('window.answer')).toBe(true)

    const after = await watch.settle()
    expect(after).toMatchObject({ settled: true, reason: 'quiet' })
    expect(await page.textContent('#state')).toBe('answered')
    await page.close()
  })

  it('a prompt receives the typed text; a dismissed confirm returns false', async () => {
    const { page, dialogs } = await open()
    await openDialog(page, "window.name1 = prompt('Thread title?', 'Untitled')")
    expect(dialogs.current()).toMatchObject({ type: 'prompt', defaultValue: 'Untitled' })
    await dialogs.accept('Gaming mice')
    expect(await page.evaluate('window.name1')).toBe('Gaming mice')

    await openDialog(page, "window.answer = confirm('Discard draft?')")
    expect(await dialogs.dismiss()).toMatchObject({ type: 'confirm', outcome: 'dismissed' })
    expect(await page.evaluate('window.answer')).toBe(false)
    expect(dialogs.history().map((d) => [d.type, d.outcome])).toEqual([
      ['prompt', 'accepted'],
      ['confirm', 'dismissed'],
    ])
    await page.close()
  })

  it('switching the policy answers a waiting dialog', async () => {
    const { page, dialogs } = await open()
    await openDialog(page, "window.answer = confirm('Leave the group?')")
    dialogs.setPolicy('accept')
    await expect.poll(() => page.evaluate('window.answer')).toBe(true)
    expect(dialogs.history().at(-1)).toMatchObject({ type: 'confirm', outcome: 'accepted', answeredBy: 'policy' })
    await page.close()
  })
})

describe('beforeunload waits for the agent', () => {
  it('"Leave site?" stays open; dismiss keeps the page, accept lets the navigation go ahead', async () => {
    const { page, dialogs } = await open('/unsaved')
    // Chrome shows a beforeunload prompt only after the user has interacted with the page.
    await page.click('h1')

    const firstPrompt = page.waitForEvent('dialog')
    const refused = page.goto(`${baseUrl}/next`).then(
      () => 'navigated',
      (error: Error) => error.message,
    )
    await firstPrompt
    expect(dialogs.current()).toMatchObject({ type: 'beforeunload' })
    // Not answered behind the agent's back: still open after the controller had every chance.
    await page.waitForTimeout(300) // real time on purpose: proves nothing auto-answers it
    expect(dialogs.current()).toMatchObject({ type: 'beforeunload' })
    expect(dialogs.history().at(-1)?.outcome).toBeUndefined()

    expect(await dialogs.dismiss()).toMatchObject({ type: 'beforeunload', outcome: 'dismissed' })
    expect(await refused).not.toBe('navigated')
    expect(page.url()).toBe(`${baseUrl}/unsaved`)

    const secondPrompt = page.waitForEvent('dialog')
    const leaving = page.goto(`${baseUrl}/next`)
    await secondPrompt
    expect(await dialogs.accept()).toMatchObject({ type: 'beforeunload', outcome: 'accepted' })
    await leaving
    expect(page.url()).toBe(`${baseUrl}/next`)
    expect(dialogs.history().map((d) => [d.type, d.outcome])).toEqual([
      ['beforeunload', 'dismissed'],
      ['beforeunload', 'accepted'],
    ])
    await page.close()
  })
})

describe('dialogs nobody has to decide, and dialogs someone else answered', () => {
  it('an alert is acknowledged automatically, reported open while that happens, and recorded as auto-accepted', async () => {
    const { page, dialogs } = await open()
    const changes: Array<{ type: string; handling: string } | null> = []
    dialogs.onChange((state) => changes.push(state && { type: state.type, handling: state.handling }))
    await openDialog(page, "alert('Saved'); window.afterAlert = true")
    await expect.poll(() => page.evaluate('window.afterAlert === true')).toBe(true)
    expect(dialogs.current()).toBeNull()
    expect(changes, 'open (handled automatically), then closed').toEqual([{ type: 'alert', handling: 'auto' }, null])
    expect(dialogs.history()).toEqual([
      expect.objectContaining({ type: 'alert', message: 'Saved', handling: 'auto', outcome: 'auto-accepted' }),
    ])
    await expect(dialogs.accept()).rejects.toThrow('No native dialog is open.')
    await page.close()
  })

  it('a confirm answered in the browser itself is closed at once, with the button Chrome reports', async () => {
    const { page, dialogs } = await open()
    // The person clicking OK in his Chrome: an answer that does not go through Playwright.
    const raw = await context.newCDPSession(page)
    await raw.send('Page.enable')
    await openDialog(page, "window.answer = confirm('Archive?')")
    expect(dialogs.current()).toMatchObject({ type: 'confirm', handling: 'agent' })
    await raw.send('Page.handleJavaScriptDialog', { accept: true })
    await expect.poll(() => dialogs.current()).toBeNull()
    expect(await page.evaluate('window.answer')).toBe(true)
    expect(dialogs.history()).toEqual([expect.objectContaining({ type: 'confirm', outcome: 'accepted' })])
    await expect(dialogs.accept()).rejects.toThrow('No native dialog is open.')
    await page.close()
  })

  it('answering a dialog Chrome no longer shows says it closed elsewhere and clears it', async () => {
    // Unbound: the controller cannot see the browser-side close, so the answer is what finds out.
    const { page, dialogs } = await open('/', { bind: false })
    const raw = await context.newCDPSession(page)
    await raw.send('Page.enable')
    await openDialog(page, "window.answer = confirm('Archive?')")
    await raw.send('Page.handleJavaScriptDialog', { accept: false })
    await expect.poll(() => page.evaluate('window.answer')).toBe(false)
    await expect(dialogs.accept()).rejects.toThrow(/was already closed elsewhere/)
    expect(dialogs.current()).toBeNull()
    await page.close()
  })

  it('a confirm dismissed by other code is recorded with the button CDP reports', async () => {
    const { page, dialogs } = await open()
    page.once('dialog', (dialog) => {
      void dialog.dismiss()
    })
    await openDialog(page, "window.answer = confirm('Archive?')")
    await expect.poll(() => page.evaluate('window.answer')).toBe(false)
    await expect.poll(() => dialogs.current()).toBeNull()
    expect(dialogs.history()).toEqual([expect.objectContaining({ type: 'confirm', message: 'Archive?', outcome: 'dismissed' })])
    await expect(dialogs.accept()).rejects.toThrow('No native dialog is open.')
    await page.close()
  })
})
