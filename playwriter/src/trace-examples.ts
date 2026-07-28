// ALL debug helpers below are GLOBAL VARIABLES in the sandbox.
// Call them directly — no import, no require needed.
// (The imports here are only for TypeScript type-checking of this examples file.)
import {
  page,
  pm,
  traceValue,
  storeIdentity,
  setLogpoint,
  readLogpoints,
  net,
  fiberSnapshot,
  fiberDiff,
  replayPure,
  console,
} from './debugger-examples-types.js'

// Example: trace a wrong on-screen value back toward its source (observe→act→observe)
async function traceWrongTotal() {
  // Anchor on the DOM symptom; traceValue resolves the React source + runs the
  // static backward slice, arming (never auto-running) a probe at each blind spot.
  const result = await traceValue({ selector: '[data-testid="cart-total"]' })

  // render is a token-bounded summary string — read it first.
  console.log(result.render)

  // anchor is where the symptom was pinned in author source.
  if (result.anchor) {
    console.log('anchor:', result.anchor.componentName, '@', result.anchor.file, result.anchor.line)
  }

  // Each blocked leaf names its blind spot + the probe that would resolve it.
  // NEVER fabricate a value past a `blockedBy` — run the armed probe instead.
  for (const leaf of result.blocked) {
    console.log(`[${leaf.id}] blockedBy=${leaf.blockedBy} probe=${leaf.probe?.type} passive=${leaf.probe?.passive}`)
  }

  // Drill into one hop losslessly without re-tracing.
  if (result.blocked.length > 0) {
    console.log('hop detail:', result.expand(result.blocked[0].id))
  }
}

// Example: trace from a PageModel handle instead of a bare selector
async function traceFromHandle() {
  const handle = await pm.anchor('[data-testid="cart-total"]')
  if (!handle) return
  const result = await traceValue({ node: handle })
  console.log(result.render)
}

// Example: archetype 1 — mutating reducer. Prove an in-place store mutation.
async function proveMutatingReducer() {
  // storeIdentity captures the store-state ref, runs the action, re-captures.
  // sameReference:true is the fingerprint of a reducer that mutates instead of
  // returning a fresh object (so React bails out of the re-render).
  const { sameReference, captured } = await storeIdentity({
    action: async () => {
      await page.locator('button:has-text("Add to cart")').click()
    },
  })
  console.log('captured store:', captured, 'mutated in place:', sameReference)
}

// Example: archetype 2 — cross-module util. Capture args via an entry logpoint.
async function captureUtilArgs() {
  // Arm a logpoint at the util's call site, trigger the flow, then drain the log.
  await setLogpoint({ file: 'src/lib/format-money.ts', line: 12, expr: 'cents', tag: 'money' })
  await page.locator('button:has-text("Checkout")').click()
  const hits = await readLogpoints({ tag: 'money' })
  for (const hit of hits) {
    console.log('formatMoney arg:', hit.tag, '=>', hit.value)
  }
}

// Example: archetype 3 — async race. Passive timeline first, then force the race.
async function forceAsyncRace() {
  // Passive capture is non-perturbing and safe to auto-run.
  const timeline = net.timeline({ urlPattern: '/api/cart' })
  await page.locator('button:has-text("Add to cart")').click()
  await page.locator('button:has-text("Checkout")').click()
  console.log('request/response order:', timeline.entries())
  timeline.stop()

  // net.delay is PERTURBING — it holds matching requests so the race reproduces
  // deterministically. Always stop() it afterward.
  const hold = await net.delay({ urlPattern: '/api/cart', ms: 800 })
  await page.locator('button:has-text("Checkout")').click()
  await hold.stop()
}

// Example: archetype 4 — stale effect deps. Diff two fiber snapshots across a render.
async function diffStaleEffect() {
  const loc = page.locator('[data-testid="live-price"]')
  const before = await fiberSnapshot({ locator: loc })
  await page.locator('button:has-text("Refresh")').click()
  const after = await fiberSnapshot({ locator: loc })

  const diff = fiberDiff(before, after)
  console.log('same component:', diff.sameComponent)
  console.log('changed props:', diff.changedProps)
  console.log('added / removed:', diff.addedProps, diff.removedProps)
  console.log('hierarchy depth moved:', diff.changedHierarchyDepth)
}

// Example: re-run a pure sliced function in-process with captured args
async function replayPureFunction() {
  // replayPure refuses impure functions (they depend on runtime state not present
  // here) with a reason + the offending free identifiers.
  const result = replayPure({
    fn: '(items) => items.reduce((sum, i) => sum + i.price * i.qty, 0)',
    args: [[{ price: 10, qty: 2 }, { price: 5, qty: 1 }]],
  })
  if (result.ok) {
    console.log('replayed value:', result.value)
  } else {
    console.log('refused:', result.reason, 'free identifiers:', result.freeIdentifiers)
  }
}

export {
  traceWrongTotal,
  traceFromHandle,
  proveMutatingReducer,
  captureUtilArgs,
  forceAsyncRace,
  diffStaleEffect,
  replayPureFunction,
}
