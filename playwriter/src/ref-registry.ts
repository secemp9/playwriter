/**
 * ref-registry.ts — stable `[12]`-style element refs for a model that cannot see.
 *
 * The old snapshot refs (`e1..eN`) were renumbered on every snapshot and its `>> nth=`
 * locators shifted whenever anything was inserted above, so a model acting on a ref
 * from its previous read could hit a different element. Here a ref is bound to the
 * element's identity — tab, document, frame and backendNodeId, which Chromium keeps for
 * as long as the DOM node lives — and is never reused. A node that disappears keeps its
 * number (resolving it says why it cannot be used), a node that appears gets a fresh one,
 * and nothing in between moves.
 *
 * One registry serves the whole session, every tab included: refs are unique across tabs,
 * so `[12]` names one element in one tab and act drives the tab it belongs to.
 *
 * A document is identified by its main frame's `loaderId`. After a cross-process navigation
 * Chromium restarts backendNodeIds, so the document is part of the identity: a different one
 * retires every ref of the old one as `navigated`. Numbering is NOT restarted on a new
 * document: if it were, an old `[5]` would silently resolve to the new page's `[5]` — exactly
 * the wrong-element click this exists to prevent. An iframe's document counts the same way, on
 * its own: the identity holds the iframe's frame id and its document's `loaderId` (an
 * out-of-process iframe numbers its nodes in its own process, from 1), and an iframe that loads
 * a new document retires the refs of its old one while the rest of the page keeps theirs.
 *
 * Two bindings are kept per ref. `role/name/context` are what the latest observation read;
 * `shown` is what the model was last SHOWN (an observation rendered to it). Act compares the
 * live element with `shown` before it dispatches: a button relabelled "Unfollow", or a list row
 * recycled for another person, is refused rather than clicked.
 */

import type { NodeKey } from './page-model.js'

/** What an element is, the way the model reads it: `button "Delete" (in row "Alice")`. */
export interface RefBinding {
  role: string
  name: string
  context?: string
}

export interface RefTarget extends RefBinding {
  ref: number
  /** `${targetId}:${documentId}:${frameId}:${frameDocumentId}:${backendNodeId}` — the element's identity for the session. */
  key: string
  /** The PageModel key (`frameId:backendNodeId`) the observation lists the element under. */
  nodeKey: NodeKey
  /** CDP target id of the tab the element is in. */
  targetId: string
  /** Main-frame loaderId of the document the element is in. */
  documentId: string
  /** The frame the element is in: the main frame or an iframe. */
  frameId: string
  /** The `loaderId` of that frame's document (equal to `documentId` in the main frame). */
  frameDocumentId: string
  backendNodeId: number
  /** Operated through its `<label>` (see `ObservedElement.viaLabel`): act clicks the label. */
  viaLabel?: true
  /** What the model was last shown for this ref; absent when it never was. */
  shown?: RefBinding
}

/** Why an element that is still in its document is not usable right now. `why` is written for the model and names the fix. */
export interface AbsentNode {
  reason: 'hidden' | 'inert'
  why: string
}

export type RefResolution =
  | { ok: true; target: RefTarget }
  | {
      ok: false
      reason: 'unknown' | 'navigated' | 'closed' | 'gone' | 'hidden' | 'inert'
      error: string
      /** The element the ref named, when it is known. */
      target?: RefTarget
      /** The one element that now has the same role, name and context, when exactly one does. */
      suggestion?: RefTarget
    }

/** The element passed to `RefObservation.assign`: identity and what the observation read. */
export type RefAssignment = Omit<RefTarget, 'ref' | 'key' | 'targetId' | 'documentId' | 'shown'>

interface TabState {
  documentId: string
  /** frameId → loaderId of the frame documents the latest committed observation read. */
  frameDocuments: Map<string, string>
  /** Refs listed by the latest committed observation of this tab. */
  alive: Set<number>
  /** Refs still in the document but not usable, from the latest committed observation. */
  absent: Map<number, AbsentNode>
  /** Element and text keys of this document the model has been shown. Empty: nothing of it shown yet. */
  shownKeys: Set<string>
}

/**
 * One observation of one tab, between `RefRegistry.begin` and `commit`. Refs are numbered as
 * elements are assigned (the observation needs them to render), and the tab's liveness
 * changes only at `commit`.
 */
export class RefObservation {
  private readonly registry: RefRegistry
  readonly targetId: string
  readonly documentId: string
  private readonly seen = new Set<number>()
  private committed = false

  constructor(registry: RefRegistry, targetId: string, documentId: string) {
    this.registry = registry
    this.targetId = targetId
    this.documentId = documentId
  }

  /** Same element → same ref for the life of its document. */
  assign(element: RefAssignment): number {
    if (this.committed) throw new Error('RefObservation.assign() after commit(): begin a new observation.')
    const ref = this.registry.place(this.targetId, this.documentId, element)
    this.seen.add(ref)
    return ref
  }

  /** Refs the latest committed observation of this tab listed that this one has not assigned. */
  unseen(): RefTarget[] {
    return this.registry.unseenBy(this.targetId, this.documentId, this.seen)
  }

  /**
   * Make this observation the tab's current one. Refs not assigned become gone, or — for the
   * ones in `absent` (keyed by ref) — hidden or inert. `frameDocuments` (frameId → loaderId) are
   * the frame documents it read: refs of an earlier document of one of those frames are retired
   * as navigated. With `shown`, the model is reading this observation: every assigned ref's
   * `shown` binding becomes what it reads now, and the element keys plus `textKeys` count as
   * seen by the model.
   */
  commit(options: { absent: Map<number, AbsentNode>; shown: boolean; frameDocuments: Map<string, string>; textKeys?: Iterable<string> }): void {
    if (this.committed) throw new Error('RefObservation.commit() was called twice.')
    this.committed = true
    this.registry.settle(this, this.seen, options)
  }
}

export class RefRegistry {
  private nextRef = 1
  private readonly tabs = new Map<string, TabState>()
  private readonly refByKey = new Map<string, number>()
  private readonly targets = new Map<number, RefTarget>()
  /** Refs whose document or tab is gone; `frame-navigated`: only the iframe it was in loaded a new document. */
  private readonly retired = new Map<number, 'navigated' | 'frame-navigated' | 'closed'>()

  /** Start an observation of the document `documentId` (main-frame loaderId) in tab `targetId`. */
  begin(targetId: string, documentId: string): RefObservation {
    const tab = this.tabs.get(targetId)
    if (tab && tab.documentId !== documentId) this.retireTab(targetId, 'navigated')
    if (!this.tabs.has(targetId)) {
      this.tabs.set(targetId, { documentId, frameDocuments: new Map(), alive: new Set(), absent: new Map(), shownKeys: new Set() })
    }
    return new RefObservation(this, targetId, documentId)
  }

  /** @internal RefObservation.assign */
  place(targetId: string, documentId: string, element: RefAssignment): number {
    const key = `${targetId}:${documentId}:${element.frameId}:${element.frameDocumentId}:${element.backendNodeId}`
    let ref = this.refByKey.get(key)
    if (ref === undefined) {
      ref = this.nextRef++
      this.refByKey.set(key, ref)
    }
    const shown = this.targets.get(ref)?.shown
    this.targets.set(ref, { ...element, ref, key, targetId, documentId, ...(shown ? { shown } : {}) })
    return ref
  }

  /** @internal RefObservation.unseen */
  unseenBy(targetId: string, documentId: string, seen: Set<number>): RefTarget[] {
    const tab = this.tabs.get(targetId)
    if (!tab || tab.documentId !== documentId) return []
    const result: RefTarget[] = []
    for (const ref of [...tab.alive, ...tab.absent.keys()]) {
      const target = this.targets.get(ref)
      if (target && !seen.has(ref)) result.push(target)
    }
    return result
  }

  /** @internal RefObservation.commit */
  settle(
    observation: RefObservation,
    seen: Set<number>,
    options: { absent: Map<number, AbsentNode>; shown: boolean; frameDocuments: Map<string, string>; textKeys?: Iterable<string> },
  ): void {
    const tab = this.tabs.get(observation.targetId)
    // The tab navigated (or closed) while this observation was being built: it describes a
    // document that is no longer there, so it changes nothing.
    if (!tab || tab.documentId !== observation.documentId) return
    tab.frameDocuments = new Map(options.frameDocuments)
    for (const [ref, target] of this.targets) {
      if (target.targetId !== observation.targetId) continue
      const current = options.frameDocuments.get(target.frameId)
      if (current === undefined || current === target.frameDocumentId) continue
      this.retired.set(ref, 'frame-navigated')
      this.targets.delete(ref)
      this.refByKey.delete(target.key)
    }
    tab.alive = new Set(seen)
    tab.absent = new Map([...options.absent].filter(([ref]) => !seen.has(ref)))
    if (!options.shown) return
    for (const ref of seen) {
      const target = this.targets.get(ref)
      if (!target) continue
      target.shown = { role: target.role, name: target.name, ...(target.context !== undefined ? { context: target.context } : {}) }
      tab.shownKeys.add(target.nodeKey)
    }
    for (const key of options.textKeys ?? []) tab.shownKeys.add(key)
  }

  /** Whether the model has been shown anything of this document yet ("new since your last look" needs a last look). */
  documentShown(targetId: string, documentId: string): boolean {
    const tab = this.tabs.get(targetId)
    return !!tab && tab.documentId === documentId && tab.shownKeys.size > 0
  }

  /** Whether the model has been shown the element or text block `key` of this document. */
  wasShown(targetId: string, documentId: string, key: string): boolean {
    const tab = this.tabs.get(targetId)
    return !!tab && tab.documentId === documentId && tab.shownKeys.has(key)
  }

  /** The tab's current document, or null when it was never observed. */
  documentId(targetId: string): string | null {
    return this.tabs.get(targetId)?.documentId ?? null
  }

  /** The current ref of a node in the tab's current document, alive or not; null when it never had one. */
  refFor(targetId: string, frameId: string, backendNodeId: number): RefTarget | null {
    const tab = this.tabs.get(targetId)
    if (!tab) return null
    const frameDocumentId = tab.frameDocuments.get(frameId)
    if (frameDocumentId === undefined) return null
    const ref = this.refByKey.get(`${targetId}:${tab.documentId}:${frameId}:${frameDocumentId}:${backendNodeId}`)
    return ref === undefined ? null : (this.targets.get(ref) ?? null)
  }

  /** The tab closed: its refs say so from now on. */
  closeTab(targetId: string): void {
    this.retireTab(targetId, 'closed')
  }

  /**
   * Act found the ref's node gone from the document (Chrome no longer knows its backendNodeId).
   * Marks it gone and returns the model-facing error, with the unambiguous re-rendered
   * replacement when there is one.
   */
  markGone(ref: number): string {
    const target = this.targets.get(ref)
    if (!target) return `Ref [${ref}] does not exist. Refs come from observe(); call observe() and use a ref from its output.`
    const tab = this.tabs.get(target.targetId)
    tab?.alive.delete(ref)
    tab?.absent.delete(ref)
    const resolution = this.resolve(ref)
    return resolution.ok ? '' : resolution.error
  }

  /** Accepts 12, '12', '[12]'. */
  resolve(ref: number | string): RefResolution {
    const text = typeof ref === 'number' ? String(ref) : ref.trim().replace(/^\[\s*/, '').replace(/\s*\]$/, '')
    const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN
    const display = Number.isNaN(parsed) ? String(ref) : String(parsed)
    const unknown = (): RefResolution => ({
      ok: false,
      reason: 'unknown',
      error: `Ref [${display}] does not exist. Refs come from observe(); call observe() and use a ref from its output.`,
    })
    if (Number.isNaN(parsed) || parsed <= 0) return unknown()
    const retired = this.retired.get(parsed)
    if (retired === 'navigated') {
      return {
        ok: false,
        reason: 'navigated',
        error: `Ref [${parsed}] is from the previous page — the page has navigated since. Call observe() to get refs for the current page.`,
      }
    }
    if (retired === 'frame-navigated') {
      return {
        ok: false,
        reason: 'navigated',
        error: `Ref [${parsed}] is from an earlier document of an iframe on this page — that iframe has loaded a new one since. Call observe() to get its current refs.`,
      }
    }
    if (retired === 'closed') {
      return {
        ok: false,
        reason: 'closed',
        error: `Ref [${parsed}] is from a tab that has been closed. Call observe() to get refs for the page you are on.`,
      }
    }
    const target = this.targets.get(parsed)
    if (!target) return unknown()
    const tab = this.tabs.get(target.targetId)
    if (tab?.alive.has(parsed)) return { ok: true, target }
    const label = `Ref [${parsed}] (${target.role}${target.name ? ` "${target.name}"` : ''})`
    const absent = tab?.absent.get(parsed)
    if (absent) {
      return {
        ok: false,
        reason: absent.reason,
        error:
          absent.reason === 'hidden'
            ? `${label} is still on the page but hidden right now: ${absent.why}`
            : `${label} is still on the page but cannot be used right now: ${absent.why}`,
        target,
      }
    }

    const matches: RefTarget[] = []
    for (const candidateRef of tab?.alive ?? []) {
      const candidate = this.targets.get(candidateRef)
      if (!candidate || candidate.role !== target.role || candidate.name !== target.name) continue
      if (target.context !== undefined && candidate.context !== target.context) continue
      matches.push(candidate)
    }
    const suggestion = matches.length === 1 ? matches[0] : undefined
    const base = `${label} is no longer on the page: it was removed or re-rendered.`
    return {
      ok: false,
      reason: 'gone',
      error: suggestion
        ? `${base} The same ${target.role} "${target.name}" is now [${suggestion.ref}]; use it if it is the one you meant.`
        : `${base} Call observe() again.`,
      target,
      ...(suggestion ? { suggestion } : {}),
    }
  }

  private retireTab(targetId: string, why: 'navigated' | 'closed'): void {
    if (!this.tabs.delete(targetId)) return
    for (const [ref, target] of this.targets) {
      if (target.targetId !== targetId) continue
      this.retired.set(ref, why)
      this.targets.delete(ref)
      this.refByKey.delete(target.key)
    }
  }
}
