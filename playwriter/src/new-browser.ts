/**
 * new-browser.ts — the browser `browser({ action: 'new', … })` launches (and every headless executor:
 * `CdpConfig.headless`), presented to pages as a person's Chrome of that version on this computer.
 *
 * What a page can see, and what decides it (all measured on Chrome 149 / Linux against the same binary
 * run headed under Xvfb; tests in new-browser-live.test.ts):
 *
 * - `navigator.webdriver`: Playwright passes `--enable-automation`, which makes it true. Not passed;
 *   `--disable-blink-features=AutomationControlled` keeps it false under the debugging pipe too.
 * - User-Agent: headless says `HeadlessChrome/<v>` where headed says `Chrome/<v>`. `--user-agent` with
 *   the binary's own headed string fixes it in pages, all three kinds of workers and request headers;
 *   since that switch blanks the high-entropy client hints, every target (page, iframe, dedicated,
 *   shared and service worker) also gets the binary's complete metadata through CDP the moment it is
 *   attached, before it runs (`presentIdentity`). Both come from the binary itself (chrome-identity.ts).
 *   No page script, no main-world global: flags and CDP only.
 * - WebGL: headless Chrome renders WebGL with SwiftShader (`ANGLE (Google, Vulkan … SwiftShader)`), a
 *   classic headless tell. On Linux `--use-angle=gl-egl` makes headless Chrome use the computer's GPU
 *   through EGL (measured: `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3090/PCIe/SSE2, OpenGL ES 3.2)`,
 *   the string Chrome reports on a Wayland desktop); without a usable GPU Chrome falls back to
 *   SwiftShader by itself (measured with EGL's vendor libraries hidden). The launch waits for the GPU
 *   process (`waitForGpuProcess`): until it is up, no page draws a frame.
 * - Screen and window: a headless window lives on an 800×600 screen, and Playwright's viewport emulation
 *   makes the screen equal to the page and the window frame zero. Instead the page size comes from the
 *   window (`viewport: null`, `--window-size` = page + Chrome's own frame), on a screen with a work area
 *   (`--screen-info`): screen ≥ window, availHeight < height, outer > inner, like a desktop.
 * - WebRTC: Chrome already hides local addresses behind mDNS names (measured: host candidates
 *   `<uuid>.local`, srflx `raddr 0.0.0.0`); the public address STUN reports is the one every request
 *   comes from. Nothing to change.
 *
 * Options (`NewBrowserOptions`) are applied at launch and context creation: a fresh browser has no user
 * state to protect, and browser-wide options (user agent, language, time zone, allowed hosts) reach
 * workers only that way. Sessions with the same browser-wide options share one Chrome (`launchKey`).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, Download, LaunchOptions } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import { ModelFacingError } from './probe-types.js'
import { withDeadline } from './isolated-world.js'
import { ScopedFS } from './scoped-fs.js'
import { resolveNewBrowserExecutablePath } from './browser-config.js'
import { chromeIdentity, forgetChromeIdentity, type ChromeIdentity } from './chrome-identity.js'
import { describeAllowedDomains, enforceAllowedDomains, parseAllowedDomains, type AllowedDomain } from './allowed-domains.js'
import { field, serverObject } from './playwright-server.js'
import type { NewBrowserOptions } from './new-browser-options.js'

/** The page size when neither viewport nor device is given: Playwright's default, which the fork always had. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 }

/** A Playwright device descriptor (playwright-core's `devices`), as far as a new browser uses it. */
interface DeviceDescriptor {
  userAgent: string
  viewport: { width: number; height: number }
  screen?: { width: number; height: number }
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
  defaultBrowserType: string
}

/** What `planNewBrowser` resolved: everything checked, nothing launched. */
export interface NewBrowserPlan {
  options: NewBrowserOptions
  executablePath: string
  headed: boolean
  /** The page size (the device's for a device). */
  viewport: { width: number; height: number }
  device: { name: string; descriptor: DeviceDescriptor; android: boolean; phone: boolean } | null
  /** A user agent the model chose; null: the binary's own (or the device's, derived from it). */
  userAgent: string | null
  locale: string | null
  timezone: string | null
  colorScheme: NewBrowserOptions['colorScheme'] | null
  allowedDomains: AllowedDomain[] | null
  /** Absolute folder every finished download is copied into. */
  downloads: string | null
}

/** What every target is told it is; null: the binary's own presentation is already right (headed). */
interface PresentedIdentity {
  userAgent: string
  metadata: Protocol.Emulation.UserAgentMetadata
  navigatorPlatform: string
}

/**
 * Real Chrome on Android sends the reduced User-Agent (`Linux; Android 10; K`), whatever the phone; the
 * model and Android version only reach a page through client hints.
 */
function androidUserAgent(major: string, phone: boolean): string {
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 ${phone ? 'Mobile ' : ''}Safari/537.36`
}

/** The device presets a Chrome binary can present honestly: Chrome on Android, and desktop Chrome. */
function chromeDevice(descriptor: DeviceDescriptor): { android: boolean; phone: boolean } | null {
  const ua = descriptor.userAgent
  if (descriptor.defaultBrowserType !== 'chromium' || !ua.includes('Chrome/') || /Edge?\/|Windows Phone/.test(ua)) return null
  if (/Android \d/.test(ua)) return { android: true, phone: ua.includes('Mobile Safari') }
  return { android: false, phone: false }
}

/** The OS a User-Agent string claims, as Chrome names platforms in client hints. */
function claimedPlatform(userAgent: string): string | null {
  if (/Android/.test(userAgent)) return 'Android'
  if (/iPhone|iPad/.test(userAgent)) return 'iOS'
  if (/CrOS/.test(userAgent)) return 'Chrome OS'
  if (/Windows/.test(userAgent)) return 'Windows'
  if (/Macintosh/.test(userAgent)) return 'macOS'
  if (/Linux|X11/.test(userAgent)) return 'Linux'
  return null
}

function hasDisplay(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}

/**
 * Check `options` and resolve what they mean. Every refusal is a ModelFacingError naming the fix;
 * a missing Chrome binary is a plain Error (the caller tells the model to ask the user).
 */
export async function planNewBrowser(
  options: NewBrowserOptions,
  { cwd, env = process.env, platform = os.platform() }: { cwd: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): Promise<NewBrowserPlan> {
  if (options.device !== undefined && options.viewport !== undefined) {
    throw new ModelFacingError(`device "${options.device}" sets the page size itself: pass device or viewport, not both.`)
  }
  if (options.device !== undefined && options.userAgent !== undefined) {
    throw new ModelFacingError(`device "${options.device}" sets the user agent itself: pass device or userAgent, not both.`)
  }
  if (options.headed && !hasDisplay(env, platform)) {
    throw new ModelFacingError(
      'headed: this MCP server has no display (neither DISPLAY nor WAYLAND_DISPLAY is set), so a browser window cannot be shown. ' +
        'Call new without headed (the headless browser behaves the same), or ask the user to run this MCP server in a desktop session.',
    )
  }

  let device: NewBrowserPlan['device'] = null
  if (options.device !== undefined) {
    // Loaded here, not at module load: playwright-core's device list is only needed for a device.
    const { devices } = await import('@xmorse/playwright-core')
    const usable = Object.entries(devices).flatMap(([name, descriptor]) => {
      const kind = chromeDevice(descriptor)
      return kind ? [{ name, descriptor, ...kind }] : []
    })
    const wanted = options.device.trim().toLowerCase()
    const found = usable.find((candidate) => candidate.name.toLowerCase() === wanted)
    if (!found) {
      const known = Object.keys(devices).find((name) => name.toLowerCase() === wanted)
      const why = known
        ? `"${known}" imitates ${devices[known]!.defaultBrowserType === 'webkit' ? 'Safari' : devices[known]!.userAgent.includes('Edg') ? 'Edge' : 'another browser'}, and this browser is Chrome: a page would see Chrome's engine and client hints under that name.`
        : `"${options.device}" is not a device preset.`
      throw new ModelFacingError(`device: ${why} The Chrome presets are: ${usable.map((candidate) => candidate.name).join(', ')}.`)
    }
    device = found
  }

  if (options.locale !== undefined) {
    try {
      Intl.getCanonicalLocales(options.locale)
    } catch {
      throw new ModelFacingError(`locale: ${JSON.stringify(options.locale)} is not a language tag. Write one like "fr-FR", "en-GB" or "ja".`)
    }
  }
  if (options.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: options.timezone })
    } catch {
      throw new ModelFacingError(`timezone: ${JSON.stringify(options.timezone)} is not an IANA time zone. Write one like "Europe/Paris", "America/New_York" or "UTC".`)
    }
  }

  let downloads: string | null = null
  if (options.downloads !== undefined) {
    // The sandbox `fs`'s folders (executor.ts): the session folder, /tmp and the system temp folder.
    const jail = new ScopedFS([cwd, '/tmp', os.tmpdir()], cwd)
    downloads = jail.resolveAllowed(options.downloads)
    if (downloads === null) {
      throw new ModelFacingError(
        `downloads: ${options.downloads} is outside the folders this session may write to (${jail.allowedDirectories().join(', ')}). Pass a folder inside one of them.`,
      )
    }
    if (fs.existsSync(downloads) && !fs.statSync(downloads).isDirectory()) {
      throw new ModelFacingError(`downloads: ${options.downloads} is a file, not a folder. Pass a folder (it is created when missing).`)
    }
  }

  return {
    options,
    executablePath: resolveNewBrowserExecutablePath({ env, platform }),
    headed: options.headed === true,
    viewport: device ? device.descriptor.viewport : (options.viewport ?? DEFAULT_VIEWPORT),
    device,
    userAgent: options.userAgent ?? null,
    locale: options.locale === undefined ? null : Intl.getCanonicalLocales(options.locale)[0]!,
    timezone: options.timezone ?? null,
    colorScheme: options.colorScheme ?? null,
    allowedDomains: options.allowedDomains ? parseAllowedDomains(options.allowedDomains) : null,
    downloads,
  }
}

/** What `plan` tells pages and workers they run in, from the binary's own `identity`. */
function presentedIdentity(plan: NewBrowserPlan, identity: ChromeIdentity): PresentedIdentity | null {
  const major = identity.version.split('.')[0]!
  if (plan.device?.android) {
    const { descriptor, phone } = plan.device
    const androidVersion = /Android (\d+(?:\.\d+)*)/.exec(descriptor.userAgent)?.[1] ?? '10'
    const model = /Android [\d.]+; ([^;)]+)/.exec(descriptor.userAgent)?.[1]?.trim() ?? ''
    return {
      userAgent: androidUserAgent(major, phone),
      metadata: {
        ...identity.metadata,
        platform: 'Android',
        platformVersion: androidVersion.split('.').concat(['0', '0']).slice(0, 3).join('.'),
        architecture: '',
        bitness: '',
        model,
        mobile: phone,
        wow64: false,
        formFactors: [phone ? 'Mobile' : 'Tablet'],
      },
      // What Chrome on an Android phone reports (32-bit ARM userland on a 64-bit CPU).
      navigatorPlatform: 'Linux armv81',
    }
  }
  if (plan.userAgent !== null) {
    const claimed = claimedPlatform(plan.userAgent)
    const ownPlatform = identity.metadata.platform
    return {
      userAgent: plan.userAgent,
      metadata:
        claimed === null || claimed === ownPlatform
          ? identity.metadata
          : { ...identity.metadata, platform: claimed, platformVersion: '', mobile: /Mobile/.test(plan.userAgent), formFactors: [/Mobile/.test(plan.userAgent) ? 'Mobile' : 'Desktop'] },
      navigatorPlatform: identity.navigatorPlatform,
    }
  }
  // Headed Chrome already presents itself as itself.
  if (plan.headed) return null
  return { userAgent: identity.userAgent, metadata: identity.metadata, navigatorPlatform: identity.navigatorPlatform }
}

/** What remains of this computer in the presentation, for the model to know (custom UA, Android device). */
function presentationNotes(plan: NewBrowserPlan, identity: ChromeIdentity, presented: PresentedIdentity | null): string[] {
  const notes: string[] = []
  if (!presented) return notes
  if (presented.metadata.platform !== identity.metadata.platform) {
    notes.push(
      `navigator.platform in workers still says "${identity.navigatorPlatform}" (Chrome has no way to change it there), while the user agent claims ${presented.metadata.platform}: a page that compares them can tell.`,
    )
  }
  const claimedMajor = /Chrome\/(\d+)/.exec(presented.userAgent)?.[1]
  const ownMajor = identity.version.split('.')[0]
  if (plan.userAgent !== null && claimedMajor !== undefined && claimedMajor !== ownMajor) {
    notes.push(`The user agent claims Chrome ${claimedMajor}; the client hints (navigator.userAgentData, Sec-CH-UA) say ${ownMajor}, the real version.`)
  }
  return notes
}

/** Browser-wide options: sessions whose keys are equal can share one Chrome. */
export function launchKey(plan: NewBrowserPlan): string {
  return JSON.stringify({
    executablePath: plan.executablePath,
    headed: plan.headed,
    viewport: plan.device ? null : plan.viewport,
    device: plan.device?.name ?? null,
    userAgent: plan.userAgent,
    locale: plan.locale,
    timezone: plan.timezone,
    allowedDomains: plan.allowedDomains ? describeAllowedDomains(plan.allowedDomains) : null,
  })
}

/**
 * A desktop layout around the window: the smallest common screen the window fits in, with a work area
 * that leaves room for the system's panel (GNOME's 32 px top bar, the Windows 48 px taskbar, the macOS
 * 25 px menu bar), so that availHeight < height as on any desktop.
 */
const COMMON_SCREENS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
]
const PANEL: Record<string, { edge: 'Top' | 'Bottom'; size: number }> = {
  linux: { edge: 'Top', size: 32 },
  win32: { edge: 'Bottom', size: 48 },
  darwin: { edge: 'Top', size: 25 },
}

function screenInfoArg(window: { width: number; height: number }, platform: NodeJS.Platform): string {
  const panel = PANEL[platform] ?? PANEL.linux!
  const screen = COMMON_SCREENS.find((candidate) => candidate.width >= window.width && candidate.height - panel.size >= window.height) ?? {
    width: window.width,
    height: window.height + panel.size,
  }
  return `--screen-info={0,0 ${screen.width}x${screen.height} workArea${panel.edge}=${panel.size}}`
}

/** Chrome keeps only the last --enable-features switch: Playwright's own feature is merged in. */
function enabledFeatures(env: NodeJS.ProcessEnv): string {
  // WebMCPTesting + DevToolsWebMCPSupport: navigator.modelContext and the CDP WebMCP domain (Chrome ≥ 149).
  const features = ['WebMCPTesting', 'DevToolsWebMCPSupport']
  if (!env.PLAYWRIGHT_LEGACY_SCREENSHOT) features.unshift('CDPScreenshotNewSurface')
  return `--enable-features=${features.join(',')}`
}

/**
 * Replaces Playwright's --disable-features list (Chrome keeps only the last switch). Playwright also turns
 * off features a page can observe, so they stay on here as in a person's Chrome: ThirdPartyStoragePartitioning
 * (measured: without it a cross-site iframe's localStorage is shared with its top-level site),
 * HttpsUpgrades, and BoundaryEventDispatchTracksNodeRemoval (mouse boundary events when the hovered node is
 * removed). The rest of Playwright's list only concerns browser UI, profile and background services, or
 * keeps beforeunload dialogs firing (AvoidUnnecessaryBeforeUnloadCheckSync) and first paint unheld
 * (PaintHolding), which the action reports rely on.
 */
const DISABLED_FEATURES =
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,' +
  'LensOverlay,MediaRouter,PaintHolding,Translate,AutoDeElevate,OptimizationHints'

/** The language list Chrome sends for a locale: the locale, then its language. */
function acceptLanguage(locale: string): string {
  const language = locale.split('-')[0]!
  return language === locale ? locale : `${locale},${language}`
}

export function launchOptionsFor(plan: NewBrowserPlan, identity: ChromeIdentity, presented: PresentedIdentity | null, platform: NodeJS.Platform = os.platform()): LaunchOptions {
  const frame = identity.windowFrame
  const window = plan.device ? { width: DEFAULT_VIEWPORT.width + frame.width, height: DEFAULT_VIEWPORT.height + frame.height } : { width: plan.viewport.width + frame.width, height: plan.viewport.height + frame.height }
  const args = ['--disable-blink-features=AutomationControlled', enabledFeatures(process.env), DISABLED_FEATURES, `--window-size=${window.width},${window.height}`]
  if (presented) args.push(`--user-agent=${presented.userAgent}`)
  if (!plan.headed) {
    args.push(screenInfoArg(window, platform))
    if (platform === 'linux') args.push('--use-angle=gl-egl')
  }
  if (plan.locale) args.push(`--lang=${plan.locale}`, `--accept-lang=${acceptLanguage(plan.locale)}`)
  return {
    executablePath: plan.executablePath,
    headless: !plan.headed,
    ignoreDefaultArgs: ['--enable-automation'],
    args,
    env: { ...process.env, ...(plan.timezone ? { TZ: plan.timezone } : {}), ...(plan.locale ? { LANGUAGE: plan.locale.replace('-', '_'), LANG: `${plan.locale.replace('-', '_')}.UTF-8` } : {}) },
  }
}

/** How a CDP error says the target is already gone (closed during its attach): nothing to tell anyone. */
function isGoneError(error: unknown): boolean {
  const message = field(error, 'message')
  return field(error, 'code') === -32001 || (typeof message === 'string' && /Session with given id not found|Target closed/.test(message))
}

/**
 * Send `presented` to every target the moment Playwright's server hears it attached, before the target
 * runs (Chrome holds every new target: `waitForDebuggerOnStart`, and Playwright resumes it only after its
 * own setup, which goes out after this). Hooked where Playwright's server reads the browser pipe, so it
 * covers targets attached to any session: pages, iframes, dedicated, shared and service workers. The
 * answers to these commands are taken out of the stream before Playwright's server sees them.
 *
 * Shared workers: Playwright's server detaches from them right away (crBrowser.ts `_onAttachedToTarget`),
 * and Chrome drops a session's override with the session — measured: the worker then read blank
 * high-entropy client hints when its script asked after the detach. Their sessions stay attached: the
 * server's `Target.detachFromTarget` for one is answered with a no-op (`Target.getTargetInfo`) under its
 * own id. The session sends nothing more and ends with the worker.
 */
function presentIdentity(browser: Browser, presented: PresentedIdentity, logger: { error(...args: unknown[]): void }): void {
  const connection = field(serverObject(browser, 'the launched browser'), '_connection')
  const transport = field(connection, '_transport')
  const rawSend = field(connection, '_rawSend')
  const original = field(transport, 'onmessage')
  const send = field(transport, 'send')
  if (typeof transport !== 'object' || transport === null || typeof rawSend !== 'function' || typeof original !== 'function' || typeof send !== 'function') {
    throw new Error(
      "new-browser: Playwright's server keeps its browser connection elsewhere (CRConnection._transport.onmessage / send / _rawSend), so the new browser cannot present its user agent to every target. " +
        'Playwright was upgraded: update presentIdentity.',
    )
  }
  const pageOverride = { userAgent: presented.userAgent, userAgentMetadata: presented.metadata, platform: presented.navigatorPlatform }
  const workerOverride = { userAgent: presented.userAgent, userAgentMetadata: presented.metadata }
  const ours = new Map<number, string>()
  const sharedWorkerSessions = new Set<string>()
  const onMessage = (message: unknown): void => {
    const id = field(message, 'id')
    if (typeof id === 'number' && ours.has(id)) {
      const what = ours.get(id)
      ours.delete(id)
      const error = field(message, 'error')
      if (error !== undefined && !isGoneError(error)) logger.error(`new-browser: ${what} failed; that target shows Chrome's own client hints:`, error)
      return
    }
    Reflect.apply(original, transport, [message])
    const method = field(message, 'method')
    const params = field(message, 'params')
    const sessionId = field(params, 'sessionId')
    if (method === 'Target.detachedFromTarget' && typeof sessionId === 'string') sharedWorkerSessions.delete(sessionId)
    if (method !== 'Target.attachedToTarget') return
    const type = field(field(params, 'targetInfo'), 'type')
    if (typeof sessionId !== 'string' || typeof type !== 'string') return
    const isDocument = type === 'page' || type === 'iframe'
    if (!isDocument && type !== 'worker' && type !== 'shared_worker' && type !== 'service_worker') return
    if (type === 'shared_worker') sharedWorkerSessions.add(sessionId)
    const override = isDocument ? 'Emulation.setUserAgentOverride' : 'Network.setUserAgentOverride'
    const sent: unknown = Reflect.apply(rawSend, connection, [sessionId, override, isDocument ? pageOverride : workerOverride])
    if (typeof sent === 'number') ours.set(sent, `${override} on a ${type}`)
  }
  const onSend = (message: unknown): unknown => {
    const detached = field(field(message, 'params'), 'sessionId')
    if (field(message, 'method') !== 'Target.detachFromTarget' || typeof detached !== 'string' || !sharedWorkerSessions.has(detached)) {
      return Reflect.apply(send, transport, [message])
    }
    const parent = field(message, 'sessionId')
    const noOp = { id: field(message, 'id'), method: 'Target.getTargetInfo', params: {}, ...(typeof parent === 'string' ? { sessionId: parent } : {}) }
    return Reflect.apply(send, transport, [noOp])
  }
  Reflect.set(transport, 'onmessage', onMessage)
  Reflect.set(transport, 'send', onSend)
}

const GPU_WAIT_MS = 10_000

/**
 * Wait until the browser's GPU process is up, before any page exists. Until it is, no page of the
 * browser draws a frame: no paint, no FCP/LCP, no first ResizeObserver callback, while the page's own
 * timers run on (Chrome 149 does not hold them for the first frame; Chromium 133 did). Measured with
 * `--use-angle=gl-egl` and 32 Chromes launched at once: without this wait, 0 of 32 fresh pages had
 * painted 600 ms after load and 26 of 32 still had not 1 s later (without gl-egl: 13 and 32 of 32);
 * with it, 32 of 32 had, FCP 240–436 ms. `SystemInfo.getInfo` answers once the GPU process has
 * reported in: 1.4–1.9 s in that burst, 4–10 ms on an idle computer. A browser-level read: no page
 * sees it. If it fails or times out, the launch goes on and pages draw once the GPU process is up.
 */
async function waitForGpuProcess(browser: Browser, logger: { error(...args: unknown[]): void }): Promise<void> {
  const session = await withDeadline(browser.newBrowserCDPSession(), GPU_WAIT_MS, 'opening a browser session to wait for the GPU process')
  try {
    await withDeadline(session.send('SystemInfo.getInfo'), GPU_WAIT_MS, 'waiting for the GPU process (SystemInfo.getInfo)')
  } catch (error) {
    logger.error('new-browser: waiting for the GPU process failed; pages of this browser draw their first frame only once it is up:', error)
  }
  await withDeadline(session.detach(), GPU_WAIT_MS, 'detaching the browser session that waited for the GPU process')
}

/** A launched new browser and what it presents. */
export interface LaunchedNewBrowser {
  browser: Browser
  identity: ChromeIdentity
  /** Lines for the model: what in the presentation still shows this computer. */
  notes: string[]
}

/**
 * Launch the Chrome `plan` describes. The binary's identity comes from its cache; when the launched
 * Chrome reports another version (it was updated in place), the cache entry is dropped and the
 * identity probed again, once.
 */
export async function launchNewBrowser(
  chromium: BrowserType,
  plan: NewBrowserPlan,
  logger: { error(...args: unknown[]): void },
): Promise<LaunchedNewBrowser> {
  for (let attempt = 0; ; attempt++) {
    const identity = await chromeIdentity(chromium, plan.executablePath)
    const presented = presentedIdentity(plan, identity)
    const browser = await chromium.launch(launchOptionsFor(plan, identity, presented))
    if (browser.version() !== identity.version) {
      await browser.close()
      forgetChromeIdentity(plan.executablePath)
      if (attempt === 0) continue
      throw new Error(`The Chrome at ${plan.executablePath} reported version ${browser.version()} twice after a fresh identity probe said ${identity.version}.`)
    }
    try {
      if (presented) presentIdentity(browser, presented, logger)
      if (plan.allowedDomains) await enforceAllowedDomains({ browser, domains: plan.allowedDomains, logger })
      await waitForGpuProcess(browser, logger)
    } catch (error) {
      await browser.close()
      throw error
    }
    return { browser, identity, notes: presentationNotes(plan, identity, presented) }
  }
}

/** The context options of a session in `plan`'s browser. User agent and language are browser-wide (launch). */
export function contextOptionsFor(plan: NewBrowserPlan): BrowserContextOptions {
  const colorScheme = plan.colorScheme ? { colorScheme: plan.colorScheme } : {}
  if (plan.device) {
    const { viewport, screen, deviceScaleFactor, isMobile, hasTouch } = plan.device.descriptor
    return { viewport, ...(screen ? { screen } : {}), deviceScaleFactor, isMobile, hasTouch, ...colorScheme }
  }
  // The page takes the window's size (launchOptionsFor), so screen, window and page agree.
  return { viewport: null, ...colorScheme }
}

/** The copy each download got in the downloads folder: its path, or why it could not be made. */
const copies = new WeakMap<Download, Promise<{ path: string } | { error: string }>>()

/** The copy of `download` in the session's downloads folder, when the session has one. */
export function downloadCopyOf(download: Download): Promise<{ path: string } | { error: string }> | undefined {
  return copies.get(download)
}

/** `name` in `folder`, numbered like Chrome does when taken: `report.csv`, `report (1).csv`, … */
function freeName(folder: string, name: string): string {
  const parsed = path.parse(name)
  for (let n = 0; ; n++) {
    const candidate = path.join(folder, n === 0 ? name : `${parsed.name} (${n})${parsed.ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
}

/** Copy every finished download of `context` into `folder` under the name the server suggested. */
export function copyDownloadsInto(context: BrowserContext, folder: string): void {
  const watch = (page: { on(event: 'download', listener: (download: Download) => void): unknown }): void => {
    page.on('download', (download) => {
      copies.set(
        download,
        (async () => {
          const finished = await download.path()
          fs.mkdirSync(folder, { recursive: true })
          const target = freeName(folder, path.basename(download.suggestedFilename()) || 'download')
          fs.copyFileSync(finished, target)
          return { path: target }
        })().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
      )
    })
  }
  context.pages().forEach(watch)
  context.on('page', watch)
}

/** One line per active option, for `browser list` and the `new` reply. */
export function describeNewBrowser(plan: NewBrowserPlan, launched: Pick<LaunchedNewBrowser, 'identity' | 'notes'> | null): string[] {
  const lines = [
    `binary: ${plan.executablePath}${launched ? ` (Chrome ${launched.identity.version})` : ''}, ${plan.headed ? 'headed (a visible window)' : 'headless'}`,
    plan.device
      ? `device: ${plan.device.name} — ${plan.viewport.width}×${plan.viewport.height} page, pixel ratio ${plan.device.descriptor.deviceScaleFactor}${plan.device.descriptor.hasTouch ? ', touch' : ''}`
      : `viewport: ${plan.viewport.width}×${plan.viewport.height}`,
    `user agent: ${plan.userAgent ?? (plan.device?.android ? `Chrome on Android (${plan.device.name})` : "the browser's own, as a person's Chrome of that version sends it")}`,
    `locale: ${plan.locale ?? "the computer's"} · timezone: ${plan.timezone ?? "the computer's"} · color scheme: ${plan.colorScheme ?? 'light'}`,
    `allowed hosts: ${plan.allowedDomains ? `${describeAllowedDomains(plan.allowedDomains)} (requests elsewhere are blocked and reported)` : 'all'}`,
    `downloads: ${plan.downloads ? `also saved into ${plan.downloads}` : 'kept for downloads.save()'}`,
  ]
  return launched ? [...lines, ...launched.notes] : lines
}
