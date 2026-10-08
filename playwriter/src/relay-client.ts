/**
 * Shared utilities for connecting to the relay server.
 * Used by both MCP and CLI.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pc from 'picocolors'
import { getListeningPidsForPort, killPortProcess } from './kill-port.js'
import { STATUS_WAIT_MAX_MS } from './relay-state.js'
import { VERSION, LOG_FILE_PATH } from './utils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const RELAY_PORT = Number(process.env.PLAYWRITER_PORT) || 19988

export type ExtensionStatus = {
  extensionId: string
  stableKey?: string
  browser: string | null
  profile: { email: string; id: string } | null
  activeTargets: number
  playwriterVersion: string | null
  /** Id of the build the extension runs; null from an extension built before it could reload itself. */
  build: string | null
  /** A newer build in the extension's folder, loaded once it controls no tab. */
  newerBuild: string | null
}

/**
 * What the relay daemon (start-relay-server.ts) tells the process that spawned it, over the spawn's
 * 'ipc' channel, before it closes that channel: it listens on port `listening`, or another relay, of
 * version `otherRelay`, already answers on the port it was to take.
 */
export type RelayDaemonMessage = { listening: number } | { otherRelay: string }

/**
 * The version of the relay on `port`, or null when none answers. A relay that listens but has not
 * served HTTP yet (still starting, or its event loop busy) needs no retry: the kernel holds the
 * request in the listener's accept backlog and the relay answers it when it gets to it (measured,
 * Linux 6.8 / Node 22: a request sent 5 ms after listen() to a server then blocked for 1500 ms was
 * answered 200 after 1530 ms). Nothing listening refuses at once (ECONNREFUSED in 0.15 ms, also when
 * the port is bound without listen()), and only a new attempt can tell when that changes; but Node
 * binds and listens in one step, so a Node relay is never seen bound and not yet listening.
 */
export async function getRelayServerVersion(port: number = RELAY_PORT): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      // The cap (a): the relay's answer settles the request first; 2 s bounds one that never answers.
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) {
      return null
    }
    const data = (await response.json()) as { version: string }
    return data.version
  } catch {
    return null
  }
}

export async function getExtensionStatus(
  port: number = RELAY_PORT,
): Promise<{ connected: boolean; activeTargets: number; playwriterVersion: string | null } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/extension/status`, {
      // The cap (a): the relay answers this from memory at once; 500 ms bounds a relay that does not.
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) {
      return null
    }
    return (await response.json()) as { connected: boolean; activeTargets: number; playwriterVersion: string | null }
  } catch {
    return null
  }
}

/**
 * The extensions connected to the relay on `port`. With `untilConnectedMs`, the relay holds its
 * answer until one is connected or that many ms have passed (its `?until=connected` long-poll); a
 * relay from before the long-poll answers at once.
 */
export async function getExtensionsStatus(
  port: number = RELAY_PORT,
  { untilConnectedMs }: { untilConnectedMs?: number } = {},
): Promise<ExtensionStatus[]> {
  const query = untilConnectedMs === undefined ? '' : `?until=connected&waitMs=${untilConnectedMs}`
  try {
    const response = await fetch(`http://127.0.0.1:${port}/extensions/status${query}`, {
      // The cap (a): the relay answers by `untilConnectedMs` itself; the 2 s on top bound a relay that
      // never answers, as for a plain status read.
      signal: AbortSignal.timeout((untilConnectedMs ?? 0) + 2000),
    })
    if (!response.ok) {
      const fallback = await fetch(`http://127.0.0.1:${port}/extension/status`, {
        // The cap (a), as above.
        signal: AbortSignal.timeout(2000),
      })
      if (!fallback.ok) {
        return []
      }

      const fallbackData = (await fallback.json()) as {
        connected: boolean
        activeTargets: number
        browser: string | null
        profile: { email: string; id: string } | null
        playwriterVersion?: string | null
      }

      if (!fallbackData?.connected) {
        return []
      }

      return [
        {
          extensionId: 'default',
          stableKey: undefined,
          browser: fallbackData.browser,
          profile: fallbackData.profile,
          activeTargets: fallbackData.activeTargets,
          playwriterVersion: fallbackData.playwriterVersion || null,
          // A relay without /extensions/status predates build ids: it reports none.
          build: null,
          newerBuild: null,
        },
      ]
    }

    const data = (await response.json()) as {
      extensions: ExtensionStatus[]
    }

    return data.extensions || []
  } catch {
    return []
  }
}

/**
 * Waits for at least one extension to be connected to the relay: one request, which the relay answers
 * as soon as an extension connects (its `?until=connected` long-poll, woken by its own state) or at
 * `timeoutMs`. Returns the connected extensions, or [] when none connected in time.
 */
export async function waitForConnectedExtensions(
  options: {
    port?: number
    timeoutMs?: number
    logger?: { log: (...args: unknown[]) => void }
  } = {},
): Promise<ExtensionStatus[]> {
  const { port = RELAY_PORT, timeoutMs = 5000, logger } = options
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > STATUS_WAIT_MAX_MS) {
    throw new RangeError(
      `waitForConnectedExtensions: timeoutMs must be a whole number of milliseconds from 0 to ${STATUS_WAIT_MAX_MS}, the relay's longest wait; got ${timeoutMs}`,
    )
  }

  logger?.log(pc.dim('Waiting for extension to connect...'))

  const extensions = await getExtensionsStatus(port, { untilConnectedMs: timeoutMs })
  if (extensions.length > 0) {
    logger?.log(pc.green('Extension connected'))
    return extensions
  }

  logger?.log(pc.yellow('Extension did not connect within timeout'))
  return []
}

/**
 * Kills the relay on `port` and returns once its port is free. A connection to the relay, opened
 * before the kill, is closed by the kernel when the relay's process dies, so its `close` is the
 * signal; one listener check after it confirms nothing listens there any more.
 */
async function killRelayServer(options: { port: number; waitForFreeMs?: number }): Promise<void> {
  const { port, waitForFreeMs = 3000 } = options

  // The cap (a) of the whole stop, the one timer: the relay's connection closing answers first.
  const deadline = AbortSignal.timeout(waitForFreeMs)
  const watch = new net.Socket({ signal: deadline })
  // Refused (nothing listens), reset by the dying relay, or the cap: told apart below, by `connected`
  // and `deadline.aborted`.
  watch.on('error', () => {})
  const closed = Promise.withResolvers<void>()
  const opened = Promise.withResolvers<boolean>()
  watch.once('connect', () => opened.resolve(true))
  watch.once('close', () => {
    opened.resolve(false)
    closed.resolve()
  })
  watch.connect(port, '127.0.0.1')
  const connected = await opened.promise

  try {
    await killPortProcess({ port })
  } catch (error) {
    watch.destroy()
    throw new Error(`Could not kill the relay on port ${port}`, { cause: error })
  }

  if (connected) {
    await closed.promise
  }
  const pids = await getListeningPidsForPort({ port })
  if (pids.length > 0) {
    const waited = connected && deadline.aborted ? `; its connection was still open after ${waitForFreeMs}ms` : ''
    throw new Error(`Killed the relay on port ${port}, but pid(s) ${pids.join(', ')} still listen there${waited}`)
  }
}

/**
 * Compare two semver versions. Returns:
 * - negative if v1 < v2
 * - 0 if v1 === v2
 * - positive if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)
  const len = Math.max(parts1.length, parts2.length)

  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    if (p1 !== p2) {
      return p1 - p2
    }
  }
  return 0
}

/**
 * Check if the running playwriter package is older than the version the extension was built with.
 * The extension bundles the playwriter version at build time. If the extension reports a newer
 * version, it means the user's CLI/MCP needs updating.
 * Returns a warning message if outdated, null otherwise.
 */
export function getExtensionOutdatedWarning(extensionPlaywriterVersion: string | null | undefined): string | null {
  if (!extensionPlaywriterVersion) {
    return null
  }
  if (compareVersions(extensionPlaywriterVersion, VERSION) > 0) {
    return `Playwriter ${VERSION} is older than the version the browser extension was built with (${extensionPlaywriterVersion}). Ask the user to update the playwriter package this server runs to ${extensionPlaywriterVersion} or later.`
  }
  return null
}

/**
 * Detect a STALE extension — the exact inverse of getExtensionOutdatedWarning.
 *
 * The extension bundles the playwriter version it was built with and sends it as `?v=`;
 * the relay surfaces it as `playwriterVersion`. `VERSION` is the running relay/CLI's own
 * playwriter version. When the extension's version is OLDER than the relay's, the loaded
 * service worker predates the running server — the classic "rebuilt the server, forgot to
 * reload the unpacked extension at chrome://extensions" mistake.
 *
 * Why this is FATAL, not a warning (unlike the newer-extension case above): workspace
 * ownership is echoed by the extension's service worker on `Target.attachedToTarget`
 * (it stamps `workspaceKey` on every tab it attaches). A stale service worker never echoes
 * it, so EVERY extension-attached target lands `workspaceKey: null` (freestyle) and becomes
 * invisible to every keyed client — the symptom is "no pages anywhere", near-undiagnosable.
 * Continuing silently reproduces exactly that mystery, so callers must throw on this.
 *
 * This compares against the CLI's own `VERSION` (not a hard-coded floor) deliberately: a
 * freshly-rebuilt extension always matches the CLI it shipped alongside, so this never
 * false-fires on a correct lockstep build, and it starts catching stale extensions the
 * moment a release bumps the version above them. It is dormant only when the two versions
 * are equal, which is the correct reading of "not stale".
 *
 * Returns an actionable error message if the extension is stale, null otherwise.
 */
export function getExtensionStaleError(extensionPlaywriterVersion: string | null | undefined): string | null {
  if (!extensionPlaywriterVersion) {
    return null
  }
  if (compareVersions(extensionPlaywriterVersion, VERSION) < 0) {
    return (
      `The Playwriter browser extension is stale: it was built with playwriter ${extensionPlaywriterVersion} ` +
      `but the relay is running ${VERSION}. A stale extension no longer reports workspace ownership, so every ` +
      `page it opens is invisible to this session (you would see "no pages anywhere"). An extension built before ` +
      `it reported the browser's user agent also leaves browser.version() wrong and makes Playwright treat a Mac as ` +
      `Linux, so macOS keyboard shortcuts (Meta+A, Meta+ArrowLeft, Alt+Backspace…) do nothing in text fields. ` +
      `Ask the user to reload the unpacked extension at chrome://extensions (rebuilding it first if its build is old), then retry.`
    )
  }
  return null
}

export interface EnsureRelayServerOptions {
  logger?: { log: (...args: any[]) => void }
  /** If true, will kill and restart server on version mismatch. Default: true */
  restartOnVersionMismatch?: boolean
  /** Pass additional environment variables to the relay server process */
  env?: Record<string, string>
}

// Module-level dedup: if ensureRelayServer is called concurrently within the
// same process (e.g. two MCP tool handlers at once), only one spawn runs.
let pendingEnsure: Promise<true | undefined> | null = null

/**
 * Ensures the relay server is running. Starts it if not running.
 * Optionally restarts on version mismatch.
 * Concurrent calls within the same process are deduplicated.
 */
export async function ensureRelayServer(options: EnsureRelayServerOptions = {}): Promise<true | undefined> {
  if (pendingEnsure) {
    return pendingEnsure
  }
  pendingEnsure = ensureRelayServerImpl(options).finally(() => {
    pendingEnsure = null
  })
  return pendingEnsure
}

async function ensureRelayServerImpl(options: EnsureRelayServerOptions = {}): Promise<true | undefined> {
  const { logger, restartOnVersionMismatch = true, env: additionalEnv } = options
  const serverVersion = await getRelayServerVersion(RELAY_PORT)

  if (serverVersion === VERSION) {
    return
  }

  // Don't restart if server version is higher than our version.
  // This prevents older clients from killing a newer server.
  if (serverVersion !== null && compareVersions(serverVersion, VERSION) > 0) {
    return
  }

  if (serverVersion !== null) {
    if (restartOnVersionMismatch) {
      logger?.log(
        pc.yellow(`CDP relay server version mismatch (server: ${serverVersion}, client: ${VERSION}), restarting...`),
      )
      await killRelayServer({ port: RELAY_PORT })
    } else {
      // Server is running but different version, just use it
      return
    }
  } else {
    const listeningPids = await getListeningPidsForPort({ port: RELAY_PORT }).catch(() => [])
    if (listeningPids.length > 0) {
      // Something listens on the port but /version didn't answer: it might be a relay that is still
      // starting (race with another CLI/MCP instance, issue #75). It listens, so this one request
      // waits in its accept backlog until it serves HTTP (getRelayServerVersion).
      const foundVersion = await getRelayServerVersion(RELAY_PORT)
      if (foundVersion) {
        // A relay came up while we waited; use it
        if (foundVersion === VERSION || compareVersions(foundVersion, VERSION) > 0) {
          return
        }
        if (!restartOnVersionMismatch) {
          return
        }
        logger?.log(
          pc.yellow(`CDP relay server version mismatch (server: ${foundVersion}, client: ${VERSION}), restarting...`),
        )
      } else {
        logger?.log(
          pc.yellow(
            `Port ${RELAY_PORT} is already in use (pid(s): ${listeningPids.join(', ')}). Attempting to stop the existing process...`,
          ),
        )
      }
      await killRelayServer({ port: RELAY_PORT })
    }

    logger?.log(pc.dim('CDP relay server not running, starting it...'))
  }

  // Detect if we're running from source (.ts) or compiled (.js)
  // This handles: tsx, vite-node, ts-node, or direct node on compiled output
  const isRunningFromSource = __filename.endsWith('.ts')
  const scriptPath = isRunningFromSource
    ? path.resolve(__dirname, './start-relay-server.ts')
    : path.resolve(__dirname, './start-relay-server.js')

  // The relay daemon is a detached singleton: whichever session spawns it first serves
  // every other session for the daemon's entire life. It must therefore carry NO identity
  // of its own that could leak into another session's workspace derivation (I4).
  //   - cwd: os.homedir() — never a worktree. A detached daemon that inherited a worktree
  //     cwd keeps it forever; deleting that worktree then pins a stale inode on Linux, and
  //     any process.cwd()-relative work inside the daemon would resolve against the wrong
  //     session's directory. Home is neutral and always exists.
  //   - strip the ambient Claude-session identity vars from the inherited env so no
  //     daemon-side code (present or future) can read one session's identity and brand
  //     another. CLAUDE_PROJECT_DIR is the only one read today (workspace-key.ts's default
  //     arg), but the CLI route always passes an explicit body.cwd so it is unused there;
  //     the other two are stripped defensively. This enforces I4 structurally, not by
  //     discipline. additionalEnv (explicit caller intent) is layered on top of the stripped
  //     base so a caller could still set one deliberately.
  const daemonEnv: NodeJS.ProcessEnv = { ...process.env }
  delete daemonEnv.CLAUDE_PROJECT_DIR
  delete daemonEnv.CLAUDE_CODE_SESSION_ID
  delete daemonEnv.CLAUDECODE
  Object.assign(daemonEnv, additionalEnv)

  const logFilePath = additionalEnv?.PLAYWRITER_LOG_FILE_PATH || LOG_FILE_PATH
  // From source the daemon is this Node with tsx's loader, not the `tsx` CLI: the CLI runs the script in a
  // child of its own, a second process that lives as long as the daemon and keeps the 'ipc' channel open
  // after the daemon has closed its end. Measured (tsx 4.20.6, Node 22.22.3): the ready message came
  // 429–498 ms after spawn this way, 588–606 ms through the CLI. The loader is resolved from this file,
  // not from the daemon's cwd (the home folder), where tsx is not installed.
  const sourceArgs = (): string[] => {
    let loader: string
    try {
      loader = createRequire(__filename).resolve('tsx')
    } catch (error) {
      throw new Error(`Cannot start the CDP relay server from source: tsx is not installed next to ${__filename}`, { cause: error })
    }
    return ['--import', pathToFileURL(loader).href, scriptPath]
  }
  const command = process.execPath
  const args = isRunningFromSource ? sourceArgs() : [scriptPath]
  // Its output goes to its log file; the 'ipc' channel carries the one message it sends once it
  // listens (RelayDaemonMessage), then the daemon closes it.
  const serverProcess = spawn(command, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    cwd: os.homedir(),
    env: daemonEnv,
  })

  const ready = Promise.withResolvers<RelayDaemonMessage>()
  const onMessage = (message: unknown) => {
    if (typeof message !== 'object' || message === null) {
      return
    }
    if ('listening' in message && typeof message.listening === 'number') {
      ready.resolve({ listening: message.listening })
    } else if ('otherRelay' in message && typeof message.otherRelay === 'string') {
      ready.resolve({ otherRelay: message.otherRelay })
    }
  }
  // 'close', not 'exit': it comes after the IPC channel has delivered everything the daemon sent.
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    const how = signal ? `was killed by ${signal}` : `exited with code ${code}`
    ready.reject(new Error(`The CDP relay server ${how} before it listened on port ${RELAY_PORT}. Check logs at: ${logFilePath}`))
  }
  const onError = (error: Error) => {
    ready.reject(new Error(`Could not start the CDP relay server (${command} ${args.join(' ')}): ${error.message}`, { cause: error }))
  }
  serverProcess.on('message', onMessage)
  serverProcess.once('close', onClose)
  serverProcess.once('error', onError)
  const startTimeoutMs = 5000
  // The cap (a): the daemon's message, or its exit, answers first; 5 s bounds one that does neither.
  const cap = setTimeout(() => {
    ready.reject(
      new Error(`The CDP relay server neither listened nor exited within ${startTimeoutMs}ms. Check logs at: ${logFilePath}`),
    )
  }, startTimeoutMs)

  let started: RelayDaemonMessage
  try {
    started = await ready.promise
  } finally {
    clearTimeout(cap)
    serverProcess.off('message', onMessage)
    serverProcess.off('close', onClose)
    serverProcess.off('error', onError)
    // The daemon outlives this process: nothing of it may keep this one running.
    if (serverProcess.connected) {
      serverProcess.disconnect()
    }
    serverProcess.unref()
  }
  logger?.log(
    'listening' in started
      ? pc.green('CDP relay server started successfully')
      : pc.green(`CDP relay server v${started.otherRelay} started by another process answers on port ${RELAY_PORT}`),
  )

  // What this start used to sleep 1 s for (commit 2decaf6, "waiting for extension to connect"): an
  // extension connecting. The relay's long-poll answers as soon as one does; the cap (a) is that same
  // 1 s, so a start never takes longer than it did. An extension retries every 3 s
  // (extension/src/background.ts maintainLoop), so callers that need one wait longer themselves.
  await getExtensionsStatus(RELAY_PORT, { untilConnectedMs: 1000 })
  return true
}
