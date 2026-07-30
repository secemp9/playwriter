/**
 * cdp-screencast.ts — gesture-free tab recording via CDP `Page.startScreencast`.
 *
 * Why this exists alongside `screen-recording.ts`:
 *
 * The tabCapture recorder (`recording.start`) produces a better picture — real
 * compositor output at a fixed frame rate — but `chrome.tabCapture.getMediaStreamId`
 * is gated behind an **activeTab grant that only a genuine user gesture produces**.
 * Neither Playwriter's unconditional tab auto-creation nor the programmatic
 * `toggleExtensionForActiveTab` satisfies Chrome; the human must click the
 * extension icon on that tab. That is fine interactively and useless unattended.
 *
 * `Page.startScreencast` needs no such grant — but Chrome deliberately withholds
 * `Page.screencastFrame` events from the `chrome.debugger` extension API (verified:
 * the command succeeds and `Page.screencastVisibilityChanged` fires, but zero frames
 * ever arrive). So this recorder only works over a **direct CDP connection** to a
 * Chrome started with `--remote-debugging-port`, where no extension sits in the path.
 *
 * Screencast is change-driven: Chrome emits a frame when the page repaints, not on a
 * clock. A still page produces no frames at all. We therefore keep each frame's real
 * arrival time and let ffmpeg rebuild constant-rate video from those timestamps, so a
 * two-second pause stays two seconds long in the output instead of collapsing.
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
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality,
    ...(maxWidth ? { maxWidth } : {}),
    ...(maxHeight ? { maxHeight } : {}),
    everyNthFrame: 1,
  })

  const guard = setTimeout(() => {
    if (!stopped) void teardown().catch(() => {})
  }, maxDurationMs)
  // A stray timer must not hold the process open.
  if (typeof guard.unref === 'function') guard.unref()

  async function teardown(): Promise<void> {
    if (stopped) return
    stopped = true
    clearTimeout(guard)
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
          wrote: false,
          // Two very different causes produce zero frames, and guessing the wrong one
          // sends you looking in the wrong place — so name both. The connection-mode
          // case is by far the more common surprise: `Page.startScreencast` returns
          // success and `screencastVisibilityChanged` fires even when frames will
          // never be delivered, so there is nothing to detect at start() time.
          note:
            'No frames captured. Either (a) this session is connected THROUGH THE ' +
            'PLAYWRITER EXTENSION — Chrome withholds Page.screencastFrame from the ' +
            'extension debugger API, so startCdp only works over a direct CDP ' +
            'connection (`playwriter session new --direct <ws-url>`); use ' +
            'recording.start() plus one extension-icon click instead — or (b) the page ' +
            'genuinely never repainted, since screencast is change-driven and a static ' +
            'page yields nothing.',
        }
      }

      await encodeFrames({ frames, outputPath, fps, durationMs })

      return {
        outputPath,
        frames: frames.length,
        durationMs,
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
