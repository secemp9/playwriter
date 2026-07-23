/**
 * Tests for the extension version-skew detectors in relay-client.
 *
 * These are pure unit tests over the two symmetric functions:
 *   - getExtensionOutdatedWarning — fires when the extension is NEWER than the CLI (warn).
 *   - getExtensionStaleError      — fires when the extension is OLDER than the CLI (throw).
 *
 * Both compare the extension's reported playwriter version against this package's live
 * VERSION, so the tests derive their inputs from VERSION rather than hard-coding literals —
 * that keeps them correct across future version bumps. `older`/`newer` are deliberately far
 * from any realistic VERSION so the relationship (older / equal / newer) is unambiguous.
 *
 * The stale detector is the Todo 33 "cheap insurance": a stale extension service worker
 * stops echoing workspace ownership, every page it opens becomes freestyle/invisible, and
 * the symptom is "no pages anywhere". A no-op check would give false confidence, so these
 * tests PROVE the detector actually fires on an older version and stays silent otherwise.
 */
import { describe, expect, it } from 'vitest'
import { getExtensionOutdatedWarning, getExtensionStaleError } from './relay-client.js'
import { VERSION } from './utils.js'

const older = '0.0.1'
const newer = '9999.0.0'

describe('getExtensionStaleError (stale extension → hard error)', () => {
  it('fires for an extension OLDER than the running CLI/relay', () => {
    const error = getExtensionStaleError(older)
    expect(error).toBeTruthy()
    // The message must name the real fix, not be vague.
    expect(error).toContain('stale')
    expect(error).toContain('chrome://extensions')
    expect(error).toContain(older)
    expect(error).toContain(VERSION)
  })

  it('does NOT fire for the exact same version (a correct lockstep build)', () => {
    expect(getExtensionStaleError(VERSION)).toBeNull()
  })

  it('does NOT fire for an extension NEWER than the CLI (that is the outdated-warning case)', () => {
    expect(getExtensionStaleError(newer)).toBeNull()
  })

  it('does NOT fire when the extension reports no version', () => {
    expect(getExtensionStaleError(null)).toBeNull()
    expect(getExtensionStaleError(undefined)).toBeNull()
    expect(getExtensionStaleError('')).toBeNull()
  })
})

describe('getExtensionOutdatedWarning (newer extension → warning) is preserved', () => {
  it('still fires for an extension NEWER than the CLI', () => {
    const warning = getExtensionOutdatedWarning(newer)
    expect(warning).toBeTruthy()
    expect(warning).toContain(newer)
  })

  it('does NOT fire for the same version or an older extension', () => {
    expect(getExtensionOutdatedWarning(VERSION)).toBeNull()
    expect(getExtensionOutdatedWarning(older)).toBeNull()
  })
})

describe('the two detectors are mutually exclusive for any single version', () => {
  it('never both fire for the same input (older, equal, or newer)', () => {
    for (const v of [older, VERSION, newer]) {
      const stale = getExtensionStaleError(v)
      const outdated = getExtensionOutdatedWarning(v)
      expect(stale !== null && outdated !== null).toBe(false)
    }
    // And the stale/outdated directions are actually distinct: older → only stale,
    // newer → only outdated. This is what proves the check is not a tautology.
    expect(getExtensionStaleError(older)).toBeTruthy()
    expect(getExtensionOutdatedWarning(older)).toBeNull()
    expect(getExtensionStaleError(newer)).toBeNull()
    expect(getExtensionOutdatedWarning(newer)).toBeTruthy()
  })
})
