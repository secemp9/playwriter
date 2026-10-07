/**
 * The pure parts of the new browser: which binary it launches, and which hosts allowedDomains lets
 * through. The launched browser itself is tested in new-browser-live.test.ts and mcp-new-browser.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { resolveNewBrowserExecutablePath } from './browser-config.js'
import { isHostAllowed, parseAllowedDomains } from './allowed-domains.js'
import { ModelFacingError } from './probe-types.js'

describe('resolveNewBrowserExecutablePath', () => {
  const linux = { platform: 'linux' as const, homeDir: '/home/u' }

  it('prefers the installed Google Chrome over Chromium and Playwright builds', () => {
    const present = new Set(['/opt/google/chrome/chrome', '/usr/bin/chromium'])
    expect(resolveNewBrowserExecutablePath({ ...linux, env: { PATH: '/usr/bin' }, existsSync: (file) => present.has(file) })).toBe('/opt/google/chrome/chrome')
  })

  it('finds google-chrome-stable on PATH', () => {
    const present = new Set(['/usr/local/bin/google-chrome-stable', '/usr/bin/chromium'])
    expect(resolveNewBrowserExecutablePath({ ...linux, env: { PATH: '/usr/local/bin:/usr/bin' }, existsSync: (file) => present.has(file) })).toBe(
      '/usr/local/bin/google-chrome-stable',
    )
  })

  it('takes PLAYWRITER_BROWSER_PATH over Google Chrome', () => {
    const present = new Set(['/opt/google/chrome/chrome', '/custom/chrome'])
    expect(resolveNewBrowserExecutablePath({ ...linux, env: { PLAYWRITER_BROWSER_PATH: '/custom/chrome' }, existsSync: (file) => present.has(file) })).toBe('/custom/chrome')
  })

  it('falls back to the other Chromium builds without Google Chrome', () => {
    const present = new Set(['/usr/bin/chromium'])
    expect(resolveNewBrowserExecutablePath({ ...linux, env: { PATH: '' }, existsSync: (file) => present.has(file) })).toBe('/usr/bin/chromium')
  })

  it('looks where macOS and Windows install Chrome', () => {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(resolveNewBrowserExecutablePath({ platform: 'darwin', homeDir: '/Users/u', env: {}, existsSync: (file) => file === mac })).toBe(mac)
    const windows = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    expect(
      resolveNewBrowserExecutablePath({ platform: 'win32', homeDir: 'C:\\Users\\u', env: { PROGRAMFILES: 'C:\\Program Files' }, existsSync: (file) => file.replaceAll('/', '\\') === windows }),
    ).toMatch(/Google.Chrome.Application.chrome\.exe$/)
  })
})

describe('allowedDomains', () => {
  it('allows a host and its subdomains, and only subdomains for *.', () => {
    const domains = parseAllowedDomains(['Example.com', '*.cdn.test', '127.0.0.1'])
    expect(['example.com', 'www.example.com', 'a.b.example.com', 'img.cdn.test', '127.0.0.1'].map((host) => isHostAllowed(host, domains))).toEqual([true, true, true, true, true])
    expect(['cdn.test', 'notexample.com', 'example.com.evil.test', 'localhost', '127.0.0.2'].map((host) => isHostAllowed(host, domains))).toEqual([false, false, false, false, false])
  })

  it('refuses entries that are not host names, naming the form to use', () => {
    for (const entry of ['https://example.com', 'example.com:8080', 'example.com/path', '']) {
      expect(() => parseAllowedDomains([entry])).toThrow(ModelFacingError)
    }
    expect(() => parseAllowedDomains(['example.com/path'])).toThrow('Write hosts only, without scheme, port or path')
  })
})
