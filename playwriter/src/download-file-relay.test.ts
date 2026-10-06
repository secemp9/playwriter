/**
 * The relay's real path for extension downloads. chrome.debugger cannot set where Chrome saves a
 * download (it refuses Page.setDownloadBehavior and has no Browser domain), so the relay sends the
 * browser nothing for Playwright's `Browser.setDownloadBehavior` and keeps each client's folder. The
 * extension reports where Chrome saved the file (chrome.downloads) on the tab's `Page.downloadProgress
 * completed`; before a client hears `Browser.downloadProgress completed` — the moment Playwright's
 * Download reports finished and `download.path()` / `saveAs` read `<folder>/<guid>` — the relay puts the
 * file there for every client whose workspace owns the tab then. `GET /downloads/:guid` says what
 * became of it.
 *
 * A fake extension, as in relay-two-targets.test.ts, plays Chrome's side: the tabs' download events,
 * the file Chrome writes into the user's download folder, and the extension's report. (The real
 * extension in Chromium is driven by extension-downloads.test.ts.) Each relay listens on a port picked
 * free at run time, never a fixed one.
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import type { DownloadFileReport } from './protocol.js'

const EXT_ORIGIN = 'chrome-extension://jfeammnjpkecdekppnclgkkffahnhfhe' // an allowlisted EXTENSION_ID
const CSV = 'id,total\n1,42\n'

type Message = { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true })
})

function newFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-downloads-'))
  folders.push(folder)
  return folder
}

function freePort(): Promise<number> {
  const found = Promise.withResolvers<number>()
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => (address && typeof address !== 'string' ? found.resolve(address.port) : found.reject(new Error('no port'))))
  })
  return found.promise
}

/** Everything one source delivered, and waits on what it has not delivered yet (no timers: settled as items arrive). */
class Inbox<T = Message> {
  readonly messages: T[] = []
  private readonly waiters: Array<{ predicate: (message: T) => boolean; resolve: (message: T) => void }> = []

  add(message: T): void {
    this.messages.push(message)
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.resolve(message)
    }
  }

  /** Resolves with the first item `predicate` holds for, delivered already or later (the test's timeout bounds the wait). */
  next(predicate: (message: T) => boolean): Promise<T> {
    const found = this.messages.find(predicate)
    if (found) return Promise.resolve(found)
    const arrival = Promise.withResolvers<T>()
    this.waiters.push({ predicate, resolve: arrival.resolve })
    return arrival.promise
  }
}

function opened(socket: WebSocket): Promise<void> {
  const open = Promise.withResolvers<void>()
  socket.once('open', () => open.resolve())
  socket.once('error', (error) => open.reject(error))
  return open.promise
}

/** A Playwright-like CDP client of the relay. */
interface FakeClient {
  socket: WebSocket
  inbox: Inbox
  folder: string
  /** For each `Browser.downloadProgress completed` it got: whether `<its folder>/<guid>` existed as it arrived. */
  completedWith: Map<string, boolean>
}

/** A relay on a free port with a fake extension, and Playwright-like CDP clients. */
class Relay {
  server!: RelayServer
  port = 0
  ext!: WebSocket
  /** What the fake extension was asked to forward to the tabs (forwardCDPCommand params). */
  readonly toTabs = new Inbox()
  /** The relay's log lines. */
  readonly log = new Inbox<string>()
  private readonly clients: WebSocket[] = []
  private nextId = 1

  async start(): Promise<void> {
    this.port = await freePort()
    this.server = await startPlayWriterCDPRelayServer({
      port: this.port,
      host: '127.0.0.1',
      logger: { log: (...args: unknown[]) => this.log.add(args.map(String).join(' ')), error: () => {} },
    })
    this.ext = new WebSocket(`ws://127.0.0.1:${this.port}/extension`, { headers: { origin: EXT_ORIGIN } })
    this.ext.on('message', (raw: WebSocket.RawData) => {
      const message: { id?: number; method?: string; params?: Message } = JSON.parse(raw.toString())
      if (message.id === undefined || !message.method) return
      if (message.method === 'forwardCDPCommand' && message.params) this.toTabs.add(message.params)
      this.ext.send(JSON.stringify({ id: message.id, result: {} }))
    })
    await opened(this.ext)
  }

  /** Chrome's side: an event on a tab's session, from the fake extension. */
  fromTab(sessionId: string | undefined, method: string, params: unknown, extra: { workspaceKey?: string; downloadFile?: DownloadFileReport } = {}): void {
    this.ext.send(JSON.stringify({ method: 'forwardCDPEvent', params: { method, params, sessionId, ...extra } }))
  }

  attachTab(sessionId: string, workspaceKey: string): void {
    this.fromTab(
      undefined,
      'Target.attachedToTarget',
      {
        sessionId,
        targetInfo: { targetId: `target-${sessionId}`, type: 'page', title: sessionId, url: `http://fixture.test/${sessionId}`, attached: true, canAccessOpener: false, browserContextId: 'ctx' },
        waitingForDebugger: false,
      },
      { workspaceKey },
    )
  }

  /** A client of `workspace` that attached and asked for downloads into `folder`, as Playwright does on connect. */
  async client(name: string, workspace: string, folder: string): Promise<FakeClient> {
    const query = new URLSearchParams({ workspace, workspaceLabel: workspace }).toString()
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/cdp/${name}?${query}`)
    const inbox = new Inbox()
    const completedWith = new Map<string, boolean>()
    socket.on('message', (raw: WebSocket.RawData) => {
      const message: Message = JSON.parse(raw.toString())
      if (message.method === 'Browser.downloadProgress' && message.params?.state === 'completed') {
        const guid = String(message.params.guid)
        completedWith.set(guid, fs.existsSync(path.join(folder, guid)))
      }
      inbox.add(message)
    })
    await opened(socket)
    this.clients.push(socket)
    const send = async (method: string, params: unknown): Promise<Message> => {
      const id = this.nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return await inbox.next((message) => message.id === id)
    }
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    const answer = await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: folder, eventsEnabled: true })
    expect(answer.result).toEqual({})
    return { socket, inbox, folder, completedWith }
  }

  /**
   * One download on `sessionId`: Chrome saves the file into the user's download folder, and the
   * extension reports it on the completion (or `report` instead). Resolves once `watcher` heard it finished.
   */
  async download({ sessionId, guid, watcher, report }: { sessionId: string; guid: string; watcher: Inbox; report?: DownloadFileReport }): Promise<string> {
    this.fromTab(sessionId, 'Page.downloadWillBegin', { frameId: `frame-${sessionId}`, guid, url: 'http://fixture.test/export', suggestedFilename: 'report.csv' })
    await watcher.next((message) => message.method === 'Browser.downloadWillBegin' && message.params?.guid === guid)
    const saved = path.join(newFolder(), 'report.csv')
    fs.writeFileSync(saved, CSV)
    this.fromTab(sessionId, 'Page.downloadProgress', { guid, totalBytes: CSV.length, receivedBytes: CSV.length, state: 'completed' }, { downloadFile: report ?? { filePath: saved } })
    await watcher.next((message) => message.method === 'Browser.downloadProgress' && message.params?.guid === guid && message.params.state === 'completed')
    return saved
  }

  async status(guid: string): Promise<{ code: number; body: unknown }> {
    const response = await fetch(`http://127.0.0.1:${this.port}/downloads/${guid}`)
    return { code: response.status, body: await response.json() }
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.close()
    this.ext?.close()
    await this.server?.close()
  }
}

describe('the relay puts the file Chrome saved where Playwright reads it', () => {
  const relay = new Relay()
  let client: FakeClient

  beforeAll(async () => {
    await relay.start()
    relay.attachTab('tab', 'wt:one')
    client = await relay.client('one', 'wt:one', newFolder())
  }, 60_000)
  afterAll(() => relay.stop())

  it('sends the browser no Page.setDownloadBehavior, and puts the file at <folder>/<guid> before the client hears of the completion', async () => {
    const saved = await relay.download({ sessionId: 'tab', guid: 'guid-one', watcher: client.inbox })
    expect(relay.toTabs.messages.filter((message) => String(message.method).includes('DownloadBehavior'))).toEqual([])
    expect(client.completedWith.get('guid-one'), `<folder>/guid-one must exist when Playwright hears the download finished`).toBe(true)
    expect(fs.readFileSync(path.join(client.folder, 'guid-one'), 'utf8')).toBe(CSV)
    // The completion carries the file's path, as CDP's own Browser.downloadProgress does.
    const completed = await client.inbox.next((message) => message.method === 'Browser.downloadProgress' && message.params?.state === 'completed')
    expect(completed.params?.filePath).toBe(saved)
    expect(await relay.status('guid-one')).toEqual({ code: 200, body: { state: 'saved', filePath: saved, folders: { [client.folder]: { ok: true } } } })
    expect(relay.log.messages.join('\n')).toContain(`download guid-one: Chrome saved ${saved}; put into ${client.folder}`)
  })

  it("keeps the extension's reason when it could not tell where Chrome saved it", async () => {
    await relay.download({ sessionId: 'tab', guid: 'guid-two', watcher: client.inbox, report: { problem: '2 chrome.downloads items fit' } })
    expect(client.completedWith.get('guid-two')).toBe(false)
    expect(await relay.status('guid-two')).toEqual({ code: 200, body: { state: 'unmatched', problem: '2 chrome.downloads items fit' } })
  })

  it('answers that Chrome waits for the user to choose where to save it, as the extension reports', async () => {
    relay.fromTab('tab', 'Page.downloadWillBegin', { frameId: 'frame-tab', guid: 'guid-ask', url: 'http://fixture.test/export', suggestedFilename: 'report.csv' })
    await client.inbox.next((message) => message.method === 'Browser.downloadWillBegin' && message.params?.guid === 'guid-ask')
    relay.ext.send(JSON.stringify({ method: 'downloadState', params: { sessionId: 'tab', guid: 'guid-ask', asking: true } }))
    // The relay handles the extension's messages in order: this barrier comes back after the state is kept.
    relay.fromTab('tab', 'Page.downloadWillBegin', { frameId: 'frame-tab', guid: 'guid-barrier', url: 'http://fixture.test/export', suggestedFilename: 'b.csv' })
    await client.inbox.next((message) => message.method === 'Browser.downloadWillBegin' && message.params?.guid === 'guid-barrier')
    expect(await relay.status('guid-ask')).toEqual({ code: 200, body: { state: 'asking' } })
    expect((await relay.status('guid-unknown')).code).toBe(404)
  })
})

describe('several clients on one extension: worktrees each get their own copy', () => {
  const relay = new Relay()
  let a1: FakeClient
  let a2: FakeClient
  let b: FakeClient

  beforeAll(async () => {
    await relay.start()
    relay.attachTab('tab-a', 'wt:a')
    relay.attachTab('tab-b', 'wt:b')
    a1 = await relay.client('a1', 'wt:a', newFolder())
    b = await relay.client('b', 'wt:b', newFolder())
    a2 = await relay.client('a2', 'wt:a', newFolder())
  }, 60_000)
  afterAll(() => relay.stop())

  it("lands worktree B's download only where B's Playwright reads it", async () => {
    await relay.download({ sessionId: 'tab-b', guid: 'guid-b', watcher: b.inbox })
    expect(b.completedWith.get('guid-b')).toBe(true)
    expect(fs.readFileSync(path.join(b.folder, 'guid-b'), 'utf8')).toBe(CSV)
    expect(fs.existsSync(path.join(a1.folder, 'guid-b'))).toBe(false)
    expect(fs.existsSync(path.join(a2.folder, 'guid-b'))).toBe(false)
  })

  it('gives both clients of worktree A the file in their own folder before either hears of the completion', async () => {
    await relay.download({ sessionId: 'tab-a', guid: 'guid-a', watcher: a2.inbox })
    await a1.inbox.next((message) => message.method === 'Browser.downloadProgress' && message.params?.guid === 'guid-a' && message.params.state === 'completed')
    expect(a1.completedWith.get('guid-a')).toBe(true)
    expect(a2.completedWith.get('guid-a')).toBe(true)
    expect(fs.existsSync(path.join(b.folder, 'guid-a'))).toBe(false)
  })

  it('serves a tab attached after the clients connected (the auto-created first tab) the same way', async () => {
    relay.attachTab('tab-a-later', 'wt:a')
    await relay.download({ sessionId: 'tab-a-later', guid: 'guid-later', watcher: a1.inbox })
    await a2.inbox.next((message) => message.method === 'Browser.downloadProgress' && message.params?.guid === 'guid-later' && message.params.state === 'completed')
    expect(a1.completedWith.get('guid-later')).toBe(true)
    expect(a2.completedWith.get('guid-later')).toBe(true)
  })

  it("tells only worktree A's clients of a download on A's tab: B gets no download event of it", async () => {
    await relay.download({ sessionId: 'tab-a', guid: 'guid-a2', watcher: a1.inbox })
    await a2.inbox.next((message) => message.method === 'Browser.downloadProgress' && message.params?.guid === 'guid-a2' && message.params.state === 'completed')
    // A barrier on B's own socket: the relay handles the extension's events in order and writes each
    // one's messages before reading the next, so anything about A's downloads would reach B before this.
    await relay.download({ sessionId: 'tab-b', guid: 'guid-b-barrier', watcher: b.inbox })
    const seenByB = b.inbox.messages.filter((message) => message.method?.includes('download')).map((message) => `${message.method} ${String(message.params?.guid)}`)
    expect(seenByB.filter((line) => line.includes('guid-a') || line.includes('guid-later'))).toEqual([])
    expect(seenByB).toEqual(expect.arrayContaining(['Browser.downloadWillBegin guid-b-barrier', 'Browser.downloadProgress guid-b-barrier', 'Page.downloadWillBegin guid-b-barrier']))
    for (const client of [a1, a2]) {
      const seen = client.inbox.messages.filter((message) => message.params?.guid === 'guid-a2').map((message) => message.method)
      expect(seen).toEqual(expect.arrayContaining(['Browser.downloadWillBegin', 'Browser.downloadProgress', 'Page.downloadWillBegin', 'Page.downloadProgress']))
    }
  })

  it("does not recreate the folder of a client that left (Playwright deleted it), and does not keep anything for it", async () => {
    a1.socket.close()
    await relay.log.next((line) => line.includes('Playwright client disconnected: a1'))
    // What Playwright does with its artifacts folder when its connection closes.
    fs.rmSync(a1.folder, { recursive: true, force: true })
    await relay.download({ sessionId: 'tab-a', guid: 'guid-after', watcher: a2.inbox })
    expect(fs.existsSync(a1.folder)).toBe(false)
    expect(a2.completedWith.get('guid-after')).toBe(true)
    expect((await relay.status('guid-after')).body).toMatchObject({ state: 'saved', folders: { [a2.folder]: { ok: true } } })
  })
})
