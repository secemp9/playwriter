/**
 * dialog-controller.ts — native JS dialogs (alert/confirm/prompt/beforeunload) handled the
 * way a person handles them, and THE one record of whether a dialog is open on a page.
 *
 * Without a `dialog` listener Playwright dismisses every dialog on its own, so a "Delete"
 * button guarded by `confirm()` silently did nothing and the agent concluded the feature
 * was broken. With this controller attached:
 *
 *  - `pending` (default): an alert is acknowledged automatically (there is only one
 *    button; nothing to decide) and recorded as `auto-accepted`. A confirm, prompt or
 *    beforeunload STAYS OPEN until the agent calls `accept()` / `dismiss()`, exactly like
 *    a person reading the question before answering — a "Leave site?" prompt is a
 *    decision about the page's unsaved work, and accepting it silently would discard
 *    that work. While it is open the page's JS is frozen (and a beforeunload holds the
 *    navigation that raised it).
 *  - `accept` / `dismiss` (the session policy, `act.dialog.policy`): a confirm or prompt is
 *    answered at once (a prompt accepted with the policy's text, else its own default) and
 *    recorded with `answeredBy: 'policy'`. A beforeunload is answered only by its own
 *    explicit setting (`beforeunload: 'leave' | 'stay'`), never implied by `accept`.
 *
 * Every open dialog — the ones the policy answers too, until they are actually closed —
 * is reported by `current()` with `handling: 'auto' | 'agent'`, and every open/close is
 * announced through `onChange`, so PageWatch and the act layer read one truth.
 *
 * Truth comes from the page's own CDP session (`bindSession`): `Page.javascriptDialogOpening`
 * and `Page.javascriptDialogClosed` see every dialog and every close, including the person
 * clicking OK in his real Chrome and other code answering it; Playwright's `dialog` event
 * supplies the handle the answer is sent through (which keeps Playwright's own dialog
 * bookkeeping consistent). Whichever of the two arrives first opens the record. A
 * main-frame navigation or the page closing also ends it.
 */

import type { Dialog, Frame, Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import { withDeadline } from './isolated-world.js'
import { ModelFacingError, type JsDialogState } from './probe-types.js'

/** Confirm and prompt: `pending` waits for the agent (act.dialog.policy('ask')); `accept`/`dismiss` answer as they open. */
export type DialogPolicy = 'pending' | 'accept' | 'dismiss'
/** beforeunload ("Leave site?"): `ask` waits for the agent; `leave` accepts it, `stay` dismisses it. */
export type BeforeUnloadPolicy = 'ask' | 'leave' | 'stay'

export interface DialogPolicySettings {
  policy: DialogPolicy
  beforeunload: BeforeUnloadPolicy
  /** Text an accepted prompt is answered with; absent: the prompt's own default. */
  promptText?: string
}

/** `prompt("What is your name?", default "Guest")`: what the dialog asks, the way the model reads it. */
export function dialogLabel(state: Pick<JsDialogState, 'type' | 'message' | 'defaultValue'>): string {
  const fallback = state.type === 'prompt' && state.defaultValue !== undefined ? `, default "${state.defaultValue}"` : ''
  return `${state.type}("${state.message}"${fallback})`
}

/** How a closed dialog was answered: `accepted by the session dialog policy with "Guest"`. */
export function dialogAnswerText(state: JsDialogState): string {
  if (state.outcome === undefined) return 'closed (which button is unknown: it closed outside this session)'
  if (state.outcome === 'auto-accepted') return 'accepted automatically'
  const text = state.type === 'prompt' && state.outcome === 'accepted' && state.promptText !== undefined ? ` with "${state.promptText}"` : ''
  return `${state.outcome}${state.answeredBy === 'policy' ? ' by the session dialog policy' : ''}${text}`
}

const HISTORY_CAP = 100
/** Answering a dialog is one protocol round trip; if it does not come back, say so rather than hang. */
const HANDLE_TIMEOUT_MS = 5000
/** Playwright's wording when its Dialog object was already answered (by other script code). */
const ALREADY_HANDLED_RE = /already handled/i
/** Chrome's wording when the dialog is no longer showing (closed in the browser, or by a navigation). */
const NOT_SHOWING_RE = /No dialog is showing/i

type Outcome = NonNullable<JsDialogState['outcome']>

interface OpenDialog {
  state: JsDialogState
  /** Playwright's handle, once its `dialog` event arrived; answers go through it. */
  handle: PromiseWithResolvers<Dialog>
  hasHandle: boolean
  /** The answer being sent, so the CDP "closed" event can be attributed to it. */
  answering?: Outcome
}

export class DialogController {
  private readonly page: Page
  private settings: DialogPolicySettings
  private attached = false
  private session: ICDPSession | null = null
  private open: OpenDialog | null = null
  private readonly log: JsDialogState[] = []
  private readonly listeners = new Set<(state: JsDialogState | null) => void>()

  constructor(options: { page: Page; policy?: DialogPolicy; beforeunload?: BeforeUnloadPolicy; promptText?: string }) {
    this.page = options.page
    this.settings = {
      policy: options.policy ?? 'pending',
      beforeunload: options.beforeunload ?? 'ask',
      ...(options.promptText !== undefined ? { promptText: options.promptText } : {}),
    }
  }

  /** Must run synchronously when the page is first seen: from then on Playwright no longer auto-dismisses. */
  attach(): void {
    if (this.attached) return
    this.attached = true
    this.page.on('dialog', this.onDialog)
    this.page.on('framenavigated', this.onFrameNavigated)
    this.page.on('close', this.onPageClose)
  }

  /**
   * Feed the controller from the page's CDP session (`getCDPSessionForPage`), so dialogs
   * closed outside Playwright are seen as closed. Idempotent for the same session.
   */
  bindSession(cdp: ICDPSession): void {
    if (this.session === cdp) return
    if (this.session) {
      throw new Error('DialogController is already bound to another CDP session; a page has exactly one.')
    }
    this.session = cdp
    cdp.on('Page.javascriptDialogOpening', this.onCdpOpening)
    cdp.on('Page.javascriptDialogClosed', this.onCdpClosed)
  }

  /** The open dialog, whoever answers it (`handling`), or null. */
  current(): JsDialogState | null {
    const open = this.open
    return open && open.state.closedAt === undefined ? { ...open.state } : null
  }

  /**
   * Called synchronously with `current()` whenever a dialog opens, closes, or changes
   * who answers it. Returns the unsubscribe function.
   */
  onChange(listener: (state: JsDialogState | null) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  history(): JsDialogState[] {
    return this.log.map((state) => ({ ...state }))
  }

  async accept(promptText?: string): Promise<JsDialogState> {
    return await this.answer('accepted', promptText)
  }

  async dismiss(): Promise<JsDialogState> {
    return await this.answer('dismissed', undefined)
  }

  /** The policy in force: what a dialog that opens now is answered with. */
  policySettings(): DialogPolicySettings {
    return { ...this.settings }
  }

  /**
   * Set the policy. A confirm/prompt (or, with an explicit `beforeunload`, a "Leave site?") that
   * waits for the agent right now is answered by the new policy at once.
   */
  setPolicy(policy: DialogPolicy, options: { beforeunload?: BeforeUnloadPolicy; promptText?: string } = {}): void {
    this.settings = {
      policy,
      beforeunload: options.beforeunload ?? 'ask',
      ...(options.promptText !== undefined ? { promptText: options.promptText } : {}),
    }
    const open = this.open
    if (!open || open.state.handling === 'auto' || open.answering || this.policyAnswer(open.state.type) === null) return
    open.state.handling = 'auto'
    this.notify()
    void this.answerAutomatically(open)
  }

  /** The answer the policy gives a dialog of `type` as it opens; null: the agent answers it. */
  private policyAnswer(type: JsDialogState['type']): Outcome | null {
    if (type === 'alert') return this.settings.policy === 'dismiss' ? 'dismissed' : 'auto-accepted'
    if (type === 'beforeunload') {
      return this.settings.beforeunload === 'leave' ? 'accepted' : this.settings.beforeunload === 'stay' ? 'dismissed' : null
    }
    return this.settings.policy === 'accept' ? 'accepted' : this.settings.policy === 'dismiss' ? 'dismissed' : null
  }

  private notify(): void {
    const state = this.current()
    for (const listener of this.listeners) listener(state)
  }

  private openDialog(type: JsDialogState['type'], message: string, defaultValue: string | undefined): OpenDialog {
    const stale = this.open
    // Chrome shows one dialog per page at a time: a new one means the previous one closed,
    // with which button unknown here.
    if (stale) this.markClosed(stale, stale.answering)
    const handling: JsDialogState['handling'] = this.policyAnswer(type) === null ? 'agent' : 'auto'
    const state: JsDialogState = { type, message, openedAt: Date.now(), handling }
    if (type === 'prompt' && defaultValue !== undefined) state.defaultValue = defaultValue
    this.log.push(state)
    if (this.log.length > HISTORY_CAP) this.log.shift()
    const open: OpenDialog = { state, handle: Promise.withResolvers<Dialog>(), hasHandle: false }
    this.open = open
    this.notify()
    return open
  }

  private async answer(outcome: 'accepted' | 'dismissed', promptText: string | undefined): Promise<JsDialogState> {
    const open = this.open
    if (!open || open.state.closedAt !== undefined) throw new ModelFacingError('No native dialog is open.')
    if (open.state.handling === 'auto') {
      throw new ModelFacingError(
        `The ${open.state.type} dialog "${open.state.message.slice(0, 80)}" is answered automatically by the dialog policy; there is nothing for you to answer.`,
      )
    }
    if (open.answering) {
      throw new ModelFacingError(`The ${open.state.type} dialog is already being ${open.answering === 'dismissed' ? 'dismissed' : 'accepted'}.`)
    }
    await this.send(open, outcome, promptText)
    return { ...open.state }
  }

  /**
   * The policy's answer. A failure leaves the dialog open and hands it to the agent
   * (`handling: 'agent'`), which `current()` and `onChange` report — the failure is not
   * thrown out of Playwright's event listener, it is the state change.
   */
  private async answerAutomatically(open: OpenDialog): Promise<void> {
    const outcome = this.policyAnswer(open.state.type)
    if (outcome === null) {
      // The policy changed to `ask` before the handle arrived: the agent answers it.
      open.state.handling = 'agent'
      this.notify()
      return
    }
    if (open.state.type !== 'alert') open.state.answeredBy = 'policy'
    try {
      await this.send(open, outcome, open.state.type === 'prompt' ? this.settings.promptText : undefined)
    } catch {
      if (open.state.closedAt === undefined && open.state.handling === 'auto') {
        delete open.state.answeredBy
        open.state.handling = 'agent'
        this.notify()
      }
    }
  }

  /** Answer through Playwright (which keeps its own dialog bookkeeping consistent). */
  private async send(open: OpenDialog, outcome: Outcome, promptText: string | undefined): Promise<void> {
    open.answering = outcome
    const verb = outcome === 'dismissed' ? 'dismissing' : 'accepting'
    const what = `the ${open.state.type} dialog "${open.state.message.slice(0, 80)}"`
    // OK on a prompt nobody typed into returns what the field shows: its default.
    const text = open.state.type === 'prompt' && outcome === 'accepted' ? (promptText ?? open.state.defaultValue ?? '') : promptText
    try {
      const dialog = await withDeadline(open.handle.promise, HANDLE_TIMEOUT_MS, `waiting for Playwright to report ${what}`)
      await withDeadline(
        outcome === 'dismissed' ? dialog.dismiss() : dialog.accept(text),
        HANDLE_TIMEOUT_MS,
        `${verb} ${what}`,
      )
      if (open.state.type === 'prompt' && outcome === 'accepted' && text !== undefined) open.state.promptText = text
      this.markClosed(open, outcome)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (NOT_SHOWING_RE.test(message)) {
        this.markClosed(open, undefined)
        throw new ModelFacingError(
          `${what} was already closed elsewhere (by the person at the browser, or by a navigation) — there is nothing left to answer.`,
        )
      }
      if (ALREADY_HANDLED_RE.test(message)) {
        this.markClosed(open, undefined)
        throw new ModelFacingError(`${what} was already answered by other code (a page.on('dialog') handler in the script?).`)
      }
      if (this.page.isClosed()) {
        this.markClosed(open, undefined)
      } else if (open.state.closedAt === undefined) {
        // Still open and nobody answered it: whoever answers it can retry.
        open.answering = undefined
      }
      throw error
    }
  }

  private markClosed(open: OpenDialog, outcome: Outcome | undefined): void {
    if (open.state.closedAt !== undefined) return
    if (outcome !== undefined) open.state.outcome = outcome
    open.state.closedAt = Date.now()
    if (this.open !== open) return
    this.open = null
    this.notify()
  }

  private readonly onCdpOpening = (event: Protocol.Page.JavascriptDialogOpeningEvent): void => {
    const open = this.open
    // Playwright's `dialog` event got here first for this very dialog.
    if (open && open.hasHandle && open.state.type === event.type && open.state.message === event.message) return
    this.openDialog(event.type, event.message, event.defaultPrompt)
  }

  private readonly onDialog = (dialog: Dialog): void => {
    const type = dialog.type() as JsDialogState['type']
    const message = dialog.message()
    const known = this.open
    const open =
      known && !known.hasHandle && known.state.type === type && known.state.message === message
        ? known
        : this.openDialog(type, message, type === 'prompt' ? dialog.defaultValue() : undefined)
    open.hasHandle = true
    open.handle.resolve(dialog)
    if (open.state.handling === 'auto' && !open.answering) void this.answerAutomatically(open)
  }

  /** Someone closed it (the human in his Chrome, other script code, or our own answer arriving first). */
  private readonly onCdpClosed = (event: Protocol.Page.JavascriptDialogClosedEvent): void => {
    const open = this.open
    if (!open) return
    this.markClosed(open, open.answering ?? (event.result ? 'accepted' : 'dismissed'))
  }

  /** A main-frame navigation can only commit once the dialog is gone; which button was used is unknown here. */
  private readonly onFrameNavigated = (frame: Frame): void => {
    const open = this.open
    if (open && frame === this.page.mainFrame()) this.markClosed(open, open.answering)
  }

  private readonly onPageClose = (): void => {
    const open = this.open
    if (open) this.markClosed(open, open.answering)
  }
}
