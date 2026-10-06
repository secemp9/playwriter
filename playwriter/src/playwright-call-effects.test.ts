/**
 * playwright-call-effects: the human-mode guard decides from this table, so a protocol method the
 * table does not know is refused in human mode. Playwright's client lists every method it can send in
 * `methodMetainfo`; a Playwright upgrade that adds one fails here, naming it, before it can reach a
 * session as an unexplained refusal.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { callEffect, isClassified } from './playwright-call-effects.js'

const require = createRequire(import.meta.url)

/** Playwright's own list of protocol methods (generated from protocol.yml), loaded from the installed client. */
async function clientProtocolMethods(): Promise<string[]> {
  const packageDir = path.dirname(require.resolve('@xmorse/playwright-core/package.json'))
  const file = path.join(packageDir, 'lib', 'utils', 'isomorphic', 'protocolMetainfo.js')
  expect(fs.existsSync(file), `${file} is where Playwright's client keeps its method list`).toBe(true)
  const loaded: unknown = await import(pathToFileURL(file).href)
  const metainfo: unknown = typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, 'methodMetainfo') : undefined
  if (!(metainfo instanceof Map)) throw new Error(`${file} has no methodMetainfo Map`)
  return [...metainfo.keys()].map(String)
}

describe('playwright call effects', () => {
  it('classifies every protocol method Playwright can send', async () => {
    const methods = await clientProtocolMethods()
    expect(methods.length).toBeGreaterThan(200)
    const unknown = methods.filter((key) => {
      const [type, method] = key.split('.')
      return !isClassified(type, method)
    })
    expect(unknown).toEqual([])
  })

  it('reads trace params: snapshots inject a recorder, screenshots alone do not', () => {
    expect(callEffect('Tracing', 'tracingStart', { name: 't', snapshots: true, screenshots: true })?.kind).toBe('pageWrite')
    expect(callEffect('Tracing', 'tracingStart', { name: 't', screenshots: true })?.kind).toBe('none')
  })
})
