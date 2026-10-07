/**
 * session-downloads.ts — getting the files the page under test produced: the downloads the action
 * reports listed (`downloads.list()`, `downloads.save(id, path)`) and, through `net.save(id, path)`,
 * the full body of a response the page loaded.
 *
 * A download is seen as Playwright's `download` event on a tab the action report watches, popups
 * included (a `target=_blank` export downloads in the popup, not in the controlled tab). Each one
 * gets a short id for the session (`d1`, `d2`, …), printed on its `DOWNLOAD` line.
 *
 * Where the file ends up depends on how the session reaches its browser, and only some of those
 * places are reachable from this process. Every session connects in-process (`chromium.launch` or
 * `connectOverCDP`), where `Download.saveAs` copies `<Playwright's downloads folder>/<guid>` from
 * THIS machine's disk (`Artifact.saveAs`; the streaming form is only used over `chromium.connect`).
 * Playwright asks Chrome to save every download exactly there (`Browser.setDownloadBehavior
 * allowAndName`):
 *   - headless: Playwright launched Chrome here — the file is there;
 *   - direct CDP: the file is there exactly when Chrome runs on this machine;
 *   - extension: chrome.debugger cannot ask that, so Chrome saves the file where the user's settings
 *     say; the extension finds it through chrome.downloads and the relay puts it at that path before
 *     Playwright hears the download finished (download-file.ts) — when it can, which the relay
 *     tells (`GET /downloads/:guid`): Chrome waits for the user to choose where to save it, the
 *     extension could not match the download, or the relay runs on another machine;
 *   - cloud: Chrome runs on the provider's machine and saves the file there.
 * For direct CDP and the extension this is checked on the finished download: `download.path()`
 * exists here or not.
 * A download that cannot be copied here says so on its report line and in `downloads.save`'s
 * refusal, with where the file is.
 *
 * The protocol calls a save makes (`Artifact.pathAfterFinished`, `Artifact.saveAs`) are on an
 * interface that never touches the page (playwright-call-effects.ts `NOT_PAGE_FACING`), so the
 * human-mode guard lets them through.
 *
 * Every target path is checked with the sandbox `fs`'s own rule (ScopedFS.resolveAllowed) before
 * anything is written: these calls write where `require('node:fs')` may write, and nowhere else.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Download } from '@xmorse/playwright-core'
import { ModelFacingError } from './probe-types.js'
import type { ScopedFS } from './scoped-fs.js'
import type { RelayDownloadStatus } from './download-file.js'

/** How this session reaches its browser: it decides whether a finished download's file is on this machine. */
export type BrowserConnection =
  /** Headless: Playwright launched Chrome on this machine (`chromium.launch`). */
  | { kind: 'launched' }
  /** `connectOverCDP` to a Chrome endpoint, on this machine or another one. */
  | { kind: 'direct'; endpoint: string }
  /** `connectOverCDP` to a cloud browser: Chrome runs on the provider's machine. */
  | { kind: 'cloud'; endpoint: string }
  /** Through the playwriter relay and extension, into the user's own Chrome; `relay` asks the relay about a download. */
  | { kind: 'extension'; relay: RelayDownloadQuery }

/**
 * What the relay knows of the extension download `guid` (`GET /downloads/:guid`); null when it has no
 * record of it. Rejects when the relay cannot be asked.
 */
export type RelayDownloadQuery = (guid: string) => Promise<RelayDownloadStatus | null>

/**
 * `download`'s `<Playwright's downloads folder>/<guid>`, known from the moment it began (the protocol's
 * Artifact `absolutePath`), or null when this Playwright client does not expose it. `download.path()`
 * gives the same only once the download finished.
 */
function artifactPathOf(download: Download): string | null {
  const artifact: unknown = Reflect.get(download, '_artifact')
  if (typeof artifact !== 'object' || artifact === null) return null
  const initializer: unknown = Reflect.get(artifact, '_initializer')
  if (typeof initializer !== 'object' || initializer === null) return null
  const absolutePath: unknown = Reflect.get(initializer, 'absolutePath')
  return typeof absolutePath === 'string' ? absolutePath : null
}

/** Chrome's own words for its setting, so the model can name it to the user. */
const ASKING =
  "Chrome is waiting for the user to choose where to save it (Chrome's \"Ask where to save each file before downloading\" setting is on): " +
  "ask the user to pick a place in Chrome's save dialog"

/**
 * What a download came to: Chrome finished it (`cannotCopy` says why its file cannot be copied here,
 * null when it can), failed it, or its outcome could not be read (its tab or browser went away).
 */
export type DownloadOutcome =
  | { state: 'completed'; cannotCopy: string | null }
  | { state: 'failed'; reason: string }
  | { state: 'unknown'; reason: string }

export interface SessionDownload {
  id: string
  download: Download
  /** Settles once the outcome is known; never rejects. */
  outcome: Promise<DownloadOutcome>
  /** The outcome once known, null while downloading. */
  settled: DownloadOutcome | null
}

/** One download as `downloads.list()` shows it. */
export interface DownloadListing {
  id: string
  /** The file name the server suggested. */
  file: string
  url: string
  state: 'downloading' | DownloadOutcome['state']
  /** Why it failed, or why its outcome is unknown. */
  reason?: string
  /** Why its file cannot be copied here (where it is instead). */
  cannotCopy?: string
}

export interface SavedDownload {
  id: string
  file: string
  /** Absolute path of the saved copy. */
  path: string
  bytes: number
}

/**
 * The call ends at its deadline with a generic timeout. `save` stops waiting this long before it, so
 * what the model reads is "still downloading", not a timeout that names nothing.
 */
const ANSWER_MARGIN_MS = 1000

function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : String(error)
}

/** `value` as a single-quoted JavaScript string, for the calls the messages tell the model to make. */
function quoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * Where `call` may write `target`: resolved by the sandbox `fs`'s rule (relative to the session cwd),
 * or refused with where it may go instead. A folder is refused too — an existing one, or a path
 * ending in a separator, which `path.resolve` would otherwise turn into a file of that name.
 */
export function jailedTarget({ jail, target, call, example }: { jail: ScopedFS; target: unknown; call: string; example: string }): string {
  if (typeof target !== 'string' || target === '') {
    throw new ModelFacingError(`${call} needs the file path to write as its second argument, like ${example}. Nothing was saved.`)
  }
  const resolved = jail.resolveAllowed(target)
  if (resolved === null) {
    throw new ModelFacingError(
      `${call}: ${target} is outside the folders this session may write to (${jail.allowedDirectories().join(', ')}) — the same ` +
        `folders require('node:fs') may touch. Pass a path inside the session folder; a relative path is resolved from it, like ${example}. Nothing was saved.`,
    )
  }
  if (target.endsWith('/') || target.endsWith(path.sep) || (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())) {
    throw new ModelFacingError(`${call}: ${target} is a folder. Pass the path of the file to write inside it, like ${example}. Nothing was saved.`)
  }
  return resolved
}

/** Every download the session's action reports saw, by id. */
export class SessionDownloads {
  private readonly entries = new Map<string, SessionDownload>()

  constructor(private readonly connection: BrowserConnection) {}

  /** Keep `download` for the session and give it its id; a download seen again keeps the id it has. */
  track(download: Download): SessionDownload {
    for (const entry of this.entries.values()) {
      if (entry.download === download) return entry
    }
    const outcome: Promise<DownloadOutcome> = download.failure().then(
      async (failure): Promise<DownloadOutcome> =>
        failure === null ? { state: 'completed', cannotCopy: await this.cannotCopyFinished(download) } : { state: 'failed', reason: failure },
      (error: unknown): DownloadOutcome => ({ state: 'unknown', reason: firstLine(error) }),
    )
    const entry: SessionDownload = { id: `d${this.entries.size + 1}`, download, outcome, settled: null }
    void outcome.then(
      (settled) => {
        entry.settled = settled
      },
      // `settled` stays null; whoever reads the outcome (`save`, the report line) awaits it and reports why.
      () => {},
    )
    this.entries.set(entry.id, entry)
    return entry
  }

  list(): DownloadListing[] {
    return [...this.entries.values()].map(({ id, download, settled }) => {
      const cannotCopy = settled?.state === 'completed' ? settled.cannotCopy : this.cannotCopyAny()
      return {
        id,
        file: download.suggestedFilename(),
        url: download.url(),
        state: settled?.state ?? 'downloading',
        ...(settled && settled.state !== 'completed' ? { reason: settled.reason } : {}),
        ...(cannotCopy !== null && settled?.state !== 'failed' && settled?.state !== 'unknown' ? { cannotCopy } : {}),
      }
    })
  }

  /**
   * The report's `DOWNLOAD` line for `entry`, after `outcome` (null: still running `waitedMs` after the
   * action). A download whose file can be copied here names the call that saves it; one that cannot
   * says where it is instead.
   */
  async reportLine(entry: SessionDownload, outcome: DownloadOutcome | null, { waitedMs, where }: { waitedMs: number; where: string }): Promise<string> {
    const file = entry.download.suggestedFilename()
    const head = `[${entry.id}] ${file} from ${entry.download.url()}${where}`
    const save = `downloads.save(${quoted(entry.id)}, ${quoted(file)})`
    if (outcome === null) {
      const cannotCopy = this.cannotCopyAny()
      const running = `${head} — still downloading when this report was written (${waitedMs}ms later)`
      if (cannotCopy !== null) return `${running}; it cannot be copied here once finished: ${cannotCopy}`
      if (await this.asking(entry.download)) return `${head} — not saved yet: ${ASKING}; then ${save} saves it into the session folder`
      return `${running} → ${save} waits for it and saves it into the session folder`
    }
    switch (outcome.state) {
      case 'completed':
        return outcome.cannotCopy === null
          ? `${head} — completed → ${save} saves it into the session folder`
          : `${head} — completed, but it cannot be copied here: ${outcome.cannotCopy}`
      case 'failed':
        return `${head} — FAILED: ${outcome.reason} (no file to save)`
      case 'unknown':
        return `${head} — outcome unknown: ${outcome.reason}`
    }
  }

  /**
   * Save download `id` to `target` (relative to the session cwd, inside the sandbox fs jail). A download
   * still running is waited for until shortly before `deadlineAt`; then the answer is that it is still
   * downloading. A failed one, one whose outcome is unknown, and one whose file is not on this machine
   * are refused with the reason.
   */
  async save({ id, target, deadlineAt, jail }: { id: unknown; target: unknown; deadlineAt: number; jail: ScopedFS }): Promise<SavedDownload> {
    if (typeof id !== 'string') {
      throw new ModelFacingError(
        "downloads.save(id, path) takes the download's id from its DOWNLOAD line as a string, like downloads.save('d1', 'report.csv'). Nothing was saved.",
      )
    }
    const entry = this.entries.get(id)
    if (!entry) {
      const seen = this.list().map((listing) => `${listing.id} ${listing.file} (${listing.state})`)
      throw new ModelFacingError(
        seen.length === 0
          ? `No download ${id}: no download has been seen in this session yet. A download shows up as a "DOWNLOAD [d1] …" line in the report of the action that started it. Nothing was saved.`
          : `No download ${id} in this session. The downloads seen so far: ${seen.join('; ')}. Nothing was saved.`,
      )
    }
    const file = entry.download.suggestedFilename()
    const resolved = jailedTarget({ jail, target, call: `downloads.save(${quoted(id)}, path)`, example: `downloads.save(${quoted(id)}, ${quoted(file)})` })
    const cannotCopyAny = this.cannotCopyAny()
    if (cannotCopyAny !== null) {
      throw new ModelFacingError(`Download ${id} (${file}) cannot be saved here: ${cannotCopyAny}. Nothing was saved.`)
    }
    let outcome = entry.settled
    if (outcome === null) {
      const waitMs = Math.max(0, deadlineAt - Date.now() - ANSWER_MARGIN_MS)
      const cap = Promise.withResolvers<null>()
      const timer = setTimeout(() => cap.resolve(null), waitMs)
      outcome = await Promise.race([entry.outcome, cap.promise])
      clearTimeout(timer)
      if (outcome === null) {
        if (await this.asking(entry.download)) {
          throw new ModelFacingError(`Download ${id} (${file}) is not saved yet: ${ASKING}, then call downloads.save(${quoted(id)}, ${quoted(resolved)}) again. Nothing was saved.`)
        }
        throw new ModelFacingError(
          `Download ${id} (${file}) is still downloading: it did not finish in the ${waitMs}ms left in this call. Nothing was saved. ` +
            `Call downloads.save(${quoted(id)}, ${quoted(resolved)}) again in a later call (give a big file a longer timeout); downloads.list() shows its state.`,
        )
      }
    }
    if (outcome.state === 'failed') {
      throw new ModelFacingError(
        `Download ${id} (${file}) failed (${outcome.reason}), so there is no file to save. Nothing was saved. Start the download again from the page; the report of that action lists the new one.`,
      )
    }
    if (outcome.state === 'unknown') {
      throw new ModelFacingError(
        `The outcome of download ${id} (${file}) could not be read (${outcome.reason}): the tab or browser it belonged to went away, so there is no file to save. Nothing was saved.`,
      )
    }
    if (outcome.cannotCopy !== null) {
      throw new ModelFacingError(`Download ${id} (${file}) cannot be saved here: ${outcome.cannotCopy}. Nothing was saved.`)
    }
    try {
      await entry.download.saveAs(resolved)
    } catch (error) {
      throw new ModelFacingError(`Download ${id} (${file}) finished, but saving it to ${resolved} failed: ${firstLine(error)}`, { cause: error })
    }
    return { id, file, path: resolved, bytes: fs.statSync(resolved).size }
  }

  /** Why no download of this connection can be copied here, whatever happens to it; null when it depends on the download. */
  private cannotCopyAny(): string | null {
    if (this.connection.kind !== 'cloud') return null
    return `the browser runs on another machine (the cloud browser at ${new URL(this.connection.endpoint).host}), so it saved the file there, not on this machine`
  }

  /** Whether the relay says Chrome waits for the user to choose where to save the running extension download. */
  private async asking(download: Download): Promise<boolean> {
    if (this.connection.kind !== 'extension') return false
    const asked = artifactPathOf(download)
    if (asked === null) return false
    try {
      return (await this.connection.relay(path.basename(asked)))?.state === 'asking'
    } catch {
      // Not asking as far as anyone can tell: the caller says it is still downloading.
      return false
    }
  }

  /** Why the finished `download` cannot be copied here, or null when it can. */
  private async cannotCopyFinished(download: Download): Promise<string | null> {
    const connection = this.connection
    if (connection.kind === 'cloud') return this.cannotCopyAny()
    if (connection.kind === 'launched') return null
    // Playwright reads it from this name, in a folder of this process: it exists here exactly when
    // Chrome (direct CDP) or the relay (extension) put it there on this machine.
    let asked: string
    try {
      asked = await download.path()
    } catch (error) {
      return `Playwright could not say where the browser saved it (${firstLine(error)})`
    }
    if (fs.existsSync(asked)) return null
    if (connection.kind === 'direct') {
      return (
        `the browser at ${new URL(connection.endpoint).host} did not save it where Playwright asked (${asked} does not exist on this machine), ` +
        'so the file is on the machine the browser runs on, or in a folder the browser chose itself'
      )
    }
    let status: RelayDownloadStatus | null
    try {
      status = await connection.relay(path.basename(asked))
    } catch (error) {
      return `the playwriter relay could not be asked where Chrome saved it (${firstLine(error)})`
    }
    return extensionReason(status, path.dirname(asked))
  }
}

/** Why an extension download the relay reported as `status` is not in this session's `folder`. */
function extensionReason(status: RelayDownloadStatus | null, folder: string): string {
  if (status === null) return 'the playwriter relay has no record of it'
  switch (status.state) {
    case 'asking':
      return ASKING
    case 'downloading':
      return 'the playwriter relay was not told it finished'
    case 'unmatched':
      return `the extension could not match it to a Chrome download (${status.problem})`
    case 'saved': {
      const delivery = status.folders[folder]
      if (delivery === undefined) {
        return `Chrome saved it at ${status.filePath}, but this session did not own the tab when it finished, so the relay did not put it into ${folder}`
      }
      if (delivery.ok) {
        return `the relay runs on another machine: it put the file into ${folder} on that machine (Chrome saved it at ${status.filePath} there)`
      }
      switch (delivery.reason) {
        case 'folder-missing':
          return `the relay runs on another machine: Chrome saved it there at ${status.filePath}, and this session's folder ${folder} does not exist on that machine`
        case 'file-missing':
          return `Chrome saved it at ${status.filePath}, but the relay could not find that file (${delivery.message}): the relay runs on another machine than the browser, or the file was moved away`
        case 'failed':
          return `Chrome saved it at ${status.filePath}, but the relay could not put it into this session's folder ${folder}: ${delivery.message}`
      }
    }
  }
}
