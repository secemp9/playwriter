/**
 * isolated-world.ts — a private JavaScript realm in one frame of a page.
 *
 * Playwriter has to read and watch the page under test without changing it: no injected
 * elements, no globals in the page's own realm, no init scripts. A CDP isolated world
 * (`Page.createIsolatedWorld`) gives exactly that. It shares the frame's DOM, so a
 * MutationObserver installed here sees every mutation the page makes and
 * `getComputedStyle`/`getBoundingClientRect` read the real layout, but it has its own
 * globals, which page scripts cannot see or reach. Nothing is written to the DOM.
 *
 * Lifetime: a world belongs to one document of one frame (`PageFrames` keeps one per frame, on
 * the session that owns the frame). A cross-document navigation destroys it. The next call
 * recreates it and replays every registered setup script, so callers never hold a dead context
 * id and never re-install their own instrumentation.
 *
 * Every protocol round trip has a deadline: while a native JS dialog is open, or the
 * renderer's main thread is wedged, Runtime/DOM calls simply do not answer.
 */

import type { ICDPSession } from './cdp-session.js'
import { ModelFacingError } from './probe-types.js'

export const PLAYWRITER_WORLD_NAME = '__playwriter_probe__'

const DEFAULT_TIMEOUT_MS = 5000

/**
 * The renderer did not answer in time. The message states only that; the executor adds what it
 * knows about the tab (an open dialog, a hidden tab) — tab-state.ts `unresponsiveDiagnosis`.
 */
export class PageUnresponsiveError extends ModelFacingError {
  constructor(what: string, timeoutMs: number) {
    super(`The page did not respond within ${timeoutMs}ms while ${what}.`)
    this.name = 'PageUnresponsiveError'
  }
}

/** Race a promise against a deadline; the rejection names what was being waited for. */
export async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new PageUnresponsiveError(what, timeoutMs)), timeoutMs)
  try {
    return await Promise.race([promise, expired.promise])
  } finally {
    clearTimeout(timer)
  }
}

const DEAD_CONTEXT_RE = /Cannot find context with specified id|Execution context was destroyed|Cannot find execution context|Inspected target navigated or closed/i

function isDeadContextError(error: unknown): boolean {
  return DEAD_CONTEXT_RE.test(error instanceof Error ? error.message : String(error))
}

/** Chrome's answers for a backend node id whose node no longer exists or whose document is gone. */
const NODE_GONE_RE = /No node with given id found|does not belong to the document|Could not find node with given id/i

/** The node a backend id names no longer exists (removed, or its document replaced). */
export function isNodeGoneError(error: unknown): boolean {
  return !(error instanceof PageUnresponsiveError) && NODE_GONE_RE.test(error instanceof Error ? error.message : String(error))
}

interface RemoteObjectLike {
  value?: unknown
  description?: string
  objectId?: string
}

interface ExceptionDetailsLike {
  text?: string
  exception?: { description?: string }
}

function describeException(details: ExceptionDetailsLike): string {
  return details.exception?.description || details.text || 'unknown exception'
}

export class IsolatedWorld {
  private readonly cdp: ICDPSession
  private readonly getFrameId: () => string
  private readonly worldName: string
  private contextIdPromise: Promise<number> | null = null
  private contextId: number | null = null
  private readonly setups = new Map<string, string>()
  private domEnabled = false
  private readonly onContextDestroyed = (event: { executionContextId: number }): void => {
    if (event.executionContextId === this.contextId) this.invalidate()
  }
  private readonly onContextsCleared = (): void => {
    this.invalidate()
  }

  constructor(options: { cdp: ICDPSession; getFrameId: () => string; worldName?: string }) {
    this.cdp = options.cdp
    this.getFrameId = options.getFrameId
    this.worldName = options.worldName ?? PLAYWRITER_WORLD_NAME
    this.cdp.on('Runtime.executionContextDestroyed', this.onContextDestroyed)
    this.cdp.on('Runtime.executionContextsCleared', this.onContextsCleared)
  }

  /**
   * Register code that must run once in every fresh copy of the world (for example: install
   * a MutationObserver and expose a reader object). Re-registering a name replaces the source
   * for future copies only; it does not re-run in the current one.
   */
  addSetup(name: string, source: string): void {
    this.setups.set(name, source)
  }

  /** Forget the current context; the next call creates a new world. */
  invalidate(): void {
    this.contextId = null
    this.contextIdPromise = null
  }

  dispose(): void {
    this.cdp.off('Runtime.executionContextDestroyed', this.onContextDestroyed)
    this.cdp.off('Runtime.executionContextsCleared', this.onContextsCleared)
    this.invalidate()
  }

  /** The id of a live world context, creating the world (and running setups) if needed. */
  async getContextId(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number> {
    if (!this.contextIdPromise) {
      const creating = this.createWorld(timeoutMs)
      this.contextIdPromise = creating
      creating.catch(() => {
        if (this.contextIdPromise === creating) this.contextIdPromise = null
      })
    }
    return await this.contextIdPromise
  }

  private async createWorld(timeoutMs: number): Promise<number> {
    const frameId = this.getFrameId()
    const created = await withDeadline(
      this.cdp.send('Page.createIsolatedWorld', { frameId, worldName: this.worldName, grantUniveralAccess: false }),
      timeoutMs,
      `creating the isolated probe world on frame ${frameId}`,
    )
    const contextId = created.executionContextId
    for (const [name, source] of this.setups) {
      const result = (await withDeadline(
        this.cdp.send('Runtime.evaluate', { expression: source, contextId, returnByValue: true, awaitPromise: true }),
        timeoutMs,
        `running probe setup "${name}"`,
      )) as { exceptionDetails?: ExceptionDetailsLike }
      if (result.exceptionDetails) {
        throw new Error(`Probe setup "${name}" threw in the isolated world: ${describeException(result.exceptionDetails)}`)
      }
    }
    this.contextId = contextId
    return contextId
  }

  /**
   * Evaluate an expression in the world and return its value (returnByValue). Retries once
   * on a destroyed context: a navigation between two calls is normal, not an error.
   */
  async evaluate<T>(expression: string, options: { timeoutMs?: number; awaitPromise?: boolean; what?: string } = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const what = options.what ?? 'evaluating in the isolated probe world'
    for (let attempt = 0; ; attempt++) {
      try {
        const contextId = await this.getContextId(timeoutMs)
        const result = (await withDeadline(
          this.cdp.send('Runtime.evaluate', {
            expression,
            contextId,
            returnByValue: true,
            awaitPromise: options.awaitPromise ?? false,
          }),
          timeoutMs,
          what,
        )) as { result: RemoteObjectLike; exceptionDetails?: ExceptionDetailsLike }
        if (result.exceptionDetails) {
          throw new Error(`${what}: ${describeException(result.exceptionDetails)}`)
        }
        return result.result.value as T
      } catch (error) {
        if (attempt === 0 && isDeadContextError(error)) {
          this.invalidate()
          continue
        }
        throw error
      }
    }
  }

  /**
   * Call `functionDeclaration` in the world as `fn(args, ...elements)`, where `elements` are
   * the DOM nodes for `backendNodeIds` (null for a node that no longer exists). Read-only by
   * convention: callers use this to measure and read, not to change the page.
   */
  async callFunctionOnNodes<T>(
    backendNodeIds: number[],
    functionDeclaration: string,
    options: { args?: unknown; timeoutMs?: number; what?: string } = {},
  ): Promise<T> {
    const what = options.what ?? 'calling a probe function on page elements'
    return await this.withNodes(backendNodeIds, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, async ({ contextId, objectIds, timeoutMs }) => {
      const result = (await withDeadline(
        this.cdp.send('Runtime.callFunctionOn', {
          functionDeclaration,
          executionContextId: contextId,
          arguments: [{ value: options.args ?? null }, ...objectIds.map((objectId) => (objectId ? { objectId } : { value: null }))],
          returnByValue: true,
          awaitPromise: true,
        }),
        timeoutMs,
        what,
      )) as { result: RemoteObjectLike; exceptionDetails?: ExceptionDetailsLike }
      if (result.exceptionDetails) {
        throw new Error(`${what}: ${describeException(result.exceptionDetails)}`)
      }
      return result.result.value as T
    })
  }

  /**
   * Like `callFunctionOnNodes`, for a function that returns an array of DOM nodes: each comes back
   * as its backendNodeId, null where the array holds something that is not a node. This is how a
   * node found in the world (a label's control, an ancestor) gets an id CDP can address.
   */
  async nodesReturnedBy(
    backendNodeIds: number[],
    functionDeclaration: string,
    options: { args?: unknown; timeoutMs?: number; what?: string } = {},
  ): Promise<Array<number | null>> {
    const what = options.what ?? 'finding page elements'
    return await this.withNodes(backendNodeIds, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, async ({ contextId, objectIds, objectGroup, timeoutMs }) => {
      const result = (await withDeadline(
        this.cdp.send('Runtime.callFunctionOn', {
          functionDeclaration,
          executionContextId: contextId,
          arguments: [{ value: options.args ?? null }, ...objectIds.map((objectId) => (objectId ? { objectId } : { value: null }))],
          returnByValue: false,
          awaitPromise: true,
          objectGroup,
        }),
        timeoutMs,
        what,
      )) as { result: RemoteObjectLike & { type?: string; subtype?: string }; exceptionDetails?: ExceptionDetailsLike }
      if (result.exceptionDetails) {
        throw new Error(`${what}: ${describeException(result.exceptionDetails)}`)
      }
      if (result.result.subtype !== 'array' || !result.result.objectId) {
        throw new Error(`${what}: the probe function returned ${result.result.subtype ?? result.result.type}, not an array of nodes.`)
      }
      const { result: properties } = await withDeadline(
        this.cdp.send('Runtime.getProperties', { objectId: result.result.objectId, ownProperties: true }),
        timeoutMs,
        `${what} (listing the nodes found)`,
      )
      const length = properties.find((property) => property.name === 'length')?.value?.value
      if (typeof length !== 'number') throw new Error(`${what}: the returned array has no length.`)
      const ids: Array<number | null> = Array.from({ length }, () => null)
      await Promise.all(
        properties.map(async (property) => {
          const objectId = property.value?.objectId
          if (!/^\d+$/.test(property.name) || property.value?.subtype !== 'node' || !objectId) return
          const described = await withDeadline(
            this.cdp.send('DOM.describeNode', { objectId }),
            timeoutMs,
            `${what} (identifying node ${property.name})`,
          )
          ids[Number(property.name)] = described.node.backendNodeId
        }),
      )
      return ids
    })
  }

  /**
   * Resolve `backendNodeIds` into the world (null for a node that no longer exists) and run `work`
   * with them. A destroyed context — a navigation between two calls — is retried once in a fresh
   * world; the objects are released afterwards.
   */
  private async withNodes<T>(
    backendNodeIds: number[],
    timeoutMs: number,
    work: (scope: { contextId: number; objectIds: Array<string | null>; objectGroup: string; timeoutMs: number }) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const objectGroup = `playwriter-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`
      try {
        const contextId = await this.getContextId(timeoutMs)
        if (!this.domEnabled) {
          await withDeadline(this.cdp.send('DOM.enable'), timeoutMs, 'enabling the DOM domain')
          this.domEnabled = true
        }
        const objectIds = await Promise.all(
          backendNodeIds.map(async (backendNodeId) => {
            try {
              const resolved = await withDeadline(
                this.cdp.send('DOM.resolveNode', { backendNodeId, executionContextId: contextId, objectGroup }),
                timeoutMs,
                `resolving node ${backendNodeId}`,
              )
              return resolved.object.objectId ?? null
            } catch (error) {
              if (isNodeGoneError(error)) return null
              throw error
            }
          }),
        )
        return await work({ contextId, objectIds, objectGroup, timeoutMs })
      } catch (error) {
        if (attempt === 0 && isDeadContextError(error)) {
          this.invalidate()
          continue
        }
        throw error
      } finally {
        // A context that died with a navigation took its objects with it; nothing is left to release.
        await withDeadline(this.cdp.send('Runtime.releaseObjectGroup', { objectGroup }), timeoutMs, 'releasing the probe objects').catch(
          (error: unknown) => {
            if (!isDeadContextError(error)) throw error
          },
        )
      }
    }
  }
}
