/**
 * chrome-identity.ts — how a Chrome binary presents itself to pages when a person runs it, read from
 * the binary itself, so a new headless browser can present exactly that.
 *
 * Headless Chrome differs from the same binary run headed in one visible way (measured on Chrome 149,
 * Linux, page + dedicated + shared + service worker scopes and request headers, against the same binary
 * headed under Xvfb): its User-Agent says `HeadlessChrome/149.0.0.0` where headed says `Chrome/149.0.0.0`.
 * Brands, full version list, platform, architecture, bitness and form factors are the same. Chrome's
 * `--user-agent` switch fixes the string in every scope, but then blanks the high-entropy client hints
 * (architecture, bitness, fullVersionList, uaFullVersion, formFactors) — so the new browser also sends
 * this metadata to each target (new-browser.ts). Both come from here: the binary's own User-Agent and
 * `navigator.userAgentData.getHighEntropyValues`, read once in a throwaway headless launch of that
 * binary with no override, on its about:blank page, and cached per binary (path, size, modification
 * time) in ~/.playwriter/chrome-identity.json. Nothing is computed from the host or guessed.
 *
 * The same probe measures the height and width of Chrome's own window frame (tab strip and toolbar,
 * which headless Chrome lays out like headed), so a viewport can be turned into a window size.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { Protocol } from 'devtools-protocol'
import type { BrowserType } from '@xmorse/playwright-core'

const brandVersionSchema = z.object({ brand: z.string(), version: z.string() })

const identitySchema = z.object({
  /** `browser.version()`, e.g. 149.0.7827.114. */
  version: z.string(),
  /** The User-Agent the binary sends when run headed (headless's `HeadlessChrome/` token made `Chrome/`). */
  userAgent: z.string(),
  /** `navigator.platform`. */
  navigatorPlatform: z.string(),
  /** Complete client-hint metadata, as CDP's Emulation.UserAgentMetadata. */
  metadata: z.object({
    brands: z.array(brandVersionSchema),
    fullVersionList: z.array(brandVersionSchema),
    fullVersion: z.string(),
    platform: z.string(),
    platformVersion: z.string(),
    architecture: z.string(),
    model: z.string(),
    mobile: z.boolean(),
    bitness: z.string(),
    wow64: z.boolean(),
    formFactors: z.array(z.string()),
  }),
  /** Outer minus inner size of a new window: Chrome's frame around the page. */
  windowFrame: z.object({ width: z.number().int().min(0), height: z.number().int().min(0) }),
})

export type ChromeIdentity = z.infer<typeof identitySchema> & { metadata: Protocol.Emulation.UserAgentMetadata }

const cacheSchema = z.record(z.string(), identitySchema)

const CACHE_PATH = path.join(os.homedir(), '.playwriter', 'chrome-identity.json')

/** The cache key of a binary: a Chrome update replaces the file, which changes its size or time. */
function binaryKey(executablePath: string): string {
  const real = fs.realpathSync(executablePath)
  const stat = fs.statSync(real)
  return `${real}|${stat.size}|${Math.round(stat.mtimeMs)}`
}

function readCache(): z.infer<typeof cacheSchema> {
  let raw: string
  try {
    raw = fs.readFileSync(CACHE_PATH, 'utf8')
  } catch {
    return {}
  }
  const parsed = cacheSchema.safeParse(JSON.parse(raw))
  // A cache written by another playwriter version, or damaged: probe again and overwrite it.
  return parsed.success ? parsed.data : {}
}

function writeCache(key: string, identity: ChromeIdentity): void {
  const cache = { ...readCache(), [key]: identity }
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
  const temporary = `${CACHE_PATH}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(cache, null, 2))
  fs.renameSync(temporary, CACHE_PATH)
}

/** What the probe page reports, evaluated in the probe's own about:blank page (this package compiles without the DOM types). */
const READ_NAVIGATOR = `(async () => {
  const data = navigator.userAgentData
  const highEntropy = data
    ? await data.getHighEntropyValues(['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64'])
    : null
  return { userAgent: navigator.userAgent, platform: navigator.platform, highEntropy, inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight] }
})()`

const probeReportSchema = z.object({
  userAgent: z.string(),
  platform: z.string(),
  highEntropy: z
    .object({
      brands: z.array(brandVersionSchema),
      mobile: z.boolean(),
      platform: z.string(),
      architecture: z.string(),
      bitness: z.string(),
      formFactors: z.array(z.string()),
      fullVersionList: z.array(brandVersionSchema),
      model: z.string(),
      platformVersion: z.string(),
      uaFullVersion: z.string(),
      wow64: z.boolean(),
    })
    .nullable(),
  inner: z.tuple([z.number(), z.number()]),
  outer: z.tuple([z.number(), z.number()]),
})

/** The probe's window size: any size larger than Chrome's frame; only the difference is kept. */
const PROBE_WINDOW = { width: 1200, height: 900 }
const PROBE_URL = 'https://chrome-identity.invalid/'

async function probeIdentity(chromium: BrowserType, executablePath: string): Promise<ChromeIdentity> {
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--window-size=${PROBE_WINDOW.width},${PROBE_WINDOW.height}`],
  })
  try {
    const context = await browser.newContext({ viewport: null })
    const page = await context.newPage()
    // navigator.userAgentData exists only in secure contexts (about:blank has none): an https page that
    // Playwright serves from memory in this throwaway browser — no network.
    await page.route(PROBE_URL, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>identity</title>' }))
    await page.goto(PROBE_URL)
    const parsed = probeReportSchema.safeParse(await page.evaluate(READ_NAVIGATOR))
    if (!parsed.success) {
      throw new Error(`The Chrome at ${executablePath} reported its identity in an unexpected shape: ${parsed.error.message}`)
    }
    const report = parsed.data
    if (!report.highEntropy) {
      throw new Error(
        `The Chrome at ${executablePath} (${browser.version()}) has no navigator.userAgentData, so its client hints cannot be presented consistently. Use Chrome 90 or newer (PLAYWRITER_BROWSER_PATH).`,
      )
    }
    const high = report.highEntropy
    return {
      version: browser.version(),
      userAgent: report.userAgent.replace('HeadlessChrome/', 'Chrome/'),
      navigatorPlatform: report.platform,
      metadata: {
        brands: high.brands,
        fullVersionList: high.fullVersionList,
        fullVersion: high.uaFullVersion,
        platform: high.platform,
        platformVersion: high.platformVersion,
        architecture: high.architecture,
        model: high.model,
        mobile: high.mobile,
        bitness: high.bitness,
        wow64: high.wow64,
        formFactors: high.formFactors,
      },
      windowFrame: { width: report.outer[0] - report.inner[0], height: report.outer[1] - report.inner[1] },
    }
  } finally {
    await browser.close()
  }
}

const inFlight = new Map<string, Promise<ChromeIdentity>>()

/**
 * The identity of the Chrome at `executablePath`: from the cache, else probed (one headless launch,
 * ≈0.6 s) and cached. Concurrent callers for the same binary share one probe.
 */
export async function chromeIdentity(chromium: BrowserType, executablePath: string): Promise<ChromeIdentity> {
  const key = binaryKey(executablePath)
  const cached = readCache()[key]
  if (cached) return cached
  const running = inFlight.get(key)
  if (running) return running
  const probing = probeIdentity(chromium, executablePath).then((identity) => {
    writeCache(key, identity)
    return identity
  })
  inFlight.set(key, probing)
  try {
    return await probing
  } finally {
    inFlight.delete(key)
  }
}

/** Forget the cached identity of `executablePath` (the launched browser reported another version). */
export function forgetChromeIdentity(executablePath: string): void {
  const key = binaryKey(executablePath)
  const cache = readCache()
  if (!(key in cache)) return
  delete cache[key]
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
}
