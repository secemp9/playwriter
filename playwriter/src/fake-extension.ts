/**
 * Test helper: a fake Playwriter extension that speaks the relay's real extension WebSocket protocol.
 *
 * It connects to `/extension` the way the service worker does (query string = what the extension
 * reports about its browser and profile), attaches one page tab owned by `workspace`, answers every
 * forwarded CDP command (with a frame tree for `Page.getFrameTree`, an execution context after
 * `Runtime.enable`, `{}` for the rest) and records the commands it was sent.
 */

import net from 'node:net'
import WebSocket from 'ws'

/** An allowlisted EXTENSION_ID: the relay only accepts extension sockets from these origins. */
const EXTENSION_ORIGIN = 'chrome-extension://jfeammnjpkecdekppnclgkkffahnhfhe'

export type ForwardedCommand = { method: string; sessionId?: string; params?: Record<string, unknown> }

export type FakeExtension = {
  name: string
  ws: WebSocket
  /** Every CDP command the relay forwarded to this browser, in order. */
  forwarded: ForwardedCommand[]
  workspace: string
}

/** A port nothing listens on right now, on 127.0.0.1. */
export function freePort(): Promise<number> {
  const found = Promise.withResolvers<number>()
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => (address && typeof address !== 'string' ? found.resolve(address.port) : found.reject(new Error('no port'))))
  })
  return found.promise
}

function opened(socket: WebSocket): Promise<void> {
  const open = Promise.withResolvers<void>()
  socket.once('open', () => open.resolve())
  socket.once('error', (error) => open.reject(error))
  return open.promise
}

/**
 * Connect a fake extension for one browser to the relay on `port`, with one page tab at `url`
 * owned by `workspace`. `query` is what the extension sends on connect (`browser`, `installId`,
 * `email`, `id`, `v`, `userAgent`, `browserVersion`).
 */
export async function connectFakeExtension({
  port,
  name,
  query,
  workspace,
  url = 'about:blank',
}: {
  port: number
  name: string
  query: Record<string, string>
  workspace: string
  url?: string
}): Promise<FakeExtension> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?${new URLSearchParams(query).toString()}`, { headers: { origin: EXTENSION_ORIGIN } })
  const fake: FakeExtension = { name, ws, forwarded: [], workspace }
  const event = (method: string, params: unknown, sessionId?: string) => {
    ws.send(JSON.stringify({ method: 'forwardCDPEvent', params: { method, params, sessionId, workspaceKey: workspace } }))
  }
  ws.on('message', (raw: WebSocket.RawData) => {
    const message: { id?: number; method?: string; params?: ForwardedCommand } = JSON.parse(raw.toString())
    if (message.id === undefined || !message.method) return
    const command = message.method === 'forwardCDPCommand' ? message.params : undefined
    if (command) fake.forwarded.push(command)
    let result: unknown = {}
    if (command?.method === 'Page.getFrameTree') {
      result = {
        frameTree: {
          frame: {
            id: `${name}-target`,
            loaderId: 'loader',
            url,
            domainAndRegistry: '',
            securityOrigin: '://',
            mimeType: 'text/html',
            secureContextType: 'InsecureScheme',
            crossOriginIsolatedContextType: 'NotIsolated',
            gatedAPIFeatures: [],
          },
        },
      }
    }
    ws.send(JSON.stringify({ id: message.id, result }))
    if (command?.method === 'Runtime.enable' && command.sessionId) {
      event(
        'Runtime.executionContextCreated',
        { context: { id: 1, origin: '', name: '', uniqueId: `${name}-ctx`, auxData: { isDefault: true, type: 'default', frameId: `${name}-target` } } },
        command.sessionId,
      )
    }
  })
  await opened(ws)
  event('Target.attachedToTarget', {
    sessionId: `${name}-tab`,
    targetInfo: { targetId: `${name}-target`, type: 'page', title: name, url, attached: true, canAccessOpener: false, browserContextId: 'ctx' },
    waitingForDebugger: false,
  })
  return fake
}
