/**
 * End to end through the real executor, in human mode, on an app built to reproduce the ways weak
 * agents went wrong on real products: a cookie modal covering the page, an AI reply that shows
 * "Processing…" and then streams in, a confirm() behind "Delete", SPA navigation whose in-memory
 * state a reload would wipe, duplicate "Add to cart" buttons, a broken image and an onclick <div>.
 *
 * Every assertion is on what the MODEL reads: refusals, the action report, observations.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'human-shop')
const FIXTURE = fs.readFileSync(path.join(FIXTURES, 'index.html'), 'utf-8')

const REPLY_CHUNKS = ['I found ', '3 wireless mice ', 'under $30: ', 'Logitech M185, ', 'Razer Basilisk, ', 'and Anker 2.4G.']

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

/**
 * The fixture apps that change on their own (act-binding.html) long-poll `/api/command`; a test
 * answers the poll to make the app change, and the app acknowledges on `/api/ack` once it has.
 */
const waitingPolls: http.ServerResponse[] = []
const acks = new Map<string, PromiseWithResolvers<void>>()

function pushCommand(command: string): Promise<void> {
  const poll = waitingPolls.shift()
  if (!poll) throw new Error(`no fixture page is waiting for a command (sending "${command}")`)
  const ack = Promise.withResolvers<void>()
  acks.set(command, ack)
  poll.writeHead(200, { 'Content-Type': 'text/plain' })
  poll.end(command)
  return ack.promise
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/command') {
      waitingPolls.push(res)
      return
    }
    if (url.pathname === '/api/ack') {
      acks.get(url.searchParams.get('command') ?? '')?.resolve()
      res.writeHead(204)
      res.end()
      return
    }
    const fixture = /^\/((?:act-[a-z-]+|app-shell|chat)\.html)$/.exec(url.pathname)
    if (fixture) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(path.join(FIXTURES, fixture[1]), 'utf-8'))
      return
    }
    if (url.pathname === '/api/reply') {
      // A real delay on purpose: what is under test is busy detection and settling against a real
      // browser's clock ("Processing…" visible while this request is in flight), which fake timers
      // in this process cannot drive. Longer than the 5s settle cap, like a real model reply, so the
      // action report has to say NOT SETTLED instead of quietly absorbing the whole reply.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ chunks: REPLY_CHUNKS }))
      }, 6500)
      return
    }
    if (url.pathname === '/missing-image.png') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'human-mode-'))
  fs.writeFileSync(path.join(cwd, 'scan.pdf'), 'scan')
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'notes')
})

afterAll(async () => {
  for (const executor of executors) {
    await executor.closeHeadlessContext().catch(() => {})
  }
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(cwd, { recursive: true, force: true })
})

function newExecutor(policy: 'human' | 'debug'): PlaywrightExecutor {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  return executor
}

/** The ref printed in front of the first line matching `pattern`, e.g. `[12] button "Send"`. */
function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

describe('human mode, end to end', () => {
  const executor = newExecutor('human')

  it('lets the first load of a blank tab through and reports it', async () => {
    const result = await executor.execute(`await page.goto('${'BASE'}/', { waitUntil: 'domcontentloaded' })`.replace('BASE', baseUrl), 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/NEW DOCUMENT/)
  })

  let observation = ''
  it('observe() shows the modal that blocks the page and its controls', async () => {
    const result = await executor.execute('await observe()', 30000)
    expect(result.isError, result.text).toBe(false)
    observation = result.text
    expect(observation).toMatch(/MODAL/)
    expect(observation).toMatch(/Cookie consent/)
    expect(observation).toMatch(/\[\d+\] button "Accept all"/)
    // The broken image and the onclick div are visible facts, not things to discover by trial.
    expect(observation).toMatch(/BROKEN/)
    expect(observation).toMatch(/clickable .*Free shipping over \$50/)
    // Two identical buttons are told apart by where they are.
    expect(observation).toMatch(/button "Add to cart" \(in .*Logitech M185/)
    expect(observation).toMatch(/button "Add to cart" \(in .*Razer Basilisk/)
  })

  it('refuses to click through the modal and names what covers the target', async () => {
    const assistant = refOf(observation, /link "Assistant"/)
    const result = await executor.execute(`await act.click(${assistant})`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/covered by/)
  })

  it('handles the modal like a person and reports that it went away', async () => {
    const accept = refOf(observation, /button "Accept all"/)
    const result = await executor.execute(`await act.click(${accept})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/✓ click \[\d+\] button "Accept all"/)
    expect(result.text).toMatch(/SETTLED/)
    const after = await executor.execute('await observe()', 30000)
    expect(after.text).not.toMatch(/MODAL/)
  })

  it('lists a drop-down with its options, and chooses one with real keys, skipping a disabled one', async () => {
    const look = await executor.execute('await observe()', 30000)
    expect(look.text).toMatch(/combobox "Sort by" \[collapsed\] = "Relevance" \(options: Relevance · Price: high to low \(disabled\) · Newest\)/)
    expect(look.text).not.toMatch(/option "Newest"/)
    const sort = refOf(look.text, /combobox "Sort by"/)
    const result = await executor.execute(`await act.select(${sort}, 'Newest')`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/selected "Newest" \(was "Relevance"\)/)
    // The page counts trusted change events only: the choice went through real input.
    expect(result.text).toMatch(/Sorted by Newest/)
  })

  it('ticks a checkbox that is hidden behind its label by clicking the label', async () => {
    const look = await executor.execute('await observe()', 30000)
    expect(look.text).toMatch(/\[\d+\] checkbox "Gift wrap" \[unchecked\] \(hidden control worked through its label/)
    const gift = refOf(look.text, /checkbox "Gift wrap"/)
    const result = await executor.execute(`await act.check(${gift})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/its label was used/)
    expect(result.text).toMatch(/now checked/)
    expect(result.text).toMatch(/Sorted by Newest, gift wrapped/)
  })

  it('refuses page.goto after the first load, before running anything', async () => {
    const result = await executor.execute(`await page.goto('${baseUrl}/chat')`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Refused \(human mode\): page\.goto/)
    expect(result.text).toMatch(/Nothing from this call was run/)
    const url = await executor.execute('return page.url()', 30000)
    expect(url.text).not.toMatch(/\/chat/)
  })

  it('navigates in-app by clicking the link, and the report says no reload happened', async () => {
    const look = await executor.execute('await observe()', 30000)
    const assistant = refOf(look.text, /link "Assistant"/)
    const result = await executor.execute(`await act.click(${assistant})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/in-app route/)
    expect(result.text).not.toMatch(/NEW DOCUMENT/)
  })

  let chat = ''
  it('refuses two actions in one call', async () => {
    chat = (await executor.execute('await observe()', 30000)).text
    const message = refOf(chat, /textbox "Message"/)
    const send = refOf(chat, /button "Send"/)
    const result = await executor.execute(`await act.fill(${message}, 'hello'); await act.click(${send})`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/2 input actions/)
  })

  it('types into the field and reads the value back', async () => {
    const message = refOf(chat, /textbox "Message"/)
    const result = await executor.execute(`await act.fill(${message}, 'find me a wireless mouse under $30')`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/value read back: "find me a wireless mouse under \$30"/)
  })

  it('sends, and the report says the page is not settled and the app is busy', async () => {
    const send = refOf(chat, /button "Send"/)
    const result = await executor.execute(`await act.click(${send})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/You: find me a wireless mouse under \$30/)
    expect(result.text).toMatch(/NOT SETTLED after \d+ms — waiting on POST \/api\/reply/)
    expect(result.text).toMatch(/BUSY .*Processing: Fetching reviews/)
  })

  it('refuses to act while the app is busy', async () => {
    const send = refOf(chat, /button "Send"/)
    const result = await executor.execute(`await act.click(${send})`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/still busy/)
  })

  it('waits for the streamed reply and reports its text', async () => {
    const result = await executor.execute('await act.waitForIdle({ timeoutMs: 20000 })', 40000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/Assistant: I found 3 wireless mice under \$30/)
    expect(result.text).not.toMatch(/BUSY  /)
  })

  it('refuses to send the same thing again right away, from what the network journal saw', async () => {
    const send = refOf(chat, /button "Send"/)
    const result = await executor.execute(`await act.click(${send})`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/sent POST \/api\/reply — requests that change data/)
  })

  it('reports a native confirm() as open and blocking, then answers it', async () => {
    const look = await executor.execute('await observe()', 30000)
    const remove = refOf(look.text, /button "Delete conversation"/)
    const clicked = await executor.execute(`await act.click(${remove})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/confirm\("Delete this conversation\?"\) is OPEN/)
    const blocked = await executor.execute('await observe()', 30000)
    expect(blocked.text).toMatch(/Delete this conversation\?/)
    const dismissed = await executor.execute('await act.dialog.dismiss()', 30000)
    expect(dismissed.isError, dismissed.text).toBe(false)
    expect(dismissed.text).toMatch(/dialog-dismiss/)
    // Dismissed means the conversation is still there.
    const after = await executor.execute('await observe()', 30000)
    expect(after.text).toMatch(/You: find me a wireless mouse under \$30/)
  })

  it('finds off-screen content without scrolling', async () => {
    const look = await executor.execute('await observe()', 30000)
    const home = refOf(look.text, /link "Home"/)
    await executor.execute(`await act.click(${home})`, 30000)
    const found = await executor.execute("await find('Great mouse')", 30000)
    expect(found.isError, found.text).toBe(false)
    expect(found.text).toMatch(/Great mouse, battery lasts forever/)
    expect(found.text).toMatch(/below/i)
  })

  it('left nothing in the page: no playwriter globals or elements in its own world', async () => {
    const result = await executor.execute(
      "return await readPage(() => ({ globals: Object.getOwnPropertyNames(window).filter((k) => /playwriter/i.test(k)), elements: document.querySelectorAll('[data-playwriter-toolbar], [id*=playwriter], [class*=playwriter]').length }))",
      30000,
    )
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/globals: \[\]/)
    expect(result.text).toMatch(/elements: 0/)
  })
})

/** A fresh human-mode executor whose blank tab loads `fixture` (the first load of a blank tab is allowed). */
async function openFixture(fixture: string): Promise<PlaywrightExecutor> {
  const executor = newExecutor('human')
  const loaded = await executor.execute(`await page.goto('${baseUrl}/${fixture}', { waitUntil: 'domcontentloaded' })`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

describe('act refuses a ref whose element changed since the model saw it', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-binding.html')
    look = (await executor.execute('await observe()', 30000)).text
  })

  it('refuses a button relabelled in place, naming both labels, and clicks nothing', async () => {
    const follow = refOf(look, /button "Follow"/)
    await pushCommand('relabel')
    const result = await executor.execute(`await act.click(${follow})`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/now reads button "Unfollow" \(you saw button "Follow"\)/)
    const state = await executor.execute("return await readPage(() => document.getElementById('follows').textContent)", 30000)
    expect(state.text).toMatch(/Follow clicks: 0/)
  })

  it('refuses a recycled list row, naming the context change, and deletes nothing', async () => {
    const aliceDelete = refOf(look, /button "Delete" \(in .*Alice/)
    await pushCommand('recycle')
    const result = await executor.execute(`await act.click(${aliceDelete})`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/is now in .*"Bob" \(you saw it in .*"Alice"\)/)
    const state = await executor.execute("return await readPage(() => document.getElementById('deleted').textContent)", 30000)
    expect(state.text).toMatch(/Deleted: nobody/)
  })
})

describe('act types where the caret is when the page swaps the field it clicked', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-swap.html')
    look = (await executor.execute('await observe()', 30000)).text
  })

  it('types into the field the page put under the pointer, and says so', async () => {
    const search = refOf(look, /searchbox "Search the shop"/)
    const result = await executor.execute(`await act.fill(${search}, 'wireless mouse')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(new RegExp(`the page replaced \\[${search}\\] when it was clicked; the caret is in \\[\\d+\\] combobox "Search the shop" under the pointer`))
    const value = await executor.execute("return await readPage(() => document.getElementById('search-app').value)", 30000)
    expect(value.text).toMatch(/wireless mouse/)
  })

  it('follows a field the page swaps in while the text is typed, and reads the value back from it', async () => {
    const notes = refOf(look, /searchbox "Search the notes"/)
    const result = await executor.execute(`await act.fill(${notes}, 'quarterly tax receipts')`, 60000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(new RegExp(`the page replaced \\[${notes}\\] while the text was typed; the caret is in \\[\\d+\\] combobox "Search the notes" under the pointer`))
    expect(result.text).toMatch(/value read back: "quarterly tax receipts"/)
    const value = await executor.execute("return await readPage(() => document.getElementById('notes-app').value)", 30000)
    expect(value.text).toMatch(/quarterly tax receipts/)
  })

  it('refuses when the caret lands in a field away from the pointer, and types nothing', async () => {
    const coupon = refOf(look, /textbox "Coupon code"/)
    const result = await executor.execute(`await act.fill(${coupon}, 'SAVE10')`, 60000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Keyboard focus is now in \[\d+\] textbox "Gift message", away from where the pointer clicked/)
    const typed = await executor.execute(
      "return await readPage(() => JSON.stringify({ gift: document.getElementById('elsewhere').value, coupon: document.getElementById('coupon-app').value }))",
      30000,
    )
    expect(typed.text).toContain('{"gift":"","coupon":""}')
  })
})

/** Real time on purpose: what is under test runs on the browser's clock (a page timer, Chrome's 5s activation lifespan). */
function realDelay(ms: number): Promise<void> {
  const elapsed = Promise.withResolvers<void>()
  setTimeout(elapsed.resolve, ms)
  return elapsed.promise
}

describe('file dialogs: held back while an input can open one, open until answered', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-file-dialogs.html')
    look = (await executor.execute('await observe()', 30000)).text
  })

  const textOf = async (on: PlaywrightExecutor, id: string): Promise<string> =>
    (await on.execute(`return await readPage(() => document.getElementById('${id}').textContent)`, 30000)).text

  it('answers a confirm without waiting on file-dialog bookkeeping while the page is frozen', async () => {
    const remove = refOf(look, /button "Delete draft"/)
    const clickedAt = Date.now()
    const clicked = await executor.execute(`await act.click(${remove})`, 30000)
    const clickMs = Date.now() - clickedAt
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/DIALOG {2}confirm\("Delete the draft\?"\) is OPEN/)
    expect(clicked.text).not.toMatch(/FILE DIALOG/)
    const dismissedAt = Date.now()
    const dismissed = await executor.execute('await act.dialog.dismiss()', 30000)
    const dismissMs = Date.now() - dismissedAt
    expect(dismissed.isError, dismissed.text).toBe(false)
    expect(dismissed.text).not.toMatch(/FILE DIALOG/)
    expect(await textOf(executor, 'out')).toMatch(/kept/)
    // The stall guarded against: a toggle sent to the frozen renderer was waited for 5s, once per call.
    expect(clickMs).toBeLessThan(4500)
    expect(dismissMs).toBeLessThan(4500)
  })

  it('holds back the file dialog a confirm leads to, reports it to the answer, and chooses in it without a second click', async () => {
    const replace = refOf(look, /button "Replace photo"/)
    const clicked = await executor.execute(`await act.click(${replace})`, 30000)
    expect(clicked.text).toMatch(/DIALOG {2}confirm\("Replace your photo\?"\) is OPEN/)
    const accepted = await executor.execute('await act.dialog.accept()', 30000)
    expect(accepted.isError, accepted.text).toBe(false)
    expect(accepted.text).toMatch(/FILE DIALOG OPEN, opened by your answer to confirm\("Replace your photo\?"\) \(one file\)/)
    const chosen = await executor.execute("await act.dialog.chooseFiles('scan.pdf')", 30000)
    expect(chosen.isError, chosen.text).toBe(false)
    expect(await textOf(executor, 'out')).toMatch(/photo: scan\.pdf/)
    expect(await textOf(executor, 'clicks')).toMatch(/clicked 1 times/)
  })

  it('holds back a file dialog the page opens after the call returned, and keeps it in the way until it is cancelled', async () => {
    const later = refOf(look, /button "Attach later"/)
    const clicked = await executor.execute(`await act.click(${later})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).not.toMatch(/FILE DIALOG/)
    // The page opens it 3s after the click, after that call returned (and within the click's 5s activation).
    await realDelay(3500)
    const looked = await executor.execute('await observe()', 30000)
    expect(looked.text).toMatch(/FILE DIALOG OPEN, opened by your click \[\d+\] button "Attach later", \d\.\ds after that action ended \(one file\)/)
    expect(looked.text).toMatch(new RegExp(`FILE DIALOG open, opened by your click \\[${later}\\] button "Attach later" \\(one file\\)`))
    const blocked = await executor.execute(`await act.click(${refOf(look, /button "Say hi"/)})`, 30000)
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toMatch(/A file dialog is open \(opened by your click \[\d+\] button "Attach later"\)/)
    const cancelled = await executor.execute('await act.dialog.dismiss()', 30000)
    expect(cancelled.isError, cancelled.text).toBe(false)
    expect((await executor.execute('await observe()', 30000)).text).not.toMatch(/FILE DIALOG/)
  })

  it('stops holding file dialogs back once the input can no longer open one', async () => {
    const debug = newExecutor('debug')
    await debug.execute(`await page.goto('${baseUrl}/act-file-dialogs.html', { waitUntil: 'domcontentloaded' })`, 30000)
    const seen = (await debug.execute('await observe()', 30000)).text
    const clicked = await debug.execute(`await act.click(${refOf(seen, /button "Say hi"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    // Chrome's activation from that click lasts 5s; after it the tab's own file dialogs open again.
    await realDelay(5600)
    // A gesture that is not ours (a debugger's) opens the browser's own dialog: headless Chromium cancels it at once.
    const opened = await debug.execute(
      `const cdp = await getCDPSession({ page }); await cdp.send('Runtime.evaluate', { expression: "document.getElementById('attachment').click()", userGesture: true })`,
      30000,
    )
    expect(opened.isError, opened.text).toBe(false)
    await realDelay(500)
    expect(await textOf(debug, 'out')).toMatch(/attachment: cancelled/)
    expect((await debug.execute('await observe()', 30000)).text).not.toMatch(/FILE DIALOG/)
  })

  it("leaves file dialogs to sandbox code that listens for them, and never cuts that code's listener off", async () => {
    const debug = newExecutor('debug')
    await debug.execute(`await page.goto('${baseUrl}/act-file-dialogs.html', { waitUntil: 'domcontentloaded' })`, 30000)
    const notes = path.join(cwd, 'notes.txt')
    const handled = await debug.execute(
      `const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#upload')]); await chooser.setFiles(${JSON.stringify(notes)})`,
      30000,
    )
    expect(handled.isError, handled.text).toBe(false)
    expect(handled.text).toMatch(/FILE DIALOG handed to your page\.on\('filechooser'\) listener \(one file\)/)
    expect(await textOf(debug, 'out')).toMatch(/attachment: notes\.txt/)
    const listening = await debug.execute("state.choosers = 0; page.on('filechooser', () => { state.choosers += 1 })", 30000)
    expect(listening.isError, listening.text).toBe(false)
    // Past the click's activation: the gate lets go of its own hold, and the code's listener keeps its.
    await realDelay(5600)
    await debug.execute(
      `const cdp = await getCDPSession({ page }); await cdp.send('Runtime.evaluate', { expression: "document.getElementById('attachment').click()", userGesture: true })`,
      30000,
    )
    await realDelay(500)
    expect((await debug.execute('return state.choosers', 30000)).text).toMatch(/\b1\b/)
  })
})

describe('reading the page leaves it untouched', () => {
  it('observe, find, the page text and an action report give the page no user activation', async () => {
    // Playwright evaluates in the page as a user gesture (page.title() included): measured, that gives
    // the page transient and sticky activation, so it may then prompt "Leave site?", play sound, or
    // open popups and file dialogs a person who only looked could never trigger.
    const debug = newExecutor('debug')
    await debug.execute(`await page.goto('${baseUrl}/act-file-dialogs.html', { waitUntil: 'domcontentloaded' })`, 30000)
    const seen = (await debug.execute('await observe()', 30000)).text
    await debug.execute("await find('Profile')", 30000)
    await debug.execute('await getPageMarkdown()', 30000)
    await debug.execute('await getCleanHTML({ locator: page })', 30000)
    // A hover moves the pointer (no activation) and gets the full report: settle, events, after-picture, tabs.
    const hovered = await debug.execute(`await act.hover(${refOf(seen, /button "Say hi"/)})`, 30000)
    expect(hovered.isError, hovered.text).toBe(false)
    const activation = await debug.execute(
      "const cdp = await getCDPSession({ page }); return (await cdp.send('Runtime.evaluate', { expression: 'navigator.userActivation.hasBeenActive', returnByValue: true })).result.value",
      30000,
    )
    expect(activation.text).toMatch(/\[return value\] false/)
  })
})

describe('act on native form controls', () => {
  let executor: PlaywrightExecutor
  let look = ''
  beforeAll(async () => {
    executor = await openFixture('act-form.html')
    look = (await executor.execute('await observe()', 30000)).text
  })

  const valueOf = async (id: string): Promise<string> =>
    (await executor.execute(`return await readPage(() => document.getElementById('${id}').value)`, 30000)).text

  it('fills a date input from ISO text by typing into its parts, and reads the ISO value back', async () => {
    const departure = refOf(look, /Departure/)
    const result = await executor.execute(`await act.fill(${departure}, '2024-05-01')`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/value read back: "2024-05-01"/)
    expect(await valueOf('departure')).toMatch(/2024-05-01/)
  })

  it('refuses a date that is not ISO, before touching the field', async () => {
    const departure = refOf(look, /Departure/)
    const result = await executor.execute(`await act.fill(${departure}, '05/01/2024')`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/ISO form YYYY-MM-DD/)
  })

  it('moves a range input to a value with the arrow keys', async () => {
    const volume = refOf(look, /Volume/)
    const result = await executor.execute(`await act.fill(${volume}, '75')`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/moved the slider from 50 to 75/)
    expect(await valueOf('volume')).toMatch(/75/)
  })

  const colourEvents = async (): Promise<string> =>
    (await executor.execute("return await readPage(() => document.getElementById('colour-events').textContent)", 30000)).text

  it('refuses a colour that is not #rrggbb, before touching the input', async () => {
    const colour = refOf(look, /Theme colour/)
    expect(look).toContain(`(takes #rrggbb: act.fill(${colour}, "#rrggbb"))`)
    const result = await executor.execute(`await act.fill(${colour}, 'red')`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/give the colour as #rrggbb, six hex digits/)
    expect(await valueOf('colour')).toMatch(/#336699/)
    expect(await colourEvents()).not.toMatch(/colour=/)
  })

  it("sets a colour input through Chrome's colour chooser with the keys a person uses, firing input and change", async () => {
    const colour = refOf(look, /Theme colour/)
    const result = await executor.execute(`await act.fill(${colour}, '#3366CC')`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/Shift\+Tab into the hex field, typed #3366cc, Enter; value read back: "#3366cc"/)
    expect(await valueOf('colour')).toMatch(/#3366cc/)
    // The page heard it the way it hears a person: input events while the hex was typed, change when the chooser closed.
    const events = await colourEvents()
    expect(events).toMatch(/input:colour=#[0-9a-f]{6}.* change:colour=#3366cc/)
    // The chooser closed: the next key reaches the page again (focus is still in the input) instead of the popup.
    const pressed = await executor.execute("await act.press('Tab')", 30000)
    expect(pressed.isError, pressed.text).toBe(false)
    const focus = await executor.execute('return await readPage(() => document.activeElement.id)', 30000)
    expect(focus.text).toMatch(/badge/)
  })

  it('refuses a colour input with suggested swatches: its popup takes no choice from page input', async () => {
    const badge = refOf(look, /Badge colour/)
    expect(look).toMatch(/Badge colour.*\(colour input with suggested swatches: act\.fill cannot choose in its popup — ask the user\)/)
    const result = await executor.execute(`await act.fill(${badge}, '#0000ff')`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/neither Enter nor Space picks a swatch/)
    expect(await valueOf('badge')).toMatch(/#ff0000/)
  })

  it('refuses a newline in a single-line field instead of submitting the form', async () => {
    const name = refOf(look, /Traveller name/)
    const result = await executor.execute(`await act.fill(${name}, 'Ada\\nLovelace')`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/single-line field/)
    const submitted = await executor.execute("return await readPage(() => document.getElementById('submitted').textContent)", 30000)
    expect(submitted.text).not.toMatch(/Submitted/)
  })

  it('uploads a file through the file dialog its click opens', async () => {
    const passport = refOf(look, /Passport scan/)
    const result = await executor.execute(`await act.upload(${passport}, 'scan.pdf')`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/a file dialog \(one file\): scan\.pdf was chosen in it/)
    const chosen = await executor.execute("return await readPage(() => Array.from(document.getElementById('passport').files).map((f) => f.name))", 30000)
    expect(chosen.text).toMatch(/scan\.pdf/)
  })

  it('refuses two files for a control that takes one: before the click for a file input, from the dialog otherwise', async () => {
    const passport = refOf(look, /Passport scan/)
    const direct = await executor.execute(`await act.upload(${passport}, ['scan.pdf', 'notes.txt'])`, 30000)
    expect(direct.isError).toBe(true)
    expect(direct.text).toMatch(/takes one file \(its file input has no `multiple`\)/)
    const photo = refOf(look, /button "Choose photo"/)
    const viaDialog = await executor.execute(`await act.upload(${photo}, ['scan.pdf', 'notes.txt'])`, 30000)
    expect(viaDialog.isError).toBe(true)
    expect(viaDialog.text).toMatch(/The file dialog takes one file only; you passed 2/)
    // The dialog the click opened is still there, as it would be for a person: cancelling it frees the page.
    expect(viaDialog.text).toMatch(/FILE DIALOG OPEN, opened by your upload/)
    const cancelled = await executor.execute('await act.dialog.dismiss()', 30000)
    expect(cancelled.isError, cancelled.text).toBe(false)
    expect(cancelled.text).toMatch(/✓ dialog-dismiss file dialog opened by your upload/)
  })

  it('a refused upload click leaves no unhandled rejection behind', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const report = refOf(look, /button "Upload report"/)
      const result = await executor.execute(`await act.upload(${report}, 'scan.pdf')`, 30000)
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/covered by/)
      // A real timer on purpose: the failure guarded against is a file-chooser waiter whose own 4s
      // timeout rejects after the click was already refused (in this process, against the
      // browser's real clock); fake timers cannot drive it, only real time lets it expire.
      const elapsed = Promise.withResolvers<void>()
      setTimeout(elapsed.resolve, 4500)
      await elapsed.promise
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('drags an HTML draggable onto a drop target with the drag data the page set', async () => {
    const card = refOf(look, /button "Card Lyon"/)
    const done = refOf(look, /button "Done column"/)
    const result = await executor.execute(`await act.drag(${card}, ${done})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/the page started an HTML drag/)
    const dropped = await executor.execute("return await readPage(() => document.getElementById('done').textContent)", 30000)
    expect(dropped.text).toMatch(/Done: Lyon/)
  })
})

describe('act across history, tabs and scroll areas', () => {
  it('refuses act.back() on a fresh tab that has no earlier page', async () => {
    const executor = newExecutor('human')
    const result = await executor.execute('await act.back()', 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Nothing to go back to: this tab has no earlier page in its history/)
  })

  it('acts in the tab a ref belongs to, and makes it the controlled page', async () => {
    const executor = await openFixture('act-tabs.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const opened = await executor.execute(`await act.click(${refOf(look, /link "Open details"/)})`, 30000)
    expect(opened.isError, opened.text).toBe(false)
    expect(opened.text).toMatch(/TAB {5}a new tab opened by this page: .* act\.switchTab\(1\)/)
    const details = await executor.execute('await observe({ page: context.pages()[1] })', 30000)
    expect(details.isError, details.text).toBe(false)
    const confirm = refOf(details.text, /button "Confirm order"/)
    const clicked = await executor.execute(`await act.click(${confirm})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/switched to the tab "Order details" this ref belongs to/)
    const state = await executor.execute("return [page.url(), await readPage(() => document.getElementById('state').textContent)]", 30000)
    expect(state.text).toMatch(/act-tab-details\.html/)
    expect(state.text).toMatch(/Confirmed: 1/)
    const back = await executor.execute('await act.switchTab(0)', 30000)
    expect(back.isError, back.text).toBe(false)
    expect(back.text).toMatch(/switchTab tab 0 "Orders — tabs fixture"/)
  })

  it('refuses a second action in one call at run time, even one the static check cannot see', async () => {
    const executor = await openFixture('act-tabs.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const first = refOf(look, /button "First"/)
    const second = refOf(look, /button "Second"/)
    // Called through an array element, the helper's second run is invisible to the static check.
    const result = await executor.execute(
      `async function tap(ref) { await act.click(ref) }\nconst steps = [tap]\nawait steps[0](${first})\nawait steps[0](${second})`,
      30000,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/this call already performed click \[\d+\] button "First" — one action per call in human mode/)
    const log = await executor.execute("return await readPage(() => document.getElementById('log').textContent)", 30000)
    expect(log.text).toMatch(/Log: first/)
    expect(log.text).not.toMatch(/second/)
  })

  it('act.scroll() without a ref scrolls the app shell list the wheel reaches, not the document', async () => {
    const executor = await openFixture('app-shell.html')
    await executor.execute('await observe()', 30000)
    const result = await executor.execute('await act.scroll()', 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/scrolled .*Messages.* \d+px; \d+\.\d screens below/)
    const offsets = await executor.execute(
      "return await readPage(() => [document.getElementById('inbox').scrollTop, document.scrollingElement.scrollTop])",
      30000,
    )
    const [, inner, documentTop] = /\[\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\s*\]/.exec(offsets.text)?.map(Number) ?? []
    expect(inner).toBeGreaterThan(0)
    expect(documentTop).toBe(0)
  })

  /** The numbers of an array readPage returned, e.g. `[ 600, 0 ]`. */
  const numbersIn = (text: string): number[] => {
    const list = /\[([^\]]*)\]\s*$/.exec(text.trim())?.[1]
    if (list === undefined) throw new Error(`no array in:\n${text}`)
    return list.split(',').map(Number)
  }

  it('lists a carousel as a scroll area and scrolls it sideways with the wheel, not the page', async () => {
    const executor = await openFixture('act-carousel.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const carousel = refOf(look, /^SCROLL \[\d+\] region "Featured products"/)
    expect(look).toMatch(new RegExp(`SCROLL \\[${carousel}\\] region "Featured products" — left edge, [\\d.]+ screens to the right \\(act\\.scroll\\(dir, \\{ ref: ${carousel} \\}\\)\\)`))
    // What it hides is counted inside it, with the way to reach it — not as page content off to the side.
    expect(look).toMatch(new RegExp(`INSIDE \\[${carousel}\\] region "Featured products" .*out of sight — act\\.scroll\\('right', \\{ ref: ${carousel} \\}\\)`))
    expect(look).not.toMatch(/SIDEWAYS/)
    const found = await executor.execute("await find('Product 12')", 30000)
    expect(found.text).toMatch(new RegExp(`link "Product 12" .*— inside \\[${carousel}\\] region "Featured products", scrolled out of sight`))

    const result = await executor.execute(`await act.scroll('right', { ref: ${carousel} })`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/scrolled \[\d+\] region "Featured products" \d+px to the right; \d+\.\d screens to the right/)
    expect(result.text).toMatch(new RegExp(`SCROLL \\[${carousel}\\] region "Featured products" sideways 0 → \\d+px`))
    const [left, pageY, pageX] = numbersIn(
      (await executor.execute("return await readPage(() => [document.getElementById('featured').scrollLeft, window.scrollY, window.scrollX])", 30000)).text,
    )
    expect(left).toBeGreaterThan(100)
    expect([pageY, pageX]).toEqual([0, 0])
  })

  it('refuses a third sideways scroll of a carousel after two that moved nothing', async () => {
    const executor = await openFixture('act-carousel.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const carousel = refOf(look, /^SCROLL \[\d+\] region "Featured products"/)
    const toEnd = await executor.execute(`await act.scroll('right', { ref: ${carousel}, screens: 10 })`, 30000)
    expect(toEnd.isError, toEnd.text).toBe(false)
    expect(toEnd.text).toMatch(/reached the right end of \[\d+\] region "Featured products" after \d+px/)
    for (let attempt = 0; attempt < 2; attempt++) {
      const idle = await executor.execute(`await act.scroll('right', { ref: ${carousel} })`, 30000)
      expect(idle.isError, idle.text).toBe(false)
      expect(idle.text).toMatch(/nothing to scroll: \[\d+\] region "Featured products" is already at the right end/)
    }
    const refused = await executor.execute(`await act.scroll('right', { ref: ${carousel} })`, 30000)
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/Not done: the last 2 scrolls of \[\d+\] region "Featured products" right moved 0px each/)
    // The other way still moves it.
    const back = await executor.execute(`await act.scroll('left', { ref: ${carousel} })`, 30000)
    expect(back.isError, back.text).toBe(false)
    expect(back.text).toMatch(/\d+px to the left; \d+\.\d screens to the left/)
  })

  it('refuses a scroll direction other than down, up, right or left', async () => {
    const executor = await openFixture('act-carousel.html')
    await executor.execute('await observe()', 30000)
    const result = await executor.execute("await act.scroll('sideways')", 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/scroll: direction must be 'down', 'up', 'right' or 'left' \(got "sideways"\)/)
  })

  it('act.scrollTo brings a card hidden to the right of a carousel into view with the wheel', async () => {
    const executor = await openFixture('act-carousel.html')
    await executor.execute('await observe()', 30000)
    const product = refOf((await executor.execute("await find('Product 12')", 30000)).text, /link "Product 12"/)
    const result = await executor.execute(`await act.scrollTo(${product})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/scrolled with the mouse wheel to reach it: \d+px in section#featured\.carousel "Featured products"/)
    const [linkLeft, linkRight, boxLeft, boxRight] = numbersIn(
      (
        await executor.execute(
          "return await readPage(() => { const link = document.querySelector('a[href=\"#featured-12\"]').getBoundingClientRect(); const box = document.getElementById('featured').getBoundingClientRect(); return [link.left, link.right, box.left, box.right].map(Math.round) })",
          30000,
        )
      ).text,
    )
    expect(linkLeft).toBeGreaterThanOrEqual(boxLeft)
    expect(linkRight).toBeLessThanOrEqual(boxRight)
  })

  it('lists a right-to-left carousel at its right edge, scrolls it left, and reports how far it moved while it loaded more', async () => {
    const executor = await openFixture('act-carousel.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const arrivals = refOf(look, /^SCROLL \[\d+\] region "New arrivals"/)
    expect(look).toMatch(new RegExp(`SCROLL \\[${arrivals}\\] region "New arrivals" — right edge, [\\d.]+ screens to the left`))
    expect(look).toMatch(new RegExp(`INSIDE \\[${arrivals}\\] region "New arrivals" .*out of sight — act\\.scroll\\('left', \\{ ref: ${arrivals} \\}\\)`))
    // The carousel adds four cards on its left the first time it scrolls: the distance from its
    // left edge grows by their width, but what moved is Chrome's own scrollLeft.
    const result = await executor.execute(`await act.scroll('left', { ref: ${arrivals} })`, 30000)
    expect(result.isError, result.text).toBe(false)
    const reported = Number(/scrolled \[\d+\] region "New arrivals" (\d+)px to the left; \d+\.\d screens to the left/.exec(result.text)?.[1])
    // Chrome's scrollLeft of right-to-left content is 0 at its start and negative leftwards.
    const [left, cards] = numbersIn(
      (await executor.execute("return await readPage(() => [document.getElementById('arrivals').scrollLeft, document.querySelectorAll('#arrivals .card').length])", 30000)).text,
    )
    expect(cards).toBe(12)
    expect(left).toBeLessThan(-100)
    expect(Math.abs(reported - Math.abs(left))).toBeLessThanOrEqual(1)
    expect(result.text).toMatch(new RegExp(`SCROLL \\[${arrivals}\\] region "New arrivals" sideways 0 → -${reported}px`))
  })

  it('does not report a right-to-left carousel as scrolled when the page only added cards to it', async () => {
    const executor = await openFixture('act-carousel.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const result = await executor.execute(`await act.click(${refOf(look, /button "More arrivals"/)})`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/link "Arrival 12"/)
    expect(result.text).not.toMatch(/SCROLL \[\d+\] region "New arrivals"/)
  })

  it('lists a vertical-rl reader at its right edge, and asks a carousel scrolled down to scroll the way it can move', async () => {
    const executor = await openFixture('act-carousel.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const reader = refOf(look, /^SCROLL \[\d+\] region "Reader"/)
    expect(look).toMatch(new RegExp(`SCROLL \\[${reader}\\] region "Reader" — right edge, [\\d.]+ screens to the left`))
    expect(look).toMatch(new RegExp(`INSIDE \\[${reader}\\] region "Reader" .*out of sight — act\\.scroll\\('left', \\{ ref: ${reader} \\}\\)`))
    const moved = await executor.execute(`await act.scroll('left', { ref: ${reader} })`, 30000)
    expect(moved.isError, moved.text).toBe(false)
    // Less than a screen is left that way: the wheel turns only that far and the report says it reached the end.
    expect(moved.text).toMatch(/reached the left end of \[\d+\] region "Reader" after \d+px/)
    // A right-to-left carousel starts at its right edge: the way it can move is left.
    const arrivals = refOf(look, /^SCROLL \[\d+\] region "New arrivals"/)
    const down = await executor.execute(`await act.scroll('down', { ref: ${arrivals} })`, 30000)
    expect(down.isError, down.text).toBe(false)
    expect(down.text).toContain(`nothing to scroll: [${arrivals}] region "New arrivals" does not scroll up or down; it scrolls sideways (act.scroll('left', { ref: ${arrivals} }))`)
  })

  it("scrolls a page whose <body> is right-to-left from its right edge, and does not list <body> as a scroll area", async () => {
    const executor = await openFixture('act-rtl-page.html')
    const look = (await executor.execute('await observe()', 30000)).text
    expect(look).not.toMatch(/^SCROLL /m)
    expect(look).toMatch(/SIDEWAYS \d+ controls off to the left\/right/)
    const result = await executor.execute("await act.scroll('left')", 30000)
    expect(result.isError, result.text).toBe(false)
    const [screensLeft] = /(\d+\.\d) screens to the left/.exec(result.text)?.slice(1).map(Number) ?? []
    expect(result.text).toMatch(/scrolled the page \d+px to the left/)
    expect(screensLeft).toBeGreaterThan(0)
    const [left] = numbersIn((await executor.execute('return await readPage(() => [document.scrollingElement.scrollLeft])', 30000)).text)
    expect(left).toBeLessThan(-100)
  })

  it('lists a column-reverse chat log at its newest message as the bottom, and scrolls it up to older ones', async () => {
    const executor = await openFixture('act-chat-log.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const chat = refOf(look, /^SCROLL \[\d+\] main "Conversation"/)
    expect(look).toMatch(new RegExp(`SCROLL \\[${chat}\\] main "Conversation" — bottom, [\\d.]+ screens above \\(act\\.scroll\\(dir, \\{ ref: ${chat} \\}\\)\\)`))
    expect(look).toMatch(new RegExp(`INSIDE \\[${chat}\\] main "Conversation" .*out of sight — act\\.scroll\\('up', \\{ ref: ${chat} \\}\\)`))
    expect(look).toMatch(/link "Message 60"/)
    const result = await executor.execute(`await act.scroll('up', { ref: ${chat} })`, 30000)
    expect(result.isError, result.text).toBe(false)
    const reported = Number(/scrolled \[\d+\] main "Conversation" (\d+)px; \d+\.\d screens above/.exec(result.text)?.[1])
    // Chrome's scrollTop of a column-reverse list is 0 at its newest message and negative upwards.
    const [top] = numbersIn((await executor.execute("return await readPage(() => [document.getElementById('log').scrollTop])", 30000)).text)
    expect(top).toBeLessThan(-100)
    expect(Math.abs(reported - Math.abs(top))).toBeLessThanOrEqual(1)
    expect(result.text).toMatch(new RegExp(`SCROLL \\[${chat}\\] main "Conversation" 0 → -${reported}px \\(now [\\d.]+ screens above, [\\d.]+ below\\)`))
  })

  it('says a column-reverse chat log at its newest message is already at the bottom, and refuses the third scroll down', async () => {
    const executor = await openFixture('act-chat-log.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const chat = refOf(look, /^SCROLL \[\d+\] main "Conversation"/)
    for (let attempt = 0; attempt < 2; attempt++) {
      const idle = await executor.execute(`await act.scroll('down', { ref: ${chat} })`, 30000)
      expect(idle.isError, idle.text).toBe(false)
      expect(idle.text).toMatch(/nothing to scroll: \[\d+\] main "Conversation" is already at the bottom/)
    }
    const refused = await executor.execute(`await act.scroll('down', { ref: ${chat} })`, 30000)
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/Not done: the last 2 scrolls of \[\d+\] main "Conversation" down moved 0px each/)
  })
})

describe('act.fill on colour inputs, when the chooser or the page gets in the way', () => {
  const logOf = async (executor: PlaywrightExecutor): Promise<string> =>
    (await executor.execute("return await readPage(() => document.getElementById('log').textContent)", 30000)).text

  it('sets a colour input hidden from view and from the accessibility tree, through its label', async () => {
    const executor = await openFixture('act-colour.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const hidden = refOf(look, /colorwell "Hidden accent"/)
    const result = await executor.execute(`await act.fill(${hidden}, '#3366cc')`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/value read back: "#3366cc"/)
    expect(await logOf(executor)).toMatch(/change:hidden-accent=#3366cc/)
  })

  it('stops sending keys when the page closes the chooser, and says which keys were sent', async () => {
    const executor = await openFixture('act-colour.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const brand = refOf(look, /colorwell "Brand colour"/)
    const result = await executor.execute(`await act.fill(${brand}, '#3366cc')`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Chrome's colour chooser for \[\d+\] colorwell "Brand colour" closed before act\.fill was done \(keys sent to it: Shift\+Tab ArrowUp Shift\+Tab # 3\)/)
    expect(result.text).not.toMatch(/Cancelled it with Escape/)
    // No key reached the page after the chooser closed.
    expect(await logOf(executor)).not.toMatch(/keydown:/)
  })

  it('refuses naming the dialog when the click on a colour input opens a confirm, and reads nothing from the frozen page', async () => {
    const executor = await openFixture('act-colour.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const confirmed = refOf(look, /colorwell "Confirmed colour"/)
    const result = await executor.execute(`await act.fill(${confirmed}, '#3366cc')`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Clicked \[\d+\] colorwell "Confirmed colour", and a native confirm\("Use a custom colour\?"\) opened: the page is frozen/)
    const dismissed = await executor.execute('await act.dialog.dismiss()', 30000)
    expect(dismissed.isError, dismissed.text).toBe(false)
  })

  it('stops typing when a change in the chooser opens a confirm, naming the keys sent', async () => {
    const executor = await openFixture('act-colour.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const asked = refOf(look, /colorwell "Asked colour"/)
    const result = await executor.execute(`await act.fill(${asked}, '#3366cc')`, 30000)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Choosing #3366cc in Chrome's colour chooser for \[\d+\] colorwell "Asked colour" \(keys sent: Shift\+Tab ArrowUp Shift\+Tab # 3\), and a native confirm\("Apply this colour\?"\) opened/)
    const dismissed = await executor.execute('await act.dialog.dismiss()', 30000)
    expect(dismissed.isError, dismissed.text).toBe(false)
    expect(await logOf(executor)).toMatch(/input:asked=#000003 confirm:false/)
  })

  it("shows a colour chooser opened by a click on the input's line, without listing the chooser's own controls", async () => {
    const executor = await openFixture('act-colour.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const plain = refOf(look, /colorwell "Plain colour"/)
    const clicked = await executor.execute(`await act.click(${plain})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    // The report says the chooser opened, and lists nothing of the chooser's own as page controls.
    expect(clicked.text).toContain(`~ [${plain}] colorwell "Plain colour": (no state) → [chooser open]`)
    expect(clicked.text).not.toMatch(/Color well|Red channel|Format toggler|Eyedropper/)
    const all = (await executor.execute('await observe({ all: true })', 30000)).text
    expect(all).toContain(
      `[${plain}] colorwell "Plain colour" [focused] = "#000000" (Chrome's colour chooser is open, and keys go to it, not the page: act.fill(${plain}, "#rrggbb") ` +
        "chooses a colour; act.press('Enter') closes it keeping the colour it shows; act.press('Escape') puts back the colour it opened with, and closes it once that colour is back)",
    )
    expect(all).not.toMatch(/Color well|Red channel|Format toggler|Eyedropper/)
  })

  it('sets a colour input whose chooser is already open, cancelling it first the way a person does', async () => {
    const executor = await openFixture('act-colour.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const plain = refOf(look, /colorwell "Plain colour"/)
    expect((await executor.execute(`await act.click(${plain})`, 30000)).isError).toBe(false)
    const result = await executor.execute(`await act.fill(${plain}, '#3366cc')`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/its colour chooser was already open, showing #000000: cancelled it with Escape \(once\), which left #000000/)
    expect(result.text).toMatch(/value read back: "#3366cc"/)
    expect(await logOf(executor)).toMatch(/input:plain=#3366cc change:plain=#3366cc/)
    // Its chooser is closed: no key reached the page, and observe says nothing is open.
    expect(await logOf(executor)).not.toMatch(/keydown:/)
    expect((await executor.execute('await observe()', 30000)).text).toContain(`[${plain}] colorwell "Plain colour" [focused] = "#3366cc" (takes #rrggbb`)
  })

  it('sends no Enter when the page closes the chooser itself once the colour is typed', async () => {
    const executor = await openFixture('act-colour.html')
    const look = (await executor.execute('await observe()', 30000)).text
    const palette = refOf(look, /colorwell "Palette colour"/)
    const result = await executor.execute(`await act.fill(${palette}, '#3366cc')`, 30000)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/typed #3366cc, and the page closed the chooser itself, so no Enter was sent; value read back: "#3366cc"/)
    // No key reached the page, and the chooser did not open again.
    expect(await logOf(executor)).not.toMatch(/keydown:/)
    expect((await executor.execute(`return await readPage(() => document.getElementById('palette').matches(':open'))`, 30000)).text).toMatch(/false/)
  })
})

describe('debug mode', () => {
  const executor = newExecutor('debug')

  it('allows multi-step scripts and goto, and still reports', async () => {
    const first = await executor.execute(`await page.goto('${baseUrl}/', { waitUntil: 'domcontentloaded' })`, 30000)
    expect(first.isError, first.text).toBe(false)
    const result = await executor.execute(
      `await page.goto('${baseUrl}/account', { waitUntil: 'domcontentloaded' }); await page.getByText('Accept all').click()`,
      30000,
    )
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/\(raw Playwright\)/)
    // A new document is summarised, not diffed element by element.
    expect(result.text).toMatch(/NEW DOCUMENT → .*\/account/)
  })
})
