// An unpacked install reloads itself when its folder holds a newer build, so nobody has to click ↻
// on its card in chrome://extensions after a rebuild.
//
// Every build has an id, a content hash of the files it leaves in its folder. The build compiles it
// into background.js and writes it to build.json in that folder, after every other file and through
// a rename (vite.config.mts, the `build-id` plugin). So the folder holds a newer build exactly when
// its build.json names another id than the one this worker was compiled with, and by then the whole
// build is on disk. After the reload the worker runs that build, whose compiled id is the one on
// disk: there is nothing left to reload.
//
// The check runs while the extension is connected to the relay (so the relay log shows the reload),
// right after each connection and on the periodic wake, and once the extension stops controlling
// tabs while a newer build waits. It never reloads while the extension controls a tab or an attach
// or command is in flight: a reload detaches every debugger session and drops the connection.

// Injected by vite: a placeholder the `build-id` plugin replaces with this build's id.
declare const __PLAYWRITER_BUILD_ID__: string

/** The id of the build this worker runs. */
export const RUNNING_BUILD = __PLAYWRITER_BUILD_ID__

/** What vite.config.mts writes: the first 8 hex digits of a SHA-256. */
const BUILD_ID = /^[0-9a-f]{8}$/

/**
 * How long `chrome.management.getSelf()` may take. chrome.* calls have been observed never to settle
 * in a wedged worker (INSTALL_ID_STORAGE_TIMEOUT_MS in background.ts); a real timer, because a check
 * that never ends would leave every later check waiting on it.
 */
const GET_SELF_TIMEOUT_MS = 1500

/**
 * The id in build.json of the extension's folder, or null when there is none to read: no file (a
 * folder from before build ids) or not a build id.
 *
 * MEASURED (Chrome for Testing 145.0.7632.18 and Chrome 149.0.7827.114, unpacked): this fetch reads
 * the file on disk as it is at that moment, a rewrite or a rename included; a missing file rejects
 * ("TypeError: Failed to fetch"); a half-written one answers 200 with the part on disk.
 */
export async function readFolderBuild(): Promise<string | null> {
  let text: string
  try {
    const response = await fetch(chrome.runtime.getURL('build.json'), { cache: 'no-store' })
    if (!response.ok) return null
    text = await response.text()
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) return null
  const { id } = parsed
  return typeof id === 'string' && BUILD_ID.test(id) ? id : null
}

/**
 * Whether Chrome runs this extension from an unpacked folder. MEASURED (Chrome for Testing 145, Chrome
 * 149): `installType` is 'development' for a folder loaded unpacked (chrome://extensions, --load-extension,
 * Extensions.loadUnpacked), and getSelf needs no "management" permission.
 */
async function isUnpacked(): Promise<boolean | null> {
  const expired = Promise.withResolvers<null>()
  const timer = setTimeout(() => expired.resolve(null), GET_SELF_TIMEOUT_MS)
  try {
    const self = await Promise.race([chrome.management.getSelf(), expired.promise])
    return self === null ? null : self.installType === 'development'
  } finally {
    clearTimeout(timer)
  }
}

export type SelfReloadOutcome =
  /** No connection to the relay: the next connection checks. */
  | { kind: 'disconnected' }
  /** Installed from the store or by policy: Chrome updates it. */
  | { kind: 'packed' }
  /** chrome.management did not answer in time: the next check asks again. */
  | { kind: 'unanswered' }
  /** The folder has no build.json that names a build. */
  | { kind: 'unreadable' }
  /** The folder holds the build this worker runs. */
  | { kind: 'current' }
  /** The folder holds a newer build, loaded once the extension controls no tab. */
  | { kind: 'waiting'; build: string }
  /** The extension is reloading into the folder's build. */
  | { kind: 'reloading'; build: string }

export type SelfReload = {
  /** Compare the folder's build with this one and reload into it when nothing would be cut. */
  check: () => Promise<SelfReloadOutcome>
  /** A new connection to the relay, which knows nothing of a waiting build yet: tell it, reload when idle. */
  connected: () => void
  /** The extension stopped controlling tabs: load the waiting build, if one waits. */
  released: () => void
}

export function createSelfReload({
  isConnected,
  isIdle,
  settle,
  reload,
  report,
  log,
}: {
  isConnected: () => boolean
  /** No tab controlled, no attach, command or recording in flight. */
  isIdle: () => boolean
  /** Wait for the work the last state change queued (tab-group clean-up) to finish. */
  settle: () => Promise<void>
  /** Hand the log line to the relay, then reload the extension. */
  reload: () => Promise<void>
  /** Tell the relay which newer build waits in the folder (null: none). */
  report: (build: string | null) => void
  log: (message: string) => void
}): SelfReload {
  let running: Promise<SelfReloadOutcome> | null = null
  // The newer build this extension waits to load, and what the relay was told on this connection
  // (undefined: nothing yet).
  let waiting: string | null = null
  let reported: string | null | undefined = undefined
  // Said once per worker, not on every check.
  let loggedWaiting: string | null = null
  let loggedUnreadable = false

  const tell = (build: string | null): void => {
    waiting = build
    if (reported === build || (reported === undefined && build === null)) return
    reported = build
    report(build)
  }

  const run = async (): Promise<SelfReloadOutcome> => {
    if (!isConnected()) return { kind: 'disconnected' }
    const unpacked = await isUnpacked()
    if (unpacked === null) return { kind: 'unanswered' }
    if (!unpacked) return { kind: 'packed' }
    const build = await readFolderBuild()
    if (build === null) {
      if (!loggedUnreadable) {
        loggedUnreadable = true
        log(`build ${RUNNING_BUILD}: its folder has no build.json naming a build; it reloads itself once one does`)
      }
      tell(null)
      return { kind: 'unreadable' }
    }
    if (build === RUNNING_BUILD) {
      tell(null)
      return { kind: 'current' }
    }
    if (isIdle()) {
      await settle()
    }
    if (!isIdle() || !isConnected()) {
      if (loggedWaiting !== build) {
        loggedWaiting = build
        log(`build ${RUNNING_BUILD}: a newer build ${build} is in its folder; it reloads itself once it controls no tab`)
      }
      tell(build)
      return { kind: 'waiting', build }
    }
    log(`reloading itself: build ${RUNNING_BUILD} → ${build} (its folder has a newer build)`)
    await reload()
    return { kind: 'reloading', build }
  }

  const check = (): Promise<SelfReloadOutcome> => {
    running ??= run().finally(() => {
      running = null
    })
    return running
  }

  return {
    check,
    connected: () => {
      reported = undefined
      void check()
    },
    released: () => {
      if (waiting !== null) void check()
    },
  }
}
