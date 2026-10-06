/**
 * download-file.ts — the relay's side of extension downloads: putting the file Chrome saved where each
 * Playwright client reads it, and answering `GET /downloads/:guid` about what became of it.
 *
 * Playwright reads a finished download from `<its downloads folder>/<guid>` (the folder each client
 * names in its `Browser.setDownloadBehavior allowAndName`). Through an extension, Chrome saves the file
 * where the user's settings say, under a name it picks: chrome.debugger refuses
 * `Page.setDownloadBehavior` and has no Browser domain. The extension finds the file through
 * chrome.downloads (download-match.ts) and reports its path on the tab's `Page.downloadProgress
 * completed`. Before forwarding that completion, the relay hard-links the file (or, across
 * filesystems, copies it) to `<folder>/<guid>` for every client whose workspace owns the tab, taken
 * at that moment. A folder that does not exist (its client left: Playwright deletes it then; or this
 * relay runs on another machine than that client) is not created; what happened to each folder is
 * kept for `GET /downloads/:guid`, which is how a session's `downloads.save` says why a file is not
 * there.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { DownloadFileReport } from './protocol.js'

/** What became of one client folder's copy of a finished download. */
export type FolderDelivery =
  | { ok: true }
  | { ok: false; reason: 'folder-missing' | 'file-missing' | 'failed'; message: string }

/** What the relay knows of a download, as `GET /downloads/:guid` answers (404: nothing). */
export type RelayDownloadStatus =
  | { state: 'downloading' }
  /** Chrome holds all the bytes and waits for the user to choose where to save them. */
  | { state: 'asking' }
  /** Chrome saved it at `filePath` (on the relay's machine when the relay runs there); `folders`: each client folder's copy. */
  | { state: 'saved'; filePath: string; folders: Record<string, FolderDelivery> }
  /** The extension could not tell which file Chrome saved: `problem` says why. */
  | { state: 'unmatched'; problem: string }

interface DownloadRecord {
  extensionId: string
  status: RelayDownloadStatus
  /** The clients that could ask about it: the tab's owners when it began and when it finished. */
  clientIds: Set<string>
}

/**
 * Put `filePath` at `<folder>/<guid>` for each folder: a hard link (the same file, no second copy), or a
 * copy when the folder is on another filesystem (EXDEV). A missing folder is not created.
 */
export function deliverDownloadFile({ filePath, guid, folders }: { filePath: string; guid: string; folders: readonly string[] }): Record<string, FolderDelivery> {
  const delivered: Record<string, FolderDelivery> = {}
  for (const folder of new Set(folders)) {
    if (!fs.existsSync(folder)) {
      delivered[folder] = { ok: false, reason: 'folder-missing', message: `${folder} does not exist on the relay's machine` }
      continue
    }
    const target = path.join(folder, guid)
    try {
      fs.linkSync(filePath, target)
      delivered[folder] = { ok: true }
      continue
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT' && !fs.existsSync(filePath)) {
        delivered[folder] = { ok: false, reason: 'file-missing', message: `${filePath} does not exist on the relay's machine` }
        continue
      }
      if (code !== 'EXDEV') {
        delivered[folder] = { ok: false, reason: 'failed', message: messageOf(error) }
        continue
      }
    }
    try {
      fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL)
      delivered[folder] = { ok: true }
    } catch (error) {
      delivered[folder] = { ok: false, reason: 'failed', message: messageOf(error) }
    }
  }
  return delivered
}

/** Every extension download the relay has seen, until no client that could ask about it is left. */
export class RelayDownloads {
  private readonly records = new Map<string, DownloadRecord>()

  /** A tab's `Page.downloadWillBegin`; `clientIds`: the clients whose workspace owns the tab now. */
  begin({ guid, extensionId, clientIds }: { guid: string; extensionId: string; clientIds: readonly string[] }): void {
    this.records.set(guid, { extensionId, status: { state: 'downloading' }, clientIds: new Set(clientIds) })
  }

  /** The extension says Chrome waits for the user to choose where to save it, or no longer does. */
  asking(guid: string, asking: boolean): void {
    const record = this.records.get(guid)
    if (record && (record.status.state === 'downloading' || record.status.state === 'asking')) {
      record.status = { state: asking ? 'asking' : 'downloading' }
    }
  }

  /**
   * The tab's `Page.downloadProgress completed` with the extension's report: put the file in the owning
   * clients' folders (`owners`, taken now) and keep what happened. Returns a line for the relay log.
   */
  complete({ guid, extensionId, report, owners }: { guid: string; extensionId: string; report: DownloadFileReport | undefined; owners: ReadonlyArray<{ clientId: string; folder: string | null }> }): string {
    const record = this.records.get(guid) ?? { extensionId, status: { state: 'downloading' }, clientIds: new Set<string>() }
    for (const owner of owners) record.clientIds.add(owner.clientId)
    this.records.set(guid, record)
    if (report === undefined) {
      record.status = { state: 'unmatched', problem: 'the extension sent no file report with it (it is older than this relay)' }
      return `download ${guid}: the extension did not say where Chrome saved it`
    }
    if ('problem' in report) {
      record.status = { state: 'unmatched', problem: report.problem }
      return `download ${guid}: the extension could not tell where Chrome saved it: ${report.problem}`
    }
    const folders = owners.flatMap((owner) => (owner.folder === null ? [] : [owner.folder]))
    const delivered = deliverDownloadFile({ filePath: report.filePath, guid, folders })
    record.status = { state: 'saved', filePath: report.filePath, folders: delivered }
    const lines = Object.entries(delivered).map(([folder, result]) => (result.ok ? `put into ${folder}` : `not put into ${folder}: ${result.message}`))
    return `download ${guid}: Chrome saved ${report.filePath}${lines.length === 0 ? '; no client asked for downloads' : `; ${lines.join('; ')}`}`
  }

  /** The tab's download was canceled: Playwright reports that itself. */
  canceled(guid: string): void {
    this.records.delete(guid)
  }

  status(guid: string): RelayDownloadStatus | undefined {
    return this.records.get(guid)?.status
  }

  /** A client left: nothing it could ask about is kept for it any longer. */
  forgetClient(clientId: string): void {
    for (const [guid, record] of this.records) {
      record.clientIds.delete(clientId)
      if (record.clientIds.size === 0) this.records.delete(guid)
    }
  }

  forgetExtension(extensionId: string): void {
    for (const [guid, record] of this.records) {
      if (record.extensionId === extensionId) this.records.delete(guid)
    }
  }

  /** Downloads still kept (tests check nothing leaks). */
  size(): number {
    return this.records.size
  }
}

/** `value` as a RelayDownloadStatus (the JSON `GET /downloads/:guid` answered), or why it is not one. */
export function parseRelayDownloadStatus(value: unknown): RelayDownloadStatus | { invalid: string } {
  if (typeof value !== 'object' || value === null || !('state' in value)) return { invalid: 'no state' }
  switch (value.state) {
    case 'downloading':
    case 'asking':
      return { state: value.state }
    case 'unmatched':
      return 'problem' in value && typeof value.problem === 'string' ? { state: 'unmatched', problem: value.problem } : { invalid: 'unmatched without a problem' }
    case 'saved': {
      if (!('filePath' in value) || typeof value.filePath !== 'string' || !('folders' in value) || typeof value.folders !== 'object' || value.folders === null) {
        return { invalid: 'saved without filePath and folders' }
      }
      const folders: Record<string, FolderDelivery> = {}
      for (const [folder, result] of Object.entries(value.folders)) {
        if (typeof result !== 'object' || result === null || !('ok' in result)) return { invalid: `folder ${folder} has no result` }
        if (result.ok === true) {
          folders[folder] = { ok: true }
          continue
        }
        const reason = 'reason' in result ? result.reason : undefined
        const message = 'message' in result ? result.message : undefined
        if ((reason !== 'folder-missing' && reason !== 'file-missing' && reason !== 'failed') || typeof message !== 'string') {
          return { invalid: `folder ${folder} has an unknown result` }
        }
        folders[folder] = { ok: false, reason, message }
      }
      return { state: 'saved', filePath: value.filePath, folders }
    }
  }
  return { invalid: `unknown state ${String(value.state)}` }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
