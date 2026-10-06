/**
 * Which chrome.downloads item a tab's CDP download is (the extension's matching, download-match.ts).
 * The item shapes are the ones measured through the real extension on Chromium 151: the item is
 * created as the tab reports `Page.downloadWillBegin`, with `filename: ''`; `finalUrl` is the URL after
 * redirects, which is the one the tab reports; "Ask where to save" leaves it in_progress with every
 * byte received and no file name.
 */

import { describe, expect, it } from 'vitest'
import { chromeDownloadState, START_SLACK_BEFORE_MS, type ChromeDownloadItem, type DownloadStart } from './download-match.js'

const SEEN_AT = Date.parse('2026-10-06T11:32:42.430Z')
const URL_ = 'http://127.0.0.1:33425/file.csv'
const start: DownloadStart = { guid: 'guid-1', url: URL_, suggestedFilename: 'report.csv', seenAt: SEEN_AT }

function item(overrides: Partial<ChromeDownloadItem>): ChromeDownloadItem {
  return {
    id: 1,
    url: URL_,
    finalUrl: URL_,
    filename: '/home/user/Downloads/report.csv',
    state: 'complete',
    startTime: '2026-10-06T11:32:42.425Z',
    bytesReceived: 8,
    totalBytes: 8,
    ...overrides,
  }
}

describe('chromeDownloadState', () => {
  it("gives the completed item's file", () => {
    expect(chromeDownloadState({ start, items: [item({})], claimed: new Set(), completedBytes: 8 })).toEqual({
      state: 'saved',
      itemId: 1,
      filePath: '/home/user/Downloads/report.csv',
    })
  })

  it('matches a redirected download by the URL it ended at', () => {
    const redirected = item({ url: 'http://127.0.0.1:33425/redirect' })
    expect(chromeDownloadState({ start, items: [redirected], claimed: new Set(), completedBytes: 8 })).toMatchObject({ state: 'saved', itemId: 1 })
  })

  it('waits while the item is not complete yet (it turns complete about 1ms after the tab says completed)', () => {
    expect(chromeDownloadState({ start, items: [item({ state: 'in_progress' })], claimed: new Set(), completedBytes: 8 })).toEqual({
      state: 'pending',
      reason: 'chrome.downloads item #1 is in_progress at /home/user/Downloads/report.csv',
    })
  })

  it('reports Chrome asking where to save it: every byte in, no file name', () => {
    const asking = item({ state: 'in_progress', filename: '' })
    expect(chromeDownloadState({ start, items: [asking], claimed: new Set(), completedBytes: null })).toEqual({ state: 'asking', itemId: 1 })
    // Not before all the bytes are in: Chrome names the file early when it does not ask.
    expect(chromeDownloadState({ start, items: [item({ state: 'in_progress', filename: '', bytesReceived: 0, totalBytes: 0 })], claimed: new Set(), completedBytes: null })).toMatchObject({
      state: 'pending',
    })
  })

  it('tells two downloads of one URL apart by the bytes the tab reported', () => {
    const items = [item({ id: 1, bytesReceived: 5, totalBytes: 5 }), item({ id: 2, filename: '/home/user/Downloads/report (1).csv' })]
    expect(chromeDownloadState({ start, items, claimed: new Set(), completedBytes: 8 })).toMatchObject({ state: 'saved', itemId: 2 })
  })

  it('never gives an item twice, and breaks a tie with the suggested name only', () => {
    const items = [item({ id: 1 }), item({ id: 2, filename: '/home/user/Downloads/report (1).csv' })]
    expect(chromeDownloadState({ start, items, claimed: new Set([1]), completedBytes: 8 })).toMatchObject({ state: 'saved', itemId: 2 })
    expect(chromeDownloadState({ start, items, claimed: new Set(), completedBytes: 8 })).toMatchObject({ state: 'saved', itemId: 1 })
  })

  it('refuses when several items fit and nothing tells them apart', () => {
    const items = [item({ id: 1, filename: '/d/a.csv' }), item({ id: 2, filename: '/d/b.csv' })]
    expect(chromeDownloadState({ start, items, claimed: new Set(), completedBytes: 8 })).toEqual({
      state: 'unmatched',
      reason: `2 chrome.downloads items of ${URL_} fit and nothing tells them apart (#1 complete /d/a.csv 8B, #2 complete /d/b.csv 8B)`,
    })
  })

  it('refuses an item of another URL, started outside the window, interrupted, or with other bytes', () => {
    const items = [
      item({ id: 1, url: 'http://other/x', finalUrl: 'http://other/x' }),
      item({ id: 2, startTime: new Date(SEEN_AT - START_SLACK_BEFORE_MS - 1).toISOString() }),
      item({ id: 3, state: 'interrupted' }),
      item({ id: 4, bytesReceived: 7, totalBytes: 7 }),
    ]
    expect(chromeDownloadState({ start, items, claimed: new Set(), completedBytes: 8 })).toEqual({
      state: 'unmatched',
      reason: `no chrome.downloads item of ${URL_} started then with 8 bytes (items of that URL: #2 complete /home/user/Downloads/report.csv 8B, #3 interrupted /home/user/Downloads/report.csv 8B, #4 complete /home/user/Downloads/report.csv 7B)`,
    })
    // While the tab has not said completed, no item yet is not a refusal: it may still appear.
    expect(chromeDownloadState({ start, items: [], claimed: new Set(), completedBytes: null })).toMatchObject({ state: 'pending' })
  })
})
