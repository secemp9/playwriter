import { describe, it, expect } from 'vitest'
import {
  computeSpecificity,
  compareSpecificity,
  resolveCascade,
  type NormalizedRule,
  type Specificity,
} from './css-cascade.js'

// --- specificity ------------------------------------------------------------

describe('computeSpecificity', () => {
  it('counts id / class / type tiers', () => {
    expect(computeSpecificity('a')).toEqual([0, 0, 1])
    expect(computeSpecificity('.a')).toEqual([0, 1, 0])
    expect(computeSpecificity('.a.b')).toEqual([0, 2, 0])
    expect(computeSpecificity('#id')).toEqual([1, 0, 0])
    expect(computeSpecificity('a#id.c[href]')).toEqual([1, 2, 1])
  })

  it('orders .a.b > .a > a', () => {
    const ab = computeSpecificity('.a.b')
    const a1 = computeSpecificity('.a')
    const t = computeSpecificity('a')
    expect(compareSpecificity(ab, a1)).toBeGreaterThan(0)
    expect(compareSpecificity(a1, t)).toBeGreaterThan(0)
  })

  it('a single #id beats 100 classes', () => {
    const hundredClasses = '.' + Array.from({ length: 100 }, (_, i) => `c${i}`).join('.')
    const spec = computeSpecificity(hundredClasses)
    expect(spec).toEqual([0, 100, 0])
    expect(compareSpecificity(computeSpecificity('#id'), spec)).toBeGreaterThan(0)
  })

  it('universal selector contributes nothing', () => {
    expect(computeSpecificity('*')).toEqual([0, 0, 0])
    expect(computeSpecificity('* a')).toEqual([0, 0, 1])
  })

  it('handles combinators (descendant/child/sibling)', () => {
    expect(computeSpecificity('div > p')).toEqual([0, 0, 2])
    expect(computeSpecificity('ul li a')).toEqual([0, 0, 3])
    expect(computeSpecificity('.nav + .item')).toEqual([0, 2, 0])
  })

  it('attribute and pseudo-class count as class tier', () => {
    expect(computeSpecificity('[type="text"]')).toEqual([0, 1, 0])
    expect(computeSpecificity('a:hover')).toEqual([0, 1, 1])
    expect(computeSpecificity('li:first-child')).toEqual([0, 1, 1])
  })

  it('pseudo-elements count as type tier', () => {
    expect(computeSpecificity('p::before')).toEqual([0, 0, 2])
    // legacy single-colon syntax also counts as pseudo-element
    expect(computeSpecificity('p:before')).toEqual([0, 0, 2])
  })

  it(':not() takes the specificity of its argument', () => {
    expect(computeSpecificity(':not(.x.y)')).toEqual([0, 2, 0])
    expect(computeSpecificity('a:not(#id)')).toEqual([1, 0, 1])
    expect(computeSpecificity(':is(.a, #b, c)')).toEqual([1, 0, 0])
  })

  it(':where() contributes zero specificity', () => {
    expect(computeSpecificity(':where(#a.b.c)')).toEqual([0, 0, 0])
    expect(computeSpecificity('a:where(.b)')).toEqual([0, 0, 1])
  })

  it('takes the MAX over a comma selector list', () => {
    expect(computeSpecificity('a, .b.c, #d')).toEqual([1, 0, 0])
    expect(computeSpecificity('h1, .title')).toEqual([0, 1, 0])
  })

  it('returns [0,0,0] on parse failure', () => {
    expect(computeSpecificity('>>>invalid<<<')).toEqual([0, 0, 0])
  })
})

// --- cascade resolution -----------------------------------------------------

function rule(
  selector: string,
  declarations: Record<string, string>,
  opts: {
    important?: string[]
    origin?: string
    inline?: boolean
    order: number
    specificity?: Specificity
  },
): NormalizedRule {
  return {
    selector,
    specificity: opts.specificity ?? computeSpecificity(selector),
    declarations,
    important: new Set(opts.important ?? []),
    origin: opts.origin ?? 'regular',
    source: null,
    inline: opts.inline,
    order: opts.order,
  }
}

describe('resolveCascade', () => {
  it('higher specificity wins among normal author rules', () => {
    const rules = [
      rule('a', { color: 'red' }, { order: 0 }),
      rule('.a', { color: 'green' }, { order: 1 }),
      rule('.a.b', { color: 'blue' }, { order: 2 }),
    ]
    const { winnerFor, losersFor } = resolveCascade(rules)
    expect(winnerFor.color.selector).toBe('.a.b')
    expect(winnerFor.color.value).toBe('blue')
    // losers ordered highest → lowest priority
    expect(losersFor.color.map((l) => l.selector)).toEqual(['.a', 'a'])
  })

  it('!important beats a higher-specificity normal declaration', () => {
    const rules = [
      rule('#id.strong', { color: 'blue' }, { order: 0 }),
      rule('a', { color: 'red' }, { order: 1, important: ['color'] }),
    ]
    const { winnerFor } = resolveCascade(rules)
    expect(winnerFor.color.selector).toBe('a')
    expect(winnerFor.color.important).toBe(true)
    expect(winnerFor.color.value).toBe('red')
  })

  it('inline normal beats author normal (even higher specificity)', () => {
    const rules = [
      rule('#nav .link.active', { color: 'green' }, { order: 0 }),
      rule('element.style', { color: 'purple' }, { order: 99, inline: true, specificity: [0, 0, 0] }),
    ]
    const { winnerFor } = resolveCascade(rules)
    expect(winnerFor.color.value).toBe('purple')
    expect(winnerFor.color.selector).toBe('element.style')
  })

  it('inline important beats author-selector important', () => {
    const rules = [
      rule('#x', { color: 'blue' }, { order: 0, important: ['color'] }),
      rule('element.style', { color: 'red' }, { order: 99, inline: true, important: ['color'], specificity: [0, 0, 0] }),
    ]
    const { winnerFor } = resolveCascade(rules)
    expect(winnerFor.color.value).toBe('red')
    expect(winnerFor.color.selector).toBe('element.style')
    expect(winnerFor.color.important).toBe(true)
  })

  it('important user-agent beats important author', () => {
    const rules = [
      rule('.author', { display: 'block' }, { order: 5, important: ['display'] }),
      rule('div', { display: 'none' }, { order: 0, origin: 'user-agent', important: ['display'] }),
    ]
    const { winnerFor } = resolveCascade(rules)
    expect(winnerFor.display.value).toBe('none')
    expect(winnerFor.display.origin).toBe('user-agent')
  })

  it('user-agent normal loses to author normal', () => {
    const rules = [
      rule('div', { margin: '8px' }, { order: 0, origin: 'user-agent' }),
      rule('.box', { margin: '0' }, { order: 1 }),
    ]
    const { winnerFor } = resolveCascade(rules)
    expect(winnerFor.margin.value).toBe('0')
    expect(winnerFor.margin.selector).toBe('.box')
  })

  it('source order breaks ties at equal specificity (later wins)', () => {
    const rules = [
      rule('.btn', { color: 'red' }, { order: 0 }),
      rule('.btn', { color: 'green' }, { order: 1 }),
    ]
    const { winnerFor, losersFor } = resolveCascade(rules)
    expect(winnerFor.color.value).toBe('green')
    expect(losersFor.color[0].value).toBe('red')
  })

  it('tracks winners and losers per property independently', () => {
    const rules = [
      rule('a', { color: 'red', 'font-size': '10px' }, { order: 0 }),
      rule('.a', { color: 'blue' }, { order: 1 }),
    ]
    const { winnerFor, losersFor } = resolveCascade(rules)
    expect(winnerFor.color.value).toBe('blue')
    expect(winnerFor['font-size'].value).toBe('10px')
    expect(losersFor['font-size']).toEqual([])
    expect(losersFor.color.map((l) => l.value)).toEqual(['red'])
  })
})
