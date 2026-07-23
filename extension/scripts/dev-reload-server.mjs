// Dev live-reload server for the unpacked Playwriter extension.
//
// Watches the built background.js and serves its current build token (the file's
// modification time) at GET /build-id. The extension's service worker polls this in
// `npm run dev` builds and calls chrome.runtime.reload() whenever the token changes, so a
// source edit -> vite rebuild -> automatic extension reload, with no manual clicks.
//
// Deliberately dependency-free (node:http + node:fs only): it must start instantly
// alongside `vite build --watch` and never pull the extension into a heavier dev stack.
// A short debounce absorbs vite's multi-file writes so the SW never reloads on a
// half-written dist.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PLAYWRITER_DEV_RELOAD_PORT || '19989')
const outDir = process.env.PLAYWRITER_EXTENSION_DIST
  ? path.resolve(process.env.PLAYWRITER_EXTENSION_DIST)
  : path.resolve(__dirname, '..', 'dist')
const watchTarget = path.join(outDir, 'background.js')

// The current build token. Derived from background.js mtime so it changes on every
// rebuild; monotonic-ish and cheap. Recomputed (debounced) whenever the file changes.
function currentMtimeToken() {
  try {
    return String(fs.statSync(watchTarget).mtimeMs)
  } catch {
    return ''
  }
}

let buildToken = currentMtimeToken()
let debounceTimer = null

function scheduleUpdate() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    const next = currentMtimeToken()
    if (next && next !== buildToken) {
      buildToken = next
      console.log(`[dev-reload] dist changed -> build ${buildToken}; extension will reload`)
    }
  }, 300)
}

// fs.watch on the directory: robust to editors/bundlers that replace (rename) the file,
// which a watch on the file inode alone would miss.
try {
  fs.watch(outDir, { persistent: true }, (_event, filename) => {
    if (!filename || filename === 'background.js') scheduleUpdate()
  })
} catch (err) {
  console.error(`[dev-reload] could not watch ${outDir}:`, err.message)
}

const server = http.createServer((req, res) => {
  // Same-origin isn't a concern (localhost dev only); allow the extension origin freely.
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.url && req.url.startsWith('/build-id')) {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end(buildToken)
    return
  }
  res.writeHead(404)
  res.end()
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[dev-reload] port ${PORT} already in use — another dev-reload server is probably running.`)
    process.exit(0)
  }
  console.error('[dev-reload] server error:', err)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-reload] serving build token on http://127.0.0.1:${PORT}/build-id (watching ${watchTarget})`)
})
