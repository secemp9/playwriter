# Browsing like a human: design

Why playwriter has `observe()` / `act.*` / `find()` / `explain()`, a human policy, and an automatic action report — and what each piece is built on.

## The problem

Models without vision, and weaker models generally, drove real products through playwriter and failed in a small number of ways. These are taken from ~530 recorded sessions, not hypothesised:

| Failure | What it looked like | What was missing |
|---|---|---|
| Jumping with `page.goto` | 15 reload+click cycles to "reproduce" an SWR stale-cache bug that only a pure SPA flow triggers; the reload wiped the cache every time | a navigation rule, and a report that says "full reload" |
| Acting before the app settled | posting while the reply still showed "Processing: Fetching reviews" → interrupted reply, duplicate post, forked thread | a busy signal and a wait-until-idle primitive |
| Batching | goto + fill + click + post in one call, then a timeout with no idea which step failed | one action per call, with a report after it |
| Misreading the page | "everything works" while product images were broken; DOM numbers instead of what a person sees | states, visibility, image load state in the observation |
| Faking the repro | `pointer-events: none`, network interception, synthetic events, curl to the API | a policy that refuses forced state and API bypass |
| Claiming success | ✅ next to steps that timed out | a report that says NOT SETTLED / FAILED / NO VISIBLE CHANGE |

The research on text-only web agents points the same way (WebArena, AgentOccam, WorkArena/BrowserGym, Browser Use, Playwright MCP, Chrome DevTools MCP): changing only the observation and the action space roughly triples weak-model success (AgentOccam: Gemini-1.5-Flash 11.6% → 33.7%); pruning the action set (no `goto`) is the largest single gain; weak models get worse as instructions grow; every shipped tool waits for a quiet page after each action and reports what changed; refs must be stable.

## Hard constraint: never modify the page under test

Everything here reads through CDP (Accessibility, DOMSnapshot, DOM, Network, Page, Runtime events) and through a CDP **isolated world** (`isolated-world.ts`): it shares the page's DOM — so a MutationObserver installed there sees every mutation — but has its own JS globals that page scripts cannot see. No elements, no attributes, no main-world globals or listeners, no init scripts, no fetches from the page. Input is real input only: a native `<select>` is opened with a click and chosen with the arrow keys and Enter, a hidden control is operated through the `<label>` HTML forwards clicks from, a file is attached through the file dialog its control opens. Pixels are read from one viewport capture, never a clipped one (Chrome takes a clipped capture by moving its emulated viewport). Pins and picks use Chrome's own element picker (`Overlay.setInspectMode`); recordings draw the pointer at encode time from the inputs that were dispatched. Tests assert the page's own globals, element count and its own MutationObserver records are unchanged after observing, settling, explaining, labelling, recording and acting.

**No user gesture either.** Playwright runs every script it puts in the page — `page.evaluate`, every locator read and the actionability checks of every locator action, `page.title()`, a new element handle's preview, `page.screenshot()`'s preparation — through `CRExecutionContext.evaluateWithArguments`, which sends `userGesture: true`. Measured on a fresh page, each of them turns `navigator.userActivation.hasBeenActive` true: the page then counts as clicked, and may prompt "Leave site?", play sound, or open popups and file dialogs that a person who only looked could never trigger. Human mode therefore runs no Playwright script in the page at all. `readPage(fn)` is the read path: `Runtime.callFunctionOn` on the element (or the document) in the page's own world, without a gesture and under V8's side-effect check, so nothing the function calls can have an effect. It runs in the page's world, not an isolated one, because measured, the first touch of another frame's window from an isolated world under the check wedges the renderer, while the page's world has a context in every frame already; under the check the page cannot observe the read.

## Architecture

```
execute(code)
  ├─ code-policy.ts     Babel scope analysis of the code: actions (aliases and helpers followed), navigations,
  │                     forced state, API bypass, unanalysable page code. Human policy refuses before anything
  │                     runs. Also replaces /\breturn\b/.
  ├─ page-probe.ts      per page: PageFrames (a session and an isolated world per frame, OOPIFs included),
  │                     PageWatch, DialogController, PinTracker, act history; one session-wide RefRegistry
  ├─ (while it runs)    a raw-input tap on Playwright's client instrumentation counts actions at run time and
  │                     follows the tab the input went to; act takes its before-picture at dispatch; in human
  │                     mode a guard on Connection.sendMessageToServer refuses every protocol call that would run
  │                     Playwright's script in the page or change it (playwright-call-effects.ts)
  ├─ sandbox code       observe / find / explain / act / pickElement / docs / net.requests …
  └─ (after input)      PageWatch.settle (from the end of the last input) → observe → diff → renderActionReport
```

| Module | Role | Built on |
|---|---|---|
| `ax-states.ts` | AX properties → `[checked]`, `[disabled]`, `[expanded]`, `[focused]`, value, `[multiline]`, ranges, error messages | `Accessibility.getFullAXTree` |
| `page-model.ts` (existing) | the page as a typed tree: geometry, paint order, occlusion, visibility, clickability | `DOMSnapshot.captureSnapshot` + AX, traversed with `page-path.ts` (a Babel-traverse clone over page nodes) |
| `page-frames.ts` | the frame model: the session that owns each frame's document, one isolated world per frame, each frame's box in main-viewport coordinates | `Page.getFrameTree`, Playwright's per-frame sessions, `DOM.getBoxModel` on the owner `<iframe>` |
| `ref-registry.ts` | integer refs unique across tabs, stable per node for the life of its frame's document; the binding last shown to the model; stale, hidden, inert, closed-tab errors that name the fix | `targetId:documentId:frameId:frameDocumentId:backendNodeId` |
| `page-observe.ts` | `observePage`, `renderObservation`, `diffObservations`, `findInObservation`: controls, text, live regions, scroll areas, iframes, label-operated and transparent controls, widgets | PageModel, the registry, the isolated worlds, one viewport capture for transparency |
| `page-watch.ts` | event journal (network per frame session incl. redirect hops and WebSocket frames, navigations incl. bfcache restores, console, exceptions), MutationObserver journal in every frame world and shadow root, busy signals, `settle()`, `waitForIdle()` | CDP events on Playwright's own sessions, the AX tree, `document.getAnimations()`, isolated worlds |
| `dialog-controller.ts` | the single dialog state machine: confirm/prompt/beforeunload wait for the agent, alerts are accepted, a dialog closed elsewhere is closed | `Page.javascriptDialogOpening/Closed` + Playwright's `dialog` event |
| `file-chooser-gate.ts` | a tab's file dialogs: held back (every renderer, out-of-process iframes included) from before an input until its user activation has run out (5 s), never toggled while a JS dialog freezes the page, coordinated with sandbox code's own `filechooser` listeners; each one recorded, reported once, and open until `act.upload` / `act.dialog.chooseFiles` / `act.dialog.dismiss` answers it | `Page.setInterceptFileChooserDialog` / `Page.fileChooserOpened`, `DOM.setFileInputFiles`, the outgoing-call hook on Playwright's `updateSubscription` |
| `human-actions.ts` | `act.*`: ref resolution against the shown binding, live AX checks, wheel scrolling with scroll chaining, hit-testing through frames, human pointer and typing, select by keys, labels, uploads through the file dialog, busy/dialog/file-dialog/repeat guards, the report renderer | `DOM.getContentQuads`, `DOM.getNodeForLocation`, `humanMouse`, CDP input |
| `element-explain.ts` | what a control does: component chain, every handler on its event path (delegated included), followed at run time through live closures and mapped through sourcemaps, Babel summary of requests/navigation/state setters | read-only main-world reads, `DOMDebugger.getEventListeners`, `[[FunctionLocation]]`/`[[Scopes]]`, sourcemap `ignoreList`, `static-analysis.ts` |
| `code-policy.ts` | the AST pre-flight | `@babel/parser`, `@babel/traverse` |
| `playwright-call-effects.ts` | every protocol method Playwright's client can send, classified by what it does to the page (script as a user gesture, element action, page write, forced state, raw CDP, backend call, input, navigation, nothing) | Playwright's server code read method by method, and measured; `methodMetainfo` keeps the table complete |
| `read-page.ts` | `readPage(fn, { ref, arg })`: the function rewritten (Babel) with a budget tick per loop iteration and function entry and exact read-only equivalents of the reads Chrome has not marked read-only, run in the element's frame under V8's side-effect check; elements come back as refs. V8 gives no position for its refusal, so a refused function is run again (still under the check) with every call wrapped in start and end events and stopped at event n; doubling then halving n finds the last event reached, which names the call it stopped in, a page getter between calls, or the result's conversion | `Runtime.callFunctionOn` with `throwOnSideEffect`, `DOM.resolveNode`, `@babel/parser`, `@babel/traverse` |
| `label-control.ts`, `png-pixels.ts`, `labelled-screenshot.ts` | label → control association; dependency-free PNG decode/encode; labels drawn in Node | HTML label semantics in the isolated world; zlib |
| `element-pins.ts`, `pointer-track.ts` | pins and picks from Chrome's element picker; the pointer timeline recordings draw | `Overlay.setInspectMode`; Playwright's `onMouseAction` |

## What came from oh-my-pi's browser tool, and what did not

The omp tool (MIT) was studied module by module. Its strengths are fail-fast, attributable errors and a few primitives; the fork's PageModel was already the stronger perception substrate (omp's `observe()` has no geometry, occlusion or stable ids).

| omp capability | Taken | How |
|---|---|---|
| AX states in observe (`focused`, `checked`, …) | yes | `ax-states.ts`, everywhere a node is rendered |
| explicit stale-element errors | yes, stronger | stable refs per node, error names what happened and suggests the new ref |
| click actionability: stable box, `elementFromPoint` occlusion, "covered by <x>" | yes | `DOM.getNodeForLocation` at several points; the cover is named by role/name or layer |
| dialog policy with pending confirm/prompt | yes | `dialog-controller.ts` |
| request log + response bodies | yes | `net.requests()` / `net.request(id)` |
| readable extract `outline` / `filter` | yes | `getPageMarkdown({ outline, filter })` |
| `pushState` helper | no | `act.spaNavigate` clicks the page's own link to the route, or refuses: calling a router or `history.pushState` is not something a person can do |
| timeout diagnosis naming the stalled op | partly | inner Playwright timeouts fire first with Playwright's reason; the abort signal stops act; the report says what is still pending |
| aria snapshot text diff with revisions | no | replaced by the semantic element diff in the action report; text diffs are opt-in only |
| screenshot `annotate` / `ifChanged` | no | for vision models; the target here is text-only |
| worker-per-tab isolation, freeze on turn end | no | a different runtime architecture; not a perception problem |
| stealth patches | no | the fork has patchright; stealth is irrelevant on the user's own Chrome |
| axe a11y audit, web vitals, emulation controllers | no | not part of acting like a user; Playwright already exposes emulation |

## The policy

`human` (default for MCP and CLI sessions; the executor class defaults to it too) vs `debug` (`--policy debug`, `PLAYWRITER_POLICY=debug`). The model cannot switch it: it is fixed when the session is created. Human mode refuses, before running anything: more than one action (helpers called twice or in a loop count as several; aliases are followed by binding), `page.goto`/`reload`/`goBack`/`setContent` and in-page `location`/`history` jumps on a non-blank page (unless `act.open(url, { reason })` / `act.back()`), forced state (`page.route`, `fulfill`, `net.delay`, init scripts, DOM/style/storage writes and synthetic events inside page-evaluated code, React internals, `ghostCursor.show`), API bypass (`fetch`, `page.request`, `http` modules) and page code it cannot read (page functions passed as variables, wrappers, `eval`, run-time strings). While the code runs, a second action is refused before it is sent — raw Playwright input included — and `getCDPSession()` only reads. Reading without Playwright's script is never restricted. Act refuses input while the page itself says it is busy or a native dialog waits for the agent, refuses a ref whose element no longer reads as it did when the model saw it, repeats an action that sent data-changing requests only with `{ again: true }`, and refuses a fourth identical attempt after three produced no visible change.

Human mode also runs no Playwright script in the page, before the code runs (by API name) and while it runs (by protocol call, at `Connection.sendMessageToServer`, for every call made in the run's async context — the code's own, a helper's, act's, and the ones the code leaves running after it returns). Playwright reads, element actions, screenshots, `waitForSelector`, printing, emulation, permissions, exposed functions, fake clocks and raw CDP sessions are refused there; `page.mouse` / `page.keyboard` input is not. Pages of another browser context (`browser.newContext()`) are not under test and not guarded.

## Known limits

- Closed shadow roots are observed by the watch (through CDP) but not read by `getPageMarkdown` (script cannot reach them).
- Horizontal-only scroll areas (carousels) are not listed as scroll areas; what they hide is reported as off to the side.
- A colour input cannot be set: its picker is browser UI that page input cannot operate.
- Requests an out-of-process iframe sends in the first milliseconds of a new renderer process, before its session is subscribed, are not journaled.
- In-page timestamps are compared with Node's clock; Chrome and the executor are on the same machine in every playwriter topology.
- Playwright's server gives the page user activation when the page itself logs a DOM element to the console (`console.log(el)`): it creates an element handle for the argument, and the handle's preview is computed in the page as a user gesture (`crPage.ts` `_onConsoleAPI` → `dom.ts` `ElementHandle._initializePreview`, measured). Nothing on playwriter's side triggers it; fixing it needs the preview evaluated without `userGesture` in the Playwright fork.
- `readPage`'s budget ticks bound the function's own loops and calls; a page function it calls (`store.getState()`) and a regular expression that backtracks catastrophically run without ticks. Locating a refusal re-runs the function up to about twice the base-2 logarithm of the calls it makes before it is stopped, within 3 s; past that the error says it was not located. The search assumes the function runs the same way each time (the page's own code runs between the re-runs); a run that ends neither at its stop nor at the check makes it report the refusal as not located.
