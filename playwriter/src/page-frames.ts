/**
 * page-frames.ts — every frame of a tab: the session that owns its document, a private
 * isolated world in it, and where its viewport sits on the screen.
 *
 * A page is a tree of documents. Measured against Chromium 145 (headless, default site
 * isolation), the protocol splits that tree in two ways that every reader has to respect:
 *
 *   - SAME-PROCESS frames (same site as their parent) are answered by the page's own session
 *     when the call names the frame: `Accessibility.getFullAXTree({ frameId })`,
 *     `Page.createIsolatedWorld({ frameId })`. One `DOMSnapshot.captureSnapshot` holds their
 *     documents too, each in its OWN document coordinates, with its own paint order.
 *     `DOM.getContentQuads`/`DOM.getNodeForLocation` on the page session work in main-viewport
 *     coordinates and descend into them (the hit carries the frame's id).
 *   - OUT-OF-PROCESS frames (OOPIF: a cross-site iframe under site isolation — localhost inside
 *     127.0.0.1 is one) are invisible to the page session: its `Page.getFrameTree` does not list
 *     them, and its hit test stops at their `<iframe>`. Playwright holds a separate session per
 *     OOPIF (`getCDPSessionForFrame`), whose coordinates are local to the frame's own viewport.
 *     Its same-site children are same-process frames of THAT session.
 *
 * So each frame here is resolved to the session that owns it (its "session root" is the main
 * frame or the OOPIF whose session it is) and to a box: the top-left of its viewport (the
 * `<iframe>`'s content box) in main-viewport CSS pixels, from `DOM.getBoxModel` of the owner
 * element in the parent's session, chained up through the out-of-process ancestors. Input is
 * always dispatched on the page at main-viewport coordinates; Chromium routes it into the frame.
 *
 * Nothing is written to any page: each frame's in-page logic runs in its own CDP isolated world,
 * created on first use and replaced when the frame moves to another process.
 */

import type { Frame, Page } from '@xmorse/playwright-core'
import type { ICDPSession } from './cdp-session.js'
import { getCDPSessionForFrame } from './cdp-session.js'
import { IsolatedWorld, withDeadline } from './isolated-world.js'
import { ModelFacingError } from './probe-types.js'

const CDP_TIMEOUT_MS = 5000

/** One frame, resolved: what reads and acts on its document go through. */
export interface FrameHandle {
  frameId: string
  /** Playwright's frame object. */
  frame: Frame
  /** The embedding frame; null for the main frame. */
  parentId: string | null
  /** The session that owns the frame's document: the page's own, or that of its out-of-process root. */
  cdp: ICDPSession
  /** The frame whose renderer session `cdp` is: the main frame, or the out-of-process frame this one is (in). */
  sessionRootId: string
  /** The frame is the root of its own renderer session: an out-of-process iframe. */
  outOfProcess: boolean
  /** A private isolated world in the frame, with every registered setup (`PageFrames.addSetup`). */
  world: IsolatedWorld
}

/** A frame as `PageFrames.list()` found it, with its current document. */
export interface FrameEntry extends FrameHandle {
  url: string
  /** The frame's `name` attribute (window.name), '' when none. */
  name: string
  /** The frame's current document (Chromium's loaderId for it). */
  loaderId: string
  /** 0 for the main frame, 1 for its iframes, and so on. */
  depth: number
}

/** A frame that exists but whose document cannot be read; `reason` is written for the model. */
export interface UnreadableFrame {
  frameId: string
  parentId: string | null
  url: string
  name: string
  depth: number
  reason: string
}

/**
 * Where a frame's viewport is on the screen. A point (x, y) in the frame's own viewport CSS px is
 * at (box.x + x * box.scale, box.y + y * box.scale) in the main viewport.
 */
export interface FrameBox {
  x: number
  y: number
  /** Main-viewport CSS px per CSS px of the frame: 1 unless a CSS transform scales the iframe. */
  scale: number
  /** The frame's viewport size, in its own CSS px. */
  width: number
  height: number
}

/** A rectangle in main-viewport CSS px. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** The `<iframe>`/`<frame>` element that embeds a frame, in its parent's session id space. */
export interface FrameOwner {
  parentId: string
  backendNodeId: number
}

export type FrameChange = { kind: 'attached' | 'navigated' | 'detached'; frameId: string }

interface WorldSlot {
  cdp: ICDPSession
  world: IsolatedWorld
}

const IDENTITY_BOX = { x: 0, y: 0, scale: 1 }

export class PageFrames {
  readonly page: Page
  /** The page's own session. */
  readonly cdp: ICDPSession
  private readonly mainWorld: IsolatedWorld
  private readonly worlds = new Map<string, WorldSlot>()
  private readonly setups = new Map<string, string>()
  private readonly listeners = new Set<(change: FrameChange) => void>()
  /** Out-of-process sessions whose renderer crashed. */
  private readonly crashed = new WeakSet<ICDPSession>()
  private readonly watchedSessions = new WeakSet<ICDPSession>()
  private readonly domEnabled = new WeakSet<ICDPSession>()
  private readonly unlisten: Array<() => void> = []

  constructor(options: { page: Page; cdp: ICDPSession }) {
    this.page = options.page
    this.cdp = options.cdp
    this.mainWorld = new IsolatedWorld({ cdp: this.cdp, getFrameId: () => this.page.mainFrame().frameId() })
    const emit = (kind: FrameChange['kind']) => (frame: Frame) => {
      if (frame === this.page.mainFrame()) return
      const frameId = frame.frameId()
      if (kind !== 'attached') this.dropWorld(frameId, kind === 'detached')
      for (const listener of this.listeners) listener({ kind, frameId })
    }
    const attached = emit('attached')
    const navigated = emit('navigated')
    const detached = emit('detached')
    this.page.on('frameattached', attached)
    this.page.on('framenavigated', navigated)
    this.page.on('framedetached', detached)
    this.unlisten.push(() => {
      this.page.off('frameattached', attached)
      this.page.off('framenavigated', navigated)
      this.page.off('framedetached', detached)
    })
  }

  /** The main frame's id now (it changes across a cross-process main-frame navigation). */
  mainFrameId(): string {
    return this.page.mainFrame().frameId()
  }

  /** The main frame: the page session and the main isolated world. */
  get main(): FrameHandle {
    const frame = this.page.mainFrame()
    const frameId = frame.frameId()
    return { frameId, frame, parentId: null, cdp: this.cdp, sessionRootId: frameId, outOfProcess: false, world: this.mainWorld }
  }

  /**
   * Run `source` once in every fresh copy of every frame's isolated world, the ones that exist
   * now (from their next copy on: see `IsolatedWorld.addSetup`) and the ones created later.
   */
  addSetup(name: string, source: string): void {
    this.setups.set(name, source)
    this.mainWorld.addSetup(name, source)
    for (const slot of this.worlds.values()) slot.world.addSetup(name, source)
  }

  /** Called on every iframe attached, navigated (a new document, maybe in a new process) or detached. */
  onChange(listener: (change: FrameChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The frame `frameId`, resolved to its session and world. Throws when it is no longer in the page. */
  async handle(frameId: string): Promise<FrameHandle> {
    const frame = this.findFrame(frameId)
    if (!frame) {
      throw new ModelFacingError(`The iframe this element was in is no longer on the page (it was removed or replaced). Call observe() again.`)
    }
    return await this.resolve(frame)
  }

  /**
   * Every frame of the page in tree order (main first, each frame before its children), with
   * its current document; the frames whose documents cannot be read are listed apart with why.
   */
  async list(): Promise<{ frames: FrameEntry[]; unreadable: UnreadableFrame[] }> {
    const frames: FrameEntry[] = []
    const unreadable: UnreadableFrame[] = []
    const trees = new Map<ICDPSession, Promise<Map<string, { loaderId: string; url: string }>>>()
    const treeOf = (cdp: ICDPSession): Promise<Map<string, { loaderId: string; url: string }>> => {
      let tree = trees.get(cdp)
      if (!tree) {
        tree = withDeadline(cdp.send('Page.getFrameTree'), CDP_TIMEOUT_MS, 'reading the frame tree (Page.getFrameTree)').then(({ frameTree }) => {
          const documents = new Map<string, { loaderId: string; url: string }>()
          const walk = (node: typeof frameTree): void => {
            documents.set(node.frame.id, { loaderId: node.frame.loaderId, url: node.frame.url + (node.frame.urlFragment ?? '') })
            for (const child of node.childFrames ?? []) walk(child)
          }
          walk(frameTree)
          return documents
        })
        trees.set(cdp, tree)
      }
      return tree
    }
    const visit = async (frame: Frame, depth: number, unreadableAncestor: boolean): Promise<void> => {
      const frameId = frame.frameId()
      const parent = frame.parentFrame()
      const describe = { frameId, parentId: parent ? parent.frameId() : null, url: frame.url(), name: frame.name(), depth }
      let entry: FrameEntry | null = null
      if (unreadableAncestor) {
        unreadable.push({ ...describe, reason: 'the iframe around it cannot be read' })
      } else if (frame.isDetached()) {
        unreadable.push({ ...describe, reason: 'it was removed from the page while being read' })
      } else {
        try {
          const handle = await this.resolve(frame)
          if (this.crashed.has(handle.cdp)) {
            unreadable.push({ ...describe, reason: 'its renderer process crashed (the frame shows nothing until it is reloaded)' })
          } else {
            const document = (await treeOf(handle.cdp)).get(frameId)
            if (!document) {
              unreadable.push({
                ...describe,
                reason: handle.outOfProcess || handle.cdp !== this.cdp
                  ? 'its document is not loaded yet'
                  : 'it runs in another renderer process (a cross-site iframe) and this browser connection gives no access to that process',
              })
            } else {
              entry = { ...handle, url: document.url, name: frame.name(), loaderId: document.loaderId, depth }
              frames.push(entry)
            }
          }
        } catch (error) {
          if (frame.isDetached()) unreadable.push({ ...describe, reason: 'it was removed from the page while being read' })
          else unreadable.push({ ...describe, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      for (const child of frame.childFrames()) await visit(child, depth + 1, entry === null)
    }
    await visit(this.page.mainFrame(), 0, false)
    return { frames, unreadable }
  }

  /**
   * The address of the frame's current document, from the session that owns it. Not Playwright's
   * `frame.url()`: measured through the relay, an out-of-process iframe that was already loaded when
   * the tab was attached has `frame.url() === ''` (Playwright names a frame from Page.frameNavigated,
   * which fired before anyone listened), while its own Page.getFrameTree has the address.
   */
  async documentUrl(frameId: string): Promise<string> {
    const handle = await this.handle(frameId)
    const { frameTree } = await withDeadline(handle.cdp.send('Page.getFrameTree'), CDP_TIMEOUT_MS, 'reading the frame tree (Page.getFrameTree)')
    const find = (node: typeof frameTree): string | null => {
      if (node.frame.id === frameId) return node.frame.url + (node.frame.urlFragment ?? '')
      for (const child of node.childFrames ?? []) {
        const found = find(child)
        if (found !== null) return found
      }
      return null
    }
    const url = find(frameTree)
    if (url === null) throw new ModelFacingError('The iframe is no longer on the page (it was removed or replaced). Call observe() again.')
    return url
  }

  /** The element that embeds `frameId` in its parent frame. */
  async owner(frameId: string): Promise<FrameOwner> {
    const frame = this.findFrame(frameId)
    const parent = frame?.parentFrame()
    if (!frame || !parent) throw new ModelFacingError('The iframe is no longer on the page (it was removed or replaced). Call observe() again.')
    const parentHandle = await this.resolve(parent)
    await this.enableDom(parentHandle.cdp)
    const { backendNodeId } = await withDeadline(
      parentHandle.cdp.send('DOM.getFrameOwner', { frameId }),
      CDP_TIMEOUT_MS,
      `finding the <iframe> element of frame ${frame.url() || frameId} (DOM.getFrameOwner)`,
    )
    return { parentId: parent.frameId(), backendNodeId }
  }

  /**
   * Where the frame's viewport is in the main viewport (see `FrameBox`). For the main frame, the
   * viewport itself. Throws, naming the iframe, when a CSS transform rotates or skews it: then no
   * point inside maps to one on the screen by an offset and a scale.
   */
  async box(frameId: string): Promise<FrameBox> {
    if (frameId === this.mainFrameId()) {
      const metrics = await withDeadline(this.cdp.send('Page.getLayoutMetrics'), CDP_TIMEOUT_MS, 'reading the viewport size (Page.getLayoutMetrics)')
      return { ...IDENTITY_BOX, width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight }
    }
    const owner = await this.owner(frameId)
    const parent = await this.handle(owner.parentId)
    const base = await this.sessionBox(parent)
    const { model } = await withDeadline(
      parent.cdp.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }),
      CDP_TIMEOUT_MS,
      'measuring the <iframe> element (DOM.getBoxModel)',
    )
    const content = model.content
    const border = model.border
    const axisAligned = content[1] === content[3] && content[0] === content[6] && content[2] === content[4] && content[5] === content[7]
    if (!axisAligned) {
      const frame = this.findFrame(frameId)
      throw new ModelFacingError(
        `The iframe "${frame ? frame.name() || frame.url() : frameId}" is rotated or skewed by a CSS transform, so positions inside it cannot be mapped to the screen.`,
      )
    }
    // `model.width` is the border box in the element's own (untransformed) CSS px; the quads are
    // where that box is drawn. Their ratio is the scale a transform applies to the frame.
    const borderWidth = Math.abs(border[2] - border[0])
    const localScale = model.width > 0 && borderWidth > 0 ? borderWidth / model.width : 1
    return {
      x: base.x + content[0] * base.scale,
      y: base.y + content[1] * base.scale,
      scale: base.scale * localScale,
      width: Math.abs(content[2] - content[0]) / localScale,
      height: Math.abs(content[5] - content[1]) / localScale,
    }
  }

  /**
   * Where `(0, 0)` of the coordinates `handle.cdp` reports (content quads, hit tests) is in the main
   * viewport: the page session's coordinates are the main viewport's; an out-of-process session's
   * are its root frame's viewport.
   */
  async sessionBox(handle: FrameHandle): Promise<{ x: number; y: number; scale: number }> {
    if (handle.cdp === this.cdp) return IDENTITY_BOX
    const root = await this.box(handle.sessionRootId)
    return { x: root.x, y: root.y, scale: root.scale }
  }

  /**
   * Where node `backendNodeId` of `handle`'s document is drawn: its content quads
   * (`DOM.getContentQuads`) as axis-aligned rects in main-viewport CSS px, for a node in an iframe
   * too; slivers under half a pixel are dropped. CDP's own error when the node has no layout box or
   * is gone.
   */
  async contentRects(handle: FrameHandle, backendNodeId: number, what: string): Promise<ScreenRect[]> {
    const { quads } = await withDeadline(handle.cdp.send('DOM.getContentQuads', { backendNodeId }), CDP_TIMEOUT_MS, what)
    const origin = await this.sessionBox(handle)
    return quads
      .map((quad) => {
        const xs = [quad[0], quad[2], quad[4], quad[6]]
        const ys = [quad[1], quad[3], quad[5], quad[7]]
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        return {
          x: origin.x + x * origin.scale,
          y: origin.y + y * origin.scale,
          width: (Math.max(...xs) - x) * origin.scale,
          height: (Math.max(...ys) - y) * origin.scale,
        }
      })
      .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
  }

  /**
   * The renderer sessions of the page's frames now: the page's own (rooted at the main frame) first,
   * then one per out-of-process frame, in tree order. Same-process frames have none of their own: the
   * session of the frame around them covers them.
   */
  async sessions(): Promise<Array<{ cdp: ICDPSession; rootId: string }>> {
    const found: Array<{ cdp: ICDPSession; rootId: string }> = [{ cdp: this.cdp, rootId: this.mainFrameId() }]
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame() || frame.isDetached()) continue
      const own = await getCDPSessionForFrame({ frame })
      if (!own || found.some((session) => session.cdp === own)) continue
      this.watchSession(own)
      found.push({ cdp: own, rootId: frame.frameId() })
    }
    return found
  }

  dispose(): void {
    for (const off of this.unlisten.splice(0)) off()
    this.listeners.clear()
    this.mainWorld.dispose()
    for (const slot of this.worlds.values()) slot.world.dispose()
    this.worlds.clear()
  }

  private findFrame(frameId: string): Frame | null {
    return this.page.frames().find((frame) => frame.frameId() === frameId) ?? null
  }

  private async resolve(frame: Frame): Promise<FrameHandle> {
    if (frame === this.page.mainFrame()) return this.main
    const frameId = frame.frameId()
    const parent = frame.parentFrame()
    const own = await getCDPSessionForFrame({ frame })
    let cdp: ICDPSession
    let sessionRootId: string
    if (own) {
      cdp = own
      sessionRootId = frameId
      this.watchSession(own)
    } else {
      // A same-process frame lives in its parent's process, whichever session that is.
      if (!parent) throw new ModelFacingError(`Frame ${frameId} has no parent frame and is not the main frame.`)
      const parentHandle = await this.resolve(parent)
      cdp = parentHandle.cdp
      sessionRootId = parentHandle.sessionRootId
    }
    let slot = this.worlds.get(frameId)
    if (slot && slot.cdp !== cdp) {
      // The frame moved to another process: its old world went with the old session.
      slot.world.dispose()
      slot = undefined
    }
    if (!slot) {
      const world = new IsolatedWorld({ cdp, getFrameId: () => frameId })
      for (const [name, source] of this.setups) world.addSetup(name, source)
      slot = { cdp, world }
      this.worlds.set(frameId, slot)
    }
    return { frameId, frame, parentId: parent ? parent.frameId() : null, cdp, sessionRootId, outOfProcess: own !== null, world: slot.world }
  }

  /** A frame navigated or detached: its world is rebuilt on next use (navigated) or dropped (detached). */
  private dropWorld(frameId: string, detached: boolean): void {
    const slot = this.worlds.get(frameId)
    if (!slot) return
    if (detached) {
      slot.world.dispose()
      this.worlds.delete(frameId)
      return
    }
    // Same session: IsolatedWorld recreates itself after the document change. Another session is
    // noticed by `resolve`, which compares sessions.
    slot.world.invalidate()
  }

  private watchSession(cdp: ICDPSession): void {
    if (this.watchedSessions.has(cdp)) return
    this.watchedSessions.add(cdp)
    cdp.on('Inspector.targetCrashed', () => this.crashed.add(cdp))
  }

  private async enableDom(cdp: ICDPSession): Promise<void> {
    if (this.domEnabled.has(cdp)) return
    await withDeadline(cdp.send('DOM.enable'), CDP_TIMEOUT_MS, 'enabling the DOM domain')
    this.domEnabled.add(cdp)
  }
}
