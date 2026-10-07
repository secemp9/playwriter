/**
 * Live-Chromium tests for what observe(), find() and the "what changed" report say about the Browser
 * Lab pages (test/fixtures/browser-lab, copied from the lab used to compare the fork with omp's
 * browser tool): row context, table names, tooltips, a revealed password, focused and greyed items,
 * images without alt, a modal's backdrop, and refs for draggable, focusable and right-click targets.
 * Plain headless Chromium for observePage; the human-mode executor where an act call is the point.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import { getAriaSnapshot } from './aria-snapshot.js'
import { PageFrames } from './page-frames.js'
import { RefRegistry } from './ref-registry.js'
import { PlaywrightExecutor } from './executor.js'
import {
  observePage,
  renderObservation,
  diffObservations,
  renderObservationDiff,
  findInObservation,
  type Observation,
  type ObservedElement,
} from './page-observe.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
}
const DECORATIVE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Decorative</title></head><body>
<h1>Gallery</h1>
<img src="/lab/chart.svg" alt="" width="40" height="20">
<img src="/lab/chart.svg" alt="" width="40" height="20">
<img src="/lab/chart.svg" alt="Sales chart" width="40" height="20">
</body></html>`
const DESCRIBED_POPUP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Popup</title>
<style>#tip { position: absolute; top: 40px; left: 0; background: #222; color: #fff; padding: 4px; }</style></head><body>
<button id="help" aria-describedby="tip">Help</button>
<div id="tip" hidden>Opens the help centre in a new tab</div>
</body></html>`

let server: http.Server
let baseUrl = ''
let browser: Browser
let context: BrowserContext
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const inline: Record<string, string> = {
      '/decorative.html': DECORATIVE_HTML,
      '/described-popup.html': DESCRIBED_POPUP_HTML,
      // The saved Hacker News front page relay-core's snapshot test uses: a logo without alt in a link, and spacer <img>s.
      '/hacker-news.html': fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'fixture-hacker-news.html'), 'utf-8'),
    }
    if (inline[pathname]) {
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] })
      res.end(inline[pathname])
      return
    }
    const file = path.join(LAB, path.normalize(pathname))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-lab-'))
}, 120000)

afterAll(async () => {
  const closing = [
    ...(await Promise.allSettled(executors.map((executor) => executor.closeHeadlessContext()))),
    // The context before its browser: closing the browser first takes the context with it.
    ...(await Promise.allSettled([context?.close()])),
    ...(await Promise.allSettled([browser?.close()])),
  ]
  const shared = await Promise.allSettled([PlaywrightExecutor.closeSharedHeadlessBrowser()])
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close((error) => (error ? closed.reject(error) : closed.resolve()))
  const stopped = await Promise.allSettled([closed.promise])
  fs.rmSync(cwd, { recursive: true, force: true })
  const errors = [...closing, ...shared, ...stopped].flatMap((outcome): unknown[] => (outcome.status === 'rejected' ? [outcome.reason] : []))
  if (errors.length > 0) throw new AggregateError(errors, `teardown failed ${errors.length} time(s): ${errors.map(String).join('; ')}`)
})

interface Observer {
  page: Page
  observe: (previous?: Observation | null) => Promise<Observation>
}

async function openObserver(file: string): Promise<Observer> {
  const page = await context.newPage()
  await page.goto(`${baseUrl}/${file}`, { waitUntil: 'load' })
  const cdp = await getCDPSessionForPage({ page })
  const frames = new PageFrames({ page, cdp })
  const registry = new RefRegistry()
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  return {
    page,
    observe: (previous) => observePage({ page, frames, registry, targetId: targetInfo.targetId, shown: true, previous: previous ?? null }),
  }
}

function only(obs: Observation, predicate: (element: ObservedElement) => boolean, what: string): ObservedElement {
  const found = obs.elements.filter(predicate)
  expect(found, `${what} in ${obs.elements.map((e) => `[${e.ref}] ${e.role} "${e.name}"`).join(', ')}`).toHaveLength(1)
  return found[0]
}

describe('row context: a control in a table row is named by its own row (A2)', () => {
  it('gives each row its own words in observe, find and the change report', async () => {
    const { page, observe } = await openObserver('table.html')
    const before = await observe()
    const initech = 'in row "INV-1003 Initech 2026-01-19 $2,400.00 Overdue"'
    const deleteInitech = only(before, (e) => e.role === 'button' && e.name === 'Delete' && e.context === initech, 'Initech Delete')
    expect(before.elements.filter((e) => e.role === 'button' && e.name === 'Delete').map((e) => e.context)).toEqual([
      'in row "INV-1001 Acme Corp 2026-01-05 $1,200.00 Paid"',
      'in row "INV-1002 Globex 2026-01-12 $830.50 Pending"',
      initech,
      'in row "INV-1004 Umbrella Health 2026-01-26 $415.75 Paid"',
      'in row "INV-1005 Stark Industries 2026-02-02 $9,999.99 Pe…"',
      'in row "INV-1006 Wayne Enterprises 2026-02-09 $3,050.00 P…"',
    ])
    const rendered = renderObservation(before)
    expect(rendered).toContain(`[${deleteInitech.ref}] button "Delete" (${initech})`)
    expect(rendered).not.toContain('(after "')
    // Every control find('Initech') returns is in the Initech row.
    const found = findInObservation(before, 'Initech')
    const buttons = found.split('\n').filter((line) => /^\s+\[\d+\] button/.test(line))
    expect(buttons).toHaveLength(3)
    for (const line of buttons) expect(line).toContain(initech)

    await page.click('#rows tr:nth-child(3) button[data-action="more"]')
    const after = await observe(before)
    const report = renderObservationDiff(diffObservations(before, after))
    expect(report).toContain(`button "More actions" (${initech}): [collapsed] [haspopup=menu] → [expanded]`)
  }, 60000)
})

describe('table, grid and list names (B1)', () => {
  it('lists a table by its caption and finds it', async () => {
    const { observe } = await openObserver('table.html')
    const obs = await observe()
    expect(renderObservation(obs)).toContain('table "Showing 1–6 of 12 invoices"')
    expect(findInObservation(obs, 'Showing')).toContain('table "Showing 1–6 of 12 invoices"')
  }, 60000)

  it("tells storage.html's three tables apart", async () => {
    const { observe } = await openObserver('storage.html')
    const obs = await observe()
    expect(obs.text.filter((block) => block.role === 'table').map((block) => block.text)).toEqual(['Cookies', 'localStorage', 'sessionStorage'])
    const rendered = renderObservation(obs)
    expect(rendered.indexOf('table "Cookies"')).toBeLessThan(rendered.indexOf('table "localStorage"'))
    expect(rendered.indexOf('table "localStorage"')).toBeLessThan(rendered.indexOf('table "sessionStorage"'))
  }, 60000)
})

describe('tooltips (B2)', () => {
  it('lists a shown role=tooltip with the control it describes, and finds it', async () => {
    const { page, observe } = await openObserver('pointer.html')
    const before = await observe()
    expect(before.text.some((block) => block.role === 'tooltip')).toBe(false)
    expect(findInObservation(before, 'Free shipping')).toContain('No match')
    await page.hover('#shipping-info')
    await page.locator('#shipping-tip').waitFor({ state: 'visible' })
    const shown = await observe(before)
    const button = only(shown, (e) => e.role === 'button' && e.name === 'Shipping info', 'Shipping info')
    const tip = shown.text.find((block) => block.role === 'tooltip')
    expect(tip).toMatchObject({ text: 'Free shipping on orders over $50', describes: button.ref, visibility: 'in-view' })
    expect(renderObservation(shown)).toContain(`tooltip "Free shipping on orders over $50" (describes [${button.ref}])`)
    expect(findInObservation(shown, 'Free shipping')).toContain(`tooltip "Free shipping on orders over $50" (describes [${button.ref}])`)
    expect(findInObservation(shown, 'tooltip')).toContain('Free shipping')
  }, 60000)

  it('lists an aria-describedby popup without a tooltip role as text once it shows', async () => {
    const { page, observe } = await openObserver('described-popup.html')
    expect(findInObservation(await observe(), 'help centre')).toContain('No match')
    await page.evaluate(() => {
      document.getElementById('tip')!.hidden = false
    })
    expect(findInObservation(await observe(), 'help centre')).toContain('text: "Opens the help centre in a new tab"')
  }, 60000)
})

describe('a revealed password (B3)', () => {
  it('reports the value as shown once the eye toggle makes the field type=text, and the toggle pressed', async () => {
    const { page, observe } = await openObserver('form.html')
    await page.fill('#password', 'Analytical1843')
    const masked = await observe()
    expect(only(masked, (e) => e.role === 'textbox' && e.name === 'Password', 'Password').value).toBe('••••')
    expect(JSON.stringify(masked)).not.toContain('Analytical1843')
    await page.click('#toggle-password')
    const revealed = await observe(masked)
    const field = only(revealed, (e) => e.role === 'textbox' && e.name === 'Password', 'Password')
    expect(field.value).toBe('Analytical1843')
    const toggle = only(revealed, (e) => e.role === 'button' && e.name === 'Hide password', 'Hide password')
    expect(toggle.states?.pressed).toBe(true)
    expect(findInObservation(revealed, 'Password')).toContain(`[${field.ref}] textbox "Password" [required] = "Analytical1843"`)
    // Hidden again: masked again.
    await page.click('#toggle-password')
    expect(only(await observe(revealed), (e) => e.role === 'textbox' && e.name === 'Password', 'Password').value).toBe('••••')
  }, 60000)
})

describe('focused items and greyed text stay listed (B4)', () => {
  it('keeps a focused tabindex list item and its words', async () => {
    const { page, observe } = await openObserver('pointer.html')
    const before = await observe()
    await page.focus('#sortable li[data-name="Echo"]')
    const after = await observe(before)
    const echo = only(after, (e) => e.name === 'Echo', 'Echo')
    expect(echo.states?.focused).toBe(true)
    expect(after.focused).toBe(echo.ref)
    expect(renderObservation(after)).toContain(`FOCUS [${echo.ref}] draggable focusable listitem "Echo" [focused]`)
    expect(findInObservation(after, 'Echo')).toContain(`[${echo.ref}] draggable focusable listitem "Echo"`)
    const report = renderObservationDiff(diffObservations(before, after))
    expect(report).not.toContain('- item: "Echo"')
    expect(report).not.toMatch(/- \[\d+\] .*"Echo"/)
  }, 60000)

  it('keeps an archived card\'s greyed "(Archived)" text when the card has focus', async () => {
    const { page, observe } = await openObserver('pointer.html')
    const before = await observe()
    await page.click('#ctx-card', { button: 'right' })
    await page.click('#ctx-menu button[data-act="Archive"]')
    await expect.poll(() => page.locator('#ctx-state').textContent()).toBe('(Archived)')
    const after = await observe(before)
    expect(only(after, (e) => e.cssLabel === 'div#ctx-card.ctx-card.archived', 'card').states?.focused).toBe(true)
    expect(findInObservation(after, 'Quarterly report (Archived)')).toContain('text: "Quarterly report (Archived)"')
    expect(renderObservationDiff(diffObservations(before, after))).not.toMatch(/- text: "Quarterly report"(?! \()/)
  }, 60000)
})

describe('images without alt (B5)', () => {
  it('lists an <img> without alt by its address, and finds it', async () => {
    const { observe } = await openObserver('a11y.html')
    const obs = await observe()
    const chart = only(obs, (e) => e.noAlt !== undefined, 'image without alt')
    expect(chart).toMatchObject({ name: '', noAlt: { src: '/lab/chart.svg' } })
    expect(renderObservation(obs)).toContain(`[${chart.ref}] image (no alt) /lab/chart.svg`)
    expect(findInObservation(obs, 'chart.svg')).toContain(`[${chart.ref}] image (no alt) /lab/chart.svg`)
  }, 60000)

  it('counts alt="" images as decoration in the legend instead of dropping them silently', async () => {
    const { observe } = await openObserver('decorative.html')
    const obs = await observe()
    expect(obs.decorativeImages).toBe(2)
    expect(obs.elements.filter((e) => e.role === 'image').map((e) => e.name)).toEqual(['Sales chart'])
    expect(renderObservation(obs)).toContain('IMAGES 2 decorative images (alt="") not listed: the page marks them as decoration')
  }, 60000)
})

describe("a modal's own backdrop (B7)", () => {
  it('lists the backdrop with a ref as the backdrop of its dialog, not as something behind the modal', async () => {
    const { page, observe } = await openObserver('overlay.html')
    await page.locator('#newsletter').waitFor({ state: 'visible' })
    const obs = await observe()
    expect(obs.modal).toMatchObject({ role: 'dialog', name: 'Get 10% off your first order' })
    const backdrop = only(obs, (e) => e.role === 'backdrop', 'backdrop')
    expect(backdrop).toMatchObject({ backdropOf: 'dialog "Get 10% off your first order"', cssLabel: 'div#newsletter-backdrop.backdrop', visibility: 'in-view' })
    const rendered = renderObservation(obs)
    expect(rendered).toContain(`[${backdrop.ref}] backdrop of dialog "Get 10% off your first order" — a click outside the dialog lands on it`)
    expect(rendered).not.toMatch(/backdrop.*\(behind the modal\)/)
    expect(rendered.indexOf(`[${backdrop.ref}] backdrop`)).toBeLessThan(rendered.indexOf('IN VIEW'))
    const continueButton = only(obs, (e) => e.role === 'button' && e.name === 'Continue', 'Continue')
    expect(continueButton.coveredBy).toBe(`the backdrop [${backdrop.ref}] of dialog "Get 10% off your first order"`)
  }, 60000)
})

describe('refs for draggable, focusable and right-click targets (E4)', () => {
  it('lists draggable list items and a context-menu card with what they answer to', async () => {
    const { observe } = await openObserver('pointer.html')
    const obs = await observe()
    const items = obs.elements.filter((e) => e.itemRole === 'listitem' && e.actionable?.draggable)
    expect(items.map((e) => e.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])
    expect(items.every((e) => e.actionable?.focusable)).toBe(true)
    const card = only(obs, (e) => e.cssLabel === 'div#ctx-card.ctx-card', 'card')
    expect(card.actionable).toEqual({ focusable: true, listens: ['contextmenu'] })
    const all = renderObservation(obs, { all: true })
    expect(all).toContain(`[${items[4].ref}] draggable focusable listitem "Echo"`)
    expect(all).toContain(`[${card.ref}] focusable div#ctx-card.ctx-card "Quarterly report`)
    expect(all).toContain(`(listens for contextmenu — right-click: act.click(${card.ref}, { button: 'right' }))`)
    // The list's own listeners (dragstart, keydown on the <ul>) do not make the list a target of its own.
    expect(obs.elements.some((e) => e.cssLabel === 'ul#sortable.sortable')).toBe(false)
  }, 60000)

  it('lets a human-mode model right-click the card by its ref and archive it (PTR-T5)', async () => {
    const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
    executors.push(executor)
    const loaded = await executor.execute(`await page.goto('${baseUrl}/pointer.html', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const look = await executor.execute('await find("Quarterly report")', 30000)
    const card = /\[(\d+)\] focusable div#ctx-card\.ctx-card/.exec(look.text)
    expect(card, look.text).not.toBeNull()
    const opened = await executor.execute(`await act.click(${card![1]}, { button: 'right' })`, 60000)
    expect(opened.isError, opened.text).toBe(false)
    // The page's own menu opened at the pointer, its first item focused.
    expect(opened.text).toMatch(/\[\d+\] menuitem "Open" \[focused\]/)
    expect(opened.text).toMatch(/\[\d+\] menuitem "Archive"/)
    // The lab menu opens where the pointer is and never moves up, so near the window's bottom edge
    // "Archive" can hang below it (then no click reaches it); its keys always do: Arrow Up wraps to it.
    const up = await executor.execute(`await act.press('ArrowUp')`, 60000)
    expect(up.text).toMatch(/menuitem "Open" .*→ \[\d+\] menuitem "Archive"/)
    const archived = await executor.execute(`await act.press('Enter')`, 60000)
    expect(archived.isError, archived.text).toBe(false)
    expect(archived.text).toContain('Archived: Quarterly report')
    const after = await executor.execute('await find("Quarterly report (Archived)")', 30000)
    expect(after.text).toContain('text: "Quarterly report (Archived)"')
  }, 180000)

  it("reads the card's listener in human and debug mode alike (observe's own read-only CDP calls)", async () => {
    for (const policy of ['human', 'debug'] as const) {
      const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
      executors.push(executor)
      const loaded = await executor.execute(`await page.goto('${baseUrl}/pointer.html', { waitUntil: 'load' })`, 30000)
      expect(loaded.isError, loaded.text).toBe(false)
      const look = await executor.execute('await find("Quarterly report")', 30000)
      expect(look.text, policy).toMatch(/\[\d+\] focusable div#ctx-card\.ctx-card .*\(listens for contextmenu/)
    }
  }, 120000)
})

describe('images inside controls are part of them (C8)', () => {
  it('lists no icon of a named button, link, tab or radio label as an image of its own', async () => {
    const { observe } = await openObserver('icons.html')
    const obs = await observe()
    const rendered = renderObservation(obs)
    for (const line of ['button "Star this repository"', 'button "More actions"', 'button "Notifications"', 'tab "Code" [selected]', 'link "Ada Lovelace" → /users/ada', 'link "Home" → /']) {
      expect(rendered).toContain(`] ${line}`)
    }
    expect(only(obs, (e) => e.role === 'radio', 'radio').name).toBe('Visa card ending 4242')
    // The images left are the two content images: one without alt, by its address, one by its alt.
    expect(obs.elements.filter((e) => e.role === 'image' || e.role === 'img').map((e) => e.noAlt?.src ?? e.name)).toEqual(['/lab/chart.svg', 'Quarterly sales chart'])
    expect(rendered).not.toMatch(/\] image "(More actions|Notifications|Code|Ada Lovelace|Company logo|Visa|Swirl)"/)
    // Decoration (alt="", aria-hidden, role=presentation/none) is never listed; a nameless SVG is counted.
    expect(rendered).toContain('IMAGES 1 decorative image (alt="") not listed')
    expect(obs.unnamedGraphics).toBe(1)
    expect(rendered).toContain('IMAGES 1 unnamed graphic (inline <svg>/canvas/role=img with no title or label) not listed')
  }, 60000)

  it("keeps the table's \"More actions\" button named, with no image line, in observe and the snapshot", async () => {
    const { page, observe } = await openObserver('table.html')
    const obs = await observe()
    expect(obs.elements.filter((e) => e.role === 'image' || e.role === 'img')).toEqual([])
    expect(obs.elements.filter((e) => e.role === 'button' && e.name === 'More actions')).toHaveLength(6)
    const { snapshot } = await getAriaSnapshot({ page, interactiveOnly: true })
    expect(snapshot).not.toMatch(/image|img/)
    expect(snapshot).toContain('role=button[name="More actions"] >> nth=5 [collapsed] [haspopup=menu]')
  }, 60000)

  it("still lists a11y.html's chart without alt, and no image for the unnamed trash button", async () => {
    const { observe } = await openObserver('a11y.html')
    const obs = await observe()
    expect(obs.elements.filter((e) => e.role === 'image' || e.role === 'img').map((e) => e.noAlt?.src)).toEqual(['/lab/chart.svg'])
    expect(only(obs, (e) => e.role === 'button', 'trash button').name).toBe('')
  }, 60000)
})

describe('popups open in a row are not its words (C9)', () => {
  it("keeps the Initech row's text and context when its More actions menu opens", async () => {
    const { page, observe } = await openObserver('table.html')
    const before = await observe()
    const initech = 'in row "INV-1003 Initech 2026-01-19 $2,400.00 Overdue"'
    await page.click('#rows tr:nth-child(3) button[data-action="more"]')
    const after = await observe(before)
    const rowText = after.text.filter((t) => t.text.includes('INV-1003'))
    expect(rowText.map((t) => t.text)).toEqual(['INV-1003 | Initech | 2026-01-19 | $2,400.00 | Overdue | Edit Delete More actions'])
    expect(renderObservation(after)).toContain('row: "INV-1003 | Initech | 2026-01-19 | $2,400.00 | Overdue | Edit Delete More actions"\n')
    expect(findInObservation(after, 'Initech')).not.toContain('Actions for')
    const markPaid = only(after, (e) => e.role === 'menuitem' && e.name === 'Mark as paid', 'Mark as paid')
    expect(markPaid.contextBasis?.container).toBe(initech)
    // The report says the button expanded, and nothing about the row's words changing.
    const report = renderObservationDiff(diffObservations(before, after))
    expect(report).not.toMatch(/INV-1003[^\n]*→[^\n]*Actions for/)
  }, 60000)

  it("leaves a tooltip and a menu out of their list item's words, and reads the tooltip on its own", async () => {
    const { page, observe } = await openObserver('delegation.html')
    await page.click('#info-1001')
    await page.click('#more-1002')
    const obs = await observe()
    const items = obs.text.filter((t) => t.text.startsWith('Order'))
    expect(items.map((t) => t.text)).toEqual(['Order 1001', 'Order 1002'])
    expect(obs.text.some((t) => t.role === 'tooltip' && t.text === 'Ships tomorrow')).toBe(true)
    const cancels = obs.elements.filter((e) => e.role === 'button' && e.name === 'Cancel').map((e) => e.context)
    expect(cancels).toEqual(['in listitem "Order 1001"', 'in listitem "Order 1002"'])
  }, 60000)
})

describe('click delegation containers are not controls (C10)', () => {
  it("lists no clickable for table.html's tbody#rows and pager", async () => {
    const { observe } = await openObserver('table.html')
    const obs = await observe()
    expect(obs.elements.filter((e) => e.role === 'clickable').map((e) => e.cssLabel)).toEqual([])
  }, 60000)

  it("keeps pointer.html's slider track, a press surface around its one thumb, and drops the menubar around its button", async () => {
    const { observe } = await openObserver('pointer.html')
    const obs = await observe()
    const clickables = obs.elements.filter((e) => e.role === 'clickable').map((e) => e.cssLabel)
    expect(clickables).toContain('div#slider.slider')
    expect(clickables).not.toContain('ul.menubar')
  }, 60000)

  it('lists the items of a delegating list, keeps a div button and a custom element, and drops a card around a button', async () => {
    const { observe } = await openObserver('delegation.html')
    const obs = await observe()
    const clickables = obs.elements.filter((e) => e.role === 'clickable')
    expect(clickables.map((e) => `${e.cssLabel} "${e.name}"`)).toEqual([
      'li.fruit "Apple"',
      'li.fruit "Banana"',
      'li.fruit "Cherry"',
      'li.fruit "Damson"',
      'div#subscribe.fake-button "Subscribe"',
      'x-chip#beta "Beta"',
    ])
    const rendered = renderObservation(obs)
    expect(rendered).toContain(`[${clickables[1].ref}] clickable listitem "Banana" (its click reaches the click listener of ul#fruits.pick)`)
    expect(rendered).toContain(`[${clickables[4].ref}] clickable div#subscribe.fake-button "Subscribe"`)
    expect(rendered).not.toContain('div#card.card')
    expect(rendered).toMatch(/\[\d+\] button "Save"/)
  }, 60000)

  it('lets a human-mode model click a delegated item by its ref', async () => {
    const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy: 'human' })
    executors.push(executor)
    const loaded = await executor.execute(`await page.goto('${baseUrl}/delegation.html', { waitUntil: 'load' })`, 30000)
    expect(loaded.isError, loaded.text).toBe(false)
    const look = await executor.execute('await find("Banana")', 30000)
    const banana = /\[(\d+)\] clickable listitem "Banana"/.exec(look.text)
    expect(banana, look.text).not.toBeNull()
    const clicked = await executor.execute(`await act.click(${banana![1]})`, 60000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toContain('Picked Banana')
  }, 120000)
})

describe('images nobody can see are not listed (F9)', () => {
  it('lists the chart without alt and the icon, not the spacers or the tracking pixels, in observe and the snapshot', async () => {
    const { page, observe } = await openObserver('spacer.html')
    const obs = await observe()
    const images = obs.elements.filter((e) => e.role === 'image' || e.role === 'img')
    expect(images.map((e) => e.noAlt?.src ?? e.name)).toEqual(['/lab/chart.svg', 'Status OK'])
    // The 1×1 alt="" pixel is not counted as decoration either: there is nothing to see.
    expect(obs.decorativeImages).toBeUndefined()
    expect(obs.unnamedGraphics).toBeUndefined()
    const { snapshot } = await getAriaSnapshot({ page })
    expect(snapshot.match(/role=image|- image/g), snapshot).toHaveLength(2)
    // Not listed as an image (its cell still carries the alt as its Chromium name: a known limit).
    expect(snapshot).not.toContain('image "tracking"')
  }, 60000)

  it("lists the Hacker News logo inside its link and none of the page's spacer images", async () => {
    const { page, observe } = await openObserver('hacker-news.html')
    const obs = await observe()
    expect(obs.elements.filter((e) => e.role === 'image' || e.role === 'img').map((e) => e.box && `${e.box.width}×${e.box.height}`)).toEqual(['20×20'])
    expect(obs.unnamedGraphics).toBeUndefined()
    const { snapshot } = await getAriaSnapshot({ page })
    expect(snapshot.match(/role=image/g)).toHaveLength(1)
  }, 60000)
})
