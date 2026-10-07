import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@xmorse/playwright-core'
import { findInstalledChrome } from './browser-install.js'
// NOTE: browser-config uses chromium synchronously (executablePath) during browser start.
// Patchright mode only affects connectOverCDP in executor.ts, not browser binary lookup.

type BrowserLookupOptions = {
  browserPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
  existsSync?: (filePath: string) => boolean
}

function expandHomeDirectory({ filePath, homeDir }: { filePath: string; homeDir: string }): string {
  if (!filePath.startsWith('~/')) {
    return filePath
  }
  return path.join(homeDir, filePath.slice(2))
}

function dedupePaths(pathsToCheck: string[]): string[] {
  return Array.from(new Set(pathsToCheck))
}

function getPlaywrightChromiumCandidate(): string[] {
  const executablePath = chromium.executablePath()
  if (!executablePath) {
    return []
  }
  return [executablePath]
}

function getPathEntries(env: NodeJS.ProcessEnv): string[] {
  const rawPath = env.PATH || env.Path || ''
  return rawPath
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => {
      return entry.trim()
    })
}

function getExecutableNames(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return ['chrome.exe', 'chromium.exe']
  }
  return ['chrome', 'chromium', 'chromium-browser']
}

function getPathExecutableCandidates({
  platform,
  env,
}: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}): string[] {
  const executableNames = getExecutableNames(platform)
  return getPathEntries(env).flatMap((entry) => {
    return executableNames.map((name) => {
      return path.join(entry, name)
    })
  })
}

export function getBrowserExecutableCandidates({
  platform = os.platform(),
  env = process.env,
  homeDir = os.homedir(),
}: Omit<BrowserLookupOptions, 'browserPath' | 'existsSync'> = {}): string[] {
  const platformCandidates = (() => {
    if (platform === 'darwin') {
      return [
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '~/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '~/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    }

    if (platform === 'win32') {
      const localAppData = env.LOCALAPPDATA || ''
      const programFiles = env.PROGRAMFILES || 'C:\\Program Files'
      const programFilesX86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'

      return [
        path.join(programFiles, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
        path.join(programFiles, 'Chromium', 'Application', 'chromium.exe'),
        path.join(programFilesX86, 'Chromium', 'Application', 'chromium.exe'),
        path.join(localAppData, 'Chromium', 'Application', 'chromium.exe'),
      ]
    }

    return [
      '/opt/google/chrome-for-testing/chrome',
      '/usr/local/bin/chrome',
      '/usr/bin/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ]
  })()

  const pathCandidates = getPathExecutableCandidates({ platform, env })
  return dedupePaths(
    [...platformCandidates, ...pathCandidates, ...getPlaywrightChromiumCandidate()].map((filePath) => {
      return expandHomeDirectory({ filePath, homeDir })
    }),
  )
}

export function resolveBrowserExecutablePath({
  browserPath,
  env = process.env,
  platform = os.platform(),
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
}: BrowserLookupOptions = {}): string {
  const explicitPath = browserPath?.trim()
  if (explicitPath) {
    const resolvedExplicitPath = expandHomeDirectory({ filePath: explicitPath, homeDir })
    if (!existsSync(resolvedExplicitPath)) {
      throw new Error(`Browser binary not found at: ${resolvedExplicitPath}`)
    }
    return resolvedExplicitPath
  }

  const envPath = env.PLAYWRITER_BROWSER_PATH?.trim()
  if (envPath) {
    const resolvedEnvPath = expandHomeDirectory({ filePath: envPath, homeDir })
    if (!existsSync(resolvedEnvPath)) {
      throw new Error(`PLAYWRITER_BROWSER_PATH does not exist: ${resolvedEnvPath}`)
    }
    return resolvedEnvPath
  }

  // Check Chrome downloaded by `playwriter install` first (highest priority)
  const installedChrome = findInstalledChrome()
  if (installedChrome) {
    return installedChrome
  }

  const candidates = getBrowserExecutableCandidates({ platform, env, homeDir })
  const resolvedPath = candidates.find((candidate) => {
    return existsSync(candidate)
  })

  if (resolvedPath) {
    return resolvedPath
  }

  const searchedPathsText = candidates.map((candidate) => {
    return `- ${candidate}`
  })

  throw new Error(
    'Could not find a Chrome or Chromium binary to launch. The user can point PLAYWRITER_BROWSER_PATH at one, ' +
      'or install Google Chrome (or Chrome for Testing, which playwriter keeps in ~/.playwriter/browsers/).' +
      `\n\nSearched paths:\n- ~/.playwriter/browsers/ (Chrome for Testing installed by playwriter)\n${searchedPathsText.join('\n')}`,
  )
}

/**
 * The installed Google Chrome (stable channel) binaries, in the order a new browser prefers them. Chrome
 * itself, not Chrome for Testing or a distribution's Chromium: it is what people browse with, so a page
 * sees the same brands, version and GPU stack as on a person's machine, and it is current (WebMCP needs
 * Chrome ≥ 149). Branded Chrome refuses `--load-extension`, which only `browser start` needs.
 */
export function getGoogleChromeCandidates({
  platform = os.platform(),
  env = process.env,
  homeDir = os.homedir(),
}: Omit<BrowserLookupOptions, 'browserPath' | 'existsSync'> = {}): string[] {
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(homeDir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
  }
  if (platform === 'win32') {
    const programFiles = env.PROGRAMFILES || 'C:\\Program Files'
    const programFilesX86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    return [programFiles, programFilesX86, env.LOCALAPPDATA || ''].filter(Boolean).map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  return ['/opt/google/chrome/chrome', ...getPathEntries(env).flatMap((entry) => ['google-chrome-stable', 'google-chrome'].map((name) => path.join(entry, name)))]
}

/**
 * The binary a new browser (`browser({ action: 'new' })`, headless sessions) launches: PLAYWRITER_BROWSER_PATH
 * when the user set it, else the installed Google Chrome, else what `resolveBrowserExecutablePath` finds
 * (Chrome for Testing from `playwriter browser install`, Chromium, Playwright's Chromium).
 */
export function resolveNewBrowserExecutablePath({
  env = process.env,
  platform = os.platform(),
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
}: Omit<BrowserLookupOptions, 'browserPath'> = {}): string {
  if (env.PLAYWRITER_BROWSER_PATH?.trim()) {
    return resolveBrowserExecutablePath({ env, platform, homeDir, existsSync })
  }
  const chrome = getGoogleChromeCandidates({ platform, env, homeDir }).find((candidate) => existsSync(candidate))
  return chrome ?? resolveBrowserExecutablePath({ env, platform, homeDir, existsSync })
}

export function shouldUseHeadlessByDefault({
  platform = os.platform(),
  env = process.env,
}: Omit<BrowserLookupOptions, 'browserPath' | 'homeDir' | 'existsSync'> = {}): boolean {
  if (platform !== 'linux') {
    return false
  }

  return !env.DISPLAY && !env.WAYLAND_DISPLAY
}

export function getBrowserExecutablePath(browserPath?: string): string {
  return resolveBrowserExecutablePath({ browserPath })
}
