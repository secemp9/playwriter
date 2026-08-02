## CLI Usage

If `playwriter` command is not found, install globally or use npx/bunx:

```bash
npm install -g playwriter@latest
# or use without installing:
npx playwriter@latest session new
bunx playwriter@latest session new
```

If using npx or bunx always use @latest for the first session command. so we are sure of using the latest version of the package

### Session management

Each session runs in an **isolated sandbox** with its own `state` object. Use sessions to:

- Keep state separate between different tasks or agents
- Persist data (pages, variables) across multiple execute calls
- Avoid interference when multiple agents use playwriter simultaneously

Get a new session ID to use in commands:

```bash
playwriter session new
# outputs: 1
```

**Always use your own session** - pass `-s <id>` to all commands. Using the same session preserves your `state` between calls. Using a different session gives you a fresh `state`.

List all active sessions with their state keys:

```bash
playwriter session list
# ID  State Keys
# --------------
# 1   myPage, userData
# 2   -
```

Reset a session if the browser connection is stale or broken:

```bash
playwriter session reset <sessionId>
```

### Remote access (control browser from another machine)

Playwriter can control a Chrome browser running on a different machine over the internet. The host machine runs `playwriter serve` with a [traforo](https://traforo.dev) tunnel, and the remote machine connects through the tunnel URL.

```bash
# Host machine (has Chrome + extension)
npx -y traforo -p 19988 -- npx -y playwriter serve --token MY_SECRET_TOKEN

# Remote machine
export PLAYWRITER_HOST=https://<tunnel-id>-tunnel.traforo.dev
export PLAYWRITER_TOKEN=MY_SECRET_TOKEN
playwriter session new
playwriter -s 1 -e "await page.goto('https://example.com')"
```

For the full guide (Docker, LAN, MCP config, security), see: https://playwriter.dev/docs/remote-access

### Direct CDP connection (no extension needed)

Playwriter can connect directly to a Chrome instance via the Chrome DevTools Protocol, bypassing the browser extension entirely. This is useful for:

- Chrome running with remote debugging enabled (CI, Docker, headless environments)
- Cloud browser providers that expose a CDP endpoint (e.g. `wss://xxx.cdp.browser-use.com`)
- Any service or machine that gives you a `ws://` or `wss://` URL to a Chrome DevTools session

**Prerequisites:** you need a CDP-enabled Chrome. Either:

- Open `chrome://inspect/#remote-debugging` in Chrome
- Launch Chrome with `--remote-debugging-port=9222`
- Use `playwriter browser start` (enables debugging automatically)
- Use a cloud browser provider URL (no local Chrome needed)

**CLI usage:**

```bash
# Auto-discover local Chrome instances with debugging enabled
playwriter session new --direct

# Connect to a specific CDP endpoint (local or cloud browser provider)
playwriter session new --direct ws://localhost:9222/devtools/browser/...
playwriter session new --direct wss://xxx.cdp.browser-use.com

# Connect to a remote Chrome instance (host:port auto-resolves to ws://)
playwriter session new --direct 192.168.1.50:9222

# Then use the session normally
playwriter -s 1 -e "await page.goto('https://example.com')"
```

**MCP configuration** (for AI assistants): set the `PLAYWRITER_DIRECT` env var in your MCP client config. If the user provides a CDP URL (like `wss://xxx.cdp.browser-use.com`), use it as the value:

```json
{
  "mcpServers": {
    "playwriter": {
      "command": "npx",
      "args": ["-y", "playwriter@latest"],
      "env": {
        "PLAYWRITER_DIRECT": "wss://xxx.cdp.browser-use.com"
      }
    }
  }
}
```

`PLAYWRITER_DIRECT` accepts:

- `1` — auto-discover Chrome on port 9222
- `ws://` or `wss://` URL — explicit WebSocket endpoint (local or cloud browser provider)
- `host:port` — resolves via HTTP probe to a ws:// URL

**Limitations:** `recording.start`/`recording.stop` are unavailable in direct CDP mode (they rely on the extension's `chrome.tabCapture`). Use `recording.startCdp`/`stopCdp` instead — it works in both direct CDP and extension sessions and needs no icon click. See the recording section.

### Headless browser (no extension, no user browser)

Launch a headless Chrome automatically. No extension setup, no user browser involvement. Useful when the user doesn't want their personal browser used, in CI/server environments, or for fully autonomous automation.

```bash
# Install Chrome for Testing (first time only, if no Chrome is available)
playwriter browser install

# Launch headless Chrome and create a session
playwriter session new --browser headless

# Use the session normally
playwriter -s 1 -e "await page.goto('https://example.com')"
playwriter -s 1 -e "console.log(await snapshot({ page }))"
```

Multiple sessions reuse the same headless Chrome process. Recording is not available in headless mode.

If no Chrome binary is found, `playwriter session new --browser headless` will tell you to run `playwriter browser install` first to download Chrome for Testing.

### Cloud browsers (stealth, proxies, CAPTCHA solving)

Cloud browsers are full Chromium instances running in the cloud. They work exactly like a local Chrome session but with stealth and anti-detection built in. No local Chrome or extension needed.

**When to use cloud browsers:**

- **CAPTCHA bypass.** Cloudflare Turnstile, reCAPTCHA v2/v3, and hCaptcha are solved automatically via token injection. No API keys, no manual solving, no extra code.
- **Anti-detection.** Stealth Chromium patches remove `navigator.webdriver`, CDP leak fingerprints, and other automation signals. Sites that block Playwright, Puppeteer, or Selenium work normally.
- **Residential proxies.** Route traffic through residential IPs in 195+ countries with `--proxy <region>`. Proxy is disabled by default to save cost; enable it only when you need anti-detection or geo-targeting.
- **VPS and headless environments.** Run browser automation from any server without installing Chrome. The cloud browser runs remotely and you connect via CDP.
- **Parallel execution.** Spin up multiple cloud browsers to run tasks in parallel with subagents. Each browser is an isolated instance with its own IP, fingerprint, and cookie jar.
- **Multiple identities.** Control separate logged-in accounts on the same site simultaneously. Each cloud browser has independent cookies and storage, so sessions don't interfere with each other.

**Authentication:** two options depending on your environment.

```bash
# Option 1: Interactive login (opens browser for OAuth)
playwriter cloud login

# Option 2: API key (for CI, VPS, headless — no browser needed)
# Create one at https://playwriter.dev/dashboard, then:
export PLAYWRITER_API_KEY=pw_xxxxx
```

```bash
# Check active cloud sessions
playwriter cloud status

# Start a cloud browser session (no proxy, cheapest)
playwriter session new --browser cloud

# Start with US residential proxy (for anti-detection / geo-targeting)
playwriter session new --browser cloud --proxy us

# Use a different region
playwriter session new --browser cloud --proxy de

# Use a custom proxy
playwriter session new --browser cloud --custom-proxy user:pass@host:8080
```

Cloud sessions auto-stop after 10 minutes of inactivity. When proxy is enabled, raster images are blocked by default to reduce bandwidth costs. Pass `--disable-proxy-bandwidth-acceleration` if you need images to load.

### Execute code

```bash
playwriter -s <sessionId> -e "<code>"
```

The `-s` flag specifies a session ID (required). Get one with `playwriter session new`. Use the same session to persist state across commands.

**Examples:**

```bash
# Navigate to a page
playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com")'

# Click a button
playwriter -s 1 -e 'await state.page.click("button")'

# Get page title
playwriter -s 1 -e 'await state.page.title()'

# Take a screenshot
playwriter -s 1 -e 'await state.page.screenshot({ path: "/absolute/path/to/screenshot.png", scale: "css" })'

# Get accessibility snapshot
playwriter -s 1 -e 'await snapshot({ page: state.page })'

# Get accessibility snapshot for a specific iframe
playwriter -s 1 -e 'const frame = await state.page.locator("iframe").contentFrame(); await snapshot({ frame })'
```

**Why single quotes?** Always wrap `-e` code in single quotes (`'...'`) to prevent bash from interpreting `$`, backticks, and other special characters inside your JS code. Use double quotes or backtick template literals for strings inside the JS code.

**Multiline code:**

```bash
# Preferred: use heredoc with quoted delimiter (disables all bash expansion)
playwriter -s 1 -e "$(cat <<'EOF'
const links = await state.page.$$eval('a', els => els.map(e => e.href));
console.log('Found', links.length, 'links');
const price = text.match(/\$[\d.]+/);
EOF
)"

# Alternative: $'...' syntax (but beware: \n and \t become special, and
# single quotes inside must be escaped as \')
playwriter -s 1 -e $'
const title = await state.page.title();
const url = state.page.url();
console.log({ title, url });
'
```

**Quoting rules summary:**
- **Single quotes** (`'...'`): best for one-liners. No bash expansion at all. But you cannot include a literal single quote inside — use double quotes for JS strings instead.
- **Heredoc** (`<<'EOF'`): best for multiline code. The quoted `'EOF'` delimiter disables all bash expansion. Any character works inside, including `$`, backticks, and single quotes.
- **`$'...'`**: allows `\'` escaping but `\n`, `\t`, `\\` become special — conflicts with JS regex patterns.

### Execute from file

For longer scripts, use `-f` instead of `-e` to execute JavaScript from a file:

```bash
playwriter -s 1 -f script.js
```

The file is read from disk and executed in the same sandbox as `-e`. All context variables (`state`, `page`, `context`, etc.) are available. `-e` and `-f` cannot be used together.

### Debugging playwriter issues

If some internal critical error happens you can read the relay server logs to understand the issue. The log file is located in the user home directory:

```bash
playwriter logfile  # prints the log file path
# typically: ~/.playwriter/relay-server.log
```

The relay log contains logs from the extension, MCP and WS server. A separate CDP JSONL log is created alongside it (see `playwriter logfile`) with all CDP commands/responses and events, with long strings truncated. Both files are recreated every time the server starts. For debugging internal playwriter errors, read these files with grep/rg to find relevant lines.

Example: summarize CDP traffic counts by direction + method:

```bash
jq -r '.direction + "\t" + (.message.method // "response")' ~/.playwriter/cdp.jsonl | uniq -c
```

If you find a bug, you can create a gh issue using `gh issue create -R remorses/playwriter --title title --body body`. Ask for user confirmation before doing this.

---

# playwriter best practices

Control user's Chrome browser via playwright code snippets. Prefer single-line code with semicolons between statements. Use playwriter immediately without waiting for user actions; only if you get "extension is not connected" or "no browser tabs have Playwriter enabled" should you ask the user to click the playwriter extension icon on the target tab.

**When to use playwriter instead of webfetch/curl:** If a website is JS-heavy (SPAs like Instagram, Twitter, Facebook, etc.), has cookie consent modals, login walls, lazy-loaded content, carousels, or infinite scroll — **always use playwriter**. Simple fetch/webfetch will return an empty HTML shell with no content. Do NOT waste time trying curl, webfetch, or parsing raw HTML from JS-rendered sites. Go straight to playwriter: navigate with a real browser, dismiss modals, then read the page with `snapshot()` for structure, `pm.query()` when you need tags/attributes/your own fields, or `getPageMarkdown()` for article text. `page.evaluate()` and network interception are the narrower fallbacks for what those cannot see — see "reading a page: pick the narrowest tool".

**If Chrome is not running**, the extension can't connect. Start Chrome from the command line before retrying:

```bash
# macOS
open -a "Google Chrome" --args --profile-directory=Default

# Linux
google-chrome --profile-directory=Default &

# Windows (cmd)
start chrome.exe --profile-directory=Default

# Windows (PowerShell)
Start-Process chrome.exe -ArgumentList '--profile-directory=Default'
```

To also enable automatic tab capture for screen recording (no manual extension click needed), add the `--allowlisted-extension-id` and `--auto-accept-this-tab-capture` flags:

```bash
# macOS
open -a "Google Chrome" --args --profile-directory=Default --allowlisted-extension-id=jfeammnjpkecdekppnclgkkffahnhfhe --auto-accept-this-tab-capture

# Linux
google-chrome --profile-directory=Default --allowlisted-extension-id=jfeammnjpkecdekppnclgkkffahnhfhe --auto-accept-this-tab-capture &

# Windows
start chrome.exe --profile-directory=Default --allowlisted-extension-id=jfeammnjpkecdekppnclgkkffahnhfhe --auto-accept-this-tab-capture
```

You can collaborate with the user - they can help with captchas, difficult elements, or reproducing bugs.

**Direct CDP mode (no extension needed):** Playwriter can connect directly to Chrome's DevTools Protocol, bypassing the extension. This is useful in CI, Docker, headless environments, when Chrome has `--remote-debugging-port=9222`, or with cloud browser providers (e.g. `wss://xxx.cdp.browser-use.com`). If the user provides a CDP URL, set `PLAYWRITER_DIRECT` in the MCP client config:

```json
{
  "mcpServers": {
    "playwriter": {
      "command": "npx",
      "args": ["-y", "playwriter@latest"],
      "env": {
        "PLAYWRITER_DIRECT": "wss://xxx.cdp.browser-use.com"
      }
    }
  }
}
```

`PLAYWRITER_DIRECT` accepts `1` (auto-discover Chrome on port 9222), a `ws://` or `wss://` endpoint (including cloud browser providers), or `host:port`.

**Screen recording IS available in direct CDP mode — but only one of the two recorders.** `recording.start`/`recording.stop` are unavailable, because they rely on the extension's `chrome.tabCapture` API. `recording.startCdp`/`stopCdp` work in direct CDP and extension sessions alike and need no extension-icon click; see the recording section.

## context variables

- `state` - object persisted between calls **within your session**. Each session has its own isolated state. Use to store pages, data, listeners (e.g., `state.page = await context.newPage()`)
- `page` - a default page (prefer `state.page`, which persists per session — see "working with pages")
- `context` - browser context, access all pages via `context.pages()`
- `browser` - the connected Playwright `Browser`. Present so `browser.version()` / `browser.contexts()` are readable; **never** call `browser.close()` (see "rules"). It is a snapshot taken when the call started, so after `resetPlaywright()` re-read it rather than holding one in `state`.
- `chrome` - Ghost Browser's multi-identity APIs. Only works inside Ghost Browser; see the last section.
- `require` - load Node.js modules (e.g., `const fs = require('node:fs')`). ESM `import` is not available in the sandbox
- Node.js globals: `setTimeout`, `setInterval`, `fetch`, `URL`, `Buffer`, `crypto`, `process`, etc.

**resetPlaywright()** - drop the browser connection and reconnect, from inside the sandbox. It is the same thing `playwriter session reset` does, and it clears **all** of `state`, so treat it as a last resort when the connection is wedged mid-task rather than a routine retry:

```js
const { page: fresh } = await resetPlaywright()
state.page = fresh
```

**Not available in the sandbox:** `__dirname`, `__filename`, `import`.

`require` is restricted to a list of safe Node built-ins; anything else throws `ModuleNotAllowedError`. The same list gates `require.resolve()` and `process.getBuiltinModule()`, and all three return the same objects — `fs` is always the write-scoped one described below, never the raw module.

`process` is exposed for reading (`env`, `argv`, `platform`, `version`). It is read-only, `cwd()` reports your session's directory, and the members that end or re-privilege the relay process (`exit`, `abort`, `kill`, `chdir`, `umask`, `setuid`…) or load native code (`binding`, `dlopen`, `loadEnvFile`) all throw. Note that `process.env` is the relay process's real environment: you can read it and writes are visible to the whole process.

**Important:** `state` is **session-isolated**, and browser tabs are **isolated per git worktree** — `context.pages()` only ever returns your own worktree's tabs. Two sessions in the *same* worktree deliberately share tabs; sessions in different worktrees never see each other's tabs. See "working with pages".

**Sandboxed `fs` write restrictions:** `require('node:fs')` is scoped. Writes (writeFileSync, mkdirSync, etc.) only succeed in:
- The **directory where `playwriter` CLI was invoked** (the session's cwd)
- `/tmp`
- The OS temp directory (`os.tmpdir()`, e.g. `/var/folders/.../T/` on macOS)

Writing to any other path (e.g. `~/Downloads`, `~/Desktop`) throws `EPERM: operation not permitted, access outside allowed directories`. To save files elsewhere, write to a temp path first, then move the file using a shell command outside the sandbox.

Two limits of that scoping worth knowing: paths are checked textually, so an existing **symlink** inside an allowed directory is followed wherever it points (a `node_modules` link to a sibling package still resolves); and Playwright's own file APIs (`page.screenshot({ path })`, `download.saveAs`, `recording.startCdp({ outputPath })`) write through Playwright and ffmpeg, not through the scoped `fs`, so they are not restricted to these directories.

**The sandbox is a guardrail, not a security boundary.** The allowlist, the `fs` scoping and the `process` restrictions exist to stop an agent doing something destructive by accident or by following a web page's injected instructions literally. They are not isolation: `execute()` runs in a Node `vm` context that shares live objects (`page`, `Buffer`, `fetch`) with the host process, and code that goes looking can reach the host realm through any of them. Never run code you would not run in your own terminal, and do not treat this as a place to execute untrusted input.

## rules

- **Initialize state.page first**: see "working with pages" — at the start of a task, assign `state.page` (reuse `about:blank` or create one) and use `state.page` for all automation steps.
- **Multiple calls**: use multiple execute calls for complex logic - helps understand intermediate state and isolate which action failed
- **Never close**: never call `browser.close()` or `context.close()`. Only close pages you created or if user asks
- **No bringToFront**: never call unless the user asks — it steals the focus of whatever they are actually looking at, and you can drive a background page without it. For recording, `recording.startCdp` captures a backgrounded tab fine on its **screencast** path (measured: 31 frames backgrounded against 30 foregrounded, and 60fps hidden over raw CDP); its **screenshot** path genuinely does need a foreground tab (~0.1fps hidden, single captures blocking up to 26s) and calls `bringToFront()` **itself**, so you still never call it — you choose the mode instead. See the recording section for which modes foreground, `mode: 'auto'` included. **There is exactly one place where YOU make the call, and it is `humanMouse`** — its moves are frame-locked, and a backgrounded renderer stretches every `Input.dispatchMouseEvent` from ~17ms to seconds, which no amount of retrying fixes. Only there is `await page.bringToFront()` the right call, only when the result's `rendererThrottled` flag says so, and the alternative is to not use human motion on that tab. See "humanMouse" for the numbers. Clicking, snapshotting and everything else here works on a background tab.
- **Check state after actions**: always verify page state after clicking/submitting (see next section)
- **Clean up listeners**: call `state.page.removeAllListeners()` at end of message to prevent leaks
- **Always print page logs after every action**: call `getLatestLogs({ page: state.page, sinceLastCall: true })` after every goto, click, or submit to catch console errors and warnings. Do not manually collect `page.on('console')` events; manual listeners miss logs emitted before the listener is attached. The first `sinceLastCall` call returns all buffered logs including startup and hydration errors.
- **CDP sessions**: use `getCDPSession({ page: state.page })` not `state.page.context().newCDPSession()` - NEVER use `newCDPSession()` method, it doesn't work through playwriter relay
- **Wait for load**: use `state.page.waitForLoadState('domcontentloaded')` not `state.page.waitForEvent('load')` - waitForEvent times out if already loaded
- **Minimize timeouts**: prefer proper waits (`waitForSelector`, `waitForPageLoad`) over `state.page.waitForTimeout()`. Short timeouts (1-2s) are acceptable for non-deterministic events like animations, tab opens, or async UI updates where no specific selector is available
- **Snapshot before screenshot**: always use `snapshot()` first to understand page state (text-based, fast, cheap). Only use `screenshot` when you specifically need visual/spatial information. Never take a screenshot just to check if a page loaded or to read text content — snapshot gives you that instantly without burning image tokens
- **Always use absolute file paths for Playwright artifact APIs**: for `page.screenshot({ path })`, `locator.screenshot({ path })`, `elementHandle.screenshot({ path })`, `page.pdf({ path })`, `download.saveAs(path)`, and `video.saveAs(path)`, always pass an absolute path. Relative paths are resolved by Playwright client internals, not the sandboxed `fs`, so they may use the relay server cwd instead of your session cwd.
- **Structured readers replace page.evaluate() for inspection**: do NOT write `page.evaluate()` calls to manually query roles, text, child counts, class names, or test ids. `snapshot()` already shows every interactive element with its text, role, and a ready-to-use locator; for tags, attributes, or a custom field set use `pm.query({ page: state.page, fields: ['role', 'name', 'tag', 'locator', 'attributes.class'] })`. If you catch yourself writing `document.querySelector` inside evaluate — stop and pick from the next section. Reserve `page.evaluate()` for the five cases listed there.

## reading a page: pick the narrowest tool

**Two unrelated trees — do not conflate them.** `pm` / `queryPage` / `select:` / the virtual types walk **live page nodes** (the ARIA snapshot fused with the flattened DOM); they know nothing about your source code. `traceValue` and the module graph behind it parse **source files on disk** with Babel; they know nothing about the DOM. `traceValue`'s React-fiber anchor step is the only bridge between the two, and it needs author source on disk **and** a React dev build.

Three layers, in cost order. **Never skip down a layer without a reason you can state.**

**Layer 1 — read the page. This is the default.**

| Need | Use |
|---|---|
| What's on the page, what can I click | `snapshot({ page: state.page })` |
| Same, plus tags/attributes or your own field set | `pm.query({ page: state.page, select: 'Interactive', fields: ['role', 'name', 'locator'] })` |
| Compact fused tree, marking what is new since the last call | `pm.renderText({ page: state.page })` |
| Article text | `getPageMarkdown({ page: state.page })` |
| Structural HTML | `getCleanHTML({ locator: state.page })` |
| One stable handle to carry into React/CSS | `pm.anchor('role=button[name="Save"]', { page: state.page })` |
| What is actually at this pixel | `pm.anchorAt({ x, y }, { page: state.page })` — a real hit test |

**Layer 2 — explain the page.** Something looks wrong but nothing crashed.

| Symptom | Use |
|---|---|
| Wrong colour / size / spacing, "my CSS isn't applying" | `debugStyle({ locator, property })` — winner **and** losers, with `file:line` |
| Renders but won't take a click | `whyOccluded({ locator })` — names the covering nodes **and** hit-tests the box centre |
| Which component rendered this, with what props | `fiberSnapshot({ locator })`, or `handle.reactFiber()` from a `pm.anchor` handle |
| Which props changed across a render | two `fiberSnapshot({ identity: true })` + `fiberDiff` |
| Clicked, DOM looks right, nothing persisted | `storeIdentity({ page: state.page, action })` — check `measured` first |
| Intermittent / order-dependent | `net.timeline` (passive), then `net.delay` (perturbing) to force it |
| Something is perturbing my measurements | `net.active()` / `net.warnings()` — the session probe registry |
| Only makes sense as motion | `recording.startCdp` (see recording section) |

**Layer 3 — explain the code.** A rendered value is wrong and you have the app's source checked out.

| Need | Use |
|---|---|
| Where this on-screen value comes from | `traceValue({ page: state.page, selector })` → read `render()`, then `blocked` |
| Continue past a blocked leaf | `await t.runProbe(id)` — never guess the value |
| Detail on one hop | `t.expand(id, { depth: 3 })` — one call, whole bounded subtree |
| "It's a `const`, it can't have changed" | `inspectBinding({ file, graph, name })` — constant ≠ unmutated |
| Which reactive value a hook forgot | `findMissingDeps({ file, graph })` — scans the whole file |
| Just the static slice, no anchor/probes | `backwardSlice({ startFile, startExpr })` |
| Value lives in a bundle with no author source | `getScriptSourceByUrl` → `setLogpoint` → `readLogpoints` |
| Step through live | `createDebugger` |

Signatures, traps, and real limits for every Layer 2/3 tool are in "debugging: symptom → cause" below — read them before your first call.

**`page.evaluate()` is still the right tool for exactly these:**

1. **Mutating** page state — `localStorage.clear()`, `el.scrollTop += 500`, dispatching an app event.
2. **Non-DOM JS values** — `window.__CONFIG__`, `window.__NEXT_DATA__`, a global store handle.
3. **Properties the model does not carry** — `naturalWidth`, `videoWidth`, `scrollHeight`, canvas contents, live scroll offsets. Static geometry is NOT on this list any more: `runtime.box`, `paintOrder`, `visible`, `inViewport` and the tracked computed styles all come off the layout snapshot, so `getBoundingClientRect` in an `evaluate` is usually a slower duplicate of `pm.query({ fields: ['runtime.box'] })`.
4. **In-page `fetch`** to reuse session cookies, and blob downloads.
5. **Bulk extraction of one repeated non-semantic field** across hundreds of nodes in a single round-trip, where that field is not in the model.

If the body of your `evaluate` is a `querySelectorAll` plus a map of role / name / text / class / testid — that is a `pm.query`, and you should rewrite it.

## interaction feedback loop

Every browser interaction must follow **observe → act → observe**. Never chain multiple actions blindly.

1. **Open page** — get or create your page, navigate to URL
2. **Observe** — print `state.page.url()` + `snapshot()` + `getLatestLogs({ sinceLastCall: true })`. Always print URL — pages can redirect unexpectedly.
3. **Check** — if page isn't ready (loading, wrong URL, content missing), wait and observe again
4. **Act** — perform one action (click, type, submit)
5. **Observe again** — print URL + snapshot + page logs to verify the action's effect
6. **Repeat** from step 3 until task is complete

**Always print page logs after every action** using `getLatestLogs({ sinceLastCall: true })`. This returns only new console messages and errors since the last call, so you catch hydration errors, failed network requests, and runtime exceptions without duplicates. The first call returns all buffered logs from the page, including logs emitted before your script started.

```js
// Each step should be a separate execute call:
// Step 1: navigate + observe
state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage())
await state.page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
console.log('URL:', state.page.url())
console.log('Page logs:', await getLatestLogs({ page: state.page, sinceLastCall: true }))
await snapshot({ page: state.page }).then(console.log)
```

```js
// Step 2: act + observe
await state.page.locator('button:has-text("Submit")').click()
console.log('URL:', state.page.url())
console.log('Page logs:', await getLatestLogs({ page: state.page, sinceLastCall: true }))
await snapshot({ page: state.page }).then(console.log)
```

If nothing changed after an action, try `waitForPageLoad({ page: state.page, timeout: 3000 })` or you may have clicked the wrong element.

**Deeper observation** — when snapshots aren't enough to understand what happened, combine snapshot with filtered logs:

```js
// Search for specific errors in all logs (not just since last call)
const errors = await getLatestLogs({ page: state.page, search: /error|fail/i, count: 20 })

// Combine snapshot + filtered logs for full picture
const snap = await snapshot({ page: state.page, search: /dialog|error|message/ })
const logs = await getLatestLogs({ page: state.page, search: /error/i, count: 10 })
console.log('UI:', snap)
console.log('Logs:', logs)
```

Use `getLatestLogs({ sinceLastCall: true })` after every action, `getLatestLogs({ search })` for targeted debugging, `state.page.url()` for navigation, screenshots only for visual layout issues.

## debugging: symptom → cause

Signatures, traps, and current limits for the Layer 2/3 tools named above.

**All of these are sandbox globals — already in scope, so never try to load one.** Loading is not how you would get them anyway: there is no `import` at all (no global, and the syntax cannot work either — a static `import` is a SyntaxError inside the async wrapper your code runs in, and a dynamic `import()` throws in a `vm` context), while `require` genuinely exists but only ever hands back the allowlisted Node built-ins listed under "context variables" — never a Playwriter global. Nearly all of the globals below are async — `await` them. To see a value, `return` it, or `console.log` it: sandbox console output is collected and returned to **you** in the execute result. (The `console.log` that goes to the browser console instead of to you is the one written *inside* `page.evaluate()`.) Full types and examples live in the `page-model-api` and `trace-api` MCP resources.

**`{ page: state.page }` is not optional.** Everything that *can* default to a page defaults to the sandbox `page` global — **not** `state.page` — so omitting it silently drives or inspects the wrong tab. The full list: `pm.*`, `queryPage`, `snapshot`, `refToLocator`, `traceValue`, `storeIdentity`, `net.*`, `setLogpoint`, `readLogpoints`, `getScriptSourceByUrl`, `humanMouse.*`, `ghostCursor.show`/`hide`, `recording.start`, and `recording.startCdp`. (`debugStyle`, `whyOccluded` and `fiberSnapshot` take their page from the `locator` you pass, so they are exempt — and so is `snapshot` when you scope it with a `locator` or a `frame`, which carries its own page.)

`getLatestLogs` is the one exception, and it is surprising in the other direction: with no `page` it returns the logs of **every** page in the session, interleaved, not the default page's. Pass `page` when you want one tab's console.

**PageModel & CSS provenance** — a queryable tree fusing the ARIA snapshot, flattened DOM, and lazy React/CSS edges. Prefer it over raw DOM scraping. It returns cycle-free projections, and it is rebuilt on every execute call, so handles do not survive across calls.

```js
await pm.query({ page: state.page, roles: ['button'] })   // rows of key/role/name/tag/locator/runtime.visible unless you pass fields:[...]
await pm.query({ page: state.page, select: 'Interactive', fields: ['role', 'name', 'locator', 'attributes.data-testid'] })
await pm.query({ page: state.page, visibleOnly: true })   // runtime.visible === true
await pm.query({ page: state.page, inViewportOnly: true })// a DIFFERENT question — visible can be scrolled out
await pm.query({ page: state.page, within: 'element#main' })      // scope the QUERY (page-path)
await pm.query({ page: state.page, rootSelector: 'main' })        // scope the FETCH (Playwright selector)
await pm.query({ page: state.page, changedSince: true })  // + changedSince/changes per row
await queryPage({ page: state.page, select: 'Interactive' })  // same projection, top-level
const h = await pm.anchor('role=button[name="Submit"]', { page: state.page }) // → handle | null
const hit = await pm.anchorAt({ x: 640, y: 320 }, { page: state.page })       // GROUND-TRUTH hit test
await h.reactFiber()                                      // lazy edge: { componentName, source, props }
await h.styles()                                          // lazy edge: cascade winner per property
await pm.renderText({ page: state.page, visibleOnly, inViewportOnly, includeRemoved })
await pm.debugMode({ page: state.page })                  // projection config with lossy levers off (you pass it yourself)
await debugStyle({ locator, property: 'color' })          // cascade winner + overridden losers ({ node } also works)
await whyOccluded({ locator })                            // who is covering it + a real hit test
await whyOccluded({ node: h, page: state.page })          // `page` only when a { node } handle carries no page of its own
```

**Two scopes, two selector languages — this is the one trap worth memorising.** `rootSelector` is a **Playwright** selector and scopes what is *fetched*, before any tree exists (CSS and `:has-text` work). `within` is a **page-path** selector over the tree that already exists (`'element#main'`, `'Interactive'`, `Type[attr=value]` with an **unquoted** value). `scope` is the deprecated alias, and everywhere in the sandbox — `pm.query`, `pm.anchor`, `pm.renderText`, `pm.debugMode`, `queryPage` — it means **`rootSelector`**, the fetch scope. It is never read as a query `within`. Say `within` when you mean the query.

**Selector traps:**
- **`pm.anchor` is not a CSS engine.** Working forms: a locator exactly as `snapshot` printed it (`'role=button[name="Submit"]'`, `'[data-testid="total"]'`), a page-path selector (`'element[data-testid=total]'` — value **unquoted** — `'element#submit'`, `'Interactive'`, `'*'`), `{ backendNodeId }`, or `{ x, y, frameId? }`. `'button:has-text("Submit")'` and `'.card'` match nothing and return `null`. **`traceValue({ selector })` is the opposite** — a real Playwright selector, so `:has-text` works there. Identical-looking arguments, opposite rules.
- **`pm.anchor` returns `null` because the node is missing from the model's index**, not because it "has no role": the model is built from the ARIA snapshot and aria nodes with no `backendNodeId` are deliberately excluded from the map `anchor` searches. Anchor an element `snapshot` printed a locator for.
- **An unmatched `within` THROWS** (it used to widen silently to the whole document, so a typo was indistinguishable from a real empty result). A scope is a precondition, not a filter — read the error, don't retry with `select`.
- **A typo in `select` returns `[]`, not an error.** The complete vocabulary is exactly `document`, `element`, `text`, `Node`, `VisibleElement`, `InViewportElement`, `Interactive`, `OccludedElement`, `FullyOccludedElement`.
- **`roles` must be exact lowercase** AX roles — `roles: ['Button']` → `[]`. **`depth` is ignored when `select` is set.**

**Geometry is real, and it is honest about what it does not know:**
- `runtime.box`, `paintOrder`, `stackingContext`, `computedStyles` and the occlusion fields come off `DOMSnapshot.captureSnapshot`. `changedSince` reports the full vocabulary — `new`, `moved`, `style`, `removed`, `hidden`, `shown` — with per-property before/after in `runtime.changes`.
- **`visible` and `rendered` are OPTIONAL, and absent means "could not be measured"** — an a11y-only node, or user-agent shadow content. Absence is **not** `false` and above all not `true`. Test `=== true`; `visibleOnly` and `VisibleElement` already do, so an unmeasurable node can never be mistaken for a visible one.
- **`visible` says nothing about the viewport.** Scrolled out of view is `inViewport: false`, not `visible: false`. `inViewport` is `undefined` in child frames — only the main frame has published viewport metrics, and measuring against the wrong rectangle would be worse than saying nothing.
- **Occlusion is an INFERENCE** from paint order + bounds containment, so it is wrong exactly when the painted shape is not the bounds rectangle: `clip-path`, `border-radius` corners, rotated/skewed `transform`s, a covering node that paints nothing, and overlays in a **different frame** (each frame's boxes are in its own coordinate space, so cross-frame overlap is never computed). `whyOccluded` flags these as `shapeDistortingProps`.
- **`pm.anchorAt` is the ground truth** — one `DOM.getNodeForLocation`, in document coordinates. `pm.anchor({x, y})` only infers the topmost node from paint order. When the two disagree, `anchorAt` is right. `whyOccluded` runs both and reports both.

**`whyOccluded` returns three separate kinds of evidence — do not collapse them:** `occluded` / `occludedBy` / `occludedByLabels` / `occludedFraction` (inference), `hitTest` (ground truth at the box centre, so it cannot see partial coverage), and `stackingContext` / `stackingReasons` (Chromium's own flag, plus the declarations that *explain* it — the declarations never decide it). `measured: false` means the element could not be joined to the measured tree at all: occlusion is **unknown**, not clear.

**Trace lane & probe toolkit** — turns a wrong on-screen value into a cause.

```js
const t = await traceValue({ page: state.page, selector: '[data-testid="total"]' })
t.render()                                                  // token-bounded summary — read FIRST. A METHOD: render({ maxLines: 60, codeFrames: true })
t.anchor                                                    // where the symptom was pinned: { componentName, file, line, slot, note } | null
t.warnings                                                  // live PERTURBING probes + blind spots with no probe. Read before trusting timings
t.hopIds                                                    // address a hop without walking the tree
t.blocked                                                   // { id, blockedBy, site, hazards, codeFrame, probe }
t.expand(hopId, { depth: 3 })                               // a bounded SUBTREE in one call; omittedChildren/complete report any cut
await t.runProbe(hopId)                                     // fire the armed probe for a blocked leaf
await storeIdentity({ page: state.page, action })            // union: check `measured` before anything else
await setLogpoint({ page: state.page, file, line, expr, tag, maxPayload }) // THROWS if it can't be made non-pausing
await readLogpoints({ page: state.page, tag, maxHits, maxLen, sinceCursor }) // → { hits, totalHits, droppedHits, malformedHits, caps, cursor }
await getScriptSourceByUrl({ page: state.page, url })        // bundled source when no author source exists
state.tl = net.timeline({ page: state.page, urlPattern, maxEntries, buffer }) // PASSIVE; .entries()/.stats()/.stop(); also in the registry
const hold = await net.delay({ page: state.page, urlPattern, ms, ttlMs }) // PERTURBING: forces a race; auto-expires
net.active({ live: true }); net.get(id); net.read(id); await net.stop(id); net.warnings()
await net.stopAll()                                          // only the probes THIS session armed
// urlPattern is a SUBSTRING of the URL or a RegExp — never a glob. '*/api/*' is rejected;
// write '/api/'. Omit it to match every request. A delay that held nothing says so in
// net.warnings() and in stats().interceptedNothing.
await fiberSnapshot({ locator, identity: true })            // identity:true is what makes handler churn visible
fiberDiff(before, after)                                    // → changes / identityChangedKeys / unobservableKeys
replayPure({ fn, args, bindings })                          // re-run a pure sliced fn in-process
await replayPureAsync({ fn, args })                         // …when the sliced fn is async
```

**How to drive `traceValue`:** anchor with `{ selector }`, a `pm.anchor` handle via `{ node }`, or explicit `{ startFile, startExpr }`. `root` defaults to **your session's cwd** — pass it only when the app source lives elsewhere. Read `t.render()` first, then `t.warnings`, then `t.blocked`. Each blocked leaf names its blind spot and carries an armed-but-un-run probe. **Never fabricate a value past a `blockedBy`** — the static pass stopped there because it cannot see runtime state. Run the probe instead.

**Not every `blockedBy` wants a probe.** `mutation`, `interprocedural`, `async`, `unresolved-module` and `dynamic` are runtime blind spots: run the armed probe. These three are **static remedies** — the armed probe type is `static-remedy`, and going to get runtime evidence is the wrong move:

| `blockedBy` | What it means | The fix |
|---|---|---|
| `budget-hops` | the walk ran out of budget mid-chain; the answer is still statically reachable | re-run with a bigger `maxHops` (the hop carries a `resumable` hint). **Not** a probe |
| `cycle` | the walk re-entered a node it was already expanding | break the cycle in the source, or start the slice past it |
| `parse-error` | a source file does not parse | fix the file. No probe helps; the graph could never see it |

**`traceValue` needs author source on disk AND a React dev build** — the slice starts from the fiber's source location, which production builds omit. Without both, the whole trace collapses to a single hop with `blockedBy: 'dynamic'` and a "could not determine a start" note. That hop is the signal to drop to `createDebugger` or `setLogpoint` + `readLogpoints`, not to retry with different arguments.

**Static analysis without the orchestration** — six callable globals over the same Babel substrate `traceValue` uses. `moduleGraph` returns an **opaque handle** (the live graph holds Babel NodePaths); never try to `return` it — use `graph.summary()`.

```js
const graph = moduleGraph({ root: '/abs/repo/root' })       // cached per root; defaults to session cwd
graph.summary()                                             // { fileCount, callSiteCount, unresolvedByReason, parseFailures, … }
inspectBinding({ file, graph, name: 'items' })              // binding + hazards + one-step hop. Or { code } for inline source
evaluateBinding({ code, name: 'rate' })                     // constant-fold one reference; never a NodePath
findMissingDeps({ file, graph, withCodeFrames: true })      // React exhaustive-deps over a whole FILE
isPureFunctionSource('(a) => a + 1', { allow: [] })         // the replayPure gate, on its own
backwardSlice({ startFile, startExpr: 'total', maxHops: 16 })  // the static slice, no anchor/probes
```

**⚠️ Pitfalls that actually bite:**
- `startExpr` is a **variable name** (`'count'`, `'state'`) — never a file path or an expression like `'state.items.push(x)'`. Paths go in `startFile` (absolute). It binds to the **first** identifier of that name in the file, so a name used twice traces the wrong one (`inspectBinding` takes an `occurrence` index; `backwardSlice` does not).
- `debugStyle` / `whyOccluded` / `fiberSnapshot` take `{ locator: state.page.locator('...') }`, not a raw selector string.
- **`storeIdentity` returns a union: check `measured` first.** The `measured: false` arm carries **no `sameReference` field at all**, so a probe that never found your store cannot be misread as a store that behaved. When it is false, read `reason` / `tried` / `remedy` and pass `storeExpr` — any expression that *returns* the state object.
- `setLogpoint` **throws** when `expr` cannot be assembled into a provably non-pausing condition (a stray paren, an injected statement, a `debugger`). That refusal is the feature: a breakpoint that can pause reorders timers on resume and destroys exactly the race hypotheses this lane exists to test. Fix the expression — it must be a single JS **expression**.
- `readLogpoints` returns an object, not an array — iterate `read.hits`. **It is capped by default: the newest `maxHits: 20` hits, each value cut to `maxLen: 50` characters.** Both caps are echoed in `read.caps`, both are raisable, and neither is ever applied silently: `droppedHits > 0` means the window hid older hits (raise `maxHits`); `hit.truncated` means that value was cut (raise `maxLen`); `hit.malformed` means the page could not serialise it and the raw text was kept rather than coerced into something plausible. Pass `sinceCursor: read.cursor` on the next call to read only what arrived after this one.
- `t.render()` is capped too: `maxLines` defaults to **60** and `codeFrames` to **true**. A collapse always announces itself on the last line, so a truncated trace never reads as a complete one — but it is still a truncated trace. Raise `maxLines`, or drill with `t.expand(hopId, { depth })`.
- **A probe outlives the `execute()` call that created it** — that is the point of the registry, and the trap it replaces. A dropped `net.timeline` controller keeps recording (drain it with `net.read(id)`); a dropped `net.delay` keeps intercepting. Probes are stopped automatically when their page closes, on `reset`, and on session delete — but not at the end of a call. `net.active()` lists them, including stopped ones, so "who perturbed my measurement?" always has an answer. `net.stopAll()` is scoped to your own session.
- `net.delay` **refuses** a second overlapping delay on the same page by name (`Fetch.enable` replaces the previous patterns, so two would silently fight). Stop the first, or pass `force: true`. It also auto-expires after `ttlMs` (default 120s; `0` = unbounded).
- `replayPure` runs in the **Node executor process** — no window, no document, no page network. Pass what the function needs via `args` / `bindings`. `console` is **virtualised**, not blocked: logging code replays fine and the calls come back in `logs`. Refusals split offenders into `admissible` (supply via `bindings`) and `categoricallyUnsafe` (nothing here can supply them honestly), each with a source position.
- **`fiberDiff` only sees handler churn when both snapshots were taken with `identity: true`.** Without it every function serialises to `[function]` and two different arrows compare equal. With it, `identityChangedKeys` is the list of deep-equal-but-new-reference props — the ones that defeat `React.memo`. A comparison it could not make lands in `unobservableKeys`, never in `unchangedKeys`.
- **Real limits of the static lane:** callee resolution leaves large **typed-unresolved buckets** — read `summary().unresolvedByReason` before concluding "nothing calls this". Escape analysis stays at **chain depth 0**: it sees `ref.push(x)` and `obj.x =`, not a value handed three functions deep. Async boundaries stop the slice by design.
- Don't create new sessions to "fix" a problem — reuse the same `-s` number.

## common mistakes to avoid

**1. Not verifying actions succeeded**
Always check page state after important actions (form submissions, uploads, typing). Your mental model can diverge from actual browser state:

```js
await state.page.keyboard.type('my text')
await snapshot({ page: state.page, search: /my text/ })
// If verifying visual layout specifically, use screenshotWithAccessibilityLabels instead
```

**2. Assuming paste/upload worked**
Clipboard paste (`Meta+v`) can silently fail. For file uploads, prefer file input:

```js
// Reliable: use file input
const fileInput = state.page.locator('input[type="file"]').first()
await fileInput.setInputFiles('/path/to/image.png')

// Unreliable: clipboard paste may silently fail, need to focus textarea first for example
await state.page.keyboard.press('Meta+v') // always verify with screenshot!
```

**3. Using stale locators from old snapshots**
Locators (especially ones with `>> nth=`) can change when the page updates. Always get a fresh snapshot before clicking, then immediately use locators from that output:

```js
await snapshot({ page: state.page, showDiffSinceLastCall: true })
// Now use the NEW locators from this output
```

**4. Wrong assumptions about current page/element**
Before destructive actions (delete, submit), verify you're targeting the right thing:

```js
// Before deleting, verify it's the right item
await screenshotWithAccessibilityLabels({ page: state.page })
// READ the screenshot to confirm, THEN proceed with delete
```

**5. Text concatenation without line breaks**
`keyboard.type()` doesn't insert newlines from `\n` in strings. Use `keyboard.press('Enter')` between lines:

```js
await state.page.keyboard.type('Line 1')
await state.page.keyboard.press('Enter')
await state.page.keyboard.type('Line 2')
```

**6. Quote escaping in bash**
Bash parses `$`, backticks, and `\` inside double-quoted strings. This silently corrupts JS code. Always use single quotes or heredoc:

```bash
# single quotes — bash passes everything through literally
playwriter -s 1 -e 'await state.page.locator(`[id="_r_a_"]`).click()'

# heredoc for complex code with mixed quotes
playwriter -s 1 -e "$(cat <<'EOF'
await state.page.locator('[id="_r_a_"]').click()
const match = html.match(/\$[\d.]+/g)
EOF
)"
```

**7. Using screenshots when snapshots suffice**
Screenshots + image analysis is expensive and slow. Only use screenshots for visual/CSS issues. Use snapshot for text checks:

```js
await snapshot({ page: state.page, search: /expected text/i })
```

**8. Assuming page content loaded**
Even after `goto()`, dynamic content may not be ready:

```js
await state.page.goto('https://example.com')
// Content may still be loading via JavaScript!
await state.page.waitForSelector('article', { timeout: 10000 })
// Or use waitForPageLoad utility
await waitForPageLoad({ page: state.page, timeout: 5000 })
```

**9. Not using playwriter for JS-rendered sites**
Do NOT waste context trying webfetch, curl, or Playwright CLI screenshots on SPAs (Instagram, Twitter, etc.). These return empty HTML shells. Use playwriter directly:

```js
state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage())
await state.page.goto('https://www.instagram.com/p/ABC123/', { waitUntil: 'domcontentloaded' })
await waitForPageLoad({ page: state.page, timeout: 8000 })
await snapshot({ page: state.page, search: /cookie|consent|accept/i }).then(console.log)
```

**10. Login buttons that open popups**
Popup windows (`window.open` with features, OAuth buttons) are auto-relocated to tabs in the main window by the Playwriter extension. The new tab appears in `context.pages()` and is fully controllable. You will receive a `[WARNING] New page opened from current page (index N, initial url: ...)` message pointing to the new tab — the `initial url` may be `about:blank` for blank-then-scripted popups, so check `context.pages()[N].url()` for the final URL:

```js
await state.page.locator('button:has-text("Login with Google")').click()
await state.page.waitForTimeout(1000)

// New tab is the last page in the context
const pages = context.pages()
const loginPage = pages[pages.length - 1]

// Complete login flow in loginPage, cookies are shared with original page
await loginPage.locator('[data-email]').first().click()
await loginPage.waitForURL('**/callback**')
// Original page should now be authenticated
```

**11. Click times out or does nothing — ask what is on top, don't guess**
When a click times out, a **modal or overlay** is likely intercepting pointer events. Do not retry with different selectors or `{ force: true }` — name the blocker:

```js
// click timed out → whyOccluded names the covering nodes AND hit-tests the box centre
const why = await whyOccluded({ locator: state.page.locator('button:has-text("Submit")') })
console.log(why.text)
// why.hitTest.label is what a click actually lands on; why.occludedByLabels is the inference
await snapshot({ page: state.page, search: /dialog|modal/i })  // then interact with the blocker properly
await state.page.getByRole('radio', { name: 'Nope, Vanilla' }).click()
```

**12. Never use `dispatchEvent` or `{ force: true }` to bypass blockers**
`dispatchEvent(new MouseEvent(...))`, `{ force: true }`, and `element.click()` inside `page.evaluate()` bypass Playwright checks but **do not trigger React/Vue/Svelte handlers** — state won't update. Use snapshot to find the real interactive element:

```js
await state.page.getByRole('radio', { name: 'Node.js' }).click()
```

**13. Over-investigating instead of just interacting**
When something doesn't respond to a click, do NOT start hand-walking CDP event listeners, reading canvas pixel data, or writing `page.evaluate()` to dump class names and bounding boxes. That wastes massive context. (If the question genuinely is "what props did React render here", use `fiberSnapshot({ locator })` or a `pm.anchor` handle's `reactFiber()` — those are cheap and token-capped. What is wasteful is reconstructing them by hand.) Instead:

1. Take a `snapshot()` — it shows every interactive element and what to click
2. Try a different interaction pattern if `click()` didn't work:
   - **Drawing/annotation tools, canvas paint** → `mouse.down`, move with steps, `mouse.up` (see drag section)
   - **Keyboard-activated modes** → press the shortcut key (snapshot shows tooltip text like "Draw mode D")
   - **Sliders, timeline scrubbers** → drag pattern
   - **Collapsed/toggled toolbars** → click the toggle first, wait, then interact
3. Take another `snapshot()` to see what changed
4. Only investigate DOM internals if correct interaction patterns produce zero response after 2–3 attempts

**14. Asserting about CSS, React, or source code instead of running the tool that knows**
Each of these is a guess you can replace with an answer (see "reading a page: pick the narrowest tool"):

- Never claim "that `!important` is overriding it", or compute specificity in your head. `debugStyle` returns the winning declaration **plus every overridden loser** with `file:line`, using real specificity (`:where()` counts 0; `:not/:is/:has` take their argument's maximum) and the full origin/importance ordering.
- Never trust a `const`. A hop tagged `hazards: ['aliasing']` means the binding is constant but its value is mutated in place (`ref.push()`, `Object.assign(ref, …)`, `ref.x =`) — "it's a const, so it can't have changed" is exactly the reasoning that tag exists to break. `inspectBinding({ file, graph, name })` answers this for any binding in one call.
- Never conclude "nothing is wrong with the store" without checking `measured` — and never conclude "nothing is covering it" from a `whyOccluded` whose `measured` is `false` or whose `shapeDistortingProps` is non-empty. In both cases the honest reading is *unknown*, not *clear*.
- Never conclude "this hook's deps are fine" by eye. `findMissingDeps({ file, graph })` scans every reactive hook in the file and returns the missing reactive values with code frames.

## accessibility snapshots

```js
await snapshot({ page: state.page, search?, showDiffSinceLastCall?, interactiveOnly? })
```

For the same tree fused with tags, attributes, and React/CSS edges — and with new nodes marked — use `pm.renderText({ page: state.page })` or `pm.query` instead (see "reading a page: pick the narrowest tool").

- `search` - string/regex to filter results (returns first 10 matching lines)
- `showDiffSinceLastCall` - returns diff since last snapshot (default: `true`, but `false` when `search` is provided). Pass `false` to get full snapshot.
- `interactiveOnly` - **default `false`**: the whole accessible tree, because a snapshot is usually read to find out what is *on* the page. Pass `true` for only the elements you can act on. Note `screenshotWithAccessibilityLabels` defaults this the other way (`true`) — a label overlay exists to find click targets, so labelling every static node is clutter.
- `frame` / `locator` - scope the snapshot to an iframe or a subtree (see below).

Snapshots return full content on first call, then diffs on subsequent calls. Diff is only returned when shorter than full content. If nothing changed, returns "No changes since last snapshot" message. Use `showDiffSinceLastCall: false` to always get full content. When `search` is provided, diffing is disabled by default so the search filters the full content — pass `showDiffSinceLastCall: true` explicitly to combine both. This diffing behavior also applies to `getCleanHTML` and `getPageMarkdown`.

Example output:

```md
- banner:
  - link "Home" [id="nav-home"]
  - navigation:
    - link "Docs" [data-testid="docs-link"]
    - link "Blog" role=link[name="Blog"]
```

Each interactive line ends with a Playwright locator you can pass to `state.page.locator()`.
If multiple elements share the same locator, a `>> nth=N` suffix is added (0-based)
to make it unique.

**Use snapshot locators directly — never invent selectors.** The snapshot output IS the selector. Do not guess CSS selectors or `getByText` when the snapshot already gives you the exact match:

```js
// Snapshot shows: role=radio[name="Nope, Vanilla"]  →  use it directly
await state.page.getByRole('radio', { name: 'Nope, Vanilla' }).click()
// Snapshot shows: role=link[name="SIGN IN"]  →  or pass raw string to locator()
await state.page.locator('role=link[name="SIGN IN"]').click()
```

**Beware CSS text-transform**: snapshots show visual text (`heading "NODE.JS"`) but DOM may be `"Node.js"`. Use case-insensitive regex: `getByRole('heading', { name: /node\.js/i })`.

If a screenshot shows ref labels like `e3`, resolve them using the last snapshot:

```js
const snap = await snapshot({ page: state.page })
const locator = refToLocator({ ref: 'e3', page: state.page })
if (!locator) throw new Error('ref e3 is not in the last snapshot for this page')
await state.page.locator(locator).click()
```

`refToLocator` returns `null` when the ref is not in this page's most recent snapshot — check it. The sandbox is plain JavaScript, so a TypeScript non-null assertion (`locator!`) is a **SyntaxError** that fails the whole call before anything runs.

Search for specific elements:

```js
const snap = await snapshot({ page: state.page, search: /button|submit/i })
```

**Scoping snapshots to a specific element** — pass a `locator` instead of `page` to snapshot only a subtree. This dramatically reduces output size when you only care about one section of the page (e.g., the main content area, ignoring the sidebar/header/footer):

```js
// Full page snapshot: ~150 lines (sidebar, nav, header, footer, everything)
await snapshot({ page: state.page })

// Scoped to main: ~20 lines (just the content you care about)
await snapshot({ locator: state.page.locator('main') })

// Scope to a specific form, dialog, or section
await snapshot({ locator: state.page.locator('[role="dialog"]') })
await snapshot({ locator: state.page.locator('form#checkout') })
```

Use this whenever the full page snapshot is dominated by navigation or layout elements you don't need. It saves significant tokens and makes the output much easier to parse.

**Filtering large snapshots in JS** — when `search` isn't enough, filter the string directly: `snap.split('\n').filter(l => l.includes('dialog') || l.includes('error')).join('\n')`

## choosing between snapshot methods

Use `snapshot` for text-heavy pages (forms, articles) — fast, cheap, searchable. Use `screenshotWithAccessibilityLabels` for complex visual layouts (grids, galleries, dashboards) where spatial position matters. Both share the same ref system and can be combined.

## selector best practices

**For unknown websites**: use `snapshot()` - it shows what's actually interactive with stable locators. `pm.query({ page: state.page, select: 'Interactive' })` emits those same locators as data rows, so you can filter them in JS instead of eyeballing the tree.

**For development** (when you have source code access), prefer stable selectors in this order:

1. **Best**: `[data-testid="submit"]` - explicit test attributes, never change accidentally
2. **Good**: `getByRole('button', { name: 'Save' })` - accessible, semantic
3. **Good**: `getByText('Sign in')`, `getByLabel('Email')` - readable, user-facing
4. **OK**: `input[name="email"]`, `button[type="submit"]` - semantic HTML
5. **Avoid**: `.btn-primary`, `#submit` - classes/IDs change frequently
6. **Last resort**: `div.container > form > button` - fragile, breaks easily

Combine locators for precision:

```js
state.page.locator('tr').filter({ hasText: 'John' }).locator('button').click()
state.page.locator('button').nth(2).click()
```

If a locator matches multiple elements, Playwright throws "strict mode violation". Use `.first()`, `.last()`, or `.nth(n)`:

```js
await state.page.locator('button').first().click() // first match
await state.page.locator('.item').last().click() // last match
await state.page.locator('li').nth(3).click() // 4th item (0-indexed)
```

## working with pages

**Tabs are isolated per git worktree.** `context.pages()` returns only the tabs that belong to **your workspace** — identified by your git worktree. Playwriter gives each worktree its own tabs in its own distinctly colored tab group and auto-creates that first tab for you, so there's no extension click to set up. A session can never see or drive tabs belonging to a different worktree. Two sessions in the *same* worktree deliberately share one tab group and see the same tabs; to avoid stepping on each other, **store your working page in `state.page` and reuse it**.

**Get or create your page (first call):**

On your very first execute call, reuse the auto-created blank tab or open a new one. Store it in `state` and use `state.page` for all subsequent operations instead of the default `page` variable:

```js
// Reuse the auto-created blank tab if available, otherwise create a new one.
state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage())
await state.page.goto('https://example.com')
// Use state.page for ALL subsequent operations
```

**Handle page closures gracefully:**

The user may close your page by accident (e.g., closing a tab in Chrome). Always check before using it and recreate if needed:

```js
if (!state.page || state.page.isClosed()) {
  state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage())
}
await state.page.goto('https://example.com')
```

**Use an existing page only when the user asks:**

Only use a page from `context.pages()` if the user explicitly asks you to control a specific tab. `context.pages()` only lists tabs in **your** workspace — a tab the user put into the shared **freestyle** group by clicking the extension icon carries no worktree ownership, is never agent-targetable, and will not appear here. Find the tab by URL pattern and store it in state:

```js
const pages = context.pages().filter((x) => x.url().includes('myapp.com'))
if (pages.length === 0) throw new Error('No myapp.com page found in your workspace')
if (pages.length > 1) throw new Error(`Found ${pages.length} matching pages, expected 1`)
state.targetPage = pages[0]
```

**List all available pages:**

```js
context.pages().map((p) => p.url())
```

**Popup windows become tabs automatically:**

The extension intercepts Chrome popup windows (`window.open(url, '', 'width=...')`, OAuth login flows) and relocates them into the main window as regular tabs. You don't need cmd+click or `{ modifiers: ['Meta'] }` to avoid popups. When a page opens another, you receive a `[WARNING] New page opened from current page (index N, initial url: ...)` and can access it via `context.pages()[N]`.

## navigation

**Use `domcontentloaded`** for `page.goto()`:

```js
await state.page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
await waitForPageLoad({ page: state.page, timeout: 5000 })
```

## common patterns

**Authenticated fetches** - fetch from within page context to include session cookies automatically:

```js
const data = await state.page.evaluate(async (url) => {
  const resp = await fetch(url)
  return await resp.text()
}, 'https://example.com/protected/resource')
```

**Read page cookies via CDP** - use `Network.getCookies` on the page CDP session:

```js
const cdp = await getCDPSession({ page: state.page })
const { cookies } = await cdp.send('Network.getCookies', { urls: [state.page.url()] })
console.log(cookies)
```

MUST use this for page-scoped cookies in extension mode. `Storage.getCookies` is a root-session command and will fail in playwriter.

**NEVER use `Network.clearBrowserCookies` or `Network.clearBrowserCache`** — these CDP commands are **profile-wide destructive operations** that wipe ALL cookies/cache across every domain in the user's Chrome profile. They will log the user out of Gmail, GitHub, and every authenticated session.

**Clear cookies for a specific domain** — use `Network.getCookies` to fetch cookies scoped to URLs, then delete them individually with `Network.deleteCookies`:

```js
const cdp = await getCDPSession({ page: state.page })
const { cookies } = await cdp.send('Network.getCookies', {
  urls: ['https://example.com', 'https://www.example.com'],
})
for (const cookie of cookies) {
  await cdp.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain })
}
```

**Downloading large data** - console output truncates large strings. Trigger a browser download instead:

```js
// Fetch protected data and trigger download to user's Downloads folder
await state.page.evaluate(async (url) => {
  const resp = await fetch(url)
  const data = await resp.text()
  const blob = new Blob([data], { type: 'application/octet-stream' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'data.json'
  a.click()
}, 'https://example.com/protected/large-file')
// File saves to ~/Downloads - read it from there
```

**Avoid permission-gated browser APIs** - some APIs require user permission prompts or special browser flags. These often fail silently or hang. Examples to avoid:

- `navigator.clipboard.writeText()` - requires permission
- Multiple concurrent downloads - browser may block
- `window.showSaveFilePicker()` - requires user gesture
- Geolocation, camera, microphone APIs

Instead, use simpler alternatives (single download via `a.click()`, store data in `state`, etc).

**Downloads** - capture and save:

```js
const [download] = await Promise.all([state.page.waitForEvent('download'), state.page.click('button.download')])
await download.saveAs(`/absolute/path/${download.suggestedFilename()}`)
```

**iFrames** - two approaches depending on what you need:

```js
// frameLocator: for chaining locator operations (click, fill, etc.)
const frame = state.page.frameLocator('#my-iframe')
await frame.locator('button').click()

// contentFrame: returns a Frame object, needed for snapshot({ frame })
const frame2 = await state.page.locator('iframe').contentFrame()
await snapshot({ frame: frame2 })
```

**Dialogs** - handle alerts/confirms/prompts:

```js
state.page.on('dialog', async (dialog) => {
  console.log(dialog.message())
  await dialog.accept()
})
await state.page.click('button.trigger-alert')
```

**Handling page obstacles (cookie modals, login walls, age gates)** - most major websites show blocking overlays. Always check for these with `snapshot()` right after navigation and dismiss them before doing anything else:

```js
// After navigating, check for common obstacles
await waitForPageLoad({ page: state.page, timeout: 5000 })
const snap = await snapshot({
  page: state.page,
  search: /cookie|consent|accept|reject|decline|allow|age|verify|login|sign.in/i,
})
console.log(snap)
// Look for dismiss/accept/decline buttons in the snapshot, then click them:
// await state.page.locator('button:has-text("Accept")').click();
// await state.page.locator('button:has-text("Decline optional")').click();
// Then re-snapshot to confirm the modal is gone before proceeding
```

If the page requires login and the user is already logged into Chrome, their session cookies are available — just navigate and the page should load authenticated. If not, ask the user for help or use their existing logged-in tab via `context.pages()`.

**Extracting and downloading media (images, videos)** - use `page.evaluate()` to extract URLs from the rendered DOM, then download via Node.js in the sandbox. This is far more reliable than parsing raw HTML:

`page.evaluate` is right here for one specific reason: `naturalWidth` (like `videoWidth` and `scrollHeight`) is a live media property the page model does not carry. Drop the size field and this becomes `pm.query({ page: state.page, roles: ['image'], fields: ['attributes.src', 'attributes.alt'] })` — if you are only pulling attributes, switch.

```js
// Extract all image URLs from rendered DOM
const images = await state.page.evaluate(() =>
  Array.from(document.querySelectorAll('img[src]')).map((img) => ({
    src: img.src,
    alt: img.alt,
    width: img.naturalWidth,
  })),
)
console.log(JSON.stringify(images, null, 2))

// Download a specific image to disk
const fs = require('node:fs')
const resp = await fetch(images[0].src)
const buf = Buffer.from(await resp.arrayBuffer())
fs.writeFileSync('./downloaded-image.jpg', buf)
console.log('Saved', buf.length, 'bytes')
```

For carousels or lazy-loaded galleries, you may need to click navigation arrows or scroll first, then re-extract. Use network interception (see "network interception" section) to capture high-resolution CDN URLs that may differ from the `img.src` thumbnails.

## utility functions

**getLatestLogs** - retrieve captured browser console logs and page errors (up to 5000 per page):

Always use this helper when inspecting browser logs. Do not attach new `page.on('console')` listeners for debugging because they only see future events and can miss logs emitted during page startup or hydration.

Use `sinceLastCall: true` after every action to get only new logs since the previous call. The first call returns all buffered logs including pre-existing ones. Logs persist across navigations so you never miss errors from page transitions.

```js
await getLatestLogs({ page?, count?, search?, sinceLastCall? })
// After every action: get only new logs
const newLogs = await getLatestLogs({ page: state.page, sinceLastCall: true })
// Search all logs (ignores cursor):
const errors = await getLatestLogs({ search: /error/i, count: 50 })
const pageLogs = await getLatestLogs({ page: state.page, count: 100 })
const hydrationErrors = await getLatestLogs({ page: state.page, search: /hydration|pageerror|React/i })
```

**clearAllLogs** - drop every buffered log line and reset every `sinceLastCall` cursor, for **all** pages in the session. There is no per-page form. Use it to get a clean baseline before a repro; after it, the next `sinceLastCall: true` returns only what happened next.

```js
clearAllLogs()
await state.page.click('button')
console.log(await getLatestLogs({ page: state.page, sinceLastCall: true }))  // just this action's logs
```

Three readers below (`getCleanHTML`, `getPageMarkdown`, and `snapshot`) share the same two options: `search` (string/regex — returns the first 10 matching lines with 5 lines of context) and `showDiffSinceLastCall` (default `true`, forced `false` when `search` is given; pass `false` for the full text).

**getCleanHTML** - get cleaned HTML from a locator or page:

```js
await getCleanHTML({ locator, search?, showDiffSinceLastCall?, includeStyles?, maxAttrLen?, maxContentLen? })
// Examples:
const html = await getCleanHTML({ locator: state.page.locator('body') })
const html = await getCleanHTML({ locator: state.page, search: /button/i })
const fullHtml = await getCleanHTML({ locator: state.page, showDiffSinceLastCall: false })  // disable diff
const wide = await getCleanHTML({ locator: state.page, maxAttrLen: 500, maxContentLen: 2000 })
```

`includeStyles` keeps style and class attributes (default false). Cleans HTML automatically: removes script/style/svg/head tags, unwraps empty wrappers, removes empty elements, truncates long values. Keeps semantic attributes (`href`, `name`, `type`, `aria-*`, `data-*`).

**The truncation is real and it is capped by default**: attribute values are cut at `maxAttrLen` (**200** chars) and text content at `maxContentLen` (**500**). A long `data-*` payload or a paragraph past those limits comes back cut, so raise them before concluding the page does not contain something.

**getPageMarkdown** - extract main page content as plain text using Mozilla Readability (same algorithm as Firefox Reader View). Strips navigation, ads, sidebars, and other clutter. Returns formatted text with title, author, and content:

```js
await getPageMarkdown({ page: state.page, search?, showDiffSinceLastCall? })
// Examples:
const content = await getPageMarkdown({ page: state.page, showDiffSinceLastCall: false })  // full article
const matches = await getPageMarkdown({ page: state.page, search: /API/i })  // search within content
```

Output is a title line, an `Author | Site | Published` line, the excerpt as a blockquote, then the article text.

**waitForPageLoad** - smart load detection that ignores analytics/ads:

```js
await waitForPageLoad({ page: state.page, timeout?, pollInterval?, minWait? })
// Returns: { success, readyState, pendingRequests, waitTimeMs, timedOut }
```

**getCDPSession** - send raw CDP commands:

```js
const cdp = await getCDPSession({ page: state.page })
const metrics = await cdp.send('Page.getLayoutMetrics')
```

**getLocatorStringForElement** - get stable Playwright selector from an element:

```js
const selector = await getLocatorStringForElement(state.page.locator('[id="submit-btn"]'))
// => "getByRole('button', { name: 'Save' })"
```

**getReactSource** - get React component source location (dev mode only):

```js
const source = await getReactSource({ locator: state.page.locator('[data-testid="submit-btn"]') })
// => { fileName, lineNumber, columnNumber, componentName }
```

**getReactComponentInfo** - get best-effort React component info for an element. Returns `null` for non-React elements and never throws just because an element was not rendered by React. Source locations are usually only available in React dev builds. Props are sanitized and truncated so functions, DOM nodes, circular refs, and huge objects do not flood the output.

`fiberSnapshot({ locator })` is the same call under its trace-lane name — but `fiberSnapshot({ locator, identity: true })` is **not**: it returns a different shape carrying page-side identity tokens for every object/function prop, which is the only way `fiberDiff` can see handler churn. Use `getReactComponentInfo` to read props once; use `fiberSnapshot({ identity: true })` when you are going to diff two of them.

```js
const info = await getReactComponentInfo({ locator: state.page.locator('[data-testid="submit-btn"]') })
// => { componentName, source, hierarchy, props } | null
```

**inspectPinnedElement** - inspect a Playwriter pinned element and print the element `outerHTML` plus React component info when available. Used by the in-page toolbar and right-click copy flow.

```js
await inspectPinnedElement('https://example.com', 'globalThis.playwriterPinnedElem1')
```

**getStylesForLocator** - raw DevTools-style listing of every matching rule (selector, source `file:line`, declarations, inherited styles). For "why is this property THIS value", prefer `debugStyle` — it resolves the cascade and names the winner plus every overridden loser. Reach for this when you want the unresolved rule list. Full reference: `https://playwriter.dev/resources/styles-api.md`.

```js
const styles = await getStylesForLocator({ locator: state.page.locator('.btn') })
console.log(formatStylesAsText(styles))

// Include the browser's own default rules — off by default, and usually noise.
const withDefaults = await getStylesForLocator({
  locator: state.page.locator('input[type="text"]'),
  includeUserAgentStyles: true,
})

// Reuse a session you already have. Optional: one is opened for the locator's page
// when you omit it, so passing it only saves a round-trip.
const cdp = await getCDPSession({ page: state.page })
const again = await getStylesForLocator({ locator: state.page.locator('.btn'), cdp })
```

**createDebugger** - set breakpoints, step through code, inspect variables at runtime. Useful for debugging issues that only reproduce in browser, understanding code flow, and inspecting state at specific points. Can pause on exceptions, evaluate expressions in scope, and blackbox framework code. ALWAYS fetch `https://playwriter.dev/resources/debugger-api.md` first.

```js
const cdp = await getCDPSession({ page: state.page })
const dbg = createDebugger({ cdp })
await dbg.enable()
const scripts = await dbg.listScripts({ search: 'app' })
await dbg.setBreakpoint({ file: scripts[0].url, line: 42 })
// when paused: dbg.inspectLocalVariables(), dbg.stepOver(), dbg.resume()
```

**createEditor** - view and live-edit page scripts and CSS at runtime. Edits are in-memory (persist until reload). Useful for testing quick fixes, searching page scripts with grep, and toggling debug flags. ALWAYS read `https://playwriter.dev/resources/editor-api.md` first.

```js
const cdp = await getCDPSession({ page: state.page })
const editor = createEditor({ cdp })
await editor.enable()
const matches = await editor.grep({ regex: /console\.log/ })
await editor.edit({ url: matches[0].url, oldString: 'DEBUG = false', newString: 'DEBUG = true' })
```

**screenshotWithAccessibilityLabels** - take a screenshot with Vimium-style visual labels overlaid on interactive elements. Shows labels, captures screenshot, then removes labels. The image and accessibility snapshot are automatically included in the response. Can be called multiple times to capture multiple screenshots. Use a timeout of **20 seconds** for complex pages.

This is only for **finding interactive elements** on the page. To share a screenshot with the user or save an image, use `page.screenshot()` + `resizeImageForAgent()` instead (see "taking screenshots" section below).

Prefer this for pages with grids, image galleries, maps, or complex visual layouts where spatial position matters. For simple text-heavy pages, `snapshot` with search is faster and uses fewer tokens.

```js
await screenshotWithAccessibilityLabels({ page: state.page })
// Image and accessibility snapshot are automatically included in response
// Use refs from snapshot to interact with elements
await state.page.locator('[id="submit-btn"]').click()

// Scope it to a subtree — same idea as snapshot({ locator }), and the same saving:
// only that region is labelled, so the labels stay legible on a busy page.
await screenshotWithAccessibilityLabels({ page: state.page, locator: state.page.locator('[role="dialog"]') })

// Label EVERY node, not just the interactive ones (default: interactiveOnly true).
await screenshotWithAccessibilityLabels({ page: state.page, interactiveOnly: false })

// Can take multiple screenshots in one execution
await screenshotWithAccessibilityLabels({ page: state.page })
await state.page.click('button')
await screenshotWithAccessibilityLabels({ page: state.page })
// Both images are included in the response
```

Labels are colour-coded by role (links, buttons, inputs, checkboxes, sliders, menus, tabs).

**resizeImageForAgent** - shrink an image so it consumes fewer tokens when read back into context. The resized image is automatically included in the response (visible to the LLM). `await resizeImageForAgent({ input: '/absolute/path/to/screenshot.png' })`. Also accepts `width`, `height`, `maxDimension` (default 1568 — Claude re-scales anything larger anyway), `quality` (80), `format` (default: `'png'`), `fit`, `output`. Alias: `resizeImage`.

`fit` decides what happens when you give **both** `width` and `height` and they disagree with the source aspect ratio: `'inside'` (default) preserves the ratio and fits within the box, `'cover'` fills the box and crops, `'contain'` pads, `'fill'` stretches. With only one dimension the ratio is preserved and `fit` does nothing.

**recording.start / recording.stop** - record the page as a video at native FPS (30-60fps). Uses `chrome.tabCapture` so **recording survives page navigation**. Auto-overlays a ghost cursor that follows mouse actions. Requires user to have clicked the Playwriter extension icon on the tab. Auto-resizes viewport to 16:9 (override with `aspectRatio: null`). Auto-stops after 15 min (override with `maxDurationMs`).

For demos, use interaction methods (`locator.click()`, `page.mouse.move()`) instead of `goto()` to show realistic cursor motion.

```js
await recording.start({
  page: state.page,
  outputPath: '/absolute/path/to/recording.mp4',
  frameRate: 30, // default
  audio: false, // default (tab audio)
  videoBitsPerSecond: 2500000,
  aspectRatio: { width: 16, height: 9 }, // default, set null to skip
  maxDurationMs: 15 * 60 * 1000, // default, set 0 to disable
})

// Recording survives navigation
await state.page.click('a')
await state.page.waitForLoadState('domcontentloaded')

// Stop — save full result including executionTimestamps for createDemoVideo
state.recordingResult = await recording.stop({ page: state.page })

// Other: recording.isRecording({ page }), recording.cancel({ page })
```

**recording.startCdp / recording.stopCdp / recording.cancelCdp** — gesture-free recorder. **No extension-icon click, no CLI flag, no separate Chrome.** Works on a normal extension-connected session and over direct CDP.

```js
await recording.startCdp({ outputPath: '/abs/path/bug.mp4', fps: 8, quality: 55 })
// ...reproduce the bug, one action per call...
recording.frameCount()                // is it actually capturing? check BEFORE you stop
const r = await recording.stopCdp()   // { outputPath, frames, durationMs, mode, wrote }
```

**Defaults, and the two that stop the recording on their own.** `fps` **10**, `quality` **70** (JPEG), `probeMs` **1500**, `mode` `'auto'`. The examples here pass `fps: 8, quality: 55` because a smaller file is usually the better trade for a bug repro — they are choices, not the defaults. Two limits end a recording without being asked: `maxDurationMs` (**10 minutes** — half the tabCapture recorder's 15) and `maxFrames` (**5000**, ≈165MB retained). Both are a hard stop, not a warning, so a long unattended repro needs them raised explicitly. `maxWidth` / `maxHeight` cap the captured frame size (Chrome scales to fit) and are unset by default, i.e. full viewport. `inputEvents: [{ action, atMs }]` seeds the input overlay with events known up front, exactly as `captions` seeds the caption track.

`recording.frameCount()` returns what the recorder has captured so far, so `frames: 0` — the change-driven-screencast failure below — is catchable while you can still do something about it. It throws when no `startCdp` recording is running, like every other member of this group.

**Never call `bringToFront()` for a recording — but know that the recorder sometimes calls it for you.** The two capture paths differ completely here, and the difference decides which mode you should ask for.

`screencast` does not need a foreground tab. Measured through the extension on a backgrounded tab: 31 frames against 30 on a foreground one; re-measured over raw CDP on Chrome for Testing 148 with two real tabs in one window, **60.0 fps hidden against 59.8 fps foreground**. Record a tab the user is not looking at.

`screenshot` does need one, and this was measured on the same rig — a 10fps poll, three runs of a 38-second hidden window:

| | foreground | tab hidden behind another | after `bringToFront` |
|---|---|---|---|
| frames captured per second | 9.95–9.97 | **0.08–0.18** | 9.95–9.96 |
| longest gap between frames | 116–129ms | **17.7–26.0s** | 118–134ms |

It never errors and it never returns a stale frame — every attempt eventually came back, and a change made from outside while the tab was hidden appeared in the next frame to complete, 25–55ms later. It simply *blocks*, for up to 26 seconds at a time, which for a serialised poller is a 26-second hole in the video.

So the recorder foregrounds the tab itself before screenshot polling: **`mode: 'screenshot'` always, and `mode: 'auto'` — the default — the moment it falls back**, which is precisely the static-page case `auto` exists to handle. If a recording must not steal the user's focus, pass `mode: 'screencast'`: it never foregrounds and captures a hidden tab at full rate, at the cost of capturing almost nothing from a page that never repaints.

If a recording comes back with `frames: 0`, the cause is almost always that **`screencast` is change-driven**: a page that never repaints sends nothing. That is what `mode: 'auto'` handles by falling back to screenshot polling. Check `mode` and `frames` on the result rather than assuming a focus problem.

Two capture paths, selected automatically (`mode: 'auto'` by default, reported back on the result):

| | `screencast` | `screenshot` |
|---|---|---|
| Source | `Page.startScreencast` | polls `Page.captureScreenshot` |
| Rate | change-driven (frame per repaint) — measured 177 frames in 3s on an animating page | ~8.5fps through the extension, 15.3fps over direct CDP (measured) |
| Static page | yields ~nothing (measured: 1 frame in 3s over direct CDP; 0 through the extension) | still captures |
| Backgrounded tab | full rate, no foregrounding (measured 60fps hidden) | ~0.1fps with captures blocking up to 26s — **so this path calls `bringToFront()`** |

`'auto'` starts with screencast and falls back to screenshot polling if no frame arrives within `probeMs` (1500ms), which covers a page that simply never repaints. Force one with `mode: 'screencast' | 'screenshot'`. Remember that falling back foregrounds the tab, so `'auto'` on a static page is a mode that steals focus.

**recording.caption / recording.clearCaption** — narrate the clip so a human can follow a repro without you there. `caption(text)` stamps at call time and stays up until the next caption; `clearCaption()` blanks it. Burned into the pixels by default, because GitHub comments, Slack previews and bare `<video>` tags never show a soft subtitle track. Throws if no `startCdp` recording is running.

```js
await recording.startCdp({ outputPath: '/abs/path/cart-badge-bug.mp4', fps: 8 })
recording.caption('1. Cart holds 3 items, badge reads 3')
await state.page.goto('https://shop.test/cart')
await recording.hold()                     // let the beat be readable — see pacing below
recording.caption('2. Remove every item')
for (const b of await state.page.getByRole('button', { name: 'Remove' }).all()) await b.click()
await recording.hold()
recording.caption('3. BUG: cart is empty, badge still reads 3')
await recording.hold()
recording.clearCaption()
await recording.hold({ minMs: 3000 })      // the broken state, alone, long enough to see
const r = await recording.stopCdp()
```

**Pace it for a human, or the clip is worthless.** These videos are watched, not parsed. A caption has to sit on screen long enough to read *and* leave time to look at the page and see what changed — roughly **2–3 seconds per beat**, and the final broken state needs **3+ seconds on screen alone** (after `clearCaption()`) before `stopCdp`. **A 3-beat repro is a 12–25 second video.** One that comes out at 2 seconds is unreadable and also loses content: chips and cues that share a repaint gap get dropped, so the too-fast clip is missing beats as well as unreadable.

**`recording.hold()`** is how you pace it without guessing. It waits out whatever is left of the *current caption's* reading time — derived from the text (~17 characters/second plus 0.6s to look at the page), minus the time the action you just ran already took. Reword the caption longer and the pause grows with it; a hard-coded `waitForTimeout` does neither. `hold({ minMs })` sets a floor, `hold({ extraMs })` adds to whatever it computed.

**The derived time is clamped to 1.2s–7s, and the ceiling is not a rounding detail.** Past 7 seconds a viewer re-reads the cue instead of watching the page, so a cue that would need longer is a cue that should be **split in two** — rewording it longer stops buying you time at that point. The floor matters in the other direction: with **nothing captioned** (after `clearCaption()`) and no `minMs`, `hold()` still waits the 1.2s floor, not 0. That is deliberate — a blank final frame flashing past is not a final state — but it means `hold()` alone is nowhere near the 3+ seconds the broken state needs. Say `hold({ minMs: 3000 })`. The returned `HoldResult` reports exactly what happened: `waitedMs`, `readableMs` (0 when nothing was captioned), `onScreenMs`, `heldForMs`, and a `note` explaining the floor when it applied.

**`stopCdp()` tells you if you got it wrong.** When any cue was on screen for less than its text needs, the result carries `captionPacingWarning` (prose, also leading `captionNote`) and `captionPacing` (`{ cues, cuesTooFast, narrationNeedsMs, videoDurationMs, shortfallMs, readingRateCps }`). **Read it before handing the file to anyone.** The only fix is to re-record with pauses — do not slow the video down or stretch frame timing, because in a bug repro the timing between frames is the evidence.

`stopCdp()` also adds `captions[]` (resolved cues in VIDEO time), `videoStartOffsetMs`, `videoDurationMs`, `captionRender`, `captionFiles`. **Video time 0 is the first repaint, not the recording start** — `videoStartOffsetMs` is the gap, and captions are shifted by it automatically. Any cue that was moved, shortened, truncated or dropped says so in its `adjustments` — including how many ms short of readable it was and what cut it off.

- `caption(text, { atMs, durationMs })` — `atMs` (ms from recording start) overrides the stamp time when you know the real instant; `durationMs` ends a cue early instead of running it to the next. Returns the stamp with the text as it will be wrapped.
- `startCdp({ captions: [{ text, atMs, durationMs? }] })` for a script known up front. Live captions merge into it.
- `captionOptions.render`: `'burn'` (default) | `'soft'` (mov_text track) | `'sidecar'` (`.srt` beside the mp4), or an array to combine. With `'sidecar'`, `sidecarFormats` picks the files (`['srt']` by default; `'vtt'` also available).
- `captionOptions` styling: `fontName` (`'DejaVu Sans'`), `fontSizePct` (5, floored at 16px), `textColor`, `outlineColor` (black by default, because it has to survive a white page), `outlineWidth`, `shadow` (1), `boxed`, `marginBottomPct` (6), `maxCharsPerLine` (42), `maxLines` (3).
- `captionOptions.backdrop` (**on by default**) draws a full-frame-width opaque band behind each cue, sized to that cue. It is not decoration: without it, overlay text lands beside page text and the composite reads as a word in NEITHER layer — measured on a dense page, a caption line ending in `charge` next to a surviving page `s` read as `charges`. The band leaves no page pixel on a caption's scanlines, so that cannot happen. `backdrop: false` hides nothing of the page and reinstates the defect; only turn it off if no page pixel may be covered.
- `captionOptions` pacing: `readingRateCps` (17; lower it for CJK), or `minDurationMs` to **replace** the reading model with one flat floor for every cue — it is not combined with the model, so a caller who genuinely wants 400ms cues gets them. `maxCaptions` refuses more than N cues, so a looping caller cannot grow the result unbounded.
- A caption can only show on a frame that exists. Two captions inside one repaint gap collapse to the later one, and the loser is reported as dropped — space narration across actions that actually change the page.

**Input overlay** (`inputOverlay: true`, off by default) — a small NohBoard-style strip of key/button chips burned into a corner, so a viewer sees *what you pressed*, not just what happened. Nothing else to wire: setting the option arms the capture for you.

```js
await recording.startCdp({
  outputPath: '/abs/path/shortcut-bug.mp4',
  mode: 'screenshot',            // strongly preferred with the overlay on — but it foregrounds the tab, see below
  inputOverlay: true,
})
await state.page.fill('#email', 'alice@example.com')   // chip: Fill ••••••
await state.page.keyboard.press('Control+A')           // chip: Ctrl+A
const r = await recording.stopCdp()                    // r.inputEvents[] in VIDEO time
```

- **Captures** every input this session drives through Playwright — `click`/`dblclick`/`hover`/`fill`/`type`/`press`/`check`/`selectOption`/`setInputFiles`/`focus` on `page`, `locator`, `frame` or `ElementHandle`, plus all of `page.keyboard.*` and `page.mouse.*`. A chip appears only when the action SUCCEEDS; one that timed out or threw gets none, because it never happened.
- **Does NOT capture**: a real human typing or clicking in the browser (nothing reaches this process); input the page synthesises itself (`el.dispatchEvent(new KeyboardEvent(…))`); raw `cdp.send('Input.dispatch…')`; and `page.mouse.move()`, which is movement, not a press — the ghost cursor already shows it.
- **Layout**: a single row in the **bottom-right**, lifted above the caption block. Bottom-right because page content is top- and left-anchored — a top-left overlay lands on the nav, the heading and the first form field. The lift is computed from the caption's real font size, margin and line count, so chips and captions can never overlap; `inputOverlayNote` says so if a giant caption forced a compromise.
- **Use `mode: 'screenshot'`, and know that it foregrounds the tab.** A burned overlay only exists on frames that exist, and typing into a field that renders nothing produces no screencast frame at all. The overlay compensates by forcing one `captureScreenshot` per event (`captureFrameOnEvent`, on by default, reported in `note`), but polling is what actually keeps the clip moving. The cost is that this mode calls `bringToFront()` once before polling — it has to, see the foreground table above. If the user must not lose focus, keep `mode: 'screencast'` and accept that chips land only on frames the page itself produced, plus the one forced per event.
- **Typed text is HIDDEN by default** — `fill`/`type`/`insertText` render as `Fill ••••••`, a fixed six dots, so not even the length leaks. `inputOverlayOptions.revealTypedText: true` shows it, and even then a target that looks like a secret (`#password`, `[name=otp]`, `#api_key`, …) stays masked. Every mask is named in that event's `adjustments`.
- **Rapid sequences**: consecutive single-character keys within `coalesceWindowMs` (400) merge into one chip (`abcdefghij`). Beyond that the row holds at most `maxVisible` (4) chips — fewer if they would not fit across the frame — and retires the oldest early. Chords are one chip (`Ctrl+Shift+K`), never three. A chip stays up `dwellMs` (1600) — less than a caption, because a key name is a glance and not prose. Four inputs in one beat (fill, fill, click, press) fit without shedding; cram in more and the retired chip's `adjustments` say whether anyone could have seen it.
- `stopCdp()` adds `inputEvents[]` — `{ index, kind, label, startMs, endMs, atMs, coalescedCount?, dropped?, adjustments[] }` — plus `inputOverlayNote`. Read `adjustments` for coalescing, truncation, redaction, early retirement and drops.
- `inputOverlayOptions`, complete with defaults: `position` (`'bottom-right'`), `layout` (`'row'`; `'stack'` puts one chip per line when labels are long), `fontName` (the caption font, so one recording reads as one thing), `fontSizePct` (2.4, against the caption's 5), `textColor` (`#FFFFFF`), `boxColor` (`#000000`), `boxOpacity` (0.65 — translucent so page content still shows through), `marginPct` (3), `dwellMs` (1600), `maxVisible` (4), `coalesceWindowMs` (400), `maxLabelChars` (26, then the chip is elided and says so in `adjustments`), `maxEvents` (300 — further events are **refused**, not silently dropped), `revealTypedText` (false), `captureFrameOnEvent` (true whenever the overlay is on and the path is screencast).
- The overlay is pixels only — there is no soft or sidecar form — so it needs an ffmpeg with libass regardless of `captionOptions.render`.

**When to use the other recorder instead:** `recording.start` (tabCapture) gives true compositor output at a higher, fixed frame rate and survives navigation. It needs one extension-icon click per tab, so prefer it when a human is present and picture quality matters; prefer `startCdp` when nothing can click.

**ghostCursor.show / ghostCursor.hide** - the ghost cursor overlay is always on: the extension injects it on every Playwriter-attached tab and it stays visible at the last spot Playwright clicked or moved. These methods only matter if you want to change the cursor style or temporarily hide it:

```js
await ghostCursor.show({ page: state.page, style: 'screenstudio' }) // 'minimal' (default), 'dot', 'screenstudio'
await ghostCursor.hide({ page: state.page }) // hide until next show() or hard navigation
```

## humanMouse — real human pointer motion (opt-in, off by default)

**This is a behaviour change, not a visual polish.** The ghost cursor draws an overlay; `humanMouse` moves the *actual* CDP pointer along a sampled trajectory. Every element between origin and target therefore receives real `mouseover` / `mouseenter` / `mousemove`. That can open dropdowns, fire tooltips, dismiss popovers, start hover-intent timers and change what the page does. It is more realistic **and** it is a genuine way to make a working automation start failing. Turn it on deliberately, per action, and read `crossed` when something moves that you did not expect.

Ordinary Playwright teleports: one `Input.dispatchMouseEvent` at the destination. Nothing in between is ever hovered.

```js
// One move. Returns the full accounting — never assume it went to plan.
const res = await humanMouse.moveTo({ page: state.page, locator: state.page.locator('#save'), reportCrossings: true })
console.log(res.plannedDurationMs, res.achievedDurationMs, res.durationDriftMs)
console.log(res.crossed?.map((c) => c.description))  // what the path actually hovered
console.log(res.warnings)                            // non-empty = something did not match the model

// Move + click. With a locator the press is delegated to locator.click(), so Playwright's
// actionability, hit-target interception and retry loop all still run.
await humanMouse.click({ page: state.page, locator: state.page.locator('#save') })

// Make every locator.click/dblclick/hover on THIS page take a human route first.
await humanMouse.enable({ page: state.page })
await state.page.locator('#save').click()   // human move, then the normal click
humanMouse.isEnabled({ page: state.page })  // → true. Synchronous, and per page
await humanMouse.disable({ page: state.page })

// Plan without moving — pure and deterministic, for assertions or inspection.
const plan = await humanMouse.plan({ page: state.page, x: 900, y: 500, seed: 42 })

// Where the driver believes the pointer is. `hover` is an alias of `moveTo` —
// with no button pressed, the move IS the hover.
const at = await humanMouse.position({ page: state.page })
await humanMouse.hover({ page: state.page, locator: state.page.locator('#menu') })
```

`humanMouse.defaults` is the mutable option bag every call falls back to — `{ seed, sampleRateHz, maxSamples, tuning, reportCrossings }`. Setting `humanMouse.defaults.reportCrossings = true` once is how you get the crossing report on every move without repeating it. `enable({ page, …defaults })` stores a *separate* set of defaults for the patched clicks on that page.

### What the model actually is

Not "Bézier plus jitter". Each piece is a named result and the code says which:

| Component | Model | What it buys |
|---|---|---|
| Duration | **Fitts's law**, Shannon form (MacKenzie 1992): `MT = a + b·log2(D/W + 1)` | A move to a big button is faster than the same-length move to a 4px handle. `W` is the target's extent *along the movement axis*, taken from the element's box when you pass a locator. |
| Speed profile | **Minimum-jerk** (Flash & Hogan 1985): `s(τ) = 10τ³ − 15τ⁴ + 6τ⁵` | The empirically correct symmetric bell. A generic `cubic-bezier` ease is a different curve with its peak in the wrong place. |
| Path | Cubic Bézier with control points offset perpendicular to the A→B axis | Human hand paths bow gently. Peak deviation is held near 3% of amplitude — a big swoop reads as fake in the other direction. |
| Endgame | **Corrective submovements** (Meyer et al. 1988) | A fast primary phase that *misses*, then 1–2 short corrections. Landing dead centre in one swoop is the clearest bot tell there is. How often you get two is a function of the geometry, not a constant: measured over 3000 seeds on a 900px move to an 80px target, **76.6% one correction, 23.4% two, 0% none**. Aim at a 12px handle from the same distance — same 3000 seeds — and it is **65.1% one, 34.9% two, 0% none**. |
| Curve timing | **2/3 power law** (Lacquaniti et al. 1983): `v ∝ κ^(−1/3)` | Slows through curves. Applied as a re-timing that preserves total duration exactly. |
| Noise | Physiological tremor, 8–12 Hz, 0.4px | Invisible as jitter; only stops the path being machine-smooth. |

Every stochastic element comes from a seeded PRNG. `Math.random()` is never called: pass `seed` and you get a byte-identical trajectory, which is what makes a recording reproducible.

### How it composes with `locator.click()`

- `humanMouse.click({ locator })` does the human move, then calls `locator.click()`. Playwright then runs its own actionability and its own move to the element centre — but the pointer is already there, so that move is zero-distance and contributes one extra `mousemove` at the resting point and nothing else. **Actionability is not bypassed.**
- `humanMouse.click({ x, y })` has no element, so there is no actionability to run. It presses where you told it to.
- `humanMouse.enable()` patches `Locator.prototype.click/dblclick/hover` but the patch is **scoped to the pages you enabled** — other sessions sharing the relay process are unaffected, and `disable()` genuinely restores the old behaviour.
- The ghost cursor overlay receives the whole polyline in one call and plays it back on the page's own rAF clock with CSS transitions off, so the drawn cursor traces the same curve as the real pointer instead of easing a transition behind it.

### Timing is real, and it is reported

Measured through the relay **and** the extension on a live profile: every CDP command round-trips in ~4ms except `Input.dispatchMouseEvent`, which is **frame-locked at ~16.5ms** when awaited — so awaiting each sample would cap the sampler at 60Hz and hand the timing to vsync. Issued without awaiting it costs **~1.8ms**. The sampler therefore paces itself on an absolute wall clock at **60Hz** (denser is pointless — Chrome coalesces mousemove within a frame) and awaits the batch at the end.

**The cliff to know about:** on a tab whose renderer is throttled — backgrounded, occluded, unfocused — that same call does not get slower, it falls off a cliff. Two independent measurements, which agree on the shape and disagree on the constant:

| Measured | Foreground | Throttled |
|---|---|---|
| Through the relay **and** the extension, live user profile | ~16.5ms | **~1000ms** |
| Direct CDP, Chrome for Testing 145, a genuinely hidden tab (`document.visibilityState === 'hidden'`, `requestAnimationFrame` suspended at **0 fps**) | 17ms p50 | **5003ms p50** (min 5002, max 5004, n=10, reproduced twice) |

So treat the cliff as 60×–300×, not as a number. `Runtime.evaluate` stayed at ~1ms on that same hidden tab throughout, so it is specifically the input path that stalls, not the connection. A 500ms move becomes half a minute. Every move therefore probes for it with one awaited dispatch before starting — that probe is itself one full stall, which is why the first move on a throttled tab looks like a hang — and reports `rendererThrottled` plus a warning.

**This is the one place where YOU are the one who calls `bringToFront`.** (The recorder's screenshot path needs a foreground tab too, but it makes that call itself — see the recording section.) Measured on the hidden tab above: `page.bringToFront()` returned in 28ms and 39ms across two rounds and restored the tab completely and immediately — visible again, rAF back to 60.3 fps, dispatch back to **16ms p50**. Nothing else recovers it; the throttling is Chromium not scheduling frames for a tab nobody is looking at.

That does **not** soften the "never call `bringToFront`" rule under "rules". The two rules are about different subsystems and do not overlap. Clicking, snapshotting and everything else here works on a background tab, so foregrounding for those is pure focus theft. Screencast recording does not need a foreground tab either (measured separately: 31 frames backgrounded against 30, and 60fps hidden over raw CDP). The recorder's *screenshot* path is the one other subsystem that does need one — measured at ~0.1fps hidden with captures blocking up to 26s — and it foregrounds the tab itself rather than asking you to, so it is not an exception to this rule; it is a mode you opt into. `humanMouse` is the only place YOU make the call, because it is the only subsystem whose latency is frame-locked. Act on the reported `rendererThrottled`, never on a hunch: if it is false, foregrounding buys you nothing and costs the user their screen. If it is true and you must not steal focus, the honest choice is to drop human motion for that action, not to run it thirty times slower.

The result always carries `fittsDurationMs` (what the law asked for), `plannedDurationMs` (what the submovement decomposition added up to — corrections are paid out of the Fitts budget, but their duration floors can push the total over on a short move) and `achievedDurationMs` / `durationDriftMs` (what the wall clock actually did). If the sampler cannot hit the modelled timing it says so in `warnings`; it never silently delivers a slower move.

### Options

`moveTo` / `click` / `hover` / `plan` take: `{ locator }` or `{ x, y }`; `page`, `position` (offset within the element), `from` (override the origin — the real lever for keeping a path out of a hazard corridor), `seed`, `sampleRateHz` (60), `maxSamples` (260 — binding reduces the *rate*, preserving the profile's shape, and says so), `tuning` (any Fitts/curvature/tremor/submovement parameter), `reportCrossings`, `includeTrajectory`, `heldButton` (for drags). `click` also takes `button`, `clickCount`, `delayMs`.

There is deliberately **no** "route around this element" option. A real user's hand does not dodge invisible rectangles, so a dodging path is less human, not more. If a hover hazard sits on the line, either start the move somewhere else (`from`) or do not use human motion for that action.

**createDemoVideo** - speeds up idle sections (time between execute() calls) while keeping interactions at normal speed. Requires `ffmpeg`/`ffprobe`. Timestamps are tracked automatically during recording and returned by `recording.stop()`. **Timeout**: can take 60–120+ seconds, always pass `--timeout 120000` or higher.

Save the whole `recording.stop()` result to `state` (shown above) — its `executionTimestamps` are what drive idle detection.

```js
// SEPARATE execute call, with --timeout 120000:
const demoPath = await createDemoVideo({
  recordingPath: state.recordingResult.path,
  durationMs: state.recordingResult.duration,
  executionTimestamps: state.recordingResult.executionTimestamps,
  speed: 6, // default 6x for idle sections
})
```

## pinned elements

Users can right-click → "Copy Playwriter Element Reference" to store elements in `globalThis.playwriterPinnedElem1` (increments for each pin). The reference is copied to clipboard:

```js
const el = await state.page.evaluateHandle(() => globalThis.playwriterPinnedElem1)
await el.click()
```

## taking screenshots

Always use `scale: 'css'` to avoid 2-4x larger images on high-DPI displays:

```js
await state.page.screenshot({ path: '/absolute/path/to/shot.png', scale: 'css' })
```

If you want to read back the image file into context, resize it first so it consumes fewer tokens:

```js
await resizeImageForAgent({ input: './shot.png' })
```

## page.evaluate

Code inside `page.evaluate()` runs in the browser - use plain JavaScript only, no TypeScript syntax. Return values and log outside (console.log inside evaluate runs in browser, not visible). Use it only for the five cases in "reading a page: pick the narrowest tool" — never to count or describe elements, which is `pm.query`'s job:

```js
// Reading non-DOM JS state — nothing else can see this
const info = await state.page.evaluate(() => ({
  url: location.href,
  config: window.__CONFIG__ ?? null,
  next: window.__NEXT_DATA__?.buildId ?? null,
}))
console.log(info)

// Mutating page state — the other legitimate use
await state.page.evaluate(() => localStorage.clear())
await state.page.locator('.scrollable-list').evaluate((el) => { el.scrollTop += 500 })
```

## loading files

Fill inputs with file content:

```js
const fs = require('node:fs')
const content = fs.readFileSync('./data.txt', 'utf-8')
await state.page.locator('textarea').fill(content)
```

## network interception

For scraping or reverse-engineering APIs, intercept network requests instead of scrolling DOM. Store in `state` to analyze across calls:

```js
state.requests = []
state.responses = []
state.page.on('request', (req) => {
  if (req.url().includes('/api/')) state.requests.push({ url: req.url(), method: req.method(), headers: req.headers() })
})
state.page.on('response', async (res) => {
  if (res.url().includes('/api/')) {
    try {
      state.responses.push({ url: res.url(), status: res.status(), body: await res.json() })
    } catch {}
  }
})
```

Then trigger actions (scroll, click, navigate) and analyze captured data:

```js
console.log('Captured', state.responses.length, 'API calls')
state.responses.forEach((r) => console.log(r.status, r.url.slice(0, 80)))
```

Inspect a specific response to understand schema:

```js
const resp = state.responses.find((r) => r.url.includes('users'))
console.log(JSON.stringify(resp.body, null, 2).slice(0, 2000))
```

Replay API directly (useful for pagination):

```js
const { url, headers } = state.requests.find((r) => r.url.includes('feed'))
const data = await state.page.evaluate(
  async ({ url, headers }) => {
    const res = await fetch(url, { headers })
    return res.json()
  },
  { url, headers },
)
console.log(data)
```

Clean up listeners when done: `state.page.removeAllListeners('request'); state.page.removeAllListeners('response');`

## computer use (low-level mouse/keyboard)

### clicking

```js
// Preferred: by locator (stable, auto-waits, no coordinates needed)
await state.page.locator('button[name="Submit"]').click()
await state.page.locator('text=Login').click({ button: 'right' })
await state.page.locator('text=Login').dblclick()
await state.page
  .locator('a')
  .first()
  .click({ modifiers: ['Meta'] }) // cmd+click opens link in new background tab

// By coordinates (when locators aren't available, e.g. canvas, maps, custom widgets)
await state.page.mouse.click(450, 320) // left click
await state.page.mouse.click(450, 320, { button: 'right' }) // right click
await state.page.mouse.dblclick(450, 320) // double click
await state.page.mouse.click(450, 320, { clickCount: 3 }) // triple click
await state.page.mouse.click(450, 320, { modifiers: ['Shift'] }) // shift+click
```

### hover

```js
await state.page.locator('.tooltip-trigger').hover() // by locator (preferred)
await state.page.mouse.move(450, 320) // by coordinates
```

### scroll

```js
// By locator (preferred)
await state.page.locator('#footer').scrollIntoViewIfNeeded()

// By pixel (for canvas, maps, infinite scroll)
await state.page.mouse.wheel(0, 300) // scroll down 300px
await state.page.mouse.wheel(0, -300) // scroll up
await state.page.mouse.wheel(300, 0) // scroll right
await state.page.mouse.wheel(-300, 0) // scroll left

// Scroll at a specific position
await state.page.mouse.move(450, 320)
await state.page.mouse.wheel(0, 500)

// Scroll inside a container
await state.page.locator('.scrollable-list').evaluate((el) => {
  el.scrollTop += 500
})
```

### drag

```js
// By locator (preferred)
await state.page.locator('#item').dragTo(state.page.locator('#target'))

// By coordinates (for canvas, sliders, custom drag targets)
await state.page.mouse.move(100, 200)
await state.page.mouse.down()
await state.page.mouse.move(400, 500, { steps: 10 }) // steps for smooth drag
await state.page.mouse.up()
```

**Freehand drawing, annotation widgets, and canvas tools** use this same `mouse.down → move → up` pattern. If a widget expects a drawn stroke (paint tools, annotation overlays, range sliders, timeline scrubbers), always use held-mouse motion — not `mouse.click()`:

```js
// Draw a stroke across a canvas or annotation layer
await state.page.mouse.move(startX, startY)
await state.page.mouse.down()
await state.page.mouse.move(endX, endY, { steps: 15 }) // steps = smoother stroke
await state.page.mouse.up()
await state.page.waitForTimeout(500) // let the widget process the stroke
```

### key hold / release / repeat

```js
// Hold modifier while pressing another key
await state.page.keyboard.down('Shift')
await state.page.keyboard.press('ArrowDown')
await state.page.keyboard.up('Shift')

// Repeat a key
for (let i = 0; i < 5; i++) await state.page.keyboard.press('ArrowDown')
```

### resize viewport

```js
await state.page.setViewportSize({ width: 1280, height: 720 })
```

### region screenshot (zoom equivalent)

```js
await state.page.screenshot({ path: '/absolute/path/to/region.png', scale: 'css', clip: { x: 100, y: 200, width: 400, height: 300 } })
```

Prefer locator-based actions over coordinates — locators are stable across scroll/resize, auto-wait for elements, and don't require screenshot round-trips that burn ~800 image tokens per cycle.

## Ghost Browser integration

When running in [Ghost Browser](https://ghostbrowser.com/), the `chrome` object exposes APIs for multi-identity automation (identities, proxies, sessions). See `extension/src/ghost-browser-api.d.ts` for full API reference. Only works in Ghost Browser — calls fail in regular Chrome.
