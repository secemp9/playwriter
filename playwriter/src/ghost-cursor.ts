/**
 * Node-side helpers for the LIVE in-page ghost cursor — an opt-in that MODIFIES THE PAGE.
 *
 * The overlay is a DOM element plus a `globalThis.__playwriterGhostCursor` API injected into
 * the page's main world. That is exactly what the page under test must never get by
 * default, so nothing injects it except an explicit `enableGhostCursor` (the sandbox's
 * `ghostCursor.show()`). Every other entry point here is a no-op on a page that was not
 * shown, and never touches it.
 *
 * Recordings do not need it: the CDP recorder draws the pointer into the video at encode
 * time from `pointer-track.ts`, which observes the dispatched positions without the page.
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
  isEnabled: () => boolean
  applyMouseAction: (event: MouseActionEvent) => void
  playPath: (options: { samples: GhostCursorPathSample[] }) => { playing: boolean; durationMs: number }
  cancelPath: () => void
  isPlayingPath: () => boolean
}

declare global {
  // The overlay's API in the page's main world. Exists only on a page `enableGhostCursor`
  // was called for; these declarations type the page-side callbacks below.
  var __playwriterGhostCursor: GhostCursorBrowserApi | undefined
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
 * Pages the caller explicitly asked to show the overlay on, with the options they asked
 * for. Presence is the opt-in; nothing else in this module may touch a page that is absent.
 */
const shownPages = new WeakMap<Page, GhostCursorClientOptions | undefined>()

export function isGhostCursorShown(page: Page): boolean {
  return shownPages.has(page)
}

/**
 * Inject (when the document has no overlay, or an older bundle without `requiredMethod`)
 * and enable it with the shown options. Only ever reached for a shown page: a hard
 * navigation replaces the document and takes the overlay with it, and because the caller
 * opted in until `hide()`, the next use re-creates it.
 */
async function reviveOverlay(page: Page, requiredMethod?: keyof GhostCursorBrowserApi): Promise<void> {
  const present = await page.evaluate((method) => {
    const api = globalThis.__playwriterGhostCursor
    return !!api && (!method || typeof api[method] === 'function')
  }, requiredMethod)
  if (!present) await page.evaluate(getGhostCursorCode())
  await page.evaluate((optionsFromNode) => {
    const api = globalThis.__playwriterGhostCursor
    if (!api) throw new Error('The ghost cursor bundle did not install __playwriterGhostCursor (not the top frame?).')
    api.enable(optionsFromNode)
  }, shownPages.get(page))
}

/**
 * Inject and show the live overlay. THIS MODIFIES THE PAGE (a DOM element and a main-world
 * global); it is the explicit opt-in behind `ghostCursor.show()`. Throws when the page
 * cannot take it (closed, restricted, mid-navigation) — a show that silently did nothing
 * would leave the caller believing the cursor is visible. Calling it again re-applies the
 * options, so it also changes the style of an overlay that is already up.
 */
export async function enableGhostCursor(options: {
  page: Page
  cursorOptions?: GhostCursorClientOptions
}): Promise<void> {
  const { page, cursorOptions } = options
  shownPages.set(page, cursorOptions)
  try {
    await reviveOverlay(page)
  } catch (error) {
    shownPages.delete(page)
    throw error
  }
}

/** Remove the overlay from a page it was shown on. A page never shown is not touched. */
export async function disableGhostCursor(options: { page: Page }): Promise<void> {
  const { page } = options
  if (!shownPages.delete(page)) return
  if (page.isClosed()) return
  await page.evaluate(() => {
    globalThis.__playwriterGhostCursor?.disable()
  })
}

/**
 * Hand a whole sampled trajectory to a SHOWN overlay in one round trip and let it play the
 * path against the page's rAF clock, so the drawn cursor and the real CDP pointer trace the
 * same curve. On a page the overlay was not shown on this returns `playing: false` without
 * touching the page.
 */
export async function playGhostCursorPath(options: {
  page: Page
  samples: GhostCursorPathSample[]
}): Promise<{ playing: boolean; durationMs: number }> {
  const { page, samples } = options
  if (!shownPages.has(page) || samples.length < 2) {
    return { playing: false, durationMs: 0 }
  }
  try {
    const play = () =>
      page.evaluate((pathSamples) => {
        const api = globalThis.__playwriterGhostCursor
        if (!api || typeof api.playPath !== 'function' || !api.isEnabled()) return null
        return api.playPath({ samples: pathSamples })
      }, samples)
    const played = await play()
    if (played) return played
    await reviveOverlay(page, 'playPath')
    return (await play()) ?? { playing: false, durationMs: 0 }
  } catch {
    // The overlay is cosmetic — a closed or navigating page must not fail the move. The
    // result reports that it did not play.
    return { playing: false, durationMs: 0 }
  }
}

/** Stop any in-flight path playback on a shown overlay. A page never shown is not touched. */
export async function cancelGhostCursorPath(options: { page: Page }): Promise<void> {
  const { page } = options
  if (!shownPages.has(page) || page.isClosed()) return
  await page.evaluate(() => {
    globalThis.__playwriterGhostCursor?.cancelPath()
  })
}

/**
 * Forward one Playwright mouse action to a shown overlay. A page never shown is not
 * touched. Throws on failure; the caller decides whether a cosmetic failure matters.
 */
export async function applyGhostCursorMouseAction(options: { page: Page; event: MouseActionEvent }): Promise<void> {
  const { page, event } = options
  if (!shownPages.has(page)) return
  const apply = () =>
    page.evaluate((serializedEvent) => {
      const api = globalThis.__playwriterGhostCursor
      if (!api?.isEnabled()) return false
      api.applyMouseAction(serializedEvent)
      return true
    }, event)
  if (await apply()) return
  await reviveOverlay(page)
  await apply()
}
