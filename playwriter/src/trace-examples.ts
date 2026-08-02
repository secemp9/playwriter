// ALL debug helpers below are GLOBAL VARIABLES in the sandbox.
// Call them directly — no import, no require needed.
// (The imports here are only for TypeScript type-checking of this examples file.)
// `{ page: state.page }` is NOT optional on any of these. Every helper that accepts an
// optional `page` falls back to the sandbox `page` global — the DEFAULT tab — so a task
// that stored its tab in `state.page` and omitted the option inspects the wrong one.
import {
  state,
  pm,
  traceValue,
  storeIdentity,
  setLogpoint,
  readLogpoints,
  net,
  fiberSnapshot,
  fiberDiff,
  replayPure,
  replayPureAsync,
  moduleGraph,
  inspectBinding,
  evaluateBinding,
  findMissingDeps,
  isPureFunctionSource,
  backwardSlice,
  console,
} from './debugger-examples-types.js'
import type { NetEntry } from './trace.js'

// Example: trace a wrong on-screen value back toward its source (observe→act→observe)
async function traceWrongTotal() {
  // Anchor on the DOM symptom; traceValue resolves the React source + runs the
  // static backward slice, arming (never auto-running) a probe at each blind spot.
  // `root` defaults to the SESSION's cwd. Pass it explicitly when the app source lives
  // somewhere else — the module graph is only as good as the tree it was parsed over.
  // This needs author source on disk AND a React dev build: the start of the slice comes
  // from the fiber's source location, which production builds omit. Without both you get
  // a single hop with blockedBy:'dynamic' and a "could not determine a start" note; that
  // is the signal to drop to createDebugger / setLogpoint, not to retry traceValue.
  const result = await traceValue({ page: state.page, selector: '[data-testid="cart-total"]', root: '/abs/repo/root' })

  // render is a METHOD with a line budget — read it first. The collapse is announced.
  console.log(result.render())
  console.log(result.render({ maxLines: 20, codeFrames: false }))

  // warnings names live PERTURBING probes and blind spots this build has no probe for.
  // A forgotten net.delay poisons every timing measurement, and it says so here.
  for (const warning of result.warnings) console.log('!', warning)

  // anchor is where the symptom was pinned in author source.
  if (result.anchor) {
    console.log('anchor:', result.anchor.componentName, '@', result.anchor.file, result.anchor.line)
  }

  // Each blocked leaf names its blind spot + the probe that would resolve it.
  // NEVER fabricate a value past a `blockedBy` — run the armed probe instead.
  for (const leaf of result.blocked) {
    console.log(`[${leaf.id}] blockedBy=${leaf.blockedBy} probe=${leaf.probe?.type} passive=${leaf.probe?.passive}`)
    // budget-hops / cycle / parse-error are STATIC remedies: the probe type is
    // 'static-remedy' and running a runtime probe would tell you nothing. For
    // budget-hops the fix is a bigger `maxHops`, not runtime evidence.
    if (leaf.blockedBy === 'budget-hops') {
      console.log('  → re-run with a bigger maxHops; there is nothing to observe here')
    }
  }

  // Drill into a hop. `expand` returns a BOUNDED SUBTREE in one call — children included,
  // with `omittedChildren` / `complete` reporting anything the caps cut.
  if (result.hopIds.length > 0) {
    const subtree = result.expand(result.hopIds[0], { depth: 3, maxNodes: 100 })
    if (subtree && !subtree.complete) console.log('cut off:', subtree.omittedChildren, 'children')
    console.log('hop detail:', subtree)
  }
}

// Example: trace from a PageModel handle instead of a bare selector.
// NOTE: traceValue's `selector` is a real Playwright selector, while pm.anchor's is a
// page-path selector / exact locator string. Identical-looking arguments, opposite rules.
async function traceFromHandle() {
  const handle = await pm.anchor('[data-testid="cart-total"]', { page: state.page })
  if (!handle) return
  const result = await traceValue({ page: state.page, node: handle })
  console.log(result.render())
}

// Example: archetype 1 — mutating reducer. Prove an in-place store mutation.
async function proveMutatingReducer() {
  // storeIdentity captures the store-state ref, runs the action, re-captures.
  const result = await storeIdentity({
    page: state.page,
    action: async () => {
      await state.page.locator('button:has-text("Add to cart")').click()
    },
  })

  // CHECK `measured` FIRST. The un-measured arm carries NO sameReference field at all, so
  // "I never found your store" cannot be read as "your store produced a fresh reference".
  if (!result.measured) {
    console.log('not measured:', result.reason, '—', result.detail)
    console.log('probed:', result.tried)
    console.log('remedy:', result.remedy) // always names storeExpr
    console.log('the action still ran:', result.actionRan)
    return
  }

  // sameReference:true is the fingerprint of a reducer that mutates instead of returning
  // a fresh object, so React bails out of the re-render.
  console.log('verdict:', result.verdict, 'sameReference:', result.sameReference)
  console.log('discovered via', result.discovery.via, 'as', result.discovery.expr)
  console.log('keys whose reference changed:', result.changedKeys)
}

// Example: archetype 2 — cross-module util. Capture args via an entry logpoint.
async function captureUtilArgs() {
  // setLogpoint THROWS when `expr` cannot be assembled into a provably non-pausing
  // condition (a stray paren, an injected statement, a `debugger`). That refusal is the
  // point: a breakpoint that can pause reorders timers and destroys race hypotheses.
  try {
    await setLogpoint({ page: state.page, file: 'src/lib/format-money.ts', line: 12, expr: 'cents', tag: 'money', maxPayload: 500 })
  } catch (err) {
    console.log('logpoint refused:', (err as Error).message)
    return
  }

  await state.page.locator('button:has-text("Checkout")').click()

  // readLogpoints returns the ACCOUNTING, not a bare array. Iterate `read.hits`.
  const read = await readLogpoints({ page: state.page, tag: 'money', maxHits: 50, maxLen: 200 })
  for (const hit of read.hits) {
    console.log('formatMoney arg:', hit.tag, '=>', hit.value)
    if (hit.truncated) console.log('  (cut from', hit.truncated.originalLength, 'chars)')
    // A payload the page could not serialise is surfaced, never coerced to a plausible string.
    if (hit.malformed) console.log('  MALFORMED:', hit.malformed.reason, hit.malformed.raw)
  }
  // droppedHits > 0 means older hits fell outside the window — raise maxHits.
  console.log(`${read.hits.length}/${read.totalHits} hits, ${read.droppedHits} dropped, caps:`, read.caps)
  if (read.unparsableLines.length) console.log('unparsable marker lines:', read.unparsableLines)

  // Pass the cursor back to read only what arrived after this call.
  const later = await readLogpoints({ page: state.page, tag: 'money', sinceCursor: read.cursor })
  console.log('new hits since:', later.hits.length)
}

// Example: archetype 3 — async race. Passive timeline first, then force the race.
async function forceAsyncRace() {
  // Passive capture is non-perturbing and safe to auto-run. The controller is also in the
  // session probe REGISTRY, so dropping it no longer means recording nothing: net.read(id)
  // drains the entries from a later execute call.
  // `buffer` is the other way to keep entries: the probe pushes into THAT array in
  // place, so `state.cartCalls` is still filling up in the next execute() call.
  const cartCalls: NetEntry[] = []
  state.cartCalls = cartCalls
  const timeline = net.timeline({ page: state.page, urlPattern: '/api/cart', buffer: cartCalls })
  await state.page.locator('button:has-text("Add to cart")').click()
  await state.page.locator('button:has-text("Checkout")').click()
  console.log('request/response order:', timeline.entries())
  console.log('retention:', timeline.stats()) // a full buffer drops the OLDEST, visibly
  timeline.stop()

  // net.delay is PERTURBING — it holds matching requests so the race reproduces
  // deterministically. Three guarantees replace "remember to stop() it": a second
  // overlapping delay on the same page is REFUSED by name (pass force:true to take over),
  // it auto-expires after ttlMs (default 120s; 0 = unbounded), and it is registered so
  // every later traceValue warns while it is live.
  const hold = await net.delay({ page: state.page, urlPattern: '/api/cart', ms: 800, ttlMs: 30_000 })
  await state.page.locator('button:has-text("Checkout")').click()
  console.log('interception stats:', hold.stats())
  await hold.stop()
}

// Example: find and stop a probe you no longer hold a controller for
async function auditProbes() {
  // "Who perturbed my measurement?" now has an answer, including for stopped probes.
  for (const probe of net.active()) {
    console.log(probe.describe) // e.g. "net.delay#2 LIVE for 41s, auto-stops in 79s {...}"
  }
  for (const warning of net.warnings()) console.log('!', warning)

  const live = net.active({ live: true, kind: 'net.delay' })
  for (const probe of live) {
    // net.get(id) is the single-probe form: same accounting, null for an unknown id.
    console.log('before:', net.get(probe.id)?.describe)
    console.log('draining then stopping', probe.id, net.read(probe.id))
    await net.stop(probe.id)
    console.log('after:', net.get(probe.id)?.stoppedReason) // 'caller' — still readable
  }
  // Or stop everything this session armed:
  console.log('stopped:', await net.stopAll())
}

// Example: archetype 4 — stale effect deps / handler churn that defeats React.memo.
async function diffStaleEffect() {
  const loc = state.page.locator('[data-testid="live-price"]')

  // `identity: true` is what makes handler churn OBSERVABLE. Without it every function
  // serialises to the string `[function]` and two different arrows compare equal.
  const before = await fiberSnapshot({ locator: loc, identity: true, maxKeys: 80, maxDepth: 4 })
  await state.page.locator('button:has-text("Refresh")').click()
  const after = await fiberSnapshot({ locator: loc, identity: true })

  const diff = fiberDiff(before, after)
  console.log('same component:', diff.sameComponent)
  // Deep-equal but a NEW reference — exactly the props that defeat React.memo.
  console.log('identity churn:', diff.identityChangedKeys)
  for (const change of diff.changes) {
    console.log(` ${change.key}: ${change.kind}`, change.fn ? `fn ${change.fn.name}/${change.fn.arity}` : '')
  }
  // Props whose comparison could NOT be made. Never reported as unchanged.
  console.log('unobservable:', diff.unobservableKeys)
  console.log('unchanged:', diff.unchangedKeys.length, 'caps:', diff.caps)
}

// Example: re-run a pure sliced function in-process with captured args
async function replayPureFunction() {
  // `fn` must be an EXPRESSION (arrow / function expression). It runs in the NODE
  // EXECUTOR PROCESS: there is no window, no document, no page network. `console` is
  // VIRTUALISED (its calls come back in `logs`), so real sliced code that logs still
  // replays without weakening the gate on anything that can reach outside.
  const result = replayPure({
    fn: '(items) => { console.log("n", items.length); return items.reduce((s, i) => s + i.price * i.qty, 0) }',
    args: [[{ price: 10, qty: 2 }, { price: 5, qty: 1 }]],
  })
  if (result.ok) {
    console.log('replayed value:', result.value, 'logs:', result.logs)
  } else {
    console.log('refused at stage:', result.stage, result.reason)
    // Every offender comes with its source position and a verdict.
    for (const o of result.offending) console.log(` ${o.name} @${o.line}:${o.column} ${o.category} — ${o.why}`)
    // `admissible` can be supplied via bindings; `categoricallyUnsafe` never can.
    console.log('supply these via bindings:', result.admissible)
    console.log('nothing can supply these honestly:', result.categoricallyUnsafe)
  }

  // A closure capture or import IS admissible — pass the value in and it is injected.
  const withCapture = replayPure({
    fn: '(cents) => formatMoney(cents)',
    args: [1999],
    bindings: { formatMoney: (c: number) => `$${(c / 100).toFixed(2)}` },
  })
  console.log('with an injected binding:', withCapture.ok && withCapture.value)

  // An async sliced function needs the awaiting variant.
  const asyncResult = await replayPureAsync({ fn: 'async (n) => n * 2', args: [21] })
  console.log('async replay:', asyncResult.ok && asyncResult.value)
}

// Example: the purity gate on its own, before you commit to a replay
function checkPurity() {
  console.log(isPureFunctionSource('(a, b) => a + b')) // { pure: true, freeIdentifiers: [] }
  const verdict = isPureFunctionSource('() => window.__CONFIG__.rate * base', { allow: ['base'] })
  // `window` stays impure even though `base` was allowed: allowing an ambient IO surface
  // would make the replay silently diverge from the runtime being debugged.
  console.log(verdict.pure, verdict.reason, verdict.freeIdentifiers)
}

// Example: static analysis without traceValue's orchestration.
// `moduleGraph` hands back an OPAQUE HANDLE. The live graph holds Babel NodePaths and is
// never exposed — never try to return it; use `summary()` for the digest.
function analyseSourceDirectly() {
  const graph = moduleGraph({ root: '/abs/repo/root' })
  const summary = graph.summary()
  console.log(`${summary.indexedFileCount}/${summary.fileCount} files indexed`)
  // Callee resolution leaves large typed-unresolved buckets — read them before drawing
  // conclusions about "nothing calls this".
  console.log('unresolved call sites by reason:', summary.unresolvedByReason)
  for (const failure of summary.parseFailures) {
    console.log('PARSE FAILURE:', failure.file, failure.line, failure.message)
  }

  // "Never trust a const": constant means never REASSIGNED, not never mutated.
  const binding = inspectBinding({ file: '/abs/repo/root/src/cart.ts', graph, name: 'items' })
  if (binding.ok) {
    console.log('constant:', binding.constant, 'writes through it:', binding.writeSites)
    console.log('hazard:', binding.hazard, binding.hazards)
    // The one-step hop classification is included when a graph was passed.
    console.log('comes from:', binding.hop?.kind, binding.hop?.blockedBy)
  }

  // Constant-fold one reference. Returns a serialisable projection, never a NodePath.
  const folded = evaluateBinding({ code: 'const rate = 0.2 * 100; export default rate', name: 'rate' })
  console.log('confident:', folded.confident, 'value:', folded.value)

  // React exhaustive-deps over a whole FILE (the primitive wants a NodePath to one hook
  // call, which nothing outside the module can produce).
  const deps = findMissingDeps({ file: '/abs/repo/root/src/Cart.tsx', graph, withCodeFrames: true })
  for (const effect of deps.effects) {
    console.log(`${effect.hook} @${effect.effectLoc.line} is missing:`, effect.missing)
    if (effect.codeFrame) console.log(effect.codeFrame)
  }

  // The static backward slice on its own. `startExpr` is a variable NAME.
  const hop = backwardSlice({
    graph,
    startFile: '/abs/repo/root/src/cart.ts',
    startExpr: 'total',
    maxHops: 16,
  })
  // budget-hops means RAISE maxHops — it is not a runtime blind spot.
  if (hop.blockedBy === 'budget-hops') console.log('resume with:', hop.resumable)
  console.log('slice root:', hop.kind, hop.blockedBy, hop.note)
}

export {
  traceWrongTotal,
  traceFromHandle,
  proveMutatingReducer,
  captureUtilArgs,
  forceAsyncRace,
  auditProbes,
  diffStaleEffect,
  replayPureFunction,
  checkPurity,
  analyseSourceDirectly,
}
