import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { EXTENSION_IDS } from './utils.js'

export type BrowserLaunchOptions = {
  extensionPath: string
  userDataDir: string
  headless: boolean
  noSandbox?: boolean
  url?: string
}

export function getDefaultBrowserUserDataDir(): string {
  return path.join(os.homedir(), '.playwriter', 'browser-profile')
}

/** The part of a Chrome profile's Preferences file read here; every other key is kept as it is. */
const ChromePreferences = z.looseObject({
  extensions: z.looseObject({ ui: z.looseObject({ developer_mode: z.boolean().optional() }).optional() }).optional(),
})

/**
 * Turn Developer mode on in the profile `Default` of userDataDir, before Chrome starts with it. The
 * extension loaded with --load-extension reloads itself when its folder gets a newer build
 * (extension/src/self-reload.ts), and MEASURED (Chrome for Testing 145.0.7632.18, Chrome 149.0.7827.114):
 * an unpacked extension that reloads while Developer mode is off is disabled
 * (DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION), and stays disabled when Chrome starts again with the same
 * --load-extension. Chrome reads Preferences at start, so this is for a profile no Chrome runs.
 */
export function enableDeveloperMode(userDataDir: string): void {
  const file = path.join(path.resolve(userDataDir), 'Default', 'Preferences')
  const preferences = ChromePreferences.parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {})
  if (preferences.extensions?.ui?.developer_mode === true) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ ...preferences, extensions: { ...preferences.extensions, ui: { ...preferences.extensions?.ui, developer_mode: true } } }),
  )
}

export function getBrowserLaunchArgs({
  extensionPath,
  userDataDir,
  headless,
  noSandbox = false,
  url = 'about:blank',
}: BrowserLaunchOptions): string[] {
  const recordingFlags = EXTENSION_IDS.map((extensionId) => {
    return `--allowlisted-extension-id=${extensionId}`
  })

  const args = [
    `--user-data-dir=${path.resolve(userDataDir)}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--auto-accept-this-tab-capture',
    ...recordingFlags,
    `--disable-extensions-except=${path.resolve(extensionPath)}`,
    `--load-extension=${path.resolve(extensionPath)}`,
  ]

  if (headless) {
    args.push('--headless=new')
  }

  if (noSandbox) {
    args.push('--no-sandbox', '--disable-setuid-sandbox')
  }

  args.push(url)
  return args
}

export function startBrowserProcess({
  browserPath,
  args,
  userDataDir,
}: {
  browserPath: string
  args: string[]
  userDataDir: string
}): { pid: number } {
  fs.mkdirSync(path.resolve(userDataDir), { recursive: true })

  const browserProcess = spawn(browserPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  browserProcess.unref()

  if (!browserProcess.pid) {
    throw new Error(`Failed to start browser process for ${browserPath}`)
  }

  return { pid: browserProcess.pid }
}
