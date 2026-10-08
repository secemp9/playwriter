/**
 * The `recording.start/stop/isRecording/cancel` API.
 *
 * With the Playwriter extension, recording uses chrome.tabCapture in the extension, so it
 * survives page navigation; the relay forwards the commands and sessionId (pw-tab-* format)
 * names the tab. A browser without the extension (a headless Chrome this process launched, a
 * direct CDP connection) has no tabCapture: there the same calls drive the session's CDP
 * screencast recorder (`recording.startCdp`, cdp-screencast.ts), and every result names the
 * recorder it used.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { BrowserContext, Page } from '@xmorse/playwright-core'
import type {
  StartRecordingResult,
  StopRecordingResult,
  IsRecordingResult,
  CancelRecordingResult,
} from './protocol.js'
import { GhostCursorController } from './ghost-cursor-controller.js'
import {
  burnPointerIntoVideo,
  validatePointerOptions,
  type CdpScreencastResult,
  type PointerBurnResult,
  type PointerOverlayOptions,
} from './cdp-screencast.js'
import { pointerTrackFor } from './pointer-track.js'

/**
 * Build headers for the relay's privileged /recording/* HTTP endpoints.
 * Reads PLAYWRITER_TOKEN from env so in-process callers (executor running
 * inside `playwriter serve --token …`) authenticate against their own relay.
 * The `serve` command sets the env var at startup.
 */
function recordingHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = process.env.PLAYWRITER_TOKEN
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

/** Default max recording duration: 15 minutes in milliseconds */
const DEFAULT_MAX_DURATION_MS = 15 * 60 * 1000

/** The longest delay a Node.js timer takes (2^31-1 ms, 24.8 days): a disabled duration limit. */
const MAX_TIMER_MS = 2_147_483_647

/** Which recorder made a recording. */
export type RecorderKind = 'extension-tab-capture' | 'cdp-screencast'

const CDP_RECORDER_NOTE =
  'Recording with the CDP screencast recorder: this browser has no Playwriter extension, so tab capture is unavailable. ' +
  'Frames arrive when the page repaints and are held in between; it keeps recording across navigations of this tab; ' +
  'no audio; it keeps at most 5000 frames (recording.stop() says if it dropped any). recording.stop() writes the MP4.'

/**
 * The session's CDP screencast recorder (`recording.startCdp`), as `recording.*` drives it in a
 * browser without the extension. The handle lives on the executor, so a recording started with
 * `recording.startCdp` is the same one `active()` reports.
 */
export interface CdpRecorder {
  start(options: { page: Page; outputPath: string; fps: number; maxDurationMs: number; pointer?: boolean | PointerOverlayOptions }): Promise<{ startedAt: number }>
  stop(): Promise<CdpScreencastResult>
  cancel(): Promise<void>
  /** The CDP screencast running in this session — started by recording.start or recording.startCdp — or null. */
  active(): { startedAt: number; frames: number } | null
}

/**
 * Compute the largest viewport that fits inside `current` at the target aspect ratio.
 * Never increases width or height beyond current values — only shrinks the
 * dimension that's "too large" relative to the target ratio.
 */
export function fitToAspectRatio(
  current: { width: number; height: number },
  ratio: { width: number; height: number },
): { width: number; height: number } {
  const targetRatio = ratio.width / ratio.height
  const currentRatio = current.width / current.height
  if (currentRatio > targetRatio) {
    // Too wide — keep height, shrink width
    return { width: Math.round(current.height * targetRatio), height: current.height }
  }
  // Too tall (or already exact) — keep width, shrink height
  return { width: current.width, height: Math.round(current.width / targetRatio) }
}

/**
 * Check if an error is related to missing activeTab permission for recording.
 */
function isActiveTabPermissionError(error: string): boolean {
  return (
    error.includes('Extension has not been invoked') ||
    error.includes('activeTab') ||
    error.includes('enable recording')
  )
}

export interface StartRecordingOptions {
  /** Target page to record */
  page: Page
  /** CDP tab session ID (pw-tab-* format) to identify which tab to record */
  sessionId?: string
  /** Frame rate (default: 30) */
  frameRate?: number
  /** Video bitrate in bps (default: 2500000 = 2.5 Mbps) */
  videoBitsPerSecond?: number
  /** Audio bitrate in bps (default: 128000 = 128 kbps) */
  audioBitsPerSecond?: number
  /** Include audio from tab (default: false) */
  audio?: boolean
  /** Path to save the video file */
  outputPath: string
  /** Relay server port (default: 19988) */
  relayPort?: number
  /**
   * Resize the viewport to this aspect ratio before recording. **Off by default, and it
   * perturbs the page:** `setViewportSize` fires `resize` and re-evaluates every media query
   * in the page, so the recording shows a page laid out differently from the one the agent
   * was driving. The original size is restored on stop/cancel. For a fixed-aspect clip
   * without touching the page, record as-is and pad or crop the file afterwards with
   * ffmpeg (`-vf pad=...` / `-vf crop=...`).
   */
  aspectRatio?: { width: number; height: number }
  /** Max recording duration in ms (default: 15 min = 900000). Auto-stops recording
   *  when exceeded to prevent accidentally filling disk. Set to 0 or Infinity to disable. */
  maxDurationMs?: number
  /**
   * Draw the pointer into the video at `stop()`. **On by default**; `false` turns it off, an
   * object styles it. Drawn from the page's pointer track — the positions the automation
   * dispatched — never from anything in the page, so nothing is injected to show it.
   *
   * Burning it needs libass. Left at the default on an ffmpeg without libass it is skipped
   * and the stop result's `pointer.note` says so; requested explicitly, that is an error.
   */
  pointer?: boolean | PointerOverlayOptions
}

export interface StopRecordingOptions {
  /** Target page that is being recorded */
  page: Page
  /** CDP tab session ID (pw-tab-* format) to identify which tab to stop recording */
  sessionId?: string
  /** Relay server port (default: 19988) */
  relayPort?: number
}

export interface RecordingState {
  isRecording: boolean
  startedAt?: number
  tabId?: number
  /** The recorder of the running recording: the extension's tab capture or the CDP screencast. */
  recorder?: RecorderKind
  /** Frames the CDP screencast has captured so far (CDP screencast only). */
  frames?: number
  /** What the recorder that started does differently (CDP screencast only). */
  note?: string
}

export interface ExecutionTimestamp {
  start: number
  end: number
}

interface RecordingTargetOptions {
  page?: Page
  sessionId?: string
}

interface CreateRecordingApiOptions {
  context: BrowserContext
  defaultPage: Page
  relayPort: number
  ghostCursorController: GhostCursorController
  onStart: () => void
  onFinish: () => void
  getExecutionTimestamps: () => ExecutionTimestamp[]
  /**
   * The page's CSS viewport (`innerWidth` × `innerHeight`), read without touching it: Playwright's
   * `page.evaluate` runs as a user gesture and gives the page user activation.
   */
  viewportOf: (page: Page) => Promise<{ width: number; height: number }>
  /**
   * Whether the browser has the extension's tab capture: false for a headless Chrome this process
   * launched and for a direct CDP connection, which then record with `cdp`.
   */
  tabCapture: boolean
  cdp: CdpRecorder
}

interface StartRecordingWithDefaultsOptions extends Omit<StartRecordingOptions, 'relayPort'> {}
interface StopRecordingWithDefaultsOptions extends Omit<StopRecordingOptions, 'relayPort'> {}
interface IsRecordingWithDefaultsOptions {
  page?: Page
  sessionId?: string
}
interface CancelRecordingWithDefaultsOptions {
  page?: Page
  sessionId?: string
}

function resolveRecordingTargetPage(options: {
  context: BrowserContext
  defaultPage: Page
  ghostCursorController: GhostCursorController
  target?: RecordingTargetOptions
}): Page {
  return options.ghostCursorController.resolveRecordingTargetPage({
    context: options.context,
    defaultPage: options.defaultPage,
    target: options.target,
  })
}

function withRecordingDefaults<T extends { page?: Page; sessionId?: string }, R>(options: {
  relayPort: number
  defaultPage: Page
  fn: (opts: T & { relayPort: number; sessionId?: string }) => Promise<R>
}): (input?: T) => Promise<R> {
  const { relayPort, defaultPage, fn } = options
  return async (input: T = {} as T) => {
    const targetPage = input.page || defaultPage
    const sessionId = input.sessionId || targetPage.sessionId() || undefined
    return fn({ page: targetPage, sessionId, relayPort, ...input })
  }
}

/** What `recording.stop()` returns. */
export interface RecordingStopResult {
  recorder: RecorderKind
  path: string
  /** Milliseconds. */
  duration: number
  size: number
  executionTimestamps: ExecutionTimestamp[]
  /** What the pointer layer drew. Present unless the recording was started with `pointer: false`. */
  pointer?: PointerBurnResult
  /** Frames captured (CDP screencast only). */
  frames?: number
  /** What the CDP screencast recorder adjusted or dropped (frame cap, late first frame). */
  note?: string
}

/** What `start()` captured so `stop()` can burn the pointer on the recording's own clock. */
interface PointerBurnPlan {
  startedAt: number
  cssViewport: { width: number; height: number }
  fps: number
  options?: PointerOverlayOptions
  required: boolean
}

export function createRecordingApi(options: CreateRecordingApiOptions): {
  start: (opts?: StartRecordingWithDefaultsOptions) => Promise<RecordingState>
  stop: (opts?: StopRecordingWithDefaultsOptions) => Promise<RecordingStopResult>
  isRecording: (opts?: IsRecordingWithDefaultsOptions) => Promise<RecordingState>
  cancel: (opts?: CancelRecordingWithDefaultsOptions) => Promise<void>
} {
  const { context, defaultPage, relayPort, ghostCursorController, onStart, onFinish, getExecutionTimestamps, viewportOf, tabCapture, cdp } = options

  // Stores the original viewport before an explicit aspect-ratio resize so we can restore on stop/cancel
  let preRecordingViewport: { width: number; height: number } | null = null
  // Auto-stop timer to prevent unbounded recordings
  let maxDurationTimer: NodeJS.Timeout | null = null
  // Per recorded page; absent when the recording was started with pointer: false.
  const pointerPlans = new Map<Page, PointerBurnPlan>()

  const startWithDefaults = withRecordingDefaults<StartRecordingWithDefaultsOptions, RecordingState>({
    relayPort,
    defaultPage,
    fn: startRecording,
  })
  const stopWithDefaults = withRecordingDefaults<StopRecordingWithDefaultsOptions, { path: string; duration: number; size: number }>({
    relayPort,
    defaultPage,
    fn: stopRecording,
  })
  const isRecordingWithDefaults = async (opts: IsRecordingWithDefaultsOptions = {}): Promise<RecordingState> => {
    if (tabCapture) {
      const targetPage = opts.page || defaultPage
      const sessionId = opts.sessionId || targetPage.sessionId() || undefined
      const state = await isRecording({ page: targetPage, sessionId, relayPort })
      if (state.isRecording) return { ...state, recorder: 'extension-tab-capture' }
    }
    // Also a recording made with recording.startCdp: it is this session's, whoever started it.
    const running = cdp.active()
    return running ? { isRecording: true, startedAt: running.startedAt, recorder: 'cdp-screencast', frames: running.frames } : { isRecording: false }
  }

  const cancelWithDefaults = async (opts: CancelRecordingWithDefaultsOptions = {}): Promise<void> => {
    const targetPage = opts.page || defaultPage
    const sessionId = opts.sessionId || targetPage.sessionId() || undefined
    await cancelRecording({ page: targetPage, sessionId, relayPort })
  }

  /** Recording options only the extension's tab capture has: refused, not ignored, when the CDP screencast records. */
  const refuseForCdpRecorder = (opts: StartRecordingWithDefaultsOptions | undefined): string => {
    const prefix =
      'recording.start: this browser has no Playwriter extension, so recording.start records with the CDP screencast recorder'
    const outputPath = opts?.outputPath
    if (!outputPath) throw new Error(`${prefix}, and it needs outputPath: recording.start({ outputPath: '/abs/path/clip.mp4' }). Nothing was recorded.`)
    if (path.extname(outputPath).toLowerCase() !== '.mp4') {
      throw new Error(`${prefix}, which writes an H.264 MP4: give outputPath a .mp4 name (got ${JSON.stringify(outputPath)}). Nothing was recorded.`)
    }
    if (opts.audio) throw new Error(`${prefix}, which records no audio: omit audio. Nothing was recorded.`)
    if (opts.videoBitsPerSecond !== undefined || opts.audioBitsPerSecond !== undefined) {
      throw new Error(
        `${prefix}, which has no bitrate setting: omit videoBitsPerSecond/audioBitsPerSecond, or call ` +
          'recording.startCdp({ outputPath, quality }) to set the JPEG quality of its frames. Nothing was recorded.',
      )
    }
    return outputPath
  }

  /**
   * A duration that is the feature (e): stop on its own after maxDurationMs (default 15 min) so a forgotten
   * recording cannot fill the disk; 0 or Infinity disables it.
   */
  const scheduleAutoStop = (maxMs: number, opts: StartRecordingWithDefaultsOptions | undefined): void => {
    if (maxMs > 0 && maxMs < Infinity) {
      maxDurationTimer = setTimeout(() => {
        maxDurationTimer = null
        stop(opts ? { page: opts.page, sessionId: opts.sessionId } : undefined).catch(() => {})
      }, maxMs)
    }
  }

  const start = async (opts?: StartRecordingWithDefaultsOptions): Promise<RecordingState> => {
    const targetPage = resolveRecordingTargetPage({ context, defaultPage, ghostCursorController, target: opts })
    const cdpOutputPath = tabCapture ? null : refuseForCdpRecorder(opts)
    const maxMs = opts?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
    // Only on explicit request: resizing fires `resize` and media-query changes in the page.
    // Only shrinks — never increases width or height beyond current values.
    if (opts?.aspectRatio) {
      const current = targetPage.viewportSize()
      if (!current) {
        throw new Error(
          'recording.start: aspectRatio needs an emulated viewport to shrink, and this page has none (it is sized by ' +
            'its browser window). Omit aspectRatio and pad or crop the recorded file with ffmpeg instead.',
        )
      }
      const fitted = fitToAspectRatio(current, opts.aspectRatio)
      if (fitted.width !== current.width || fitted.height !== current.height) {
        preRecordingViewport = current
        await targetPage.setViewportSize(fitted)
      }
    }

    const pointer = opts?.pointer ?? true
    // Refused now rather than after the recording has been made.
    validatePointerOptions(typeof pointer === 'object' ? pointer : undefined)
    if (cdpOutputPath !== null) {
      const { startedAt } = await cdp.start({
        page: targetPage,
        outputPath: cdpOutputPath,
        fps: opts?.frameRate ?? 30,
        // The recorder's own hard stop; the auto-stop below is what encodes the file at that point.
        maxDurationMs: maxMs > 0 && maxMs < Infinity ? maxMs : MAX_TIMER_MS,
        // Passed through as given: the recorder draws the pointer itself, and an explicit value makes a missing libass an error.
        pointer: opts?.pointer,
      })
      onStart()
      scheduleAutoStop(maxMs, opts)
      return { isRecording: true, startedAt, recorder: 'cdp-screencast', note: CDP_RECORDER_NOTE }
    }
    // The CSS viewport the pointer track's coordinates live in, which `stop()` scales onto the
    // captured video. Measured after any resize above.
    const cssViewport = pointer === false ? undefined : await viewportOf(targetPage)
    if (pointer !== false) pointerTrackFor(targetPage)

    const result = await startWithDefaults(opts)
    onStart()
    if (cssViewport) {
      if (result.startedAt === undefined) {
        throw new Error('recording.start: the relay reported no startedAt, so the pointer cannot be aligned with the video.')
      }
      pointerPlans.set(targetPage, {
        startedAt: result.startedAt,
        cssViewport,
        fps: opts?.frameRate ?? 30,
        options: typeof pointer === 'object' ? pointer : undefined,
        required: opts?.pointer !== undefined,
      })
    }

    scheduleAutoStop(maxMs, opts)
    return { ...result, recorder: 'extension-tab-capture' }
  }

  const clearMaxDurationTimer = (): void => {
    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer)
      maxDurationTimer = null
    }
  }

  const restoreViewport = async (targetPage: Page): Promise<void> => {
    if (!preRecordingViewport) {
      return
    }
    const saved = preRecordingViewport
    preRecordingViewport = null
    await targetPage.setViewportSize(saved)
  }

  const stop = async (opts?: StopRecordingWithDefaultsOptions): Promise<RecordingStopResult> => {
    clearMaxDurationTimer()
    const targetPage = resolveRecordingTargetPage({ context, defaultPage, ghostCursorController, target: opts })
    if (!tabCapture) {
      if (!cdp.active()) {
        throw new Error(
          'recording.stop: no recording is running. This browser has no Playwriter extension: recording.start({ outputPath }) ' +
            'records with the CDP screencast recorder.',
        )
      }
      const recorded = await cdp.stop()
      const executionTimestamps = [...getExecutionTimestamps()]
      onFinish()
      await restoreViewport(targetPage)
      if (!recorded.wrote) throw new Error(`recording.stop: no video was written. ${recorded.note ?? ''}`.trim())
      const written = path.resolve(recorded.outputPath)
      return {
        recorder: 'cdp-screencast',
        path: written,
        duration: recorded.durationMs,
        size: fs.statSync(written).size,
        frames: recorded.frames,
        executionTimestamps,
        ...(recorded.pointer ? { pointer: recorded.pointer } : {}),
        ...(recorded.note ? { note: recorded.note } : {}),
      }
    }
    const result = await stopWithDefaults(opts)
    const recordingEndedAt = Date.now()
    const executionTimestamps = [...getExecutionTimestamps()]
    onFinish()
    await restoreViewport(targetPage)
    const plan = pointerPlans.get(targetPage)
    pointerPlans.delete(targetPage)
    if (!plan) return { recorder: 'extension-tab-capture', ...result, executionTimestamps }
    const pointer = await burnPointerIntoVideo({
      videoPath: result.path,
      timeline: pointerTrackFor(targetPage),
      recordingStartedAt: plan.startedAt,
      recordingEndedAt,
      cssViewport: plan.cssViewport,
      fps: plan.fps,
      options: plan.options,
      required: plan.required,
    }).catch((error: Error) => {
      throw new Error(`${error.message} The recording itself was saved, without the pointer, at ${result.path}.`)
    })
    return { recorder: 'extension-tab-capture', ...result, size: fs.statSync(result.path).size, executionTimestamps, pointer }
  }

  const cancel = async (opts?: CancelRecordingWithDefaultsOptions): Promise<void> => {
    clearMaxDurationTimer()
    const targetPage = resolveRecordingTargetPage({ context, defaultPage, ghostCursorController, target: opts })
    if (tabCapture) await cancelWithDefaults(opts)
    else await cdp.cancel()
    pointerPlans.delete(targetPage)
    onFinish()
    await restoreViewport(targetPage)
  }

  return {
    start,
    stop,
    isRecording: isRecordingWithDefaults,
    cancel,
  }
}

/**
 * Start recording the page.
 * The recording is handled by the extension, so it survives page navigation.
 */
export async function startRecording(options: StartRecordingOptions): Promise<RecordingState> {
  const {
    sessionId,
    frameRate = 30,
    videoBitsPerSecond = 2500000,
    audioBitsPerSecond = 128000,
    audio = false,
    outputPath,
    relayPort = 19988,
  } = options

  // Resolve relative paths to absolute using the caller's cwd.
  // The relay server may have a different cwd, so we must resolve here.
  const absoluteOutputPath = path.resolve(outputPath)

  const response = await fetch(`http://127.0.0.1:${relayPort}/recording/start`, {
    method: 'POST',
    headers: recordingHeaders(),
    body: JSON.stringify({
      sessionId,
      frameRate,
      videoBitsPerSecond,
      audioBitsPerSecond,
      audio,
      outputPath: absoluteOutputPath,
    }),
  })

  const result = (await response.json()) as StartRecordingResult

  if (!result.success) {
    const errorMsg = result.error || 'Unknown error'

    // Missing activeTab permission: only a click on the extension icon grants it.
    if (isActiveTabPermissionError(errorMsg)) {
      throw new Error(
        `Failed to start recording: ${errorMsg}\n\n` +
          `recording.start needs the user to click the Playwriter extension icon on this tab once: ask them to. ` +
          `recording.startCdp records without that click.`,
      )
    }

    throw new Error(`Failed to start recording: ${errorMsg}`)
  }

  return {
    isRecording: true,
    startedAt: result.startedAt,
    tabId: result.tabId,
  }
}

/**
 * Stop recording and save to file.
 * Returns the path to the saved video file.
 */
export async function stopRecording(
  options: StopRecordingOptions,
): Promise<{ path: string; duration: number; size: number }> {
  const { sessionId, relayPort = 19988 } = options

  const response = await fetch(`http://127.0.0.1:${relayPort}/recording/stop`, {
    method: 'POST',
    headers: recordingHeaders(),
    body: JSON.stringify({ sessionId }),
  })

  const result = (await response.json()) as StopRecordingResult

  if (!result.success) {
    throw new Error(`Failed to stop recording: ${result.error}`)
  }

  return { path: result.path, duration: result.duration, size: result.size }
}

/**
 * Check if recording is currently active.
 */
export async function isRecording(options: {
  page: Page
  sessionId?: string
  relayPort?: number
}): Promise<RecordingState> {
  const { sessionId, relayPort = 19988 } = options

  const url = new URL(`http://127.0.0.1:${relayPort}/recording/status`)
  if (sessionId) {
    url.searchParams.set('sessionId', sessionId)
  }
  // GET request — only the Authorization header matters here
  const response = await fetch(url.toString(), { headers: recordingHeaders() })
  const result = (await response.json()) as IsRecordingResult

  return { isRecording: result.isRecording, startedAt: result.startedAt, tabId: result.tabId }
}

/**
 * Cancel recording without saving.
 */
export async function cancelRecording(options: {
  page: Page
  sessionId?: string
  relayPort?: number
}): Promise<void> {
  const { sessionId, relayPort = 19988 } = options

  const response = await fetch(`http://127.0.0.1:${relayPort}/recording/cancel`, {
    method: 'POST',
    headers: recordingHeaders(),
    body: JSON.stringify({ sessionId }),
  })

  const result = (await response.json()) as CancelRecordingResult

  if (!result.success) {
    throw new Error(`Failed to cancel recording: ${result.error}`)
  }
}
