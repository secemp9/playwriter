/**
 * webmcp.* in the human-mode policy: list() and events() only read; invoke() runs a page tool, an
 * input action counted with act's (one per call); a computed method name cannot be read. Debug mode
 * lets everything through.
 */

import { describe, expect, it } from 'vitest'
import { analyzeCode, checkPolicy } from './code-policy.js'

const human = (code: string) => checkPolicy(analyzeCode(code), { mode: 'human', pageIsBlank: false })
const debug = (code: string) => checkPolicy(analyzeCode(code), { mode: 'debug', pageIsBlank: false })

describe('webmcp in the policy', () => {
  it('classifies webmcp.invoke as an input action and list/events as reads', () => {
    const analysis = analyzeCode("const tools = await webmcp.list()\nawait webmcp.invoke('addTodo', { text: 'x' })\nreturn await webmcp.events()")
    expect(analysis.inputActions.map((site) => `${site.api}@${site.line}${site.viaAct ? ' act' : ''}`)).toEqual(['webmcp.invoke@2 act'])
    expect(human("await webmcp.list()\nawait webmcp.events({ since: 3 })").allowed).toBe(true)
    expect(human("await webmcp.invoke('addTodo', { text: 'Buy milk' })").allowed).toBe(true)
  })

  it('refuses two invocations, or an invocation and an act action, in one human-mode call', () => {
    const twice = human("await webmcp.invoke('addTodo', { text: 'a' })\nawait webmcp.invoke('addTodo', { text: 'b' })")
    expect(twice.allowed).toBe(false)
    expect(twice.refusal).toContain('this call does 2 input actions — webmcp.invoke on line 1, webmcp.invoke on line 2')
    expect(twice.refusal).toMatch(/Nothing from this call was run\.$/)
    const mixed = human("await act.click(3)\nawait webmcp.invoke('listTodos')")
    expect(mixed.allowed).toBe(false)
    expect(mixed.refusal).toContain('act.click on line 1, webmcp.invoke on line 2')
  })

  it('refuses an invocation in a loop and a computed method name', () => {
    const looped = human("for (const text of ['a', 'b']) await webmcp.invoke('addTodo', { text })")
    expect(looped.refusal).toContain('webmcp.invoke on line 1 runs inside')
    const computed = human("const m = ['inv', 'oke'].join('')\nawait webmcp[m]('addTodo', {})")
    expect(computed.allowed).toBe(false)
    expect(computed.refusal).toContain('webmcp[…] on line 2 is unanalysable — calls a webmcp method whose name is computed at run time')
    // A key that folds to a constant is read as written.
    expect(analyzeCode("const m = 'inv' + 'oke'\nawait webmcp[m]('addTodo', {})").inputActions.map((site) => site.api)).toEqual(['webmcp.invoke'])
  })

  it('lets debug mode run several invocations', () => {
    expect(debug("await webmcp.invoke('addTodo', { text: 'a' })\nawait webmcp.invoke('addTodo', { text: 'b' })").allowed).toBe(true)
  })
})
