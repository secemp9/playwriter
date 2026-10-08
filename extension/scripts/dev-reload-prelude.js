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
// Change detection is the app body's convention (src/self-reload.ts): every build compiles its
// id into background.js (RUNNING_BUILD below, filled in by vite.config.mts) and
// writes it to build.json in its folder, last, so the folder holds a newer build exactly when
// build.json names another id. `fetch` on a chrome-extension:// URL of an UNPACKED extension reads
// through to disk; `cache: 'no-store'` stops Chrome serving us our own stale copy. A missing or
// unreadable build.json (a folder from before build ids) reloads nothing.
//
// Unlike the body, it reloads without waiting for the extension to control no tab: it runs ahead
// of the body, also when the body threw, so it cannot see the body's tabs or in-flight work, and
// in a dev build the developer who rebuilt is the one waiting for the new code. That is also why
// the body's own self-reload is off in dev builds.
//
// NOTE: dynamic `import()` is disallowed in a ServiceWorkerGlobalScope, which is why
// the body is concatenated rather than imported.
;(() => {
  const ALARM = 'playwriter-dev-reload'
  const ERROR_KEY = 'playwriterDevBodyError'
  const RUNNING_BUILD = __PLAYWRITER_BUILD_ID__
  const BUILD_ID = /^[0-9a-f]{8}$/
  // The body's key (src/self-reload.ts FOLDER_BUILD_AT_LOAD_KEY): one baseline per loaded build.
  const FOLDER_BUILD_AT_LOAD_KEY = 'selfReloadFolderBuildAtLoad'

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

  // The id in the folder's build.json, or null while it names none (missing, half-written, or a
  // folder from before build ids).
  async function folderBuild() {
    try {
      const res = await fetch(chrome.runtime.getURL('build.json'), { cache: 'no-store' })
      if (!res.ok) return null
      const { id } = await res.json()
      return typeof id === 'string' && /^[0-9a-f]{8}$/.test(id) ? id : null
    } catch {
      return null
    }
  }

  // No baseline to keep: the running build's id is compiled in, so a worker woken after a
  // rebuild still compares the folder with the code it runs.
  async function poll() {
    try {
      const build = await folderBuild()
      if (build === null || build === RUNNING_BUILD) return
      // A background.js that kept the build-id placeholder: its build stopped before its last step and
      // Chrome loaded it anyway. Its id matches no build.json, so it reloads only into a build written
      // after it was loaded, or it would reload into the same files every second (src/self-reload.ts,
      // writtenAfterUnfinishedLoad).
      if (!BUILD_ID.test(RUNNING_BUILD)) {
        const stored = await chrome.storage.session.get(FOLDER_BUILD_AT_LOAD_KEY)
        const seen = stored[FOLDER_BUILD_AT_LOAD_KEY]
        if (typeof seen !== 'string') {
          await chrome.storage.session.set({ [FOLDER_BUILD_AT_LOAD_KEY]: build })
          console.log(`[playwriter] dev live-reload: this build did not finish; reloading into the next build written to its folder (now ${build})`)
          return
        }
        if (seen === build) return
      }
      console.log(`[playwriter] dev live-reload: build ${RUNNING_BUILD} -> ${build}, RELOADING`)
      chrome.runtime.reload()
    } catch (err) {
      console.debug('[playwriter] dev live-reload poll failed', err)
    }
  }

  try {
    console.log(`[playwriter] dev live-reload starting (build ${RUNNING_BUILD}, no server)`)
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
