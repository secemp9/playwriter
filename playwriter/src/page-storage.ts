/**
 * page-storage.ts — the sandbox's cookie, Web Storage, saved-state and clipboard globals:
 * `cookies`, `storage`, `saveState` (reads, allowed in human mode), `setCookies`, `clearCookies`,
 * `setStorage`, `clearStorage`, `loadState` (writes: debug mode only) and `clipboard.read()`.
 *
 * Why not Playwright's `context.cookies()` / `storageState()`: they send `Storage.getCookies` on
 * the browser session, which the extension relay cannot route ("No tab found for method
 * Storage.getCookies"), and `storageState()` runs Playwright's script in every page and opens a
 * tab for each other origin. Here everything goes through the tab's own session:
 *
 *  - cookies: `Network.getCookies` (the cookies the page and its frames send) and, for a saved
 *    state or a write's read-back, `Network.getAllCookies` on the tab's session (every path of the
 *    page's hosts). Measured on Chromium 133, 145 and Chrome 149: on a tab of a non-default browser context (a
 *    new browser's session), `Network.getAllCookies` answers with that context's cookies while
 *    `Storage.getCookies` on the same session answers with the default context's (empty). Both
 *    are answered by the browser process, so they work while a JS dialog freezes the page.
 *  - Web Storage: read and written in playwriter's isolated world of the frame (isolated-world.ts):
 *    same storage as the page, none of the page's globals, no event in the page for a read.
 *  - first-party or partitioned: `Storage.getStorageKeyForFrame` — a cross-site iframe's storage
 *    is keyed under the top-level site, and Playwright's state format has no place for it. (Its
 *    successor `Storage.getStorageKey({ frameId })` is missing from Chromium 133, a build a new
 *    browser may launch: measured "'Storage.getStorageKey' wasn't found".)
 *  - clipboard: never through the page under test. Through the extension, its offscreen document
 *    pastes the clipboard into its own textarea (`clipboardRead` permission); in a browser
 *    playwriter launched (or reached over direct CDP), a private browser context of its own, on an
 *    origin served from memory, is granted `clipboard-read` and reads it. Granting the permission
 *    to the page's own origin instead was measured to be visible to the page
 *    (`PermissionStatus.onchange` fired 'granted', then 'prompt').
 */

import type { Browser, Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import { z } from 'zod'
import type { ICDPSession } from './cdp-session.js'
import { getCDPSessionForPage } from './cdp-session.js'
import { ActError } from './human-actions.js'
import { withDeadline } from './isolated-world.js'
import type { FrameEntry, FrameHandle, UnreadableFrame } from './page-frames.js'
import type { PageProbe, PageProbes } from './page-probe.js'
import { ModelFacingError, type PolicyMode } from './probe-types.js'
import type { ScopedFS } from './scoped-fs.js'

declare module 'devtools-protocol/types/protocol-mapping.js' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ProtocolMapping {
    interface Commands {
      /**
       * Not a Chrome command: the relay answers it by asking the extension to read the clipboard's
       * text in its offscreen document (cdp-relay.ts). `undefined` comes back from an extension
       * that predates it.
       */
      'Playwriter.readClipboard': { paramsType: []; returnType: { text?: string } | undefined }
    }
  }
}

const CDP_TIMEOUT_MS = 5000
/** The extension may first have to create its offscreen document. */
const CLIPBOARD_TIMEOUT_MS = 10_000
/** A private browser context, one page, a navigation served from memory and the read. */
const PRIVATE_READ_TIMEOUT_MS = 15_000
/** The origin of the private clipboard-reader page: `.invalid` never resolves, the page is served by a route of that page only. */
const CLIPBOARD_READER_ORIGIN = 'https://playwriter-clipboard.invalid'

// ---- argument and file shapes ---------------------------------------------------------

const PageArg = z.custom<Page>(
  (value) => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'isClosed') === 'function' && typeof Reflect.get(value, 'mainFrame') === 'function',
  { message: "must be a Page (the sandbox's `page`, or a tab from context.pages())" },
)
const HttpUrl = z.string().refine((url) => URL.canParse(url) && /^(https?|wss?):$/.test(new URL(url).protocol), {
  message: "must be an absolute http(s) URL, like 'https://example.com/account' (cookies belong to http(s) addresses)",
})
const Urls = z.union([HttpUrl, z.array(HttpUrl).nonempty()])
const StorageKind = z.enum(['local', 'session'], { message: "must be 'local' (localStorage) or 'session' (sessionStorage)" })
const FrameArg = z.string().min(1, { message: "must be a part of the iframe's address or its name, like 'checkout.example.com'" })
const SameSite = z.enum(['Strict', 'Lax', 'None'])

const CookiesOptions = z.strictObject({ urls: Urls.optional(), values: z.boolean().optional(), page: PageArg.optional() })
const StorageOptions = z.strictObject({ kind: StorageKind.optional(), frame: FrameArg.optional(), page: PageArg.optional() })
const FrameOptions = z.strictObject({ frame: FrameArg.optional(), page: PageArg.optional() })
const Entries = z.record(z.string(), z.string({ message: 'must be a string (Web Storage keeps strings only)' }), { message: "must be an object of string values, like { theme: 'dark' }" }).refine(
  (entries) => Object.keys(entries).length > 0,
  { message: 'has no entries' },
)
const SetStorageOptions = z.strictObject({ kind: StorageKind, entries: Entries, frame: FrameArg.optional(), page: PageArg.optional() })
const ClearStorageOptions = z.strictObject({ kind: StorageKind, frame: FrameArg.optional(), page: PageArg.optional() })
const CookieInput = z.strictObject({
  name: z.string().min(1),
  value: z.string(),
  url: HttpUrl.optional(),
  domain: z.string().min(1).optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: SameSite.optional(),
})
const CookiesInput = z.union([z.string().min(1), CookieInput, z.array(CookieInput).nonempty()])
const SetCookiesOptions = z.strictObject({ url: HttpUrl.optional(), page: PageArg.optional() })
const ClearCookiesOptions = z.strictObject({ names: z.array(z.string()).nonempty().optional(), urls: Urls.optional(), page: PageArg.optional() })
const PathTarget = z.union([z.string().min(1), z.strictObject({ path: z.string().min(1), page: PageArg.optional() })])

/** One cookie of Playwright's storage-state format (`context.storageState()`). */
const StateCookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  /** Unix seconds; -1 for a session cookie. */
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: SameSite,
  partitionKey: z.string().optional(),
  _crHasCrossSiteAncestor: z.boolean().optional(),
})
type StateCookie = z.infer<typeof StateCookie>

/** Playwright's storage-state format, as `context.storageState()` writes it and `newContext({ storageState })` reads it. */
const StorageState = z.object({
  cookies: z.array(StateCookie),
  origins: z.array(z.object({ origin: z.string(), localStorage: z.array(z.object({ name: z.string(), value: z.string() })) })),
})
export type StorageState = z.infer<typeof StorageState>

/** `value` checked against `schema`; a mismatch is an ActError naming each problem and the right form. */
function parseArg<T>(call: string, schema: z.ZodType<T>, value: unknown, usage: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const problems = result.error.issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') return `unknown option${issue.keys.length > 1 ? 's' : ''} ${issue.keys.map((key) => `'${key}'`).join(', ')}`
    // Messages written here start lowercase ("must be …"); zod's own ("Invalid input: …") follow a colon.
    const subject = issue.path.length > 0 ? `'${issue.path.join('.')}'` : 'the argument'
    return /^[a-z]/.test(issue.message) ? `${subject} ${issue.message}` : `${subject}: ${issue.message}`
  })
  throw new ActError(`${call}: ${problems.join('; ')}. ${usage}`)
}

// ---- the public shapes ----------------------------------------------------------------

/** A cookie as `cookies()` returns it. `value` is `<N chars>` unless `cookies({ values: true })`. */
export interface CookieView {
  name: string
  value: string
  domain: string
  path: string
  /** ISO date, or 'session' (deleted when the browser session ends). */
  expires: string
  httpOnly: boolean
  secure: boolean
  /** The attribute as set; unset means Chrome treats the cookie as Lax. */
  sameSite: 'Strict' | 'Lax' | 'None' | 'unset (Chrome treats it as Lax)'
  /** Set for a partitioned (CHIPS) cookie: the top-level site it is kept under. */
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }
}

/** What `storage()` returns: the frame's document, its origin, and the area(s) asked for, keys sorted. */
export interface StorageView {
  origin: string
  url: string
  local?: Record<string, string>
  session?: Record<string, string>
}

export interface StorageGlobalsDeps {
  policy: () => PolicyMode
  currentPage: () => Page
  probes: PageProbes
  fs: ScopedFS
  /** The browser playwriter drives; null for a persistent context, which has no Browser object. */
  browser: () => Browser | null
  /** True when the browser is the user's Chrome through the extension and relay. */
  viaExtension: boolean
  /** Runs playwriter's own Playwright calls (the private clipboard reader) so they are not counted as the code's raw actions. */
  ownCalls: <T>(work: () => Promise<T>) => Promise<T>
}

export interface StorageGlobals {
  cookies: (options?: unknown) => Promise<CookieView[]>
  storage: (kindOrOptions?: unknown, options?: unknown) => Promise<StorageView>
  saveState: (target?: unknown) => Promise<object>
  loadState: (target?: unknown) => Promise<object>
  setCookies: (cookies?: unknown, options?: unknown) => Promise<object>
  clearCookies: (options?: unknown) => Promise<object>
  setStorage: (kindOrOptions?: unknown, entries?: unknown, options?: unknown) => Promise<StorageView>
  clearStorage: (kindOrOptions?: unknown, options?: unknown) => Promise<StorageView>
  clipboard: { read: () => Promise<string> }
}

function livePage(call: string, page: Page | undefined, fallback: () => Page): Page {
  const target = page ?? fallback()
  if (target.isClosed()) throw new ActError(`${call}: that page is closed. Use the sandbox's \`page\` (the tab you are working in).`)
  return target
}

function refuseInHumanMode(deps: StorageGlobalsDeps, call: string, what: string, read: string): void {
  if (deps.policy() !== 'human') return
  throw new ActError(
    `Refused (human mode): ${call} ${what}: forged state the page never made, so what the page does next is not ` +
      `something a user can reach. ${read} Change it the way a user would, through the page (act.* with refs from ` +
      'observe()). Writing it directly needs debug mode (ask the user). It was not run.',
  )
}

// ---- cookies --------------------------------------------------------------------------

/** RFC 6265 §5.1.3: whether `host` domain-matches a cookie's domain (a leading dot marks a domain cookie). */
function domainMatches(host: string, cookieDomain: string): boolean {
  const domain = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain
  return host === domain || (cookieDomain.startsWith('.') && host.endsWith(`.${domain}`))
}

/** Cookies applicable to `urls`, or (none given) to the page and all its frames — what they send. */
async function pageCookies(cdp: ICDPSession, urls: string[] | undefined): Promise<Protocol.Network.Cookie[]> {
  const { cookies } = await withDeadline(cdp.send('Network.getCookies', urls ? { urls } : {}), CDP_TIMEOUT_MS, 'reading cookies (Network.getCookies)')
  return cookies
}

/**
 * Set `params` and read them back: Chrome drops a cookie it will not store (a Secure cookie for an
 * http page, SameSite=None without Secure, a domain the URL is not in) without an error.
 */
async function setAndVerify(cdp: ICDPSession, params: Protocol.Network.CookieParam[]): Promise<{ stored: string[]; dropped: string[] }> {
  await withDeadline(cdp.send('Network.setCookies', { cookies: params }), CDP_TIMEOUT_MS, 'writing cookies (Network.setCookies)')
  const { cookies } = await withDeadline(cdp.send('Network.getAllCookies'), CDP_TIMEOUT_MS, 'reading the cookies back (Network.getAllCookies)')
  const stored: string[] = []
  const dropped: string[] = []
  for (const param of params) {
    const host = param.url ? new URL(param.url).hostname : (param.domain ?? '')
    const found = cookies.some(
      (cookie) =>
        cookie.name === param.name &&
        cookie.value === param.value &&
        (param.domain ? cookie.domain.replace(/^\./, '') === param.domain.replace(/^\./, '') : domainMatches(host, cookie.domain)) &&
        (param.path === undefined || cookie.path === param.path),
    )
    const label = `${param.name} (${param.domain ?? param.url}${param.path ? ` path ${param.path}` : ''})`
    ;(found ? stored : dropped).push(label)
  }
  return { stored, dropped }
}

const DROPPED_HINT =
  'Chrome refuses a cookie without an error when it breaks a cookie rule: Secure on an http page, SameSite=None without Secure, ' +
  'a domain the URL is not under, an expiry in the past, or a __Host-/__Secure- prefix without Secure (and Path=/ for __Host-).'

// ---- frames and Web Storage ------------------------------------------------------------

function dialogGuard(probe: PageProbe, call: string): void {
  const dialog = probe.dialogs.current()
  if (!dialog) return
  throw new ActError(
    `${call}: a ${dialog.type} dialog ("${dialog.message}") is open on this tab, and the page's JavaScript is frozen until it is answered, ` +
      "so the page's storage cannot be reached. Answer it first with act.dialog.accept() or act.dialog.dismiss(), then call again.",
  )
}

function describeFrame(frame: { url: string; name: string }): string {
  return `${frame.url || '(no address)'}${frame.name ? ` (name "${frame.name}")` : ''}`
}

/** The frame `frame` names (frame id, exact name, or a part of its address), or the main frame. */
async function frameNamed(probe: PageProbe, call: string, frame: string | undefined): Promise<FrameHandle> {
  if (frame === undefined) return probe.frames.main
  const { frames, unreadable } = await probe.frames.list()
  const matches = (entry: { frameId: string; url: string; name: string }): boolean => entry.frameId === frame || entry.name === frame || entry.url.includes(frame)
  const found = frames.filter(matches)
  if (found.length === 1) return found[0]
  if (found.length > 1) {
    throw new ActError(`${call}: { frame: '${frame}' } matches ${found.length} frames: ${found.map(describeFrame).join('; ')}. Give a longer part of the address, or the frame's name.`)
  }
  const sealed = unreadable.find(matches)
  if (sealed) throw new ActError(`${call}: the frame ${describeFrame(sealed)} cannot be read: ${sealed.reason}.`)
  throw new ActError(
    `${call}: no frame of this tab matches { frame: '${frame}' }. Its frames: ${frames.map(describeFrame).join('; ')}` +
      `${unreadable.length > 0 ? `; unreadable: ${unreadable.map((entry) => `${describeFrame(entry)} — ${entry.reason}`).join('; ')}` : ''}.`,
  )
}

interface AreaRead {
  entries?: Record<string, string>
  error?: string
}

interface WorldStorage {
  origin: string
  url: string
  local?: AreaRead
  session?: AreaRead
}

interface StorageWrite {
  area: 'localStorage' | 'sessionStorage'
  clear: boolean
  set: Array<[string, string]>
}

/**
 * Runs in playwriter's isolated world of the frame: optionally writes (`set`, after `clear`), then
 * reads the areas asked for, keys sorted (a write always reads its own area back). A document
 * without storage access (an opaque origin, a blocked third-party frame) throws SecurityError on
 * `localStorage`: the write is skipped and the read reports it for that area.
 */
const STORAGE_FN = `(args) => {
  const read = (name) => {
    let area
    try { area = window[name] } catch (error) { return { error: String((error && error.message) || error) } }
    if (!area) return { error: name + ' is not available in this document' }
    const keys = []
    for (let i = 0; i < area.length; i++) keys.push(area.key(i))
    keys.sort()
    const entries = {}
    for (const key of keys) entries[key] = area.getItem(key)
    return { entries }
  }
  if (args.write) {
    let area = null
    try { area = window[args.write.area] } catch {}
    if (area) {
      if (args.write.clear) area.clear()
      for (const [key, value] of args.write.set) area.setItem(key, value)
    }
  }
  // self.origin is the document's security origin ('null' when opaque); location.origin is only its URL's.
  const result = { origin: self.origin, url: location.href }
  if (args.local) result.local = read('localStorage')
  if (args.session) result.session = read('sessionStorage')
  return result
}`

/** A Web Storage area the frame's document cannot use; `detail` says which and why, for a report line. */
class StorageAreaError extends ActError {
  readonly detail: string

  constructor(call: string, detail: string) {
    super(`${call}: ${detail}`)
    this.name = 'StorageAreaError'
    this.detail = detail
  }
}

/** Read (and with `write`, first change) the frame's Web Storage in playwriter's isolated world; an area the document cannot use is a StorageAreaError. */
async function worldStorage(call: string, frame: FrameHandle, args: { local: boolean; session: boolean; write?: StorageWrite }): Promise<StorageView> {
  const read = await frame.world.evaluate<WorldStorage>(`(${STORAGE_FN})(${JSON.stringify(args)})`, {
    what: args.write ? `writing ${args.write.area} of frame ${frame.frameId}` : `reading the Web Storage of frame ${frame.frameId}`,
  })
  const view: StorageView = { origin: read.origin, url: read.url }
  for (const kind of ['local', 'session'] as const) {
    const area = read[kind]
    if (!area) continue
    if (area.error !== undefined) {
      throw new StorageAreaError(
        call,
        `${kind}Storage of ${read.url} cannot be used: ${area.error}` +
          (read.origin === 'null' ? ' — the document has an opaque origin (a sandboxed iframe or a data: URL), which has no Web Storage.' : '') +
          (/Access is denied/.test(area.error)
            ? " — Chrome denies this document storage access; it does so for a cross-site iframe when third-party cookies are blocked (Incognito, and a new browser's private context)."
            : ''),
      )
    }
    view[kind] = area.entries ?? {}
  }
  return view
}

/** The tab's readable frames with first-party storage (one per origin), and what was left out and why. */
async function firstPartyFrames(probe: PageProbe): Promise<{ frames: FrameEntry[]; leftOut: string[]; unreadable: UnreadableFrame[] }> {
  const { frames, unreadable } = await probe.frames.list()
  const byOrigin = new Map<string, FrameEntry>()
  const leftOut: string[] = []
  for (const entry of frames) {
    if (!URL.canParse(entry.url) || !/^https?:$/.test(new URL(entry.url).protocol)) continue
    const origin = new URL(entry.url).origin
    if (byOrigin.has(origin)) continue
    // Equal to `origin/` for first-party storage; a partitioned key appends the top-level site.
    const { storageKey } = await withDeadline(
      entry.cdp.send('Storage.getStorageKeyForFrame', { frameId: entry.frameId }),
      CDP_TIMEOUT_MS,
      `reading the storage key of frame ${entry.frameId} (Storage.getStorageKeyForFrame)`,
    )
    if (storageKey !== `${origin}/`) {
      leftOut.push(
        `localStorage of ${entry.url}: it is partitioned (storage key ${storageKey}: a cross-site iframe's storage is kept under the ` +
          'top-level site), and the state format has one storage per origin',
      )
      continue
    }
    byOrigin.set(origin, entry)
  }
  return { frames: [...byOrigin.values()], leftOut, unreadable }
}

function isHttp(url: string): boolean {
  return URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)
}

// ---- the globals ----------------------------------------------------------------------

export function createStorageGlobals(deps: StorageGlobalsDeps): StorageGlobals {
  const cookies = async (options?: unknown): Promise<CookieView[]> => {
    const usage = "Use cookies(), cookies({ urls: ['https://example.com/'] }) or cookies({ values: true })."
    const parsed = parseArg('cookies', CookiesOptions, typeof options === 'string' || Array.isArray(options) ? { urls: options } : (options ?? {}), usage)
    const probe = await deps.probes.get(livePage('cookies', parsed.page, deps.currentPage))
    const found = await pageCookies(probe.cdp, parsed.urls === undefined ? undefined : [parsed.urls].flat())
    return found.map((cookie) => {
      const view: CookieView = {
        name: cookie.name,
        value: parsed.values === true ? cookie.value : `<${cookie.value.length} chars>`,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.session ? 'session' : new Date(cookie.expires * 1000).toISOString(),
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite ?? 'unset (Chrome treats it as Lax)',
      }
      if (cookie.partitionKey) view.partitionKey = { topLevelSite: cookie.partitionKey.topLevelSite, hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor }
      return view
    })
  }

  const storage = async (kindOrOptions?: unknown, options?: unknown): Promise<StorageView> => {
    const usage = "Use storage() for both areas, storage('local'), storage('session'), or storage('local', { frame: 'part of the iframe address' })."
    const parsed =
      typeof kindOrOptions === 'string'
        ? { kind: parseArg('storage', StorageKind, kindOrOptions, usage), ...parseArg('storage', FrameOptions, options ?? {}, usage) }
        : parseArg('storage', StorageOptions, kindOrOptions ?? {}, usage)
    const probe = await deps.probes.get(livePage('storage', parsed.page, deps.currentPage))
    dialogGuard(probe, 'storage')
    const frame = await frameNamed(probe, 'storage', parsed.frame)
    return await worldStorage('storage', frame, { local: parsed.kind !== 'session', session: parsed.kind !== 'local' })
  }

  /** setStorage / clearStorage: one area of one frame, changed in playwriter's isolated world, then read back. */
  const writeStorage = async (call: string, target: { kind: 'local' | 'session'; frame?: string; page?: Page }, clear: boolean, entries: Record<string, string>): Promise<StorageView> => {
    const probe = await deps.probes.get(livePage(call, target.page, deps.currentPage))
    dialogGuard(probe, call)
    const frame = await frameNamed(probe, call, target.frame)
    const area = target.kind === 'local' ? 'localStorage' : 'sessionStorage'
    return await worldStorage(call, frame, { local: target.kind === 'local', session: target.kind === 'session', write: { area, clear, set: Object.entries(entries) } })
  }

  const setStorage = async (kindOrOptions?: unknown, entries?: unknown, options?: unknown): Promise<StorageView> => {
    const usage = "Use setStorage('local', { key: 'value' }) or setStorage('session', { key: 'value' }, { frame: 'part of the iframe address' })."
    refuseInHumanMode(deps, 'setStorage()', 'writes Web Storage directly', 'storage() reads it.')
    const parsed =
      typeof kindOrOptions === 'string'
        ? { kind: parseArg('setStorage', StorageKind, kindOrOptions, usage), entries: parseArg('setStorage', Entries, entries, usage), ...parseArg('setStorage', FrameOptions, options ?? {}, usage) }
        : parseArg('setStorage', SetStorageOptions, kindOrOptions, usage)
    return await writeStorage('setStorage', parsed, false, parsed.entries)
  }

  const clearStorage = async (kindOrOptions?: unknown, options?: unknown): Promise<StorageView> => {
    const usage = "Use clearStorage('local') or clearStorage('session', { frame: 'part of the iframe address' })."
    refuseInHumanMode(deps, 'clearStorage()', 'empties Web Storage directly', 'storage() reads it.')
    const parsed =
      typeof kindOrOptions === 'string'
        ? { kind: parseArg('clearStorage', StorageKind, kindOrOptions, usage), ...parseArg('clearStorage', FrameOptions, options ?? {}, usage) }
        : parseArg('clearStorage', ClearStorageOptions, kindOrOptions, usage)
    return await writeStorage('clearStorage', parsed, true, {})
  }

  const setCookies = async (input?: unknown, options?: unknown): Promise<object> => {
    const usage =
      "Use setCookies('theme=dark; lang=en') or setCookies([{ name: 'theme', value: 'dark' }]); objects take name, value, and optionally " +
      "url or domain + path, expires (Unix seconds), httpOnly, secure, sameSite; { url: 'https://example.com/' } as the second argument sets the address."
    refuseInHumanMode(deps, 'setCookies()', 'writes cookies directly', 'cookies() reads them.')
    const cookiesIn = parseArg('setCookies', CookiesInput, input, usage)
    const parsed = parseArg('setCookies', SetCookiesOptions, options ?? {}, usage)
    const page = livePage('setCookies', parsed.page, deps.currentPage)
    const url = parsed.url ?? page.url()
    const params: Protocol.Network.CookieParam[] = []
    if (typeof cookiesIn === 'string') {
      for (const pair of cookiesIn.split(';').map((part) => part.trim()).filter((part) => part.length > 0)) {
        const eq = pair.indexOf('=')
        if (eq <= 0) throw new ActError(`setCookies: '${pair}' is not name=value. ${usage}`)
        params.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url })
      }
    } else {
      for (const cookie of [cookiesIn].flat()) params.push({ ...cookie, ...(cookie.domain === undefined ? { url: cookie.url ?? url } : {}) })
    }
    if (params.some((param) => param.url !== undefined && !isHttp(param.url))) {
      throw new ActError(`setCookies: the page is at ${page.url() || 'about:blank'}, which has no cookies. Open an http(s) page first, or pass { url: 'https://example.com/' }.`)
    }
    const probe = await deps.probes.get(page)
    const { stored, dropped } = await setAndVerify(probe.cdp, params)
    if (dropped.length > 0) {
      throw new ActError(`setCookies: Chrome did not store ${dropped.join(', ')}${stored.length > 0 ? ` (stored: ${stored.join(', ')})` : ''}. ${DROPPED_HINT}`)
    }
    return { stored, note: 'The page reads them on its next request or document.cookie read; it was not reloaded.' }
  }

  const clearCookies = async (options?: unknown): Promise<object> => {
    const usage = "Use clearCookies(), clearCookies({ names: ['session'] }) or clearCookies({ urls: ['https://example.com/'] })."
    refuseInHumanMode(deps, 'clearCookies()', 'deletes cookies directly', 'cookies() reads them.')
    const parsed = parseArg('clearCookies', ClearCookiesOptions, options ?? {}, usage)
    const urls = parsed.urls === undefined ? undefined : [parsed.urls].flat()
    const probe = await deps.probes.get(livePage('clearCookies', parsed.page, deps.currentPage))
    const targets = (await pageCookies(probe.cdp, urls)).filter((cookie) => !parsed.names || parsed.names.includes(cookie.name))
    for (const cookie of targets) {
      await withDeadline(
        probe.cdp.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path, ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}) }),
        CDP_TIMEOUT_MS,
        `deleting cookie ${cookie.name} (Network.deleteCookies)`,
      )
    }
    const describe = (cookie: Protocol.Network.Cookie): string => `${cookie.name} (${cookie.domain} path ${cookie.path})`
    const left = (await pageCookies(probe.cdp, urls)).filter((cookie) => targets.some((target) => describe(target) === describe(cookie)))
    if (left.length > 0) throw new ActError(`clearCookies: Chrome kept ${left.map(describe).join(', ')} after deleting it.`)
    const missing = parsed.names?.filter((name) => !targets.some((cookie) => cookie.name === name)) ?? []
    return {
      deleted: targets.map(describe),
      ...(missing.length > 0 ? { notFound: missing.map((name) => `${name}: this page${urls ? ' (or those URLs)' : ''} sends no cookie of that name`) } : {}),
      note: 'The page reads the change on its next request or document.cookie read; it was not reloaded.',
    }
  }

  const saveState = async (target?: unknown): Promise<object> => {
    const usage = "Use saveState({ path: 'state.json' })."
    const parsed = parseArg('saveState', PathTarget, target, usage)
    const { path, page: pageArg } = typeof parsed === 'string' ? { path: parsed, page: undefined } : parsed
    const resolved = deps.fs.resolveAllowed(path)
    if (resolved === null) throw new ActError(`saveState: ${path} is outside the directories the sandbox may write (${deps.fs.allowedDirectories().join(', ')}). Pass a path inside one of them.`)
    const page = livePage('saveState', pageArg, deps.currentPage)
    const probe = await deps.probes.get(page)
    dialogGuard(probe, 'saveState')
    const { frames, leftOut, unreadable } = await firstPartyFrames(probe)
    const hosts = new Set<string>()
    for (const url of [page.url(), ...frames.map((entry) => entry.url), ...unreadable.map((entry) => entry.url)]) {
      if (isHttp(url)) hosts.add(new URL(url).hostname)
    }
    // Every path of the page's hosts, in the tab's own browser context (Network.getCookies only gives the paths of the current URLs).
    const { cookies: all } = await withDeadline(probe.cdp.send('Network.getAllCookies'), CDP_TIMEOUT_MS, "reading the browser context's cookies (Network.getAllCookies)")
    const state: StorageState = {
      cookies: all
        .filter((cookie) => [...hosts].some((host) => domainMatches(host, cookie.domain)))
        .map((cookie) => {
          const saved: StateCookie = {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.session ? -1 : cookie.expires,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            // The format requires one of the three; Chrome treats an unset SameSite as Lax, and Playwright saves it so.
            sameSite: cookie.sameSite ?? 'Lax',
          }
          if (cookie.partitionKey) {
            saved.partitionKey = cookie.partitionKey.topLevelSite
            saved._crHasCrossSiteAncestor = cookie.partitionKey.hasCrossSiteAncestor
          }
          return saved
        }),
      origins: [],
    }
    for (const entry of frames) {
      try {
        const read = await worldStorage('saveState', entry, { local: true, session: false })
        const items = Object.entries(read.local ?? {}).map(([name, value]) => ({ name, value }))
        if (items.length > 0) state.origins.push({ origin: read.origin, localStorage: items })
      } catch (error) {
        if (!(error instanceof StorageAreaError)) throw error
        leftOut.push(error.detail)
      }
    }
    for (const entry of unreadable) leftOut.push(`localStorage of ${describeFrame(entry)}: ${entry.reason}`)
    leftOut.push("sessionStorage (the storage-state format has no place for it; storage('session') reads it)")
    deps.fs.writeFileSync(resolved, `${JSON.stringify(state, null, 2)}\n`)
    return {
      path: resolved,
      cookies: state.cookies.map((cookie) => `${cookie.name} (${cookie.domain} path ${cookie.path})`),
      origins: state.origins.map((origin) => `${origin.origin}: ${origin.localStorage.length} localStorage key(s)`),
      leftOut,
      note: "Playwright's storage-state format: loadState(path) here (debug mode), or browser.newContext({ storageState: path }) in Playwright. It holds credentials in clear text.",
    }
  }

  const loadState = async (target?: unknown): Promise<object> => {
    const usage = "Use loadState('state.json') or loadState({ path: 'state.json' })."
    refuseInHumanMode(deps, 'loadState()', 'writes cookies and localStorage from a file', 'cookies() and storage() read them; saveState({ path }) saves them.')
    const parsed = parseArg('loadState', PathTarget, target, usage)
    const { path, page: pageArg } = typeof parsed === 'string' ? { path: parsed, page: undefined } : parsed
    const resolved = deps.fs.resolveAllowed(path)
    if (resolved === null) throw new ActError(`loadState: ${path} is outside the directories the sandbox may read (${deps.fs.allowedDirectories().join(', ')}).`)
    let raw: unknown
    try {
      raw = JSON.parse(String(deps.fs.readFileSync(resolved, 'utf8')))
    } catch (error) {
      throw new ActError(`loadState: cannot read ${resolved} as JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const state = parseArg(`loadState(${resolved})`, StorageState, raw, "The file must be Playwright's storage-state format ({ cookies: [...], origins: [...] }), as saveState or context.storageState() writes it.")
    const probe = await deps.probes.get(livePage('loadState', pageArg, deps.currentPage))
    dialogGuard(probe, 'loadState')
    const params = state.cookies.map((cookie): Protocol.Network.CookieParam => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      // As Playwright loads its own files: a missing _crHasCrossSiteAncestor counts as true.
      ...(cookie.partitionKey ? { partitionKey: { topLevelSite: cookie.partitionKey, hasCrossSiteAncestor: cookie._crHasCrossSiteAncestor ?? true } } : {}),
    }))
    const { stored, dropped } = params.length > 0 ? await setAndVerify(probe.cdp, params) : { stored: [], dropped: [] }
    const { frames } = await firstPartyFrames(probe)
    const loaded: string[] = []
    const notLoaded: string[] = []
    for (const origin of state.origins) {
      const frame = frames.find((entry) => new URL(entry.url).origin === origin.origin)
      if (!frame) {
        notLoaded.push(`${origin.origin}: no frame of this tab shows that origin with first-party storage — open a page of it (act.open) and call loadState again`)
        continue
      }
      const entries = Object.fromEntries(origin.localStorage.map((item) => [item.name, item.value]))
      try {
        await worldStorage('loadState', frame, { local: true, session: false, write: { area: 'localStorage', clear: false, set: Object.entries(entries) } })
      } catch (error) {
        if (!(error instanceof StorageAreaError)) throw error
        notLoaded.push(`${origin.origin}: ${error.detail}`)
        continue
      }
      loaded.push(`${origin.origin}: ${origin.localStorage.length} localStorage key(s)`)
    }
    return {
      cookies: stored,
      ...(dropped.length > 0 ? { cookiesRefused: dropped, cookieRule: DROPPED_HINT } : {}),
      origins: loaded,
      ...(notLoaded.length > 0 ? { notLoaded } : {}),
      note: 'Merged into what was there (nothing was cleared). The page has not re-read them: it sends cookies on its next request and reads localStorage when its code next does — reload to start from them.',
    }
  }

  const readViaExtension = async (): Promise<string> => {
    const cdp = await getCDPSessionForPage({ page: deps.currentPage() })
    let answer: { text?: string } | undefined
    try {
      answer = await withDeadline(cdp.send('Playwriter.readClipboard'), CLIPBOARD_TIMEOUT_MS, 'reading the clipboard through the Playwriter extension')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/wasn't found/.test(message)) {
        throw new ModelFacingError(
          'clipboard.read(): the relay this session is connected to predates clipboard reads (it passed the request to Chrome as an unknown command). ' +
            'Restart the relay with this playwriter version, then call again.',
        )
      }
      if (/clipboardRead permission/.test(message)) {
        throw new ModelFacingError(
          'clipboard.read(): the Playwriter extension has no clipboardRead permission (its manifest predates clipboard reads). Update or reload the ' +
            'extension (chrome://extensions → Playwriter) and accept "Read data you copy and paste" if Chrome asks, then call again.',
        )
      }
      throw error
    }
    if (typeof answer?.text !== 'string') {
      throw new ModelFacingError(
        'clipboard.read(): the Playwriter extension connected to the relay predates clipboard reads (it did not answer the request). ' +
          'Update or reload the extension (chrome://extensions → Playwriter), then call again.',
      )
    }
    return answer.text
  }

  const readViaPrivateContext = async (): Promise<string> => {
    const browser = deps.browser()
    if (!browser) {
      throw new ModelFacingError(
        'clipboard.read(): this browser was opened as a persistent context, which gives playwriter no Browser to open a private reader ' +
          'context in, so the clipboard cannot be read without involving the page under test.',
      )
    }
    return await deps.ownCalls(async () => {
      const reader = await browser.newContext()
      try {
        await reader.grantPermissions(['clipboard-read'], { origin: CLIPBOARD_READER_ORIGIN })
        const page = await reader.newPage()
        await page.route(`${CLIPBOARD_READER_ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>playwriter clipboard reader</title>' }))
        await page.goto(`${CLIPBOARD_READER_ORIGIN}/`)
        // A string expression: this package has no DOM types. Playwright awaits the promise it makes.
        const text: unknown = await page.evaluate('navigator.clipboard.readText()')
        if (typeof text !== 'string') throw new ModelFacingError(`clipboard.read(): Chrome's clipboard read returned ${typeof text}, not text.`)
        return text
      } finally {
        await reader.close()
      }
    })
  }

  const clipboard = {
    /**
     * The clipboard's text now ('' when it holds no text). Read on this call only, never written, and
     * never through the page under test (see the file comment).
     */
    read: async (): Promise<string> =>
      deps.viaExtension
        ? await readViaExtension()
        : await withDeadline(readViaPrivateContext(), PRIVATE_READ_TIMEOUT_MS, 'reading the clipboard in a private browser context'),
  }

  return { cookies, storage, saveState, loadState, setCookies, clearCookies, setStorage, clearStorage, clipboard }
}
