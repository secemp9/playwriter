/**
 * Recording in a browser without the Playwriter extension (the MCP `browser new` headless Chrome):
 * `recording.start/isRecording/stop` record with the CDP screencast recorder and say so, instead of
 * failing with "Extension not connected"; `recording.isRecording()` also reports a recording
 * started with `recording.startCdp`. Real executor, human mode, headless Chromium.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

// The click repaints the page (the heading changes), so the screencast has a frame beyond its first.
const PAGE = `<!doctype html><html><head><title>Recorded page</title></head>
<body><main><h1>Recorded page</h1><button onclick="document.querySelector('h1').textContent = 'Clicked'">Click me</button></main></body></html>`

let server: http.Server
let baseUrl = ''
let cwd = ''
const executors: PlaywrightExecutor[] = []

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-no-extension-'))
})

afterAll(async () => {
  for (const executor of executors) await executor.closeHeadlessContext().catch(() => {})
  await PlaywrightExecutor.closeSharedHeadlessBrowser().catch(() => {})
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  server.closeAllConnections()
  await closed.promise
  fs.rmSync(cwd, { recursive: true, force: true })
})

async function openSession(policy: 'human' | 'debug'): Promise<PlaywrightExecutor> {
  const executor = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: { log: () => {}, error: () => {} }, cwd, policy })
  executors.push(executor)
  const loaded = await executor.execute(`await act.open('${baseUrl}/')`, 30000)
  expect(loaded.isError, loaded.text).toBe(false)
  return executor
}

function refOf(text: string, pattern: RegExp): number {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue
    const match = line.match(/\[(\d+)\]/)
    if (match) return Number(match[1])
  }
  throw new Error(`no ref for ${pattern} in:\n${text}`)
}

describe('recording without the extension', () => {
  it('recording.start records with the CDP screencast, says so, and stop() writes the MP4 (human mode)', async () => {
    const executor = await openSession('human')
    const outputPath = path.join(cwd, 'clip.mp4')

    const started = await executor.execute(`return await recording.start({ outputPath: ${JSON.stringify(outputPath)} })`, 30000)
    expect(started.isError, started.text).toBe(false)
    expect(started.text).not.toContain('Extension not connected')
    expect(started.text).toContain("recorder: 'cdp-screencast'")
    expect(started.text).toContain('isRecording: true')
    expect(started.text).toContain('Recording with the CDP screencast recorder: this browser has no Playwriter extension')

    const during = await executor.execute('return await recording.isRecording()', 30000)
    expect(during.isError, during.text).toBe(false)
    expect(during.text).toContain('isRecording: true')
    expect(during.text).toContain("recorder: 'cdp-screencast'")

    const look = await executor.execute('await observe()', 30000)
    const clicked = await executor.execute(`await act.click(${refOf(look.text, /button "Click me"/)})`, 30000)
    expect(clicked.isError, clicked.text).toBe(false)

    const stopped = await executor.execute('const r = await recording.stop()\nreturn { recorder: r.recorder, path: r.path, size: r.size, frames: r.frames }', 60000)
    expect(stopped.isError, stopped.text).toBe(false)
    expect(stopped.text).toContain("recorder: 'cdp-screencast'")
    expect(stopped.text).toContain(outputPath)
    const bytes = fs.readFileSync(outputPath)
    // An MP4 starts with its `ftyp` box.
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp')
    expect(stopped.text).toContain(`size: ${bytes.length}`)
    expect(Number(/frames: (\d+)/.exec(stopped.text)?.[1])).toBeGreaterThan(1)

    const after = await executor.execute('return await recording.isRecording()', 30000)
    expect(after.text).toContain('isRecording: false')
  }, 120_000)

  it('refuses what only tab capture has, before recording anything', async () => {
    const executor = await openSession('human')
    const webm = await executor.execute(`await recording.start({ outputPath: ${JSON.stringify(path.join(cwd, 'clip.webm'))} })`, 30000)
    expect(webm.isError).toBe(true)
    expect(webm.text).toContain('which writes an H.264 MP4: give outputPath a .mp4 name')
    const audio = await executor.execute(`await recording.start({ outputPath: ${JSON.stringify(path.join(cwd, 'a.mp4'))}, audio: true })`, 30000)
    expect(audio.isError).toBe(true)
    expect(audio.text).toContain('which records no audio: omit audio. Nothing was recorded.')
    const idle = await executor.execute('return await recording.isRecording()', 30000)
    expect(idle.text).toContain('isRecording: false')
    const nothing = await executor.execute('await recording.stop()', 30000)
    expect(nothing.isError).toBe(true)
    expect(nothing.text).toContain('recording.stop: no recording is running')
  }, 120_000)

  it('isRecording() reports a recording.startCdp recording (debug mode)', async () => {
    const executor = await openSession('debug')
    const started = await executor.execute(`return await recording.startCdp({ outputPath: ${JSON.stringify(path.join(cwd, 'cdp.mp4'))} })`, 30000)
    expect(started.isError, started.text).toBe(false)
    expect(started.text).toMatch(/startedAt: \d+/)
    const during = await executor.execute('return await recording.isRecording()', 30000)
    expect(during.text).toContain('isRecording: true')
    expect(during.text).toContain("recorder: 'cdp-screencast'")
    const stopped = await executor.execute('const r = await recording.stopCdp()\nreturn r.wrote', 60000)
    expect(stopped.text).toContain('true')
    const after = await executor.execute('return await recording.isRecording()', 30000)
    expect(after.text).toContain('isRecording: false')
  }, 120_000)
})
