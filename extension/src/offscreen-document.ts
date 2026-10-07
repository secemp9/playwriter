/**
 * The extension's single offscreen document (Chrome allows one per extension), shared by
 * screen recording (MediaRecorder), the clipboard writes of the element picker and the
 * clipboard reads of the sandbox's `clipboard.read()` — an MV3 service worker has neither
 * API, and touching the clipboard from the inspected page would mean running code in it.
 */

import type { OffscreenCopyToClipboardResult, OffscreenReadClipboardResult } from './offscreen-types'

let offscreenDocumentCreating: Promise<void> | null = null

export async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL('src/offscreen.html')],
  })
  if (existingContexts.length > 0) {
    return
  }

  // Reuse in-progress creation
  if (offscreenDocumentCreating) {
    return offscreenDocumentCreating
  }

  offscreenDocumentCreating = chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.CLIPBOARD],
    justification: 'Screen recording via chrome.tabCapture, copying picked-element references to the clipboard, and reading the clipboard text on request',
  })

  try {
    await offscreenDocumentCreating
  } finally {
    offscreenDocumentCreating = null
  }
}

export async function copyTextViaOffscreen(text: string): Promise<void> {
  await ensureOffscreenDocument()
  const result = (await chrome.runtime.sendMessage({ action: 'copyToClipboard', text })) as
    | OffscreenCopyToClipboardResult
    | undefined
  if (!result) throw new Error('The offscreen document did not answer the clipboard request.')
  if (!result.success) throw new Error(`Clipboard write failed: ${result.error}`)
}

/** The clipboard's text, read in the offscreen document (needs the `clipboardRead` permission). */
export async function readTextViaOffscreen(): Promise<string> {
  await ensureOffscreenDocument()
  const result = (await chrome.runtime.sendMessage({ action: 'readClipboard' })) as OffscreenReadClipboardResult | undefined
  if (!result) throw new Error('The offscreen document did not answer the clipboard read.')
  if (!result.success) throw new Error(`Clipboard read failed: ${result.error}`)
  return result.text
}
