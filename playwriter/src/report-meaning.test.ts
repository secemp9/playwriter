/**
 * The "what changed" report by meaning, and find() by phrase — pure tests on constructed
 * observations, every assertion on the exact text a model reads:
 *  - rows and controls a page re-rendered with the same content (new DOM nodes, same role, name,
 *    text and state) are not reported as `-`/`+` pairs; controls that got new refs say which;
 *  - the double-post warning counts identical new items in ONE container (a list, a log, a table),
 *    so three tables each showing "(empty)" are not a duplicate, two identical messages in one log are;
 *  - find() lists exact phrase matches (case and whitespace normalised) and falls back to matches of
 *    every word only when no exact one exists, saying they are approximate.
 */

import { describe, expect, it } from 'vitest'
import type { NodeKey } from './page-model.js'
import { renderActionReport, type ActionReportInput } from './human-actions.js'
import { diffObservations, findInObservation, renderObservationDiff, type Observation, type ObservationDiff, type ObservedElement, type TextBlock } from './page-observe.js'

function el(ref: number, key: number, role: string, name: string, extra: Partial<ObservedElement> = {}): ObservedElement {
  return {
    ref,
    key: `F:${key}` as NodeKey,
    backendNodeId: key,
    frameId: 'F',
    role,
    name,
    tag: 'button',
    visibility: 'in-view',
    box: { x: 10, y: key, width: 100, height: 20 },
    order: key,
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
    url: 'http://127.0.0.1:47101/storage.html',
    targetId: 'T1',
    title: 'Storage · Browser Lab',
    documentId: 'doc-1',
    viewport: { width: 1280, height: 720 },
    scroll: { y: 0, maxY: 0, screensAbove: 0, screensBelow: 0 },
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

const COOKIES = { key: 'F:1' as NodeKey, label: 'table "Cookies"' }
const LOCAL = { key: 'F:2' as NodeKey, label: 'table "localStorage"' }
const SESSION = { key: 'F:3' as NodeKey, label: 'table "sessionStorage"' }

function report(after: Observation, diff: ObservationDiff | null): string {
  const input: ActionReportInput = { records: [], rawInputs: [], settle: null, events: null, after, diff, newTabs: [], downloads: [], fileDialogs: [] }
  return renderActionReport(input)
}

describe('what changed, by meaning', () => {
  it('rows re-rendered with the same content are not reported; the new and the gone ones are', () => {
    const before = observation({
      text: [
        text(100, 'row', 'session | ada', { region: 'main', container: COOKIES }),
        text(110, 'row', 'auth-token | tok_ada_2026', { region: 'main', container: LOCAL }),
        text(120, 'row', 'auth-user | ada', { region: 'main', container: SESSION }),
      ],
    })
    // The page replaced every tbody's rows: new nodes (new keys), most of them saying the same.
    const after = observation({
      text: [
        text(200, 'row', 'session | ada', { region: 'main', container: COOKIES, isNew: true }),
        text(201, 'row', 'theme | dark', { region: 'main', container: COOKIES, isNew: true }),
        text(210, 'row', 'auth-token | tok_ada_2026', { region: 'main', container: LOCAL, isNew: true }),
        text(220, 'row', '(empty)', { region: 'main', container: SESSION, isNew: true }),
      ],
    })
    const rendered = renderObservationDiff(diffObservations(before, after))
    expect(rendered).toMatch(/^\+ row: "theme \| dark"$/m)
    expect(rendered).toMatch(/^\+ row: "\(empty\)"$/m)
    expect(rendered).toMatch(/^- row: "auth-user \| ada"$/m)
    expect(rendered).not.toMatch(/session \| ada/)
    expect(rendered).not.toMatch(/auth-token/)
    expect(rendered).toMatch(/^~ re-rendered with the same content: 2 text blocks \(not listed\)$/m)
  })

  it('a row that moved to another table is a change, not a re-render', () => {
    const before = observation({ text: [text(100, 'row', 'lab-step | 2', { region: 'main', container: LOCAL })] })
    const after = observation({ text: [text(200, 'row', 'lab-step | 2', { region: 'main', container: SESSION })] })
    const rendered = renderObservationDiff(diffObservations(before, after))
    expect(rendered).toMatch(/^\+ row: "lab-step \| 2"$/m)
    expect(rendered).toMatch(/^- row: "lab-step \| 2"$/m)
  })

  it('rows re-rendered unchanged in a table whose caption changed are not reported (the table node stayed)', () => {
    const invoices = { key: 'F:1' as NodeKey, label: 'table "Showing 1–6 of 12 invoices"' }
    const renamed = { key: 'F:1' as NodeKey, label: 'table "Showing 1–6 of 11 invoices"' }
    const before = observation({
      text: [
        text(1, 'table', 'Showing 1–6 of 12 invoices', { region: 'main' }),
        text(100, 'row', 'INV-1001 | Acme Corp', { region: 'main', container: invoices }),
        text(101, 'row', 'INV-1003 | Initech', { region: 'main', container: invoices }),
      ],
    })
    const after = observation({
      text: [
        text(1, 'table', 'Showing 1–6 of 11 invoices', { region: 'main' }),
        text(200, 'row', 'INV-1001 | Acme Corp', { region: 'main', container: renamed, isNew: true }),
        text(201, 'row', 'INV-1007 | Hooli', { region: 'main', container: renamed, isNew: true }),
      ],
    })
    const rendered = renderObservationDiff(diffObservations(before, after))
    expect(rendered).toMatch(/^~ table "Showing 1–6 of 11 invoices" \(was "Showing 1–6 of 12 invoices"\)$/m)
    expect(rendered).toMatch(/^- row: "INV-1003 \| Initech"$/m)
    expect(rendered).toMatch(/^\+ row: "INV-1007 \| Hooli"$/m)
    expect(rendered).not.toMatch(/Acme/)
    expect(rendered).toMatch(/^~ re-rendered with the same content: 1 text block \(not listed\)$/m)
  })

  it('controls re-rendered with the same content are one line naming their new refs', () => {
    const before = observation({
      elements: [el(12, 112, 'button', 'Delete', { context: 'in row "Initech"', container: COOKIES }), el(13, 113, 'button', 'Delete', { context: 'in row "Globex"', container: COOKIES })],
    })
    const after = observation({
      elements: [
        el(31, 131, 'button', 'Delete', { context: 'in row "Initech"', container: COOKIES, isNew: true }),
        el(32, 132, 'button', 'Delete', { context: 'in row "Globex"', container: COOKIES, isNew: true, states: { disabled: true } }),
      ],
    })
    const rendered = renderObservationDiff(diffObservations(before, after))
    expect(rendered).toMatch(/^~ re-rendered with the same content: 1 control under a new ref: \[12\]→\[31\] button "Delete" \(in row "Initech"\)$/m)
    // Its state changed: that one is a real change, reported as gone and new.
    expect(rendered).toMatch(/^- \[13\] button "Delete" \(in row "Globex"\) \(gone\)$/m)
    expect(rendered).toMatch(/^\+ \[32\] button "Delete"/m)
    expect(rendered).not.toMatch(/\[12\] button "Delete" \(in row "Initech"\) \(gone\)/)
  })
})

describe('possible duplicate warning', () => {
  it('three tables each showing "(empty)" are not a duplicate', () => {
    const before = observation({
      text: [
        text(100, 'row', 'theme | dark', { container: COOKIES }),
        text(110, 'row', 'lab-pref | compact', { container: LOCAL }),
        text(120, 'row', 'lab-step | 2', { container: SESSION }),
      ],
    })
    const after = observation({
      text: [
        text(200, 'row', '(empty)', { container: COOKIES, isNew: true }),
        text(210, 'row', '(empty)', { container: LOCAL, isNew: true }),
        text(220, 'row', '(empty)', { container: SESSION, isNew: true }),
      ],
    })
    expect(report(after, diffObservations(before, after))).not.toMatch(/possible duplicate/)
  })

  it('rows re-rendered unchanged are not "new" for the warning', () => {
    const before = observation({ text: [text(100, 'row', 'ada | admin', { container: COOKIES }), text(101, 'row', 'ada | admin', { container: COOKIES })] })
    const after = observation({ text: [text(200, 'row', 'ada | admin', { container: COOKIES, isNew: true }), text(201, 'row', 'ada | admin', { container: COOKIES, isNew: true })] })
    expect(report(after, diffObservations(before, after))).not.toMatch(/possible duplicate/)
  })

  it('two identical new messages in one log are still a possible duplicate', () => {
    const log = { key: 'F:9' as NodeKey, label: 'log "Conversation"' }
    const before = observation({ text: [text(100, 'text', 'Hi team', { container: log })] })
    const after = observation({
      text: [
        text(100, 'text', 'Hi team', { container: log }),
        text(200, 'text', 'Ship it tonight', { container: log, isNew: true }),
        text(201, 'text', 'Ship it tonight', { container: log, isNew: true }),
      ],
    })
    expect(report(after, diffObservations(before, after))).toMatch(/⚠ possible duplicate: 2 identical new text "Ship it tonight" appeared in log "Conversation" — was something submitted twice\?/)
  })
})

describe('find by phrase', () => {
  const chat = observation({
    text: [
      text(1, 'text', 'Message 1 — Maya: Welcome to #general! Please read the pinned rules.'),
      ...[10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 31].map((n) => text(1 + n, 'text', `Message ${n} — Sam: status update number ${n}.`)),
    ],
  })

  it('an exact phrase lists only what contains it', () => {
    const found = findInObservation(chat, 'Message 1 —')
    expect(found.split('\n')[0]).toBe('1 match for "Message 1 —":')
    expect(found).toMatch(/Message 1 — Maya/)
    expect(found).not.toMatch(/Message 10/)
  })

  it('case and whitespace do not matter for an exact phrase', () => {
    expect(findInObservation(chat, '  MESSAGE   1 —  ').split('\n')[0]).toBe('1 match for "MESSAGE 1 —":')
  })

  it('without an exact phrase, matches of every word are listed as approximate', () => {
    const found = findInObservation(chat, 'welcome rules')
    expect(found.split('\n')[0]).toBe('No exact match for "welcome rules". 1 approximate match (every word found, not as one phrase):')
    expect(found).toMatch(/Message 1 — Maya/)
  })
})
