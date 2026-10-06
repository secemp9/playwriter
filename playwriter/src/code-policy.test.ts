/**
 * code-policy: what analyzeCode sees in real model-written execute code, and what
 * checkPolicy lets through in human vs debug mode. The cases are the shapes from the
 * incident log (page.goto mid-flow, batched actions, loops, route/delay fakes,
 * page.evaluate DOM pokes, direct fetches) plus the false-positive traps a regex
 * classifier falls into.
 */

import { describe, it, expect } from 'vitest'
import { analyzeCode, checkPolicy, hasExplicitReturn, ACT_INPUT_METHODS, ACT_WAIT_METHODS, type CodeAnalysis } from './code-policy.js'

interface Summary {
  input: string[]
  nav: string[]
  forced: string[]
  bypass: string[]
  waits: string[]
  unreadable: string[]
}

/** A compact view of an analysis: `api@line` per category. */
function summary(analysis: CodeAnalysis): Summary {
  return {
    input: analysis.inputActions.map((s) => `${s.api}@${s.line}${s.loop ? ' loop' : ''}${s.viaAct ? ' act' : ''}`),
    nav: analysis.navigations.map((s) => `${s.api}@${s.line} ${s.kind}`),
    forced: analysis.forcedState.map((s) => `${s.api}@${s.line}`),
    bypass: analysis.apiBypass.map((s) => `${s.api}@${s.line}`),
    waits: analysis.waits.map((s) => `${s.api}@${s.line}`),
    unreadable: analysis.unanalysable.map((s) => `${s.api}@${s.line}`),
  }
}

const EMPTY: Summary = { input: [], nav: [], forced: [], bypass: [], waits: [], unreadable: [] }

describe('analyzeCode', () => {
  const cases: Array<{ name: string; code: string; expected: Partial<Summary> }> = [
    {
      name: 'chained getByRole click is one input action',
      code: "await page.getByRole('button', { name: 'Send' }).click()",
      expected: { input: ["page.getByRole('button', { name: 'Send' }).click@1"] },
    },
    {
      name: "locator('a').click() counts once, not once per call in the chain",
      code: "await page.locator('a').first().click()",
      expected: { input: ["page.locator('a').first().click@1"] },
    },
    {
      name: 'multi-line chain reports the line of the action, not of `page`',
      code: "await page\n  .getByRole('link', { name: 'Docs' })\n  .click()",
      expected: { input: ["page.getByRole('link', { name: 'Docs' }).click@3"] },
    },
    {
      name: 'msg.type() is the console message getter, not typing',
      code: "page.on('console', (msg) => { if (msg.type() === 'error') console.log(msg.text()) })",
      expected: EMPTY,
    },
    {
      name: 'keyboard, mouse, touchscreen and humanMouse are input',
      code: [
        "await page.keyboard.press('Enter')",
        'await page.mouse.click(10, 20)',
        'await page.touchscreen.tap(5, 5)',
        "await humanMouse.click({ locator: page.locator('#go') })",
        "await page.keyboard.insertText('hi')",
      ].join('\n'),
      expected: {
        input: ['page.keyboard.press@1', 'page.mouse.click@2', 'page.touchscreen.tap@3', 'humanMouse.click@4', 'page.keyboard.insertText@5'],
      },
    },
    {
      name: 'focus() on a locator is not input',
      code: "await page.locator('input').focus()",
      expected: EMPTY,
    },
    {
      name: 'act input, dialogs, navigation and waits',
      code: "await act.click(12)\nawait act.dialog.accept()\nawait act.spaNavigate('/cart')\nawait act.waitForIdle()\nawait act.wait(500)",
      expected: {
        input: ['act.click@1 act', 'act.dialog.accept@2 act'],
        nav: ['act.spaNavigate@3 spa'],
        waits: ['act.waitForIdle@4', 'act.wait@5'],
      },
    },
    {
      name: 'page.goto inside a comment and "return" inside a string are not code',
      code: "// first: await page.goto('http://localhost:3000')\nconst label = 'return to cart'\nconsole.log(label)",
      expected: EMPTY,
    },
    {
      name: 'goto / reload / goBack / setContent are navigations',
      code: "await page.goto('http://x')\nawait page.reload()\nawait page.goBack()\nawait page.setContent('<p>x</p>')",
      expected: {
        nav: ['page.goto@1 document', 'page.reload@2 document', 'page.goBack@3 history', 'page.setContent@4 document'],
      },
    },
    {
      name: '.click() inside page.evaluate is a synthetic event, not input',
      code: "await page.evaluate(() => {\n  document.querySelector('button').click()\n})",
      expected: { input: [], forced: ["document.querySelector('button').click@2"] },
    },
    {
      name: 'page-code DOM, style, storage, event and React writes are forced state',
      code: [
        'await page.evaluate(() => {',
        "  const el = document.querySelector('#x')",
        "  el.innerHTML = '<b>hi</b>'",
        "  el.style.pointerEvents = 'none'",
        "  el.dispatchEvent(new MouseEvent('click'))",
        "  localStorage.setItem('k', 'v')",
        "  document.cookie = 'a=1'",
        "  el.classList.add('open')",
        '  el.__reactProps$abc.onClick()',
        "  el.setAttribute('aria-expanded', 'true')",
        '})',
      ].join('\n'),
      expected: {
        forced: [
          'el.innerHTML =@3',
          'el.style.pointerEvents =@4',
          'el.dispatchEvent@5',
          'new MouseEvent@5',
          'localStorage.setItem@6',
          'document.cookie =@7',
          'el.classList.add@8',
          'el.__reactProps$abc.onClick@9',
          'el.setAttribute@10',
        ],
      },
    },
    {
      name: 'reading through page.evaluate is not forced state',
      code: "const t = await page.evaluate(() => document.querySelector('h1').textContent)\nreturn t",
      expected: EMPTY,
    },
    {
      name: 'string page code is parsed as page code, at the right line',
      code: "\nawait page.evaluate(\"document.body.innerHTML = ''\")",
      expected: { forced: ['document.body.innerHTML =@2'] },
    },
    {
      name: '$eval: the page function is the second argument',
      code: "await page.$eval('#q', (el) => { el.value = 'shoes' })",
      expected: { forced: ['el.value =@1'] },
    },
    {
      name: 'a function passed to evaluate by name is page code',
      code: "const poke = () => { document.querySelector('a').click() }\nawait page.evaluate(poke)",
      expected: { input: [], forced: ["document.querySelector('a').click@1"] },
    },
    {
      name: 'navigation from page code',
      code: "await page.evaluate(() => { location.href = '/a' })\nawait page.evaluate(() => history.pushState({}, '', '/b'))\nawait page.evaluate(() => window.history.back())",
      expected: { nav: ['location.href =@1 document', 'history.pushState@2 spa', 'window.history.back@3 history'] },
    },
    {
      name: 'network fakes and injections are forced state',
      code: [
        "await page.route('**/api/**', (route) => route.fulfill({ status: 500 }))",
        "await net.delay('/api/reviews', 3000)",
        "await page.addInitScript(() => { window.x = 1 })",
        'await context.setOffline(true)',
        "await page.locator('#b').dispatchEvent('click')",
      ].join('\n'),
      expected: {
        forced: ['page.route@1', 'route.fulfill@1', 'net.delay@2', 'page.addInitScript@3', 'window.x =@3', 'context.setOffline@4', "page.locator('#b').dispatchEvent@5"],
      },
    },
    {
      name: 'force: true is a click a person may not be able to make',
      code: "await page.locator('#hidden').click({ force: true })",
      expected: { input: ["page.locator('#hidden').click@1"], forced: ["page.locator('#hidden').click@1"] },
    },
    {
      name: 'direct backend calls',
      code: "await fetch('/api/user')\nconst http = require('node:http')\nawait page.request.post('/api/x')\nawait page.evaluate(() => fetch('/api/y'))",
      expected: {
        bypass: ['fetch@1', "require('node:http')@2", 'page.request.post@3', 'fetch@4'],
        forced: ['fetch@4'],
      },
    },
    {
      name: 'loops and concurrent callbacks mark input as inLoop',
      code: [
        "for (const b of await page.locator('button').all()) await b.click()",
        "items.forEach((i) => page.locator(i).hover())",
        "await Promise.all([page.click('#a'), page.waitForNavigation()])",
        "let n = 0; while (n++ < 3) { await act.press('ArrowDown') }",
      ].join('\n'),
      expected: {
        input: ['b.click@1 loop', 'page.locator(i).hover@2 loop', 'page.click@3 loop', 'act.press@4 loop act'],
        waits: ['page.waitForNavigation@3'],
      },
    },
    {
      name: 'array fill / Map clear are not input',
      code: 'const arr = new Array(3).fill(0)\nconst seen = new Map()\nseen.clear()\nconst xs = [1, 2]\nxs.fill(9)',
      expected: EMPTY,
    },
    {
      name: 'Playwright waits',
      code: "await page.waitForSelector('.done')\nawait page.waitForLoadState('load')\nawait page.locator('x').waitFor()\nawait waitForPageLoad({ page })\nawait page.waitForTimeout(100)\nawait page.waitForURL('**/b')\nawait page.waitForResponse('**/api')",
      expected: {
        waits: [
          'page.waitForSelector@1',
          'page.waitForLoadState@2',
          "page.locator('x').waitFor@3",
          'waitForPageLoad@4',
          'page.waitForTimeout@5',
          'page.waitForURL@6',
          'page.waitForResponse@7',
        ],
      },
    },
    {
      name: 'Object.prototype names are not table hits',
      code: 'const s = page.url().toString()\nconst c = state.constructor',
      expected: EMPTY,
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      const analysis = analyzeCode(testCase.code)
      expect(analysis.parseError).toBeUndefined()
      expect(summary(analysis)).toEqual({ ...EMPTY, ...testCase.expected })
    })
  }

  it('act.open records a literal reason; a computed one is not a reason', () => {
    const literal = analyzeCode("await act.open('http://x/', { reason: 'testing a cold cache' })")
    expect(literal.navigations).toEqual([{ api: 'act.open', line: 1, kind: 'document', viaAct: true, reason: 'testing a cold cache' }])
    const computed = analyzeCode("await act.open('http://x/', { reason: why })")
    expect(computed.navigations[0].reason).toBeUndefined()
  })

  it('loop sites name the construct', () => {
    const analysis = analyzeCode("for (const k of keys) await page.keyboard.press(k)\nawait Promise.all([act.click(1)])")
    expect(analysis.inputActions.map((s) => s.loop)).toEqual(['a for…of loop', 'Promise.all'])
  })

  it('reports a parse error instead of throwing', () => {
    const analysis = analyzeCode('await page.click(')
    expect(analysis.parseError).toMatch(/line 1, column \d+/)
    expect(analysis.inputActions).toEqual([])
  })
})

describe('hasExplicitReturn', () => {
  it.each([
    ['return await page.title()', true],
    ['if (x) { return 1 }', true],
    ["const s = 'return value'", false],
    ['// return early\nawait page.title()', false],
    ['const f = () => { return 1 }; f()', false],
    ["await page.evaluate(() => { return document.title })", false],
    ['return (', false],
  ])('%j → %s', (code, expected) => {
    expect(hasExplicitReturn(code)).toBe(expected)
  })
})

describe('checkPolicy', () => {
  const human = { mode: 'human' as const, pageIsBlank: false }
  const humanBlank = { mode: 'human' as const, pageIsBlank: true }
  const debug = { mode: 'debug' as const, pageIsBlank: false }

  it('exports the act method lists', () => {
    expect(ACT_INPUT_METHODS).toContain('click')
    expect(ACT_INPUT_METHODS).toContain('drag')
    expect(ACT_WAIT_METHODS).toEqual(['waitForIdle', 'wait'])
  })

  it('allows one action plus any number of waits and reads', () => {
    const verdict = checkPolicy(
      analyzeCode("await act.click(3)\nawait act.waitForIdle()\nconst o = await observe()\nreturn await getLatestLogs({ page })"),
      human,
    )
    expect(verdict).toEqual({ allowed: true, notes: [] })
  })

  it('refuses page.goto on a loaded page with the teaching text', () => {
    const verdict = checkPolicy(analyzeCode("await page.goto('http://localhost:3030/products')"), human)
    expect(verdict.allowed).toBe(false)
    expect(verdict.refusal).toBe(
      "Refused (human mode): page.goto on line 1 would reload the whole document — client-side caches and in-memory state (SWR, React Query, Redux) are wiped, which a person clicking around never does, so a repro made this way is biased. Navigate like a user: observe() lists links with their URLs — act.click(ref) the link, or act.spaNavigate('/path') for an in-app route. If a full reload is genuinely what you are testing, use act.open(url, { reason: '…' }).\nNothing from this call was run.",
    )
  })

  it('allows page.goto as the first load of a blank tab', () => {
    const verdict = checkPolicy(analyzeCode("await page.goto('http://localhost:3030')"), humanBlank)
    expect(verdict.allowed).toBe(true)
    expect(verdict.notes).toEqual(['page.goto on line 1 is the first load of a blank tab.'])
  })

  it('allows act.open with a reason and act.back, and notes them', () => {
    const open = checkPolicy(analyzeCode("await act.open('http://x/', { reason: 'cold cache is the bug' })"), human)
    expect(open.allowed).toBe(true)
    expect(open.notes[0]).toContain('reason: "cold cache is the bug"')
    const back = checkPolicy(analyzeCode('await act.back()'), human)
    expect(back.allowed).toBe(true)
    expect(back.notes).toEqual(["act.back on line 1 goes back in history like the browser's Back button."])
  })

  it('refuses act.open without a reason and page.goBack', () => {
    const open = checkPolicy(analyzeCode("await act.open('http://x/')"), human)
    expect(open.allowed).toBe(false)
    expect(open.refusal).toContain('act.open on line 1 has no reason')
    const back = checkPolicy(analyzeCode('await page.goBack()'), human)
    expect(back.allowed).toBe(false)
    expect(back.refusal).toContain('use act.back()')
  })

  it('refuses location.href= from page code', () => {
    const verdict = checkPolicy(analyzeCode("await page.evaluate(() => { location.href = '/login' })"), human)
    expect(verdict.allowed).toBe(false)
    expect(verdict.refusal).toContain('location.href = in page code on line 1 would load a new document')
  })

  it('refuses several actions and names the first one', () => {
    const verdict = checkPolicy(analyzeCode("await act.fill(4, 'a@b.c')\nawait act.click(7)\nawait act.waitForIdle()"), human)
    expect(verdict.allowed).toBe(false)
    expect(verdict.refusal).toContain('this call does 2 input actions — act.fill on line 1, act.click on line 2')
    expect(verdict.refusal).toContain('Do the first one — act.fill(…) on line 1 — then read the report and decide the next.')
  })

  it('counts a navigation as an action', () => {
    const verdict = checkPolicy(analyzeCode("await act.spaNavigate('/cart')\nawait act.click(2)"), human)
    expect(verdict.allowed).toBe(false)
    expect(verdict.refusal).toContain('this call does 2 input actions')
  })

  it('refuses a single action inside a loop', () => {
    const verdict = checkPolicy(analyzeCode("for (let i = 0; i < 5; i++) await act.press('ArrowDown')"), human)
    expect(verdict.allowed).toBe(false)
    expect(verdict.refusal).toContain('act.press on line 1 runs inside a for loop')
  })

  it('refuses forced state and API bypass with their own texts', () => {
    const forced = checkPolicy(analyzeCode("await net.delay('/api/x', 2000)"), human)
    expect(forced.allowed).toBe(false)
    expect(forced.refusal).toContain('net.delay on line 1 (delays network responses artificially)')
    expect(forced.refusal).toContain('fake the conditions the bug needs')
    const cursor = checkPolicy(analyzeCode('await ghostCursor.show()'), human)
    expect(cursor.allowed).toBe(false)
    expect(cursor.refusal).toContain('ghostCursor.show on line 1 (adds a cursor element and a global to the page')
    expect(checkPolicy(analyzeCode('await ghostCursor.hide()'), human).allowed).toBe(true)
    const bypass = checkPolicy(analyzeCode("await page.evaluate(() => fetch('/user/info'))"), human)
    expect(bypass.allowed).toBe(false)
    expect(bypass.refusal).toContain('the UI is what is under test; drive it like a user, read the backend log for the server side')
    // The in-page fetch is reported once, as a bypass, not again as forced state.
    expect(bypass.refusal).not.toContain('forced state')
  })

  it('refuses code that does not parse in human mode, allows it in debug', () => {
    const analysis = analyzeCode('await act.click(')
    expect(checkPolicy(analysis, human).allowed).toBe(false)
    expect(checkPolicy(analysis, debug).allowed).toBe(true)
  })

  it('debug mode allows everything and lists what it saw', () => {
    const verdict = checkPolicy(
      analyzeCode("await page.goto('http://x')\nawait page.route('**', (r) => r.abort())\nawait page.click('a')\nawait page.click('b')"),
      debug,
    )
    expect(verdict.allowed).toBe(true)
    expect(verdict.refusal).toBeUndefined()
    expect(verdict.notes).toEqual([
      "2 input actions: page.click on line 3, page.click on line 4",
      'navigation: page.goto on line 1 (document)',
      'forced state: page.route on line 2 (intercepts network requests and answers them from the script)',
    ])
  })
})

/**
 * Human mode decides by bindings, not by names: aliases and computed keys reach the same verdict
 * as the plain call, the code's own `style`/`row`/`location` objects are not the page's, actions
 * in helpers count per call, page code that cannot be read is refused, and the URL may change
 * only through a real link (act.click / act.spaNavigate).
 */
describe('checkPolicy by bindings (human mode)', () => {
  const human = { mode: 'human' as const, pageIsBlank: false }
  const refused: Array<{ name: string; code: string; says: string }> = [
    { name: 'navigation in a loop', code: "for (const u of urls) await act.open(u, { reason: 'cold cache' })", says: 'act.open on line 1 runs inside a for…of loop' },
    {
      name: 'helper called twice',
      code: 'const go = async (n) => { await act.click(n) }\nawait go(1)\nawait go(2)',
      says: 'act.click on line 1 runs inside helper go(), called on lines 2, 3',
    },
    {
      name: 'helper called from a loop',
      code: 'async function tap(n) { await act.click(n) }\nfor (const n of [1, 2]) await tap(n)',
      says: 'act.click on line 1 runs inside a for…of loop (through helper tap() on line 2)',
    },
    {
      name: 'helper passed to forEach',
      code: 'const go = (n) => act.click(n);\n[1, 2].forEach(go)',
      says: 'runs inside a .forEach callback (through helper go() on line 2)',
    },
    { name: 'aliased act', code: 'const a = act\nawait a.click(1)\nawait a.click(2)', says: 'this call does 2 input actions — act.click on line 2, act.click on line 3' },
    { name: 'destructured act method', code: 'const { click } = act\nawait click(1)\nawait click(2)', says: 'this call does 2 input actions' },
    { name: 'aliased page.mouse', code: 'const m = page.mouse\nawait m.click(1, 2)\nawait m.click(3, 4)', says: 'this call does 2 input actions — m.click on line 2, m.click on line 3' },
    { name: 'computed act key', code: "await act['cl' + 'ick'](1)\nawait act.click(2)", says: 'this call does 2 input actions' },
    { name: 'act method through .call', code: 'await act.click.call(act, 1)\nawait act.click(2)', says: 'this call does 2 input actions' },
    { name: 'computed navigation key', code: "const g = 'goto'\nawait page[g]('http://x/')", says: 'would reload the whole document' },
    { name: 'act method name unknown', code: 'await act[name](1)', says: 'is unanalysable — calls an act method whose name is computed at run time' },
    { name: 'with statement', code: 'with (act) { await click(1) }', says: 'with on line 1 is unanalysable' },
    { name: 'page code from a variable', code: 'await page.evaluate(script)', says: 'page.evaluate on line 1 is unanalysable — its page code comes from `script`' },
    { name: 'page code from an object property', code: 'await page.evaluate(helpers.poke)', says: 'its page code is `helpers.poke`, which is only known at run time' },
    {
      name: 'page code through a wrapper',
      code: 'const inPage = (fn) => page.evaluate(fn)\nawait inPage(() => document.title)',
      says: 'its page code comes from `fn`, a parameter of the function around it',
    },
    { name: 'page code built by concatenation', code: "await page.evaluate('document.querySelector(\"' + sel + '\").remove()')", says: 'is unanalysable' },
    { name: 'eval in page code', code: "await page.evaluate(() => eval('document.body.remove()'))", says: 'eval on line 1 is unanalysable' },
    { name: 'string timer in page code', code: "await page.evaluate(() => setTimeout('document.body.remove()', 0))", says: 'setTimeout on line 1 is unanalysable' },
    {
      name: 'pushState in page code',
      code: "await page.evaluate(() => history.pushState({}, '', '/cart'))",
      says: "history.pushState in page code on line 1 changes the URL from a script. The app's router does not take part",
    },
    { name: 'hash write in page code', code: "await page.evaluate(() => { location.hash = '#/done' })", says: 'location.hash = in page code on line 1 changes the URL from a script' },
    { name: 'location.replace in page code', code: "await page.evaluate(() => { window.location.replace('/x') })", says: 'would load a new document' },
    {
      name: 'the vm code declaring `location` does not make the page global local',
      code: "const location = 'x'\nawait page.evaluate(() => { location.href = '/a' })",
      says: 'location.href = in page code on line 2 would load a new document',
    },
    { name: 'style write through an alias', code: "await page.evaluate(() => { const s = document.body.style; s.color = 'red' })", says: 's.color = on line 1 (changes styles from a script)' },
    { name: 'computed DOM property', code: "await page.evaluate(() => { document.body['inner' + 'HTML'] = '' })", says: "(writes the DOM from a script)" },
    { name: 'page global write', code: 'await page.evaluate(() => { flags = 1 })', says: 'flags = on line 1 (writes a global of the page)' },
    { name: 'write into a page object', code: "await page.evaluate(() => { document.title = 'x' })", says: 'document.title = on line 1 (writes a property of a page object from a script)' },
  ]
  for (const testCase of refused) {
    it(`refuses: ${testCase.name}`, () => {
      const verdict = checkPolicy(analyzeCode(testCase.code), human)
      expect(verdict.allowed).toBe(false)
      expect(verdict.refusal).toContain(testCase.says)
    })
  }

  const allowed: Array<{ name: string; code: string }> = [
    { name: 'a local style object', code: 'return await page.evaluate(() => { const style = {}; style.color = getComputedStyle(document.body).color; return style })' },
    { name: 'a local row object', code: "return await page.evaluate(() => { const row = {}; row.value = document.querySelector('input').value; return row })" },
    { name: 'a local location object', code: "return await page.evaluate(() => { const location = { href: 'x' }; location.href = 'y'; return location })" },
    { name: 'nested data the page code made', code: 'return await page.evaluate(() => { const data = { rows: [] }; data.rows.push(1); data.count = 2; return data })' },
    { name: 'values passed as arguments', code: "const sel = '#q'\nreturn await page.evaluate((s) => document.querySelector(s).textContent, sel)" },
    { name: 'a constant string of page code', code: "const js = 'document.title'\nreturn await page.evaluate(js)" },
    { name: 'a page function declared by name', code: 'function read() { return document.title }\nreturn await page.evaluate(read)' },
    {
      name: 'document.evaluate inside page code is the page API',
      code: "return await page.evaluate(() => document.evaluate('//h1', document, null, XPathResult.STRING_TYPE, null).stringValue)",
    },
    { name: 'a local object named act', code: 'const act = { click: () => 1 }\nact.click(1)\nact.click(2)' },
    { name: "the code's own array methods", code: 'const items = []\nitems.push(await page.title())\nawait act.click(3)' },
    { name: 'one action through an alias', code: 'const { click } = act\nawait click(3)\nawait act.waitForIdle()' },
    { name: 'act.spaNavigate', code: "await act.spaNavigate('/cart')" },
  ]
  for (const testCase of allowed) {
    it(`allows: ${testCase.name}`, () => {
      const verdict = checkPolicy(analyzeCode(testCase.code), human)
      expect(verdict.refusal).toBeUndefined()
      expect(verdict.allowed).toBe(true)
    })
  }
})
