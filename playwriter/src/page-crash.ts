/**
 * A tab whose renderer crashed, and getting the session going again without `reset`.
 *
 * Playwright marks a page's own CDP session crashed on `Inspector.targetCrashed` and refuses every
 * later command on it (`Target crashed`, `Page crashed`), for good: the Page object never works
 * again, even after Chrome reloads the renderer. Measured on Chromium 133 headless: after
 * `Page.crash`, `page.title()` → `Target crashed`, `page.goto()` → `Page crashed`; a CDP session
 * opened afterwards can `Page.navigate` the same target back to life, yet the Playwright Page still
 * answers `Target crashed`, and `act.*` types and scrolls through that Page. A working session
 * therefore needs a new Page, and a new Page needs a new tab: the crashed tab is replaced by a new
 * one in the same browser context (same cookies and storage), and the crashed one is closed.
 *
 * Nothing here touches a page: the crash is Playwright's `crash` event, the replacement is a
 * browser-level `Target.createTarget` / `Target.closeTarget` (context.newPage / page.close).
 */

import type { Page } from '@xmorse/playwright-core'
import { ModelFacingError } from './probe-types.js'

/** What is known of a crash: the page the tab showed, and when it went. */
export interface PageCrash {
  url: string
  at: number
}

const crashes = new WeakMap<Page, PageCrash>()
/** Replacement tab → the crash it replaced, so `act.reload()` there loads the page that crashed. */
const replacements = new WeakMap<Page, PageCrash>()
const watched = new WeakSet<Page>()

/** Record the page's renderer crash when Playwright reports it. Idempotent. */
export function watchForCrash(page: Page): void {
  if (watched.has(page)) return
  watched.add(page)
  page.on('crash', () => {
    // page.url() is Playwright's cached main-frame URL: it reads nothing from the dead renderer.
    crashes.set(page, { url: page.url(), at: Date.now() })
  })
}

/** The page's crash, or null while its renderer lives. A crashed Page never recovers. */
export function crashOf(page: Page): PageCrash | null {
  return crashes.get(page) ?? null
}

/** The crash a replacement tab stands in for, or null for any other tab. */
export function replacedCrashOf(page: Page): PageCrash | null {
  return replacements.get(page) ?? null
}

/** The report line for a crashed controlled tab. */
export function crashedLine(crash: PageCrash, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - crash.at) / 1000))
  return (
    `PAGE CRASHED — the tab's renderer crashed (it showed ${crash.url}, ${seconds === 0 ? 'just now' : `${seconds} s ago`}); nothing of ` +
    'that page can be read or acted on any more. act.open(url) or act.reload() reloads it.'
  )
}

const BROWSER_DEADLINE_MS = 10_000

async function browserStep<T>(work: Promise<T>, what: string): Promise<T> {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(
    () => expired.reject(new ModelFacingError(`The browser did not answer within ${BROWSER_DEADLINE_MS}ms while ${what}. Call the MCP reset tool.`)),
    BROWSER_DEADLINE_MS,
  )
  try {
    return await Promise.race([work, expired.promise])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Open a tab in the crashed tab's browser context, hand it to `adopt` (the caller's controlled
 * page from then on), and close the crashed one. Adopted first, so the close is that of a tab no
 * longer controlled, not a "controlled tab closed". The new tab starts on about:blank;
 * `act.reload()` there loads `crash.url`. Returns the line the report shows.
 */
export async function replaceCrashedPage(crashed: Page, crash: PageCrash, adopt: (replacement: Page) => void): Promise<string> {
  const replacement = await browserStep(crashed.context().newPage(), 'opening a tab to replace the crashed one')
  replacements.set(replacement, crash)
  adopt(replacement)
  const closed = await browserStep(crashed.close(), 'closing the crashed tab').then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message.split('\n')[0] : String(error)),
  )
  return (
    `PAGE RECOVERED — the crashed tab (it showed ${crash.url}) was replaced by a new tab in the same browser context: cookies and ` +
    "storage are kept; the crashed page's history and in-memory state are gone. " +
    (closed === null ? 'The crashed tab was closed.' : `The crashed tab could not be closed (${closed}); it is still among the tabs.`)
  )
}
