## Browse like a human (start here)

You drive a real browser, often the user's own logged-in Chrome. Work like a careful person sitting at it: look, do ONE thing, let the page react, look again. **Human mode** (the default; whoever starts the session picks it) enforces this: a call that breaks a rule is refused with the reason and the right move, and nothing in it runs.

### The loop

1. **Look** — `await observe()` prints what is on screen right now:
   - `PAGE` url, title, tab, how far down you are · `TABS` when several are open · `BUSY` the app is still working · `MODAL` / `DIALOG` something blocks the page · `FOCUS` · `LIVE` a live region (chat log, status line) and its newest text.
   - `IN VIEW` — every control with a **ref** in brackets, plus its state and value: `[12] button "Send"`, `[7] textbox "Message" [focused] = "hi"`, `[9] checkbox "Remember me" [unchecked]`, `[4] combobox "Sort" = "Relevance" (options: Relevance · Newest · …)`, `[5] date "Check-in" (takes YYYY-MM-DD: act.fill(ref, "YYYY-MM-DD"))`, `[20] clickable div.card "Free shipping"` (a click target that is not a semantic control), `img "Product" BROKEN`, `partly covered by …`. A control drawn by its styling (`transparent control`) or hidden behind its label (`worked through its label`) is listed and acted on like any other. Long text is kept whole; a printed line cut short says `(+N chars)`.
   - `BELOW` / `ABOVE` — what is off-screen (counts and headings), so you do not have to scroll to find out. In apps whose page does not scroll (mail, chat, dashboards), `SCROLL [57] main "Messages" — 4 screens below` names the scroll area and `INSIDE [57] …` counts what it hides. A carousel or wide table is a scroll area too: `SCROLL [58] region "Featured products" — left edge, 3 screens to the right`. `*` marks what is new since your last look.
   - Iframes are part of the page: `[7] iframe "Secure card payment" — 4 controls` with its controls (refs) indented under it, cross-site ones (payment fields, embedded sign-in, consent walls) included. An iframe that cannot be read says why on its line. `act.*`, `find()` (`· in iframe [n]`), `explain()` and `getPageMarkdown()` work inside iframes the same way.
2. **Do one thing** with a ref from that output: `await act.click(12)` · `await act.fill(7, 'red running shoes size 10')` · `await act.press('Enter')` · `await act.select(4, 'Price: low to high')` · `await act.check(9)`.
3. **Read the report** printed after the call. It always says what was hit, whether the page `SETTLED` (or what it is still waiting for), navigation (`in-app route`, `NEW DOCUMENT` = full reload, or a back/forward-cache restore), dialogs, live text (also text that vanished), console errors and failed requests, new tabs (`act.switchTab(i)`), downloads (`DOWNLOAD [d1] …` — `downloads.save('d1', 'name.csv')` saves the file), a `FILE DIALOG` your input opened (it waits for `act.dialog.chooseFiles(path)` or `act.dialog.dismiss()`), and the `CHANGES` (`+` appeared, `-` gone, `~` state or value changed, text that grew). `NO VISIBLE CHANGE` means it probably did not work. Do not assume it did.
4. **If the app is still working** (`BUSY`, `NOT SETTLED`, an AI reply streaming in): `await act.waitForIdle()`, then read what changed. Never act while it is busy: that is how replies get interrupted and messages get posted twice. Give long waits a bigger call `timeout`.
5. Repeat. One input action per call; waits and reads are free.

### Finding things

- `await find('Checkout')` — every match on the whole page, off-screen included, whole texts and drop-down options too, with its ref and where it is.
- `await act.scrollTo(ref)` brings an element into view with the mouse wheel; `await act.scroll('down')` scrolls what the wheel reaches in the middle of the screen (in an app shell, the main list); `act.scroll('down', { ref: 57 })` scrolls that scroll area; `act.scroll('right', { ref: 58 })` turns a carousel sideways.
- `await observe({ all: true })` also lists off-screen elements; `await observe({ scope: ref })` shows only that part of the page.
- Before clicking something you do not understand: `await explain(ref)` — what it is wired to (React component, handler source, the requests and navigation it triggers).
- Not sure which element the user means? Ask them to point at it: right-click the page → **Pin an element for Playwriter**, then click it — `observe()` lists it under `PINNED` with its ref. Or tell them what to click, then `await pickElement()` with a long call `timeout` (e.g. 120000): Chrome's picker highlights elements under their pointer, and the call returns the ref of the one they click.
- Article text: `await getPageMarkdown({ outline: true })`, then `getPageMarkdown({ filter: 'Reviews' })` for one section.
- Anything else on the page: `await readPage((el) => el.closest('tr').querySelector('.price').textContent, { ref: 12 })` runs your function in the page, in the element's frame, under Chrome's side-effect check — it can only read (a write, focus, scroll or request stops it and changes nothing). Without a ref `el` is the `document`; `{ arg }` passes data in (the function cannot see your variables). It returns data, or refs for elements it returns (`readPage(() => document.querySelectorAll('.result a'))`). Synchronous only; a loop that waits for the page never ends (the page cannot change while it runs) — read, `act.waitForIdle()`, read again. `console.log` inside prints with the call's output.

### act

| Call | What it does |
|---|---|
| `act.click(ref)` / `act.dblclick(ref)` | moves the pointer like a person, hit-tests the target (refuses and names the cover if something is on top), clicks |
| `act.fill(ref, text)` / `act.type(ref, text)` | clicks the field, replaces (`fill`) or appends (`type`) key by key at a person's pace; the report reads the value back. A newline in a single-line field is refused (it is Enter: submit with `act.press('Enter')` next). In a text area or rich editor a line break is a key the app decides, so text with one needs `{ newline: 'Shift+Enter' }` (chat composers: Enter sends) or `{ newline: 'Enter' }` (plain text areas, code editors), or `{ paste: true }`; without it the call is refused and nothing is typed. Date/time inputs take ISO text (`2024-05-01`, `13:45`) typed into the field's parts; a slider takes a number on its step; a colour input takes `#rrggbb`, typed into the hex field of Chrome's colour chooser (one with suggested swatches — a `list` — is refused: ask the user). `{ paste: true }` inserts the text, line breaks included, in one go as IME text (no key events, no paste event; not combinable with `newline`) |
| `act.press(key, { ref })` | a key or chord (`'Enter'`, `'Escape'`, `'Tab'`, `'Control+A'`) where focus is, or on `ref` |
| `act.select(ref, option)` | native `<select>`: clicks it, moves to the option with the arrow keys and presses Enter, as a person does (observe() lists the options; a disabled one is refused). Custom dropdowns: click to open, then click the option |
| `act.check(ref)` / `act.uncheck(ref)` | sets the state and verifies it took |
| `act.hover(ref)` · `act.scrollTo(ref)` · `act.scroll('down' \| 'up' \| 'right' \| 'left', { screens, ref })` · `act.drag(from, to)` (each a ref, or `{ ref, x, y }` — a point of the element in CSS px from the top-left corner of its box as laid out: x from 0 up to, not including, its width; y from 0 up to, not including, its height) · `act.upload(ref, files)` | scrolling is the mouse wheel over the area that actually scrolls (sideways: horizontal wheel deltas, as from a trackpad); if the page ignores the wheel, the action says so, and a third scroll that moves nothing is refused. `drag` presses on the first point, moves with the button held along a person's path and releases on the second; a point is wheeled into view, must be inside the element's box (the refusal names its size, e.g. `300×150 px`) and is hit-tested exactly there (a covered point is refused naming the cover); rotated, scaled and perspective-tilted elements are mapped through their transform. `upload` clicks the control and chooses the files in the file dialog it opens (more files than it takes is refused); when that control's dialog is already open, it chooses in it without clicking again |
| `act.waitForIdle({ timeoutMs })` | waits until nothing is loading, streaming or changing (AI replies, searches) |
| `act.dialog.accept(text?)` / `act.dialog.dismiss()` / `act.dialog.chooseFiles(files)` | answers a native `confirm()` / `prompt()` / `beforeunload` ("Leave site?"); they block the page until answered — leaving with unsaved work is a decision, never made for you. Alerts are accepted automatically and reported. A dialog the user answered at the browser is reported as closed. A file dialog your input opened (`FILE DIALOG OPEN`) stays open like a real one: `chooseFiles` picks files in it, `dismiss` cancels it, and until then the page cannot be used |
| `act.open(url, { reason })` | a full page load: free on a blank tab, otherwise only with a reason (it wipes client caches) |
| `act.spaNavigate('/path')` | an in-app route change: clicks the page's own link to it; refuses when the page has none |
| `act.back()` | the browser's Back button; refused on a tab with no earlier page |
| `act.switchTab(i)` | makes tab `i` (from `TABS` / a report's `TAB` line) the controlled tab. Not an action on the page. Acting on a ref from another tab switches to it by itself |

### Enforced in human mode

- **One action per call** — checked in your code before it runs (a helper that acts and is called twice or in a loop counts as several; aliases like `const { click } = act` are the same call) and again while it runs. Do the first one, read the report, then decide the next.
- **No `page.goto` / `reload` after the first load.** A full reload wipes client caches (SWR, React Query, Redux), so a repro made that way is biased. Click the link (observe lists links with their URLs) or use `act.spaNavigate`. `history.pushState` / `location.hash =` from page code are refused too.
- **No faked conditions:** no `page.route` / `net.delay`, no DOM or style writes, no synthetic events, no calling the backend with `fetch`. Reproduce it the way a user would; `net.requests()` shows what the page itself sent. Page functions must be readable: pass them inline (`readPage((doc, sel) => …, { arg: sel })`), not as a variable, a wrapper, `eval` or a string. `getCDPSession()` only reads.
- **No Playwright script in the page.** `page.evaluate`, `page.title()`, `page.content()`, `page.screenshot()`, `waitForSelector`, every locator read (`textContent()`, `count()`, `isVisible()`, `boundingBox()`, …) and every locator action (`click()`, `fill()`, `hover()`, `focus()`, `selectOption()`, …) run Playwright's script in the page as a user gesture: the page then counts as clicked (`navigator.userActivation`), which unlocks popups, file dialogs, sound and "Leave site?" prompts a person who only looked never unlocks. Refused before it runs, and at run time for what the check could not see. Read with `observe` / `find` / `explain` / `readPage`, act with `act.*`.
- **Wait while busy, answer native dialogs first.** A ref from before a navigation is stale: `observe()` again.
- **The element must still be what you saw.** If a ref now reads differently (`[12] now reads button "Unfollow" (you saw button "Follow")`, or a recycled row now belongs to another item), the action is refused: observe and decide again.
- **No double sends.** Repeating the action you just did is refused when it sent data-changing requests (`POST …`, a WebSocket message) — that is how a message gets posted twice. Do something else first (type the next message), or pass `{ again: true }` if the first really failed.

Reading without Playwright's script is never restricted: `observe`, `find`, `explain`, `readPage`, `snapshot`, `pm.*`, `getLatestLogs`, `net.requests`, `getPageMarkdown`, `screenshotWithAccessibilityLabels`.

### Be the user, not the tester

- Use the product the way its users do: a new conversation, natural wording, real data. Never "test 1" or "doc 1:".
- Before saying something works or is fixed, point at the evidence in a report or observation (a visible text, a state, a request status). `NOT SETTLED`, `FAILED`, a timeout or `NO VISIBLE CHANGE` is not success.
- On a password field outside localhost, stop and ask the user. Do not touch the user's other tabs.
- Stuck? `explain(ref)`, `find(…)`, `getLatestLogs({ sinceLastCall: true })`, `net.requests({ failedOnly: true })`, or ask the user. Repeating an action that changed nothing three times is refused.

`state` persists between calls, `page` is the controlled tab. Everything else — the Playwright API, `snapshot()` locators, CSS/React/debugger/trace tools, recording — is in the reference below. **Debug mode** (`playwriter session new --policy debug`, or `PLAYWRITER_POLICY=debug` for the MCP server) allows multi-step scripts and network perturbation; only the user switches it on.

---

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

Don't create new sessions to "fix" a problem — reuse the same `-s` number. A fresh session throws away the `state` you built up and reconnects to the same browser, so it fixes nothing that `resetPlaywright()` would not fix in place.

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

The in-sandbox equivalent is `resetPlaywright()` — the same reconnect, and it clears `state` the same way. See "context variables".

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

The `-s` flag specifies a session ID (required). Get one with `playwriter session new`. Use the same session to persist state across commands. The session's cwd is the directory you run `playwriter` from — that is the cwd `process.cwd()` reports inside the sandbox, and the one that scopes `fs` writes (see "context variables").

`--timeout` raises the execution timeout in milliseconds from its 10000 default. Anything that shells out to ffmpeg — `createDemoVideo` in particular — needs `--timeout 120000` or higher.

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

**Why single quotes?** Always wrap `-e` code in single quotes (`'...'`) to prevent bash from interpreting `$`, backticks, and other special characters inside your JS code. Bash rewrites those *inside double quotes* before playwriter ever sees them, so double-quoting silently corrupts the code you meant to run rather than failing. Use double quotes or backtick template literals for strings inside the JS code.

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

```bash
playwriter logfile  # prints the relay log path, and the CDP JSONL path beside it
```

What is in those logs, how to triage them, and where to report a bug: see "debugging playwriter itself" at the end of this document.

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

**Remote relay (the browser is on another machine):** Chrome, the extension and the relay can all live somewhere else — a desktop, a LAN box, the far end of a tunnel — while you run here. Set `PLAYWRITER_HOST` to that machine's relay URL in the same MCP client `env` block as above, plus `PLAYWRITER_TOKEN` when the relay is exposed beyond localhost. Both are read in MCP mode, not only by the CLI, so this is a real deployment and not a CLI-only trick. The other machine is the one that runs `playwriter serve`. Full guide (Docker, LAN, security): https://playwriter.dev/docs/remote-access

**Screen recording IS available in direct CDP mode — but only one of the two recorders.** `recording.start`/`recording.stop` are unavailable, because they rely on the extension's `chrome.tabCapture` API. `recording.startCdp`/`stopCdp` work in direct CDP and extension sessions alike and need no extension-icon click; see the recording section.

## context variables

- `state` - object persisted between calls **within your session**. Each session has its own isolated state. Use to store pages, data, listeners (e.g., `state.page = await context.newPage()`)
- `page` - a default page (prefer `state.page`, which persists per session — see "working with pages")
- `context` - browser context, access all pages via `context.pages()`
- `browser` - the connected Playwright `Browser`. Present so `browser.version()` / `browser.contexts()` are readable; **never** call `browser.close()` (see "rules"). It is a snapshot taken when the call started, so after `resetPlaywright()` re-read it rather than holding one in `state`.
- `chrome` - Ghost Browser's multi-identity APIs. Only works inside Ghost Browser; see the last section.
- `require` - load Node.js modules (e.g., `const fs = require('node:fs')`). ESM `import` is not available in the sandbox
- Node.js globals: `setTimeout`, `setInterval`, `fetch`, `URL`, `Buffer`, `crypto`, `process`, etc.

**resetPlaywright()** - drop the browser connection and reconnect, from inside the sandbox. It is a full reconnect and it clears **all** of `state`, so treat it as a last resort when the connection is wedged mid-task rather than a routine retry:

```js
const { page: fresh } = await resetPlaywright()
state.page = fresh
```

**Not available in the sandbox:** `__dirname`, `__filename`, `import`.

`require` is restricted to a list of safe Node built-ins; anything else throws `ModuleNotAllowedError`. The same list gates `require.resolve()` and `process.getBuiltinModule()`, and all three return the same objects — `fs` is always the write-scoped one described below, never the raw module.

`process` is exposed for reading (`env`, `argv`, `platform`, `version`). It is read-only, `cwd()` reports your session's directory, and the members that end or re-privilege the relay process (`exit`, `abort`, `kill`, `chdir`, `umask`, `setuid`…) or load native code (`binding`, `dlopen`, `loadEnvFile`) all throw. Note that `process.env` is the relay process's real environment: you can read it and writes are visible to the whole process.

**Important:** `state` is **session-isolated**, and browser tabs are **isolated per git worktree** — `context.pages()` only ever returns your own worktree's tabs. Two sessions in the *same* worktree deliberately share tabs; sessions in different worktrees never see each other's tabs. See "working with pages".

**Sandboxed `fs` write restrictions:** `require('node:fs')` is scoped. Writes (writeFileSync, mkdirSync, etc.) only succeed in:
- The **session's cwd** — what `process.cwd()` reports inside the sandbox
- `/tmp`
- The OS temp directory (`os.tmpdir()`, e.g. `/var/folders/.../T/` on macOS)

Writing to any other path (e.g. `~/Downloads`, `~/Desktop`) throws `EPERM: operation not permitted, access outside allowed directories`. To save files elsewhere, write to a temp path first, then move the file using a shell command outside the sandbox.

Two limits of that scoping worth knowing: paths are checked textually, so an existing **symlink** inside an allowed directory is followed wherever it points (a `node_modules` link to a sibling package still resolves); and Playwright's own file APIs (`page.screenshot({ path })`, `download.saveAs`, `recording.startCdp({ outputPath })`) write through Playwright and ffmpeg, not through the scoped `fs`, so they are not restricted to these directories.

**The sandbox is a guardrail, not a security boundary.** The allowlist, the `fs` scoping and the `process` restrictions exist to stop an agent doing something destructive by accident or by following a web page's injected instructions literally. They are not isolation: `execute()` runs in a Node `vm` context that shares live objects (`page`, `Buffer`, `fetch`) with the host process, and code that goes looking can reach the host realm through any of them. Never run code you would not run in your own terminal, and do not treat this as a place to execute untrusted input.

## rules

- **Initialize state.page first**: see "working with pages" — at the start of a task, assign `state.page` (reuse `about:blank` or create one) and use `state.page` for all automation steps.
- **One action per call, then read the report**: in human mode (the default) a call may contain one input action; the settle + "what changed" report printed after it replaces printing the URL, snapshot and logs by hand. In debug mode use multiple execute calls anyway — it isolates which action failed.
- **Never close**: never call `browser.close()` or `context.close()`. Only close pages you created or if user asks
- **No bringToFront**: never call unless the user asks — it steals the focus of whatever they are actually looking at, and you can drive a background page without it. For recording, `recording.startCdp` captures a backgrounded tab fine on its **screencast** path (measured: 31 frames backgrounded against 30 foregrounded, and 60fps hidden over raw CDP); its **screenshot** path genuinely does need a foreground tab (~0.1fps hidden, single captures blocking up to 26s) and calls `bringToFront()` **itself**, so you still never call it — you choose the mode instead. See the recording section for which modes foreground, `mode: 'auto'` included. **There is exactly one place where YOU make the call, and it is `humanMouse`** — its moves are frame-locked, and a backgrounded renderer stretches every `Input.dispatchMouseEvent` from ~17ms to seconds, which no amount of retrying fixes. Only there is `await page.bringToFront()` the right call, only when the result's `rendererThrottled` flag says so, and the alternative is to not use human motion on that tab. See "humanMouse" for the numbers. Clicking, snapshotting and everything else here works on a background tab.
- **Check state after actions**: the action report says what changed; if it says `NO VISIBLE CHANGE` or `NOT SETTLED`, the action did not demonstrably work — look again (`observe()`), do not assume.
- **Clean up listeners**: call `state.page.removeAllListeners()` at end of message to prevent leaks
- **Logs after actions**: the action report already lists console errors, uncaught exceptions and failed requests caused by the action. For everything else, `getLatestLogs({ page: state.page, sinceLastCall: true })`. Do not manually collect `page.on('console')` events; manual listeners miss logs emitted before the listener is attached. The first `sinceLastCall` call returns all buffered logs including startup and hydration errors.
- **CDP sessions**: use `getCDPSession({ page: state.page })` not `state.page.context().newCDPSession()` - NEVER use `newCDPSession()` method, it doesn't work through playwriter relay
- **Wait for load**: use `state.page.waitForLoadState('domcontentloaded')` not `state.page.waitForEvent('load')` - waitForEvent times out if already loaded
- **Minimize timeouts**: prefer proper waits — `act.waitForIdle()` (any mode), `waitForPageLoad`, and in debug mode `waitForSelector` (human mode refuses it: it polls with Playwright's script in the page) — over `state.page.waitForTimeout()`. Short timeouts (1-2s) are acceptable for non-deterministic events like animations, tab opens, or async UI updates where no specific selector is available
- **Text before screenshots**: use `observe()` (or `snapshot()` for locators) first to understand the page (text-based, fast, cheap, and readable without vision). Only take a screenshot when you need visual/spatial information and can actually look at images. Never take a screenshot just to check if a page loaded or to read text.
- **Always use absolute file paths for Playwright artifact APIs**: for `page.screenshot({ path })`, `locator.screenshot({ path })`, `elementHandle.screenshot({ path })`, `page.pdf({ path })`, `download.saveAs(path)`, and `video.saveAs(path)`, always pass an absolute path. Relative paths are resolved by Playwright client internals, not the sandboxed `fs`, so they may use the relay server cwd instead of your session cwd.
- **Structured readers replace page.evaluate() for inspection**: do NOT write `page.evaluate()` / `readPage()` calls to manually query roles, text, child counts, class names, or test ids. `observe()` and `snapshot()` already show every interactive element with its text, role and state; for tags, attributes, or a custom field set use `pm.query({ page: state.page, fields: ['role', 'name', 'tag', 'locator', 'attributes.class'] })`. If you catch yourself writing `document.querySelector` in a page function — stop and pick from the next section. Reserve page functions for the cases listed there: `readPage(fn)` in human mode (`page.evaluate` is refused there — it runs as a user gesture), `page.evaluate` in debug mode.

## reading a page: pick the narrowest tool

**Two unrelated trees — do not conflate them.** `pm` / `queryPage` / `select:` / the virtual types walk **live page nodes** (the ARIA snapshot fused with the flattened DOM); they know nothing about your source code. `traceValue` and the module graph behind it parse **source files on disk** with Babel; they know nothing about the DOM. `traceValue`'s React-fiber anchor step is the only bridge between the two, and it needs author source on disk **and** a React dev build.

Three layers, in cost order. **Never skip down a layer without a reason you can state.**

**Layer 1 — read the page. This is the default.**

| Need | Use |
|---|---|
| What is on screen, what can I click, what state is it in | `observe()` — refs, states, values, visibility, what covers what |
| Where is X (also off-screen) | `find('X')` |
| What does this control do before I click it | `explain(ref)` — React component, handler source, requests/navigation it triggers |
| Locators for Playwright code, the full accessibility tree | `snapshot({ page: state.page })` |
| Same, plus tags/attributes or your own field set | `pm.query({ page: state.page, select: 'Interactive', fields: ['role', 'name', 'locator'] })` |
| Compact fused tree, marking what is new since the last call | `pm.renderText({ page: state.page })` |
| Article text | `getPageMarkdown({ page: state.page })` |
| Structural HTML | `getCleanHTML({ locator: state.page })`; one element: `getCleanHTML({ ref: 12 })` |
| One stable handle to carry into React/CSS | `pm.anchor('role=button[name="Save"]', { page: state.page })` |
| What is actually at this pixel | `pm.anchorAt({ x, y }, { page: state.page })` — a real hit test |

**Layer 2 — explain the page.** Something looks wrong but nothing crashed.

| Symptom | Use |
|---|---|
| Wrong colour / size / spacing, "my CSS isn't applying" | `debugStyle({ ref, property })` — winner **and** losers, with `file:line` |
| Renders but won't take a click | `whyOccluded({ ref })` — names the covering nodes **and** hit-tests the box centre |
| Which component rendered this, with what props | `fiberSnapshot({ ref })`, or `handle.reactFiber()` from a `pm.anchor` handle |
| Which props changed across a render | two `fiberSnapshot({ ref, identity: true })` + `fiberDiff` |
| Clicked, DOM looks right, nothing persisted | `storeIdentity({ page: state.page, action })` — check `measured` first |
| Intermittent / order-dependent | `net.timeline` (passive), then `net.delay` (perturbing) to force it |
| Something is perturbing my measurements | `net.active()` / `net.warnings()` — the session probe registry |
| Only makes sense as motion | `recording.startCdp` (see recording section) |

**Layer 3 — explain the code.** A rendered value is wrong and you have the app's source checked out.

| Need | Use |
|---|---|
| Where this on-screen value comes from | `traceValue({ ref })` (debug mode also `{ page: state.page, selector }`) → read `render()`, then `blocked` |
| Continue past a blocked leaf | `await t.runProbe(id)` — never guess the value |
| Detail on one hop | `t.expand(id, { depth: 3 })` — one call, whole bounded subtree |
| "It's a `const`, it can't have changed" | `inspectBinding({ file, graph, name })` — constant ≠ unmutated |
| Which reactive value a hook forgot | `findMissingDeps({ file, graph })` — scans the whole file |
| Just the static slice, no anchor/probes | `backwardSlice({ startFile, startExpr })` |
| Value lives in a bundle with no author source | `getScriptSourceByUrl` → `setLogpoint` → `readLogpoints` |
| Step through live | `createDebugger` |

Signatures, traps, and real limits for every Layer 2/3 tool are in "debugging: symptom → cause" below — read them before your first call.

**A page function is still the right tool for exactly these** — `readPage(fn)` (any mode; it can only read) or, in debug mode, `page.evaluate()`:

1. **Mutating** page state — `page.evaluate` in debug mode only; human mode refuses DOM, style and storage writes, and `readPage` cannot make them: `localStorage.clear()`, `el.scrollTop += 500`, dispatching an app event.
2. **Non-DOM JS values** — `window.__CONFIG__`, `window.__NEXT_DATA__`, a global store handle: `readPage(() => window.__NEXT_DATA__.props.pageProps.user.id)` (it runs in the page's own world; a store getter that caches or logs is refused by the check).
3. **Properties the model does not carry** — `naturalWidth`, `videoWidth`, `scrollHeight`, canvas contents, live scroll offsets. Static geometry is NOT on this list any more: `runtime.box`, `paintOrder`, `visible`, `inViewport` and the tracked computed styles all come off the layout snapshot, so `getBoundingClientRect` in a page function is usually a slower duplicate of `pm.query({ fields: ['runtime.box'] })`.
4. **In-page `fetch`** to reuse session cookies, and blob downloads — `page.evaluate` in debug mode only; human mode refuses calling the backend from page code.
5. **Bulk extraction of one repeated non-semantic field** across hundreds of nodes in a single round-trip, where that field is not in the model.

If the body of your page function is a `querySelectorAll` plus a map of role / name / text / class / testid — that is a `pm.query`, and you should rewrite it.

## interaction feedback loop

Every browser interaction follows **observe → one action → report → observe**. The report after an action is automatic: whenever a call performs input (through `act.*` or raw Playwright like `locator.click()`), playwriter waits for the page to settle, looks again, and prints what changed — you do not print URL, snapshot and logs by hand anymore.

```js
// Call 1: open a page on a blank tab (free), then look
state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage())
await state.page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
```

```js
// Call 2
await observe()
```

```js
// Call 3: one action on a ref from the observation; the report follows automatically
await act.click(12)
```

What the report contains, in order: the action (`✓`/`✗`, what the pointer actually hit, notes such as "scrolled 640px in main to reach it"), `SETTLED` or `NOT SETTLED` (with the requests your action started that are still open, and where content is still changing), `NAV` (`in-app route` = same document, `NEW DOCUMENT` = full load, or a back/forward-cache restore where the earlier page comes back with its state), `DIALOG`, `LIVE` (live-region and toast text, including text that already vanished), `ERRORS` (console errors from the page's own code — its iframes' and workers' included — uncaught exceptions, HTTP ≥ 400 and failed requests with their `net.requests` id), `TAB` (a new tab this page opened, with `act.switchTab(i)`), `DOWNLOAD [d1] …` (`completed → downloads.save('d1', 'name.csv')`, `FAILED: …`, still downloading, or why the file cannot be copied here), `FILE DIALOG OPEN, opened by your click [12] button "Upload photo" (one file) — … act.dialog.chooseFiles(path) chooses the files, act.dialog.dismiss() cancels` (a file dialog your input opened, held back by the browser and waiting for your answer — also one that opened after a confirm you answered, or from a page timer a moment after your call returned: then it is in the next report, `… 3.0s after that action ended`), then `CHANGES` (`+` appeared, `-` gone, `~` state/value/name changed, `~ text grew by N chars: "…tail"`, `SCROLL [57] … 0 → 840px`), possible duplicates, and `BUSY` if the app is still working. `NO VISIBLE CHANGE` is printed only when a before/after comparison was made and found nothing — navigations, dialogs, new tabs, downloads and file dialogs count as changes. Treat it as "did not work" until proven otherwise. If part of the report could not be produced, that line says why (`NOT SETTLED — …`, `EVENTS UNAVAILABLE — …`, `AFTER-STATE UNAVAILABLE — …`); the ✓/✗ lines and other events are still listed, so do not repeat an action because the after-state is missing.

Raw Playwright input on the page — `page.mouse.*`, `page.keyboard.*`, `page.touchscreen.tap` — still works and is reported, but it gets no human pointer path, no busy check and no cover check; the report marks it `(raw Playwright)`. Locator and element actions (`locator.click()`, `page.fill(selector, …)`, …) are refused in human mode: Playwright runs them through its injected script. Raw input or a navigation on a tab other than the one you control (`state.page = await context.newPage()` in one call, then `await state.page.goto(url)` in the next) is followed on that tab: the line names it (`ACTION  (raw Playwright) goto https://… on tab 1 "Title"`) and SETTLED, NAV and errors are read from it. No before-picture of that tab was taken, so the report shows no element diff and never claims NO VISIBLE CHANGE for it; a navigation counts as a change. `act.switchTab(1)` then `observe()` to see it.

Playwright reads are not neutral either. `page.title()`, `page.content()`, `page.evaluate()`, `page.screenshot()` and every locator read (`textContent()`, `count()`, `isVisible()`, …) run in the page as a user gesture: the page gets user activation, which a person who only looked never gives it — it may then prompt "Leave site?", play sound, or open popups and file dialogs (`page.screenshot()` also writes `caret-color` into the inline style of every text field unless `caret: 'initial'`). Human mode refuses them; `observe()`, `find()`, `explain()`, `readPage()`, `getPageMarkdown()` and `getCleanHTML({ locator: page })` read without it.

**When the page is still working** (an AI reply streaming, a search running): `await act.waitForIdle({ timeoutMs: 90000 })` in a call with a larger `timeout`, then read the CHANGES it reports — the new reply text is in them.

**Waiting and busy.** After every input the report waits for the page's reaction. Quiet is measured from the end of your last input, so a search the page debounces after your last key is still waited for. Only requests your action caused — in the page, its iframes or its workers — can hold a settle: a long-poll, a stream or a poller the page opened earlier is listed as "open before the action" and never waited on. Chrome's own request facts decide the rest — beacons, prefetches, CSP reports, ad-tagged requests, WebSockets and EventSource channels never hold, and images, fonts and media stop holding once they stall. Ticking clocks, timers, marquees, `aria-live=off` regions, and anything already churning before your action (a reply still streaming from an earlier step) are listed once as ambient and do not keep the page "not settled".

`BUSY` means the page itself says it is working: something marked `aria-busy`, a progressbar with no value or one that moved since your action, an endlessly repeating animation that is on screen and on top (a spinner) and started since your action, content still streaming, or a response body still arriving. Words such as "Loading" or "Processing", class names, and a progressbar standing still never block. A spinner that was already turning before your action is reported but does not block. An alert is accepted automatically and the wait resumes after it closes; a confirm, prompt or "Leave site?" stays open and stops the wait until you answer it.

**What observe() tells you, in detail:**
- Long text is kept whole; lines are cut only when printed, marked `(+N chars)`. `find("words")` searches the whole text and shows the match in context: `text: (212 chars before) "…costs $14.99 and ships tomorrow."`.
- Repeated controls (the same role and name more than once) carry what tells them apart, in this order: the item they are in (`(in listitem "Buy milk")`, `(in row "Alice")`), the heading above them (`(under heading "Reviews")`), the text right before their group (`(after "Width")` — the caption above a set of options), else their position (`(2nd of 3)`). A label's words are its control's name and are not repeated as text.
- Live regions (chat logs, status lines, alerts) stay readable as normal text. `LIVE  log "Conversation" — latest: "…"` names the region and its newest message; changes inside it are marked `— in live region log "Conversation"`.
- Scroll areas: in apps whose page does not scroll the header says `the page itself does not scroll`; `SCROLL [57] main "Messages" — top, 4 screens below` gives the area a ref, `INSIDE [57] …: N more controls … — act.scroll('down', { ref: 57 })` counts what it hides, and `observe({ scope: 57 })` lists its contents. A carousel or wide table is one too: `SCROLL [58] region "Featured products" — left edge, 3 screens to the right`, `INSIDE [58] …: … — act.scroll('right', { ref: 58 })`, and after a sideways scroll the report says `SCROLL [58] region "Featured products" sideways 0 → 540px (now 0.9 screens to the left, 2.1 to the right)`. An area that starts at its right edge (right-to-left content, vertical-rl text, a `row-reverse` strip) is listed from there: `— right edge, 2 screens to the left`, `act.scroll('left', { ref })`. The diff's `sideways a → bpx` is Chrome's scrollLeft, which is 0 or negative for such an area. A list that starts at its bottom — a chat log built with `flex-direction: column-reverse`, which opens at the newest message — is listed from there too: `SCROLL [57] main "Conversation" — bottom, 12 screens above`, and its INSIDE line says `act.scroll('up', { ref: 57 })`. The diff's `a → bpx` is Chrome's scrollTop, which is 0 or negative for such a list.
- Tabs: with several open, `TABS  0: "Shop" (controlled) · 1: "Docs"` lists them for `act.switchTab(n)`. Refs are unique across tabs.
- Iframes: every iframe is an element of the page around it, `[7] iframe "Secure card payment" — 4 controls`, with its content indented under it; `observe({ scope: 7 })` shows only what is inside it. Cross-site iframes, which Chrome runs in their own process, are read the same way. An iframe whose content cannot be read says why on its line (`— not read: the iframe is hidden …`, `… still loading`, `… removed while being read`). Something drawn over an iframe covers what is inside it (`covered by iframe "Cookie consent" [12]`). Acting on a ref inside an iframe scrolls the page to the iframe, then the iframe itself, and hit-tests through it; an iframe's requests and console errors are in the report and journal — a cross-site iframe's from the moment its document starts — each request naming the iframe that sent it (`frame`), and a POST sent from inside an iframe counts for the repeat guard.
- Fields say what they take: `[range 0–100 step 5]`, `(takes YYYY-MM-DD: …)` on date inputs (dates, datetimes and times are roles `date`, `datetime`, `inputtime`; colour inputs `colorwell`), `(file input: its click opens a file dialog — act.upload(3, path))` on a file input (it reads as a button), `(takes #rrggbb: act.fill(10, "#rrggbb"))` on a colour input (`(colour input with suggested swatches: act.fill cannot choose in its popup — ask the user)` when it has a `list`), `type=email`, `placeholder "…"`, `max 64 chars`, `accepts ".pdf"`, `[multiline]`, `[autocomplete=list] [active=[7]]`, and for an invalid field the page's own message: `[invalid] error "Enter a valid email address"`.
- Secrets are shown as `••••`: password fields, one-time-code and card-security fields, and any field the page draws as bullets.
- While a native dialog is open, observe shows only the dialog; title, viewport and scroll say `not readable while the dialog is open`.
- An open file dialog shows at the top: `FILE DIALOG open, opened by your click [12] button "Upload photo" (one file)`. The page behind it stays readable, but nothing on it can be used until you answer it (`act.dialog.chooseFiles(path)` or `act.dialog.dismiss()`), as for a person facing the browser's file dialog.

**When a ref stops working**, the error says why and what to do:
- `… is still on the page but hidden right now: its button [30] "File" is collapsed — open it first (act.click(30))`
- `… is still on the page but cannot be used right now: it is behind the modal dialog "Confirm" [9] — answer or close that first`
- `… is no longer on the page: it was removed or re-rendered.` When exactly one element now has the same role, name and context, it adds `The same button "Save" is now [41]`.
- `… is from a tab that has been closed.` / `… is from the previous page — the page has navigated since.`
- When a modal opens, the report counts the controls behind it (`now inert or behind it — still on the page, not gone`); anything really removed is still listed as `- [12] … (gone)`.

**act, in detail:**
- **Tabs:** acting on a ref from another tab brings that tab to the front and makes it the controlled page; the report says `switched to the tab "…" this ref belongs to`. `act.switchTab(i)` does it without acting and does not use up the call's one action.
- **Upload:** `act.upload(ref, 'file.pdf')` (or an array) clicks the control; the files are chosen in the file dialog that click opens. A control that opens no dialog within 4s is not an upload control; if the click opens a confirm() first, answer it — the file dialog that follows is reported, and `act.dialog.chooseFiles(path)` chooses in it. More files than the dialog takes is refused, and the dialog stays open. A file dialog can open as long as the browser lets the page act on your input (5 s after it): it is held back and waits for you; cancelling it with `act.dialog.dismiss()` is not told to the page (the browser sends no cancel event for a dialog it held back).
- **Back:** `act.back()` goes to the previous entry of this tab's history; with no earlier page it is refused (`Nothing to go back to`). If the page holds the navigation ("Leave site?"), the report says so.
- **Scroll:** `act.scroll('down')` with no ref scrolls what the mouse wheel reaches in the middle of the screen, and the note names it (`scrolled [57] main "Messages" 840px; 2.1 screens below`). `act.scroll('right' | 'left', { ref })` turns a carousel sideways (`scrolled [58] region "Featured products" 480px to the right; 2.2 screens to the right`); scrolling an area the way it does not scroll names the direction it can still move (`it scrolls sideways (act.scroll('left', { ref: 58 }))`). A third scroll in the same direction after two that moved 0px is refused: you are at the end, so read the screen or use find().
- **Date, time, slider and colour fields:** `act.fill(ref, value)` on a native date/time input takes ISO text — `2024-05-01` (date), `13:45` (time), `2024-05-01T13:45` (datetime-local), `2024-05` (month), `2024-W18` (week) — typed into the field's parts in the order the field shows them; the value read back must equal what you asked for, or the action fails. A slider (`type=range`) takes a number on its step grid and is moved with the arrow keys. A colour input takes `#rrggbb` (`act.fill(10, '#3366cc')`): act clicks it and, in Chrome's colour chooser, does what a keyboard user does — Shift+Tab to its format switch, ArrowUp to hex, Shift+Tab into the hex field, type the colour, Enter. The page gets `input` and `change`, and the value read back must be the one asked for. A colour input with suggested colours (a `list`) opens Chrome's swatch popup instead, which takes no choice from the keyboard: that is refused — ask the user. If the chooser closes before it is done (the page re-renders the input), no more keys are sent and the error names the keys that were; a native dialog the page opens on the click or while the colour is typed stops it and names the dialog. A colour input hidden behind its label works the same way. After act.click on a colour input its line says `(Chrome's colour chooser is open, and keys go to it, not the page: …)`: act.fill then cancels the chooser with Escape and chooses the colour, act.press('Enter') closes it keeping the colour it shows, act.press('Escape') puts back the colour it opened with (and closes it once that colour is back). The chooser's own controls are not page controls and are not listed. If the page closes the chooser itself once the colour is typed, no Enter is sent (it would reach the page), and the report says so.
- **Text fields:** a newline in a single-line field is refused (it is the Enter key and submits the form): `act.press('Enter')` in the next call. In a field that takes several lines, text with a line break needs `{ newline: 'Shift+Enter' }` or `{ newline: 'Enter' }` (see common mistake 5), or `{ paste: true }`; otherwise it is refused before anything is typed. `act.type` adds to the end of the whole text (Ctrl+End, or ⌘↓ on macOS — End alone only reaches the end of the clicked line); `act.fill` selects everything first (Ctrl+A / ⌘A). Both check where the caret or selection landed and refuse before typing when the page kept it elsewhere (an app that takes those keys for its own shortcuts). `{ paste: true }` inserts text as IME text in one go — no key events and no paste event fire, so apps that react to pasting will not see one. The report reads the value back; a rich editor's text is read line by line as shown (one line per paragraph or line break).
- **When the element changed since you looked:** act refuses instead of clicking it — `Not done: [12] now reads button "Unfollow" (you saw button "Follow")`, or `[7] button "Delete" is now in listitem "Bob" (you saw it in listitem "Alice")`. Call observe() and decide again.
- **One action per call, also at run time:** a second action reached while the code runs (through helpers, aliases, or raw Playwright input) is refused — `Not done: this call already performed click [3] button "Send" — one action per call in human mode.` Waiting (`act.wait`, `act.waitForIdle`) and `act.switchTab` do not count.

**Deeper observation** — combine the structured readers with filtered logs:

```js
// Search for specific errors in all logs (not just since last call)
const errors = await getLatestLogs({ page: state.page, search: /error|fail/i, count: 20 })
// Every request the page made, failed ones only
const failed = await net.requests({ failedOnly: true })
// The response body of one of them (cut at 64K characters; `truncated` says so)
const body = await net.request('r17')
// The whole body as a file: images, PDFs, large JSON
await net.save('r17', 'response.json')
```

`getLatestLogs({ search })` for targeted debugging, `net.requests()` for what the page sent and got back, screenshots only for visual layout issues. A request record names who sent it besides the page itself: `frame` is the address of the iframe document, `worker` the script of the dedicated worker (a nested one too). Its `startedAt` / `endedAt` are epoch ms on the machine running playwriter, also when the browser runs elsewhere (a cloud browser, a remote relay) with its clock minutes off. A navigation whose response became a download ends with `download: "<file name>"`, not as a failure; a blocked request says why in `failed` (`blocked: csp`, `CORS error: …`).

## debugging: symptom → cause

Signatures, traps, and current limits for the Layer 2/3 tools named above.

**All of these are sandbox globals — already in scope, so never try to load one.** Loading is not how you would get them anyway: there is no `import` at all (no global, and the syntax cannot work either — a static `import` is a SyntaxError inside the async wrapper your code runs in, and a dynamic `import()` throws in a `vm` context), while `require` genuinely exists but only ever hands back the allowlisted Node built-ins listed under "context variables" — never a Playwriter global. Nearly all of the globals below are async — `await` them. To see a value, `return` it, or `console.log` it: sandbox console output is collected and returned to **you** in the execute result. (The `console.log` that goes to the browser console instead of to you is the one written *inside* `page.evaluate()`.) Full types and examples live in the `page-model-api` and `trace-api` MCP resources.

**`{ page: state.page }` is not optional.** Everything that *can* default to a page defaults to the sandbox `page` global — **not** `state.page` — so omitting it silently drives or inspects the wrong tab. The full list: `pm.*`, `queryPage`, `snapshot`, `refToLocator`, `traceValue`, `storeIdentity`, `net.*`, `setLogpoint`, `readLogpoints`, `getScriptSourceByUrl`, `humanMouse.*`, `ghostCursor.show`/`hide`, `pickElement`, `recording.start`, and `recording.startCdp`. (`debugStyle`, `whyOccluded` and `fiberSnapshot` take their page from the `ref` or `locator` you pass, so they are exempt — and so is every call given a `ref` (a ref names its tab), and `snapshot` when you scope it with a `locator` or a `frame`, which carries its own page.)

`getLatestLogs` is the one exception, and it is surprising in the other direction: with no `page` it returns the logs of **every** page in the session, interleaved, not the default page's. Pass `page` when you want one tab's console.

**Element arguments: `{ ref }` everywhere, a Playwright `locator` in debug mode only.** `snapshot`, `getCleanHTML`, `getLocatorStringForElement`, `getStylesForLocator`, `debugStyle`, `whyOccluded`, `getReactSource`, `getReactComponentInfo`, `fiberSnapshot`, `traceValue`, `humanMouse.*` and `pm.*` (`rootRef`) take a ref from `observe()` / `find()` and read the element over CDP, without running anything in the page. Their `locator` / ElementHandle / FrameLocator / selector forms (`node`, `selector`, `rootSelector`) resolve the element with Playwright's script in the page, which Playwright runs as a user gesture — human mode refuses them before anything runs, so use them in debug mode only.

**PageModel & CSS provenance** — a queryable tree fusing the ARIA snapshot, flattened DOM, and lazy React/CSS edges. Prefer it over raw DOM scraping. It returns cycle-free projections, and it is rebuilt on every execute call, so handles do not survive across calls.

```js
await pm.query({ page: state.page, roles: ['button'] })   // rows of key/role/name/tag/locator/runtime.visible unless you pass fields:[...]
await pm.query({ page: state.page, select: 'Interactive', fields: ['role', 'name', 'locator', 'attributes.data-testid'] })
await pm.query({ page: state.page, visibleOnly: true })   // runtime.visible === true
await pm.query({ page: state.page, inViewportOnly: true })// a DIFFERENT question — visible can be scrolled out
await pm.query({ page: state.page, within: 'element#main' })      // scope the QUERY (page-path)
await pm.query({ page: state.page, rootSelector: 'main' })        // scope the FETCH (Playwright selector — debug mode only)
await pm.query({ rootRef: 12 })                                   // scope the FETCH to a ref's element (its tab is the page)
await pm.query({ page: state.page, changedSince: true })  // + changedSince/changes per row
await queryPage({ page: state.page, select: 'Interactive' })  // same projection, top-level
const h = await pm.anchor('role=button[name="Submit"]', { page: state.page }) // → handle | null
const hit = await pm.anchorAt({ x: 640, y: 320 }, { page: state.page })       // GROUND-TRUTH hit test
await h.reactFiber()                                      // lazy edge: { componentName, source, props }
await h.styles()                                          // lazy edge: cascade winner per property
await pm.renderText({ page: state.page, visibleOnly, inViewportOnly, includeRemoved })
await pm.debugMode({ page: state.page })                  // projection config with lossy levers off (you pass it yourself)
await debugStyle({ ref: 12, property: 'color' })          // cascade winner + overridden losers ({ locator } / { node }: debug mode only)
await whyOccluded({ ref: 12 })                            // who is covering it + a real hit test
await whyOccluded({ node: h, page: state.page })          // debug mode only; `page` only when a { node } handle carries no page of its own
```

**Two scopes, two selector languages — this is the one trap worth memorising.** `rootSelector` is a **Playwright** selector and scopes what is *fetched*, before any tree exists (CSS and `:has-text` work; debug mode only — in human mode scope the fetch with `rootRef: 12`). `within` is a **page-path** selector over the tree that already exists (`'element#main'`, `'Interactive'`, `Type[attr=value]` with an **unquoted** value). `scope` is the deprecated alias, and everywhere in the sandbox — `pm.query`, `pm.anchor`, `pm.renderText`, `pm.debugMode`, `queryPage` — it means **`rootSelector`**, the fetch scope. It is never read as a query `within`. Say `within` when you mean the query.

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
const t = await traceValue({ ref: 12 })                     // or { page: state.page, selector: '[data-testid="total"]' } in debug mode
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
await fiberSnapshot({ ref: 12, identity: true })            // identity:true is what makes handler churn visible ({ locator }: debug mode only)
fiberDiff(before, after)                                    // → changes / identityChangedKeys / unobservableKeys
replayPure({ fn, args, bindings })                          // re-run a pure sliced fn in-process
await replayPureAsync({ fn, args })                         // …when the sliced fn is async
```

**How to drive `traceValue`:** anchor with `{ ref }`, a `pm.anchor` handle via `{ node }`, or explicit `{ startFile, startExpr }` (`{ selector }` / `{ locator }` work in debug mode only). `root` defaults to **your session's cwd** — pass it only when the app source lives elsewhere. Read `t.render()` first, then `t.warnings`, then `t.blocked`. Each blocked leaf names its blind spot and carries an armed-but-un-run probe. **Never fabricate a value past a `blockedBy`** — the static pass stopped there because it cannot see runtime state. Run the probe instead.

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
- `debugStyle` / `whyOccluded` / `fiberSnapshot` take `{ ref: 12 }` (or, in debug mode, `{ locator: state.page.locator('...') }`), not a raw selector string.
- **`storeIdentity` returns a union: check `measured` first.** The `measured: false` arm carries **no `sameReference` field at all**, so a probe that never found your store cannot be misread as a store that behaved. When it is false, read `reason` / `tried` / `remedy` and pass `storeExpr` — any expression that *returns* the state object.
- `setLogpoint` **throws** when `expr` cannot be assembled into a provably non-pausing condition (a stray paren, an injected statement, a `debugger`). That refusal is the feature: a breakpoint that can pause reorders timers on resume and destroys exactly the race hypotheses this lane exists to test. Fix the expression — it must be a single JS **expression**.
- `readLogpoints` returns an object, not an array — iterate `read.hits`. **It is capped by default: the newest `maxHits: 20` hits, each value cut to `maxLen: 50` characters.** Both caps are echoed in `read.caps`, both are raisable, and neither is ever applied silently: `droppedHits > 0` means the window hid older hits (raise `maxHits`); `hit.truncated` means that value was cut (raise `maxLen`); `hit.malformed` means the page could not serialise it and the raw text was kept rather than coerced into something plausible. Pass `sinceCursor: read.cursor` on the next call to read only what arrived after this one.
- `t.render()` is capped too: `maxLines` defaults to **60** and `codeFrames` to **true**. A collapse always announces itself on the last line, so a truncated trace never reads as a complete one — but it is still a truncated trace. Raise `maxLines`, or drill with `t.expand(hopId, { depth })`.
- **A probe outlives the `execute()` call that created it** — that is the point of the registry, and the trap it replaces. A dropped `net.timeline` controller keeps recording (drain it with `net.read(id)`); a dropped `net.delay` keeps intercepting. Probes are stopped automatically when their page closes, on `reset`, and on session delete — but not at the end of a call. `net.active()` lists them, including stopped ones, so "who perturbed my measurement?" always has an answer. `net.stopAll()` is scoped to your own session.
- `net.delay` runs on Playwright's `page.route`: matching requests are held for `ms`, then handed on to any routes you registered (they keep working during and after). While it is live Playwright disables the HTTP cache. It **refuses** a second delay on the same page; stop the first, or pass `force: true` to take over. `net.stop(id)` releases held requests at once. It also auto-expires after `ttlMs` (default 120s; `0` = unbounded).
- `replayPure` runs in the **Node executor process** — no window, no document, no page network. Pass what the function needs via `args` / `bindings`. `console` is **virtualised**, not blocked: logging code replays fine and the calls come back in `logs`. Refusals split offenders into `admissible` (supply via `bindings`) and `categoricallyUnsafe` (nothing here can supply them honestly), each with a source position.
- **`fiberDiff` only sees handler churn when both snapshots were taken with `identity: true`.** Without it every function serialises to `[function]` and two different arrows compare equal. With it, `identityChangedKeys` is the list of deep-equal-but-new-reference props — the ones that defeat `React.memo`. A comparison it could not make lands in `unobservableKeys`, never in `unchangedKeys`.
- **Real limits of the static lane:** callee resolution leaves large **typed-unresolved buckets** — read `summary().unresolvedByReason` before concluding "nothing calls this". Escape analysis stays at **chain depth 0**: it sees `ref.push(x)` and `obj.x =`, not a value handed three functions deep. Async boundaries stop the slice by design.

## common mistakes to avoid

**1. Not verifying actions succeeded**
Read the report after every action: it names what the pointer hit, reads a typed value back and lists what changed. `NO VISIBLE CHANGE` means it probably did not work; `NOT SETTLED` means the page is still working. Your mental model can diverge from the browser's state:

```js
await act.type(7, 'my text')   // the report: value read back: "my text"
```

**2. Assuming paste/upload worked**
Clipboard paste (`Meta+v`) can silently fail. For file uploads, do what a person does — click the upload control and choose the file in the dialog it opens:

```js
// Reliable, and the way a user does it: the report says whether a file dialog opened
await act.upload(ref, '/path/to/image.png')
```

```js
// Unreliable: a clipboard paste may silently fail (the field needs focus first) — read the report after it
await state.page.keyboard.press('Meta+v')
```

**3. Acting on a ref from an old observation**
A ref stays bound to its element for the life of its document; a navigation retires it, and an element the app re-rendered gets a new one. `act.*` refuses a stale ref, or one whose element now reads differently, and says why — observe again and decide again:

```js
await observe()   // fresh refs; * marks what is new since your last look
```

In debug mode the same goes for snapshot locators (especially ones with `>> nth=`): take a fresh `snapshot()` before using one.

**4. Wrong assumptions about current page/element**
Before destructive actions (delete, submit), verify you're targeting the right thing:

```js
// Before deleting, check which row the button is in and what it is wired to
await observe()          // the Delete button's context names its row: (in listitem "Logitech M185")
await explain(ref)       // the request it sends, before you click
```

**5. Multi-line text**
In a field that takes several lines, a line break is a key, and apps disagree on which: in a chat composer Enter sends the message and Shift+Enter starts a new line; in a plain text area or a code editor Enter starts a new line (and in a notebook Shift+Enter runs the cell). `act.type` / `act.fill` never guess: text with `\n` needs `{ newline: 'Shift+Enter' }` or `{ newline: 'Enter' }`, or `{ paste: true }`, which inserts it in one go as IME text (no key events, so nothing is sent; no paste event fires either). Without one of them the call is refused and nothing is typed. A newline in a single-line field is refused: there it is Enter, which submits the form.

```js
await act.type(9, 'Line 1\nLine 2', { newline: 'Shift+Enter' })   // a chat composer: a bare Enter would send "Line 1"
```

**6. Using screenshots when text suffices**
Screenshots + image analysis is expensive and slow, and impossible without vision. Only use screenshots for visual/CSS issues. Use text for text checks:

```js
await find('expected text')
```

**7. Assuming page content loaded**
The report after an action waits until the page settles (`SETTLED`), or says what it is still waiting for (`NOT SETTLED`, `BUSY`). For content that keeps arriving (an AI reply, search results), wait for it:

```js
await act.waitForIdle({ timeoutMs: 30000 })   // then read what changed in its report
```

In debug mode `state.page.waitForSelector('article')` waits for one element.

**8. Not using playwriter for JS-rendered sites**
Do NOT waste context trying webfetch, curl, or Playwright CLI screenshots on SPAs (Instagram, Twitter, etc.). These return empty HTML shells. Use playwriter directly:

```js
// A blank tab: its first load is free
state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage())
await state.page.goto('https://www.instagram.com/p/ABC123/', { waitUntil: 'domcontentloaded' })
await waitForPageLoad({ page: state.page, timeout: 8000 })
await observe()
```

**9. Login buttons that open popups**
Popup windows (`window.open` with features, OAuth buttons) are moved into the main window as tabs by the Playwriter extension, and cookies are shared with the original page. The report of the click that opened one names it: `TAB a new tab opened by this page: "Sign in" https://accounts.example.com/… — act.switchTab(1) to work in it`:

```js
await act.click(12)   // "Login with Google"
```

```js
await act.switchTab(1)   // then observe() and act on the login tab's refs
```

In debug mode the new tab is also the last of `context.pages()`, and a `[WARNING] New page opened from current page (index N, initial url: …)` line names it (`initial url` may be `about:blank` for a popup the page fills in by script).

**10. Click refused or does nothing — ask what is on top, don't guess**
`act.click` hit-tests before it clicks and refuses when something covers the target, naming the cover. When a click did nothing, do not retry with other selectors or force it — name the blocker:

```js
// whyOccluded names the covering nodes AND hit-tests the box centre
const why = await whyOccluded({ ref: 12 })
console.log(why.text)   // why.hitTest.label is what a click actually lands on
await observe()         // a MODAL / DIALOG line names the blocker: deal with it the way a person would
```

**11. Never use `dispatchEvent` or `{ force: true }` to bypass blockers**
Synthetic events and forced clicks skip what a real click goes through, and often do not trigger React/Vue/Svelte handlers — state won't update. Human mode refuses them. Click the real control:

```js
await act.click(14)   // the radio "Node.js" from observe()
```

**12. Over-investigating instead of just interacting**
When something doesn't respond to a click, do NOT start hand-walking CDP event listeners, reading canvas pixel data, or writing page functions to dump class names and bounding boxes. That wastes massive context. (If the question genuinely is "what props did React render here", use `fiberSnapshot({ ref })` or a `pm.anchor` handle's `reactFiber()` — those are cheap and token-capped. What is wasteful is reconstructing them by hand.) Instead:

1. `observe()` — it shows every control with its ref, its state and what covers it; `explain(ref)` says what one is wired to
2. Try a different interaction pattern if a click didn't work:
   - **Drawing/annotation tools, canvas paint** → a held-button drag (see the drag section)
   - **Keyboard-activated modes** → press the shortcut key (`act.press('d')`; the control's description often names it, like "Draw mode D")
   - **Sliders, timeline scrubbers** → `act.fill(sliderRef, '40')`, or a drag
   - **Collapsed/toggled toolbars** → click the toggle first, then `observe()` again
3. `observe()` again to see what changed
4. Only investigate DOM internals if correct interaction patterns produce zero response after 2–3 attempts

**13. Asserting about CSS, React, or source code instead of running the tool that knows**
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
- `showDiffSinceLastCall` - return a unified diff against the last snapshot of the same scope and URL instead of the full tree. **Default `false`.**
- `interactiveOnly` - **default `false`**: the whole accessible tree, because a snapshot is usually read to find out what is *on* the page. Pass `true` for only the elements you can act on. Note `screenshotWithAccessibilityLabels` defaults this the other way (`true`) — a label overlay exists to find click targets, so labelling every static node is clutter.
- `ref` / `frame` / `locator` - scope the snapshot to an element's subtree or an iframe (see below). `locator`, and a `frame` that is a FrameLocator (`locator.contentFrame()`), are debug mode only; a `Frame` from `page.frames()` works in both modes.

Every snapshot line carries the element's state and value after its name (or after its locator): `[checked]` / `[unchecked]` / `[checked=mixed]`, `[disabled]`, `[expanded]` / `[collapsed]`, `[pressed]`, `[selected]`, `[focused]`, `[required]`, `[invalid]`, `[level=2]`, and ` = "typed value"` for text fields (password values are always `••••`). Snapshots return the full tree on every call. Pass `showDiffSinceLastCall: true` to get only what changed since the last snapshot of the same scope and URL (a navigation, including an SPA route change, starts a new baseline); if nothing changed it says so. The same opt-in diff exists on `getCleanHTML` and `getPageMarkdown`. For "what changed after my action" you rarely need it: the action report already lists the changes.

Example output:

```md
- banner:
  - link "Home" [id="nav-home"]
  - navigation:
    - link "Docs" [data-testid="docs-link"]
    - link "Blog" role=link[name="Blog"]
```

Each interactive line ends with a Playwright locator you can pass to `state.page.locator()` in debug mode (human mode refuses locators — act on the refs `observe()` prints).
If multiple elements share the same locator, a `>> nth=N` suffix is added (0-based)
to make it unique.

**Debug mode: use snapshot locators directly — never invent selectors.** The snapshot output IS the selector. Do not guess CSS selectors or `getByText` when the snapshot already gives you the exact match:

```js
// Debug mode. Snapshot shows: role=radio[name="Nope, Vanilla"]  →  use it directly
await state.page.getByRole('radio', { name: 'Nope, Vanilla' }).click()
// Snapshot shows: role=link[name="SIGN IN"]  →  or pass raw string to locator()
await state.page.locator('role=link[name="SIGN IN"]').click()
```

**Beware CSS text-transform**: snapshots show visual text (`heading "NODE.JS"`) but DOM may be `"Node.js"`. In a debug-mode locator use a case-insensitive regex: `getByRole('heading', { name: /node\.js/i })`; `find('node.js')` is case-insensitive already.

Debug mode: if a screenshot shows snapshot ref labels like `e3`, resolve them to locators using the last snapshot (human mode refuses locators — act on the refs `observe()` prints):

```js
// Debug mode
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

**Scoping snapshots to a specific element** — pass a `ref` (from `observe()` / `find()`) to snapshot only that element's subtree; its tab is the page. In debug mode a `locator` does the same. This dramatically reduces output size when you only care about one section of the page (e.g., the main content area, ignoring the sidebar/header/footer):

```js
// Full page snapshot: ~150 lines (sidebar, nav, header, footer, everything)
await snapshot({ page: state.page })

// Scoped to one element (a ref observe() or find() printed): just the subtree you care about
await snapshot({ ref: 4 })

// Debug mode only: scope with a Playwright locator
await snapshot({ locator: state.page.locator('[role="dialog"]') })
await snapshot({ locator: state.page.locator('form#checkout') })
```

Use this whenever the full page snapshot is dominated by navigation or layout elements you don't need. It saves significant tokens and makes the output much easier to parse.

**Filtering large snapshots in JS** — when `search` isn't enough, filter the string directly: `snap.split('\n').filter(l => l.includes('dialog') || l.includes('error')).join('\n')`

## choosing between snapshot methods

Use `snapshot` for text-heavy pages (forms, articles) — fast, cheap, searchable. Use `screenshotWithAccessibilityLabels` for complex visual layouts (grids, galleries, dashboards) where spatial position matters. Both share the same ref system and can be combined.

## selector best practices

**Debug mode.** In human mode you act on refs from `observe()` / `find()` and never write a selector; this section is for debug-mode scripts.

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
// Debug mode
await state.page.locator('tr').filter({ hasText: 'John' }).locator('button').click()
await state.page.locator('button').nth(2).click()
```

If a locator matches multiple elements, Playwright throws "strict mode violation". Use `.first()`, `.last()`, or `.nth(n)`:

```js
// Debug mode
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

The user may close your page by accident (e.g., closing a tab in Chrome). Check before using it, and take a blank tab if it is gone — its first load is free:

```js
// A blank tab when yours was closed
if (!state.page || state.page.isClosed()) {
  state.page = context.pages().find((p) => p.url() === 'about:blank') ?? (await context.newPage())
  await state.page.goto('https://example.com')
}
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

**`page.goto()` is for the first load of a blank tab.** After that, in human mode, `page.goto`/`reload`/`goBack` are refused: a full document load wipes client-side caches and in-memory state (SWR, React Query, Redux), which a person clicking around never does, so anything reproduced that way is biased. Move around the way a user does — `act.click(ref)` on a link (observe() shows links with their URLs), `act.spaNavigate('/path')` for an in-app route, `act.back()` for the Back button. When a full load IS what you are testing (cold cache, hard refresh), say so: `act.open(url, { reason: 'cold cache after deploy' })`.

```js
// first load of a blank tab: use domcontentloaded, then look
await state.page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
```

## common patterns

**Authenticated fetches** (debug mode: human mode refuses calling the backend from page code — `net.requests()` / `net.request(id)` give the body of any request the page itself made) - fetch from within page context to include session cookies automatically:

```js
// Debug mode
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

**Clear cookies for a specific domain** (debug mode: it changes the browser's state, and human mode's CDP session only reads) — use `Network.getCookies` to fetch cookies scoped to URLs, then delete them individually with `Network.deleteCookies`:

```js
// Debug mode
const cdp = await getCDPSession({ page: state.page })
const { cookies } = await cdp.send('Network.getCookies', {
  urls: ['https://example.com', 'https://www.example.com'],
})
for (const cookie of cookies) {
  await cdp.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain })
}
```

**Downloading large data** (debug mode: it fetches from page code and adds an element to the page) - console output truncates large strings. Trigger a browser download instead:

```js
// Debug mode: fetch protected data and trigger a download to the user's Downloads folder
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

**Downloads** - a download a click starts, in this tab or in a popup it opened, appears in the action report with an id and the call that saves it: `DOWNLOAD [d1] report.csv from <url> — completed → downloads.save('d1', 'report.csv') …`. Save it, then read it:

```js
const saved = await downloads.save('d1', 'report.csv')   // { id, file, path, bytes }
const text = require('node:fs').readFileSync(saved.path, 'utf8')
```

The path is resolved from the session folder and must stay where the sandbox `fs` may write (the session folder, `/tmp`, the OS temp folder). A download still running is waited for within the call; if it does not finish, the error says so — call `downloads.save` again later. A failed download has no file and cannot be saved. `downloads.list()` lists every download of the session with its state (`downloading`, `completed`, `failed`, `unknown`). `downloads.save` copies the file when it is on this machine: headless sessions, direct-CDP sessions to a Chrome running here, and extension sessions (the user's Chrome with the relay on this machine: Chrome saves the file where its settings say, the extension finds it, and the relay hands each session its own copy). When it cannot, the `DOWNLOAD` line says why and `downloads.save` refuses with that reason (`downloads.list()` shows it as `cannotCopy`): a cloud browser or a browser on another machine saved it there; Chrome is waiting for the user to choose where to save it (its "Ask where to save each file" setting): ask the user to pick a place, then save again; or the extension could not match the download.

```js
// Debug mode: catch one yourself (download.saveAs has the same reach as downloads.save)
const [download] = await Promise.all([state.page.waitForEvent('download'), state.page.click('button.download')])
await download.saveAs(`/absolute/path/${download.suggestedFilename()}`)
```

**iFrames** - `observe()` lists what is inside each iframe (cross-site ones too) under its `[n] iframe "title"` line, with refs: act on them like any other ref, and `readPage(fn, { ref })` runs in that ref's frame. For a snapshot of one frame, pass its `Frame` (from `page.frames()`):

```js
await act.fill(31, 'ana@example.com')   // a field inside the newsletter iframe, by its ref
await snapshot({ frame: state.page.frames()[1] })
```

```js
// Debug mode: frameLocator chains locator operations
const frame = state.page.frameLocator('#my-iframe')
await frame.locator('button').click()
```

**Dialogs** - a `confirm()` / `prompt()` / `beforeunload` blocks the page until it is answered: the report says `DIALOG … is OPEN`, and `observe()` puts it first. Answer it like a person — `act.dialog.accept()` (with the text for a prompt) or `act.dialog.dismiss()`. Alerts are accepted automatically and reported.

```js
await act.dialog.accept()
```

**Handling page obstacles (cookie modals, login walls, age gates)** - most major websites show blocking overlays. `observe()` puts a modal first, with its controls under it, and marks a control behind an overlay `partly covered by …`; deal with the overlay first, the way a person would:

```js
await observe()
// MODAL dialog "We use cookies" [13] — only its controls work right now:
//   [14] button "Accept all"
//   [15] button "Reject optional"
```

```js
await act.click(15)   // then observe() again: the MODAL line is gone
```

If the page requires login and the user is already logged into Chrome, their session cookies are available — just navigate and the page should load authenticated. If not, ask the user for help or use their existing logged-in tab via `context.pages()`.

**Extracting media (images, videos)** - read the URLs from the rendered page. `naturalWidth` (like `videoWidth` and `scrollHeight`) is a live media property the page model does not carry, so this is a page function; drop the size field and it becomes `pm.query({ page: state.page, roles: ['image'], fields: ['attributes.src', 'attributes.alt'] })`:

```js
const images = await readPage(() =>
  Array.from(document.querySelectorAll('img[src]')).map((img) => ({
    src: img.src,
    alt: img.alt,
    width: img.naturalWidth,
  })),
)
console.log(JSON.stringify(images, null, 2))
```

The page loaded those images itself: `net.requests({ urlIncludes: images[0].src })` finds the request, and its body is the file. In debug mode the sandbox can also fetch it again:

```js
// Debug mode: download it again from Node (human mode refuses calling servers directly)
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
await act.click(12)
console.log(await getLatestLogs({ page: state.page, sinceLastCall: true }))  // just this action's logs
```

Three readers below (`getCleanHTML`, `getPageMarkdown`, and `snapshot`) share the same two options: `search` (string/regex — returns the first 10 matching lines with 5 lines of context) and `showDiffSinceLastCall` (default `false`; `true` returns only what changed since the last call on the same page).

**getCleanHTML** - get cleaned HTML of the page or of one element, the element's own tag and attributes included (a field or an image is not empty). `{ ref }` reads the element from Chrome's DOM agent, without running anything in the page; `{ locator: <Locator> }` reads it with Playwright's script in the page, debug mode only (`{ locator: state.page }`, the whole page, works in both modes):

```js
await getCleanHTML({ locator, search?, showDiffSinceLastCall?, includeStyles?, maxAttrLen?, maxContentLen? })
// Examples:
const form = await getCleanHTML({ ref: 12 })  // a ref from observe() or find()
const html = await getCleanHTML({ locator: state.page.locator('body') })  // debug mode only
const buttons = await getCleanHTML({ locator: state.page, search: /button/i })
const fullHtml = await getCleanHTML({ locator: state.page, showDiffSinceLastCall: false })  // disable diff
const wide = await getCleanHTML({ locator: state.page, maxAttrLen: 500, maxContentLen: 2000 })
```

`includeStyles` keeps style and class attributes (default false). Cleans HTML automatically: removes script/style/svg/head tags, unwraps empty wrappers, removes empty elements, truncates long values. Keeps semantic attributes (`href`, `name`, `type`, `aria-*`, `data-*`).

**The truncation is real and it is capped by default**: attribute values are cut at `maxAttrLen` (**200** chars) and text content at `maxContentLen` (**500**). A long `data-*` payload or a paragraph past those limits comes back cut, so raise them before concluding the page does not contain something.

**getPageMarkdown** - what is on screen, as markdown: the main content when Mozilla Readability (Firefox Reader View's algorithm) finds an article, otherwise the whole visible page. Every result starts with its source: `source: article — N words (visible page: M words)` (M > N means there is on-screen content outside the article: nav, sidebars, other panels) or `source: visible page — M words (no article: <why>)`. Hidden content never appears: inactive tab panels, `display:none` templates and errors, closed `<details>` bodies, unslotted light DOM. Shadow-DOM components (Lit, Shoelace, …) are read in flat-tree order, slotted content included — closed shadow roots too, in iframes as well; the inside of form controls and media is not content. Iframes are read inline, in page order, under `[iframe "title"]` … `[end of iframe "title"]`; one that cannot be read says why. Headings stay headings, so you can read the outline first and then one section. It runs in a private world: nothing is added to the page.

```js
await getPageMarkdown({ page: state.page, search?, outline?, filter?, showDiffSinceLastCall? })
// Examples:
const outline = await getPageMarkdown({ page: state.page, outline: true })  // headings only
const reviews = await getPageMarkdown({ page: state.page, filter: 'Reviews' })  // sections whose heading contains "Reviews"
const matches = await getPageMarkdown({ page: state.page, search: /API/i })  // the first 10 matching lines with context, then how many more were not shown
```

Output is a title line, an `Author | Site | Published` line, the excerpt as a blockquote, then the article as markdown (`#` headings, `-`/`1.` lists, `>` quotes, fenced code, table rows joined with `|`).

**waitForPageLoad** - wait until the page has settled: content stopped changing (a MutationObserver in a private world, shadow roots included) and the requests started since this call (or since this call's first action on that page) finished — the same request rules as the action report's settle (see "Waiting and busy"):

```js
await waitForPageLoad({ page: state.page, timeout?, minWait? })
// Returns: { success, readyState, pendingRequests, waitTimeMs, timedOut }
```

After an action you rarely need it: the action report already waited. For an app that keeps working for a while (an AI reply streaming in), use `act.waitForIdle()`, which also waits for busy indicators to go away.

**getCDPSession** - raw CDP on the page's own session (the same object on every call; never send `*.disable` on it, `detach()` does nothing). In human mode it only reads — `DOM.get*`, `DOM.describeNode`, `CSS.get*`, `Accessibility.*` (not `disable`), `DOMSnapshot.captureSnapshot`, `Network.getResponseBody`, `Page.getFrameTree` / `getLayoutMetrics` / `getNavigationHistory` / `captureScreenshot`; anything else (`Input.*`, `Page.navigate`, `Runtime.evaluate`, …) is refused, because `act.*` does input and navigation:

```js
const cdp = await getCDPSession({ page: state.page })
const metrics = await cdp.send('Page.getLayoutMetrics')
```

**getLocatorStringForElement** - get stable Playwright selector from an element (a ref, or in debug mode a Locator/ElementHandle):

```js
const selector = await getLocatorStringForElement({ ref: 12 })
// => "getByRole('button', { name: 'Save' })"
const same = await getLocatorStringForElement(state.page.locator('[id="submit-btn"]'))  // debug mode only
```

**getReactSource** - get React component source location (dev mode only). It reads React's fiber with one read-only call and maps React 19 `_debugStack` sites through the scripts' source maps, which playwriter fetches itself — nothing is injected into the page and the page makes no requests. A source map that exists but cannot be fetched or used is an error naming why; a script without one gives its served position:

```js
const source = await getReactSource({ ref: 12 })  // or, debug mode only: { locator: state.page.locator('[data-testid="submit-btn"]') }
// => { fileName, lineNumber, columnNumber, componentName }
```

**getReactComponentInfo** - React component info for an element: `null` when the element was not rendered by React (no fiber, no component, no debug records); an error when React is there but reading it fails (CDP failure, a source map that cannot be used). Source locations are usually only available in React dev builds. Props are sanitized and truncated so functions, DOM nodes, circular refs, and huge objects do not flood the output. For an element you have a ref for, `explain(ref)` gives the component chain with its handlers.

`fiberSnapshot({ ref })` is the same call under its trace-lane name — but `fiberSnapshot({ ref, identity: true })` is **not**: it returns a different shape carrying identity tokens for every object/function prop (held by playwriter per frame; nothing is stored on the page), which is the only way `fiberDiff` can see handler churn. A value that could not be given a token is reported by `fiberDiff` as `unobservable`, never as changed or unchanged. Use `getReactComponentInfo` to read props once; use `fiberSnapshot({ identity: true })` when you are going to diff two of them. All three take `{ ref }` (a ref from observe() or find()); their `{ locator }` form is debug mode only.

```js
const info = await getReactComponentInfo({ ref: 12 })  // or, debug mode only: { locator: state.page.locator('[data-testid="submit-btn"]') }
// => { componentName, source, hierarchy, props } | null
```

**inspectPinnedElement** - the command the extension's "Pin an element for Playwriter" puts on the clipboard. Finds the tab the element was pinned in, makes it `state.page`, and prints the element's ref, its markup and `explain()` of it (component chain, handlers, what they do). Read-only.

```js
await inspectPinnedElement({ url: 'https://example.com/cart', backendNodeId: 1234 })
```

**pickElement** - ask the user to click the element they mean. Turns on Chrome's element picker in the tab (elements highlight under their pointer; Esc cancels) and waits for the click, then prints which element it was and returns `{ ref, text }`. Nothing is added to the page. Tell the user what to click *before* the call, and give the call a long `timeout`: the wait is bounded by it.

```js
const { ref } = await pickElement({ page: state.page })   // timeoutMs defaults to what is left of the call
```

**getStylesForLocator** - raw DevTools-style listing of every matching rule (selector, source `file:line`, declarations, inherited styles). For "why is this property THIS value", prefer `debugStyle` — it resolves the cascade and names the winner plus every overridden loser. Reach for this when you want the unresolved rule list. It takes `{ ref }` (a ref from observe() or find()); the `{ locator }` form below is debug mode only. Full reference: `https://playwriter.dev/resources/styles-api.md`.

```js
const btn = await getStylesForLocator({ ref: 12 })
console.log(formatStylesAsText(btn))

// Include the browser's own default rules — off by default, and usually noise.
const withDefaults = await getStylesForLocator({ ref: 7, includeUserAgentStyles: true })

// Reuse a session you already have. Optional: the element's own session is used when you omit it
// (an out-of-process iframe's element is read in its frame's session).
const cdp = await getCDPSession({ page: state.page })
const again = await getStylesForLocator({ ref: 12, cdp })

// Debug mode only: by Playwright locator
const styles = await getStylesForLocator({ locator: state.page.locator('.btn') })
console.log(formatStylesAsText(styles))
```

**createDebugger** - set breakpoints, step through code, inspect variables at runtime (debug mode: it drives the Debugger through `getCDPSession()`, which only reads in human mode). Useful for debugging issues that only reproduce in browser, understanding code flow, and inspecting state at specific points. Can pause on exceptions, evaluate expressions in scope, and blackbox framework code. ALWAYS fetch `https://playwriter.dev/resources/debugger-api.md` first. The Debugger is enabled once per page and never disabled, and the page's own `debugger;` statements do NOT pause it: pauses are allowed only while you have armed something meant to pause — `setBreakpoint` without a provably non-pausing condition, `setPauseOnExceptions({ state: 'uncaught' | 'all' })`, `setXHRBreakpoint`, or `pauseOnDebuggerStatements({ enabled: true })`. Removing it makes the page pause-free again. Logpoints never pause. A pause nobody asked for is resumed automatically and noted.

```js
const cdp = await getCDPSession({ page: state.page })
const dbg = createDebugger({ cdp })
await dbg.enable()
const scripts = await dbg.listScripts({ search: 'app' })
await dbg.setBreakpoint({ file: scripts[0].url, line: 42 })
// when paused: dbg.inspectLocalVariables(), dbg.stepOver(), dbg.resume()
```

**createEditor** - view and live-edit page scripts and CSS at runtime (debug mode: it changes the page). Edits are in-memory (persist until reload). Useful for testing quick fixes, searching page scripts with grep, and toggling debug flags. `dryRun: true` writes nothing: for a script V8 compiles it as a check; for a stylesheet it only checks that `oldString` matches exactly once. ALWAYS read `https://playwriter.dev/resources/editor-api.md` first.

```js
const cdp = await getCDPSession({ page: state.page })
const editor = createEditor({ cdp })
await editor.enable()
const matches = await editor.grep({ regex: /console\.log/ })
await editor.edit({ url: matches[0].url, oldString: 'DEBUG = false', newString: 'DEBUG = true' })
```

**screenshotWithAccessibilityLabels** - a viewport screenshot with a colour-coded `[N]` label at the top-left of every visible element `observe()` lists. These are the same refs `act.*` takes (`act.click(5)`), and the observation text comes back with the image. The image is drawn in Node from one CDP capture, so nothing is injected into the page. It is in CSS pixels (image x/y = page x/y), downscaled only above 1568 px. `scope: ref` labels only that element and what is inside it. It refuses a background tab (Chrome paints nothing there — `observe()` still works; if a picture is needed, ask the user to switch to the tab), a pinch-zoomed page, and an observation the page has navigated or scrolled away from (observe again).

This is for **finding where things are** when position matters (grids, galleries, maps, canvas-heavy layouts). To share a screenshot with the user or save an image, use `page.screenshot()` + `resizeImageForAgent()` instead (see "taking screenshots" below). For text, `observe()` / `find()` are faster and cheaper.

```js
await screenshotWithAccessibilityLabels({ page: state.page })   // labels = observe() refs
await act.click(5)                                               // act on a ref you saw labelled

// Only one region — the labels stay legible on a busy page
await screenshotWithAccessibilityLabels({ page: state.page, scope: 12 })
```

Labels are colour-coded by role (links, buttons, inputs, checkboxes, sliders, menus, tabs). `snapshot({ locator })` cuts its tree at the locator's element (shadow DOM and same-process iframes included; pass `frame` for an iframe) without touching the page. `showAriaRefLabels` / `hideAriaRefLabels` no longer exist.

**resizeImageForAgent** - shrink an image so it consumes fewer tokens when read back into context. The resized image is automatically included in the response (visible to the LLM). `await resizeImageForAgent({ input: '/absolute/path/to/screenshot.png' })`. Also accepts `width`, `height`, `maxDimension` (default 1568 — Claude re-scales anything larger anyway), `quality` (80), `format` (default: `'png'`), `fit`, `output`. Alias: `resizeImage`.

`fit` decides what happens when you give **both** `width` and `height` and they disagree with the source aspect ratio: `'inside'` (default) preserves the ratio and fits within the box, `'cover'` fills the box and crops, `'contain'` pads, `'fill'` stretches. With only one dimension the ratio is preserved and `fit` does nothing.

**recording.start / recording.stop** - record the page as a video at native FPS (30-60fps). Uses `chrome.tabCapture` so **recording survives page navigation**. Requires user to have clicked the Playwriter extension icon on the tab. The viewport is left as it is: a fixed aspect is made afterwards (`ffmpeg -i in.mp4 -vf "pad=ceil(ih*16/9/2)*2:ih:(ow-iw)/2:0" out.mp4`); `aspectRatio: { width, height }` is an explicit opt-in that DOES perturb the page — it resizes the viewport (resize events, media queries), restores it on stop/cancel, and throws on a page with no emulated viewport. `recording.stop()` burns the pointer into the video from the inputs that were dispatched (nothing is added to the page) and returns `pointer: { drawn, samples, segments, pulses, note? }`; `pointer: false` at start turns it off, an object (`sizePx`, `fillColor`, `outlineColor`, `pulseColor`, `pulseMs`) styles it. It needs an ffmpeg with libass: left at the default without libass the pointer is skipped with a note, asked for explicitly it is an error; it is also not drawn (note, or error if explicit) when the video's shape does not match the viewport. Auto-stops after 15 min (override with `maxDurationMs`).

For demos, act through the page (`act.*`) instead of `goto()`, so the recording shows the steps a person would take.

```js
await recording.start({
  page: state.page,
  outputPath: '/absolute/path/to/recording.mp4',
  frameRate: 30, // default
  audio: false, // default (tab audio)
  videoBitsPerSecond: 2500000,
  // aspectRatio: { width: 16, height: 9 }, // opt-in: resizes the page's viewport while recording
  maxDurationMs: 15 * 60 * 1000, // default, set 0 to disable
})
```

```js
// Then one action per call, as usual: the recording survives navigation
await act.click(12)
```

```js
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

**Defaults, and the two that stop the recording on their own.** `fps` **10**, `quality` **70** (JPEG), `mode` `'screencast'`. The examples here pass `fps: 8, quality: 55` because a smaller file is usually the better trade for a bug repro — they are choices, not the defaults. Two limits end a recording without being asked: `maxDurationMs` (**10 minutes** — half the tabCapture recorder's 15) and `maxFrames` (**5000**, ≈165MB retained). Both are a hard stop, not a warning, so a long unattended repro needs them raised explicitly. `maxWidth` / `maxHeight` cap the captured frame size (Chrome scales to fit) and are unset by default, i.e. full viewport. `inputEvents: [{ action, atMs }]` seeds the input overlay with events known up front, exactly as `captions` seeds the caption track.

`recording.frameCount()` returns what the recorder has captured so far, so `frames: 0` — the change-driven-screencast failure below — is catchable while you can still do something about it. It throws when no `startCdp` recording is running, like every other member of this group.

**The pointer is drawn into the video** (`pointer`, on by default): an arrow at every position this session's mouse input went through — `act.*`, `humanMouse` paths and Playwright's own `page.mouse.*` / `locator.click()`, as dispatched — and a ring on each press and release. It is burned in at encode time from those inputs, so nothing is added to the page. `pointer: false` turns it off; `result.pointer` reports what was drawn. It needs an ffmpeg with libass, like burned captions: left at the default without libass it is skipped with a note, asked for explicitly it is an error.

**The default never takes the user's focus.** `mode: 'screencast'` (the default) records a tab the user is not looking at at full rate — measured through the extension on a backgrounded tab: 31 frames against 30 on a foreground one; over raw CDP with two real tabs in one window, **60.0 fps hidden against 59.8 fps foreground**. Screencast is change-driven, so on a visible tab the recorder takes one screenshot at start as the first frame; the encoder then holds each frame until the next one, so a page that never repaints still gives a constant-rate clip as long as the recording, with the pointer and captions drawn on every frame. A tab that is hidden at start and never repaints gives no frames at all: `wrote: false`, and `note` says why. `mode: 'auto'` and `probeMs` no longer exist; passing `'auto'` throws.

`mode: 'screenshot'` is an explicit opt-in that polls `Page.captureScreenshot` and calls `bringToFront()` on the tab first, because a screenshot of a hidden tab blocks — measured on the same rig, a 10fps poll, three runs of a 38-second hidden window:

| | foreground | tab hidden behind another | after `bringToFront` |
|---|---|---|---|
| frames captured per second | 9.95–9.97 | **0.08–0.18** | 9.95–9.96 |
| longest gap between frames | 116–129ms | **17.7–26.0s** | 118–134ms |

It never errors and never returns a stale frame; it simply *blocks*, for up to 26 seconds at a time. Ask for it only when the user is present and agrees to lose focus.

| | `screencast` (default) | `screenshot` (opt-in) |
|---|---|---|
| Source | `Page.startScreencast`, plus one screenshot at start on a visible tab | polls `Page.captureScreenshot` |
| Rate | change-driven (frame per repaint) — measured 177 frames in 3s on an animating page; frames are held between repaints | ~8.5fps through the extension, 15.3fps over direct CDP (measured) |
| Backgrounded tab | full rate, no foregrounding (measured 60fps hidden) | calls `bringToFront()` (a hidden tab blocks captures up to 26s) |

**recording.caption / recording.clearCaption** — narrate the clip so a human can follow a repro without you there. `caption(text)` stamps at call time and stays up until the next caption; `clearCaption()` blanks it. Burned into the pixels by default, because GitHub comments, Slack previews and bare `<video>` tags never show a soft subtitle track. Throws if no `startCdp` recording is running.

```js
// Call 1: start, and the first beat
await recording.startCdp({ outputPath: '/abs/path/cart-badge-bug.mp4', fps: 8 })
recording.caption('1. Cart holds 3 items, badge reads 3')
await recording.hold()                     // let the beat be readable — see pacing below
```

```js
// Each next call: the caption, then the one action it narrates
recording.caption('2. Remove every item')
await act.click(31)                        // the first row's "Remove"; one call per row
await recording.hold()
```

```js
// Last call: the broken state, alone, long enough to see
recording.caption('3. BUG: cart is empty, badge still reads 3')
await recording.hold()
recording.clearCaption()
await recording.hold({ minMs: 3000 })
const r = await recording.stopCdp()
```

**Pace it for a human, or the clip is worthless.** These videos are watched, not parsed. A caption has to sit on screen long enough to read *and* leave time to look at the page and see what changed — roughly **2–3 seconds per beat**, and the final broken state needs **3+ seconds on screen alone** (after `clearCaption()`) before `stopCdp`. **A 3-beat repro is a 12–25 second video.** One that comes out at 2 seconds is unreadable and also loses content: chips and cues that share a repaint gap get dropped, so the too-fast clip is missing beats as well as unreadable.

**`recording.hold()`** is how you pace it without guessing. It waits out whatever is left of the *current caption's* reading time — derived from the text (~17 characters/second plus 0.6s to look at the page), minus the time the action you just ran already took. Reword the caption longer and the pause grows with it; a hard-coded `waitForTimeout` does neither. `hold({ minMs })` sets a floor, `hold({ extraMs })` adds to whatever it computed.

**The derived time is clamped to 1.2s–7s, and the ceiling is not a rounding detail.** Past 7 seconds a viewer re-reads the cue instead of watching the page, so a cue that would need longer is a cue that should be **split in two** — rewording it longer stops buying you time at that point. The floor matters in the other direction: with **nothing captioned** (after `clearCaption()`) and no `minMs`, `hold()` still waits the 1.2s floor, not 0. That is deliberate — a blank final frame flashing past is not a final state — but it means `hold()` alone is nowhere near the 3+ seconds the broken state needs. Say `hold({ minMs: 3000 })`. The returned `HoldResult` reports exactly what happened: `waitedMs`, `readableMs` (0 when nothing was captioned), `onScreenMs`, `heldForMs`, and a `note` explaining the floor when it applied.

**`stopCdp()` tells you if you got it wrong.** When any cue was on screen for less than its text needs, the result carries `captionPacingWarning` (prose, also leading `captionNote`) and `captionPacing` (`{ cues, cuesTooFast, narrationNeedsMs, videoDurationMs, shortfallMs, readingRateCps }`). **Read it before handing the file to anyone.** The only fix is to re-record with pauses — do not slow the video down or stretch frame timing, because in a bug repro the timing between frames is the evidence.

`stopCdp()` also adds `captions[]` (resolved cues in VIDEO time), `videoStartOffsetMs`, `videoDurationMs`, `captionRender`, `captionFiles`, `captionStripHeightPx` (rows of caption strip appended below the page — crop it off to recover the page exactly). **Video time 0 is the first repaint, not the recording start** — `videoStartOffsetMs` is the gap, and captions are shifted by it automatically. Any cue that was moved, shortened, truncated or dropped says so in its `adjustments` — including how many ms short of readable it was and what cut it off.

- `caption(text, { atMs, durationMs })` — `atMs` (ms from recording start) overrides the stamp time when you know the real instant; `durationMs` ends a cue early instead of running it to the next. Returns the stamp with the text as it will be wrapped.
- `startCdp({ captions: [{ text, atMs, durationMs? }] })` for a script known up front. Live captions merge into it.
- `captionOptions.render`: `'burn'` (default) | `'soft'` (mov_text track) | `'sidecar'` (`.srt` beside the mp4), or an array to combine. With `'sidecar'`, `sidecarFormats` picks the files (`['srt']` by default; `'vtt'` also available).
- **Burned captions are drawn in a strip APPENDED BELOW the page, not over it.** The encoded video is taller than the page it recorded — `stopCdp()` reports how much as `captionStripHeightPx` — and **the page area of every frame is exactly the pixels the page showed**. Nothing is ever hidden by narration. Two consequences worth knowing: the mp4's dimensions are not the viewport's, and a clip with no burned captions gets no strip at all and is byte-for-byte the video this recorder always produced.
- **This replaced a full-frame-width opaque band drawn over the page.** The band existed to stop overlay text landing beside page text and reading as a word in NEITHER layer (measured on a dense page: a caption line ending in `charge` next to a surviving page `s` read as `charges`). It worked, and it cost two full rows of page content at the bottom of the frame — where status text, totals, toasts and error messages live. The strip keeps the guarantee and takes the rows from the canvas instead: caption ink and page pixels are in disjoint regions, so no page glyph can share a scanline with a caption glyph, whatever the page is.
- `captionOptions` styling: `fontName` (`'DejaVu Sans'`), `fontSizePct` (5 of the PAGE height, floored at 16px), `textColor` (**black**), `stripColor` (`#E8E8E8`), `stripRuleColor` (`#707070`, the hairline between page and strip), `outlineColor` (defaults to `stripColor`, i.e. no visible outline — there is nothing behind the text to hide from), `outlineWidth`, `shadow` (1), `boxed`, `maxCharsPerLine` (42), `maxLines` (3). There is no `marginBottomPct` any more: the strip is sized to the caption, so there is nothing to margin against.
- **The strip is one fixed height for the whole clip**, sized to the tallest cue in it. Fixed because a moving page/narration boundary reads as the page shifting; sized to the tallest cue rather than to `maxLines` so a one-line clip does not carry three lines of empty strip.
- `captionOptions` pacing: `readingRateCps` (17; lower it for CJK), or `minDurationMs` to **replace** the reading model with one flat floor for every cue — it is not combined with the model, so a caller who genuinely wants 400ms cues gets them. `maxCaptions` refuses more than N cues, so a looping caller cannot grow the result unbounded.
- A caption can only show on a frame that exists. Two captions inside one repaint gap collapse to the later one, and the loser is reported as dropped — space narration across actions that actually change the page.

**Input overlay** (`inputOverlay: true`, off by default) — a small NohBoard-style strip of key/button chips burned into a corner, so a viewer sees *what you pressed*, not just what happened. Nothing else to wire: setting the option arms the capture for you.

```js
await recording.startCdp({
  outputPath: '/abs/path/shortcut-bug.mp4',
  mode: 'screenshot',            // keeps chips on frames while typing — but it foregrounds the tab, see above
  inputOverlay: true,
})
```

```js
await act.press('Control+A')    // chip: Ctrl+A (the next calls: one input each, each with its chip)
```

```js
const r = await recording.stopCdp()   // r.inputEvents[] in VIDEO time
```

- **Captures** every input this session drives through Playwright — `click`/`dblclick`/`hover`/`fill`/`type`/`press`/`check`/`selectOption`/`setInputFiles`/`focus` on `page`, `locator`, `frame` or `ElementHandle`, plus all of `page.keyboard.*` and `page.mouse.*`. A chip appears only when the action SUCCEEDS; one that timed out or threw gets none, because it never happened.
- **Does NOT capture**: a real human typing or clicking in the browser (nothing reaches this process); input the page synthesises itself (`el.dispatchEvent(new KeyboardEvent(…))`); raw `cdp.send('Input.dispatch…')`; and `page.mouse.move()`, which is movement, not a press — the pointer layer already shows it.
- **Layout**: a single row in the **bottom-right**, ON the page. Bottom-right because page content is top- and left-anchored — a top-left overlay lands on the nav, the heading and the first form field. The chips deliberately stay on the picture even though the caption left it: a NohBoard-style keystroke HUD that is not on the recording is not a keystroke HUD, and a chip's position is itself information about where the input landed. They are therefore **the only thing that still covers page content**, one line tall in the emptiest corner. Chips and captions are now in disjoint regions of the frame and cannot overlap at all.
- **The chip strip sits on an opaque merge plate**, for the same reason the caption sits on a band: overlay text landing beside or on top of page text makes the composite read as a word in NEITHER layer. The chips cannot have the caption's full-frame-width band — a bar behind a corner HUD would be worse than the defect — so they get three narrower guarantees instead. The plate is **opaque**, so nothing of the page survives under a chip. It runs to the **frame edge it is anchored to**, so on a chip's own scanlines there is no page pixel on that side at all. And it extends a **measured clear distance inboard** (1.5 chip faces; measured, two glyph runs stop reading as one word at about twice the page's own inter-word gap, and the 3px that shipped is narrower than a 12px page's 4px space). The first two are proofs; the third holds for page text up to about 2.1x the chip face. Lowering `boxOpacity` gives that up.
- **`mode: 'screenshot'` keeps chips moving, and it foregrounds the tab.** A burned overlay only exists on frames that exist, and typing into a field that renders nothing produces no screencast frame at all. The overlay compensates by forcing one `captureScreenshot` per event (`captureFrameOnEvent`, on by default, reported in `note`), but polling is what actually keeps the clip moving. The cost is that this mode calls `bringToFront()` once before polling — it has to, see the foreground table above. If the user must not lose focus, keep the default `mode: 'screencast'` and accept that chips land only on frames the page itself produced, plus the one forced per event.
- **Typed text is HIDDEN by default** — `fill`/`type`/`insertText` render as `Fill ••••••`, a fixed six dots, so not even the length leaks. `inputOverlayOptions.revealTypedText: true` shows it, and even then a target that looks like a secret (`#password`, `[name=otp]`, `#api_key`, …) stays masked. Every mask is named in that event's `adjustments`.
- **Rapid sequences**: consecutive single-character keys within `coalesceWindowMs` (400) merge into one chip (`abcdefghij`). Beyond that the row holds at most `maxVisible` (4) chips — fewer if they would not fit across the frame — and retires the oldest early. Chords are one chip (`Ctrl+Shift+K`), never three. A chip stays up `dwellMs` (1600) — less than a caption, because a key name is a glance and not prose. Four inputs in one beat (fill, fill, click, press) fit without shedding; cram in more and the retired chip's `adjustments` say whether anyone could have seen it.
- `stopCdp()` adds `inputEvents[]` — `{ index, kind, label, startMs, endMs, atMs, coalescedCount?, dropped?, adjustments[] }` — plus `inputOverlayNote`. Read `adjustments` for coalescing, truncation, redaction, early retirement and drops.
- `inputOverlayOptions`, complete with defaults: `position` (`'bottom-right'`), `layout` (`'row'`; `'stack'` puts one chip per line when labels are long), `fontName` (the caption font, so one recording reads as one thing), `fontSizePct` (2.4, against the caption's 5), `textColor` (`#FFFFFF`), `boxColor` (`#000000`), `boxOpacity` (**1** — the plate has to cover the page, not tint it; see the merge plate above), `marginPct` (3, the distance from the anchored edges to the chip's LETTERS — the plate itself runs to the edge), `dwellMs` (1600), `maxVisible` (4), `coalesceWindowMs` (400), `maxLabelChars` (26, then the chip is elided and says so in `adjustments`), `maxEvents` (300 — further events are **refused**, not silently dropped), `revealTypedText` (false), `captureFrameOnEvent` (true whenever the overlay is on and the path is screencast).
- The overlay is pixels only — there is no soft or sidecar form — so it needs an ffmpeg with libass regardless of `captionOptions.render`.

**When to use the other recorder instead:** `recording.start` (tabCapture) gives true compositor output at a higher, fixed frame rate and survives navigation. It needs one extension-icon click per tab, so prefer it when a human is present and picture quality matters; prefer `startCdp` when nothing can click.

**ghostCursor.show / ghostCursor.hide** - a live cursor drawn INSIDE the page, for a human watching the tab. Off unless you call `show()`, and `show()` modifies the page: it adds a cursor element and a global, which a page that watches its own DOM can see — so human mode refuses it. Recordings do not need it: `recording.startCdp` draws the pointer into the video without touching the page. `hide()` removes both.

```js
await ghostCursor.show({ page: state.page, style: 'screenstudio' }) // debug mode only. 'minimal' (default), 'dot', 'screenstudio'
await ghostCursor.hide({ page: state.page })
```

## humanMouse — real human pointer motion (opt-in, off by default)

**This is a behaviour change, not a visual polish.** A recording's pointer layer only draws; `humanMouse` moves the *actual* CDP pointer along a sampled trajectory. Every element between origin and target therefore receives real `mouseover` / `mouseenter` / `mousemove`. That can open dropdowns, fire tooltips, dismiss popovers, start hover-intent timers and change what the page does. It is more realistic **and** it is a genuine way to make a working automation start failing. Turn it on deliberately, per action, and read `crossed` when something moves that you did not expect.

Ordinary Playwright teleports: one `Input.dispatchMouseEvent` at the destination. Nothing in between is ever hovered.

Point it at a ref from `observe()` / `find()` (`{ ref }`: the element's box is read over CDP and its tab is the page), or at `{ x, y }`. `{ locator }` measures the element with Playwright's script in the page (`locator.boundingBox()`) and is debug mode only, as is `enable()`.

```js
// One move. Returns the full accounting — never assume it went to plan.
const res = await humanMouse.moveTo({ ref: 12, reportCrossings: true })
console.log(res.plannedDurationMs, res.achievedDurationMs, res.durationDriftMs)
console.log(res.crossed?.map((c) => c.description))  // what the path actually hovered
console.log(res.warnings)                            // non-empty = something did not match the model

// Move + press at the element's centre (the largest visible part of its box).
await humanMouse.click({ ref: 12 })

// Debug mode only: with a locator the press is delegated to locator.click(), so Playwright's
// actionability, hit-target interception and retry loop all still run.
await humanMouse.click({ page: state.page, locator: state.page.locator('#save') })

// Debug mode only: make every locator.click/dblclick/hover on THIS page take a human route first.
await humanMouse.enable({ page: state.page })
await state.page.locator('#save').click()   // human move, then the normal click
humanMouse.isEnabled({ page: state.page })  // → true. Synchronous, and per page
await humanMouse.disable({ page: state.page })

// Plan without moving — pure and deterministic, for assertions or inspection.
const plan = await humanMouse.plan({ page: state.page, x: 900, y: 500, seed: 42 })

// Where the driver believes the pointer is. `hover` is an alias of `moveTo` —
// with no button pressed, the move IS the hover.
const at = await humanMouse.position({ page: state.page })
await humanMouse.hover({ ref: 7 })
```

`humanMouse.defaults` is the mutable option bag every call falls back to — `{ seed, sampleRateHz, maxSamples, tuning, reportCrossings }`. Setting `humanMouse.defaults.reportCrossings = true` once is how you get the crossing report on every move without repeating it. `enable({ page, …defaults })` stores a *separate* set of defaults for the patched clicks on that page.

The crossing recorder listens in a private world, so the page sees nothing of it. If it cannot be armed the move throws; if the page navigates during the move, `crossed` is `undefined` and `warnings` says the crossings of the old document were lost.

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

- `humanMouse.click({ locator })` (debug mode) does the human move, then calls `locator.click()`. Playwright then runs its own actionability and its own move to the element centre — but the pointer is already there, so that move is zero-distance and contributes one extra `mousemove` at the resting point and nothing else. **Actionability is not bypassed.**
- `humanMouse.click({ ref })` and `humanMouse.click({ x, y })` run no Playwright actionability: they press where the pointer now is. A ref's point is the centre of the largest part of its box inside the viewport; an element outside the viewport is refused (`act.scrollTo(ref)` first). For a click with cover and disabled checks and an action report, use `act.click(ref)`.
- `humanMouse.enable()` patches `Locator.prototype.click/dblclick/hover` but the patch is **scoped to the pages you enabled** — other sessions sharing the relay process are unaffected, and `disable()` genuinely restores the old behaviour.
- When `ghostCursor.show()` is on (debug mode), its overlay receives the whole polyline in one call and plays it back on the page's own rAF clock with CSS transitions off, so the drawn cursor traces the same curve as the real pointer instead of easing a transition behind it. Recordings get the same path from the pointer track, as dispatched.

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

`moveTo` / `click` / `hover` / `plan` take: `{ locator }` or `{ x, y }`; `page`, `position` (offset within the element), `from` (override the origin — the real lever for keeping a path out of a hazard corridor), `seed`, `sampleRateHz` (60), `maxSamples` (260 — binding reduces the *rate*, preserving the profile's shape, and says so), `tuning` (any Fitts/curvature/tremor/submovement parameter), `reportCrossings`, `includeTrajectory`, `heldButton` (for drags: press first with `page.mouse.down()`, move with `heldButton`, then `page.mouse.up()` — every move in between carries the held button, so the page sees one continuous drag and the release lands at the target). `click` also takes `button`, `clickCount`, `delayMs`.

There is deliberately **no** "route around this element" option. A real user's hand does not dodge invisible rectangles, so a dodging path is less human, not more. If a hover hazard sits on the line, either start the move somewhere else (`from`) or do not use human motion for that action.

**createDemoVideo** - speeds up idle sections (time between execute() calls) while keeping interactions at normal speed. Requires `ffmpeg`/`ffprobe`. Timestamps are tracked automatically during recording and returned by `recording.stop()`. **Timeout**: can take 60–120+ seconds, so always send `timeout: 120000` (or higher) alongside `code` in this `execute` call — `timeout` is the second parameter of the `execute` tool, and its 30000ms default will kill the encode midway.

Save the whole `recording.stop()` result to `state` (shown above) — its `executionTimestamps` are what drive idle detection.

```js
// SEPARATE execute call, sent with timeout: 120000 in the execute arguments:
const demoPath = await createDemoVideo({
  recordingPath: state.recordingResult.path,
  durationMs: state.recordingResult.duration,
  executionTimestamps: state.recordingResult.executionTimestamps,
  speed: 6, // default 6x for idle sections
})
```

## pinned elements

The user can point at an element instead of describing it: right-click the page (or the extension icon) → **Pin an element for Playwriter**, then click the element in Chrome's element picker (Esc cancels). Nothing is injected into the page.

- `observe()` lists pins under `PINNED`, newest first: the ref of the element, of the control the point is inside, or the text it is on. A pin whose element is gone is reported once, then dropped.
- The clipboard gets `playwriter -e 'inspectPinnedElement({"url":…,"backendNodeId":N})'`; pasted into the chat, it is the command for you to run.
- **Copy React component source (click an element next)**, in the same menu, puts the `file:line` of the JSX that rendered the clicked element on the clipboard.
- `pickElement()` is the same picker started by you, waiting for the click (see utility functions).

## taking screenshots

In human mode `page.screenshot()` is refused: Playwright prepares the page with its own script, as a user gesture, and by default writes `caret-color` into the inline style of every text field while it shoots. Take the pixels from the browser instead — `screenshotWithAccessibilityLabels({ page: state.page })` (labels drawn into the image, not the page), or plain:

```js
const cdp = await getCDPSession({ page: state.page })
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
require('node:fs').writeFileSync('/absolute/path/to/shot.png', Buffer.from(data, 'base64'))
```

In debug mode `page.screenshot()` works; always use `scale: 'css'` to avoid 2-4x larger images on high-DPI displays, and `caret: 'initial'` to keep it from styling the page:

```js
// Debug mode
await state.page.screenshot({ path: '/absolute/path/to/shot.png', scale: 'css', caret: 'initial' })
```

If you want to read back the image file into context, resize it first so it consumes fewer tokens:

```js
await resizeImageForAgent({ input: '/absolute/path/to/shot.png' })
```

## readPage

`readPage(fn, { ref, arg, page })` runs `fn(el, arg)` in the page and returns what it returns. It is the page function of human mode, and works the same in debug mode.

- **Where:** in the page's own JavaScript world (`window.__NEXT_DATA__`, a store's state and the page's globals are visible), in the frame of the element of `ref` — `document` is that frame's document. Without a ref, `el` is the `document` of `page` (default: the current page).
- **Read-only, enforced by Chrome:** it runs under V8's side-effect check (the one DevTools' eager evaluation uses) and without a user gesture. Anything that could change the page stops it before it happens — DOM, style and storage writes, focus, scrolling, events, requests, timers, promises, writes into the page's objects, a page function that caches, logs or reads `arguments`. Chrome does not say where it stopped; readPage finds out by running the function again under the same check, and the error shows the call in your code with why and what to read instead: ``It stopped in `window.siteConfig.get('title')` (line 3)`` … ``Object.keys(window.siteConfig) lists what window.siteConfig holds.`` Read the data the page's function would have read (`window.siteConfig.values.title`).
- Some reads Chrome has not marked read-only are routed to exact equivalents for you: `closest`, `matches`, `getRootNode`, `getElementById`, `isSameNode`, `localStorage.getItem` / `key`, `rect.toJSON()`, `getPropertyValue` of standard properties, `location.toString()`, `Object.fromEntries`, `Object.assign`, `{ ...spread }`. Still refused: `getClientRects`, `elementFromPoint`, `checkVisibility`, `matchMedia`, `new URL` (use `a.pathname` / `a.search` / `location.*`), `getPropertyValue('--custom')`, object rest (`{ a, ...rest } = obj`), `arguments`.
- **Synchronous, and bounded.** No `async`/`await`. It may run 5 s: a loop waiting for the page to change never ends (the page cannot run while your function does) — read, `act.waitForIdle()`, read again. A function of the page that never returns, or a regular expression that backtracks without end, is stopped by Chrome 6 s after the read started; the page goes on, untouched.
- **With a ref, Chrome's console helpers exist while it runs** (`$`, `$$`, `$x`, `$_`, `keys`, `values`, `copy`, `inspect`, `dir`…, as in the DevTools console): that is how the element reaches your function. They are gone when it returns. Test for a library by its own name (`window.jQuery`), not by `$`.
- **Data in, data out.** `fn` cannot see your code's variables: pass them as `{ arg }` (JSON data). It returns JSON data; an element, an array of elements or a NodeList comes back as `{ ref, text }` entries (the ref observe() uses, or what contains the element). `console.log` inside prints with the call's output.

```js
// The price in the row of [12]
await readPage((el) => el.closest('tr').querySelector('.price').textContent, { ref: 12 })
// App state the page keeps in a global
await readPage(() => window.__NEXT_DATA__.props.pageProps.cart.items.length)
// Values in, refs out: every result link whose text has the word
await readPage((doc, word) => [...doc.querySelectorAll('.results a')].filter((a) => a.textContent.includes(word)), { arg: 'mouse' })
```

## page.evaluate

Debug mode. Human mode refuses `page.evaluate` (Playwright runs it as a user gesture): use `readPage`. Code inside `page.evaluate()` runs in the browser - use plain JavaScript only, no TypeScript syntax. Return values and log outside (console.log inside evaluate runs in browser, not visible). Use it only for the five cases in "reading a page: pick the narrowest tool" — never to count or describe elements, which is `pm.query`'s job:

```js
// Reading non-DOM JS state — nothing else can see this
const info = await state.page.evaluate(() => ({
  url: location.href,
  config: window.__CONFIG__ ?? null,
  next: window.__NEXT_DATA__?.buildId ?? null,
}))
console.log(info)

// Mutating page state — debug mode only (human mode refuses it)
await state.page.evaluate(() => localStorage.clear())
await state.page.locator('.scrollable-list').evaluate((el) => { el.scrollTop += 500 })
```

## loading files

Fill inputs with file content — in human mode type or paste it into the field's ref, in debug mode a locator works too:

```js
const fs = require('node:fs')
const content = fs.readFileSync('./data.txt', 'utf-8')
await act.fill(12, content, { paste: true })                // any mode: a ref from observe()
await state.page.locator('textarea').fill(content)         // debug mode only
```

## network interception

**Observing is always allowed; faking is not (human mode).** Every request the page makes is already journaled: `await net.requests({ urlIncludes: '/api/' })` lists them (method, url, status, timing, `r…` id), `await net.request('r12')` returns one response body (cut at 64K characters, with `truncated` set), and `await net.save('r12', 'file.png')` writes the whole body to a file — decoded to bytes, under the same folder rules as `downloads.save`; it returns `{ id, path, bytes, status, mimeType }`, and a redirect, a failed request or a body Chrome dropped gets the same reason `net.request` gives. Listeners like the ones below also only observe. What human mode refuses is changing traffic — `page.route`, `fulfill`, `net.delay`, `routeWebSocket` — because a bug "reproduced" through faked responses is not one a user can hit; those need a debug session (`--policy debug`). For scraping or reverse-engineering APIs, listening beats scrolling the DOM. Store results in `state` to analyze across calls:

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

Replay API directly (useful for pagination) — debug mode only: human mode refuses calling the backend from page code:

```js
// Debug mode
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

In human mode act on refs — `act.click(ref)`, `act.hover(ref)`, `act.scrollTo(ref)` / `act.scroll('down', { ref })`, `act.drag(from, to)` — and use the raw `page.mouse` / `page.keyboard` calls below only where there is no element to name (a canvas, a map, a drawn stroke), one input per call; they run in both modes and are reported as raw Playwright. The locator forms (`locator.click()`, `.hover()`, `.dragTo()`, `.scrollIntoViewIfNeeded()`, `locator.evaluate`), `setViewportSize` and `page.screenshot` run Playwright's script in the page or force a state, so they are debug mode only.

### clicking

```js
// By coordinates, one per call (when there is no element to name, e.g. canvas, maps, custom widgets)
await state.page.mouse.click(450, 320) // left click; { button: 'right' }, { clickCount: 3 }, { modifiers: ['Shift'] } as needed
```

```js
// Debug mode: by locator (stable, auto-waits, no coordinates needed), or several clicks in one call
await state.page.locator('button[name="Submit"]').click()
await state.page.locator('text=Login').click({ button: 'right' })
await state.page.locator('text=Login').dblclick()
await state.page
  .locator('a')
  .first()
  .click({ modifiers: ['Meta'] }) // cmd+click opens link in new background tab
await state.page.mouse.dblclick(450, 320) // double click
```

### hover

```js
await state.page.mouse.move(450, 320) // by coordinates
```

```js
await state.page.locator('.tooltip-trigger').hover() // by locator (debug mode)
```

### scroll

```js
// By pixel, one wheel turn per call (for canvas, maps, infinite scroll); over an element, act.scroll('down', { ref }) aims for you
await state.page.mouse.wheel(0, 300) // down 300px; (0, -300) up, (300, 0) right, (-300, 0) left
```

```js
// Debug mode: by locator, at a position, or from page code
await state.page.locator('#footer').scrollIntoViewIfNeeded()
await state.page.mouse.move(450, 320)
await state.page.mouse.wheel(0, 500)
await state.page.locator('.scrollable-list').evaluate((el) => {
  el.scrollTop += 500
})
```

### drag

```js
await act.drag(12, 18)   // from the element of [12] onto [18], with a held button and a person's path
```

```js
await act.drag(31, { ref: 30, x: 300, y: 12 })   // custom slider: thumb [31] onto 75% of its 400px track [30]
```

```js
// Debug mode: by locator, or by coordinates (several inputs in one call)
await state.page.locator('#item').dragTo(state.page.locator('#target'))
await state.page.mouse.move(100, 200)
await state.page.mouse.down()
await state.page.mouse.move(400, 500, { steps: 10 }) // steps for smooth drag
await state.page.mouse.up()
```

**Freehand drawing, annotation widgets, and canvas tools** need a held-button stroke, not a click. In human mode a stroke is one action — `act.drag` between two points of the element, each a ref with an `x`/`y` offset into its box:

```js
await act.drag({ ref: 40, x: 20, y: 30 }, { ref: 40, x: 260, y: 140 })   // a stroke across canvas [40]
```

x/y are CSS px from the top-left of the element's border box as laid out, x from 0 up to, not including, the width and y from 0 up to, not including, the height (the far edges are outside it; for a slider's maximum use `x: width - 1`); rotated, scaled and perspective-tilted elements are mapped through their transform. An offset outside that range is refused and the refusal gives the box size. Both points are hit-tested; the from-point is wheeled into view first (a point by the page edge or at the end of a list needs no scrolling), the to-point must already be visible.

```js
// Debug mode: the raw stroke, several inputs in one call
await state.page.mouse.move(startX, startY)
await state.page.mouse.down()
await state.page.mouse.move(endX, endY, { steps: 15 }) // steps = smoother stroke
await state.page.mouse.up()
await state.page.waitForTimeout(500) // let the widget process the stroke
```

### key hold / release / repeat

```js
// Hold a modifier while pressing another key: one chord, one action
await act.press('Shift+ArrowDown')
```

```js
// Debug mode: hold and release as separate inputs, or repeat a key in a loop
await state.page.keyboard.down('Shift')
await state.page.keyboard.press('ArrowDown')
await state.page.keyboard.up('Shift')
for (let i = 0; i < 5; i++) await state.page.keyboard.press('ArrowDown')
```

### resize viewport (debug mode)

```js
// Debug mode
await state.page.setViewportSize({ width: 1280, height: 720 })
```

### region screenshot (zoom equivalent)

```js
// Debug mode:
await state.page.screenshot({ path: '/absolute/path/to/region.png', scale: 'css', clip: { x: 100, y: 200, width: 400, height: 300 } })
// Any mode: the browser's own capture of the region
const cdp = await getCDPSession({ page: state.page })
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 100, y: 200, width: 400, height: 300, scale: 1 } })
require('node:fs').writeFileSync('/absolute/path/to/region.png', Buffer.from(data, 'base64'))
```

In debug mode prefer locator-based actions over coordinates — locators are stable across scroll/resize, auto-wait for elements, and don't require screenshot round-trips that burn ~800 image tokens per cycle. In human mode refs from `observe()` give the same without a screenshot.

## Ghost Browser integration

When running in [Ghost Browser](https://ghostbrowser.com/), the `chrome` object exposes APIs for multi-identity automation (identities, proxies, sessions). See `extension/src/ghost-browser-api.d.ts` for full API reference. Only works in Ghost Browser — calls fail in regular Chrome.

## debugging playwriter itself

When the failure is in playwriter rather than in the page — an internal error, a call that never returns, an extension that will not attach — the relay writes two logs into the user's home directory. Both are recreated every time the server starts, so they describe the current run only:

- `~/.playwriter/relay-server.log` — the extension, the MCP server and the WS server, interleaved. Read it with grep/rg rather than whole.
- `~/.playwriter/cdp.jsonl` — every CDP command, response and event, with long strings truncated.

(`playwriter logfile` prints both paths if the CLI is on PATH.) To summarise CDP traffic by direction and method:

```bash
jq -r '.direction + "\t" + (.message.method // "response")' ~/.playwriter/cdp.jsonl | uniq -c
```

If it turns out to be a playwriter bug, report it with `gh issue create -R remorses/playwriter --title title --body body`. Ask the user to confirm before opening one.
