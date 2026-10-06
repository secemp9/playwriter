/**
 * Pure tests for what the model is told: rendering (viewport first, states, where
 * things are, the modal, scroll areas, the budget), the "what changed" diff and find — all on
 * constructed observations, so every line asserted is the exact text a model reads.
 */

import { describe, expect, it } from 'vitest'
import type { NodeKey } from './page-model.js'
import {
  diffObservations,
  findInObservation,
  liveContext,
  renderObservation,
  renderObservationDiff,
  type Observation,
  type ObservedElement,
  type ObservedScroller,
  type TextBlock,
} from './page-observe.js'

const VIEWPORT_H = 720

function el(ref: number, role: string, name: string, extra: Partial<ObservedElement> = {}): ObservedElement {
  return {
    ref,
    key: `F:${100 + ref}` as NodeKey,
    backendNodeId: 100 + ref,
    frameId: 'F',
    role,
    name,
    tag: role === 'link' ? 'a' : role === 'textbox' ? 'input' : 'button',
    visibility: 'in-view',
    box: { x: 10, y: ref * 20, width: 100, height: 20 },
    order: ref * 10,
    ...extra,
  }
}

function text(key: number, role: string, value: string, extra: Partial<TextBlock> = {}): TextBlock {
  return {
    key: `F:${key}` as NodeKey,
    frameId: 'F',
    role,
    text: value,
    visibility: 'in-view',
    order: key,
    box: { x: 10, y: key, width: 300, height: 20 },
    ...extra,
  }
}

function observation(extra: Partial<Observation> = {}): Observation {
  return {
    takenAt: 0,
    url: 'http://localhost:3030/',
    targetId: 'T1',
    title: 'Shop — Home',
    documentId: 'doc-1',
    viewport: { width: 1280, height: VIEWPORT_H },
    scroll: { y: 0, maxY: 1656, screensAbove: 0, screensBelow: 2.3 },
    scrollers: [],
    busy: [],
    jsDialog: null,
    live: [],
    elements: [],
    text: [],
    absent: [],
    counts: { interactive: 0, inView: 0, above: 0, below: 0 },
    frames: { total: 1, observed: 1 },
    ...extra,
  }
}

function shop(): Observation {
  return observation({
    tabs: [
      { index: 0, title: 'Shop — Home', url: 'http://localhost:3030/', controlled: true },
      { index: 1, title: 'Docs', url: 'http://localhost:3030/docs', controlled: false },
    ],
    focused: 2,
    busy: [{ strength: 'strong', kind: 'progressbar', label: 'progressbar "Uploading"' }],
    live: [{ key: 'F:70' as NodeKey, role: 'alert', name: '', text: 'Payment failed: card declined', latest: 'Payment failed: card declined' }],
    elements: [
      el(1, 'link', 'Home', { href: 'http://localhost:3030/', region: 'banner' }),
      el(2, 'searchbox', 'Search products', { states: { focused: true }, value: 'wireless mouse', region: 'banner' }),
      el(9, 'checkbox', 'In stock only', { states: { checked: true }, region: 'main' }),
      el(12, 'button', 'Add to cart', { region: 'main', context: 'in listitem "Logitech M185"' }),
      el(13, 'button', 'Add to cart', { region: 'main', context: 'in listitem "MX Master"', isNew: true }),
      el(20, 'clickable', 'Free shipping over $50', { tag: 'div', cssLabel: 'div.card', region: 'main' }),
      el(21, 'img', 'Product photo', { tag: 'img', region: 'main', image: { loaded: false, broken: true, naturalWidth: 0, naturalHeight: 0 } }),
      el(23, 'button', 'Checkout', { region: 'main', visibility: 'partly-covered', coveredBy: 'iframe#chat-widget', coveredFraction: 0.4 }),
      el(30, 'button', 'Load more', { region: 'main', visibility: 'below', box: { x: 10, y: 1500, width: 100, height: 20 } }),
      el(31, 'link', 'Privacy', { region: 'contentinfo', visibility: 'below', box: { x: 10, y: 1700, width: 100, height: 20 } }),
      el(40, 'button', 'Deep option', { region: 'main', visibility: 'clipped' }),
      el(41, 'button', 'Ghost', { region: 'main', visibility: 'hidden' }),
    ],
    text: [
      text(85, 'heading', 'Results', { level: 1, region: 'main' }),
      text(150, 'text', 'Showing 24 results for wireless mouse', { region: 'main' }),
      text(900, 'heading', 'Reviews', { level: 2, region: 'main', visibility: 'below', box: { x: 0, y: 864, width: 300, height: 30 } }),
      text(1800, 'heading', 'Related', { level: 2, region: 'main', visibility: 'below', box: { x: 0, y: 1728, width: 300, height: 30 } }),
    ],
    counts: { interactive: 12, inView: 8, above: 0, below: 2 },
  })
}

const LONG_REPLY =
  'Sure — here is what I found about the Logitech M185. It is a compact wireless mouse with a USB nano receiver, ' +
  'a battery life of about twelve months, and it works with Windows, macOS and ChromeOS. The current price is $14.99 ' +
  'and it ships tomorrow from the Lyon warehouse.'

describe('renderObservation', () => {
  it('prints the page header, tabs, signals, focus and the viewport grouped by region', () => {
    const rendered = renderObservation(shop())
    expect(rendered).toBe(
      [
        'PAGE  Shop — Home · http://localhost:3030/',
        'TABS  0: "Shop — Home" (controlled) · 1: "Docs" — act.switchTab(n) works in another',
        '      viewport 1280×720 · top of page, 2.3 screens below',
        'BUSY  progressbar "Uploading" (wait before acting)',
        'FOCUS [2] searchbox "Search products" [focused] = "wireless mouse"',
        'LIVE  alert: "Payment failed: card declined"',
        'IN VIEW',
        'banner',
        '  [1] link "Home" → /',
        '  [2] searchbox "Search products" [focused] = "wireless mouse"',
        'main',
        '  heading "Results" [level=1]',
        '  [9] checkbox "In stock only" [checked]',
        '  [12] button "Add to cart" (in listitem "Logitech M185")',
        '  *[13] button "Add to cart" (in listitem "MX Master")',
        '  text: "Showing 24 results for wireless mouse"',
        '  [20] clickable div.card "Free shipping over $50"',
        '  [21] img "Product photo" BROKEN (did not load)',
        '  [23] button "Checkout" partly covered by iframe#chat-widget (40%)',
        'BELOW  2 more controls · headings: "Reviews" (1.2 screens down), "Related" (2.4)',
        'CLIPPED 1 control cut off by a container around them: [40] button "Deep option"',
        '      observe({ all: true }) lists them; find("text") searches everything',
        '* = new since your last observe',
      ].join('\n'),
    )
  })

  it('lists off-screen and hidden elements with all: true', () => {
    const rendered = renderObservation(shop(), { all: true })
    expect(rendered).toContain('BELOW (scroll down to reach)\n  [30] button "Load more" (2.1 screens down)  — main')
    expect(rendered).toContain('  [31] link "Privacy" (2.4 screens down)  — contentinfo')
    expect(rendered).toContain('CLIPPED (cut off by a container around them; act.scrollTo(ref) when it scrolls)\n  [40] button "Deep option"  — main')
    expect(rendered).toContain('HIDDEN (not visible; cannot be used now)\n  [41] button "Ghost"  — main')
    expect(rendered).toContain('  heading "Reviews" [level=2]  — main')
  })

  it('puts the modal and its controls first and marks the rest as behind it', () => {
    const base = shop()
    const obs: Observation = {
      ...base,
      busy: [],
      live: [],
      focused: undefined,
      tabs: undefined,
      modal: { ref: 50, role: 'dialog', name: 'Cookie consent' },
      elements: [
        ...base.elements.map((e) => (e.visibility === 'in-view' ? { ...e, visibility: 'covered' as const, coveredBy: 'div.backdrop' } : e)),
        el(51, 'button', 'Accept all', { region: 'dialog "Cookie consent"', inModal: true, inside: [50], order: 5000 }),
      ],
      text: [...base.text, text(4990, 'text', 'We use cookies', { inModal: true, inside: [50], region: 'dialog "Cookie consent"' })],
    }
    const rendered = renderObservation(obs)
    const lines = rendered.split('\n')
    expect(lines.slice(2, 5)).toEqual([
      'MODAL dialog "Cookie consent" [50] — only its controls work right now:',
      '  text: "We use cookies"',
      '  [51] button "Accept all"',
    ])
    expect(rendered).toContain('  [9] checkbox "In stock only" [checked] (behind the modal)')
    expect(rendered).not.toMatch(/IN VIEW[\s\S]*Accept all/)

    const scoped = renderObservation(obs, { scope: 50 })
    expect(scoped).toContain('SCOPE only inside [50] dialog "Cookie consent"')
    expect(scoped).toContain('[51] button "Accept all"')
    expect(scoped).not.toContain('In stock only')
  })

  it('lists an iframe as a line with its content nested under it, and names the iframe of off-screen items', () => {
    const pay = { frameId: 'F', url: 'http://127.0.0.1:3031/pay', controls: 2, documentId: 'pay-doc' }
    const obs = observation({
      elements: [
        el(1, 'button', 'Behind', { region: 'main', visibility: 'covered', coveredBy: 'iframe "Consent" [4]', coveredFraction: 1, order: 10 }),
        el(2, 'iframe', 'Secure card payment', { region: 'main', frame: { ...pay, frameId: 'PAY' }, order: 20 }),
        el(3, 'textbox', 'Card number', { frameId: 'PAY', key: 'PAY:5' as NodeKey, inside: [2], order: 21 }),
        el(5, 'button', 'Pay', { frameId: 'PAY', key: 'PAY:6' as NodeKey, inside: [2], visibility: 'below', order: 23 }),
        el(4, 'iframe', 'Ads', { frame: { frameId: 'ADS', url: 'http://ads.test/', controls: 0, unread: 'the iframe is hidden, so nothing in it can be seen or used' }, visibility: 'hidden', order: 30 }),
      ],
      text: [text(22, 'text', 'Pay with card', { frameId: 'PAY', inside: [2] })],
      frames: { total: 3, observed: 2 },
    })
    const rendered = renderObservation(obs)
    expect(rendered).toContain('      1 of 2 iframes not read — each one\'s line says why (observe({ all: true }) lists hidden ones too)')
    expect(rendered).toContain(
      [
        'main',
        '  [1] button "Behind" covered by iframe "Consent" [4] (100%) — a click would hit that instead',
        '  [2] iframe "Secure card payment" — 2 controls',
        '    [3] textbox "Card number"',
        '    text: "Pay with card"',
      ].join('\n'),
    )
    const all = renderObservation(obs, { all: true })
    expect(all).toContain('  [5] button "Pay" (0.1 screens down) · in iframe [2]')
    expect(all).toContain('HIDDEN (not visible; cannot be used now)\n  [4] iframe "Ads" — not read: the iframe is hidden, so nothing in it can be seen or used')
    expect(renderObservation(obs, { scope: 2 })).toContain('[3] textbox "Card number"')
    expect(findInObservation(obs, 'card number')).toContain('[3] textbox "Card number" — in view · in iframe [2]')
  })

  it('says what to do when a native dialog is open, and invents nothing it could not read', () => {
    const frozen = observation({ jsDialog: { type: 'confirm', message: 'Delete 3 items?', openedAt: 1, handling: 'agent' } })
    delete frozen.title
    delete frozen.viewport
    delete frozen.scroll
    expect(renderObservation(frozen)).toBe(
      [
        'PAGE  (title not readable while the dialog is open) · http://localhost:3030/',
        '      viewport and scroll position not readable while the dialog is open',
        'DIALOG native confirm "Delete 3 items?"',
        '      The page is frozen until it is answered: act.dialog.accept() or act.dialog.dismiss().',
        '      Nothing else on the page can be read or used while it is open.',
      ].join('\n'),
    )
  })

  it('keeps whole texts and cuts only when printing, saying how much was left out', () => {
    const obs = observation({ text: [text(10, 'paragraph', LONG_REPLY)] })
    const line = renderObservation(obs).split('\n').find((candidate) => candidate.startsWith('text:'))!
    expect(line).toBe(`text: "${LONG_REPLY.slice(0, 159)}…" (+${LONG_REPLY.length - 159} chars)`)
  })

  it('describes what a field takes: date format, range, file input, constraints, error and description', () => {
    const obs = observation({
      elements: [
        el(1, 'date', 'Arrival', { tag: 'input', widget: { type: 'date', min: '2024-01-01', max: '2024-12-31' } }),
        el(2, 'slider', 'Volume', { tag: 'input', states: { valueMin: 0, valueMax: 100 }, value: '30', widget: { type: 'range', step: '5' } }),
        el(3, 'textbox', 'Email', {
          tag: 'input',
          states: { invalid: true, required: true, description: 'We never share it' },
          errorText: 'Enter a valid email address',
          widget: { type: 'email', placeholder: 'you@example.com', maxLength: 64 },
        }),
        el(4, 'textbox', 'Message', { tag: 'textarea', states: { multiline: true }, widget: { type: '' } }),
        el(5, 'combobox', 'City', { tag: 'input', states: { autocomplete: 'list', expanded: true }, activeRef: 7, widget: { type: 'text' } }),
        el(6, 'button', 'Upload CV', { tag: 'input', widget: { type: 'file', accept: '.pdf,.docx', multiple: true } }),
      ],
    })
    const lines = renderObservation(obs).split('\n')
    expect(lines).toContain('[1] date "Arrival" [range 2024-01-01–2024-12-31] (takes YYYY-MM-DD: act.fill(1, "YYYY-MM-DD"))')
    expect(lines).toContain('[2] slider "Volume" = "30" [range 0–100 step 5]')
    expect(lines).toContain(
      '[3] textbox "Email" [required] [invalid] type=email placeholder "you@example.com" max 64 chars error "Enter a valid email address" description "We never share it"',
    )
    expect(lines).toContain('[4] textbox "Message" [multiline]')
    expect(lines).toContain('[5] combobox "City" [expanded] [autocomplete=list] [active=[7]]')
    expect(lines).toContain('[6] button "Upload CV" (file input: its click opens a file dialog — act.upload(6, path)) accepts ".pdf,.docx" multiple')
  })

  it('lists inner scroll areas and counts what they hide there, not as page content below', () => {
    const inbox: ObservedScroller = {
      ref: 57,
      key: 'F:157' as NodeKey,
      backendNodeId: 157,
      role: 'scroll area',
      name: 'main.inbox',
      scrollTop: 0,
      scrollHeight: 3000,
      clientHeight: 600,
      screensAbove: 0,
      screensBelow: 4,
      visibility: 'in-view',
    }
    const obs = observation({
      scroll: { y: 0, maxY: 0, screensAbove: 0, screensBelow: 0 },
      scrollers: [inbox],
      elements: [
        el(1, 'link', 'Mail 1', { scroller: 57 }),
        el(2, 'link', 'Mail 40', { scroller: 57, visibility: 'below', box: { x: 0, y: 2400, width: 100, height: 20 } }),
      ],
      text: [text(5000, 'text', 'Older mail', { scroller: 57, visibility: 'below', box: { x: 0, y: 2500, width: 100, height: 20 } })],
    })
    const rendered = renderObservation(obs)
    expect(rendered).toContain('      viewport 1280×720 · the page itself does not scroll')
    expect(rendered).toContain(`SCROLL [57] scroll area "main.inbox" — top, 4 screens below (act.scroll(dir, { ref: 57 }))`)
    expect(rendered).toContain(`INSIDE [57] scroll area "main.inbox" — top, 4 screens below: 1 more control and 1 text block out of sight — act.scroll('down', { ref: 57 })`)
    expect(rendered).not.toContain('BELOW')
    expect(findInObservation(obs, 'mail 40')).toContain(
      '[2] link "Mail 40" — inside [57] scroll area "main.inbox", scrolled out of sight (act.scrollTo(ref), or act.scroll(dir, { ref: 57 }))',
    )
    expect(renderObservation(obs, { scope: 57 })).toContain('SCOPE only inside [57] scroll area "main.inbox"')
  })
})

describe('diffObservations / renderObservationDiff', () => {
  it('reports state, value, visibility, text and focus changes in document order', () => {
    const before = shop()
    const after: Observation = {
      ...before,
      focused: 9,
      elements: before.elements
        .filter((e) => e.ref !== 12)
        .map((e) => {
          if (e.ref === 9) return { ...e, states: { checked: false, focused: true as const } }
          if (e.ref === 2) return { ...e, states: undefined, value: 'wireless mouse pad' }
          if (e.ref === 23) return { ...e, visibility: 'in-view' as const, coveredBy: undefined, coveredFraction: undefined }
          if (e.ref === 41) return { ...e, visibility: 'in-view' as const }
          if (e.ref === 30) return { ...e, visibility: 'in-view' as const }
          return e
        })
        .concat(el(60, 'button', 'Undo', { region: 'main' })),
      text: [
        ...before.text,
        text(1990, 'text', 'Added to cart', { region: 'main', live: 'status "Cart"' }),
        text(2000, 'paragraph', 'Your assistant says: the M185 ships tomorrow.', { region: 'main', visibility: 'below', box: { x: 0, y: 1440, width: 300, height: 20 } }),
      ],
    }
    const diff = diffObservations(before, after)
    expect(diff.newDocument).toBe(false)
    expect(diff.removed.map((e) => e.ref)).toEqual([12])
    expect(diff.added.map((e) => e.ref)).toEqual([60])
    expect(diff.changed.map((c) => c.element.ref)).toEqual([2, 9, 23, 41])
    expect(renderObservationDiff(diff)).toBe(
      [
        'FOCUS [2] searchbox "Search products" → [9] checkbox "In stock only"',
        '~ [2] searchbox "Search products": value "wireless mouse" → "wireless mouse pad"',
        '~ [9] checkbox "In stock only": [checked] → [unchecked]',
        '- [12] button "Add to cart" (in listitem "Logitech M185") (gone)',
        '~ [23] button "Checkout": no longer covered',
        '~ [41] button "Ghost": now shown (in view)',
        '+ [60] button "Undo" — in view',
        '+ text: "Added to cart" — in live region status "Cart"',
        '+ text: "Your assistant says: the M185 ships tomorrow." — below, 2 screens down (scroll down)',
      ].join('\n'),
    )
  })

  it('returns an empty string when nothing changed', () => {
    expect(renderObservationDiff(diffObservations(shop(), shop()))).toBe('')
  })

  it('reports a modal opening and text that changed in place', () => {
    const before = shop()
    const after: Observation = {
      ...before,
      modal: { ref: 50, role: 'dialog', name: 'Cookie consent' },
      text: before.text.map((t) => (t.role === 'text' ? { ...t, text: 'Showing 3 results for wireless mouse' } : t)),
    }
    expect(renderObservationDiff(diffObservations(before, after))).toBe(
      [
        'MODAL opened: dialog "Cookie consent" — only its controls work now',
        '~ text: "Showing 3 results for wireless mouse" (was "Showing 24 results for wireless mouse")',
      ].join('\n'),
    )
  })

  it('reports a streamed reply that grew past what is printed, with its new tail', () => {
    const start = LONG_REPLY.slice(0, 170)
    const before = observation({ text: [text(10, 'paragraph', start, { live: 'log "Conversation"' })] })
    const after = observation({ text: [text(10, 'paragraph', LONG_REPLY, { live: 'log "Conversation"' })] })
    expect(renderObservationDiff(diffObservations(before, after))).toBe(
      `~ text grew by ${LONG_REPLY.length - 170} chars: "${LONG_REPLY.slice(170)}" (now ${LONG_REPLY.length} chars) — in live region log "Conversation"`,
    )
  })

  it('never hides a real removal behind a modal, and counts only what went inert', () => {
    const before = observation({
      elements: [el(1, 'button', 'Delete', { context: 'in row "Alice"' }), el(2, 'button', 'Edit'), el(3, 'link', 'Help')],
      text: [text(400, 'text', 'Alice — admin')],
    })
    // Delete removed the row (gone from the DOM) and opened an Undo dialog; Edit and the
    // text are still in the DOM but inert behind it.
    const after = observation({
      modal: { ref: 9, role: 'dialog', name: 'Deleted' },
      elements: [el(3, 'link', 'Help'), el(10, 'button', 'Undo', { inModal: true, inside: [9] })],
      absent: [
        { key: 'F:102' as NodeKey, ref: 2, reason: 'inert', why: 'it is behind the modal dialog "Deleted" [9] — answer or close that first' },
        { key: 'F:400' as NodeKey, reason: 'inert', why: 'it is behind the modal dialog "Deleted" [9] — answer or close that first' },
      ],
    })
    const opened = diffObservations(before, after)
    expect(opened.removed.map((e) => e.ref)).toEqual([1])
    expect(opened.behindModal).toBe(2)
    expect(renderObservationDiff(opened)).toBe(
      [
        'MODAL opened: dialog "Deleted" — only its controls work now',
        '      2 controls and text blocks are now inert or behind it (still on the page, not gone) — observe() lists what works',
        '- [1] button "Delete" (in row "Alice") (gone)',
        '+ [10] button "Undo" — in view',
      ].join('\n'),
    )
    // Closing it brings Edit back (counted) and lists the row the dialog added (not folded in).
    const closed = observation({ elements: [el(2, 'button', 'Edit'), el(3, 'link', 'Help'), el(11, 'button', 'Restored row')], text: [text(400, 'text', 'Alice — admin')] })
    const back = diffObservations(after, closed)
    expect(back.backFromModal).toBe(2)
    expect(back.added.map((e) => e.ref)).toEqual([11])
    expect(back.removed.map((e) => e.ref)).toEqual([10])
  })

  it('says why a control went hidden, naming what shows it again', () => {
    const before = observation({ elements: [el(30, 'button', 'File'), el(31, 'menuitem', 'Rename')] })
    const after = observation({
      elements: [el(30, 'button', 'File', { states: { expanded: false } })],
      absent: [{ key: 'F:131' as NodeKey, ref: 31, reason: 'hidden', why: 'its button [30] "File" is collapsed — open it first (act.click(30))' }],
    })
    expect(renderObservationDiff(diffObservations(before, after))).toBe(
      [
        '~ [30] button "File": (no state) → [collapsed]',
        '~ [31] menuitem "Rename": now hidden: its button [30] "File" is collapsed — open it first (act.click(30))',
      ].join('\n'),
    )
  })

  it('reports an inner scroll area that moved', () => {
    const area: ObservedScroller = {
      ref: 57,
      key: 'F:157' as NodeKey,
      backendNodeId: 157,
      role: 'list',
      name: 'Inbox',
      scrollTop: 0,
      scrollHeight: 3000,
      clientHeight: 600,
      screensAbove: 0,
      screensBelow: 4,
      visibility: 'in-view',
    }
    const before = observation({ scrollers: [area] })
    const after = observation({ scrollers: [{ ...area, scrollTop: 840, screensAbove: 1.4, screensBelow: 2.6 }] })
    expect(renderObservationDiff(diffObservations(before, after))).toBe('SCROLL [57] list "Inbox" 0 → 840px (now 1.4 screens above, 2.6 below)')
  })

  it('says new document instead of an element diff after a navigation', () => {
    const after = { ...shop(), documentId: 'doc-2', url: 'http://localhost:3030/cart', title: 'Cart' }
    const diff = diffObservations(shop(), after)
    expect(diff.newDocument).toBe(true)
    expect(diff.added).toEqual([])
    expect(renderObservationDiff(diff)).toBe(
      'NEW DOCUMENT "Cart" · http://localhost:3030/cart — the page loaded a new document; every earlier ref is gone. 12 controls, 8 in view.',
    )
  })
})

describe('findInObservation', () => {
  it('searches names, values, hrefs, context and text, and says where each match is', () => {
    const obs = shop()
    expect(findInObservation(obs, 'add cart')).toBe(
      [
        '2 matches for "add cart":',
        '  [12] button "Add to cart" (in listitem "Logitech M185") — in view · main',
        '  [13] button "Add to cart" (in listitem "MX Master") — in view · main',
      ].join('\n'),
    )
    expect(findInObservation(obs, 'privacy')).toBe('1 match for "privacy":\n  [31] link "Privacy" — below, 2.4 screens down (scroll down) · contentinfo')
    expect(findInObservation(obs, 'reviews')).toContain('heading: "Reviews" — below, 1.2 screens down (scroll down) · main')
    expect(findInObservation(obs, 'wireless')).toContain('[2] searchbox "Search products" [focused] = "wireless mouse" — in view · banner')
    expect(findInObservation(obs, 'M185')).toContain('[12] button "Add to cart"')
    expect(findInObservation(obs, 'deep')).toContain('cut off by a container around it (act.scrollTo(ref) brings it into view when that container scrolls)')
  })

  it('finds words past what is printed and shows them in context', () => {
    const obs = observation({ text: [text(10, 'paragraph', LONG_REPLY, { live: 'log "Conversation"' })] })
    const at = LONG_REPLY.indexOf('Lyon')
    expect(findInObservation(obs, 'lyon warehouse')).toBe(
      [
        '1 match for "lyon warehouse":',
        `  text: (${at - 60} chars before) "…${LONG_REPLY.slice(at - 60)}" — in view · live region log "Conversation"`,
      ].join('\n'),
    )
  })

  it('says plainly when nothing matches, and caps long result lists', () => {
    expect(findInObservation(shop(), 'refund')).toBe(
      'No match for "refund" among the 12 controls and 4 text blocks observe() lists on this page (off-screen ones included; whole texts searched).',
    )
    const many = observation({ elements: Array.from({ length: 30 }, (_, i) => el(i + 1, 'link', `Item ${i + 1}`)) })
    const found = findInObservation(many, 'item', { limit: 5 })
    expect(found.split('\n')).toHaveLength(7)
    expect(found).toContain('… 25 more not shown')
  })
})

describe('liveContext', () => {
  it('recomputes the context in the kind the model was shown', () => {
    const obs = observation({
      elements: [
        el(1, 'button', 'Delete', { context: 'in row "Bob"', contextBasis: { container: 'in row "Bob"', heading: 'under heading "Team"' } }),
        el(2, 'button', 'Delete', { context: 'in row "Carol"', contextBasis: { container: 'in row "Carol"', heading: 'under heading "Team"' } }),
        el(3, 'button', 'Save', { contextBasis: { heading: 'under heading "Team"' } }),
      ],
    })
    expect(liveContext(obs, 1, 'in row "Alice"')).toBe('in row "Bob"')
    expect(liveContext(obs, 1, 'under heading "Team"')).toBe('under heading "Team"')
    expect(liveContext(obs, 2, '1st of 2')).toBe('2nd of 2')
    expect(liveContext(obs, 3, undefined)).toBeUndefined()
    expect(liveContext(obs, 3, '1st of 2')).toBeUndefined()
    expect(liveContext(obs, 99, undefined)).toBeUndefined()
  })
})
