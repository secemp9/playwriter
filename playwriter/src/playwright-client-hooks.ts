/**
 * playwright-client-hooks.ts — seeing the calls this process's Playwright client sends, as they go out.
 *
 * Playwright's client instrumentation says that a call starts, not which object it targets. Every
 * call goes through `Connection.sendMessageToServer(object, method, params, apiCall)`, which is where
 * Playwright itself reads the target (`object._guid`), synchronously right after onApiCallBegin. That
 * one method is hooked, once per connection.
 */

import type { Page } from '@xmorse/playwright-core'

/** One call on its way to Playwright's server. */
export interface OutgoingCall {
  /** The object it was made on: a Page, Frame, ElementHandle… */
  owner: object
  /** The protocol method (`click`, `updateSubscription`, …). */
  method: string
  params: unknown
  /** The same apiCall object the instrumentation's onApiCallBegin received. */
  apiCall: object
  /** Settles with the server's answer: the call has had its effect on the server (and the browser) by then. */
  answered: Promise<unknown>
}

/** Told about each call as it goes out. A returned promise holds the call back until it settles. */
export type OutgoingCallListener = (call: OutgoingCall) => Promise<void> | undefined

/** Per Playwright connection: the listeners its hooked `sendMessageToServer` calls. */
const outgoingCallListeners = new WeakMap<object, Set<OutgoingCallListener>>()

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'then') === 'function'
}

/**
 * The outgoing-call listeners of `page`'s Playwright connection, hooking the connection on first use,
 * or null when this client has no such connection. One hook per connection, installed once and never
 * removed: several sessions can share a connection, and restoring a saved original would drop
 * whichever hook was installed after it. Listeners run outside Playwright's API zone, so the calls
 * they make are their own API calls rather than parts of the call being held.
 */
export function outgoingCallsOf(page: Page): Set<OutgoingCallListener> | null {
  const connection: unknown = Reflect.get(page, '_connection')
  if (typeof connection !== 'object' || connection === null) return null
  const existing = outgoingCallListeners.get(connection)
  if (existing) return existing
  const send: unknown = Reflect.get(connection, 'sendMessageToServer')
  const platform: unknown = Reflect.get(connection, '_platform')
  const zones: unknown = typeof platform === 'object' && platform !== null ? Reflect.get(platform, 'zones') : undefined
  const emptyZone: unknown = typeof zones === 'object' && zones !== null ? Reflect.get(zones, 'empty') : undefined
  const runInZone: unknown = typeof emptyZone === 'object' && emptyZone !== null ? Reflect.get(emptyZone, 'run') : undefined
  if (typeof send !== 'function' || typeof runInZone !== 'function') return null
  const listeners = new Set<OutgoingCallListener>()
  const hooked = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const [owner, method, params, apiCall] = args
    if (listeners.size === 0 || typeof owner !== 'object' || owner === null || typeof method !== 'string' || typeof apiCall !== 'object' || apiCall === null) {
      return await Reflect.apply(send, this, args)
    }
    const answered = Promise.withResolvers<unknown>()
    // A listener that does not read the answer must not leave a rejection unhandled.
    answered.promise.catch(() => {})
    const call: OutgoingCall = { owner, method, params, apiCall, answered: answered.promise }
    const holds: Array<PromiseLike<unknown>> = []
    for (const listener of listeners) {
      const hold: unknown = Reflect.apply(runInZone, emptyZone, [() => listener(call)])
      if (isThenable(hold)) holds.push(hold)
    }
    // Nothing to wait for: the call goes out in this same tick, in the order it was made.
    if (holds.length > 0) await Promise.all(holds)
    try {
      const result: unknown = await Reflect.apply(send, this, args)
      answered.resolve(result)
      return result
    } catch (error) {
      answered.reject(error)
      throw error
    }
  }
  Reflect.set(connection, 'sendMessageToServer', hooked)
  outgoingCallListeners.set(connection, listeners)
  return listeners
}
