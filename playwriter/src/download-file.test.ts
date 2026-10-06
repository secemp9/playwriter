/**
 * The relay's side of extension downloads (download-file.ts), on real temp folders: putting the file
 * Chrome saved at `<folder>/<guid>` for each owning client, what `GET /downloads/:guid` answers, and
 * that nothing is kept once no client could ask about it.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { deliverDownloadFile, parseRelayDownloadStatus, RelayDownloads } from './download-file.js'

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true })
})

function newFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'download-file-'))
  folders.push(folder)
  return folder
}

const CSV = 'id,total\n1,42\n'

/** A file the way Chrome leaves it in the user's download folder. */
function chromeFile(): string {
  const file = path.join(newFolder(), 'report.csv')
  fs.writeFileSync(file, CSV)
  return file
}

describe('deliverDownloadFile', () => {
  it("hard-links Chrome's file to <folder>/<guid> in every client folder", () => {
    const file = chromeFile()
    const [a, b] = [newFolder(), newFolder()]
    expect(deliverDownloadFile({ filePath: file, guid: 'guid-1', folders: [a, b, a] })).toEqual({ [a]: { ok: true }, [b]: { ok: true } })
    for (const folder of [a, b]) {
      expect(fs.readFileSync(path.join(folder, 'guid-1'), 'utf8')).toBe(CSV)
      // The same file, not a second copy.
      expect(fs.statSync(path.join(folder, 'guid-1')).ino).toBe(fs.statSync(file).ino)
    }
  })

  it("does not create a folder that is gone (its client left, or it is on another machine), and says so", () => {
    const missing = path.join(newFolder(), 'playwright-artifacts-gone')
    expect(deliverDownloadFile({ filePath: chromeFile(), guid: 'guid-1', folders: [missing] })).toEqual({
      [missing]: { ok: false, reason: 'folder-missing', message: `${missing} does not exist on the relay's machine` },
    })
    expect(fs.existsSync(missing)).toBe(false)
  })

  it("says when Chrome's file is not on the relay's machine", () => {
    const absent = path.join(newFolder(), 'report.csv')
    const folder = newFolder()
    expect(deliverDownloadFile({ filePath: absent, guid: 'guid-1', folders: [folder] })).toEqual({
      [folder]: { ok: false, reason: 'file-missing', message: `${absent} does not exist on the relay's machine` },
    })
  })

  it('names any other failure', () => {
    const folder = newFolder()
    fs.writeFileSync(path.join(folder, 'guid-1'), 'already here')
    const delivered = deliverDownloadFile({ filePath: chromeFile(), guid: 'guid-1', folders: [folder] })
    expect(delivered[folder]).toMatchObject({ ok: false, reason: 'failed', message: expect.stringMatching(/^EEXIST/) })
  })
})

describe('RelayDownloads', () => {
  it('follows a download from its start to where its file went, for GET /downloads/:guid', () => {
    const downloads = new RelayDownloads()
    const [folderA, folderB] = [newFolder(), newFolder()]
    const file = chromeFile()
    downloads.begin({ guid: 'guid-1', extensionId: 'ext', clientIds: ['a'] })
    expect(downloads.status('guid-1')).toEqual({ state: 'downloading' })
    downloads.asking('guid-1', true)
    expect(downloads.status('guid-1')).toEqual({ state: 'asking' })
    downloads.asking('guid-1', false)
    const line = downloads.complete({
      guid: 'guid-1',
      extensionId: 'ext',
      report: { filePath: file },
      owners: [
        { clientId: 'a', folder: folderA },
        { clientId: 'b', folder: folderB },
        { clientId: 'c', folder: null },
      ],
    })
    expect(line).toBe(`download guid-1: Chrome saved ${file}; put into ${folderA}; put into ${folderB}`)
    expect(downloads.status('guid-1')).toEqual({ state: 'saved', filePath: file, folders: { [folderA]: { ok: true }, [folderB]: { ok: true } } })
    // Kept while any client that could ask about it is connected.
    downloads.forgetClient('a')
    downloads.forgetClient('c')
    expect(downloads.status('guid-1')).toBeDefined()
    downloads.forgetClient('b')
    expect(downloads.size()).toBe(0)
  })

  it("keeps the extension's reason when it could not tell where Chrome saved it", () => {
    const downloads = new RelayDownloads()
    downloads.begin({ guid: 'guid-1', extensionId: 'ext', clientIds: ['a'] })
    expect(downloads.complete({ guid: 'guid-1', extensionId: 'ext', report: { problem: 'two items fit' }, owners: [{ clientId: 'a', folder: newFolder() }] })).toBe(
      'download guid-1: the extension could not tell where Chrome saved it: two items fit',
    )
    expect(downloads.status('guid-1')).toEqual({ state: 'unmatched', problem: 'two items fit' })
    downloads.begin({ guid: 'guid-2', extensionId: 'ext', clientIds: ['a'] })
    downloads.complete({ guid: 'guid-2', extensionId: 'ext', report: undefined, owners: [] })
    expect(downloads.status('guid-2')).toEqual({ state: 'unmatched', problem: 'the extension sent no file report with it (it is older than this relay)' })
  })

  it('forgets canceled downloads and everything of an extension that left', () => {
    const downloads = new RelayDownloads()
    downloads.begin({ guid: 'guid-1', extensionId: 'ext', clientIds: ['a'] })
    downloads.canceled('guid-1')
    downloads.begin({ guid: 'guid-2', extensionId: 'ext', clientIds: ['a'] })
    downloads.begin({ guid: 'guid-3', extensionId: 'other', clientIds: ['b'] })
    downloads.forgetExtension('ext')
    expect(downloads.status('guid-1')).toBeUndefined()
    expect(downloads.status('guid-2')).toBeUndefined()
    expect(downloads.size()).toBe(1)
  })
})

describe('parseRelayDownloadStatus', () => {
  it('reads every status the relay answers, and refuses anything else', () => {
    const saved = { state: 'saved', filePath: '/d/report.csv', folders: { '/tmp/a': { ok: true }, '/tmp/b': { ok: false, reason: 'folder-missing', message: 'gone' } } }
    expect(parseRelayDownloadStatus(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
    expect(parseRelayDownloadStatus({ state: 'asking' })).toEqual({ state: 'asking' })
    expect(parseRelayDownloadStatus({ state: 'unmatched', problem: 'x' })).toEqual({ state: 'unmatched', problem: 'x' })
    expect(parseRelayDownloadStatus({ state: 'saved', filePath: '/d', folders: { '/tmp/a': { ok: false, reason: 'other', message: 'x' } } })).toEqual({
      invalid: 'folder /tmp/a has an unknown result',
    })
    expect(parseRelayDownloadStatus({ error: 'nope' })).toEqual({ invalid: 'no state' })
  })
})
