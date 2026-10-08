/**
 * The extension reloads itself when its folder holds a newer build (extension/src/self-reload.ts), through
 * the real extension in Chrome for Testing, loaded unpacked from a temp copy of a real build, against a
 * relay of this process. Newer builds are put in that folder by the build itself (`pnpm build` into it),
 * so they are written in the build's own order: build.json last.
 *
 * The folder alternates between two builds of this suite's port: A (TESTING=1, as every relay suite
 * builds) and B (no TESTING, so its welcome page would open on an install). Reloading from A to B proves
 * the reload is not an install.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { chromium, type BrowserContext, type Page, type Worker } from '@xmorse/playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { enableDeveloperMode } from './browser-launch.js'
import { createCdpLogger, type CdpLogger } from './cdp-log.js'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'
import { createFileLogger, type Logger } from './create-logger.js'
import { killPortProcess } from './kill-port.js'
import { createMCPClient } from './mcp-client.js'
import { getExtensionsStatus, type ExtensionStatus } from './relay-client.js'
import { getExtensionServiceWorker, testRelayPort, TEST_WORKSPACE } from './test-utils.js'
import { EXTENSION_IDS, sleep, VERSION } from './utils.js'
import './test-declarations.js'

const execFileAsync = promisify(execFile)
const TEST_PORT = testRelayPort(import.meta.url)
const EXTENSION_DIR = path.resolve('../extension')

/**
 * Bound from the relay restart (or the tab's release) to the relay listing the reloaded extension on its
 * new build. MEASURED over 7 runs, alone and next to human-mode-live.test.ts (Chrome for Testing
 * 145.0.7632.18): 319–958 ms after a relay restart (maintainLoop notices the closed socket within 1 s,
 * reconnects, checks, reloads in ~0.1 s, reconnects), 323–341 ms after the release. 10 s leaves room for
 * a loaded machine and still fails long before the 30 s periodic wake could have done the reload instead.
 */
const RELOAD_BOUND_MS = 10_000

let staging = ''
let loaded = ''
let userDataDir = ''
let context: BrowserContext
let relay: RelayServer
let logger: Logger
let cdpLogger: CdpLogger
let mcp: { client: Client; cleanup: () => Promise<void> } | null = null
let buildA = ''
let buildB = ''
/** Every page the browser opened since launch, the extension's included. */
const openedPages: Page[] = []

/** One real build of the extension for this suite's port, written by the build into `outDir`. */
async function build({ outDir, testing }: { outDir: string; testing: boolean }): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRITER_PORT: String(TEST_PORT), PLAYWRITER_EXTENSION_DIST: outDir }
  // Each variable the build reads: only TESTING differs between A and B.
  delete env.TESTING
  delete env.PRODUCTION
  delete env.PLAYWRITER_DEV_RELOAD
  delete env.PLAYWRITER_OPEN_WELCOME_PAGE
  if (testing) env.TESTING = '1'
  await execFileAsync('pnpm', ['build'], { cwd: EXTENSION_DIR, env })
  return buildIdIn(outDir)
}

function buildIdIn(folder: string): string {
  const file = path.join(folder, 'build.json')
  if (!fs.existsSync(file)) throw new Error(`the build wrote no ${file}`)
  return z.object({ id: z.string() }).parse(JSON.parse(fs.readFileSync(file, 'utf-8'))).id
}

function writeBuildJson(content: string): void {
  fs.writeFileSync(path.join(loaded, 'build.json.tmp'), content)
  fs.renameSync(path.join(loaded, 'build.json.tmp'), path.join(loaded, 'build.json'))
}

/**
 * The relay's /extensions/status entry of the extension under test (the path `playwriter browser list` and
 * install.sh read), once `matches` holds. A real timer: the relay has no event this process could await
 * for an extension that connects, reconnects or reports a waiting build.
 */
async function waitForExtension(
  what: string,
  matches: (extension: ExtensionStatus) => boolean,
  timeoutMs = 30_000,
): Promise<{ extension: ExtensionStatus; ms: number }> {
  const started = performance.now()
  let listed: ExtensionStatus[] = []
  while (performance.now() - started < timeoutMs) {
    listed = await getExtensionsStatus(TEST_PORT)
    const extension = listed.find(matches)
    if (extension) return { extension, ms: Math.round(performance.now() - started) }
    await sleep(100)
  }
  throw new Error(`the relay did not list ${what} within ${timeoutMs} ms; it lists ${JSON.stringify(listed)}`)
}

async function restartRelay(): Promise<void> {
  await relay.close()
  relay = await startPlayWriterCDPRelayServer({ port: TEST_PORT, logger, cdpLogger })
}

/** Set in the extension's storage.session, which a reload wipes and a worker restart keeps (MEASURED, see self-reload.ts). */
async function markExtension(worker: Worker): Promise<void> {
  await worker.evaluate(async () => {
    await chrome.storage.session.set({ selfReloadTestMarker: 'set' })
  })
}

async function wasReloaded(worker: Worker): Promise<boolean> {
  return await worker.evaluate(async () => {
    const { selfReloadTestMarker } = await chrome.storage.session.get('selfReloadTestMarker')
    return selfReloadTestMarker !== 'set'
  })
}

/** What a reload could have shown the user: welcome tabs (any page opened since launch) and tab groups. */
async function welcomeTabsAndGroups(worker: Worker): Promise<{ welcomeTabs: number; groups: number }> {
  const welcomeTabs = openedPages.filter((page) => page.url().includes('/src/welcome.html')).length
  const groups = await worker.evaluate(async () => (await chrome.tabGroups.query({})).length)
  return { welcomeTabs, groups }
}

async function relayLog(): Promise<string> {
  await logger.flush()
  return fs.readFileSync(logger.logFilePath, 'utf-8')
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

async function browserList(): Promise<string> {
  if (!mcp) throw new Error('no MCP client')
  const result = await mcp.client.callTool({ name: 'browser', arguments: { action: 'list' } })
  const content = Array.isArray(result.content) ? result.content : []
  return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('\n')
}

beforeAll(async () => {
  staging = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-self-reload-'))
  loaded = path.join(staging, 'loaded')
  const folderA = path.join(staging, 'a')
  buildA = await build({ outDir: folderA, testing: true })
  // Chrome is not running yet: the order of this first copy does not matter.
  fs.cpSync(folderA, loaded, { recursive: true })

  await killPortProcess({ port: TEST_PORT }).catch(() => {})
  logger = createFileLogger({ logFilePath: path.join(process.cwd(), 'tmp', `relay-server-${TEST_PORT}.log`) })
  cdpLogger = createCdpLogger({ logFilePath: path.join(process.cwd(), 'tmp', `cdp-${TEST_PORT}.jsonl`) })
  relay = await startPlayWriterCDPRelayServer({ port: TEST_PORT, logger, cdpLogger })

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-self-reload-profile-'))
  // MEASURED: without Developer mode a reload disables an extension loaded with --load-extension.
  enableDeveloperMode(userDataDir)
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADFUL,
    args: [`--disable-extensions-except=${loaded}`, `--load-extension=${loaded}`],
  })
  openedPages.push(...context.pages())
  context.on('page', (page) => openedPages.push(page))
  await waitForExtension(`the extension on build ${buildA}`, (extension) => extension.build === buildA)
  const created = await createMCPClient({ port: TEST_PORT })
  mcp = { client: created.client, cleanup: created.cleanup }
}, 600_000)

afterAll(async () => {
  await mcp?.cleanup()
  await context?.close()
  await relay?.close()
  for (const dir of [userDataDir, staging]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('an unpacked extension whose folder gets a newer build', () => {
  it('reports its build, and does not reload while build.json is equal, missing or invalid', async () => {
    const worker = await getExtensionServiceWorker(context)
    await markExtension(worker)

    expect(await browserList()).toContain(`extension built with playwriter ${VERSION}, build ${buildA} · 0 attached tabs`)
    expect(await worker.evaluate(() => globalThis.checkForNewerBuild())).toEqual({ kind: 'current' })

    fs.rmSync(path.join(loaded, 'build.json'))
    expect(await worker.evaluate(() => globalThis.checkForNewerBuild())).toEqual({ kind: 'unreadable' })
    // Also on the check right after a connection, as when install.sh restarts the relay.
    await restartRelay()
    await waitForExtension(`the extension reconnected on build ${buildA}`, (extension) => extension.build === buildA)
    expect(await worker.evaluate(() => globalThis.checkForNewerBuild())).toEqual({ kind: 'unreadable' })
    for (const content of ['{"id":"not-a-build"}', '{"id":', '[]', '{"id":12345678}']) {
      writeBuildJson(content)
      expect(await worker.evaluate(() => globalThis.checkForNewerBuild()), content).toEqual({ kind: 'unreadable' })
    }
    writeBuildJson(`${JSON.stringify({ id: buildA })}\n`)
    expect(await worker.evaluate(() => globalThis.checkForNewerBuild())).toEqual({ kind: 'current' })

    expect(await wasReloaded(worker)).toBe(false)
    const log = await relayLog()
    expect(occurrences(log, `build ${buildA}: its folder has no build.json naming a build`)).toBe(1)
    expect(log).not.toContain('reloading itself')
  }, 120_000)

  it('reloads itself into a newer build put in its folder, reconnects reporting it, and opens no tab or group', async () => {
    const before = await getExtensionServiceWorker(context)
    await markExtension(before)
    const pagesBefore = context.pages().length

    buildB = await build({ outDir: loaded, testing: false })
    expect(buildB).not.toBe(buildA)

    // install.sh restarts the relay after a build; the check right after the reconnection reloads.
    await restartRelay()
    const { ms } = await waitForExtension(`the extension on build ${buildB}`, (extension) => extension.build === buildB)
    console.log(`self-reload: relay restart → extension back on build ${buildB} in ${ms} ms`)
    expect(ms).toBeLessThan(RELOAD_BOUND_MS)

    const after = await getExtensionServiceWorker(context)
    expect(await wasReloaded(after)).toBe(true)
    expect(await after.evaluate(() => globalThis.checkForNewerBuild())).toEqual({ kind: 'current' })
    expect(await welcomeTabsAndGroups(after)).toEqual({ welcomeTabs: 0, groups: 0 })
    expect(context.pages().length).toBe(pagesBefore)

    const log = await relayLog()
    expect(occurrences(log, `reloading itself: build ${buildA} → ${buildB} (its folder has a newer build)`)).toBe(1)
  }, 180_000)

  it('waits while it controls a tab, says so in browser list, and reloads once the tab is released', async () => {
    const worker = await getExtensionServiceWorker(context)
    await markExtension(worker)
    const page = await context.newPage()
    await page.goto('about:blank')
    const connected = await worker.evaluate(
      async ([key, label]) => (await globalThis.toggleExtensionForActiveTab(key, label)).isConnected,
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    expect(connected).toBe(true)
    const tabId = await worker.evaluate(() => globalThis.getExtensionState().currentTabId)
    if (tabId === undefined) throw new Error('the toggle recorded no tab')

    const newer = await build({ outDir: loaded, testing: true })
    expect(newer).toBe(buildA)
    expect(await worker.evaluate(() => globalThis.checkForNewerBuild())).toEqual({ kind: 'waiting', build: buildA })
    await waitForExtension(`the extension waiting with build ${buildA}`, (extension) => extension.build === buildB && extension.newerBuild === buildA)
    expect(await browserList()).toContain(
      `extension built with playwriter ${VERSION}, build ${buildB} (a newer build is in its folder; it reloads itself once it controls no tab) · 1 attached tab`,
    )

    // A new connection while it controls the tab: the check right after it waits too, and says so again.
    await restartRelay()
    await waitForExtension(`the reconnected extension waiting with build ${buildA}`, (extension) => extension.build === buildB && extension.newerBuild === buildA)
    expect(await worker.evaluate(() => globalThis.checkForNewerBuild())).toEqual({ kind: 'waiting', build: buildA })
    expect(await wasReloaded(worker)).toBe(false)

    // Release the tab; no awaiting the toggle, whose worker the reload ends.
    const released = performance.now()
    await worker.evaluate(
      ([key, label]) => {
        void globalThis.toggleExtensionForActiveTab(key, label)
      },
      [TEST_WORKSPACE.key, TEST_WORKSPACE.label] as [string, string],
    )
    const { extension } = await waitForExtension(`the extension on build ${buildA}`, (extension) => extension.build === buildA)
    const ms = Math.round(performance.now() - released)
    console.log(`self-reload: tab released → extension back on build ${buildA} in ${ms} ms`)
    expect(ms).toBeLessThan(RELOAD_BOUND_MS)
    expect(extension.newerBuild).toBe(null)

    const after = await getExtensionServiceWorker(context)
    expect(await wasReloaded(after)).toBe(true)
    expect(await welcomeTabsAndGroups(after)).toEqual({ welcomeTabs: 0, groups: 0 })
    expect(await after.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, tabId)).toBe(-1)

    const log = await relayLog()
    expect(occurrences(log, `build ${buildB}: a newer build ${buildA} is in its folder; it reloads itself once it controls no tab`)).toBe(1)
    expect(occurrences(log, `reloading itself: build ${buildB} → ${buildA} (its folder has a newer build)`)).toBe(1)
    await page.close()
  }, 180_000)

  it('lists an extension that reports no build id with the one ↻ the user has to click', async () => {
    // An extension built before build ids, on the wire: its hello has the version and no build.
    const installId = 'before-self-reload'
    const old = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/extension?browser=Chrome&installId=${installId}&v=${VERSION}`, {
      headers: { Origin: `chrome-extension://${EXTENSION_IDS[1]}` },
    })
    const opened = Promise.withResolvers<void>()
    old.once('open', () => opened.resolve())
    old.once('error', (error) => opened.reject(error))
    await opened.promise
    try {
      await waitForExtension('the extension without a build id', (extension) => extension.stableKey === `install:Chrome:${installId}`)
      const list = await browserList()
      expect(list).toContain(
        `key install:Chrome:${installId} · Chrome · extension built with playwriter ${VERSION}, before it could reload itself: ask the user to click ↻ on its card in chrome://extensions once · 0 attached tabs`,
      )
      expect(list).toContain(`extension built with playwriter ${VERSION}, build ${buildA} · 0 attached tabs`)
    } finally {
      old.close()
    }
  }, 60_000)
})
