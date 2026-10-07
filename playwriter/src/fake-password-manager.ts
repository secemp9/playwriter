/**
 * A minimal password manager extension for tests: its inline menu is a page of its own
 * (`chrome-extension://<id>/menu.html`, web-accessible) shown in an iframe, the way Bitwarden shows
 * its autofill menu.
 *
 * With `inlineMenu`, a content script opens that menu when an email or password field gets focus — a
 * custom element with a closed shadow root holding the iframe, appended to `<body>` — and removes it
 * when the field loses focus or on Escape. A field marked `data-pm-flash` gets the menu for 26 ms
 * only (Bitwarden was measured inserting it and removing it ~26 ms later). Every `chrome.debugger`
 * client on the tab is cut off while that iframe is in the page (debugger-cut.ts).
 *
 * Without `inlineMenu` the extension only serves `menu.html`, for a page that embeds it itself.
 *
 * Extensions need full Chromium (`channel: 'chromium'`), not the headless shell.
 */

import fs from 'node:fs'
import path from 'node:path'

const CONTENT_SCRIPT = `
let host = null
let flashTimer = 0
function close() {
  clearTimeout(flashTimer)
  host?.remove()
  host = null
}
function open(field) {
  if (host) return
  host = document.createElement('pm-inline-menu')
  const shadow = host.attachShadow({ mode: 'closed' })
  const frame = document.createElement('iframe')
  frame.title = 'Password manager menu'
  frame.src = chrome.runtime.getURL('menu.html')
  shadow.appendChild(frame)
  document.body.appendChild(host)
  if (field.hasAttribute('data-pm-flash')) flashTimer = setTimeout(close, 26)
}
document.addEventListener('focusin', (event) => {
  const field = event.target
  if (field instanceof HTMLInputElement && (field.type === 'email' || field.type === 'password')) open(field)
}, true)
document.addEventListener('focusout', close, true)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close()
}, true)
`

/** Writes the extension into `dir` (which must exist), ready for `--load-extension`. */
export function writeFakePasswordManager({ dir, inlineMenu }: { dir: string; inlineMenu: boolean }): void {
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Test password manager',
      version: '1.0',
      background: { service_worker: 'worker.js' },
      web_accessible_resources: [{ resources: ['menu.html'], matches: ['<all_urls>'] }],
      ...(inlineMenu ? { content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }] } : {}),
    }),
  )
  fs.writeFileSync(path.join(dir, 'worker.js'), '')
  fs.writeFileSync(path.join(dir, 'menu.html'), '<!doctype html><title>Menu</title><button>Fill password</button>')
  if (inlineMenu) fs.writeFileSync(path.join(dir, 'content.js'), CONTENT_SCRIPT)
}
