import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import WebSocket from 'ws'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'

// ─────────────────────────────────────────────────────────────────────────────
// TODO 24 — the decisive cross-workspace isolation test.
//
// This drives the REAL relay (startPlayWriterCDPRelayServer, imported from source)
// over real WebSockets, with a FAKE EXTENSION as the test double (a legitimate,
// expected harness — it stands in for Chrome+extension, not for any logic under
// test) and TWO Playwright clients connecting with DIFFERENT `?workspace=` keys.
//
// Why this harness and not the real-Chrome e2e suite: every existing e2e client
// connects keyless (chromium.connectOverCDP(getCdpUrl({port}))) and is rejected by
// Todo 12's 4005 "Missing workspace" close BEFORE any onMessage runs — those clients
// only learn to send keys in Todo 26, which has not landed. A real-Chrome Todo 24
// therefore cannot exist before Todo 26. This raw-WebSocket harness sidesteps the 84
// keyless call sites entirely: it sends the keys itself, so the decisive assertion is
// enforceable TODAY, independent of Todo 26. (It formalizes scratchpad/todo17- and
// todo20-realproof.mjs into a committed test.)
//
// THE DECISIVE ASSERTION is (2): each client receives `Target.attachedToTarget` ONLY
// for its own workspace's targets. This is the EVENT the setAutoAttach replay emits —
// the exact channel Todo 13 filters. A test that asserted only on `Target.getTargets`
// (Todo 16's filter) would still pass with Todo 13 reverted — that is why the spec
// mandates asserting on the events. The revert-check (temporarily deleting Todo 13's
// `if (!visibleToWorkspace(...)) continue`) MUST make assertion (2) fail; if it does
// not, the test has no teeth.
// ─────────────────────────────────────────────────────────────────────────────

const TEST_PORT = 19771
const EXT_ORIGIN = 'chrome-extension://jfeammnjpkecdekppnclgkkffahnhfhe' // an allowlisted EXTENSION_ID

const KEY_A = 'wt:aaa'
const KEY_B = 'wt:bbb'
const KEY_C = 'wt:ccc'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const quietLogger = { log: () => {}, error: () => {} }

// Build the exact wire query getCdpUrl produces: `workspace` percent-encodes the `:`
// in the key (wt:aaa -> wt%3Aaaa) and `workspaceLabel` rides alongside. URLSearchParams
// on the relay side decodes it back, so the `wt:` prefix arrives intact.
function q(key: string, label: string): string {
  const p = new URLSearchParams()
  p.set('workspace', key)
  p.set('workspaceLabel', label)
  return p.toString()
}

function pageTarget(targetId: string, url: string) {
  return {
    targetId,
    type: 'page',
    title: url,
    url,
    attached: true,
    canAccessOpener: false,
    browserContextId: 'ctx1',
  }
}

type ExtMsg = { id?: number; method?: string; params?: Record<string, unknown> }

// A keyed Playwright client: collects the sessionIds it is told to attach to via
// `Target.attachedToTarget`, and can send a CDP command and await its response by id.
class KeyedClient {
  readonly ws: WebSocket
  readonly attachedSessionIds: string[] = []
  private nextId = 1

  constructor(clientId: string, query: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/cdp/${clientId}?${query}`)
    this.ws.on('message', (raw: WebSocket.RawData) => {
      let m: { id?: number; method?: string; params?: { sessionId?: string } }
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (m.method === 'Target.attachedToTarget' && m.params?.sessionId) {
        this.attachedSessionIds.push(m.params.sessionId)
      }
    })
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve())
      this.ws.on('error', reject)
      // A 4005 "Missing workspace" close means our keys did not reach the relay.
      this.ws.on('close', (code, reason) => reject(new Error(`client closed ${code} ${reason}`)))
    })
  }

  sendCdp<T = unknown>(msg: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timeout = setTimeout(() => {
        this.ws.off('message', handler)
        reject(new Error(`CDP response timeout for id ${id}`))
      }, 5000)
      const handler = (raw: WebSocket.RawData) => {
        let parsed: { id?: number }
        try {
          parsed = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (parsed.id === id) {
          this.ws.off('message', handler)
          clearTimeout(timeout)
          resolve(parsed as T)
        }
      }
      this.ws.on('message', handler)
      this.ws.send(JSON.stringify({ id, ...msg }))
    })
  }

  // Send Target.setAutoAttach and await its response. Because the relay sends the
  // per-target Target.attachedToTarget replay events (the ones under test) BEFORE the
  // command response on the SAME ordered WebSocket, once the response resolves every
  // replay event for this client has already been recorded in attachedSessionIds.
  async autoAttachAndSettle(): Promise<void> {
    await this.sendCdp({
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    })
    await sleep(100)
  }

  close(): void {
    this.ws.close()
  }
}

describe('Cross-workspace isolation (Todo 24 — decisive)', () => {
  let server: RelayServer
  let ext: WebSocket
  let autoCreateCounter = 0

  beforeAll(async () => {
    server = await startPlayWriterCDPRelayServer({ port: TEST_PORT, host: '127.0.0.1', logger: quietLogger })

    // Fake extension: valid chrome-extension:// origin so the relay accepts it.
    ext = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/extension`, { headers: { origin: EXT_ORIGIN } })
    ext.on('message', (raw: WebSocket.RawData) => {
      let msg: ExtMsg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.id === undefined || !msg.method) {
        return
      }
      if (msg.method === 'createInitialTab') {
        // Auto-create path (Todo 14 -> Todo 20): mint a new tab owned by the CREATING
        // client's workspace. The relay stamps ownership = params.workspaceKey itself.
        const sessionId = `sess-auto-${autoCreateCounter++}`
        ext.send(
          JSON.stringify({
            id: msg.id,
            result: {
              success: true,
              tabId: 900 + autoCreateCounter,
              sessionId,
              targetInfo: pageTarget(`t-auto-${autoCreateCounter}`, 'http://auto.test/'),
            },
          }),
        )
      } else {
        // Every other forwarded command (e.g. forwardCDPCommand for setAutoAttach) just
        // needs an ack so routeCdpCommand's await resolves.
        ext.send(JSON.stringify({ id: msg.id, result: {} }))
      }
    })
    await new Promise<void>((resolve, reject) => {
      ext.on('open', () => resolve())
      ext.on('error', reject)
    })
    await sleep(150)

    // Register three targets BEFORE any client connects, so each target lands in
    // connectedTargets with its owner stamped and NO live broadcast reaches anyone.
    // This isolates the setAutoAttach REPLAY (Todo 13) as the sole delivery channel
    // under test. Ownership comes from the workspaceKey the extension echoes on
    // Target.attachedToTarget (Todo 20, Job A).
    const register = (workspaceKey: string | null, sessionId: string, targetId: string, url: string) => {
      ext.send(
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            workspaceKey,
            params: { sessionId, targetInfo: pageTarget(targetId, url), waitingForDebugger: false },
          },
        }),
      )
    }
    register(KEY_A, 'sessA', 'tA', 'http://a.test/')
    register(KEY_B, 'sessB', 'tB', 'http://b.test/')
    register(null, 'sessFree', 'tFree', 'http://free.test/') // freestyle (human icon-click), owned by no workspace
    await sleep(200)
  }, 30000)

  afterAll(async () => {
    ext?.close()
    server?.close()
    await sleep(100)
  })

  it('(2)+(3) each client receives Target.attachedToTarget ONLY for its own workspace; freestyle reaches neither — THE decisive, teeth-bearing assertion', async () => {
    const a = new KeyedClient('t24-decisive-A', q(KEY_A, 'A'))
    const b = new KeyedClient('t24-decisive-B', q(KEY_B, 'B'))
    try {
      await Promise.all([a.open(), b.open()])
      await a.autoAttachAndSettle()
      await b.autoAttachAndSettle()

      // (2) A sees ONLY its own target; (3) neither sees the freestyle target.
      expect(a.attachedSessionIds).toContain('sessA')
      expect(a.attachedSessionIds).not.toContain('sessB') // <-- fails if Todo 13's filter is reverted
      expect(a.attachedSessionIds).not.toContain('sessFree')

      expect(b.attachedSessionIds).toContain('sessB')
      expect(b.attachedSessionIds).not.toContain('sessA') // <-- fails if Todo 13's filter is reverted
      expect(b.attachedSessionIds).not.toContain('sessFree')
    } finally {
      a.close()
      b.close()
      await sleep(100)
    }
  }, 15000)

  it('(4) two clients with the SAME key share the same target', async () => {
    const a1 = new KeyedClient('t24-same-A1', q(KEY_A, 'A'))
    const a2 = new KeyedClient('t24-same-A2', q(KEY_A, 'A'))
    try {
      await Promise.all([a1.open(), a2.open()])
      await a1.autoAttachAndSettle()
      await a2.autoAttachAndSettle()

      expect(a1.attachedSessionIds).toContain('sessA')
      expect(a2.attachedSessionIds).toContain('sessA')
      // Same-key sessions share; neither is confined away from the shared target.
      expect(a1.attachedSessionIds).not.toContain('sessB')
      expect(a2.attachedSessionIds).not.toContain('sessB')
    } finally {
      a1.close()
      a2.close()
      await sleep(100)
    }
  }, 15000)

  it('(1, supplementary) Target.getTargets is scoped to the client workspace — NOTE: this is Todo 16 filtering, NOT Todo 13; toothless for the revert-check', async () => {
    const a = new KeyedClient('t24-gettargets-A', q(KEY_A, 'A'))
    try {
      await a.open()
      const res = await a.sendCdp<{ result?: { targetInfos?: Array<{ targetId?: string }> } }>({
        method: 'Target.getTargets',
        params: {},
      })
      const ids = (res.result?.targetInfos ?? []).map((t) => t.targetId)
      expect(ids).toContain('tA')
      expect(ids).not.toContain('tB')
      expect(ids).not.toContain('tFree')
    } finally {
      a.close()
      await sleep(100)
    }
  }, 15000)

  it('(5) a workspace with no tabs auto-creates its own tab and never adopts the freestyle tab', async () => {
    // KEY_C owns nothing; a freestyle tab (sessFree) exists. On setAutoAttach the relay
    // must auto-create a fresh tab owned by KEY_C (zero-click) and replay ONLY that tab —
    // never the freestyle one.
    const c = new KeyedClient('t24-autocreate-C', q(KEY_C, 'C'))
    try {
      await c.open()
      await c.autoAttachAndSettle()
      await sleep(200) // auto-create round-trips to the fake extension before the replay

      const autoCreated = c.attachedSessionIds.filter((s) => s.startsWith('sess-auto-'))
      expect(autoCreated.length).toBeGreaterThan(0) // got its own auto-created tab
      expect(c.attachedSessionIds).not.toContain('sessFree') // never adopts freestyle
      expect(c.attachedSessionIds).not.toContain('sessA')
      expect(c.attachedSessionIds).not.toContain('sessB')
    } finally {
      c.close()
      await sleep(100)
    }
  }, 15000)
})
