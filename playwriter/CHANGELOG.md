# Changelog

## Unreleased

1. **Browse like a human: `observe()`, `act.*`, `find()`, `explain()`** — a perception and action layer built so that weak models, including ones without vision, can use a real product the way a careful person does.
   - `observe()` prints what is on screen: every control with a stable numeric ref, its state (`[checked]`, `[disabled]`, `[expanded]`, `[focused]`) and typed value, where it is (in view, below, covered and by what, clipped inside a scroll container), modals and native dialogs, busy indicators, live/status text, broken images, `onclick` divs listed as clickables, same-named controls told apart (`button "Add to cart" (in listitem "Razer Basilisk")`), and what is off-screen. Refs stay the same across observations for as long as the element lives; a stale ref is an explicit error with a suggestion.
   - `act.click/fill/type/press/select/check/uncheck/hover/scroll/scrollTo/upload/drag/open/back/spaNavigate/waitForIdle/dialog.accept/dialog.dismiss` act on refs: the pointer moves along a human path, the target is hit-tested first (the action refuses and names the cover when something is on top), the mouse wheel brings off-screen targets into view, typing is key by key and the value is read back, and acting is refused while the app shows it is busy or a native dialog blocks the page.
   - After every call that sends input (act.* or raw Playwright) an **action report** is printed automatically: what was hit, whether the page settled, SPA route change vs full document load, dialogs, toast/status text (also ones that vanished), console errors and failed requests, and the element-level changes. `NO VISIBLE CHANGE` is said out loud. Possible double submissions are flagged.
   - `find(text)` searches the whole page, off-screen included. `explain(ref)` says what a control does before you click it: its React component chain, every handler that can run — on the element, inside it, and anywhere on its event path (a listener delegated to `#app`, `body`, `document` or through shadow roots, labelled `delegated`) — mapped through sourcemaps to the original source, and a Babel summary of the requests, navigation and state changes they make. Calls are followed at run time through the handler's live closure (`[[Scopes]]`, bound functions unwrapped), so a helper imported from another module is followed; a library listener on the sourcemap's ignoreList (a Preact/Vue-style event proxy) is followed to the page handler it dispatches to. Bundles are parsed whole whatever their size, and a sourcemap or script that cannot be loaded is a note naming the URL and the cause.
   - Nothing is added to the page for any of this: reads go through CDP and a private isolated world (MutationObserver included).
2. **Human policy (default for MCP and CLI sessions)** — the code of every `execute` call is read with Babel scope analysis before it runs, and checked again while it runs. One action per call: a helper that acts and is called twice or in a loop counts as several, aliases (`const { click } = act`, `const m = page.mouse`) are the same call, and a second action reached at run time — raw Playwright input included, seen through Playwright's client instrumentation — is refused before it is sent. No `page.goto`/`reload` after the first load (it wipes client caches, biasing repros — `act.open(url, { reason })` when a full load is the point), and no in-page `history.pushState`/`location.hash` jumps. No faked conditions (`page.route`, `net.delay`, DOM/style writes, synthetic events, direct backend `fetch`). Page code must be readable: page functions passed as variables, wrappers, `eval` or run-time strings are refused as unanalysable. `getCDPSession()` is read-only. Refusals name the line and the human way to do it, and nothing from a refused call runs. `playwriter session new --policy debug` or `PLAYWRITER_POLICY=debug` turns it off.
3. **Element state in `snapshot()` and `pm.*`** — snapshot lines now carry `[checked]`/`[unchecked]`/`[disabled]`/`[expanded]`/`[focused]`/… and ` = "value"` (passwords masked). `PageModelNode` gains `states` and `value`.
4. **No diff by default** — `snapshot()`, `getCleanHTML()` and `getPageMarkdown()` return the full content on every call; `showDiffSinceLastCall: true` opts in, and a snapshot baseline never spans a navigation.
5. **`waitForPageLoad` actually waits** — it used to read resource-timing entries, which only exist once a request has finished, so it reported "loaded" in the middle of a fetch. It now uses the page journal: content quiet (a MutationObserver in a private world, shadow roots included) and quiet among the requests started since the call, by the same rules as the action report. Same result shape.
6. **Native dialogs are no longer silently dismissed** — a `confirm()`, `prompt()` or `beforeunload` ("Leave site?") stays open and shows up in observations and reports until `act.dialog.accept()`/`dismiss()`; alerts are accepted and reported. One dialog state machine fed by CDP: a dialog the user answered at the browser is reported as closed.
7. **`getPageMarkdown` returns markdown** — headings, lists, quotes and code survive, with `outline: true` and `filter: 'Section'` (ported from oh-my-pi's browser tool, MIT). Readability runs in a private world instead of adding `__readability` to the page.
8. **`net.requests()` / `net.request(id)`** — every request the page made, with status, timing and failure, and any response body by id (ported from oh-my-pi's request log).
9. **Execute timeouts name the cause** — Playwright's own waits now give up before the call does, so a stuck click reports Playwright's reason instead of a bare timeout, and a timed-out call stops `act.*` from dispatching more input. The return-value detection uses the AST instead of matching the word `return` anywhere in the code. Default timeout is 30s (MCP and CLI); output is capped at 16k characters at a line boundary with a hint.
10. **Short MCP description** — the `execute` description is now the start-here guide (~6 KB instead of ~108 KB of skill.md); the full reference is readable inside a call with `docs()` / `docs('recording')` and as the `skill-reference` resource.
11. **Labelled screenshots and scoped snapshots leave the page alone** — `screenshotWithAccessibilityLabels` now captures the viewport with one `Page.captureScreenshot` and draws the labels in Node (dependency-free PNG decode/encode and a built-in bitmap font), so no label DOM or `__a11y` script is injected; the labels are the same `[N]` refs `observe()` prints, at each element's top-left, and the image is in CSS pixels (capped at 1568 px). `snapshot({ locator })` and `pm.*`/`queryPage`/`whyOccluded` with a root selector no longer stamp a `data-pw-scope` attribute on the element: the locator is resolved to its DOM node over CDP and the tree is cut at that node. `showAriaRefLabels`/`hideAriaRefLabels` are removed.
12. **React inspection no longer injects anything** — `getReactSource`, `getReactComponentInfo`, `fiberSnapshot` and `pm` handles' `reactFiber()` read React's fiber with one read-only `Runtime.callFunctionOn` (the bippy bundle, its `__bippy` global and its in-page source-map fetches are gone). React 19 `_debugStack` sites are mapped to the original `file:line` through the scripts' source maps, fetched by DevTools' own loader, never by the page; React ≤18 `_debugSource` is read as is. A source map that exists but cannot be used is now an error naming why, instead of a silent `null`. `getReactSource`/`getReactComponentInfo` also accept `{ backendNodeId, frameId?, cdp }`. `fiberSnapshot({ identity: true })` tokens are held by playwriter per frame (no `__playwriter_trace_ids` global; capped at 5000 objects, reported in `caps.identitiesOmitted`), and `storeIdentity` keeps the captured state through CDP instead of `__playwriter_trace_probe`; a fiber-discovered store is no longer pinned as `__playwriter_trace_store` — `discovery.expr` re-finds it instead (`discovery.pinnedAs` is removed).
13. **Nothing is injected into attached tabs** — the extension no longer adds the toolbar, the context-menu script or the ghost cursor to pages. Pinning an element and copying a React component's source use Chrome's own element picker (`Overlay.setInspectMode`) from the browser's context menu; pins show up under `PINNED` in `observe()`, `inspectPinnedElement({ url, backendNodeId })` replaces the old main-world expression form, and `pickElement()` asks the user to click the element they mean. `ghostCursor.show()` is opt-in and refused in human mode (it adds an element and a global); the humanMouse crossing recorder runs in an isolated world.
14. **Recordings draw the pointer without touching the page** — `recording.startCdp` and `recording.stop` (tabCapture) burn the pointer into the video at encode time from the inputs that were dispatched. `startCdp` defaults to `mode: 'screencast'` and never foregrounds the tab (`'auto'` is removed; a visible tab gets one screenshot as its first frame); `recording.start` no longer resizes the viewport (`aspectRatio` is an explicit, documented perturbation).
15. **Session hygiene** — one shared CDP session per page (fixes an event fan-out leak); Debugger and Editor never disable domains on Playwright's session; a page's own `debugger;` statements no longer freeze it (pauses only while you armed something meant to pause); Editor's CSS `dryRun` no longer writes; `net.delay` runs on `page.route`.
16. **`getPageMarkdown` reads what is on screen** — every result states its source (`article` or `visible page`) with word counts; the copy is built from the live flat tree, so CSS-hidden content (inactive tab panels, `.hidden` templates, closed `<details>`) no longer leaks in and open shadow-DOM content is read; iframes are marked instead of dropped; search reports how many matches were not shown.
17. **Settle and busy from ground truth** — busy comes only from the page itself (AX `busy`, indeterminate or moving progressbars, on-screen endless animations started since the action, measured streaming); words like "Loading" and class names never block. Only requests the action caused can hold a settle, measured from the end of the last input, with Chrome's request facts deciding the rest (no host or extension lists); a long-poll opened earlier is listed, not waited on. One journal record per redirect hop, WebSocket frames journaled, back/forward-cache restores reported as such, console limited to the page's main world, timers and ambient churn excluded from quiet.
18. **observe() and act, closer to what a person sees and does** — native `<select>` options are listed and `act.select` opens the select and chooses with the arrow keys and Enter (trusted input/change); controls hidden behind their `<label>` are listed and operated through the label; fully transparent controls count as visible only when something is drawn where they sit (judged from one viewport capture); `act.upload` clicks the control and answers the file dialog; `act.spaNavigate` clicks the page's own link or refuses. Long text is kept whole (find() searches it; growth is reported); live regions stay readable; app-shell scroll areas get refs and `act.scroll` scrolls what the wheel reaches; date/time inputs are typed into their parts and verified; refs are unique across tabs and act follows a ref to its tab (`act.switchTab(i)`); a ref whose element now reads differently is refused (`[12] now reads button "Unfollow" (you saw button "Follow")`); hidden and inert refs say how to reach them; the double-send guard is driven by the requests the last action actually sent (POST hops, WebSocket sends); typing is never sped up to fit the call — a call too short for a person's pace is refused with the timeout it needs.
19. **Action report** — file choosers your click opened (`FILE CHOOSER … → act.upload`), downloads with their outcome, and this page's popups are reported; raw input on another tab is reported on that tab and names it (`on tab N "Title"`), with no diff or `NO VISIBLE CHANGE` claimed without a before-picture of that tab; each section fails on its own with its cause instead of the whole report disappearing; `NO VISIBLE CHANGE` only when a before/after comparison was made; model-facing errors print without a stack or the generic "call reset" hint. Snapshot lines print `[level=N]` only for headings, tree items and treegrid rows. `humanMouse.moveTo({ heldButton })` keeps the button held through the whole move, so drags work.
20. **Iframes are observed, operated, watched, read and explained** — same-process and cross-site (out-of-process) iframes such as payment fields, embedded sign-in and consent walls. They are listed as `iframe "…" — N controls` with their content nested under them; refs are frame-qualified per iframe document, and refs of an iframe that loaded a new document are retired on their own. Something drawn over an iframe covers what is inside it. Act scrolls and hit-tests through iframes and types into their fields; network, console and DOM journals include every frame, so a POST from an iframe counts for the double-post guard; `getPageMarkdown` reads iframe text inline.
21. **Fixes found on real sites** — `act.fill`/`act.type` keep typing when the page replaces the clicked field with a new one on focus (Wikipedia's search box becomes a combobox): the caret is in the replacement under the pointer, the report names it, and the new field gets the same newline and secret checks. When the replacement arrives while the text is being typed (Wikipedia's search app loads after the click and takes the text so far), the value is read back from the field the caret is in, instead of the action failing on the vanished one. Repeated controls are told apart by the caption above their group when nothing else does (`(after "Width")`), a row's other-kind control names it (`(in listitem "Buy milk")` for its Delete button), and a sibling option's label is never used as context; a label's words are no longer repeated as text, from Chrome's own record of which nodes named which control. A tab that outlived a relay restart or upgrade gets the current in-page journal instead of keeping the old build's.
22. **File dialogs behave like the browser's own** — a file dialog an input opened is held back and stays open until it is answered: `FILE DIALOG OPEN, opened by your click [12] …` in the report and at the top of observe(), nothing else on the page usable meanwhile, `act.dialog.chooseFiles(path)` to choose files, `act.dialog.dismiss()` to cancel, and `act.upload(ref)` choosing in its own control's open dialog instead of clicking again. Dialogs are held back from before each input until its user activation has run out (5 s), so one opened after a confirm you answered, or by a page timer after the call returned, is caught and reported instead of opening natively; out-of-process iframes included. Interception is never toggled while a JS dialog freezes the page: a click that opens `confirm()` and its answer no longer stall 5 s each, and a timed-out toggle can no longer leave the tab intercepting the user's own file dialogs. Sandbox code that listens for `filechooser` keeps its dialogs and its listener (the report says it was handed to it).
23. **Reading the page no longer gives it user activation** — Playwright evaluates in the page as a user gesture, and measured, even `page.title()` left the page user-activated (sticky), which changes what it may do next: a "Leave site?" prompt, autoplay with sound, popups, file dialogs. Every observation read every tab's title that way. Tab titles now come from the browser (the current navigation entry, which also answers while a dialog freezes the tab), the document title and the recording's viewport from the isolated world, and `getCleanHTML({ locator: page })` from `DOM.getOuterHTML` (the same text). A file input says what it is: `(file input: its click opens a file dialog — act.upload(3, path))`. `getPageMarkdown()` with no argument reads the controlled page; `getCleanHTML()` without a locator says what it needs.
24. **Human mode runs no Playwright script in the page** — `page.evaluate`, `page.title()`, `page.content()`, `page.screenshot()` (which also writes `caret-color` into every text field's inline style unless `caret: 'initial'`), `waitForSelector`/`waitFor`/`waitForFunction`, every locator read and every locator action (`click()`, `fill()`, `hover()`, `focus()`, `selectOption()`, …) run Playwright's injected script as a user gesture, so the page counts as clicked. Human mode refuses them: before the code runs (Babel, by API name, with the readPage / observe / act.* equivalent named) and while it runs, as each protocol call goes out — calls reached through computed names, calls the code leaves running after it returns, Playwright's internal calls (`_snapshotForAI`) and raw CDP sessions (`context.newCDPSession`, `getExistingCDPSession`) included. Every protocol method Playwright's client can send is classified by what it does to the page (`playwright-call-effects.ts`; a test fails on an unclassified one), and printing, viewport and media emulation, permissions, geolocation, extra headers, HTTP credentials, storage state, exposed functions, Playwright's highlight and fake clocks count as forced state. `getCDPSession()`'s read-only session can no longer be bypassed through its `session` property. `page.mouse.*` / `page.keyboard.*` input is unchanged. Debug mode is unchanged.
25. **`readPage(fn, { ref, arg, page })`** — read anything on the page in human mode: `fn(el, arg)` runs in the page's own world, in the frame of `ref` (`el` is that element; without a ref, the `document`), without a user gesture and under V8's side-effect check, so a write, focus, scroll, event, request or a page function that caches or logs is stopped before it happens and nothing changes (measured: no mutation the page observes, no storage or app-state change, `navigator.userActivation` untouched). Reads Chrome has not marked read-only are rewritten (Babel) to exact equivalents that pass the check — `closest`, `matches`, `getRootNode`, `getElementById`, `isSameNode`, `localStorage.getItem`/`key`, `DOMRect#toJSON`, `getPropertyValue`, `location.toString()`, `Object.fromEntries`/`assign`, object spread — falling back to the native call wherever they could differ. Every loop iteration and function entry checks a 5 s budget, so a function that never returns stops instead of freezing the tab. Data comes back as JSON; elements come back as refs for act.*; `console.*` inside prints with the call's output; a throw is shown as a code frame of the model's own function. V8 reports no position when its check stops a function, so readPage runs it again under the same check with every call counted, stopped at a chosen count, and finds the last call reached by doubling then halving that count: the refusal shows the call it stopped in (a page function such as MediaWiki's `mw.config.get`, which reads `arguments`), or that it stopped between calls (a page getter) or while the result was turned into data, in a code frame of the model's function, with why and what to read instead (`Object.keys(mw.config)`).
26. **Element readers take a ref** — `snapshot`, `getCleanHTML`, `getLocatorStringForElement`, `getStylesForLocator`, `debugStyle`, `whyOccluded`, `getReactSource`, `getReactComponentInfo`, `fiberSnapshot`, `traceValue`, `humanMouse.moveTo/click/hover/plan` and `pm.*` (`rootRef`) accept `{ ref }` from `observe()`/`find()`: the element is read over CDP and playwriter's isolated world (its box from `DOM.getContentQuads` for `humanMouse`), never with Playwright's script in the page. `getStylesForLocator({ ref })` and `debugStyle({ ref })` read an out-of-process iframe's element in that frame's own session (the locator forms could not), and `whyOccluded` says why it cannot measure one and what does. A page-model handle's `styles()` reads the node by its id instead of through a locator. Their Locator / ElementHandle / FrameLocator / selector forms (`locator`, `node`, `selector`, `rootSelector`, a FrameLocator `frame`) and `humanMouse.enable()` resolve the element with that script, so human mode refuses them before any Playwright call, naming the ref form; debug mode keeps them unchanged.
27. **A page that logs an element no longer gets user activation or Playwright's listeners** — Playwright's server previews every element handle it creates by building its injected script in the element's world and calling it as a user gesture, and the page creates such handles itself with every `console.log(element)` (and every file chooser). Measured: the page became user-activated, and 13 capture listeners (pointer, mouse, touch, `click`, `contextmenu`, `__playwright_global_listeners_check__`) and a MutationObserver were added to its own world. The preview is now replaced before playwriter connects (`playwright-server.ts`): the same `JSHandle@<button id="b" disabled class="buy">Buy</button>` text, from a self-contained read in the handle's own context, under the side-effect check and without a gesture. Debug mode gets the same previews without the listeners.
28. **readPage cannot hold the tab** — a function of the page that never returns, or a regular expression that backtracks without end, ran past readPage's budget checks (they are in the model's code only) and froze the tab. readPage now runs as a `Runtime.evaluate` with V8's own time limit, which stops whatever is running 6 s after the read started, scoped to that evaluation so nothing else on the page is ever stopped; the error names what to change. A read with a ref receives its element as `$_` (set by a call on the element in the console group), so Chrome's console helpers (`$`, `$$`, `keys`, …) exist while it runs and are gone after; a same-process iframe's page world is found through Playwright's server.
29. **getCleanHTML of an element is the element itself** — `getCleanHTML({ ref })` reads the element's own HTML from Chrome's DOM agent (`DOM.getOuterHTML`, nothing run in the page), and the debug-mode `{ locator }` form reads the outer HTML too: a field, an image or a button is no longer read as its (empty) inside.
30. **debugStyle points into minified stylesheets** — the code frame of a winning declaration cuts long lines to a window around the declaration; on Wikipedia, the frame for one `font-size` was the whole 390 000-character stylesheet line.
31. **snapshot() in human mode says what its selectors are** — the line about `refToLocator` (snapshot lines show no ref strings) is gone; in human mode the snapshot ends by saying its selectors are Playwright locators, which human mode refuses, and to act with refs from `observe()`.
32. **Human mode on the patchright engine** — with `PLAYWRITER_PATCHRIGHT=1` every probe failed with "CDP session is only available in Chromium": `@playwriter/patchright-core@1.61.0-playwriter.1`'s `getExistingCDPSession` checks `options.isChromium`, which Playwright 1.61 no longer sets (every other check reads `options.browserType`). Playwriter restores the field for patchright's Chromium before borrowing a session — that check is its only reader — and replaces patchright's element preview before connecting too, though its bundle exports no `ElementHandle` (a one-shot setter on `SdkObject.prototype` swaps it inside the first handle's constructor, before that handle previews itself). Patchright journals no console messages: it never enables `Runtime`, which is what keeps the page from detecting CDP.
33. **Downloads and full response bodies in human mode** — a download a click starts (in a popup too) is reported as `DOWNLOAD [d1] report.csv from … — completed → downloads.save('d1', 'report.csv') …` and kept for the session: `downloads.save(id, path)` copies it into the session folder (it waits for one still running within the call and refuses a failed one) and `downloads.list()` lists them. It copies when the browser saved the file on this machine — headless, direct CDP to a local Chrome, and the extension. Through the extension Chrome saves a download where its own settings say, under its own name: chrome.debugger cannot choose (it refuses `Page.setDownloadBehavior`), so `download.saveAs` used to fail with ENOENT. The extension (new `downloads` permission) now finds the file Chrome saved and reports its path when the tab's download completes, and the relay hard-links it (or copies it) to where each session's Playwright reads it, for every session of the worktree that owns the tab, before Playwright hears the download finished. When Chrome is waiting for the user to choose where to save, or the file cannot be matched, the report line and `downloads.save` say so. For a cloud or remote browser the line says the file cannot be copied here and where it is, and `downloads.save` refuses with that reason. `net.save(id, path)` writes the whole body of a request the page made — `net.request(id)` cuts at 64K characters — decoded to bytes, over CDP, so on every connection. Both write only where the sandbox `fs` may (the session folder and the temp folders).
34. **getPageMarkdown reads closed shadow roots** — nested ones and those inside iframes (same-process and out-of-process), at their host's place in document order: CDP lists them, each frame's isolated world copies them, nothing is written to the page. A document that navigates while it is being read is read again once; if it navigates again, the error says to call again.
35. **Element readers' Playwright forms are refused before the code runs** — `debugStyle({ locator })`, `pm.query({ rootSelector })`, `traceValue({ selector })`, `getCleanHTML({ locator: page.locator(…) })`, `getLocatorStringForElement(page.getByRole(…))`, `humanMouse.enable()` and the others are read by the static policy and refused with the ref form to use, so nothing of the call runs; the run-time check still catches forms built in a variable, and now says that call was not run (earlier statements of the code may have).
36. **skill.md examples run in human mode as written** — every example the policy would refuse was rewritten for human mode or marked `// Debug mode` (popups and `act.switchTab`, dialogs, cookie walls, iframes, recordings one action per call, raw input one per call), and a test runs every example through the policy. The claim that `keyboard.type()` cannot type a newline was wrong (Playwright types `\n` as Enter) and is gone. `debugStyle` no longer hides why it has no code frame: a stylesheet whose text cannot be read says so.
37. **Carousels are scroll areas** — observe lists an element that scrolls sideways (a carousel, a wide table) as a scroll area with a ref and how far it goes (`left edge, 3 screens to the right`), and what it hides as `INSIDE [n] … — act.scroll('right', { ref: n })` instead of "off to the side". `act.scroll('right' | 'left', { ref })` turns it with horizontal wheel deltas, as a trackpad does, with the same chaining, notes and end-of-area refusal as vertical scrolls; where an area starts follows Chrome's own rule (Blink's HasTopOverflow/HasLeftOverflow): a right-to-left or `row-reverse` strip starts at its right, and a chat log built with `flex-direction: column-reverse` starts at its bottom — observe used to call such a log, sitting at its newest message, "top, N screens below", and every scroll note and end check was inverted; diffs and distances use Chrome's raw scrollTop/scrollLeft, so content a page adds above or to the left no longer reads as a scroll. An unknown direction is refused — `act.scroll('sideways')` used to scroll up.
38. **Colour inputs can be set** — the claim that Chrome's colour picker is browser UI was wrong: since M83 it is a page popup, and Chrome forwards the page's keys to it. `act.fill(ref, '#rrggbb')` clicks the input and does what a keyboard user does in the chooser (format switch to hex, type, Enter); the page gets `input` and `change`, and the value is read back. A colour input with a `list` opens a swatch popup that cancels every key but the arrows: that one is refused with the reason. Robust to the page: the chooser is checked open (`:open`) before every key, so if the page closes it no key lands on the page; a dialog the click or an `input` handler opens stops it, naming the dialog; an input hidden behind its label works; a chooser already open (after `act.click`) is cancelled first. While it is open, observe says so on the input's line and no longer lists the chooser's own controls as page elements.
39. **An iframe's first requests, and workers' requests, are journaled** — Playwright's server enables Network on a new out-of-process iframe's session and resumes it in one synchronous run, before playwriter could borrow the session, so a request sent as the iframe's document started was lost (a sign-in iframe's startup POST never reached `net.requests()` or the repeat guard). The session is now tapped as it is created, its events held in order and replayed; each request names the iframe that sent it (`frame`). Dedicated workers, nested ones included, are followed the same way from their first event: a POST a click makes a worker send holds the settle, counts for the repeat guard, and names the worker (`worker`) — before, the report said `SETTLED` before the worker's answer arrived and the POST was nowhere.
40. **Browser clocks are measured, not assumed** — the journal, settle and the action report compared Chrome's timestamps with this machine's clock directly. A cloud browser or remote relay minutes off made settles time out, attributed the previous action's live text to this one, and let a repeated POST through. The offset is now measured as an interval from timed round trips (every journal read is one) and from stamps as they arrive, and every comparison goes through it; `net.requests()` times are on this machine's clock.
41. **Multi-line text, strokes, and clicks on a scrolled page** — `act.type`/`act.fill` no longer type a line break as Enter in a multi-line field: Playwright's keyboard types `\n` as Enter, which in a chat composer sent the first line. Text with a line break in a textarea or contenteditable needs `{ newline: 'Enter' | 'Shift+Enter' }` or `{ paste: true }` and is refused before any input otherwise; `\r\n`/`\r` count as one key, and a rich editor's value is read back line by line (innerText turned `<p>` lines into blank lines and reported a correct value as "differs"). `act.drag` takes points of elements — `{ ref, x, y }` in CSS px of the element's border box, mapped through its transform — so a stroke on a canvas, a custom slider position or a map pan is one action; the point is wheeled into view, checked against the box size and hit-tested exactly. Hit tests now use document coordinates (`DOM.getNodeForLocation` takes them): before, every act on a page scrolled from its top hit-tested the wrong spot, or failed with "No node found at given location". `act.type` appends after the whole text of a text area or editor (it pressed End, which reaches only the end of the clicked line, and inserted mid-text); select-all and end-of-text use the browser's platform (Ctrl+A/Ctrl+End, or ⌘A/⌘↓ with Chrome's editing commands on macOS), and the selection is read back before anything is typed. Rich editors whose select-all ends after their last block (ProseMirror, TipTap) and contenteditable markup that is indented are read and replaced correctly, drag points map through perspective transforms too (a projective map of the drawn corners), and a point by the page edge or at the end of a list is not wheeled for.
42. **Worker errors are in the report; spinners on a scrolled page are seen** — a dedicated worker's console errors and uncaught exceptions (nested workers included) are journaled from the worker's first event and shown in the action report's `ERRORS` line at the worker's script location; before, a click that made a worker throw reported no errors at all. Busy signals hit-test in document coordinates too, so an on-screen spinner on a scrolled page, or inside a cross-site iframe on one, holds `BUSY` and `waitForIdle` again.
43. **The extension reports the real browser** — the relay answered `Browser.getVersion` with `Chrome/Extension-Bridge` and the user agent `CDP-Bridge-Server/1.0.0`, so `browser.version()` was `Extension-Bridge` and Playwright, which reads the platform from the user agent, treated every Mac as Linux: `Meta+A`, `Meta+ArrowLeft` and `Alt+Backspace` were sent without the editing commands Chrome on macOS needs, and did nothing in text fields. The extension now sends its user agent and Chromium version on connect, and the relay answers with them for the extension each client is bound to. An extension that does not send them gets the old values, and the relay log says what that breaks. `act.*` reads the platform from the page's own user agent, so its select-all and end-of-text keys were right through either relay. Playwright also reads "headless" from that user agent, and then sets default font families on every page it initializes; through the relay that would change the fonts of the user's tab, and Chrome takes it once per page, so a second session's `newPage()` failed with "Font families can only be set once". The relay does not forward a font override to a tab.
44. **Download events stay in their worktree** — the relay's compat `Browser.downloadWillBegin` / `downloadProgress` events carry no session, so it sent them to every session of the extension: a download's URL and file name from one worktree's tab reached every other worktree. They now go only to the sessions whose worktree owns the tab that started the download.
45. **A request is one record across the page's sessions** — a cross-site iframe's document request starts on the parent's session and ends on the iframe's, so the journal never saw it finish: loading a page with such iframes reported `NOT SETTLED … waiting on GET /runner.html` (MDN's examples) for documents long rendered. A request is now tracked by Chrome's request id across the page's sessions, its body read where it arrived.
46. **A link that redirects to a download settles and reports cleanly** — on GitHub's archive links the report said `NOT SETTLED … waiting on GET …/archive/…zip`, listed the canceled navigation as an error and printed `HTTP undefined`. Chrome moves a still-open fetch on to its redirect target without reporting the redirect: that is now the next hop, and the first one ends. A navigation canceled because its response became a download (`Page.downloadWillBegin` for that frame and address) ends as that download (`download` in `net.requests()`), not as a failure. A blocked request says why (`blocked: csp`, `CORS error: …`); `failed` is never empty, and the report and the journal agree on what failed.
47. **find() matches the page's words, not observe()'s** — a repeated control's context (`under heading "Shipping address"`, `in listitem "…"`, `after "…"`) was searched whole, so `find('head')` listed every control under a heading. Only the page's words inside the quotes are searched now. A scroll area that hides less than a tenth of a screen says how many pixels (`left edge, 14px to the right`) instead of "0 screens", and which edge it is at is decided in pixels: 10px from the bottom is no longer "bottom".
48. **`PLAYWRITER_PORT` moves the relay too** — the relay the CLI and MCP start in the background listened on 19988 whatever `PLAYWRITER_PORT` said, while they waited for it on `PLAYWRITER_PORT`: on any other port the MCP failed with "Failed to start CDP relay server", and when 19988 already had a relay the new one exited without a word. It now listens on `PLAYWRITER_PORT`. What it logs right before exiting (another relay already on its port, a crash, a shutdown signal) now reaches `relay-server.log`; the log is written on a timer the exit skipped, so those lines were lost.
49. **The MCP chooses its browser: the `browser` tool** — an MCP session could only take what the relay's fallback gave it: with two Chrome profiles connected it bound one only when exactly one had attached tabs, else every call failed with 4003 "Multiple extensions connected. Specify extensionId.", and it could not start a new browser at all (only the CLI could). `browser({ action: "list" })` lists the user's connected profiles (email, key, the playwriter version its extension was built with, attached tabs) and a fresh headless Chrome; `use` with an email (case-insensitive) or key binds that profile (by its key, through the relay); `new` launches a headless Chrome for the session. Switching releases the previous browser (`PlaywrightExecutor.disconnect()`: the user's tabs stay open, a headless context is closed, and its Chrome with the last one). `PLAYWRITER_BROWSER` (`new`, an email or a key) presets the choice; without it, one connected profile is used, and none or several is an error saying how to choose instead of a guess. `PLAYWRITER_DIRECT` and `PLAYWRITER_HOST`/`PLAYWRITER_TOKEN` keep working. Nothing an MCP model reads tells it to run a command any more: `docs()` serves skill.md without its CLI section (as `skill-reference.md`), starting Chrome, the `jq` triage and `gh issue create` moved into that section, and the error texts (extension not connected, outdated or stale extension, no Chrome binary, tabCapture permission, remote relay) say what to ask the user.
50. **A frame that leaves the page no longer crashes the MCP** — a password manager's inline menu (an iframe it adds when a login field gets focus and removes ms later) made Node exit: the file-dialog gate re-arms on every frame event, borrowed each listed frame's CDP session, Playwright answered `frame: no object with guid frame@…` for a frame its server no longer had, and the rejection from that event listener was unhandled. A frame that detaches between being listed and being borrowed — Playwright's "no object with guid frame@", "Frame was detached", or a frame `isDetached()` after the failure — is gone, not an error: `PageFrames.sessions()`, `list()`, `observe()`, `getPageMarkdown()` and the page journal skip it; a call about that one frame says it is no longer on the page; any other failure still propagates with its cause. A frame no debugger may enter (another extension's page at `chrome-extension://`, a `chrome:`, `chrome-untrusted:` or `devtools:` page) is never borrowed a session; observe and getPageMarkdown name it where it sits (`iframe "…" — not read: it is a browser extension's frame (chrome-extension://…), whose content cannot be read`), and a snapshot of it says the same. Every listener, timer and `void` promise in `src/` handles its own failure: the gate's event-driven re-arm reports a failure with the next action, the relay's and CDP log files say on stderr when a write fails instead of leaving the flush queue rejected (it rejected on every later flush), the relay's idle-cloud sweep logs a session it could not stop, and `serve`/the relay daemon flush the crash line before exiting and report a failed shutdown.
51. **act points and buttons** — only `act.drag` took a point, and `act.click({ ref, x, y })` failed with `ref.trim is not a function`. `act.click`, `act.dblclick`, `act.hover` and `act.drag` now all take `{ ref, x, y }`, mapped through transforms and checked inside the box, in view and not covered; the report gives the point in viewport px and the element under it. A covered point's refusal now also gives the same spot as a point of the cover when it has a ref, so a model can press it the way a person's click lands on what is on top. `act.click(ref, { button: 'right' | 'middle' })` was untested and its report did not show the button: the line now says `with the right button`, the page's context menu shows up in the report, and an unknown button is refused before anything runs (it used to reach CDP). `act.drag(from, to, { path: 'straight' })` moves along the line at a person's pace, ending exactly on the target point (the default curved path, 202–247 px for a 200 px drag over 8 seeds, is unchanged); the report gives the held-button path length.
52. **act.select on long native selects** — it arrowed through every option (28–31 s on a 200-country list) and, in a real Chrome, landed on the wrong country while blaming the page. It now opens the list, types the start of the label (Chrome's type-ahead), checks the highlighted option through Chrome's accessibility value, presses Enter (one change event) and reads the choice back: about 2 s. A list the model already opened is typed into, not clicked shut; option groups, disabled options, duplicate labels (by value) and options out of sight work; `<select multiple>` adds with Ctrl+click. The page is blamed only when the choice was seen taken and then undone.
53. **act.type in rich editors, and `{ at: 'caret' }`** — `act.type` jumped to the end of the whole document (Ctrl+End), so text meant for paragraph 2 landed in paragraph 3 and the report hid it in a cut value diff. observe now lists an editor's blocks (paragraph, list item, heading, quote, code block, table cell) with refs; `act.type(blockRef, text)` clicks after the block's last character, checks the caret is there, types, and reports `typed into paragraph 2 "…"`. `act.type(ref, text, { at: 'caret' })` types where the caret already is, and is refused when focus is not in the field.
54. **act.spaNavigate with query strings** — it failed when the page's link was `/spa/products?tag=…`. Links now match by path (query and `#fragment` only when given), exact addresses first; the report names the link used, and ambiguous or missing links are listed.
55. **act.scroll in a scroll area** — scrolling a 240px chat log by 10 screens moved the log 980px and then the page 1300px more, and an off-screen area was refused. The wheel now turns only as far as the area can still move, reports `reached the top of [12] log "Team chat" after 980px`, and brings an off-screen area into view first.
56. **Shadow DOM buttons are no longer covered by their own host** — MDN's Run (`<mdn-button>` around a `<button><slot>`) was refused as "covered by mdn-button#execute": Chrome's hit test names the host over the text it slots in. A point over content slotted into the target (open or closed shadow roots) now reaches it; real overlays and other hosts are still refused.
57. **Rows, tables, tooltips and revealed passwords in observe()** — a control in a table row was labelled with the previous row (`(after "<previous row>")`), so `find('Initech')` returned Umbrella Health's Delete; it now carries its own row's words (`(in row "INV-1003 Initech 2026-01-19 $2,400.00 Overdue")`) in observe, find and the report, and an open menu, listbox, dialog or tooltip inside the row is no longer part of them. Tables, grids and lists with a `<caption>` or aria name are listed by it (`table "Cookies"`). A showing `role=tooltip` was dropped as a repeat of its name; it is now `tooltip "…" (describes [n])` in observe and find, and the action report says `+ tooltip "…"` when it appears and `- tooltip "…" (now hidden)` when it goes (hovering "Shipping info" used to report NO VISIBLE CHANGE). A field the page revealed with its eye toggle still showed `••••` because `autocomplete="new-password"` counted as a secret; only `type=password`, one-time-code and card tokens and `-webkit-text-security` bullets mask now, in act read-backs too. A focused `tabindex` list item or card no longer swallows the text inside it (Chromium names it after its content).
58. **Images, icons and backdrops in observe()** — `<img>` without `alt` was absent; it is listed as `[n] image (no alt) /lab/chart.svg`, `alt=""` images are counted on an `IMAGES … decorative` line, and nameless inline SVGs and canvases are counted (`IMAGES 14 unnamed graphics … not listed`) instead of listed as bare `image` lines (react.dev: 28 → 0). An icon inside a named button, link, menu item, tab, option or checkbox/radio label was its own `image "More actions"` line and took the button's name in the snapshot; it is part of its control now. A modal's backdrop, listed as `clickable … (behind the modal)` or not at all, is `[n] backdrop of dialog "…"` in the MODAL block, and covered controls say `covered by the backdrop [n] of dialog "…"`.
59. **Refs for non-control targets, and no refs for click containers** — `<li draggable tabindex=0>` items and a card with only a `contextmenu` listener had no ref, so act.drag and right-click could not reach them; they are listed as `draggable focusable listitem "Echo"` / `focusable div#ctx-card.ctx-card … (listens for contextmenu — right-click: act.click(n, { button: 'right' }))`, from one read-only `DOMDebugger.getEventListeners` per frame (18–70 ms on real sites; a live test pins the call shape that does not crash the renderer). Click delegation containers — `tbody#rows`, a pager `<nav>`, GitHub's file-list rows, MDN's `<mdn-button>` wrappers — were listed as `clickable` (GitHub repo page: 34, MDN: 23; now 0); a container whose listener serves ≥3 children of one kind lists those children (`(its click reaches the click listener of ul#fruits.pick)`), and a click surface that also takes pointerdown/mousedown/touchstart around exactly one control (a slider track) stays listed.
60. **Query handlers in `find()` and `readPage({ query })`** — `role/…[name="…" exact]`, `aria/`, `label/`, `placeholder/`, `text/`, `alt/`, `title/`, `testid/`, `pierce/` (closed shadow roots too) and `xpath/`, over every frame, read from Chrome's accessibility tree and DOM over CDP; each match gets a ref (elements observe() does not list get one too, usable by act.*), states, where it is (covered, off-screen, hidden) and its box, plus a count. Plain-word `find()` lists exact phrase matches first: `find('Message 1 —')` returned 13 word-by-word matches; word-by-word matches now come only when there is no exact one, labelled approximate.
61. **`readPage(fn, { ref })` through the extension** — it failed with `ReferenceError: $_ is not defined` for every function, because Chrome gives an extension's debugger none of the console helpers the element was handed over with. The element is now reached by its path from its frame's document and checked to be the ref's node; one inside a closed shadow root over the extension gets an error naming getCleanHTML / snapshot / explain instead.
62. **`snapshot()` takes no options, and its diff is a real delta** — `snapshot()` crashed with `Cannot destructure property 'page' of 'options'`; it now reads the controlled page. `snapshot({ diff: true })` (and `showDiffSinceLastCall`) returned the whole tree on any change; it now returns revisions (`full` / `unchanged` / `delta`, `revision`, `baseRevision`) with `+`/`-`/`~` lines keyed by node identity, per page or ref scope, starting over on a new document, with re-renders that change nothing counted and not listed.
63. **`getCleanHTML({ ref })` keeps id, class and state** — it dropped `id`, `class`, `disabled` (and `src`, `for`, `selected`, `readonly`, `required`, `hidden`, most `aria-*`); they are kept now, style and handlers still dropped. The whole page keeps them too, except `class`.
64. **Re-renders and duplicates in the action report are judged by meaning** — a page that rebuilt a table with the same rows produced `+`/`-` pairs for every row; items that read the same (role, name or text, value, state, context, container) are now paired off as `~ re-rendered with the same content: …`, with controls' new refs (`[12]→[31]`). "Clear all" on three tables warned `3 identical new row "(empty)"`; the duplicate warning now counts only new identical items in one list, log or table, and names it.
65. **Busy: skeletons and aria-busy seen, still progressbars and glowing badges ignored** — the SPA's six shimmering product cards read as six spinners, or as nothing once loaded, and GitHub's language bar (four determinate `role=progressbar`) printed `BUSY? progressbar "TypeScript: 58.3%"`. An endless animation on blocks that show nothing, inside an aria-busy element or repeated across siblings, is now one `skeleton` signal per container that blocks like a spinner; aria-busy reads `area "Products" [aria-busy]`; a determinate bar counts only while its value moves; an endless animation on text or a control is no longer a spinner. Settle records the indicators it waited through: `busy while it settled, gone now: …`.
66. **Pages that start a worker settle, and a worker's script request ends** — Chrome reports a worker's main-script fetch on the page session but ends it on the worker's target, so settle waited the full 5 s on `GET /scope.js`, and a dedicated worker's script request could stay open. Such fetches no longer hold settle, and a worker's script request ends when the worker does.
67. **ERRORS says what failed** — a script that answered 404 read `canceled` (Chrome cancels reading its body), and a 204 answer read `request failed POST /report: canceled`: the line now says `HTTP 404 GET /lab/missing-script.js`, a 204/205/304 is answered, and `canceled` is left for real cancellations. CORS failures showed only `net::ERR_FAILED`; ERRORS and `net.requests()` now give Chrome's reason, the origin and the address (`CORS: no Access-Control-Allow-Origin header (fetch from http://127.0.0.1:47101 to http://localhost:47102/api/cors-fail)`), all 28 of Chrome 149's reasons named, in a launched browser and through the extension alike. `net.requests()` rows carry `statusText`, `durationMs` and `bytes`. `getLatestLogs()` kept only the message; console entries keep their source location and uncaught exceptions their stack frames (`readLogpoints` reads each entry's first line).
68. **`net.request(id)` gives everything Chrome reported, and `net.har({ path })`** — `net.request` gave only the response body. It now also gives request and response headers as sent and received on the wire when Chrome reported them (saying which version it shows), status text, transferred and body sizes, `durationMs` from Chrome's clock, protocol, server address, failure text, CORS reason and request body, and a failed request's reason instead of a throw. Cookie, Set-Cookie, Authorization and Proxy-Authorization show as `<redacted, N chars>` unless `{ secrets: true }`. New `net.har({ path, urlIncludes, bodies, secrets })` writes the journal as HAR 1.2 with the response bodies Chrome still holds, requesting nothing again, and lists the bodies it could not include.
69. **The DOWNLOAD line names the browser's own copy** — both tools left a copy of every download behind without saying so. In a launched browser the line names Playwright's temporary file (deleted when the browser closes) and the `browser new` downloads folder's copy; through the extension it ends with `; Chrome also kept its own copy at <path> (where this Chrome's settings save downloads)`.
70. **Web Workers through the extension** — the relay resumed every dedicated worker and dropped it, so a worker's `console.error` and exceptions were missing from ERRORS and `getLatestLogs()`, and its script request never ended (a click stayed `NOT SETTLED`). The relay now forwards dedicated workers, nested ones included, on the session that started them (page, iframe or parent worker); a session that connects later is told of running workers; a worker's end reaches Playwright on that session, so `page.workers()` drops it and its request ends.
71. **Our auto-attach no longer breaks a page while no session listens** — once a session had asked for auto-attach on a tab, Chrome held every new cross-site iframe and worker of it until a debugger resumed it; with no session of the tab's workspace connected nothing did, and the iframe never loaded (measured: `waitingForDebugger: true`, never resumed). The relay now resumes any iframe or worker no connected session of its workspace will hear about, and any child attach that names no owning session (resumed, not announced; before, it went out on the root session where Playwright detached it).
72. **`screenshot()` and `diffScreenshot()`** — a picture without labels needed raw CDP plus `require('node:fs')` (`page.screenshot()` is refused in human mode), with no element crop, JPEG or change detection. `screenshot({ path, ref, format, quality, ifChanged, threshold, pixelTolerance })` captures the window with one `Page.captureScreenshot`, crops a ref in Node, saves in the session folder and shows the image inline; with `ifChanged` it saves nothing when the window did not change and returns `pixelChangeRatio` and `changedBox`. `diffScreenshot(baseline, { threshold, output, ref, against })` compares a baseline with the page now (or a file) and returns the changed share, the changed box and a red-on-grey diff image; different sizes are refused with both sizes. Captures beyond the window are debug-only: measured, `captureBeyondViewport` resizes the window to 1×1 and back (resize, visualViewport, ResizeObserver and matchMedia events), and a `clip` does the same in a headed window with an emulated viewport, so `screenshot({ fullPage: true })` and raw `Page.captureScreenshot` with `clip` / `captureBeyondViewport` are refused in human mode (the raw forms used to pass the read-only CDP session).
73. **`perf.vitals()`, `perf.metrics()`, `perf.trace`, `perf.profile`, and SHIFT lines** — there was no vitals helper (omp's reloads an adopted page silently), and `Performance.getMetrics` / `Profiler.enable` were refused in human mode as "not a read". `perf.vitals()` reads LCP with its element as a ref, CLS with the shifted nodes, INP with the slow interaction's target, FCP, TTFB, long tasks and long animation frames with their scripts from the page's own timeline (isolated-world observers, no reload), and says why a metric is missing. `perf.metrics()`, a Chrome trace (file + long-task summary with trigger and script) and a CPU profile (file + top self time with url:line) work in human mode, headless and through the extension, and `getCDPSession()` allows those read-only commands. The action report lists content that moved by itself after an action: `SHIFT 0.019 — moved down 136px: [1] button "Load offers", …`.
74. **`pdf({ path })`** — PDF was debug-only through `page.pdf()`. `pdf()` prints with `Page.printToPDF` in human mode (`format`, `landscape`, `printBackground`, `pageRanges`) and says that the page saw a print (its beforeprint/afterprint handlers ran) and whether they changed it; `page.pdf()` stays refused and points to it.
75. **`react.tree()` and `react.suspense()`** — there was only per-element React info. Now the whole component tree (names, keys, props, JSX site, refs) and every Suspense boundary with its state, read from fibers without the DevTools hook or a reload.
76. **`audit()`: an accessibility audit nothing on the page can see** — there was none (omp's `a11y()` had one; the lab's a11y page had 7 planted problems nothing reported). `audit({ ref, rules, tags, page })` runs axe-core 4.14.0 (new dependency, MPL-2.0, pinned: a test fails on another version) in each frame's CDP isolated world — the page keeps no global, mutation, stylesheet, listener, event, request or user activation (tested) — and prints the problems by impact with each element's ref and the rule's help link, returning the full report. Cross-site and nested frames are audited through their own sessions, page-wide rules judged across frames with axe's runPartial/finishRun. It says how many elements it checked and how long it took, which rules it did not run and which frames it could not audit, and why. axe passes a field named only by its placeholder and a `<div>` with a click listener, and has `duplicate-id` off; `placeholder-only-label` and `clickable-without-keyboard` are added and `duplicate-id` is on, so all 7 lab problems are reported.
77. **`cookies()`, `storage()`, `saveState()` and debug-only writes** — `context.cookies()` failed through the relay with `Storage.getCookies: No tab found`, human mode could read only `document.cookie` (no httpOnly cookies), Web Storage was read with `readPage`, and `context.storageState()` failed over the relay and opened a tab per origin. `cookies({ urls, values })` reads through the tab's own session (httpOnly, domain, path, expiry, SameSite, partition key; values hidden as `<N chars>` unless `{ values: true }`), over the relay, in a new browser and while a dialog is open. `storage(kind, { frame })` reads localStorage/sessionStorage in playwriter's isolated world, of the page or one iframe, and says why a frame has none. `saveState({ path })` (a read) writes Playwright's storage-state format from the tab's session and lists what it left out. `setCookies`, `clearCookies`, `setStorage`, `clearStorage` and `loadState` are debug mode only, refused in human mode by the static policy and again when called; `setCookies` reads back what Chrome stored and names each cookie it refused.
78. **`clipboard.read()`** — nothing could confirm what a Copy button copied (omp's helpers return their own shim value over the relay). `clipboard.read()` returns the real clipboard text: through the extension, read by its offscreen document (new `clipboardRead` permission: Chrome's warning becomes "Read and modify data you copy and paste", so a Web Store update waits for the user to accept it); in a new browser, read in a private browser context of its own, invisible to the page (granting the permission to the page's origin was measured to fire the page's `PermissionStatus.onchange`).
79. **WebMCP: the page's own tools** — the fork could not see or use tools a page registers with `navigator.modelContext` (omp has them through a main-world shim). `webmcp.list()`, `webmcp.invoke(name, input)` and `webmcp.events()` use Chrome's native `WebMCP` DevTools domain only — nothing is injected (measured: no `toolchange` event, no main-world call, no DOM change). `invoke` is a human-mode input action (one per call, busy/dialog checks, settle and report after); results, names and descriptions are marked untrusted; a tool that throws, never answers (cancelled after `timeout`) or opens a confirm() is reported as such. Iframe tools are listed, including the ones Chrome's own replay misses, and a cross-origin iframe without `allow="tools"` is named as unable to have them. When Chrome cannot do WebMCP, `webmcp.list()` answers `available: false` with the Chrome version and the exact flags to turn on.
80. **Tabs, popups and dialogs** — a tab opened by a connected tab joined its opener's group as a "freestyle" tab, so the relay answered `Target.getTargetInfo` for it with the first tab's id and tab 0's refs failed "from the previous page"; such a tab now inherits its opener's workspace, the relay never answers for another target, and the probe refuses two open tabs that share an id. A `window.open` popup was reported as "a new tab"; it is `POPUP … (window.open with window features …)`, and TABS marks it `(popup window)`. `act.switchTab` took only an index; it also takes title or URL text that one tab has, and lists the candidates otherwise. DIALOG lines showed `prompt("…")` without its default; they show `prompt("What is your name?", default "Guest")`, and OK without text answers with it. There was no session dialog policy: `act.dialog.policy('accept' | 'dismiss' | 'ask', { promptText, beforeunload })` answers confirm and prompt on every tab, each answer stated in the report, and "Leave site?" only by an explicit `beforeunload: 'leave' | 'stay'`.
81. **The controlled tab closing is said, also within the call** — the session moved to another tab or a new `about:blank` tab without saying so (headless reconnected into a new context). The output now says `TAB CLOSED — … now controlling tab N "…" (the tab that opened it | the first open tab)`, or that no tab is left and which blank tab the next call opens. When it closes during a call, the rest of that call (observe, find, act.*, webmcp, pickElement, waitForPageLoad, the sandbox `page`) works on the tab now controlled, a read cut short by the close is made once more there, and the same call's report gives the line.
82. **Hidden tabs are named, and timeouts state facts** — nothing told the model that the tab it drives is hidden from the user (behind another tab, or its window minimised), where Chrome throttles timers and input and colour and file choosers may not open; Playwright's focus emulation makes `document.visibilityState` read `visible` there. The extension now reports the tab's state (`chrome.tabs`, `chrome.windows`; new relay route `GET /tab-visibility/:targetId`, messages `tabVisibility` / `readTabVisibility`, no new permission), and a `HIDDEN` line in observe and every action report gives the effect and the fix (`page.bringToFront()`). Timeouts guessed "a native JS dialog may be open"; they now state the timeout, then the open dialog if there is one, otherwise whether the tab is hidden.
83. **A password manager's autofill menu no longer loses the tab** — Bitwarden's inline menu (a `chrome-extension://` iframe put into the page when an email or password field gets focus) made Chrome take the extension's debugger off the tab; the extension dropped it, the relay said it had closed, and the session silently moved to a new `about:blank` tab. The extension now keeps the tab and re-attaches it as soon as Chrome allows (at once, on a backoff for 5 minutes, on that tab's events and on every call), never removing the other extension's frame; the relay records the cut and its cause (`GET /debugger-cuts/:targetId`) and announces a clean re-attach, and the session takes the same tab back. The model reads `DEBUGGER CUT — …` with either `Re-attached after N s; refs from before are gone — observe() again.` or what to do while the frame stays; reports said `the page was closed` and now say `Chrome took the debugger off the tab (DEBUGGER CUT above)`, without a stack or a "call reset" hint, and refs of the cut tab say `is from before Chrome took the debugger off this tab`. Pages no extension may debug (`chrome://…`) are handled the same way. An attach that won the race right after the cut left a stale debugger session, so every later attach failed with "Another debugger is already attached"; the re-attach now releases it and attaches again.
84. **A crashed renderer no longer wedges the session, and `act.reload()`** — after a tab's renderer crashed every call failed with `Target crashed` (or waited 5 s and blamed a native dialog) until `reset`. The crash is now reported (`PAGE CRASHED — … act.open(url) or act.reload() reloads it`), other calls are refused at once with that line, and `act.open(url)` or the new `act.reload({ reason })` — the browser's Reload button, one action, a reason required on a loaded page — continue in a new tab of the same context (`PAGE RECOVERED`), the crashed tab closed.
85. **Recording without the extension** — `recording.start()` in `browser new` or over direct CDP failed with `Failed to start recording: Extension not connected`. It now records with the CDP screencast when there is no extension tab capture; every result names the recorder (`recorder: 'extension-tab-capture' | 'cdp-screencast'`, with a `note` for the screencast), options only tab capture has (`audio`, bitrates, a non-`.mp4` path) are refused before anything is recorded, and `recording.isRecording()`, which said `false` during a `recording.startCdp` recording, reports either recorder.
86. **The MCP server exits with its client** — closing its stdin (how an MCP stdio client ends a session) left the server and its headless Chrome running until SIGTERM. It now releases what it drives (a launched Chrome closed, a relay or direct connection dropped) and exits, measured 380 ms after EOF.
87. **New browsers look like a person's Chrome** — `browser new` launched the system Chromium with `--enable-automation` (navigator.webdriver true, `HeadlessChrome` UA in every scope, SwiftShader GPU, screen = viewport): bot.sannysoft 26 passed / 5 failed, CreepJS 100% headless. It now launches the installed Google Chrome without `--enable-automation`, AutomationControlled off, the binary's own headed User-Agent and complete client hints sent to every page, iframe and worker target through CDP before it runs (no page script), the real GPU on Linux, a desktop screen and window: sannysoft 31/0, CreepJS 0% headless / 0% stealth. Playwright's launch disabled ThirdPartyStoragePartitioning, HttpsUpgrades and BoundaryEventDispatchTracksNodeRemoval; they stay on, and WebMCP's features are merged into Playwright's own `--enable-features` (Chrome keeps only the last one).
88. **`browser new` takes launch options** — it took none. `viewport`, `device` (Playwright's Chrome presets, as Chrome on Android with matching client hints), `userAgent`, `locale`, `timezone`, `colorScheme`, `headed` (refused without a display), `allowedDomains` (other hosts blocked browser-wide, workers included, and named in ERRORS) and `downloads` (every download also saved there by name) are checked before the current browser is released and listed by `browser list`.
89. **Faster new sessions** — the MCP server imported the executor and Playwright before answering `initialize`, and launched Chrome on the first call. It now answers before loading the executor, and with `PLAYWRITER_BROWSER=new` launches the browser in the background; a binary's identity is probed once and cached in `~/.playwriter/chrome-identity.json`. Measured from spawn, 5 runs each, on a 64-core Linux machine under load from other jobs (load average 7–12), Chrome 149 headless, lab server on 127.0.0.1: `initialize` + `tools/list` 1.30–1.40 s; with `PLAYWRITER_BROWSER=new` the first `observe()` of about:blank returned at 2.19–2.31 s and the first observe of a lab page (form.html, `act.open` ≈1.0 s) at 3.33–3.50 s; without it, `browser new` took 0.78–0.82 s, about:blank was observed at 2.28–2.36 s and the lab page at 3.43–3.55 s. A rerun on a quieter machine measured `initialize` + `tools/list` at 0.44–0.52 s, about:blank observed at 2.28–2.35 s and a lab page at 3.25–3.32 s. The battery before this change measured 3.6–3.8 s to the first usable page.
90. **Faster actions and observe() on large pages** — an action read the accessibility tree 6 times and the full DOM 4 times (about 22 MB of protocol data per action on Wikipedia). It now reads each once per picture: the busy guard's read is the before-picture's, busy signals and the snapshot share one tree, the page model and the snapshot share one `DOM.getDocument` (replacing the deprecated `DOM.getFlattenedDocument`), and settle no longer reads busy signals (`waitForIdle` and `busySignals()` do; the report's BUSY line comes from the after-picture as before). Measured headless: Wikipedia observe() 1.4 s → 0.9 s and an action 4.1–5.0 s → 2.4–3.2 s, GitHub observe() 1.0 s → 0.5 s and a click 3.0 s → 2.0 s, protocol data per action about halved. Human pacing is unchanged.
91. **The guide names the new lines and instruments** — the start-here guide now says what to do on `HIDDEN`, `TAB CLOSED`, `PAGE CRASHED`, `DEBUGGER CUT`, `SHIFT`, busy skeletons and re-renders, shows the find() query handlers, point targets and right-click, editor blocks and `{ at: 'caret' }`, `act.dialog.policy`, `act.switchTab(text)` and `act.reload`, and names the `docs()` topic of each instrument; the reference has a section per area (recording, perf, pdf, screenshots, audit, storage, clipboard, webmcp, react, network, dialogs, tabs, find, snapshot diff, browser new).
92. **An input that closes its own tab is reported as done** — a page that calls `window.close()` from an input handler (click, mouseup, pointerdown, contextmenu, dblclick, keydown, a drop) can take Chrome's confirmation of the release with the tab, so `act.click` (and `dblclick`, a right click, `act.press`, `act.drag`) reported `✗ … FAILED: mouse.up: Target page, context or browser has been closed` and `Error executing code`, although the click happened and closing the tab was its effect. Once Chrome confirmed the press (the mouse button, the key-down) and the tab closes during or right after the release, the ACTION line reads `✓ click [6] button "Close this window" — the tab closed (the page closed itself in response)`, then the `TAB CLOSED` line, and the call does not fail. A tab closed before the press is still a failure with its cause (`Not done: the tab closed before the mouse button was pressed (while the pointer moved to it); nothing was clicked.`), and a press whose confirmation Chrome lost with the tab says `whether the page got it cannot be told`. An action that only clicks on its way (fill, check, select, upload, `act.press` with a ref) stops there: `the click on … closed the tab (the page closed itself in response): the rest of this fill was not done.` `act.press` now sends its key events one at a time (modifiers down, key down, key up, modifiers up — the order of Playwright's `keyboard.press`), to know whether the key-down was confirmed.
93. **Images nobody can see are not listed** — table-layout spacer `<img>`s (Hacker News' 14×1 and 0×10 px spacers) were listed as `role=image >> nth=1..4` in `snapshot()` and as `image (no alt)` lines in observe. An image whose rendered box has a side of 1 px or less, or no box, is no longer listed in either, and a 1×1 `alt=""` pixel is no longer counted on the `IMAGES … decorative` line. observe and every act picture measure it from the layout snapshot they already read (0 `DOM.getBoxModel` calls; before, one per image on every snapshot — through the extension 200–650 ms per observe and 200–800 ms per action on a page of 300 images, Wikipedia's Cat 63 calls per observe, unsplash 40, BBC News 54); only a standalone `snapshot()` reads one box per image. Measured from the rendered box, an image a CSS transform shrinks below 1 px is now unseen, and one 1–1.5 px wide is listed (getBoxModel rounded it to 1 px).
94. **New browsers paint their first frame** — with many Chromes starting at once and `--use-angle=gl-egl`, pages of a new browser had not painted 1.5 s after load (`perf.vitals()`: FCP and LCP unknown; 0 of 32 painted, 6 of 32 a second later). `browser new` now waits for Chrome's GPU process (`SystemInfo.getInfo` on a browser session, a read no page sees; 10 s deadline, logged and skipped if it fails) before the first page opens: 32 of 32 painted, FCP 240–436 ms. It costs 4–10 ms on an idle computer, 1.4–2.1 s in a 32-launch burst.
95. **The beyond-viewport screenshot note says "up to twice"** — it said the page gets the resize, visualViewport resize, ResizeObserver and matchMedia events twice; on a loaded computer the two resizes merge and the page gets them once.
96. **A tab is announced to a client once** — when a tab's attach reached the relay while a client's first `Target.setAutoAttach` was still in flight, the relay forwarded it live and its replay sent it again on the same session. Playwright then put a second session object under that id and threw `Duplicate target`. Every answer for the tab went to the orphan, so `locator.click` and `cdp.send` hung. The relay now remembers what it announced to each client and skips a repeat, and the extension's initial tab for a workspace is the tab it already has instead of a new background `about:blank`. Reproduced by holding the extension's frames 250 ms; covered by a relay-workspace test.
97. **Freeing a port no longer scans the process table three times** — `killPortProcess` asked `lsof` for the port's process; when nothing listened, `lsof` exits 1 with no output, which was read as a failure and followed by `lsof -i` and `fuser`, two more full scans for the same empty answer (1.2 s idle, 6 s under load). An exit 1 with empty output is now the empty answer.
98. **The extension no longer loses a tab that two paths attach at once** — when the relay connection opened, a toggled tab was attached twice together, once by its own connect and once by the re-attach of 'connecting' tabs. The second `chrome.debugger.attach` failed with "Another debugger is already attached", and its error path dropped the tab. The relay then auto-created a background `about:blank` tab, and the whole session ran there while Chrome throttled it: no paint, no layout, about 1 frame per second. Attaches of one tab are now single-flight: a second request joins the running one and gets its result. If the debugger already on the tab is the extension's own, that is not a failure. An attach error no longer removes a tab that another connect took over or connected. The test harness's `toggleExtension` now fails setup, with the extension's error, if the tab did not end up connected; `attach-race-relay.test.ts` forces the collision 10 times.
99. **A call that only waited no longer says "Do not assume it worked"** — `act.waitForIdle()` or `act.wait(ms)` after the result had already appeared ended with `NO VISIBLE CHANGE — … Do not assume it worked`, as if the wait were an action that had failed. A call whose actions are only waits now says `NOTHING CHANGED WHILE WAITING — waited 1616ms; the page was quiet; the page looks as it did before the wait. A wait does nothing to the page, so this says nothing about earlier actions …`. A call with any other action keeps `NO VISIBLE CHANGE`.
100. **One line for a new tab, naming act.switchTab** — after a click opened a tab, the report had its `TAB … — act.switchTab(1) to work in it` line and also Playwright's `[WARNING] New page opened from current page (index 1, …). Access it via context.pages()[1] to interact with it.`, a raw-Playwright instruction human mode refuses. The warning is left out when the action report already named the tab. A tab opened outside a reported action gets `[WARNING] TAB a new tab opened by this page (tab 1, initial url: …) — act.switchTab(1) to work in it`; debug mode adds `or context.pages()[1] in code`. Its index is act.switchTab's (open tabs only).
101. **Line breaks are shown as ⏎ everywhere a value or text is printed** — a chat composer holding `Hello` / `World` was reported as `value "" → "Hello World"` and the sent message as `+ item: "Hello World"`, while the act line printed the raw line break and broke the report's layout. Values, texts, find() excerpts, `LIVE` lines and act's own lines (typed text, `value read back`, `replaced the previous value`) now show each line break as `⏎`: `value "Hello⏎World" → ""`, `+ item: "Hello⏎World"`. Observed text keeps the breaks the page renders (pre-wrap text, where Chromium's accessible text has them); other whitespace still collapses. The guide says what `⏎` means.
102. **getLatestLogs({ search }) returns only what matches** — it returned every entry within 5 of a match as "context", with `---` between runs: `search: 'cors'` gave 12 entries, 10 of them `[lab-witness] probe` lines. Each entry already carries its own `at` lines, so the search now returns the matching entries only; a string matches case-insensitively, a regex with the `g` or `y` flag no longer skips every other match, and `count: 0` returns nothing instead of everything.
103. **Unchanged rows of a table whose caption changed are no longer `-`/`+` pairs** — deleting INV-1003 on the invoices page changed the caption to "Showing 1–6 of 11 invoices" and re-rendered the rows: the five unchanged rows printed as `- row …` / `+ row …` pairs, because pairing by meaning compared each row's container by its label, the caption. A container still in the document is now compared by its node; one that was itself replaced is still compared by its label.
104. **A plain ref covered at every point names the spot to press anyway** — `act.click(22)` behind a modal was refused with `covered by div#newsletter-backdrop.backdrop at every point a person could click`, while the point form added `To press that spot anyway (it lands on what is on top): { ref: 25, x: 867, y: 859 }.` The plain-ref refusal now adds the same hint for the first covered point tried (the centre of the target's largest visible part), when the cover has a ref.
105. **docs('point') and docs('right-click') reach the point-target section** — `docs('point')` returned only the humanMouse section, and the `{ ref, x, y }` syntax was only under `docs('drag')`. The clicking section is now "clicking: a point of an element ({ ref, x, y }), right-click, double-click", with human-mode examples.
106. **perf.vitals() puts a slow handler under processing** — the INP breakdown was taken from the interaction's longest event alone, which for a click is often the pointerup (no handler, same paint as the click): a 300 ms click handler printed `input delay 1 ms, processing 0 ms, presentation 319 ms` next to a long animation frame naming that handler. The breakdown now follows web-vitals' attribution over all the interaction's events (grouped by interactionId; those painted in the same frame as the longest one): input delay to the first handler, processing from the first handler's start to the last one's end, presentation from there to the next paint. The line names the event types in the order they happened and each event whose handlers ran — `pointerdown/pointerup/click on [3] button "Run heavy task (300 ms)": input delay 1 ms, processing 30x ms (click 30x ms), presentation 1x ms` — and the result has `inputDelayMs`, `processingMs` and `presentationMs`.
107. **A phone preset gets a finger, not a mouse** — with `browser({ action: 'new', device: 'Pixel 7' })` the page reported a touch screen, but `act.click` moved a mouse along a hover path first (the witness counted 41 mousemoves and 8 elements entered before the click). On a context with touch emulation act now taps with `Input.dispatchTouchEvent` (a finger radius, ~50–110 ms down): the page sees pointerType `touch`, pointerdown, touchstart, pointerup, touchend, then Chrome's compatibility mouseover, one mousemove, mousedown, mouseup and click — what a real tap and Playwright's touchscreen.tap give, measured on Chrome 149 — with the busy, cover and point checks unchanged. `act.dblclick` is a double tap, `act.drag` a finger drag along the same human or straight path, `act.scroll` and scrolling an off-screen target into view are swipes, measured after each one. `act.hover` is refused with the reason (a finger does not hover; a tap opens hover menus), and so are right and middle clicks: Chrome's touch emulation never turns a long press into a context menu (a press held 0.9–1.7 s gave a plain click). The report says `tapped with a finger` / `scrolled with finger swipes`.
108. **A ref click reaches an element partly in view when nothing can scroll further** — `act.click(134)` on the last item of a context menu that stuck out of the window's bottom edge was refused ("The page did not scroll when the mouse wheel turned over page (twice)"), while a point click on the same item worked: the menu is fixed to the window, so wheeling the page never moved it, and the page was already at its end. Each wheel step is now cut to what its scroller has left; a layer fixed to the window (position: fixed) is never wheeled with the page, only the scroll areas inside it, judged by their part inside the window; the part of the target in view is clicked (also when the page ignores the wheel). A target with no part in view is refused with the reason: it is in a named layer fixed to the window, or the page is already scrolled as far as it goes.
109. **A read after an action in the same call sees the settled page** — `await act.open(url); await observe()` printed an observation taken while the page still showed its loading skeletons, under a report saying the page had settled with 10 controls. `observe()`, `find()`, `explain()`, `readPage()`, `getPageMarkdown()`, `getCleanHTML()` and `audit()` now first wait for the settle the report will show; the report reuses it, so a call waits no longer than before.
110. **A colour chooser that did not open is no longer blamed on the page** — the error said "(the page may handle the click itself)" with no evidence. It now says what is known — the chooser is still closed 1 s after the click, and what the input reads — then the cause Chrome can show: a hidden tab (`page.bringToFront()`, or restore a minimised window), otherwise a window that cannot take the focus, likely one on a workspace the user is not looking at, which Chrome reports like any other (`page.bringToFront()`, then ask the user to show the window). Measured with Chrome 149 and Chrome for Testing 145, headed under Xvfb, through the extension: the chooser never opens in a background tab, nor in a window shown again without the focus (`page.bringToFront()` fixes that); a window on an i3 workspace that is not shown reads `normal` in `chrome.windows`, so `HIDDEN` cannot report it.
111. **Iframes whose documents Chrome holds no longer hold every action** — on MDN, `act.open` reported `NOT SETTLED after 5054ms — waiting on GET …/runner.html …` and every observe() printed 13 `BUSY? no response yet` lines. Chrome delivered those documents one by one over a minute (MDN's runner answers with `Clear-Site-Data`). An iframe's document Chrome has not answered for 2 s now stops holding the settle: the SETTLED (or NOT SETTLED) line says `not waited for: 15 iframes still loading their documents — [12] iframe "runner"'s document http://… — Chrome has not delivered it after 2.1s · …`, a pending iframe document is named by its iframe's ref instead of a bare GET, and observe() puts them on one line: `BUSY? 15 iframes still loading their documents: [12] [14] …`. The journal keeps them open until Chrome answers. On a 15-example fixture `act.open` settles in about 2.1 s instead of 5 s, headless and through the extension.
112. **observe() and act.* while an iframe commits its next document** — `act.open` from MDN failed with `DOM.resolveNode: Node with given id does not belong to the document`: the before-picture read an iframe document's pointer listeners just after that iframe committed its next document. Listeners are now read before the page's frames are checked for new documents, and a document that left its frame meanwhile makes that frame be read again, on the new document.
113. **No FILE DIALOG line about an iframe that left** — after a navigation the report said `FILE DIALOG watch: releasing the file dialogs of an iframe of …/Array/map failed: … (Page.setInterceptFileChooserDialog): No tab found`. The file-dialog gate kept the session of an iframe whose document had left and released interception there. It now forgets a session that no longer carries a frame of the page before it arms or releases, and a toggle whose session is gone (`Target page, context or browser has been closed`, `Session with given id not found`, the extension's `No tab found`) gives no line; a failure on a session that still carries a frame is reported as before.
114. **Worker errors Chrome never reports are documented for `browser new` too** — a worker error missing in `browser new` was errors.html, which terminates its worker inside the worker's error handler: Chrome reports nothing of that error (measured over raw CDP on Chrome 149, the Chrome `browser new` runs; asserted through the extension in workers-relay.test.ts). The guide and the limits now say so.
115. **A debugger cut is not re-attached while the menu is still loading** — Chrome cuts the extension's debugger when another extension's frame starts loading its page and refuses the debugger once that page has loaded; in between it lets an attach through (measured on Chromium 145: about 15 ms on an idle machine, about 425 ms when the other extension's worker answers its menu page 400 ms late). Under a full test run's load the re-attach completed inside that window: the call said `Re-attached after 0.1 s`, and every read after it failed with `Chrome lets no debugger into its document`. For 10 s after such a cut the extension now checks the frame that cut the tab before announcing it (`Page.getFrameTree`: a frame with no address yet is still loading) and keeps trying instead; the tries say `another extension's frame is still loading … in the tab, and Chrome refuses the debugger once it has loaded`. debugger-cut-relay.test.ts opens the window on any machine with a menu page its extension's worker answers 500 ms late.
116. **An input a debugger cut stopped is not reported as a closed tab** — `act.click`, `act.press`, a drag's drop or release and touch input said `The tab closed while the mouse button was being pressed … cannot be told` (or `✓ … the tab closed (the page closed itself in response)`) when Chrome had only taken the debugger off the tab. They now say how far the input got and what reached the page (`Not finished: Chrome took the debugger off this tab (DEBUGGER CUT above; the tab is still open) while the mouse button was being pressed: … so the page got no click — at most the press.`) and point to observe() once the tab is back; an input that went through whole keeps its ✓ with a note. "cannot be told" is kept for tabs that really closed.
117. **explain() no longer reports an unresponsive page while it parses a large bundle** — the handlers and components of one element usually live in one bundle, and each read its source itself: the first read's Babel parse (about 0.7 s for a 976 KB React dev bundle on a free core, several seconds under load) kept Node busy past the second read's 3 s deadline although Chrome had answered it (`The page did not respond within 3000ms while reading the source of …/app.js`). Reads of one script that run at the same time now share one `Debugger.getScriptSource`.
118. **The extension reloads itself into a newer build** — after every rebuild of the fork, someone had to click ↻ on the Playwriter card in chrome://extensions before Chrome ran the new code. Every extension build now gets an id (the first 8 hex digits of a SHA-256 over the files it writes; the same files give the same id, so a rebuild that changes nothing reloads nothing), compiled into background.js and written to `build.json` last, through a rename (vite `closeBundle`, after rolldown's and vite-plugin-static-copy's writes; the Prism download now runs before `vite build`; the copy the playwriter package bundles copies `build.json` last too). An unpacked install reads its folder's `build.json` right after each connection to the relay, on its 30 s wake and when it stops controlling tabs; when the folder names another build it logs `reloading itself: build <old> → <new> (its folder has a newer build)` and calls `chrome.runtime.reload()`, only while it controls no tab and no attach, relay command or recording is in flight — otherwise it says once that a newer build waits, and tells the relay. A reload opens no tab, creates no tab group and keeps the extension's relay key (measured on Chrome for Testing 145 and Chrome 149: `onInstalled` reason `update`, storage.local kept; 0.3–1 s from the relay restart to the extension back on the new build). `browser list` shows `extension built with playwriter 0.4.0, build 77e117b6`, adds `(a newer build is in its folder; it reloads itself once it controls no tab)` while one waits, and lists an extension without a build id as one that does not reload itself (built before this, or not loaded from the fork's folder, such as a Chrome Web Store install), asking the model to have the user click ↻ once when it is the fork's folder. A worker whose background.js kept the build-id placeholder (a build that stopped before its last step, loaded at a Chrome restart or a ↻) reloads only into a build written after it was loaded, kept in storage.session: compared like any other it reloaded into the same files 30 times in 30 s (measured), and `browser list` says `from a build that did not finish (it reloads itself into the next build written to its folder)`. `playwriter browser start` turns Developer mode on in its profile: reloading an extension loaded with `--load-extension` while Developer mode is off disables it (measured). The dev prelude (`pnpm dev`) uses the same `build.json` comparison instead of hashing the bundle every second against a stored baseline, and the `reload` scripts that opened chrome://extensions are gone.
119. **Settle survives an iframe Chrome moves into its own process** — a same-site iframe that navigates to another site is moved by Chrome into a renderer process of its own: the page session gets `Page.frameDetached` with reason `swap` and from then on answers every read of that frame with an error ("No frame for given id found", "Cannot find context with specified id", "Frame with the given frameId is not found"; measured on Chromium 145), while Playwright keeps the same Frame and follows it on a new session. A settle pass that had listed the frames just before the swap read the iframe through the page session, and Chrome's error became the report's verdict: `NOT SETTLED — cdpSession.send: Protocol error (Page.createIsolatedWorld): No frame for given id found` (seen once in a full test run). Settle now leaves such an iframe out of that pass, as observe already did (one shared check, `isFrameLeftError`), and the next pass reads it on its own session. frame-swap-live.test.ts makes the swap land inside a pass every time; it runs on full Chromium, because the headless shell never moves the iframe (measured).
120. **Freeing a port no longer takes seconds on a busy machine** — on Linux, `killPortProcess` (it stops a relay, and the tests use it) found the process listening on the port with lsof, which reads every open file of every process: 632–659 ms with 1235 processes running, and 5.3 s during a full test run, past kill-port.test.ts's 5 s bound. It now asks iproute2's `ss` (the sockets over netlink, then one pass over the processes' descriptors in C): 195–203 ms on the same machine, and a kill plus the wait for the port to free took 467–515 ms, alone and next to the live suites. lsof is still asked where ss cannot answer.
121. **act.drag brings both ends into view before it presses** — a scroll toward a point stops as soon as the point shows, at the edge it came in from, so after the scroll to a drag's start its end could still be under the window's edge: a stroke from (150, 1300) to (200, 1320) of a tall pad was refused with `(200, 1320) of … is not visible while dragging` (once in a full test run: it depended on where the last wheel step left the start), and the refusal came after the press — the page got a pointerdown and a pointerup at the start (measured: `down 100 20; up 100 20` on act-drag-edge.html), a click the report did not mention. act.drag now wheels to the start, then to the end, checks that the start is still in view, and only then presses; two points that do not fit on the screen together are refused before anything is pressed, saying so. act-newline-drag-live.test.ts drags from a point in view to one just below the window, which failed every time before.
122. **Fast settle: on evidence, never on time** — `settle({ pace: 'fast' })`, used by fast mode, has no quiet windows. In every readable frame's isolated world the page runs the work it has queued — 3 MessageChannel round trips, with the microtask checkpoint after each (a chain of `setTimeout(0)` is clamped to 4 ms after 5 levels: 20 nested turns took 58 ms against 1–2.5 ms; requestAnimationFrame needs a frame being rendered) — while the journal's MutationObserver listens: a content mutation (by human settle's rules: not cosmetic, not ambient, not an element already churning) starts a new pass, and a whole pass with no content mutation, no caused request awaiting its answer and no navigation in progress is settled. Three round trips is the measured worst case (a handler's three nested `setTimeout(0)`, React 19.2.7's time-sliced transitions and its setTimeout → setState → effect → setState chain); plain handlers, React sync updates, Vue 3.5.39 and Svelte 4.2.19 needed at most 2. Each caused request is a promise resolved by its own `responseReceived`, `loadingFinished` or `loadingFailed`; navigations and dialogs end on their events (`frameStartedLoading` came before the pass's answer 40 of 40 times); the only timer is the `timeoutMs` cap. A response that answered and stays open (a stream, a long-poll) is listed in `fast.openStreams`, not waited for; a request never answered is awaited to the cap and named in a NOT SETTLED, where the 2 s and 3 s age facts only sort it (`iframeDocuments`, `fast.stalledAssets`). It does not wait for work the page starts later on a timer: a debounced search settled in 6–11 ms and its result came about 350 ms later; `fast.coveredMs` says how far the evidence reaches. Measured on Chromium 145, fast against human: a static page 7–9 ms / 506–583 ms, an 800 ms fetch and its text 813–819 / 1347–1385, a 600 ms POST 614–616 / 1142–1150, a link to a new document 33–49 / 523–621, an iframe the click inserts (a 300 ms document, then a 600 ms POST in it) 921–932 / 1432–1523. Human settle is unchanged; `SettleResult` is a union on `pace`.
123. **Fast mode, chosen per session** — `browser({ action: "use" | "new", mode: "fast" })` (or `PLAYWRITER_POLICY=fast`, `--policy fast`) runs the session with debug mode's freedom (several actions per call, `page.route`, init scripts, DOM/storage writes, raw Playwright) and act.* without human pacing: one straight pointer move then the press (the humanMouse driver's `pace: 'fast'`), keys without delays, no pauses, the wheel's whole distance in one turn (measured: one mouseWheel of up to 15000 px scrolls all of it on Chrome 145), drags along 5 straight moves, select type-ahead and colour-chooser keys without delays. Hit tests, cover and disabled refusals, the busy guard (now also in webmcp.invoke), dialogs and reports stay; its settle is the fast settle (item 122), and the SETTLED line says so and what it does not wait for. Several actions in one call print a report per action, in order. The `browser` reply and `list` name the mode, and switching is a new `use`/`new` call. Measured on Chromium 145: six actions (three fills, a select, a check, the submit) in one fast call in 2.3–2.4 s; per action, human against fast: click 1369–1409 / 389–443 ms, fill 2573–2743 / 399–476, select 2401–2533 / 496–588, drag 2302–2441 / 282–311, scroll 1614–1751 / 201–252. In both modes, waits that are not pacing now wait on state, never on a poll, each under a cap: a native dialog appearing (the dialog controller's event), a wheel or swipe's scroll ending (`scroll`/`scrollend` in the isolated world), a checkbox toggling and a select changing (a MutationObserver and input/change in the isolated world; human mode's half-second glance at a select ends with one more read, because a value the page puts back from script fires no event and changes no attribute), `act.back()` committing (Page.frameNavigated / navigatedWithinDocument); the colour chooser's `:open` and a select's open list are read once, right after the input's ack (measured: set by then, 5 of 5), so the colour chooser's failure now says it `was still closed once the click was done`. Recording in fast mode is allowed: the video shows the fast input as it happened.
124. **Human settle, the report and the video harness wait on events, not on a period** — human settle (`settle()`, `waitForIdle()`) read every frame's journal every 75 ms until its quiet windows held. It now sleeps between reads until something that can change its verdict happens: each frame's journal answers a wait it arms (`settleWait`: a content change; while waiting for idle on a strong busy signal, any change, a scroll included; a loading indicator appearing or going), and a caused request's event, a navigation, a dialog or the page closing wakes it too. Its one timer is the earliest moment its verdict could change with nothing happening: the quiet windows' end, a strong busy signal's own end (a stream or a body going stale, a bar no longer moving), a due look for closed shadow roots, or the cap. Measured on the page-watch fixtures (3 runs, 102 settles each): 16.5 → 10.7 page reads per settle, waits the same (994 → 967 ms on average), the same results; `busyWhileSettling` now measures how long a loading indicator was seen up to the change that removed it. An act call the code did not await is waited for on its end, not with a 50 ms poll (report lag median 26 → 0.05 ms). The video oracle's harness waits for a produced frame (two requestAnimationFrame callbacks) instead of 40 ms before each capture, and for the next frame instead of 150 ms before retrying one: 500 captures in 23–25 s against 43 s, no capture failed in 1000 either way. Every timer left in the code says which it is: a cap racing an event, human pacing, the quiet windows, a heartbeat, keepalive, backoff or TTL with no event to wait on, or a duration that is the feature (`act.wait`, `waitForPageLoad({ minWait })`, `net.delay`, a recording's hold and frame rate, the cursor's idle fade, the file-chooser hold until Chrome's user activation expires).
125. **The relay starts, stops and is waited for on its own signals** — `ensureRelayServer` spawned the relay and polled `/version` every 200 ms, then slept 1 s. The relay now tells its spawner over the spawn's IPC channel when it listens (or which relay already does), and a relay that dies first is reported at its exit with its code or signal and its log (545 ms against the 5 s cap); from source it runs as this Node with tsx's loader, which forwards the channel and the daemon's own exit (through the `tsx` CLI a killed daemon read as `exit code 1`, and the channel stayed open). The 1 s sleep (it waited for an extension to connect) is the relay's new long-poll with that same cap. `GET /extensions/status?until=connected&waitMs=N` and `GET /extension/status?until=free&waitMs=N` answer as soon as the relay's state meets the condition (at once when it does already) or at the cap, with the same JSON; without `until` they answer at once, as before. `waitForConnectedExtensions` is one such request: it returns 1.1 ms (median, 20 runs) after an extension's socket opens, against 93 ms with the 200 ms poll. A relay being replaced is stopped on the close of a connection opened to it before the kill (the kernel closes it when the process dies), not on 100 ms polls of the port. `waitForRelayVersion` is gone: a relay that listens holds a request in its accept backlog until it answers (measured: answered 1530 ms after a 1500 ms block), and Node binds and listens in one step.
126. **The extension reconnects on events** — its reconnect loop looked at its socket every second and slept 3 s after each attempt. The socket's close now wakes it at once (back 14–30 ms after a relay restart, 5 restarts in a row, against up to 1 s plus a 3 s pause); while the relay is down it tries every 250 ms, the one timer kept (an extension cannot observe a local port starting to listen; a relay that was just started waits 1 s for an extension), and is back 257–281 ms after the relay listens. An extension another one replaced waits for the slot with `/extension/status?until=free` (back 15–21 ms after the other leaves, one request), and keeps the 3 s backoff against a relay from before that parameter, which answers at once. A toggle waits on the store's subscription for its tab to leave 'connecting', with a 30 s cap that names why the tab is still connecting (it waited forever). A popup window's tab is found with tabs.onCreated and one query (chrome.tabs.query lists it already when windows.onCreated arrives, 8 of 8, Chromium 145), not 5 queries 20 ms apart; the popup-opener map loses an entry when it is used or its tab closes, not after 10 s. The fixed sleeps before attaching a tab the relay created (100 ms), before attaching a Ghost Browser tab (100 ms) and after removing other extensions' iframes (50 ms) are gone: `context.newPage()` through the extension took 544 ms (median, 16 runs) against 939. The 50 ms between `Runtime.disable` and `Runtime.enable` is gone too: Chrome has handled the disable when it answers it.
127. **Fast mode: touch input without pacing, and a busy guard that does not trip on the action's own changes** — on a phone preset, fast mode tapped, double-tapped, swiped and dragged at a person's pace. Taps now go at once; swipes and finger drags go at once as at most 3 moves whose CDP `timestamp`s carry a person's stroke, so Chrome's gesture detection — the fling, the rest before the lift — reads it as one. Measured on Chromium 145 (5 runs each): tap and double tap 8–12 / 39–54 ms against 85–88 / 312 ms, click and dblclick 5 of 5; a 300 px swipe scrolled 285 px either way (109–112 ms against 459–478), and flung on to 430–459 px when sent at once without the times; a finger drag of a slider in 309–320 ms against 1576–1707. The busy guard's "content still changing" (3 content changes within 1.5 s, the newest under 0.5 s old) refused the action right after a fast tap, because the tap's own changes, over within milliseconds, were still in that window (act-touch-live in fast mode: 3 of 5 tests refused, 3 runs of 3). In fast mode it now counts only the changes after the page's last settle, which proved the content quiet: allowed 4 of 4 after a finished burst; a stream (a token every 30 ms) refused 4 of 4 once 150 ms or more passed since its start, and not seen when the next action follows at once (Known limits). observe()'s BUSY line, `webmcp.invoke` and the guard before raw input read busy by the same rule. act-touch-live runs every case in both modes.

## 0.4.0

1. **Cloud browser sessions via Browser Use** — spin up stealth Chromium VMs in the cloud with `playwriter session new --browser cloud`. Cloud browsers support residential proxies (`--proxy us`, `--proxy de`), custom proxies (`--custom-proxy host:port`), and configurable timeouts (`--timeout 120`). Idle sessions auto-disconnect after 10 minutes.

   New CLI commands for cloud management:
   ```bash
   playwriter cloud login       # authenticate via device flow
   playwriter cloud status      # list active cloud VMs
   playwriter cloud subscribe   # open subscription page
   playwriter cloud live        # open live browser view
   ```

   Selecting a running cloud session (`cloud-1`, `cloud-2`) reattaches to the existing VM instead of creating a new one.

2. **Headless browser mode** — run without the extension or a visible browser:
   ```bash
   playwriter browser install                    # download Chrome for Testing
   playwriter session new --browser headless      # launch headless Chrome
   playwriter -s 1 -e "await page.goto('https://example.com')"
   ```

   Multiple sessions share the same Chrome process. Each session gets its own isolated context. Recording is not available in headless mode.

3. **API key authentication for cloud browsers** — skip the interactive device flow in CI and headless environments:
   ```bash
   export PLAYWRITER_API_KEY=pw_xxxxx
   playwriter session new --browser cloud
   ```

   Create and revoke keys at https://playwriter.dev/dashboard. Authentication priority: `PLAYWRITER_API_KEY` env var, then `PLAYWRITER_CLOUD_TOKEN` env var, then `~/.playwriter/auth.json`.

4. **Fixed relay routing across Chrome profiles** — the relay now identifies extension connections by per-profile install id before falling back to account identity, so two profiles signed into the same Google account no longer replace each other's relay connection. `context.newPage()` and `Target.createTarget` route to the intended browser profile.

5. **Fixed cloud billing race conditions** — concurrent `playwriter session new --browser cloud` requests now use durable per-org slot claims, preventing over-provisioning beyond the subscribed session quantity. Stripe Checkout also verifies Stripe directly before creating subscriptions, avoiding duplicates while webhook delivery is pending.

6. **Fixed `playwriter cloud login`** — the CLI now uses Better Auth's current device authorization endpoints (`/api/auth/device/code`, `/api/auth/device/token`) so cloud browsers appear after approving the login.

## 0.3.1

1. **Auto-page creation enabled by default** — MCP and CLI sessions now automatically create a blank Playwriter-enabled tab when no targets are available, so agents can start working immediately without manual tab setup. Set `PLAYWRITER_AUTO_ENABLE=false` to disable.

## 0.3.0

1. **New `sinceLastCall` option for `getLatestLogs()`** — inspect browser logs after every action without seeing duplicate messages:
   ```bash
   playwriter -s 1 -e 'console.log(await getLatestLogs({ page, sinceLastCall: true }))'
   ```
   The first call returns all buffered console logs and page errors for the page. Later calls return only new entries since the previous `sinceLastCall` read. Logs also persist across navigations, so hydration errors, redirect failures, and startup exceptions are not lost when the page changes.
2. **CDP logs now rotate automatically** — `~/.playwriter/cdp.jsonl` is capped at 10,000 entries by default to prevent unbounded disk growth. Set `PLAYWRITER_CDP_LOG_MAX_ENTRIES` to tune the cap. Rotation keeps the newest half of the log and writes through an atomic temp-file rename to avoid corrupting the JSONL file.
3. **More reliable `getLatestLogs({ page })` results** — page runtime errors and console messages emitted by related frame targets now appear in the returned log stream. This makes React and hydration failures visible through `pageerror` entries instead of requiring manual console listeners.
4. **CLI-created sessions auto-open pages more reliably** — `playwriter session new` can auto-create an initial extension tab even when the shared relay was originally started by MCP. This avoids `No Playwright pages are available` after all enabled tabs have closed.
5. **Remote status checks send bearer tokens** — `/extensions/status` and `/extension/status` requests now include the configured auth token, so remote relays using `--token` no longer reject status checks with 403 responses.
6. **Concurrent relay startup no longer crashes on port races** — simultaneous CLI and MCP commands now deduplicate startup work and treat a competing process winning port `19988` as a clean handoff instead of surfacing `EADDRINUSE`.
7. **Clearer multi-browser names in `playwriter session new`** — browser lists now use full user-agent client hints when available, so Chromium-family browsers such as Chrome Canary can show a more specific name.
8. **Skill docs prefer `getLatestLogs()` for page diagnostics** — the generated Playwriter skill now tells agents to call `getLatestLogs({ page })` instead of adding manual console listeners that miss errors emitted before listener setup.

## 0.2.0

1. **New `-f/--file` flag** — execute JavaScript from a file instead of inline `-e` strings:
   ```bash
   playwriter -s 1 -f script.js
   ```
   The file runs in the same sandbox as `-e` with all context variables (`state`, `page`, `context`, etc.) available. `-e` and `-f` are mutually exclusive.
2. **React component inspection for pinned elements** — agents can call `getReactComponentInfo({ locator })` to get the nearest React component name, parent hierarchy, sanitized props, and source file locations. Non-React elements return `null` instead of throwing.
3. **Performance profiling guide** — new generated `performance-profiling.md` resource covering TTFB, FCP, LCP, CLS measurement, heavy request detection, and interactivity blockers with concrete Playwriter + CDP snippets. Also links to `profano` for deeper `.cpuprofile` analysis.
4. **Shell tab completions** — `playwriter` now supports shell completions via goke. Run the completion setup for your shell to get tab completion on commands and flags.
5. **Security: token required on all requests regardless of source** — the previous loopback bypass on `/cli/*`, `/recording/*`, and `/mcp-log` let any request from `127.0.0.1` skip auth. Under tunnel setups (traforo/ngrok/cloudflared), every public request arrives from localhost, making the bypass equivalent to no auth. The middleware now requires the token on every request.
6. **`--token` works on every remote subcommand** — `session new`, `session list`, `session delete`, `session reset`, and `browser list` all forward `Authorization: Bearer …` to the relay's `/cli/*` endpoints. Previously only `playwriter -e` sent the token. Thanks to @ivanleomk for the original fix.
7. **`POST /mcp-log` is now token-protected** — previously open, so any reachable client could spam the relay log file.
8. **Fixed Next.js webpack layer prefixes in React source paths** — `/(app-pages-browser)/`, `/(ssr)/`, `/(rsc)/` and other webpack layer prefixes are now stripped from source file paths in React component info.
9. **Skill docs require absolute paths for saved artifacts** — `page.screenshot({ path })`, `page.pdf({ path })`, `download.saveAs(path)`, and `video.saveAs(path)` now documented to use absolute paths since Playwright resolves them outside the sandboxed `fs`.

## 0.1.0

1. **New in-page toolbar with pin mode** — every attached tab now gets a floating toolbar you can use to pin elements directly from the page. Pinning copies a natural-language prompt plus the exact `playwriter -e '…'` code needed to inspect that element later, so pasted prompts are immediately useful to an agent instead of just exposing a fragile DOM handle.
2. **Always-on ghost cursor with better motion** — the cursor overlay now appears on every Playwriter-attached tab, survives hard navigations, uses smoother move/press animation timing, and fades away after 5 seconds of idle time so manual browsing stays uncluttered. The next Playwright-driven mouse action brings it back instantly.
3. **`playwriter --help` and `playwriter serve --help` work on clean installs again** — browser-launch code is now lazy-loaded only when `playwriter browser start` actually runs, so generic CLI entrypoints no longer fail early on unrelated browser-install dependencies.
4. **Shared JavaScript dialogs no longer crash multi-client sessions** — when multiple `connectOverCDP()` clients auto-close the same `alert()`/`confirm()`/`prompt()`, duplicate best-effort closes are now ignored instead of surfacing an unhandled rejection that kills the process.

## 0.0.105

1. **Stabilize multi-browser extension connections**. The relay now keys fallback extension identities by a persisted per-install ID instead of collapsing every unsigned Chromium-family browser into `browser:Chromium`. This prevents Chrome/Vivaldi/Helium/Dia instances from replacing each other on the relay when `chrome.identity` returns no profile ID/email.
2. **Stop reconnect handoff loops after replacement**. A replaced extension worker now waits until no replacement connection exists before reclaiming the relay slot, instead of treating `activeTargets: 0` as free. This closes the race where a fresh replacement briefly reports zero targets, gets stolen back, and drops the user's active Playwright tab.
3. **Regression coverage for dual-browser relay stability**. Added an integration test that launches a second Chromium context against the same relay and verifies the original active page stays connected.

## 0.0.104

1. **Executor logs new pages instead of unreachable popups**. Previously, when a page opened another via `window.open` or `target="_blank"`, the executor emitted `[WARNING] Popup window detected ... cannot be controlled by playwriter` and told the agent to retry. Paired with the extension 0.0.80 change (popups are auto-relocated to tabs in the source tab's window), the warning is now `[WARNING] New page opened from current page (index N, initial url: ...)` pointing the agent at the new tab to interact with it.
2. **Minimum extension version check**. If the user has an outdated Playwriter extension (< 0.0.80) that doesn't support popup relocation, the CLI/MCP now emits a warning telling them to update the extension via `chrome://extensions`. The warning is also enqueued into the MCP agent's warning stream so the agent knows why popup behavior is broken.
3. **Skill docs updated**. Removed the section instructing agents to use `cmd+click` (`{ modifiers: ['Meta'] }`) to work around popup windows during OAuth flows — the extension now handles this automatically. Added a short note under "working with pages" explaining popup auto-relocation.

## 0.0.103

1. **Auto-returned Playwright handles are silently skipped** (#82). `await page.goto(url)` and similar single-expression code previously dumped the Playwright Response object, which is useless output — it's a programmatic handle, not display data. That same dump also leaked every process env var because `util.inspect` traversed `_connection._platform.env` at depth 4 (secrets, API keys, tokens). The CLI now skips return values that are Playwright handles (Response, Page, Browser, Request, Frame, BrowserContext, etc.) entirely. Return specific fields (`return response.url()`) or `console.log(response)` to see data.
2. **`@xmorse/playwright-core`** now has custom `util.inspect` handlers on `ChannelOwner` and channel proxies. `console.log(response)` renders a concise summary like `Response@response@abc123 { url: '...', status: 200 }` without leaking internals.

## 0.0.102

1. **`browser` exposed in sandbox** — user code can now call `browser.contexts()` to access pages from all open Chrome profiles when using `--direct` mode. The `browser` variable is available alongside `page`, `context`, etc. in all sandbox code.
2. **`browser start` deprecated and hidden from `--help`** — the command still works if called directly but no longer appears in the help output. Use `session new --direct` for headless automation flows instead.
3. **`PLAYWRITER_DIRECT` only accepts `'1'`** — removed `'auto'` and `'true'` aliases. The standard boolean env var pattern (`PLAYWRITER_DIRECT=1`) is the only accepted value for auto-discovery. Explicit `ws://` endpoints still work as before.

## 0.0.101

1. **Chrome 136+ direct CDP discovery** — `playwriter browser list` and `--direct` auto-discovery now detect Chrome instances where `/json/version` returns 404 (Chrome 136+ with `chrome://inspect` debugging). Previously these were silently ignored. Discovery uses HTTP-only probing and never triggers Chrome's approval dialog.
2. **`--direct` moved to `session new` only** — removed the `--direct` flag from the root command. For MCP, set `PLAYWRITER_DIRECT=1` env var instead.
3. **Unique WS paths per session** — direct CDP connections now use the session ID (CLI) or a UUID (MCP) as the WebSocket path segment, making connections traceable.

## 0.0.100

1. **`resizeImageForAgent` now defaults to PNG** — previously defaulted to JPEG, which caused `image/png` vs `image/jpeg` mismatch errors when MCP clients assumed PNG. All images emitted by playwriter are now consistently PNG unless explicitly overridden with `format: 'jpeg'`.

## 0.0.99

1. **Kitty Graphics Protocol support in CLI** — when `AGENT_GRAPHICS=kitty` is set, the CLI now emits screenshots and resized images as Kitty Graphics Protocol escape sequences to stdout. Agents with `kitty-graphics-agent` (or compatible parsers) automatically extract the PNG images and pass them to the LLM as media parts — no extra tool call or file reading needed.
2. **Screenshots now use PNG format** — `screenshotWithAccessibilityLabels()` now captures and returns PNG instead of JPEG. PNG is lossless and is the only format supported for extraction by the Kitty Graphics Protocol (`f=100`). The `resizeImage()` function now accepts a `format` option (`'jpeg' | 'png'`).
3. **`resizeImageForAgent`** — renamed from `resizeImage`. Resized images are now automatically collected and included in the response (emitted via Kitty Graphics in CLI, included as image parts in MCP). The old `resizeImage` name still works as a backward-compatible alias.

## 0.0.98

1. **Direct CDP connection mode** — new `--direct` flag on `session new` connects to Chrome's built-in debugging WebSocket without needing the Playwriter extension. Works with any Chromium-based browser (Chrome, Brave, Ghost Browser, Arc, Edge, etc.) that has debugging enabled via `chrome://inspect/#remote-debugging` or `--remote-debugging-port`. Auto-discovers instances via DevToolsActivePort files and port scanning (9222-9229). Recording is unavailable in this mode.
2. **`playwriter browser list` command** — lists all Chrome/Chromium instances with debugging enabled, showing port, browser name, and profile info.
3. **MCP direct mode** — set `PLAYWRITER_DIRECT=1` or `PLAYWRITER_DIRECT=ws://...` env var to start the MCP server in direct CDP mode without a relay server.
4. **Multi-browser table includes direct instances** — when multiple extensions are connected, `session new` now also discovers and shows direct CDP instances in the unified selection table.

## 0.0.97

1. **Remove low-value managed-browser unit tests** — dropped the temporary browser-config, browser-launch, and package-path unit tests that were mostly asserting implementation details instead of protecting meaningful product behavior.

## 0.0.96

1. **Document managed-browser recording permissions** — `playwriter browser start` now clearly reports that recording/tab-capture flags are enabled, and the skill docs now explain that `recording.start()` does not require a manual extension click when using the managed browser flow.

## 0.0.95

1. **Skip the welcome tab for bundled automation builds** — the Playwriter CLI now packages an extension build with `welcome.html` disabled on install, so fresh managed browser profiles do not waste a tab in headless and AVPS flows.

## 0.0.94

1. **Make `browser start` work from source checkouts** — runtime package path resolution now falls back to the local `playwriter/` package directory before using installed-package resolution, so `tsx playwriter/src/cli.ts browser start` works during development.
2. **Fall back to Playwright's managed Chromium** — browser autodiscovery now also considers the Chromium / Chrome for Testing binary installed by `@xmorse/playwright-core`, so the command succeeds even when no system-wide Chromium app is installed.

## 0.0.93

1. **Show searched browser paths on launch failures** — `playwriter browser start` now prints every Chrome for Testing / Chromium path it checked, making it much easier to debug autodiscovery issues on local machines and AVPS hosts.

## 0.0.92

1. **Add `playwriter browser start`** — the CLI can now launch a managed Chrome for Testing or Chromium instance with the bundled Playwriter extension preloaded, making fresh AVPS/VPS automation setups much easier.
2. **Bundle the extension into the npm package** — Playwriter now builds and ships an unpacked extension copy inside `dist/extension`, resolved at runtime from the installed package path so the CLI can side-load it without depending on a separate checkout.

## 0.0.91

1. **Stabilize external accessibility snapshot coverage** — Hacker News and shadcn snapshot regression tests now wait for stable page content before capturing the AX tree, avoiding flaky empty interactive snapshots from live pages.
2. **Refresh extension download event expectations** — relay-core coverage now matches the current extension-mode behavior where both `Browser.download*` and `Page.download*` events are observed during downloads.

## 0.0.90

1. **Show session cwd in `playwriter session list`** — the CLI session table now includes the working directory each session was created with, making it easier to tell similar sessions apart.
2. **Fix session cwd leakage across relay restarts** — relative `fs` paths in the sandbox now resolve from the cwd captured by `playwriter session new`, instead of whichever directory last launched the detached relay server.

## 0.0.89

1. **More reliable downloads in extension mode** — download behavior now stays compatible with both `Page.download*` and `Browser.download*` event paths, so Playwright flows like `page.waitForEvent('download')` work consistently when connected through the relay.
2. **Default action timeout is now 60 seconds** — reduced false click failures on slower, real-world pages where the interaction succeeds but post-action waiting previously exceeded short timeout budgets.
3. **Ghost cursor injection is more stable** — recording flows now use direct per-page cursor injection again, avoiding the unreliable init-script persistence path used in prior builds.

## 0.0.80

### Bug Fixes

- **Relaxed relay server version check timeout**: Increased `getRelayServerVersion` timeout from 500ms to 2000ms to prevent false "server not running" detections that kill a healthy relay server and disconnect the extension. This was causing intermittent `session new` failures when the relay was briefly busy (e.g. processing recording chunks).

## 0.0.80 (previous)

### Improvements

- **Descriptive click timeout errors**: When `locator.click()` times out due to actionability failures, the error now includes the reason (e.g. "Element is not visible", "Element is not stable", "<button> intercepts pointer events") instead of just "Timeout exceeded."
- **Faster action timeouts for agents**: Default Playwright action timeout reduced from 10s to 2s. Navigation timeout remains at 10s. Agents now get fast failure with descriptive errors instead of waiting 10 seconds for a generic timeout.

## 0.0.79

### Improvements

- **Faster ghost cursor motion defaults**: Reduced min/max movement durations and increased base movement speed so pointer travel feels snappier while preserving smooth easing.
- **Recording docs now emphasize interaction-driven navigation**: Updated skill guidance to prefer click/type/hover flows during recordings so ghost cursor motion is visible and human-like instead of bypassed by direct `goto` jumps.

## 0.0.78

### Features

- **Add `resizeImage` sandbox utility**: Standalone function to resize images, useful for shrinking screenshots before reading them back into context. Default LLM-optimal mode fits within 1568×1568px; also supports explicit width/height/maxDimension. Available in execute sandbox alongside other utilities.

## 0.0.77

### Improvements

- **Cap speed-up output to source fps in FFmpeg pipeline**: Speed-up filters now use explicit `fps=fps=<source>:round=down` and set output `-r` to the same probed frame rate, keeping accelerated sections bounded to the recording's native fps.

## 0.0.76

### Bug Fixes

- **Fix ultra-short/slow demo generation on variable-framerate recordings**: `probeVideo()` now prefers `avg_frame_rate` and clamps output FPS to sane bounds, avoiding accidental `fps=30000` filter chains.
- **Avoid speeding entire video when no execute timestamps exist**: `computeIdleSections()` now returns no idle sections when timestamps are empty, so `createDemoVideo()` preserves original speed instead of aggressively compressing full recordings.

## 0.0.75

### Improvements

- **Switch minimal cursor to triangular pointer icon**: Updated the `minimal` ghost cursor style to use a stylized triangular SVG pointer (with subtle drop shadow) instead of the circular indicator, while keeping `dot` and `screenstudio` styles available.

## 0.0.74

### Improvements

- **Switch default ghost cursor to a stylized minimal look**: Updated cursor rendering defaults to a cleaner minimal style while preserving `dot` and `screenstudio` options for explicit overrides.

## 0.0.73

### Improvements

- **Simplify recording integration in executor**: Moved ghost-cursor-aware recording wrappers out of `executor.ts` into `screen-recording.ts` via `createRecordingApi(...)`, reducing executor complexity while preserving existing `recording.*` and backward-compatible top-level recording helpers.

## 0.0.72

### Improvements

- **Reduce false "extension disconnected" on relay restarts**: `playwriter session new` now waits longer for extension reconnect and adds a short polling grace window before failing, preventing transient post-restart races from surfacing as hard disconnect errors.

## 0.0.71

### Features

- **Add `recording` and `ghostCursor` namespaces in execute context**: New `recording.start/stop/isRecording/cancel` and `ghostCursor.show/hide` APIs are now exposed for cleaner scripting while keeping `startRecording`, `stopRecording`, `isRecording`, and `cancelRecording` as backward-compatible aliases.
- **Manual cursor overlay controls**: Cursor overlay can now be shown/hidden explicitly outside recording flows for screenshot and demo generation.

## 0.0.70

### Features

- **Ghost cursor overlay during recording**: Playwriter now auto-enables a smooth in-page ghost cursor when `startRecording()` is called, driven by `page.onMouseAction` callbacks from the Playwright fork so both `page.mouse.*` and `locator.click()` actions are visualized.

### Tests

- **Add ghost-cursor integration coverage**: Extended `on-mouse-action.test.ts` to verify callback-driven cursor animation and teardown in real extension-connected runs.

## 0.0.69

### Bug Fixes

- **Scope CDP tab session IDs by extension runtime**: Switched root tab IDs to `pw-tab-<scope>-<n>` so concurrent extension connections do not reuse the same `pw-tab-1`, `pw-tab-2`, etc. The scope is generated once per extension runtime to avoid cross-profile collisions and ambiguous recording-route resolution.
- **Standardize recording routes on CDP `sessionId`**: Recording HTTP routes now treat `sessionId` as a CDP tab session ID (`pw-tab-*`) only, removing executor-target branching from the recording path.

## 0.0.68

### Tests

- **Use a more realistic complex page in aria label screenshot test**: Replaced `example.com` with `old.reddit.com` in the optimized label rendering integration test to keep stronger real-world DOM coverage while preserving faster runtime.

## 0.0.67

### Tests

- **Speed up aria label screenshot integration test**: Reduced the `should show aria ref labels on real pages and save screenshots` runtime by loading fewer external pages, removing `networkidle` waits, and parallelizing initial page loading.

## 0.0.66

### Internal

- **Simplify warning scope tracking**: Replaced warning-scope map + execution ID counter with a direct set of scope objects, keeping the same concurrent warning behavior with less executor state.

## 0.0.65

### Improvements

- **State-aware page-close warnings**: Executor now emits page-close warnings only when the closed page is referenced in session state (for example `state.page`), and warning text includes the exact state key(s) that must be reassigned.
- **Safer active page fallback messaging**: When the active page closes and a replacement tab is available, warning text now includes both fallback index/URL and the affected state key(s).

### Docs

- **Standardize examples on `state.page`**: Updated skill examples and guidance to consistently initialize and use `state.page` at task start, reducing cross-agent tab confusion.

## 0.0.64

### Improvements

- **Warn when active page closes**: Executor now listens for page close events and emits explicit `[WARNING]` messages when the current page is closed, including the closed URL and automatic fallback behavior.
- **Automatic page fallback after close**: When possible, executor switches `page` to another open tab and reports which page index/URL it selected so agents understand context changes immediately.
- **Concurrency-safe warning delivery**: Warning buffering now tracks warning scopes per execute call so concurrent executions do not lose page-close or popup warnings.

### Tests

- **Add active-page-close integration test**: New extension connection test verifies warning emission and successful continuation on a replacement page after closing the active page.

## 0.0.63

### Security

- **Harden privileged HTTP routes against cross-origin attacks**: Added route-level middleware on `/cli/*` and `/recording/*` that blocks cross-origin browser requests via `Sec-Fetch-Site` header validation, rejects POST requests without `Content-Type: application/json` (prevents the CORS preflight bypass via `text/plain`), and enforces token authentication when token mode is enabled. Previously, CORS alone was relied upon, but CORS only blocks reading responses — it does not prevent "simple" POST requests from executing side effects like `/cli/execute`.
- **Token enforcement on HTTP routes**: When `--token` is set (remote access mode), `/cli/*` and `/recording/*` routes now require `Authorization: Bearer <token>` or `?token=<token>`, matching the behavior already documented in remote-access.md.
- **Security regression tests**: Added tests covering Sec-Fetch-Site blocking, Content-Type enforcement, token validation on privileged routes, and pass-through for legitimate Node.js clients.

## 0.0.62

### Features

- **Remote access support**: `PLAYWRITER_HOST` now accepts full URLs (e.g., `https://x-tunnel.traforo.dev`) in addition to plain hostnames, enabling secure remote browser access through tunnels like traforo
- **WebSocket over HTTPS**: Automatically uses `wss://` protocol when connecting to HTTPS relay hosts
- **Remote access documentation**: Added comprehensive guide covering architecture, setup, use cases, and security model for remote Playwriter access

### Internal

- **Centralized host parsing**: New `parseRelayHost()` utility handles URL/hostname detection and returns correct HTTP/WebSocket base URLs

## 0.0.61

### Improvements

- **Simplified Unix port killing**: Replaced shell pipeline approach (lsof/grep/awk/xargs) with direct `lsof -t` for PID discovery and `process.kill()` for termination. This eliminates spawn overhead and makes the code more maintainable while improving reliability.

## 0.0.60

### Bug Fixes

- **Fix relay startup EADDRINUSE timeouts**: If the relay port is already bound but `/version` is not responding, Playwriter now detects the listening PID(s), stops the existing process, and only then starts the relay (the 5s startup timeout now measures post-spawn readiness, not port cleanup time).
- **Harden port-kill implementation**: Replaced Playwriter's port killer with an implementation that mirrors `kill-port-process` (lsof/grep/awk/xargs on unix; taskkill on Windows) and includes the `xargs.stdout` pipe fix from upstream PR #199.

### Tests

- **Add kill-port subprocess test**: New test starts a real HTTP server subprocess on an ephemeral port, measures kill latency, and asserts the port is released.

## 0.0.59

### Bug Fixes

- **Fix "Cannot find module 'graceful-fs'" error**: Updated `@xmorse/playwright-core` to 1.59.3 which adds missing runtime dependencies (`graceful-fs`, `retry`, `signal-exit`) for clean `npx playwriter` installs (GitHub #45)

## 0.0.58

### Bug Fixes

- **Fix `bunx playwriter@latest` relay restarts**: Replaced `kill-port-process` with a vendored cross-platform port killer to avoid runtime crashes during version-mismatch restart flows.
- **Harden relay port cleanup behavior**: Unified relay/test/serve port termination through local `killPortProcess({ port })` helper with Windows/macOS/Linux support.

### Internal

- **Removed `kill-port-process` dependency**: Dropped external dependency and updated lockfile to reduce transitive process-management packages.

## 0.0.57

### Features

- **Ghost Browser Support**: Added integration with Ghost Browser APIs (multi-identity, proxies)
- **Multi-browser Support**: Added support for connecting to multiple browser instances/extensions
- **Screen Recording**: Added concurrent screen recording support in MP4 format (requires extension update)
- **Iframe Handling**: Improved iframe targeting using `Frame` objects and `Runtime.enable` routing
- **Accessibility Snapshots**: Added support for inline locators and better filtering
- **CDP JSONL Logging**: Added structured CDP logging to `~/.playwriter/cdp.jsonl`

### Bug Fixes

- **Fix hung navigations on YouTube and similar sites**: Resume filtered targets (like service workers) to avoid blocking navigations
- **Fix tab group infinite loop**: Prevent infinite loop when dragging tabs
- **Fix log dir permissions on shared machines**: Move default log directory from `/tmp/playwriter` to `~/.playwriter` so each OS user gets their own directory. Fixes startup crash when `/tmp/playwriter` is owned by another user (#44).

## 0.0.56

### Bug Fixes

- **Fix hung navigations on YouTube and similar sites**: Resume filtered targets (like service workers) to avoid blocking navigations. CDP `Target.setAutoAttach` with `waitForDebuggerOnStart: true` requires calling `Runtime.runIfWaitingForDebugger` even on targets we filter out, otherwise they hang forever.
- **Fix auto-enable page selection when no pages**: Properly handles the case when there are no existing pages during auto-enable

### Features

- **CDP JSONL logging**: Added structured CDP logging to a JSONL file (`/tmp/playwriter/cdp.jsonl`) for debugging. Log all CDP messages with direction, timestamp, and source info. Use `jq` to analyze.
- **Sync tab state for automated tabs**: Tab state is now properly synced for programmatically created tabs

### Improvements

- **Better logging output**: Use `util.inspect` for cleaner log output with proper object formatting
- **Set default timeout**: Added sensible default timeouts for operations

## 0.0.55

### Features

- **`playwriter skill` CLI command**: New command that prints full MCP instructions to stdout, useful for agents that need up-to-date documentation without relying on MCP resources

### Internal

- **Moved SKILL.md to src/**: Source of truth for agent instructions now lives in `src/skill.md`
- **Removed docker.package.json**: Cleaned up unused Docker configuration

## 0.0.54

### Features

- **Faster aria snapshot ref lookup**: Refs are now extracted directly from the snapshot string and fetched in parallel (20 concurrent requests), significantly reducing time to generate accessibility snapshots with labels
- **`refFilter` parameter for `getAriaSnapshot`**: New optional filter to include only specific refs by role/name, reducing unnecessary ref lookups
- **Increased default execution timeout**: Execution timeout increased from 5s to 10s for better handling of slow operations

### Bug Fixes

- **Pass cwd to executor in MCP**: File operations in executed code now use the correct working directory

## 0.0.53

### Bug Fixes

- **Fix CLI relay server startup from source**: Detect source vs compiled via `__filename.endsWith('.ts')` instead of env var, fixing `tsx` and `vite-node` execution
- **Wait for extension to reconnect**: CLI now waits up to 10 seconds for extension to reconnect after server (re)start before executing commands

### Improvements

- **Colored CLI output**: Setup messages now use colors (dim for progress, green for success, yellow for warnings)

## 0.0.52

### Features

- **First extension keeps connection**: When multiple Playwriter extensions are installed (e.g., dev and prod), the first one with active tabs now keeps the connection instead of being replaced by newer connections. Idle extensions (no tabs) can still be replaced.
- **Smarter extension slot detection**: `/extension/status` endpoint now returns `activeTargets` count, allowing extensions to know when the slot becomes available (no active tabs).
- **Accessibility snapshot format options**: `accessibilitySnapshot` now supports `format` option (`'yaml'` or `'markdown'`) with deduplication of interactive refs
- **Session management CLI commands**: New CLI commands for managing relay sessions (`playwriter sessions list`, `playwriter sessions kill`)
- **Eval CLI flag**: New `-e/--eval` CLI flag for quick code execution from command line
- **Auto-enable environment variable**: CLI now passes `PLAYWRITER_AUTO_ENABLE` when starting relay server

### Bug Fixes

- **Relay server auto-recovery**: Restored auto-recovery on every execute call
- **Preserve tabs during relay reconnects**: Tabs now persist correctly when relay reconnects
- **Show log file path on connection refused error**: Better debugging experience with log file location in errors
- **Improved error messages for extension connection states**: Clearer error messages when extension isn't connected

### Security

- **Block browser access to CLI endpoints**: Prevents browsers from accessing CLI-specific endpoints

### Internal

- **SKILL.md as source of truth**: Refactored to generate `prompt.md` from `SKILL.md`
- **Aria snapshot module**: New `aria-snapshot.ts` with dedicated accessibility snapshot functions

## 0.0.50

### Bug Fixes

- **Sharp fallback with viewport clipping**: When sharp is unavailable (optional dependency), screenshots now clip to max 1568px instead of relying on Claude's auto-resize
- **Error logging for sharp failures**: Added logging when sharp import or resize fails, making it easier to debug screenshot optimization issues

## 0.0.49

### Features

- **CORS support for relay server**: Added CORS middleware to allow extension's fetch/XHR requests during development. Only allows requests from our specific extension IDs for security.

### Bug Fixes

- **Clearer error messages**: Improved error messages when another Playwriter extension connects, making it easier to diagnose connection issues

## 0.0.48

### Bug Fixes

- **Fix SSE streaming (issue #22)**: CDP's Network domain buffers response bodies by default, which breaks SSE/streaming - data arrives at Chrome but `ReadableStream` never receives it. Now `Network.enable` defaults to `maxTotalBufferSize: 0` to disable buffering.

### Features

- **Auto-switch to another page when default page is closed**: When the current page is closed, MCP automatically switches to another available page instead of erroring
- **Optimized screenshot token usage**: Screenshots are now resized with sharp to reduce Claude token consumption
- **Reading response bodies**: Agents can re-enable Network buffering via `Network.disable` + `Network.enable` with explicit buffer sizes when they need `response.body()`

### Changes

- **Dependencies cleanup**: Removed unused deps, updated to zod v4, replaced chalk with picocolors

## 0.0.47

### Bug Fixes

- **Improved connection reliability**: Use `127.0.0.1` instead of `localhost` to avoid DNS/IPv6 resolution issues, add 15s global timeout wrapper around `connect()` to prevent hanging forever
- **Use domcontentloaded everywhere**: Changed `getCurrentPage()` and prompt guidance to use `domcontentloaded` instead of `load` for faster, more reliable page detection
- **Allow attaching to own extension pages**: Extension pages can now be debugged while still blocking other extensions

### Changes

- **Centralized target filtering**: Consolidated extension ID arrays and target filtering logic for cleaner code
- **Optional wsUrl in getCDPSessionForPage**: `wsUrl` parameter now defaults to `getCdpUrl()` if not provided

## 0.0.46

### Bug Fixes

- **Limit screenshot dimensions to 2000px**: Screenshots are now clipped to max 2000x2000 pixels to avoid Claude API rejection for many-image requests (Claude enforces 2000px limit when >20 images in a request)

## 0.0.45

### Bug Fixes

- **Filter non-page targets from Playwright (issue #14)**: Service workers, web workers, and other non-page targets are now filtered out at the server level. This prevents Playwright from trying to initialize these targets, which would cause timeouts waiting for `executionContextCreated` events and errors on `Target.detachFromTarget`.

## 0.0.44

### Features

- **Search context lines**: `accessibilitySnapshot`, `getCleanHTML`, and `getLatestLogs` now include 5 lines of context above and below each search match
  - Non-contiguous sections are separated by `---`
  - Provides better context for understanding search results

- **CDP discovery endpoints**: Added standard Chrome DevTools Protocol HTTP discovery endpoints
  - `/json/version` - Returns browser info and `webSocketDebuggerUrl`
  - `/json/list` - Returns list of debuggable targets
  - `/json` - Alias for `/json/list`
  - Supports both GET and PUT methods (Chrome 66+ compatibility)
  - Handles trailing slash variants (Playwright compatibility)
  - Allows `chromium.connectOverCDP('http://127.0.0.1:19988')` without needing to call `getCdpUrl` first

## 0.0.43

### Features

- **`getCleanHTML` utility**: New function to get cleaned HTML from a locator or page
  - Removes script, style, svg, head tags
  - Keeps only essential attributes (aria-_, data-_, href, role, title, alt, etc.)
  - Supports `search` option to filter results (returns first 10 matching lines)
  - Supports `showDiffSinceLastCall` to see changes since last snapshot
  - Supports `includeStyles` to optionally keep style/class attributes

### Changes

- **Simplified `accessibilitySnapshot` search**: Removed `contextLines` parameter, search now returns just matching lines instead of context around matches. Use `.split('\n').slice()` for pagination instead.

## 0.0.42

### Bug Fixes

- **Fix "no low surrogate in string" API error**: Sanitize accessibility snapshot text using `toWellFormed()` to remove unpaired Unicode surrogates that break JSON encoding for Claude API (requires Node.js 20+ for sanitization, gracefully degrades on older versions)

## 0.0.41

### Features

- **Arrow connectors in screenshot labels**: Visual labels now show arrow lines from label to element center, making it clearer which element each label references

### Patch Changes

- **Bigger label font**: Increased label font size from 11px to 12px for better readability
- **Fixed screenshot dimensions**: Screenshots now use actual viewport size (`innerWidth`/`innerHeight`) with `scale: 'css'` to match visual appearance

## 0.0.40

### Features

- **`screenshotWithAccessibilityLabels`**: New utility function that takes a screenshot with Vimium-style visual labels overlaid on interactive elements
  - Labels show aria-ref IDs that can be used with `page.locator('aria-ref=e5')`
  - Image and accessibility snapshot are automatically included in the response
  - Can be called multiple times to capture multiple screenshots
  - Labels are color-coded by element type
- **Media elements in aria labels**: Added `img`, `video`, `audio` to INTERACTIVE_ROLES
  - Light blue color scheme for media element labels
  - Agents can now reference images by aria-ref for visual tasks

### Patch Changes

- **Extension fix**: Query playwriter tab group by title instead of caching ID, fixing stale group issues after debugger detach/reattach

## 0.0.39

### Patch Changes

- **Fix icon not updating on WS disconnect**: `maintainLoop` now ensures tabs transition to 'connecting' state when WebSocket is not connected, fixing edge cases where `handleClose` wasn't called
- **Increased aria-labels auto-hide timeout**: Labels now auto-hide after 30 seconds instead of 5 seconds

## 0.0.38

### Patch Changes

- Internal connection handling improvements

## 0.0.36

### Features

- **Visual Aria Ref Labels**: New `showAriaRefLabels()` and `hideAriaRefLabels()` functions overlay Vimium-style labels on interactive elements
  - Labels show aria-ref IDs (e.g., "e1", "e5") that can be used with `page.locator('aria-ref=e5')`
  - Color-coded by element type: yellow=links, orange=buttons, coral=inputs, pink=checkboxes, peach=sliders, salmon=menus, amber=tabs
  - Only shows truly interactive roles (button, link, textbox, combobox, checkbox, etc.)
  - Skips elements covered by opaque overlays using `elementsFromPoint()`
  - Greedy overlap prevention skips labels that would overlap with already-placed ones
  - Auto-hides after 30 seconds to prevent stale labels (timer cancelled if called again)
  - Available in MCP execute context

### Usage

```js
const { snapshot, labelCount } = await showAriaRefLabels({ page })
await page.screenshot({ path: '/tmp/labeled-page.png' })
await page.locator('aria-ref=e5').click()
// Labels auto-hide after 30 seconds, or call hideAriaRefLabels({ page }) manually
```

## 0.0.35

### Patch Changes

- **Persistent WS connection**: Extension now connects to relay server at startup and maintains connection indefinitely, retrying every 5 seconds silently in background
- **Silent background retry**: Connecting badge only shows when user explicitly clicks to attach a tab, not during background reconnection attempts
- **Fixed tab group race condition**: All tab group operations now queue through `tabGroupQueue` to prevent race conditions between `syncTabGroup`, `disconnectEverything`, and `onTabUpdated`
- **Simplified connection states**: Renamed `'disconnected'` to `'idle'`, removed global `'connecting'` state (only individual tabs show connecting state)
- **Auto-create initial tab**: When `PLAYWRITER_AUTO_ENABLE` env var is set, automatically creates an about:blank tab when Playwright connects and no tabs exist

## 0.0.34

### Patch Changes

- **Skip server restart for newer versions**: MCP no longer kills and restarts the relay server when the server version is higher than the MCP version. This prevents older MCPs from disrupting newer server instances.
- **Ping/pong keep-alive**: Added WebSocket ping/pong mechanism to prevent Chrome extension service worker from terminating due to inactivity.

## 0.0.33

### Patch Changes

- **Fixed prompt.md not found error**: Read `prompt.md` from `src/` instead of `dist/`, fixing `ENOENT: no such file or directory` error when running the MCP

## 0.0.32

### Patch Changes

- **Build-time resource generation**: API docs (debugger-api, editor-api, styles-api) are now generated at build time via `build-resources.ts`
- **Hosted resources on playwriter.dev**: Resources now use `https://playwriter.dev/resources/*.md` URLs instead of `playwriter://` custom URIs
- **Simplified mcp.ts**: Resource handlers now read pre-built markdown files from `dist/` instead of constructing content at runtime

## 0.0.31

### Patch Changes

- **Added `styles-api` resource**: New MCP resource (`playwriter://styles-api`) with types and examples for `getStylesForLocator` CSS inspection API
- **Reduced prompt context**: Simplified prompt.md to reference resources (`playwriter://debugger-api`, `playwriter://editor-api`, `playwriter://styles-api`) instead of inline documentation

## 0.0.30

### Patch Changes

- **Wait for main frame execution context**: `Runtime.enable` now waits for the main frame's default execution context (`auxData.isDefault === true`) instead of any context. This prevents "Frame has been detached" errors when pages weren't fully ready.
- **Fix race condition when toggling extension**: When re-enabling the extension on a tab, ignore group removal events while the tab is still in 'connecting' state. Previously, `syncTabGroup` would ungroup 'connecting' tabs which triggered a disconnect during connection.

## 0.0.29

### Patch Changes

- **Fixed Editor/Debugger script listing after page load**: `listScripts()` and `list()` now work correctly even when called after page has loaded
  - `enable()` now disables first then re-enables to force CDP to emit `scriptParsed` and `styleSheetAdded` events
  - Added 100ms debounced wait for events to arrive before returning
  - `listScripts()` and `list()` are now async and auto-call `enable()`
- **Bun/bunx compatibility**: Removed known issue about bunx - the MCP now works with both `npx` and `bunx`

## 0.0.28

### Patch Changes

- **Added `getReactSource` utility**: Extract React component source location (file, line, column) from DOM elements
  - Uses bippy library for React fiber introspection
  - Returns `{ fileName, lineNumber, columnNumber, componentName }` or `null`
  - Only works on local dev servers (Vite, Next.js, CRA) with JSX transform in development mode
- **CSP bypass for script injection**: Changed `getLocatorStringForElement` and `getReactSource` to use CDP `Runtime.evaluate` instead of `addScriptTag`
  - Scripts now work on pages with strict Content Security Policy
- **Switched to Bun.build**: Replaced esbuild and esm.sh downloads with Bun.build for bundling selector-generator and bippy
  - New `build-selector-generator.ts` and `build-bippy.ts` scripts

## 0.0.27

### Patch Changes

- **Fixed gray icon on about:blank pages**: `about:blank` pages now show the black (clickable) icon instead of gray (restricted). Chrome returns `undefined` for `tab.url` on blank pages, which was incorrectly treated as restricted.
- **Auto-recovery after extension replacement**: When another extension instance takes over the connection, the replaced extension now polls `/extension/status` every 3 seconds. When the slot becomes free, it clears the error state so the user can click to reconnect.

## 0.0.26

### Patch Changes

- **Fixed CDP commands sent too soon after attach**: Added 400ms delay after debugger attach before sending CDP commands to prevent race conditions
- **Deferred page emulation setup**: Disabled early `setDeviceScaleFactorForMacOS` and `preserveSystemColorScheme` calls that could fail on newly attached pages
- **Fixed main tab cleanup on detach**: `Target.detachedFromTarget` now properly removes main tabs from state, not just child sessions

## 0.0.25

### Patch Changes

- **Wait for extension after server start**: When MCP starts the relay server, wait 3 seconds for the extension to connect before proceeding

## 0.0.24

### Patch Changes

- **Auto-restart relay server on version mismatch**: Server now exposes `/version` endpoint, MCP checks and restarts server if versions differ after package update
- **Simplified logging**: Single `relay-server.log` file instead of timestamped files with symlinks
- **Cross-platform process killing**: Use `kill-port-process` package for Windows/Mac/Linux compatibility
- **IPv4 compatibility**: Use `127.0.0.1` instead of `localhost` to avoid IPv6 resolution issues
- **Reset tabs on disconnect**: Clear connected tabs state when extension disconnects

## 0.0.23

### Patch Changes

- **Windows compatibility**: Use `os.tmpdir()` for log files instead of XDG paths, ensuring cross-platform support
- **Removed `xdg-basedir` dependency**: Simplified path handling by using Node's built-in `os.tmpdir()`

## 0.0.22

### Patch Changes

- **Green icons for connected tabs**: Extension now uses distinct green icons when tabs are connected
- **Cleaner timeout handling**: Code execution timeouts no longer suggest using reset tool

## 0.0.21

### Patch Changes

- **Improved debug message clarity**: Changed log file path hint to specify "internal playwriter errors" for better guidance

## 0.0.20

### Patch Changes

- **Timestamped log files**: Log files now include timestamps in filename (`relay-server-{timestamp}.log`) instead of overwriting a single file
- **Automatic log cleanup**: Keeps only the 10 most recent log files, deleting older ones automatically
- **Async log writes**: Logger now uses a queue for async file writes instead of blocking sync writes

## 0.0.19

### Patch Changes

- **Added `getCDPSession` utility**: New function to send raw CDP commands through the relay
  - Works with `getCDPSession({ page })` in MCP execute context
  - Returns `{ send, on, off, detach }` interface for CDP commands and events
  - Uses page index matching with URL verification for reliable target identification
- **Converted CDP tests to use relay**: All CDP Session tests now go through the relay instead of direct playwright CDP
  - Debugger, Profiler, and layout metrics tests all use `getCDPSessionForPage`
- **Added warning about `newCDPSession`**: Documented in prompt.md that `page.context().newCDPSession()` does not work through the relay

## 0.0.18

### Patch Changes

- **Marked project as production ready**: Removed "Still in development" notice from README

## 0.0.17

### Patch Changes

- **Improved error debugging**: Log file path now included in error messages and tool description. Log file writes to OS temp directory by default (`PLAYWRITER_LOG_PATH` env var to override)
- **Added CDP Session tests**: New test suite for CDP commands through the relay
  - Debugger test: pauses on `debugger` statement, captures stack trace, local variables, and evaluates expressions
  - Profiler test: profiles JavaScript execution with inline snapshot of function names
  - Layout metrics test: captures viewport dimensions via CDP
- **Refactored test setup**: Extracted `setupTestContext()` and `cleanupTestContext()` to deduplicate beforeAll/afterAll code
- **Improved `getExtensionServiceWorker`**: Now waits for extension global functions to be ready before returning
- **Better TypeScript types**: Uses `Protocol.Debugger.PausedEvent`, `Protocol.Profiler.Profile`, `Protocol.Performance.Metric` instead of `any`

## 0.0.16

### Patch Changes

- **Fixed Stagehand timeout**: Send `Target.attachedToTarget` event after `Target.attachToTarget` returns
  - Stagehand creates sessions from `attachToTarget` response, then expects `attachedToTarget` event to create Page
  - Previously events were only sent from `setAutoAttach` which arrived before sessions were created

## 0.0.15

### Patch Changes

- **Fixed logger safety**: Added optional chaining to logger calls in CDP relay to prevent errors when logger methods are undefined

## 0.0.14

### Patch Changes

- **Added Stagehand support**: CDP relay now works with Stagehand's `cdpUrl` connection option
  - Added `Target.setDiscoverTargets` handler that sends `Target.targetCreated` events for connected targets
  - Added `Target.attachToTarget` handler that returns existing sessionId for already-attached targets
  - Added Stagehand integration test verifying connection and page access
- **Viewport initialization**: Extension now sets initial viewport via `Emulation.setDeviceMetricsOverride` when attaching to tabs
  - Gets layout metrics via `Page.getLayoutMetrics`
  - Sends `Page.frameResized` event after setting viewport

## 0.0.13

### Patch Changes

- **Fixed home directory expansion on Windows**: Use `os.homedir()` instead of `process.env.HOME` for `~` path expansion in browser-config.ts, which doesn't exist on Windows.

## 0.0.12

### Patch Changes

- **Fixed Windows path resolution**: Use `fileURLToPath` for prompt.md path resolution, fixing issues on Windows where `import.meta.url` paths weren't being handled correctly.

## 0.0.11

### Patch Changes

- **Fixed `page.url()` returning empty after extension runs for a while**: The `Target.targetInfoChanged` handler was incorrectly updating the parent page's cached `targetInfo` with child target info (service workers, iframes). Now correctly looks up targets by `targetId` instead of `sessionId`.

## 0.0.10

### Patch Changes

- **Browser console log capture**: Added `getLatestLogs` function to capture and retrieve browser console logs
  - Automatically captures up to 5000 logs per page
  - Logs cleared on page reload/navigation
  - Logs deleted when page is closed
  - Supports filtering by page, search string/regex, and count limit
- **Fixed test contamination**: Added `clearAllLogs` function to prevent log persistence across tests
- **Improved console listener setup**: Made listeners synchronous using page `_guid` for immediate log capture
- **Critical reconnection test**: Added test verifying extension reconnection after `disconnectEverything()`
  - Tests full disconnect/reconnect cycle
  - Verifies MCP client can reconnect with `resetPlaywright()`
  - Ensures pages are visible after reconnection
- **Persistent console listeners**: Console logs now persist across browser reconnections (not cleared in `resetConnection`)

## 0.0.9

### Patch Changes

- Added `tabs` permission to extension manifest to fix `chrome.tabs` access issues
- Implemented `toggleExtensionForActiveTab` global helper in extension background script
- Automated extension loading and toggling in MCP tests using `chromium.launchPersistentContext`
- Added comprehensive tests for extension lifecycle:
  - Toggling extension on new and existing pages
  - Verifying direct CDP connection to relay
  - Handling Playwright connection before extension attachment
- Fixed `getCdpUrl` utility usage in tests
- Updated tests to use unique URLs for better debugging

## 0.0.8

### Patch Changes

- Added `getLocatorStringForElement` utility to `execute` tool context
- Helper generates Playwright locator strings for element handles
- Fixed bug where timeout was not correctly passed to `waitForEvent` in `getCurrentPage`

## 0.0.7

### Patch Changes

- Increased default timeout for execute tool from 3000ms to 5000ms

## 0.0.6

### Patch Changes

- Added `resetPlaywright` functionality to reset Playwright connection
- Added `getCdpUrl` utility function for CDP endpoint access
- Support for multiple tabs in CDP relay
- Support for multiple Playwright clients
- Enhanced prompt documentation with better examples
- Improved CDP relay error handling and logging
- Added `utils.ts` with helper functions

## 0.0.5

### Patch Changes

- Added `activateTab(page)` utility function to bring browser tabs to front and focus them
- Added `Playwriter.activateTab` CDP command support in relay server
- Added `activateTab` message type to extension protocol
- Extension now handles tab activation via `chrome.tabs.update` and `chrome.windows.update`

## 0.0.4

### Patch Changes

- Added `context` field to `State` type
- Renamed `ToolState` interface to `State`
- Limit execute tool output to 1000 characters with truncation message

## 0.0.3

### Patch Changes

- Replace CommonJS `require` with ESM `import` for user-agents module

## 2025-07-24 22:15

- Changed Chrome process stdio from 'ignore' to 'inherit' to print Chrome logs
- Helps with debugging CDP connection issues

## 2025-07-24 22:00

- Simplified email validation by checking profiles directly in MCP connect tool
- Connect tool validates email against available profiles before starting Chrome
- Returns helpful message with available profiles when email doesn't match
- startPlaywriter now simply throws an error for invalid emails

## 2025-07-24 21:45

- Added test infrastructure with vitest for MCP server testing
- Created mcp-client.ts with MCP client setup using vite-node
- Added comprehensive tests for Chrome CDP connection and console log capture
- Fixed callTool signatures to match MCP SDK API
- Added proper TypeScript types for CallToolResult

## 2025-07-24 21:30

- Moved profile listing functionality into connect tool when emailProfile is not provided
- Updated parameter description with agent-appropriate phrasing ("ask your user/owner")
- Removed separate get_profiles tool for cleaner API
- Connect tool now handles both profile listing and connection in one place

## 2025-07-24 21:15

- Modified startPlaywriter to accept optional emailProfile parameter
- Removed prompts dependency and interactive profile selection
- Connect tool now accepts emailProfile parameter or returns available profiles
- Added security guidance for profile selection in MCP response
- Suggests storing selected email in AGENTS.md or CLAUDE.md to avoid repeated selection

## 2025-07-24 21:00

- Integrated Chrome launch via startPlaywriter from playwriter.ts
- Connect tool now starts Chrome with CDP port and connects via playwright.chromium.connectOverCDP
- Added proper cleanup handlers for browser and Chrome process on server shutdown
- Removed placeholder getActivePage function in favor of direct browser connection

## 2025-07-24 20:50

- Moved console object definition outside of the Function constructor template string
- Improved code readability and maintainability

## 2025-07-24 20:45

- Refactored console capture to use a custom console object instead of overriding global console
- Cleaner implementation that avoids modifying global state

## 2025-07-24 20:40

- Enhanced execute tool to capture console.log, console.info, console.warn, console.error, and console.debug output
- Console methods are temporarily overridden during code execution to collect logs
- Output now includes both console logs and return values in a formatted response

## 2025-07-24 20:35

- Added execute tool to run arbitrary JavaScript code with page and context in scope
- The tool uses the Playwright automation guide from prompt.md as its description

## 2025-07-24 20:30

- Fixed MCP server tool registration API usage to match the correct method signature (name, description, schema, handler)
