/**
 * cdp-screencast.ts — gesture-free tab recording.
 *
 * Why this exists alongside `screen-recording.ts`:
 *
 * The tabCapture recorder (`recording.start`) produces a better picture — real
 * compositor output at a fixed frame rate — but `chrome.tabCapture.getMediaStreamId`
 * is gated behind an **activeTab grant that only a genuine user gesture produces**.
 * Neither Playwriter's unconditional tab auto-creation nor the programmatic
 * `toggleExtensionForActiveTab` satisfies Chrome; a human must click the extension
 * icon on that tab. Fine interactively, useless unattended.
 *
 * This recorder needs no gesture and works on an ordinary extension-connected
 * session as well as over direct CDP.
 *
 * THE ACTUAL CONSTRAINT IS TAB VISIBILITY, NOT CONNECTION TYPE. A backgrounded tab
 * has no compositor surface, so `Page.startScreencast` delivers zero frames and
 * `Page.captureScreenshot` hangs until timeout — neither returns an error, which
 * makes it very easy to misread as an API restriction. Foreground the tab first;
 * `'screenshot'`/`'auto'` mode does that for you when handed a `page`.
 *
 * Two capture paths, because screencast can legitimately produce nothing:
 *   - screencast  — change-driven, cheap, preferred.
 *   - screenshot  — polls `Page.captureScreenshot` (~8.5fps measured through the
 *                   extension). Always produces frames on a foregrounded tab, even
 *                   for a page that never repaints.
 *
 * Screencast emits a frame when the page repaints, not on a clock, so we keep each
 * frame's real arrival time and let ffmpeg rebuild constant-rate video from those
 * timestamps — a two-second pause stays two seconds instead of collapsing.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ICDPSession } from './cdp-session.js'

/** A single captured frame: JPEG bytes plus the ms offset from recording start. */
interface CapturedFrame {
  data: Buffer
  offsetMs: number
}

export interface CdpScreencastOptions {
  cdp: ICDPSession
  /** Where to write the .mp4 */
  outputPath: string
  /**
   * How frames are obtained.
   *
   * - `'screencast'` — `Page.startScreencast`. Cheap and change-driven; works through
   *   the extension too. Yields nothing if the tab is backgrounded or never repaints.
   * - `'screenshot'` — poll `Page.captureScreenshot` (~8.5fps / 118ms per frame
   *   measured through the extension). Produces frames even on a static page.
   * - `'auto'` (default) — try screencast, and if no frame arrives within `probeMs`,
   *   switch to screenshot polling. Covers the static-page case and any environment
   *   where screencast frames do not arrive.
   *
   * All modes require a FOREGROUND tab; `'screenshot'`/`'auto'` call `bringToFront()`
   * when given a `page`.
   */
  mode?: 'auto' | 'screencast' | 'screenshot'
  /** How long `'auto'` waits for a screencast frame before falling back (default 1500ms). */
  probeMs?: number
  /** Page handle — required for `'screenshot'`/`'auto'` so the tab can be foregrounded. */
  page?: { bringToFront(): Promise<void> }
  /** JPEG quality 0-100 (default 70). Lower = smaller files, faster frames. */
  quality?: number
  /** Cap the captured frame width/height; Chrome scales to fit. */
  maxWidth?: number
  maxHeight?: number
  /** Output frame rate for the encoded video (default 10). */
  fps?: number
  /** Hard stop so a forgotten recording cannot fill the disk (default 10 min). */
  maxDurationMs?: number
  /** Cap on retained frames (default 5000 ≈ 165MB at 33KB/frame). */
  maxFrames?: number
}

export interface CdpScreencastHandle {
  /** Stop capturing, encode, and return the written file. */
  stop(): Promise<CdpScreencastResult>
  /** Abort without writing anything. */
  cancel(): Promise<void>
  /** Frames captured so far — useful to assert motion was actually recorded. */
  frameCount(): number
}

export interface CdpScreencastResult {
  outputPath: string
  frames: number
  durationMs: number
  /** Which capture path actually produced the frames. */
  mode?: 'screencast' | 'screenshot'
  /** False when nothing repainted, so no video was produced. */
  wrote: boolean
  note?: string
}

/**
 * Begin capturing. Returns a handle; call `stop()` to encode and write.
 *
 * The returned promise resolves once Chrome has accepted `Page.startScreencast`,
 * so any action taken after the await is inside the capture window.
 */
export async function startCdpScreencast(options: CdpScreencastOptions): Promise<CdpScreencastHandle> {
  const {
    cdp,
    outputPath,
    quality = 70,
    maxWidth,
    maxHeight,
    fps = 10,
    maxDurationMs = 10 * 60 * 1000,
    maxFrames = 5000,
    mode = 'auto',
    probeMs = 1500,
    page,
  } = options

  const frames: CapturedFrame[] = []
  const startedAt = Date.now()
  let stopped = false
  let droppedForCap = 0

  const onFrame = (params: { data: string; sessionId: number }) => {
    if (stopped) return
    if (frames.length >= maxFrames) {
      droppedForCap++
      // Still ack, or Chrome stops sending and we silently lose the tail.
      void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
      return
    }
    frames.push({ data: Buffer.from(params.data, 'base64'), offsetMs: Date.now() - startedAt })
    // Chrome throttles to one un-acked frame; without this we get exactly one frame.
    void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  }

  cdp.on('Page.screencastFrame' as never, onFrame as never)

  await cdp.send('Page.enable')

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let usedMode: 'screencast' | 'screenshot' = 'screencast'

  /**
   * Poll `Page.captureScreenshot`. Unlike screencast this is a plain request/response
   * command, so the extension debugger API forwards it normally — which is what makes
   * gesture-free recording possible on an ordinary extension-connected session.
   * Serialised (no overlapping calls) because a backlog only adds latency.
   */
  async function startScreenshotPolling(): Promise<void> {
    usedMode = 'screenshot'
    // A backgrounded tab has no compositor surface: captureScreenshot then hangs
    // until the CDP timeout rather than returning an error.
    try {
      await page?.bringToFront()
    } catch {
      // Best-effort; if we cannot foreground it the first capture will surface the problem.
    }
    let inFlight = false
    pollTimer = setInterval(() => {
      if (stopped || inFlight || frames.length >= maxFrames) return
      inFlight = true
      void cdp
        .send('Page.captureScreenshot', { format: 'jpeg', quality })
        .then((r: any) => {
          if (!stopped && r?.data) {
            frames.push({ data: Buffer.from(r.data, 'base64'), offsetMs: Date.now() - startedAt })
          }
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false
        })
    }, Math.max(1000 / fps, 60))
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  if (mode === 'screenshot') {
    await startScreenshotPolling()
  } else {
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      ...(maxWidth ? { maxWidth } : {}),
      ...(maxHeight ? { maxHeight } : {}),
      everyNthFrame: 1,
    })
    if (mode === 'auto') {
      // Nothing in the CDP session says whether an extension is in the path, so detect
      // by observation: no frame within probeMs means screencast will never deliver.
      setTimeout(() => {
        if (!stopped && frames.length === 0) {
          void cdp.send('Page.stopScreencast').catch(() => {})
          void startScreenshotPolling()
        }
      }, probeMs).unref?.()
    }
  }

  const guard = setTimeout(() => {
    if (!stopped) void teardown().catch(() => {})
  }, maxDurationMs)
  // A stray timer must not hold the process open.
  if (typeof guard.unref === 'function') guard.unref()

  async function teardown(): Promise<void> {
    if (stopped) return
    stopped = true
    clearTimeout(guard)
    if (pollTimer) clearInterval(pollTimer)
    cdp.off?.('Page.screencastFrame' as never, onFrame as never)
    try {
      await cdp.send('Page.stopScreencast')
    } catch {
      // Tab may already be gone; nothing to stop.
    }
  }

  return {
    frameCount: () => frames.length,

    async cancel() {
      await teardown()
      frames.length = 0
    },

    async stop(): Promise<CdpScreencastResult> {
      await teardown()
      const durationMs = Date.now() - startedAt

      if (frames.length === 0) {
        return {
          outputPath,
          frames: 0,
          durationMs,
          mode: usedMode,
          wrote: false,
          // Two very different causes produce zero frames, and guessing the wrong one
          // sends you looking in the wrong place — so name both. The connection-mode
          // case is by far the more common surprise: `Page.startScreencast` returns
          // success and `screencastVisibilityChanged` fires even when frames will
          // never be delivered, so there is nothing to detect at start() time.
          note:
            'No frames captured. The usual cause is a BACKGROUNDED TAB — it has no ' +
            'compositor surface, so neither screencast nor screenshot can capture it, ' +
            'and Chrome reports no error. Call page.bringToFront() (or pass `page` so ' +
            'this recorder can) and retry. Otherwise the recording window may simply ' +
            'have been too short to contain any repaint.',
        }
      }

      await encodeFrames({ frames, outputPath, fps, durationMs })

      return {
        outputPath,
        frames: frames.length,
        durationMs,
        mode: usedMode,
        wrote: true,
        note: droppedForCap > 0 ? `Hit the ${maxFrames}-frame cap; dropped ${droppedForCap} later frames.` : undefined,
      }
    },
  }
}

/**
 * Encode captured frames to mp4, preserving real timing.
 *
 * ffmpeg's concat demuxer takes an explicit `duration` per image, so a still stretch
 * of the recording stays still for the right length instead of being compressed away.
 * We then force a constant output rate so ordinary players scrub correctly.
 */
async function encodeFrames({
  frames,
  outputPath,
  fps,
  durationMs,
}: {
  frames: CapturedFrame[]
  outputPath: string
  fps: number
  durationMs: number
}): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-screencast-'))
  try {
    const lines: string[] = []
    frames.forEach((frame, i) => {
      const file = path.join(workDir, `f${String(i).padStart(6, '0')}.jpg`)
      fs.writeFileSync(file, frame.data)
      // Hold this frame until the next one arrived (last frame gets a sane tail).
      // The floor must stay well below the output frame interval: clamping to 1/fps
      // would stretch a burst of rapid repaints into one wall-clock second each and
      // desynchronise the whole clip from real time. `-vsync cfr` resamples anyway.
      const next = i + 1 < frames.length ? frames[i + 1].offsetMs : durationMs
      const holdSec = Math.max((next - frame.offsetMs) / 1000, 0.001)
      lines.push(`file '${file}'`, `duration ${holdSec.toFixed(3)}`)
    })
    // concat demuxer quirk: the final image must be repeated or it is dropped.
    lines.push(`file '${path.join(workDir, `f${String(frames.length - 1).padStart(6, '0')}.jpg`)}'`)

    const listFile = path.join(workDir, 'frames.txt')
    fs.writeFileSync(listFile, lines.join('\n'))

    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })

    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-vsync', 'cfr',
      '-r', String(fps),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      // yuv420p needs even dimensions; screencast output is often odd.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags', '+faststart',
      path.resolve(outputPath),
    ])
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (chunk) => {
      // Keep only the tail; ffmpeg is extremely chatty.
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    proc.on('error', (err) =>
      reject(new Error(`ffmpeg failed to spawn (is it installed?): ${err.message}`)),
    )
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr}`))
    })
  })
}
