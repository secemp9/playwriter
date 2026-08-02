/**
 * Node-side ghost cursor helpers.
 * Injects the browser bundle and forwards mouse action events to the page overlay.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, MouseActionEvent } from '@xmorse/playwright-core'

export interface GhostCursorClientOptions {
  style?: 'minimal' | 'dot' | 'screenstudio'
  color?: string
  size?: number
  zIndex?: number
  easing?: string
  minDurationMs?: number
  maxDurationMs?: number
  speedPxPerMs?: number
}

/** One knot of a sampled trajectory. `tMs` is an offset from the start of playback. */
export interface GhostCursorPathSample {
  tMs: number
  x: number
  y: number
}

interface GhostCursorBrowserApi {
  enable: (options?: GhostCursorClientOptions) => void
  disable: () => void
  applyMouseAction: (event: MouseActionEvent) => void
  playPath: (options: { samples: GhostCursorPathSample[] }) => { playing: boolean; durationMs: number }
  cancelPath: () => void
  isPlayingPath: () => boolean
}

let ghostCursorCode: string | null = null

function getGhostCursorCode(): string {
  if (ghostCursorCode) {
    return ghostCursorCode
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const bundlePath = path.join(currentDir, '..', 'dist', 'ghost-cursor-client.js')
  ghostCursorCode = fs.readFileSync(bundlePath, 'utf-8')
  return ghostCursorCode
}

/**
 * `requiredMethod` guards against VERSION SKEW, which is not hypothetical: the Chrome
 * extension bundles its own copy of this overlay and injects it into every attached tab.
 * A tab can therefore already hold an older `__playwriterGhostCursor` that predates a
 * method this process wants to call. Testing only for the object's existence would skip
 * re-injection and then silently fail on the missing method, so the capability itself is
 * what gets probed.
 */
async function ensureGhostCursorInjected(options: { page: Page; requiredMethod?: string }): Promise<void> {
  const { page, requiredMethod } = options
  const isUsable = await page.evaluate((method) => {
    const api = (globalThis as { __playwriterGhostCursor?: Record<string, unknown> }).__playwriterGhostCursor
    if (!api) {
      return false
    }
    return method ? typeof api[method] === 'function' : true
  }, requiredMethod)

  if (isUsable) {
    return
  }

  const code = getGhostCursorCode()
  await page.evaluate(code)
}

export async function enableGhostCursor(options: {
  page: Page
  cursorOptions?: GhostCursorClientOptions
}): Promise<void> {
  try {
    const { page, cursorOptions } = options
    await ensureGhostCursorInjected({ page })

    await page.evaluate(
      ({ optionsFromNode }) => {
        const api = (globalThis as { __playwriterGhostCursor?: GhostCursorBrowserApi }).__playwriterGhostCursor
        api?.enable(optionsFromNode)
      },
      { optionsFromNode: cursorOptions },
    )
  } catch {
    // Non-fatal — page may be closed or navigating.
  }
}

export async function disableGhostCursor(options: { page: Page }): Promise<void> {
  try {
    const { page } = options
    await page.evaluate(() => {
      const api = (globalThis as { __playwriterGhostCursor?: GhostCursorBrowserApi }).__playwriterGhostCursor
      api?.disable()
    })
  } catch {
    // Non-fatal — page may be closed or navigating.
  }
}

/**
 * Hand a whole sampled trajectory to the overlay in ONE round trip and let it play the
 * path back against the page's rAF clock.
 *
 * The alternative — one `applyMouseAction` per sample — costs a full page.evaluate round
 * trip each (measured at ~4-5ms through the extension) AND restarts a CSS transition
 * every sample, so the overlay both lags and smooths away the trajectory's shape. This is
 * the coordination fix that lets the drawn cursor and the real CDP pointer trace the same
 * curve.
 *
 * Returns whether the overlay actually started playing, so the caller can report it
 * rather than assume it.
 */
export async function playGhostCursorPath(options: {
  page: Page
  samples: GhostCursorPathSample[]
}): Promise<{ playing: boolean; durationMs: number }> {
  try {
    const { page, samples } = options
    if (samples.length < 2) {
      return { playing: false, durationMs: 0 }
    }

    await ensureGhostCursorInjected({ page, requiredMethod: 'playPath' })

    return await page.evaluate(
      ({ pathSamples }) => {
        const api = (globalThis as { __playwriterGhostCursor?: GhostCursorBrowserApi }).__playwriterGhostCursor
        if (!api?.playPath) {
          return { playing: false, durationMs: 0 }
        }
        return api.playPath({ samples: pathSamples })
      },
      { pathSamples: samples },
    )
  } catch {
    // The overlay is cosmetic — a closed or navigating page must not fail the move.
    return { playing: false, durationMs: 0 }
  }
}

/** Stop any in-flight path playback and hand the cursor back to `applyMouseAction`. */
export async function cancelGhostCursorPath(options: { page: Page }): Promise<void> {
  try {
    await options.page.evaluate(() => {
      const api = (globalThis as { __playwriterGhostCursor?: GhostCursorBrowserApi }).__playwriterGhostCursor
      api?.cancelPath?.()
    })
  } catch {
    // Non-fatal — page may be closed or navigating.
  }
}

export async function applyGhostCursorMouseAction(options: {
  page: Page
  event: MouseActionEvent
}): Promise<void> {
  // Never throw — the cursor is cosmetic and must not break the caller's action.
  try {
    const { page, event } = options

    const applied = await page.evaluate(
      ({ serializedEvent }) => {
        const api = (globalThis as { __playwriterGhostCursor?: GhostCursorBrowserApi }).__playwriterGhostCursor
        if (!api) {
          return false
        }

        api.applyMouseAction(serializedEvent)
        return true
      },
      { serializedEvent: event },
    )

    if (applied) {
      return
    }

    await ensureGhostCursorInjected({ page })
    await page.evaluate(
      ({ serializedEvent }) => {
        const api = (globalThis as { __playwriterGhostCursor?: GhostCursorBrowserApi }).__playwriterGhostCursor
        api?.applyMouseAction(serializedEvent)
      },
      { serializedEvent: event },
    )
  } catch {
    // Swallow — page may be closed, navigating, or debugger detached.
  }
}
