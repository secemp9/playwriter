/**
 * Every code example in skill.md (the start guide and the reference the model reads with docs()) runs
 * as written in human mode, the default — or says it does not. Models copy examples; an example the
 * policy refuses, with nothing marking it, costs a refused call and teaches the wrong habit.
 *
 * Each ```js block goes through the same static policy execute() applies. A refused block must say
 * `debug mode` in a comment, say `fast mode` and pass fast mode's policy, or be a first load of a blank
 * tab (allowed on one, and saying so). A block that does not parse must be a signature
 * (`fn({ a?, b? })`), not a broken example.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeCode, checkPolicy } from './code-policy.js'

const SKILL = path.join(path.dirname(new URL(import.meta.url).pathname), 'skill.md')

interface Example {
  line: number
  heading: string
  code: string
}

function jsExamples(markdown: string): Example[] {
  const examples: Example[] = []
  const lines = markdown.split('\n')
  let heading = ''
  let start = -1
  let lang = ''
  for (const [index, line] of lines.entries()) {
    if (start === -1) {
      const opened = /^```(\w*)\s*$/.exec(line)
      if (opened) {
        start = index
        lang = opened[1]
      } else if (/^#{1,6}\s/.test(line)) {
        heading = line
      }
      continue
    }
    if (!/^```\s*$/.test(line)) continue
    if (lang === 'js' || lang === 'javascript') examples.push({ line: start + 2, heading, code: lines.slice(start + 1, index).join('\n') })
    start = -1
  }
  return examples
}

describe('skill.md code examples and the human-mode policy', () => {
  const examples = jsExamples(fs.readFileSync(SKILL, 'utf8'))

  it('finds the examples', () => {
    // The guide and the reference hold dozens of examples; a parse that finds few has broken.
    expect(examples.length).toBeGreaterThan(80)
  })

  it('runs every example as written in human mode, or marks it fast or debug mode', () => {
    const unmarked: string[] = []
    for (const example of examples) {
      // A signature line (`fn({ a?, b? })`, optional parameters written `name?`) is not code: it is
      // blanked, keeping line numbers, and the examples under it are checked like any other code. A `?`
      // in a comment does not make a line a signature.
      const code = example.code
        .split('\n')
        .map((line) => (/\w\?[\s,)}]/.test(line.replace(/\/\/.*$/, '')) ? '' : line))
        .join('\n')
      const analysis = analyzeCode(code)
      if (analysis.parseError) {
        unmarked.push(`line ${example.line} (${example.heading}) does not parse: ${analysis.parseError}`)
        continue
      }
      const verdict = checkPolicy(analysis, { mode: 'human', pageIsBlank: false })
      if (verdict.allowed) continue
      if (/\/\/[^\n]*debug mode/i.test(example.code)) continue
      if (/\/\/[^\n]*fast mode/i.test(example.code) && checkPolicy(analysis, { mode: 'fast', pageIsBlank: false }).allowed) continue
      const onBlankTab = checkPolicy(analysis, { mode: 'human', pageIsBlank: true })
      if (onBlankTab.allowed && /\/\/[^\n]*blank tab/i.test(example.code)) continue
      unmarked.push(`line ${example.line} (${example.heading}): ${(verdict.refusal ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
    }
    expect(unmarked, unmarked.join('\n')).toEqual([])
  })
})
