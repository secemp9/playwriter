/**
 * Where a download's file ends up, for each way a session reaches its browser, and what the model is
 * told about it. Every executor session connects in-process (`chromium.launch` for headless,
 * `connectOverCDP` for direct, cloud and extension sessions), where `Download.saveAs` copies
 * `<Playwright's downloads folder>/<guid>` from this machine's disk — the file is only there when a
 * Chrome on this machine saved it under that name.
 *
 * Driven against a Chrome started here with a debugging port:
 *   - a direct-CDP session to it: the file is on this machine, `downloads.save` copies it;
 *   - a cloud session (direct CDP with cloud metadata): the browser's machine is not this one, so the
 *     report line offers no save and `downloads.save` refuses, naming where the file is;
 *   - a download Chrome saved under its own name in the user's folder, as it does through the
 *     extension (chrome.debugger cannot ask for anything else): the extension store copies it once the
 *     relay put it at Playwright's path (download-file.ts deliverDownloadFile), and otherwise refuses
 *     with exactly what the relay says (`GET /downloads/:guid`, stubbed here; the real relay and
 *     extension are driven by download-file-relay.test.ts and extension-downloads.test.ts).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Download, Page } from '@xmorse/playwright-core'
import { resolveBrowserExecutablePath } from './browser-config.js'
import { PlaywrightExecutor } from './executor.js'
import { deliverDownloadFile, type RelayDownloadStatus } from './download-file.js'
import { getChromium } from './playwright-import.js'
import { ScopedFS } from './scoped-fs.js'
import { SessionDownloads } from './session-downloads.js'

const CSV = 'id,total\n1,42\n'
const PAGE =
  '<!doctype html><title>Exports</title><main><h1>Exports</h1><p><a href="/export" target="_blank">Export CSV</a></p>' +
  '<p><a id="same" href="/export">Export here</a></p><p><a id="slow" href="/slow-export">Slow export</a></p></main>'

let server: http.Server
let baseUrl = ''
let cwd = ''
const chromes: Array<{ process: ChildProcess; exited: Promise<void> }> = []
/** The slow export's response, held open until a test ends it. */
let slowExport: http.ServerResponse | null = null

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/export') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' })
      res.end(CSV)
      return
    }
    if (req.url === '/slow-export') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="slow.csv"' })
      res.write('id,total\n')
      slowExport = res
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-downloads-'))
})

afterAll(async () => {
  slowExport?.end()
  // Chrome writes to its profile while it shuts down: the profiles go only once every Chrome has exited.
  for (const chrome of chromes) chrome.process.kill()
  await Promise.all(chromes.map((chrome) => chrome.exited))
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  server.closeAllConnections()
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

/** A headless Chrome of its own, the way a user or a cloud provider runs one: its CDP WebSocket URL. */
async function startChrome(): Promise<string> {
  const profile = fs.mkdtempSync(path.join(cwd, 'profile-'))
  const chrome = spawn(resolveBrowserExecutablePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const exited = Promise.withResolvers<void>()
  chrome.once('exit', () => exited.resolve())
  chromes.push({ process: chrome, exited: exited.promise })
  const endpoint = Promise.withResolvers<string>()
  let output = ''
  chrome.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(output)
    if (match) endpoint.resolve(match[1]!)
  })
  chrome.once('exit', (code) => endpoint.reject(new Error(`Chrome exited (${code}) before listening:\n${output}`)))
  return await endpoint.promise
}

/** A session on `endpoint` showing the fixture page, with what the model saw on it. */
async function openSession(endpoint: string, cloud: boolean): Promise<{ executor: PlaywrightExecutor; observation: string }> {
  const executor = new PlaywrightExecutor({
    cdpConfig: { directCdpUrl: endpoint },
    logger: { log: () => {}, error: () => {} },
    cwd,
    policy: 'human',
    ...(cloud ? { cloudSession: {} } : {}),
  })
  const load = await executor.execute(`await page.goto('${baseUrl}/', { waitUntil: 'load' })`, 30000)
  expect(load.isError, load.text).toBe(false)
  const look = await executor.execute('await observe()', 30000)
  expect(look.isError, look.text).toBe(false)
  return { executor, observation: look.text }
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

describe('downloads over connectOverCDP', () => {
  it('direct CDP to a Chrome on this machine: the popup download is saved into the session folder', async () => {
    const { executor, observation } = await openSession(await startChrome(), false)
    const clicked = await executor.execute(`await act.click(${refOf(observation, /link "Export CSV"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    expect(clicked.text).toMatch(/DOWNLOAD \[d1\] report\.csv from .*\/export — completed → downloads\.save\('d1', 'report\.csv'\) saves it into the session folder/)
    const saved = await executor.execute("const saved = await downloads.save('d1', 'direct/report.csv')\nreturn saved.bytes", 30000)
    expect(saved.isError, saved.text).toBe(false)
    expect(fs.readFileSync(path.join(cwd, 'direct', 'report.csv'), 'utf8')).toBe(CSV)
  })

  it('cloud browser: the report says where the file is and offers no save; downloads.save refuses the same way', async () => {
    const endpoint = await startChrome()
    const { executor, observation } = await openSession(endpoint, true)
    const clicked = await executor.execute(`await act.click(${refOf(observation, /link "Export CSV"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)
    const where = `the browser runs on another machine (the cloud browser at ${new URL(endpoint).host}), so it saved the file there, not on this machine`
    expect(clicked.text).toContain(`DOWNLOAD [d1] report.csv from ${baseUrl}/export — completed, but it cannot be copied here: ${where}`)
    expect(clicked.text).not.toContain('downloads.save(')
    const refused = await executor.execute("await downloads.save('d1', 'cloud/report.csv')", 30000)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain(`Download d1 (report.csv) cannot be saved here: ${where}. Nothing was saved.`)
    expect(refused.text).not.toMatch(/HINT|ENOENT/)
    const listed = await executor.execute('return JSON.stringify(downloads.list())', 30000)
    expect(listed.text).toContain(`"cannotCopy":"${where}"`)
    expect(fs.existsSync(path.join(cwd, 'cloud'))).toBe(false)
  })

  it("extension: once the relay put Chrome's file at Playwright's path, downloads.save and debug mode's saveAs copy it", async () => {
    const { browser, page, userFolder } = await userFolderTab()
    const download = await downloadFrom(page, '#same')
    expect(await download.failure()).toBe(null)
    const asked = await download.path()
    // Chrome named it itself, in the user's folder: not where Playwright reads it.
    expect(fs.existsSync(asked)).toBe(false)
    expect(fs.readdirSync(userFolder)).toEqual(['report.csv'])
    await expect(download.saveAs(path.join(cwd, 'raw.csv'))).rejects.toThrow(/ENOENT/)

    // What the relay does before it forwards the completion (cdp-relay.ts trackExtensionDownload).
    expect(deliverDownloadFile({ filePath: path.join(userFolder, 'report.csv'), guid: path.basename(asked), folders: [path.dirname(asked)] })).toEqual({
      [path.dirname(asked)]: { ok: true },
    })
    const extension = new SessionDownloads({ kind: 'extension', relay: async () => null })
    const entry = extension.track(download)
    expect(await extension.reportLine(entry, await entry.outcome, { waitedMs: 0, where: '' })).toBe(
      `[d1] report.csv from ${baseUrl}/export — completed → downloads.save('d1', 'report.csv') saves it into the session folder`,
    )
    const saved = await extension.save({ id: 'd1', target: 'extension/report.csv', deadlineAt: Date.now() + 10_000, jail: new ScopedFS([cwd, '/tmp', os.tmpdir()], cwd) })
    expect(saved).toEqual({ id: 'd1', file: 'report.csv', path: path.join(cwd, 'extension', 'report.csv'), bytes: CSV.length })
    expect(fs.readFileSync(saved.path, 'utf8')).toBe(CSV)
    await download.saveAs(path.join(cwd, 'extension', 'debug.csv'))
    expect(fs.readFileSync(path.join(cwd, 'extension', 'debug.csv'), 'utf8')).toBe(CSV)
    await browser.close()
  })

  it('extension: when the file is not there, the refusal says exactly why, as the relay tells it — never an ENOENT', async () => {
    const { browser, page, userFolder } = await userFolderTab()
    const download = await downloadFrom(page, '#same')
    expect(await download.failure()).toBe(null)
    const asked = await download.path()
    const folder = path.dirname(asked)
    const chromeFile = path.join(userFolder, 'report.csv')
    const jail = new ScopedFS([cwd, '/tmp', os.tmpdir()], cwd)
    const answers: Array<{ status: RelayDownloadStatus | null | Error; reason: string }> = [
      { status: { state: 'unmatched', problem: '2 chrome.downloads items fit' }, reason: 'the extension could not match it to a Chrome download (2 chrome.downloads items fit)' },
      {
        status: { state: 'saved', filePath: chromeFile, folders: { [folder]: { ok: false, reason: 'folder-missing', message: `${folder} does not exist on the relay's machine` } } },
        reason: `the relay runs on another machine: Chrome saved it there at ${chromeFile}, and this session's folder ${folder} does not exist on that machine`,
      },
      {
        status: { state: 'saved', filePath: chromeFile, folders: { [folder]: { ok: true } } },
        reason: `the relay runs on another machine: it put the file into ${folder} on that machine (Chrome saved it at ${chromeFile} there)`,
      },
      {
        status: { state: 'saved', filePath: chromeFile, folders: { [folder]: { ok: false, reason: 'failed', message: 'EACCES: permission denied' } } },
        reason: `Chrome saved it at ${chromeFile}, but the relay could not put it into this session's folder ${folder}: EACCES: permission denied`,
      },
      { status: null, reason: 'the playwriter relay has no record of it' },
      { status: new Error('fetch failed'), reason: 'the playwriter relay could not be asked where Chrome saved it (fetch failed)' },
    ]
    for (const { status, reason } of answers) {
      const extension = new SessionDownloads({
        kind: 'extension',
        relay: async (guid) => {
          expect(guid).toBe(path.basename(asked))
          if (status instanceof Error) throw status
          return status
        },
      })
      const entry = extension.track(download)
      expect(await extension.reportLine(entry, await entry.outcome, { waitedMs: 0, where: '' })).toBe(
        `[d1] report.csv from ${baseUrl}/export — completed, but it cannot be copied here: ${reason}`,
      )
      await expect(extension.save({ id: 'd1', target: 'extension.csv', deadlineAt: Date.now() + 10_000, jail })).rejects.toThrow(
        `Download d1 (report.csv) cannot be saved here: ${reason}. Nothing was saved.`,
      )
    }

    const direct = new SessionDownloads({ kind: 'direct', endpoint: 'ws://browser.example:9222/devtools/browser/x' })
    direct.track(download)
    await expect(direct.save({ id: 'd1', target: 'direct-missing.csv', deadlineAt: Date.now() + 10_000, jail })).rejects.toThrow(
      `Download d1 (report.csv) cannot be saved here: the browser at browser.example:9222 did not save it where Playwright asked (${asked} does not exist on this machine), ` +
        'so the file is on the machine the browser runs on, or in a folder the browser chose itself. Nothing was saved.',
    )
    expect(fs.existsSync(path.join(cwd, 'extension.csv'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, 'direct-missing.csv'))).toBe(false)
    await browser.close()
  })

  it('extension: a download Chrome holds for the user to choose where to save it is reported as waiting for the user', async () => {
    const { browser, page } = await userFolderTab()
    const download = await downloadFrom(page, '#slow')
    const guids: string[] = []
    const extension = new SessionDownloads({
      kind: 'extension',
      relay: async (guid) => {
        guids.push(guid)
        return { state: 'asking' }
      },
    })
    const entry = extension.track(download)
    const asking =
      "Chrome is waiting for the user to choose where to save it (Chrome's \"Ask where to save each file before downloading\" setting is on): " +
      "ask the user to pick a place in Chrome's save dialog"
    expect(await extension.reportLine(entry, null, { waitedMs: 0, where: '' })).toBe(
      `[d1] slow.csv from ${baseUrl}/slow-export — not saved yet: ${asking}; then downloads.save('d1', 'slow.csv') saves it into the session folder`,
    )
    // A real deadline on purpose: the export is held open, so save() waits out the call's time and
    // then answers with what the relay says instead of "still downloading".
    await expect(extension.save({ id: 'd1', target: 'slow.csv', deadlineAt: Date.now() + 1500, jail: new ScopedFS([cwd, '/tmp', os.tmpdir()], cwd) })).rejects.toThrow(
      `Download d1 (slow.csv) is not saved yet: ${asking}, then call downloads.save('d1', '${path.join(cwd, 'slow.csv')}') again. Nothing was saved.`,
    )
    // Asked by the download's guid, known before it finished.
    expect(guids.length).toBe(2)
    expect(guids[0]).toMatch(/^[0-9a-f-]{36}$/)
    slowExport?.end('1,42\n')
    expect(await download.failure()).toBe(null)
    expect(path.basename(await download.path())).toBe(guids[0])
    await browser.close()
  })
})

/**
 * A tab whose downloads Chrome saves the way it does through the extension: in the user's own folder,
 * under a name it picks (`Page.setDownloadBehavior allow` stands in for the user's settings; through
 * the extension nothing at all is set). Playwright still reads `<its folder>/<guid>`.
 */
async function userFolderTab(): Promise<{ browser: Browser; page: Page; userFolder: string }> {
  const chromium = await getChromium()
  const browser = await chromium.connectOverCDP(await startChrome())
  const context = browser.contexts()[0]!
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(`${baseUrl}/`)
  const userFolder = fs.mkdtempSync(path.join(cwd, 'user-downloads-'))
  const tab = await context.newCDPSession(page)
  await tab.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: userFolder })
  return { browser, page, userFolder }
}

async function downloadFrom(page: Page, selector: string): Promise<Download> {
  const started = Promise.withResolvers<Download>()
  page.once('download', (download) => started.resolve(download))
  await page.click(selector)
  return await started.promise
}
