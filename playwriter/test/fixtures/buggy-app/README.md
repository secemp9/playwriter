# buggy-app fixture

A tiny **Vite + React + TypeScript** app used as an end-to-end fixture for the
trace/debug feature. Each of the nine tabs exhibits exactly **one** canonical,
realistically-written bug so a static + runtime program slice has something real
to trace back through source maps into the author's TypeScript. The bugs are
catalogued in "The nine bugs" below.

## Not part of the pnpm workspace

The repo's `pnpm-workspace.yaml` globs are `./*` and
`playwright/packages/playwright-core`. `./*` only matches **immediate** children
of the repo root, so this deeply-nested package
(`playwriter/playwriter/test/fixtures/buggy-app`) is **never** picked up by the
workspace, and its dependencies are **not** installed by the root `pnpm install`.

Install and build it **standalone with plain npm** — do not run pnpm here:

```bash
cd playwriter/test/fixtures/buggy-app
npm install          # standalone install, NOT `pnpm install`
npm run build        # tsc --noEmit && vite build  ->  emits dist/ with *.js.map
npm run preview      # static server on http://localhost:4318  (strict port)
# or during development:
npm run dev          # dev server on http://localhost:4317
```

### Source maps

`vite.config.ts` sets `build.sourcemap = true`, so `npm run build` emits both
the bundle and its map:

```
dist/assets/index-*.js
dist/assets/index-*.js.map
```

Verify with `ls dist/assets/*.map`.

## Ports

| Command           | URL                     |
| ----------------- | ----------------------- |
| `npm run dev`     | http://localhost:4317   |
| `npm run preview` | http://localhost:4318   |

## Redux-ish store probe

`src/store/cartStore.ts` is a hand-rolled minimal store (no `redux` dependency)
exposed on `window.__STORE__` with `getState()` for a `storeIdentity` probe.

## The nine bugs

| Tab           | Bug | One-line description                                                                                                       | Culprit source                                  | Symptom testid  | Trigger testid                    |
| ------------- | --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------- | --------------------------------- |
| Cart          | a   | **Mutating reducer**: `ADD_ITEM` does `state.items.push(...)` / `state.total += ...` and returns the **same reference**, so the reference-equality snapshot (`useSyncExternalStore`) never re-renders → **stale total**. | `src/store/cartStore.ts` (reducer `ADD_ITEM`) + `src/components/CartTotal.tsx` | `cart-total`    | `add-item`                        |
| Orders        | b   | **Bad date parse**: `formatDate` assumes `DD/MM/YYYY` and `split('/')`, but the API returns ISO 8601 → **"Invalid Date"**. Util lives in a separate module (cross-module + interprocedural hop). | `src/utils/date.ts` (`formatDate`)              | `order-date`    | — (renders on load)               |
| Search        | c   | **Async fetch race**: one fetch per keystroke in a `useEffect` keyed on `query` with **no abort / sequence guard**; the mock resolves shorter queries slower, so a stale earlier response overwrites a newer one (last-write-wins). | `src/components/SearchList.tsx` (the effect) + `src/utils/mockApi.ts` | `search-list`   | `search-input`                    |
| Notifications | d   | **Missing effect dependency**: `useEffect(() => setBadge(computeBadge(unreadCount)), [userId])` reads `unreadCount` but only lists `userId`, so the badge goes **stale** when the count changes. | `src/components/NotificationBadge.tsx` (the effect) | `unread-badge`  | `mark-read` (also `switch-user`)  |
| Modal         | e   | **Disappearing modal**: a settings modal auto-closes at unpredictable times. `useEffect` cleanup fires prematurely during Strict-Mode double-mount. The "Save" button starts a 50ms close timeout AND triggers a re-render that starts a new timeout without cancelling the old one, so multiple timers race. | `src/components/DisappearingModal.tsx` (the effect + handleSave) | `settings-modal` | `open-modal-btn` (observe); `modal-save-btn` (trigger race) |
| Overlay       | f   | **Ghost overlay**: a full-viewport promotional banner has `position:absolute; opacity:0; background:transparent` but **no** `pointer-events:none`, so it intercepts all clicks on elements below. The "Dismiss" link inside the overlay has `z-index:1` but is a child of the overlay, so the overlay still catches clicks. | `src/components/GhostOverlay.tsx` (the overlay div) | `cta-button` / `dismiss-banner` | `cta-button` (click does nothing) |
| Counter       | g   | **Stale counter + localStorage**: `useEffect(() => localStorage.setItem('count', count), [])` has empty deps, so it only writes the initial count once. A "Reset" button uses `useCallback` with empty deps, capturing a stale `count` permanently — reset saves the old value to the simulated server. | `src/components/StaleCounter.tsx` (empty deps + stale closure in handleReset) | `stale-count-display` | `increment-btn` then `refresh-btn` (or `reset-stale-btn`) |
| Form          | h   | **Race condition form**: `setInterval` auto-save on mount captures empty initial `name`/`email` (stale closure — empty deps), so every 5s it sends `{name:"", email:""}`. The manual "Save Draft" debounce timer is not cancelled on unmount, and stacking debounces fires out of order — older saves overwrite newer ones. | `src/components/RaceConditionForm.tsx` (stale interval closure + debounce timer leak) | `save-status` / `auto-save-indicator` | `name-input` / `email-input` (type); `save-draft-btn` (manual save) |
| Layout        | i   | **Disappearing grid item**: a product grid with `grid-template-rows: repeat(3, 200px)` inserts a 150px ad banner after 2s. Instead of reflowing, the 3rd product gets `display:none` (in-component logic), leaving only 5 of 6 products visible. The grid tracks are fixed so no reflow occurs. | `src/components/LayoutShift.tsx` (fixed grid rows + in-component hide logic) | `product-grid` / `product-2` (hidden) | Wait 2s for ad to load; observe 5 products instead of 6 |

### Tab nav testids

`tab-cart`, `tab-orders`, `tab-search`, `tab-notifications`, `tab-modal`, `tab-overlay`, `tab-counter`, `tab-form`, `tab-layout`.

## Notes for the e2e test

- Bug (a): click `add-item`; `cart-total` stays `$0.00` while `window.__STORE__.getState().total` actually increments.
- Bug (b): open Orders; `order-date` reads `Invalid Date`.
- Bug (c): type into `search-input` quickly (e.g. `r`, `re`, `rea`, `reac`); `search-list` can settle on results for a stale query.
- Bug (d): click `mark-read` repeatedly; `unread-badge` stays `—`/stale until `switch-user` forces the effect to re-run.
- Bug (e): open the modal via `open-modal-btn`; type in `modal-input`; click `modal-save-btn`; observe the modal disappear at an unpredictable time (immediately, or after a few seconds).
- Bug (f): open the Overlay tab; try clicking `cta-button` (nothing happens); try clicking `dismiss-banner` (nothing happens).
- Bug (g): open the Counter tab; click `increment-btn` a few times; click `refresh-btn` — the displayed count reverts to the stale localStorage value. Or: increment, then click `reset-stale-btn` — count goes to 0 but the server saved the pre-reset value.
- Bug (h): open the Form tab; type "Alice" into `name-input` and "alice@example.com" into `email-input`; wait 5s for the auto-save (`auto-save-indicator` shows `name="", email=""`). Click `save-draft-btn` multiple times quickly — `save-status` may show stale/out-of-order values.
- Bug (i): open the Layout tab; immediately observe 6 products; wait 2s for the ad to load; `product-2` (3rd item) is now hidden — only 5 products visible in the grid.
