/**
 * page-probe.ts — the per-page state of the "browse like a human" layer.
 *
 * One PageProbe per controlled page bundles everything observe()/act/explain need and that
 * must outlive a single execute() call: the CDP session, the page's frames (each with the
 * session that owns it and its own isolated probe world), the event journal (PageWatch), the
 * native-dialog controller, the file-dialog gate, the act history (duplicate/loop guards), the
 * last full observation (what a frozen page last looked like) and the elements the human pointed
 * at with Chrome's element picker (pins). The ref registry is one for the whole session: refs are
 * unique across tabs, and each knows the tab and frame it belongs to.
 *
 * The dialog controller is the one piece attached synchronously when the page is first seen:
 * with no `dialog` listener Playwright auto-dismisses every confirm(), so a "Delete" click would
 * silently do nothing. Everything else is created lazily on first use and torn down with the
 * page.
 */

import type { BrowserContext, Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import { getCDPSessionForPage, tabTitle } from './cdp-session.js'
import { withDeadline, type IsolatedWorld } from './isolated-world.js'
import { PageFrames, type FrameHandle } from './page-frames.js'
import { RefRegistry, type RefTarget } from './ref-registry.js'
import { PageWatch, type BusyRead } from './page-watch.js'
import { DialogController, type BeforeUnloadPolicy, type DialogPolicy, type DialogPolicySettings } from './dialog-controller.js'
import { PinTracker } from './element-pins.js'
import { chooserOpener, describeOpener, FileChooserGate } from './file-chooser-gate.js'
import { outgoingCallsOf, type OutgoingCallListener } from './playwright-client-hooks.js'
import { ActError, type ActionRecord, type ActProbe } from './human-actions.js'
import { observePage, quote, type Observation, type ObservedElement, type ObserveOptions } from './page-observe.js'
import { hiddenTabNote, WindowOpens, type TabVisibility, type WindowOpenRecord } from './tab-state.js'
import { tabIsHidden } from './tab-visibility.js'
import { PERF_OBSERVERS_SOURCE, PERF_SETUP_NAME } from './perf-observers.js'

export interface PageProbe extends ActProbe {
  page: Page
  cdp: ICDPSession
  /** The main frame's isolated world (`frames.main.world`). */
  world: IsolatedWorld
  /** Every frame of the page: its session, its isolated world, where it is on screen. */
  frames: PageFrames
  /** The session's registry (the same object for every tab). */
  registry: RefRegistry
  watch: PageWatch
  dialogs: DialogController
  history: ActionRecord[]
  /** CDP target id of the tab. */
  targetId: string
  /**
   * The latest observation that could read the page (shown to the model or not). While a native
   * dialog freezes the page it is still what the page looks like: the "before" of answering it.
   */
  lastFullObservation: Observation | null
  /** The tab's file dialogs: held back while an input of ours can open one, open until answered. */
  fileChoosers: FileChooserGate
  /** Elements the human pinned from the extension's context menu, and the pickElement() picker. */
  pins: PinTracker
  /** The new windows and tabs this tab asked Chrome for (`Page.windowOpen`). */
  windowOpens: WindowOpens
}

export interface ProbeLogger {
  error(...args: unknown[]): void
}

export type TabSummary = NonNullable<Observation['tabs']>[number]

/**
 * A node the human pointed at (a pin, a pick), placed in an observation: the listed element that
 * is that node or contains it, or — for a node inside no listed element, like a paragraph — what
 * it is and says. `gone`: removed, or its document was replaced.
 */
export type LocatedNode =
  | { kind: 'element'; element: ObservedElement; exact: boolean }
  | { kind: 'content'; tag: string; text: string; inClosedFrame: boolean }
  | { kind: 'gone' }

/** The element a ref names, resolved for reading (`PageProbes.element`). */
export interface RefElement {
  page: Page
  probe: PageProbe
  target: RefTarget
  /** The element's frame: the session that owns its document and the frame's isolated world. */
  frame: FrameHandle
  /** `DOM.describeNode` of the element, on the frame's session. */
  node: Protocol.DOM.Node
}

/** One line a model can act on: the ref when there is one, what it is otherwise. */
export function renderLocatedNode(located: LocatedNode): string {
  switch (located.kind) {
    case 'element': {
      const { element } = located
      const head = `[${element.ref}] ${element.role}${element.name ? ` ${quote(element.name)}` : ''}${element.context ? ` (${element.context})` : ''}`
      return located.exact ? head : `${head} — the point is inside it`
    }
    case 'content':
      return (
        `${located.tag}${located.text ? ` ${quote(located.text, 160)}` : ''} — page content, not a control` +
        (located.inClosedFrame ? '; inside a cross-origin frame, outside what observe() lists' : '')
      )
    case 'gone':
      return 'an element that is no longer on the page (removed, or the page navigated since)'
  }
}

/**
 * The node and every ancestor, nearest first, across shadow roots and into the embedding frame;
 * empty when the node is gone. A `<label>` is followed by the control it activates: clicking a
 * label is clicking its control. A picked `::before`/`::after` starts at the pseudo-element, whose
 * parent is the element it decorates. Runs in the isolated world: reads only.
 */
const ANCESTRY_FN = `function (_args, start) {
  const chain = []
  let node = start
  while (node) {
    chain.push(node)
    if (node.nodeType === Node.ELEMENT_NODE && node.localName === 'label' && node.control) chain.push(node.control)
    const parent = node.parentNode
    if (!parent) break
    if (parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE) node = parent.host || null
    else if (parent.nodeType === Node.DOCUMENT_NODE) node = parent.defaultView ? parent.defaultView.frameElement : null
    else node = parent
  }
  return chain
}`

/**
 * What a person would call the node: its tag and its visible text. `inClosedFrame`: it sits in a
 * frame whose embedding element cannot be reached (cross-origin), so no listed element of the
 * outer page can contain it.
 */
const DESCRIBE_FN = `function (_args, node) {
  if (!node) return null
  const pseudo = node.nodeType === Node.ELEMENT_NODE && node.nodeName.startsWith('::') ? node.nodeName.toLowerCase() : ''
  const element = pseudo || node.nodeType !== Node.ELEMENT_NODE ? node.parentElement : node
  let top = element
  let crossedInto = false
  while (top) {
    const root = top.getRootNode()
    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && root.host) { top = root.host; continue }
    if (root.nodeType === Node.DOCUMENT_NODE && root.defaultView && root.defaultView !== window) {
      const outer = root.defaultView.frameElement
      if (!outer) { crossedInto = true; break }
      top = outer
      continue
    }
    break
  }
  const text = element ? (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim() : ''
  return {
    tag: (element ? element.tagName.toLowerCase() : node.nodeName.toLowerCase()) + pseudo,
    text,
    inClosedFrame: crossedInto,
  }
}`

const CDP_TIMEOUT_MS = 5000

export class PageProbes {
  /** One ref namespace for the session, every tab included. */
  readonly registry = new RefRegistry()
  private readonly probes = new WeakMap<Page, Promise<PageProbe>>()
  private readonly dialogs = new WeakMap<Page, DialogController>()
  /** Every open page's controller: the session dialog policy applies to all of them. */
  private readonly controllers = new Set<DialogController>()
  private dialogSettings: DialogPolicySettings = { policy: 'pending', beforeunload: 'ask' }
  /** The title each tab showed when last read: a closed tab can no longer be asked. */
  private readonly titles = new WeakMap<Page, string>()
  /** How each new page was opened, once a report matched it to its opener's request. */
  private readonly openedAs = new WeakMap<Page, WindowOpenRecord>()
  private readonly pagesByTarget = new Map<string, Page>()
  private readonly logger: ProbeLogger
  /**
   * Whether the user can see a tab, by target id. Absent for a launched browser: its background tabs
   * are not throttled (measured, tab-visibility.ts), so there is nothing to tell.
   */
  private readonly readTabVisibility: ((targetId: string) => Promise<TabVisibility>) | undefined
  /** The session's pace now (its mode can change at `browser use`/`new`): busy reads in fast mode count content changes from the last settle (page-watch BusyOptions). */
  private readonly busyPace: () => 'human' | 'fast'

  constructor(options: { logger: ProbeLogger; busyPace: () => 'human' | 'fast'; readTabVisibility?: (targetId: string) => Promise<TabVisibility> }) {
    this.logger = options.logger
    this.busyPace = options.busyPace
    this.readTabVisibility = options.readTabVisibility
  }

  /**
   * Whether the user can see the tab, read now (never rejects). Null for a launched browser. Not the
   * page's `document.visibilityState`: under Playwright's focus emulation it reads `visible` in a
   * background tab.
   */
  async visibility(probe: { targetId: string }): Promise<TabVisibility | null> {
    if (!this.readTabVisibility) return null
    return await this.readTabVisibility(probe.targetId).catch(
      (error: unknown): TabVisibility => ({ kind: 'unreadable', error: error instanceof Error ? error.message : String(error) }),
    )
  }

  /** The page's dialog controller, attached on first call. Call this as soon as a page is seen. */
  dialogsFor(page: Page): DialogController {
    let controller = this.dialogs.get(page)
    if (!controller) {
      const created = new DialogController({ page, ...this.dialogSettings })
      created.attach()
      this.dialogs.set(page, created)
      this.controllers.add(created)
      page.once('close', () => this.controllers.delete(created))
      controller = created
    }
    return controller
  }

  /** The session dialog policy (`act.dialog.policy`): every tab, open now or opened later, answers by it. */
  setDialogPolicy(policy: DialogPolicy, options: { beforeunload?: BeforeUnloadPolicy; promptText?: string } = {}): DialogPolicySettings {
    this.dialogSettings = {
      policy,
      beforeunload: options.beforeunload ?? 'ask',
      ...(options.promptText !== undefined ? { promptText: options.promptText } : {}),
    }
    for (const controller of this.controllers) controller.setPolicy(policy, options)
    return { ...this.dialogSettings }
  }

  /** The title `page` showed when last read, or undefined when it never was. */
  lastTitle(page: Page): string | undefined {
    return this.titles.get(page)
  }

  /**
   * How `page` was opened by `opener`: its window.open/target=_blank request, matched once and
   * remembered (observe()'s TABS list marks popup windows from then on). Undefined when the opener
   * asked for no such window.
   */
  async openedBy(page: Page, opener: Page, since: number): Promise<WindowOpenRecord | undefined> {
    const known = this.openedAs.get(page)
    if (known) return known
    const record = (await this.get(opener)).windowOpens.take(page.url(), since)
    if (record) this.openedAs.set(page, record)
    return record
  }

  get(page: Page): Promise<PageProbe> {
    let existing = this.probes.get(page)
    if (!existing) {
      const creating = this.create(page)
      this.probes.set(page, creating)
      creating.catch(() => {
        if (this.probes.get(page) === creating) this.probes.delete(page)
      })
      existing = creating
    }
    return existing
  }

  /** The open page of a tab, by CDP target id; null once it closed or when it was never probed. */
  pageOf(targetId: string): Page | null {
    const page = this.pagesByTarget.get(targetId)
    return page && !page.isClosed() ? page : null
  }

  /** The probe of every open tab that has one. */
  async all(): Promise<Array<{ page: Page; probe: PageProbe }>> {
    const found: Array<{ page: Page; probe: PageProbe }> = []
    for (const page of this.pagesByTarget.values()) {
      const probe = page.isClosed() ? undefined : this.probes.get(page)
      if (probe) found.push({ page, probe: await probe })
    }
    return found
  }

  private async create(page: Page): Promise<PageProbe> {
    // Sandbox code's own `filechooser` listener makes Playwright set the file-dialog interception flag
    // the gate sets (the adapter borrows Playwright's session): the gate follows that subscription.
    const outgoing = outgoingCallsOf(page)
    if (!outgoing) {
      throw new Error('This Playwright client exposes no outgoing-call hook (Connection.sendMessageToServer), so file dialogs cannot be held back safely.')
    }
    const cdp = await getCDPSessionForPage({ page })
    const { targetInfo } = await withDeadline(cdp.send('Target.getTargetInfo'), CDP_TIMEOUT_MS, 'reading the tab id (Target.getTargetInfo)')
    if (!targetInfo) {
      throw new Error(`Target.getTargetInfo on the page's own session returned no target for ${page.url()}.`)
    }
    const targetId = targetInfo.targetId
    const holder = this.pagesByTarget.get(targetId)
    if (holder && holder !== page && !holder.isClosed()) {
      // Refs and tab tracking key on the target id: two open tabs under one id would hand one
      // tab's refs to the other.
      throw new Error(
        `Target.getTargetInfo on the session of ${page.url()} answered the target id of another open tab (${holder.url()}): ` +
          'the connection reported the wrong tab. Reconnect with the MCP reset tool.',
      )
    }
    const frames = new PageFrames({ page, cdp })
    const world = frames.main.world
    // Web Vitals and layout shifts are tracked from the page's first world copy on (perf-observers.ts).
    world.addSetup(PERF_SETUP_NAME, PERF_OBSERVERS_SOURCE)
    // The controller is the one record of open dialogs: bound to this session before the watch
    // that reads it, so a dialog closed outside Playwright is seen as closed.
    const dialogs = this.dialogsFor(page)
    dialogs.bindSession(cdp)
    const watch = new PageWatch({ frames, dialogs, isClosed: () => page.isClosed(), logger: this.logger })
    watch.start()
    const fileChoosers = new FileChooserGate({ page, frames, dialogs })
    const onSubscription: OutgoingCallListener = ({ owner, method, params, answered }) => {
      if (owner !== page || method !== 'updateSubscription' || typeof params !== 'object' || params === null) return undefined
      if (Reflect.get(params, 'event') === 'fileChooser') fileChoosers.playwrightToggled(Reflect.get(params, 'enabled') === true, answered)
      return undefined
    }
    outgoing.add(onSubscription)
    const probe: PageProbe = {
      page,
      cdp,
      world,
      frames,
      registry: this.registry,
      watch,
      dialogs,
      history: [],
      targetId,
      lastFullObservation: null,
      fileChoosers,
      pins: new PinTracker({ cdp, getUrl: () => page.url() }),
      windowOpens: new WindowOpens(cdp),
    }
    this.pagesByTarget.set(targetId, page)
    // Picks from the extension's context menu arrive as CDP events from the moment the page is
    // seen, not only once the model asks for one.
    probe.pins.start()
    page.once('close', () => {
      outgoing.delete(onSubscription)
      fileChoosers.dispose()
      watch.dispose()
      frames.dispose()
      probe.pins.dispose()
      probe.windowOpens.dispose()
      this.pagesByTarget.delete(targetId)
      this.registry.closeTab(targetId)
    })
    return probe
  }

  /**
   * Every open tab of the context, marking the controlled one, with the title its tab shows (read in
   * the browser, so a tab frozen by a native dialog still has one). A tab that does not answer in time
   * is labelled as such rather than given an empty title.
   */
  async tabs(page: Page, context: BrowserContext): Promise<TabSummary[]> {
    const pages = context.pages().filter((candidate) => !candidate.isClosed())
    return await Promise.all(
      pages.map(async (candidate, index) => {
        const title = await tabTitle(candidate).then(
          (read) => {
            this.titles.set(candidate, read)
            return read
          },
          (error: unknown) => `(title unreadable: ${error instanceof Error ? error.message.split('.')[0] : String(error)})`,
        )
        return {
          index,
          title,
          url: candidate.url(),
          controlled: candidate === page,
          ...(this.openedAs.get(candidate)?.popup ? { popup: true as const } : {}),
        }
      }),
    )
  }

  /**
   * Observe the page now. With `remember` (the default) the observation is the one rendered to
   * the model: the refs' shown bindings (what act checks before it dispatches) and "new since your
   * last look" follow it. A picture the model never sees (the before-state of an action) updates
   * which refs are alive and nothing else. An observation of a page frozen by a native dialog is
   * never remembered: it shows nothing of the page.
   *
   * `known`: the busy read the caller made a moment ago, since the same last dispatched action
   * (act's busy guard, right before its before-picture): its signals are the observation's, and its
   * accessibility trees are not read again.
   */
  async observe(page: Page, context: BrowserContext, options: ObserveOptions = {}, remember = true, known?: BusyRead): Promise<Observation> {
    const probe = await this.get(page)
    // Busy signals since the last action that reached the page: animations that ran before it
    // are the page's decoration, not its answer to the action.
    const since = probe.history.findLast((record) => record.dispatched && record.checkpoint)?.checkpoint
    // A dialog the agent must answer freezes the page: nothing can be read. One the policy answers
    // by itself is waited out by readBusy(); one can also open between the check and the read,
    // in which case the dialog is what the observation shows.
    const busy: BusyRead | null =
      known ??
      (probe.dialogs.current()?.handling === 'agent'
        ? null
        : await probe.watch.readBusy(since ? { since, pace: this.busyPace() } : { pace: this.busyPace() }).catch((error: unknown) => {
            if (probe.dialogs.current()) return null
            throw error
          }))
    const jsDialog = probe.dialogs.current()
    const visibility = this.visibility(probe)
    const observation = await observePage({
      page,
      frames: probe.frames,
      registry: this.registry,
      targetId: probe.targetId,
      shown: remember,
      previous: probe.lastFullObservation,
      busy: busy?.signals ?? [],
      ...(busy ? { axTrees: busy.axTrees } : {}),
      jsDialog,
      tabs: await this.tabs(page, context),
      options,
    })
    if (!observation.jsDialog) probe.lastFullObservation = observation
    const seen = await visibility
    if (seen?.kind === 'read' && tabIsHidden(seen.report)) observation.tabNotes = [hiddenTabNote(seen.report)]
    const fileDialogs = await probe.fileChoosers.openDialogs()
    if (fileDialogs.length > 0) {
      observation.fileDialogs = fileDialogs.map((record) => {
        const opener = chooserOpener(probe.history, record)
        return { ...(opener ? { openedBy: describeOpener(opener) } : {}), multiple: record.multiple, fillable: record.backendNodeId !== undefined }
      })
    }
    return observation
  }

  /**
   * A fresh "before" picture of the page that the model is not shown. Never a reused earlier
   * observation: a page can change in ways no content mutation records (a class toggle that
   * hides a panel, a property-only value change, scrolling), and a stale before would credit
   * those changes to the next action.
   */
  async baseline(page: Page, context: BrowserContext): Promise<Observation> {
    return await this.observe(page, context, {}, false)
  }

  /**
   * The element `ref` names, resolved for reading: its tab, probe, frame (session and isolated world)
   * and CDP node. Throws an ActError the model can act on when the ref names no live element, or when
   * a native dialog freezes its tab (nothing in it can be read until the dialog is answered).
   */
  async element(ref: number | string): Promise<RefElement> {
    const resolution = this.registry.resolve(ref)
    if (!resolution.ok) throw new ActError(resolution.error)
    const { target } = resolution
    const page = this.pageOf(target.targetId)
    if (!page) {
      throw new ActError(`[${target.ref}] was listed in a tab that is no longer open. observe() the tab you are working in for current refs.`)
    }
    const probe = await this.get(page)
    const dialog = probe.dialogs.current()
    if (dialog) {
      throw new ActError(
        `A native ${dialog.type}("${dialog.message}") dialog is open and freezes the page, so [${target.ref}] cannot be read. ` +
          'Handle it first, like a person would: act.dialog.accept() or act.dialog.dismiss().',
      )
    }
    const frame = await probe.frames.handle(target.frameId)
    const { node } = await withDeadline(
      frame.cdp.send('DOM.describeNode', { backendNodeId: target.backendNodeId }),
      CDP_TIMEOUT_MS,
      `describing [${target.ref}]`,
    )
    return { page, probe, target, frame, node }
  }

  /**
   * Place a node the human pointed at (a pin, a pick) or a read returned among `observation`'s
   * listed elements. `frame`: the frame whose session the backend id belongs to (the main frame
   * when absent) — backend ids are per renderer process, so only elements read through the same
   * session can be the node or contain it.
   */
  async locateNode(page: Page, observation: Observation, backendNodeId: number, frame?: FrameHandle): Promise<LocatedNode> {
    const probe = await this.get(page)
    const where = frame ?? probe.frames.main
    const sessionOf = new Map((await probe.frames.list()).frames.map((entry) => [entry.frameId, entry.cdp]))
    const listed = new Map(
      observation.elements.filter((element) => sessionOf.get(element.frameId) === where.cdp).map((element) => [element.backendNodeId, element]),
    )
    const direct = listed.get(backendNodeId)
    if (direct) return { kind: 'element', element: direct, exact: true }
    const ancestry = await where.world.nodesReturnedBy([backendNodeId], ANCESTRY_FN, {
      what: `reading the ancestors of node ${backendNodeId}`,
    })
    if (ancestry.length === 0) return { kind: 'gone' }
    for (const id of ancestry) {
      const element = id === null ? undefined : listed.get(id)
      if (element) return { kind: 'element', element, exact: false }
    }
    const description = await where.world.callFunctionOnNodes<{ tag: string; text: string; inClosedFrame: boolean } | null>(
      [backendNodeId],
      DESCRIBE_FN,
      { what: `describing node ${backendNodeId}` },
    )
    if (!description) return { kind: 'gone' }
    return { kind: 'content', tag: description.tag, text: description.text, inClosedFrame: description.inClosedFrame }
  }
}
