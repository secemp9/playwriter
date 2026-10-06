/**
 * Pure tests for turning React fiber debug info into a `file:line`, outside the page.
 * The live end-to-end path (extension picker → fiber read → source map) is in
 * page-purity.test.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  cleanSourceFileName,
  formatReactSourceLocation,
  jsxSiteFromDebugStack,
  locateReactSource,
} from './react-source-location.js'

// React 19.2's shape, as measured: the JSX site is the frame right after jsxDEV.
const STACK = [
  'Error: react-stack-top-frame',
  '    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js:250:30)',
  '    at SendButton (http://localhost:5173/assets/app.js:3:5)',
  '    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js:5000:22)',
].join('\n')

// One mapping: generated line 3, column 4 (0-based) -> sources[0] line 10 (1-based), column 2.
// VLQ segment [4, 0, 9, 2] is "IASE".
const MAP = { version: 3, sources: ['../src/ChatComposer.tsx'], names: [], mappings: ';;IASE' }
const SCRIPT = `// line 1\n// line 2\n    jsxDEV("button")\n//# sourceMappingURL=app.js.map\n`

describe('react-source-location', () => {
  it('finds the JSX site in a React 19 _debugStack', () => {
    expect(jsxSiteFromDebugStack(STACK)).toEqual({ fn: 'SendButton', url: 'http://localhost:5173/assets/app.js', line: 3, column: 5 })
  })

  it('maps a _debugStack frame through the source map the script links to', async () => {
    const fetched: string[] = []
    const result = await locateReactSource(
      { reactFound: true, frames: [{ element: 'button', owner: 'SendButton', debugSource: null, debugStack: STACK }] },
      {
        fetchText: async (url) => {
          fetched.push(url)
          if (url.endsWith('app.js')) return SCRIPT
          if (url.endsWith('app.js.map')) return JSON.stringify(MAP)
          throw new Error(`HTTP 404 for ${url}`)
        },
      },
    )
    expect(fetched).toEqual(['http://localhost:5173/assets/app.js', 'http://localhost:5173/assets/app.js.map'])
    expect(result).toEqual({
      ok: true,
      location: { fileName: 'src/ChatComposer.tsx', lineNumber: 10, columnNumber: 3, componentName: 'SendButton', via: 'sourcemap' },
    })
    if (result.ok) expect(formatReactSourceLocation(result.location)).toBe('src/ChatComposer.tsx:10')
  })

  it('reads an inline data: source map', async () => {
    const inline = SCRIPT.replace(
      'app.js.map',
      `data:application/json;base64,${Buffer.from(JSON.stringify(MAP)).toString('base64')}`,
    )
    const result = await locateReactSource(
      { reactFound: true, frames: [{ element: 'button', owner: null, debugSource: null, debugStack: STACK }] },
      { fetchText: async () => inline },
    )
    expect(result.ok && result.location.lineNumber).toBe(10)
  })

  it('says so when the position could not be mapped, instead of passing it off as source', async () => {
    const result = await locateReactSource(
      { reactFound: true, frames: [{ element: 'button', owner: 'SendButton', debugSource: null, debugStack: STACK }] },
      { fetchText: async () => 'no map here' },
    )
    expect(result).toMatchObject({ ok: true, location: { fileName: 'assets/app.js', lineNumber: 3, via: 'stack' } })
    expect(result.ok && result.location.note).toMatch(/no sourceMappingURL/)
  })

  it("prefers React ≤18's _debugSource, cleaned of bundler prefixes", async () => {
    const result = await locateReactSource(
      {
        reactFound: true,
        frames: [
          {
            element: 'div',
            owner: 'Card',
            debugSource: { fileName: 'webpack://_N_E/./(app-pages-browser)/./app/card.tsx', lineNumber: 7 },
            debugStack: null,
          },
        ],
      },
      { fetchText: async () => '' },
    )
    expect(result).toEqual({ ok: true, location: { fileName: 'app/card.tsx', lineNumber: 7, columnNumber: undefined, componentName: 'Card', via: 'debugSource' } })
  })

  it('reports a non-React element and a production build honestly', async () => {
    expect(await locateReactSource({ reactFound: false, frames: [] }, { fetchText: async () => '' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/No React fiber/),
    })
    expect(await locateReactSource({ reactFound: true, frames: [] }, { fetchText: async () => '' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Production builds strip/),
    })
  })

  it('cleans served URLs and webpack paths into project paths', () => {
    expect(cleanSourceFileName('http://localhost:5173/src/App.tsx?t=123')).toBe('src/App.tsx')
    expect(cleanSourceFileName('http://localhost:5173/@fs/home/me/lib/x.tsx')).toBe('/home/me/lib/x.tsx')
    expect(cleanSourceFileName('webpack-internal:///./src/a.tsx')).toBe('src/a.tsx')
    expect(cleanSourceFileName('file:///home/me/a.tsx')).toBe('/home/me/a.tsx')
  })
})
