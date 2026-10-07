/**
 * How the static human-mode policy classifies the instrument globals: perf.*, pdf() and react.* are
 * reads (no input action, no navigation, no forced state), so they run in human mode and may share a
 * call with its one action; Playwright's page.pdf() stays refused and points at pdf().
 */

import { describe, expect, it } from 'vitest'
import { analyzeCode, checkPolicy } from './code-policy.js'

const human = { mode: 'human' as const, pageIsBlank: false }

const INSTRUMENT_CALLS = [
  'await perf.vitals()',
  'await perf.metrics()',
  "await perf.trace.start({ categories: ['devtools.timeline'] })",
  "await perf.trace.stop({ path: 'trace.json' })",
  'await perf.profile.start()',
  "await perf.profile.stop({ path: 'page.cpuprofile' })",
  "await pdf({ path: 'page.pdf', format: 'A4', landscape: true })",
  'await react.tree({ ref: 3, depth: 4 })',
  'await react.suspense()',
]

describe('instrument globals in the human-mode policy', () => {
  it.each(INSTRUMENT_CALLS)('%s is a read', (code) => {
    const analysis = analyzeCode(code)
    expect(analysis.inputActions).toEqual([])
    expect(analysis.navigations).toEqual([])
    expect(analysis.forcedState).toEqual([])
    expect(analysis.scriptReads).toEqual([])
    expect(analysis.unanalysable).toEqual([])
    expect(checkPolicy(analysis, human).allowed).toBe(true)
  })

  it('shares a call with the one input action', () => {
    expect(checkPolicy(analyzeCode('await perf.trace.start()\nawait act.click(3)'), human).allowed).toBe(true)
  })

  it("refuses Playwright's page.pdf() and points at pdf()", () => {
    const verdict = checkPolicy(analyzeCode("await page.pdf({ path: 'x.pdf' })"), human)
    expect(verdict.allowed).toBe(false)
    expect(verdict.refusal).toContain("pdf({ path: 'page.pdf' }) prints it the way Ctrl+P does")
  })
})
