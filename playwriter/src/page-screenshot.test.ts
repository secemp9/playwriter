/**
 * page-screenshot.ts without a browser: the pixel comparison and crop, and how the code policy
 * classifies screenshot() / diffScreenshot() in human and debug mode.
 */

import { describe, expect, it } from 'vitest'
import { analyzeCode, checkPolicy } from './code-policy.js'
import { cropImage, diffPixels } from './page-screenshot.js'
import type { DecodedPng } from './png-pixels.js'

function solid(width: number, height: number, rgb: [number, number, number]): DecodedPng {
  const data = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) data.set(rgb, i * 3)
  return { width, height, channels: 3, data }
}

describe('diffPixels', () => {
  it('counts changed pixels, bounds them, and paints them red on a faded baseline', () => {
    const base = solid(10, 10, [0, 0, 0])
    const now = solid(10, 10, [0, 0, 0])
    for (const [x, y] of [[2, 3], [5, 7]]) now.data.set([9, 9, 9], (y * 10 + x) * 3)
    const diff = diffPixels(base, now, 0)
    expect(diff).toMatchObject({ changedPixels: 2, totalPixels: 100, ratio: 0.02, box: { x: 2, y: 3, width: 4, height: 5 } })
    expect([...diff.image.data.subarray((3 * 10 + 2) * 3, (3 * 10 + 2) * 3 + 3)]).toEqual([255, 0, 0])
    expect([...diff.image.data.subarray(0, 3)]).toEqual([170, 170, 170])
  })

  it('ignores channel differences up to the tolerance', () => {
    const base = solid(4, 4, [100, 100, 100])
    const now = solid(4, 4, [103, 98, 100])
    expect(diffPixels(base, now, 3)).toMatchObject({ changedPixels: 0, box: null })
    expect(diffPixels(base, now, 2).changedPixels).toBe(16)
  })

  it('compares RGB with RGBA by colour', () => {
    const rgba: DecodedPng = { width: 1, height: 1, channels: 4, data: new Uint8Array([1, 2, 3, 255]) }
    expect(diffPixels(solid(1, 1, [1, 2, 3]), rgba, 0).changedPixels).toBe(0)
  })

  it('refuses images of different sizes', () => {
    expect(() => diffPixels(solid(2, 2, [0, 0, 0]), solid(3, 2, [0, 0, 0]), 0)).toThrow('sizes differ: 2×2 and 3×2')
  })
})

describe('cropImage', () => {
  it('copies the rows of the box', () => {
    const image = solid(4, 3, [0, 0, 0])
    image.data.set([7, 8, 9], (1 * 4 + 2) * 3)
    const crop = cropImage(image, { x: 2, y: 1, width: 2, height: 2 })
    expect([crop.width, crop.height]).toEqual([2, 2])
    expect([...crop.data.subarray(0, 3)]).toEqual([7, 8, 9])
  })
})

describe('code policy for screenshots', () => {
  const human = { mode: 'human' as const, pageIsBlank: false }
  const debug = { mode: 'debug' as const, pageIsBlank: false }

  it('lets window, ref, ifChanged and diff captures through as reads in both modes', () => {
    for (const code of [
      'return await screenshot()',
      "return await screenshot({ ref: 12, path: 'a.png', ifChanged: true, threshold: 0.01 })",
      "return await diffScreenshot('a.png', { output: 'd.png' })",
      'await act.click(3)\nreturn await screenshot({ ifChanged: true })',
    ]) {
      expect(checkPolicy(analyzeCode(code), human).allowed, code).toBe(true)
      expect(checkPolicy(analyzeCode(code), debug).allowed, code).toBe(true)
    }
  })

  it('refuses fullPage in human mode only, naming what it does to the page', () => {
    for (const code of ['return await screenshot({ fullPage: true })', "return await diffScreenshot('a.png', { fullPage: !0 })"]) {
      const verdict = checkPolicy(analyzeCode(code), human)
      expect(verdict.allowed, code).toBe(false)
      expect(verdict.refusal).toContain('({ fullPage: true }) on line 1')
      expect(verdict.refusal).toContain('resizes the window to 1×1 and back while it shoots')
      expect(checkPolicy(analyzeCode(code), debug).allowed).toBe(true)
    }
  })

  it('does not treat the code’s own screenshot function as the global', () => {
    expect(checkPolicy(analyzeCode('const screenshot = (o) => o\nreturn screenshot({ fullPage: true })'), human).allowed).toBe(true)
  })
})
