/**
 * RefRegistry semantics: a ref names one element for the life of its document, survives
 * insertions around it, says "gone" (with a suggestion only when it is unambiguous), "hidden"
 * or "inert" (with the fix) when its element is not usable, "navigated" after the document
 * changes and "closed" with its tab; refs are unique across tabs; and the binding the model was
 * last SHOWN only moves with observations rendered to it.
 */

import { describe, expect, it } from 'vitest'
import type { NodeKey } from './page-model.js'
import { RefRegistry, type AbsentNode, type RefAssignment } from './ref-registry.js'

const FRAME_DOCUMENTS = new Map([['F1', 'F1-doc']])

function element(backendNodeId: number, role: string, name: string, context?: string, frame: { frameId: string; frameDocumentId: string } = { frameId: 'F1', frameDocumentId: 'F1-doc' }): RefAssignment {
  return {
    nodeKey: `${frame.frameId}:${backendNodeId}` as NodeKey,
    frameId: frame.frameId,
    frameDocumentId: frame.frameDocumentId,
    backendNodeId,
    role,
    name,
    ...(context ? { context } : {}),
  }
}

function observe(
  registry: RefRegistry,
  documentId: string,
  elements: RefAssignment[],
  options: { tab?: string; shown?: boolean; absent?: Map<number, AbsentNode>; frameDocuments?: Map<string, string> } = {},
): number[] {
  const observation = registry.begin(options.tab ?? 'T1', documentId)
  const refs = elements.map((e) => observation.assign(e))
  observation.commit({ absent: options.absent ?? new Map(), shown: options.shown ?? true, frameDocuments: options.frameDocuments ?? FRAME_DOCUMENTS })
  return refs
}

describe('RefRegistry', () => {
  it('keeps refs stable when an element is inserted above, and never reuses a number', () => {
    const registry = new RefRegistry()
    expect(observe(registry, 'doc-1', [element(10, 'button', 'Save'), element(11, 'link', 'Help')])).toEqual([1, 2])
    expect(observe(registry, 'doc-1', [element(9, 'button', 'Promo'), element(10, 'button', 'Save'), element(11, 'link', 'Help')])).toEqual([3, 1, 2])
    expect(registry.resolve(1)).toMatchObject({ ok: true, target: { ref: 1, backendNodeId: 10, name: 'Save', targetId: 'T1', documentId: 'doc-1' } })
    expect(registry.documentId('T1')).toBe('doc-1')
  })

  it("accepts 12, '12' and '[12]'", () => {
    const registry = new RefRegistry()
    observe(registry, 'doc-1', [element(10, 'button', 'Save')])
    for (const form of [1, '1', '[1]', ' [1] ']) {
      expect(registry.resolve(form)).toMatchObject({ ok: true, target: { name: 'Save' } })
    }
  })

  it('reports unknown refs with the exact guidance text', () => {
    const registry = new RefRegistry()
    observe(registry, 'doc-1', [element(10, 'button', 'Save')])
    expect(registry.resolve(7)).toEqual({
      ok: false,
      reason: 'unknown',
      error: 'Ref [7] does not exist. Refs come from observe(); call observe() and use a ref from its output.',
    })
    expect(registry.resolve('abc')).toMatchObject({ ok: false, reason: 'unknown' })
  })

  it('says gone, and suggests the re-rendered element only when exactly one matches', () => {
    const registry = new RefRegistry()
    observe(registry, 'doc-1', [element(10, 'button', 'Save'), element(20, 'button', 'Delete')])
    // React re-rendered the Save button (new DOM node, same role+name); Delete vanished.
    const [newSave] = observe(registry, 'doc-1', [element(30, 'button', 'Save')])
    expect(registry.resolve(1)).toMatchObject({
      ok: false,
      reason: 'gone',
      error:
        `Ref [1] (button "Save") is no longer on the page: it was removed or re-rendered. ` +
        `The same button "Save" is now [${newSave}]; use it if it is the one you meant.`,
      suggestion: expect.objectContaining({ ref: newSave, backendNodeId: 30 }),
    })
    expect(registry.resolve(2)).toMatchObject({
      ok: false,
      reason: 'gone',
      error: 'Ref [2] (button "Delete") is no longer on the page: it was removed or re-rendered. Call observe() again.',
    })
  })

  it('does not guess between two candidates or across a different context', () => {
    const registry = new RefRegistry()
    observe(registry, 'doc-1', [element(10, 'button', 'Edit', 'in row "Alice"'), element(11, 'button', 'Edit', 'in row "Bob"')])
    observe(registry, 'doc-1', [element(12, 'button', 'Edit', 'in row "Bob"'), element(13, 'button', 'Edit', 'in row "Carol"')])

    const ambiguous = new RefRegistry()
    observe(ambiguous, 'doc-1', [element(40, 'link', 'More')])
    observe(ambiguous, 'doc-1', [element(41, 'link', 'More'), element(42, 'link', 'More')])
    expect(ambiguous.resolve(1)).toMatchObject({
      ok: false,
      reason: 'gone',
      error: 'Ref [1] (link "More") is no longer on the page: it was removed or re-rendered. Call observe() again.',
    })
    const alice = registry.resolve(1)
    expect(alice).toMatchObject({ ok: false, reason: 'gone' })
    expect(alice.ok === false && alice.suggestion).toBeFalsy()
    expect(registry.resolve(2)).toMatchObject({ ok: false, reason: 'gone', suggestion: { ref: 3, context: 'in row "Bob"' } })
  })

  it('brings a ref back when the same node reappears', () => {
    const registry = new RefRegistry()
    observe(registry, 'doc-1', [element(10, 'button', 'Menu item')])
    observe(registry, 'doc-1', [])
    expect(registry.resolve(1)).toMatchObject({ ok: false, reason: 'gone' })
    expect(observe(registry, 'doc-1', [element(10, 'button', 'Menu item')])).toEqual([1])
    expect(registry.resolve(1)).toMatchObject({ ok: true })
  })

  it('says hidden or inert, with the fix, for an element still in the document', () => {
    const registry = new RefRegistry()
    const [file, rename, save] = observe(registry, 'doc-1', [element(5, 'button', 'File'), element(6, 'menuitem', 'Rename'), element(7, 'button', 'Save')])
    const absent = new Map<number, AbsentNode>([
      [rename, { reason: 'hidden', why: `its button [${file}] "File" is collapsed — open it first (act.click(${file}))` }],
      [save, { reason: 'inert', why: 'it is behind the modal dialog "Confirm" [9] — answer or close that first' }],
    ])
    observe(registry, 'doc-1', [element(5, 'button', 'File')], { absent })
    expect(registry.resolve(rename)).toMatchObject({
      ok: false,
      reason: 'hidden',
      error: `Ref [${rename}] (menuitem "Rename") is still on the page but hidden right now: its button [${file}] "File" is collapsed — open it first (act.click(${file}))`,
    })
    expect(registry.resolve(save)).toMatchObject({
      ok: false,
      reason: 'inert',
      error: `Ref [${save}] (button "Save") is still on the page but cannot be used right now: it is behind the modal dialog "Confirm" [9] — answer or close that first`,
    })
    // Back in the listing, usable again under the same number.
    expect(observe(registry, 'doc-1', [element(5, 'button', 'File'), element(6, 'menuitem', 'Rename')])).toEqual([file, rename])
    expect(registry.resolve(rename)).toMatchObject({ ok: true })
  })

  it('retires every ref of a tab as navigated on a new document, without renumbering into them', () => {
    const registry = new RefRegistry()
    observe(registry, 'doc-1', [element(10, 'button', 'Save'), element(11, 'link', 'Help')])
    // backendNodeId 10 exists again in the new document, but it is a different node.
    const refs = observe(registry, 'doc-2', [element(10, 'button', 'Save')])
    expect(refs).toEqual([3])
    expect(registry.resolve(1)).toEqual({
      ok: false,
      reason: 'navigated',
      error: 'Ref [1] is from the previous page — the page has navigated since. Call observe() to get refs for the current page.',
    })
    expect(registry.resolve('[2]')).toMatchObject({ ok: false, reason: 'navigated' })
    expect(registry.resolve(3)).toMatchObject({ ok: true })
    expect(registry.documentId('T1')).toBe('doc-2')
  })

  it('numbers refs uniquely across tabs and resolves each to its own tab', () => {
    const registry = new RefRegistry()
    const [a] = observe(registry, 'doc-a', [element(10, 'button', 'Save')], { tab: 'TA' })
    // The same backendNodeId in another tab is another element with another number.
    const [b] = observe(registry, 'doc-b', [element(10, 'button', 'Save')], { tab: 'TB' })
    expect(a).not.toBe(b)
    expect(registry.resolve(a)).toMatchObject({ ok: true, target: { targetId: 'TA' } })
    expect(registry.resolve(b)).toMatchObject({ ok: true, target: { targetId: 'TB' } })
    // Observing tab B again leaves tab A's refs alive.
    observe(registry, 'doc-b', [], { tab: 'TB' })
    expect(registry.resolve(a)).toMatchObject({ ok: true })
    registry.closeTab('TA')
    expect(registry.resolve(a)).toMatchObject({ ok: false, reason: 'closed' })
    expect(registry.refFor('TB', 'F1', 10)).toMatchObject({ ref: b })
  })

  it('moves the shown binding only with observations rendered to the model', () => {
    const registry = new RefRegistry()
    const [follow] = observe(registry, 'doc-1', [element(10, 'button', 'Follow')])
    // A quiet look (the before-state of an action) sees the relabel; the model has not.
    observe(registry, 'doc-1', [element(10, 'button', 'Unfollow')], { shown: false })
    expect(registry.resolve(follow)).toMatchObject({ ok: true, target: { name: 'Unfollow', shown: { role: 'button', name: 'Follow' } } })
    observe(registry, 'doc-1', [element(10, 'button', 'Unfollow')])
    expect(registry.resolve(follow)).toMatchObject({ ok: true, target: { shown: { name: 'Unfollow' } } })
  })

  it('tracks what the model was shown of a document, for "new since your last look"', () => {
    const registry = new RefRegistry()
    expect(registry.documentShown('T1', 'doc-1')).toBe(false)
    const quiet = registry.begin('T1', 'doc-1')
    quiet.assign(element(10, 'button', 'Save'))
    quiet.commit({ absent: new Map(), shown: false, frameDocuments: FRAME_DOCUMENTS, textKeys: ['F1:3\u0000hello'] })
    expect(registry.documentShown('T1', 'doc-1')).toBe(false)
    const shown = registry.begin('T1', 'doc-1')
    shown.assign(element(10, 'button', 'Save'))
    shown.commit({ absent: new Map(), shown: true, frameDocuments: FRAME_DOCUMENTS, textKeys: ['F1:3\u0000hello'] })
    expect(registry.wasShown('T1', 'doc-1', 'F1:10')).toBe(true)
    expect(registry.wasShown('T1', 'doc-1', 'F1:3\u0000hello')).toBe(true)
    expect(registry.wasShown('T1', 'doc-1', 'F1:11')).toBe(false)
  })

  it('marks a ref gone when act finds its node deleted, with the suggestion', () => {
    const registry = new RefRegistry()
    const [first, second] = observe(registry, 'doc-1', [element(10, 'button', 'Send'), element(12, 'button', 'Send', 'in form "Reply"')])
    expect(registry.markGone(first)).toBe(
      `Ref [${first}] (button "Send") is no longer on the page: it was removed or re-rendered. The same button "Send" is now [${second}]; use it if it is the one you meant.`,
    )
    expect(registry.resolve(first)).toMatchObject({ ok: false, reason: 'gone' })
  })

  it('keeps iframe refs per frame document: a reused backendNodeId is another element, a frame navigation retires only its refs', () => {
    const registry = new RefRegistry()
    const payDoc1 = { frameId: 'PAY', frameDocumentId: 'pay-1' }
    const documents = new Map([...FRAME_DOCUMENTS, ['PAY', 'pay-1']])
    // An out-of-process iframe numbers its nodes from 1 in its own process: node 10 there is not node 10 of the page.
    const [save, card] = observe(registry, 'doc-1', [element(10, 'button', 'Save'), element(10, 'textbox', 'Card number', undefined, payDoc1)], { frameDocuments: documents })
    expect(save).not.toBe(card)
    expect(registry.refFor('T1', 'PAY', 10)).toMatchObject({ ref: card, frameDocumentId: 'pay-1' })
    // The iframe loads a new document whose node 10 is something else: the old ref is retired, the page's stays.
    const [saveAgain, other] = observe(registry, 'doc-1', [element(10, 'button', 'Save'), element(10, 'button', 'Confirm', undefined, { frameId: 'PAY', frameDocumentId: 'pay-2' })], {
      frameDocuments: new Map([...FRAME_DOCUMENTS, ['PAY', 'pay-2']]),
    })
    expect(saveAgain).toBe(save)
    expect(other).not.toBe(card)
    expect(registry.resolve(card)).toEqual({
      ok: false,
      reason: 'navigated',
      error: `Ref [${card}] is from an earlier document of an iframe on this page — that iframe has loaded a new one since. Call observe() to get its current refs.`,
    })
    expect(registry.resolve(save)).toMatchObject({ ok: true })
  })
})
