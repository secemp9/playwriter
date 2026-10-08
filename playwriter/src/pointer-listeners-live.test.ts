/**
 * Live-Chromium regression test for readPointerListeners' CDP call shape. Resolving the document in
 * the isolated world and reading `DOMDebugger.getEventListeners` on it with `pierce: true` crashed
 * the renderer (SIGSEGV, `Target.targetCrashed` errorCode 139) a few seconds later during
 * human-mode-live's chat test, on Chromium 133 and Chrome 149: the document must be resolved in the
 * main world (no execution context), and every object released. human-mode-live's chat block is the
 * end-to-end reproducer; this pins the call shape that does not crash.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import type { Browser } from '@xmorse/playwright-core'
import { getCDPSessionForPage } from './cdp-session.js'
import type { ICDPSession } from './cdp-session.js'
import { readPointerListeners } from './pointer-listeners.js'

const LAB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'browser-lab')

let server: http.Server
let baseUrl = ''
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(LAB, path.normalize(new URL(req.url ?? '/', 'http://localhost').pathname))
    if (!file.startsWith(LAB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/css' })
    res.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
}, 120000)

afterAll(async () => {
  const closing = await Promise.allSettled([browser?.close()])
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close((error) => (error ? closed.reject(error) : closed.resolve()))
  const stopped = await Promise.allSettled([closed.promise])
  const errors = [...closing, ...stopped].flatMap((outcome): unknown[] => (outcome.status === 'rejected' ? [outcome.reason] : []))
  if (errors.length > 0) throw new AggregateError(errors, `teardown failed: ${errors.map(String).join('; ')}`)
})

describe('readPointerListeners call shape', () => {
  it('resolves the document in the main world, pierces shadow roots and iframes, and releases its objects', async () => {
    const page = await browser.newPage()
    await page.goto(`${baseUrl}/pointer.html`, { waitUntil: 'load' })
    const cdp = await getCDPSessionForPage({ page })
    const sent: Array<{ method: string; params: unknown }> = []
    const recording: ICDPSession = {
      send(method, params) {
        sent.push({ method, params })
        return cdp.send(method, params)
      },
      on: (event, callback) => cdp.on(event, callback),
      off: (event, callback) => cdp.off(event, callback),
      detach: () => cdp.detach(),
    }
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const listeners = await readPointerListeners({ cdp: recording, documentBackendId: root.backendNodeId, timeoutMs: 5000 })
    // The context-menu card is found: the read works.
    const card = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#ctx-card' })
    const { node } = await cdp.send('DOM.describeNode', { nodeId: card.nodeId })
    expect(listeners?.get(node.backendNodeId)).toEqual(['contextmenu'])

    const resolve = sent.find((call) => call.method === 'DOM.resolveNode')
    expect(resolve, JSON.stringify(sent)).toBeDefined()
    // No execution context: the main world. The isolated world's document crashed the renderer.
    expect(resolve?.params).not.toHaveProperty('executionContextId')
    const read = sent.find((call) => call.method === 'DOMDebugger.getEventListeners')
    expect(read?.params).toMatchObject({ depth: -1, pierce: true })
    expect(sent.map((call) => call.method).at(-1)).toBe('Runtime.releaseObjectGroup')
    await page.close()
  }, 60000)
})
