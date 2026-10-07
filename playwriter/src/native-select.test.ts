import { describe, expect, it } from 'vitest'
import { arrowPresses, keyRoute, typeAheadLanding, type SelectOptionFacts } from './native-select.js'

const options = (...labels: string[]): SelectOptionFacts[] => labels.map((label) => ({ label, disabled: false, hidden: false }))

describe('the key route to a native select option (Blink TypeAhead)', () => {
  const countries = options('Select a country', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Yemen')

  it('types until type-ahead highlights the option', () => {
    expect(keyRoute(countries, 0, 4)).toEqual({ typed: 'United K', landing: 4, arrows: 0 })
    // From "United Kingdom", one "U" moves on to the next option starting with it.
    expect(keyRoute(countries, 4, 5)).toEqual({ typed: 'U', landing: 5, arrows: 0 })
  })

  it('searches a single character from the option after the highlight, a longer prefix from the highlight itself', () => {
    expect(typeAheadLanding(countries, 1, 'U')).toBe(2)
    expect(typeAheadLanding(countries, 1, 'Ug')).toBe(1)
  })

  it('cycles through the options starting with a character typed again', () => {
    const list = options('Apple', 'Apricot', 'Avocado', 'Banana')
    expect(typeAheadLanding(list, 3, 'A')).toBe(0)
    expect(typeAheadLanding(list, 3, 'AA')).toBe(1)
    expect(typeAheadLanding(list, 3, 'AAA')).toBe(2)
  })

  it('never lands on a disabled option and counts arrows only over options the keys stop at', () => {
    const list: SelectOptionFacts[] = [
      { label: 'Choose', disabled: false, hidden: false },
      { label: 'Spain', disabled: true, hidden: false },
      { label: 'Sweden', disabled: false, hidden: false },
      { label: 'Secret', disabled: false, hidden: true },
      { label: 'Serbia', disabled: false, hidden: false },
    ]
    expect(typeAheadLanding(list, 0, 'S')).toBe(2)
    expect(arrowPresses(list, 0, 4)).toBe(2)
    expect(arrowPresses(list, 4, 0)).toBe(-2)
  })

  it('reaches the second of two options with one label with the fewest arrows after the prefix', () => {
    const sizes = options('Small', 'Medium', 'Large', 'Medium', 'Extra large')
    expect(keyRoute(sizes, 0, 3)).toEqual({ typed: 'M', landing: 1, arrows: 2 })
  })

  it('uses arrows alone for a label the keyboard cannot type', () => {
    const list = options('東京', '大阪', '京都')
    expect(keyRoute(list, 0, 2)).toEqual({ typed: '', landing: 0, arrows: 2 })
  })
})
