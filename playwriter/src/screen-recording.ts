/**
 * Screen recording utility for playwriter using chrome.tabCapture.
 * Recording happens in the extension context, so it survives page navigation.
 *
 * This module communicates with the relay server which forwards commands to the extension.
 * sessionId (pw-tab-* format) is used to identify which tab to record.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserContext, Page } from '@xmorse/playwright-core'
import { shouldUseHeadlessByDefault } from './browser-config.js'
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

/**
 * Generate a CLI command that starts a managed Playwriter browser with the
 * bundled extension preloaded. This enables screen recording without a manual
 * extension click on fresh automation sessions.
 */
export function getChromeRestartCommand(): string {
  const headlessFlag = shouldUseHeadlessByDefault({ platform: os.platform() }) ? ' --headless' : ''
  return `playwriter browser start${headlessFlag}`
}

/** Default max recording duration: 15 minutes in milliseconds */
const DEFAULT_MAX_DURATION_MS = 15 * 60 * 1000

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
  path: string
  duration: number
  size: number
  executionTimestamps: ExecutionTimestamp[]
  /** What the pointer layer drew. Present unless the recording was started with `pointer: false`. */
  pointer?: PointerBurnResult
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
  const { context, defaultPage, relayPort, ghostCursorController, onStart, onFinish, getExecutionTimestamps, viewportOf } = options

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
    const targetPage = opts.page || defaultPage
    const sessionId = opts.sessionId || targetPage.sessionId() || undefined
    return isRecording({ page: targetPage, sessionId, relayPort })
  }

  const cancelWithDefaults = async (opts: CancelRecordingWithDefaultsOptions = {}): Promise<void> => {
    const targetPage = opts.page || defaultPage
    const sessionId = opts.sessionId || targetPage.sessionId() || undefined
    await cancelRecording({ page: targetPage, sessionId, relayPort })
  }

  const start = async (opts?: StartRecordingWithDefaultsOptions): Promise<RecordingState> => {
    const targetPage = resolveRecordingTargetPage({ context, defaultPage, ghostCursorController, target: opts })

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

    // Schedule auto-stop to prevent unbounded recordings filling disk.
    // Default 15 min. Set maxDurationMs to 0 or Infinity to disable.
    const maxMs = opts?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
    if (maxMs > 0 && maxMs < Infinity) {
      maxDurationTimer = setTimeout(() => {
        maxDurationTimer = null
        stop(opts ? { page: opts.page, sessionId: opts.sessionId } : undefined).catch(() => {})
      }, maxMs)
    }

    return result
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
    const result = await stopWithDefaults(opts)
    const recordingEndedAt = Date.now()
    const executionTimestamps = [...getExecutionTimestamps()]
    onFinish()
    await restoreViewport(targetPage)
    const plan = pointerPlans.get(targetPage)
    pointerPlans.delete(targetPage)
    if (!plan) return { ...result, executionTimestamps }
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
    return { ...result, size: fs.statSync(result.path).size, executionTimestamps, pointer }
  }

  const cancel = async (opts?: CancelRecordingWithDefaultsOptions): Promise<void> => {
    clearMaxDurationTimer()
    const targetPage = resolveRecordingTargetPage({ context, defaultPage, ghostCursorController, target: opts })
    await cancelWithDefaults(opts)
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

    // If the error is about missing activeTab permission, provide helpful guidance
    if (isActiveTabPermissionError(errorMsg)) {
      const restartCmd = getChromeRestartCommand()
      throw new Error(
        `Failed to start recording: ${errorMsg}\n\n` +
          `For automated recording, start a managed Playwriter browser with the bundled extension loaded:\n\n` +
          `  ${restartCmd}\n\n` +
          `Or click the Playwriter extension icon on the tab once to grant permission.`,
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
