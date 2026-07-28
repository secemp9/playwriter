// Dev-only prelude, injected verbatim at the TOP of dist/background.js by the
// `dev-resilient-reload` vite plugin (dev builds only — see vite.config.mts).
//
// Plain JS on purpose: it is concatenated into the emitted bundle, so it must need
// no compilation and no imports.
//
// Why it lives ahead of the app body, with the body wrapped in try/catch:
// Chrome stops delivering events — alarms included — to a service worker that THREW
// during evaluation. Verified: with an unguarded top-level throw an alarm created
// moments earlier fired 0 times in 100s; with the throw inside try/catch it fired 3.
// So a reloader that lives inside (or after) breakable code dies with it, and the
// extension stays broken until a human clicks reload. This ordering is what makes a
// bad edit self-healing instead of terminal.
//
// Change detection needs no dev server: `fetch` on a chrome-extension:// URL of an
// UNPACKED extension reads through to disk, so the running worker can hash the bundle
// currently on disk — which, after a rebuild, differs from the code it is itself
// executing. `cache: 'no-store'` stops Chrome serving us our own stale copy.
//
// NOTE: dynamic `import()` is disallowed in a ServiceWorkerGlobalScope, which is why
// the body is concatenated rather than imported.
;(() => {
  const ALARM = 'playwriter-dev-reload'
  const BASELINE_KEY = 'playwriterDevReloadBaseline'
  const ERROR_KEY = 'playwriterDevBodyError'
  const WATCHED = ['background.js', 'offscreen.js']

  globalThis.__playwriterDevReport = (err) => {
    const message = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err)
    // Console first — cheapest, and works even if the APIs below do not.
    console.error(
      '[playwriter] EXTENSION BODY FAILED TO LOAD. The extension is NOT functional.\n' +
        'Live reload is still armed, so fixing the source will recover it automatically.\n',
      err,
    )
    try {
      chrome.action.setBadgeText({ text: 'ERR' })
      chrome.action.setBadgeBackgroundColor({ color: '#d93025' })
      chrome.action.setTitle({
        title: `Playwriter: extension body failed to load\n\n${message.slice(0, 400)}\n\nFix the source — it reloads itself.`,
      })
    } catch {}
    try {
      chrome.storage.local.set({ [ERROR_KEY]: { message: message.slice(0, 2000), at: Date.now() } })
    } catch {}
  }

  // Only clears when a failure was actually recorded: the app body drives its own
  // PER-TAB badge/title, ours is the global default, and skipping the write on a
  // healthy boot keeps us out of its way.
  globalThis.__playwriterDevClear = () => {
    ;(async () => {
      try {
        const got = await chrome.storage.local.get(ERROR_KEY)
        if (!got || !got[ERROR_KEY]) return
        await chrome.storage.local.remove(ERROR_KEY)
        chrome.action.setBadgeText({ text: '' })
        chrome.action.setTitle({ title: 'Click to attach debugger' })
        console.log('[playwriter] extension body recovered after a failed build.')
      } catch {}
    })()
  }

  async function hashBuild() {
    let acc = 0
    let sawAny = false
    for (const file of WATCHED) {
      try {
        const res = await fetch(chrome.runtime.getURL(file), { cache: 'no-store' })
        if (!res.ok) continue
        const text = await res.text()
        sawAny = true
        for (let i = 0; i < text.length; i++) acc = ((acc << 5) - acc + text.charCodeAt(i)) | 0
        acc = (acc * 31 + text.length) | 0
      } catch {}
    }
    return sawAny ? String(acc) : null
  }

  // The baseline must outlive the worker: MV3 kills an idle SW in ~20s, taking module
  // state and every setInterval with it, so an in-memory baseline would re-arm on wake
  // to the ALREADY-rebuilt hash and never see the change. storage.local survives worker
  // restarts AND chrome.runtime.reload() (storage.session is wiped by the reload itself).
  async function poll() {
    try {
      const token = await hashBuild()
      if (!token) return
      const got = await chrome.storage.local.get(BASELINE_KEY)
      const baseline = got && typeof got[BASELINE_KEY] === 'string' ? got[BASELINE_KEY] : null
      if (baseline === null) {
        await chrome.storage.local.set({ [BASELINE_KEY]: token })
        console.log(`[playwriter] dev live-reload armed, build=${token}`)
        return
      }
      if (token !== baseline) {
        console.log(`[playwriter] dev live-reload: dist changed ${baseline} -> ${token}, RELOADING`)
        // Persist BEFORE reloading, or the fresh worker re-arms on the old baseline,
        // sees the same diff again, and reload-loops forever.
        await chrome.storage.local.set({ [BASELINE_KEY]: token })
        chrome.runtime.reload()
      }
    } catch (err) {
      console.debug('[playwriter] dev live-reload poll failed', err)
    }
  }

  try {
    console.log('[playwriter] dev live-reload starting (self-hash, no server)')
    // setInterval alone dies with the worker; the alarm wakes a terminated worker so
    // edits are still picked up after an idle period. 0.5 min is Chrome's floor.
    chrome.alarms.create(ALARM, { periodInMinutes: 0.5 })
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name === ALARM) poll()
    })
    setInterval(poll, 1000)
    poll()
  } catch (err) {
    console.error('[playwriter] dev live-reload failed to start', err)
  }
})()
