/**
 * page-storage's place in human mode: the reads (cookies, storage, saveState, clipboard.read) pass
 * the static policy, the writes (setCookies, clearCookies, setStorage, clearStorage, loadState) are
 * refused as forced state before anything runs and refused again when called (a write the
 * analysis could not see); debug mode allows them. And the argument checks name the right form.
 */

import type { Page } from '@xmorse/playwright-core'
import { describe, expect, it } from 'vitest'
import { analyzeCode, checkPolicy } from './code-policy.js'
import { PageProbes } from './page-probe.js'
import { createStorageGlobals, type StorageGlobals } from './page-storage.js'
import type { PolicyMode } from './probe-types.js'
import { ScopedFS } from './scoped-fs.js'

const human = { mode: 'human' as const, pageIsBlank: false }
const debug = { mode: 'debug' as const, pageIsBlank: false }

function globalsFor(policy: PolicyMode): StorageGlobals {
  return createStorageGlobals({
    policy: () => policy,
    currentPage: (): Page => {
      throw new Error('the page was reached: the call should have stopped before it')
    },
    probes: new PageProbes({ logger: { error: () => {} }, busyPace: () => 'human' }),
    fs: new ScopedFS(),
    browser: () => null,
    viaExtension: false,
    ownCalls: (work) => work(),
  })
}

describe('static policy', () => {
  it.each([
    'return await cookies()',
    "return await cookies({ urls: ['https://example.com/'], values: true })",
    "return await storage('local')",
    'return await storage()',
    "return await saveState({ path: 'state.json' })",
    'return await clipboard.read()',
  ])('allows the read %s in human mode', (code) => {
    const analysis = analyzeCode(code)
    expect(analysis.forcedState).toEqual([])
    expect(checkPolicy(analysis, human)).toMatchObject({ allowed: true })
  })

  it.each([
    ["await setCookies('a=b; c=d')", 'setCookies on line 1 (writes cookies the page never set; cookies() reads them)'],
    ["await clearCookies({ names: ['a'] })", 'clearCookies on line 1 (deletes cookies directly; cookies() reads them)'],
    ["await setStorage('local', { a: 'b' })", 'setStorage on line 1 (writes localStorage/sessionStorage directly; storage() reads them)'],
    ["await clearStorage('session')", 'clearStorage on line 1 (empties localStorage/sessionStorage directly; storage() reads them)'],
    ["await loadState('state.json')", 'loadState on line 1 (loads cookies and localStorage from a file; saveState({ path }) saves them)'],
  ])('refuses %s in human mode as forced state, and allows it in debug mode', (code, site) => {
    const analysis = analyzeCode(code)
    const verdict = checkPolicy(analysis, human)
    expect(verdict.allowed).toBe(false)
    expect(verdict.refusal).toContain(`forced state — ${site}`)
    expect(verdict.refusal).toContain('Nothing from this call was run.')
    expect(checkPolicy(analysis, debug)).toMatchObject({ allowed: true })
  })

  it("leaves the code's own function of the same name alone", () => {
    expect(analyzeCode("const setCookies = (s) => s\nsetCookies('a=b')").forcedState).toEqual([])
  })
})

describe('run-time refusal of writes in human mode', () => {
  const globals = globalsFor('human')
  it.each([
    ['setCookies', () => globals.setCookies('a=b'), 'writes cookies directly'],
    ['clearCookies', () => globals.clearCookies(), 'deletes cookies directly'],
    ['setStorage', () => globals.setStorage('local', { a: 'b' }), 'writes Web Storage directly'],
    ['clearStorage', () => globals.clearStorage('local'), 'empties Web Storage directly'],
    ['loadState', () => globals.loadState('state.json'), 'writes cookies and localStorage from a file'],
  ] as const)('%s() is refused before it reaches the page', async (name, call, what) => {
    await expect(call()).rejects.toThrow(`Refused (human mode): ${name}() ${what}: forged state the page never made`)
    await expect(call()).rejects.toThrow('It was not run.')
  })
})

describe('argument checks', () => {
  const globals = globalsFor('debug')
  it('names an unknown option and the right form', async () => {
    await expect(globals.cookies({ url: 'https://example.com/' })).rejects.toThrow("cookies: unknown option 'url'. Use cookies(), cookies({ urls: ['https://example.com/'] })")
  })
  it('refuses a URL that is not http(s)', async () => {
    await expect(globals.cookies({ urls: ['about:blank'] })).rejects.toThrow("cookies: 'urls.0' must be an absolute http(s) URL")
  })
  it('refuses a storage kind that is not local or session', async () => {
    await expect(globals.storage('cookies')).rejects.toThrow("storage: the argument must be 'local' (localStorage) or 'session' (sessionStorage)")
  })
  it('refuses non-string Web Storage values', async () => {
    await expect(globals.setStorage('local', { n: 1 })).rejects.toThrow("setStorage: 'n' must be a string (Web Storage keeps strings only)")
  })
  it('requires a path for saveState and loadState', async () => {
    await expect(globals.saveState({})).rejects.toThrow('saveState:')
    await expect(globals.loadState()).rejects.toThrow('loadState:')
  })
  it('says why the clipboard cannot be read without a Browser', async () => {
    await expect(globals.clipboard.read()).rejects.toThrow('this browser was opened as a persistent context')
  })
})
