import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Prevent Buffers from dumping hex bytes in util.inspect output.
// Without this, returning a screenshot Buffer would log ~400+ chars of useless hex.
Buffer.prototype[util.inspect.custom] = function () {
  return `<Buffer ${this.length} bytes>`
}

import dedent from 'string-dedent'
import { LOG_FILE_PATH, VERSION, parseRelayHost } from './utils.js'
import { ensureRelayServer, RELAY_PORT } from './relay-client.js'
import type { PlaywrightExecutor } from './executor.js'
import type * as ExecutorExports from './executor.js'
import { deriveWorkspace } from './workspace-key.js'
import { discoverChromeInstances, resolveDirectInput, appendSessionToWsUrl } from './chrome-discovery.js'
import { newBrowserOptionShapes, type NewBrowserOptions } from './new-browser-options.js'
import type { NewBrowserPlan } from './new-browser.js'
import { ModelFacingError } from './probe-types.js'
import { exitOnStdinEnd } from './mcp-lifecycle.js'
import type { BrowserContext, Page } from '@xmorse/playwright-core'
import crypto from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)

type ExecutorModule = typeof ExecutorExports
let executorModule: Promise<ExecutorModule> | null = null

/**
 * The executor module, loaded on first need: dynamic because its import graph (Playwright's client and
 * server) takes ≈1 s, which the server must not spend before it answers `initialize`. startMcp warms it
 * once the client is initialized.
 */
function loadExecutorModule(): Promise<ExecutorModule> {
  executorModule ??= import('./executor.js')
  return executorModule
}

// The executor this MCP session drives its browser through, and which browser that is. Both are
// null until the first `browser` call, or until execute/reset applies the default (see
// getOrCreateExecutor); `browser use` / `browser new` replace them, releasing the previous one.
let executor: PlaywrightExecutor | null = null

type Binding =
  /** PLAYWRITER_DIRECT: the server config names the browser; the model cannot change it. */
  | { kind: 'direct'; endpoint: string }
  /** One of the user's Chrome profiles, through its Playwriter extension and the relay. */
  | { kind: 'extension'; key: string; email: string }
  /** A headless Chrome launched for this session (CdpConfig.headless). */
  | { kind: 'headless'; executablePath: string }

let binding: Binding | null = null

// Workspace identity for this MCP session, derived ONCE per process here in the client —
// never in the shared relay daemon (I4). process.cwd() is frozen at spawn, so this key
// stays stable for the session's whole life even if the user cd's. This file is only ever
// imported by the MCP entrypoint (cli.ts), so derivation cannot leak into the daemon.
// Only the relay/extension path consumes it; direct-CDP and headless own their own browser
// and never touch the relay (see the CdpConfig.workspace doc in executor.ts).
const workspace = deriveWorkspace()

interface RemoteConfig {
  host: string
  port: number
  token?: string
}

function getRemoteConfig(): RemoteConfig | null {
  const host = process.env.PLAYWRITER_HOST
  if (!host) {
    return null
  }
  return {
    host,
    port: RELAY_PORT,
    token: process.env.PLAYWRITER_TOKEN,
  }
}

function getLogServerUrl(): string {
  const remote = getRemoteConfig()
  if (remote) {
    const { httpBaseUrl } = parseRelayHost(remote.host, remote.port)
    return `${httpBaseUrl}/mcp-log`
  }
  return `http://127.0.0.1:${RELAY_PORT}/mcp-log`
}

async function sendLogToRelayServer(level: string, ...args: any[]) {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = process.env.PLAYWRITER_TOKEN
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    await fetch(getLogServerUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ level, args }),
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // Silently fail if relay server is not available
  }
}

/**
 * Log to both console.error (for early startup) and relay server log file.
 * Fire-and-forget to avoid blocking.
 */
function mcpLog(...args: any[]) {
  console.error(...args)
  sendLogToRelayServer('log', ...args)
}

/** MCP-specific logger for executor */
const mcpLogger = {
  log: (...args: any[]) => mcpLog(...args),
  error: (...args: any[]) => {
    console.error(...args)
    sendLogToRelayServer('error', ...args)
  },
}

async function ensureRelayServerForMcp(): Promise<void> {
  await ensureRelayServer({ logger: mcpLogger })
}

/**
 * Resolve direct CDP config from PLAYWRITER_DIRECT env var.
 * - "auto" / "1" / "true": auto-discover Chrome on default port 9222
 * - "ws://..." / "wss://...": use explicit WebSocket endpoint
 * - "host:port": resolve to ws:// URL via HTTP probe + DevToolsActivePort fallback
 */
async function getDirectCdpConfig(): Promise<{ directCdpUrl: string } | null> {
  const directEnv = process.env.PLAYWRITER_DIRECT
  if (!directEnv) {
    return null
  }

  // Auto-discover: check default port 9222
  if (directEnv === '1') {
    const instances = await discoverChromeInstances()
    if (instances.length === 0) {
      throw new Error(
        'PLAYWRITER_DIRECT is set but no Chrome found on port 9222. ' +
          'Ask the user to enable debugging at chrome://inspect/#remote-debugging or to start Chrome with --remote-debugging-port=9222.',
      )
    }
    const sessionId = crypto.randomUUID()
    const wsUrl = appendSessionToWsUrl(instances[0].wsUrl, sessionId)
    mcpLog(`Direct CDP: using ${instances[0].browser} on port ${instances[0].port}`)
    return { directCdpUrl: wsUrl }
  }

  // ws://, wss://, or host:port — resolveDirectInput handles all three
  const resolved = await resolveDirectInput(directEnv)
  const sessionId = crypto.randomUUID()
  const directCdpUrl = appendSessionToWsUrl(resolved, sessionId)
  mcpLog(`Direct CDP: resolved ${directEnv} → ${directCdpUrl}`)
  return { directCdpUrl }
}

/** One connected Playwriter extension, as the relay's `/extensions/status` lists it. */
const connectedExtensionSchema = z.object({
  extensionId: z.string(),
  stableKey: z.string(),
  browser: z.string().nullable(),
  profile: z.object({ email: z.string(), id: z.string() }).nullable(),
  activeTargets: z.number(),
  playwriterVersion: z.string().nullable(),
  build: z.string().nullable(),
  newerBuild: z.string().nullable(),
})
type ConnectedExtension = z.infer<typeof connectedExtensionSchema>
const extensionsStatusSchema = z.object({ extensions: z.array(connectedExtensionSchema) })

/** Start the local relay when there is no remote one (PLAYWRITER_HOST), so its status can be read. */
async function ensureLocalRelay(): Promise<void> {
  if (!getRemoteConfig()) {
    await ensureRelayServerForMcp()
  }
}

/** The Chrome profiles connected to the relay (local, or PLAYWRITER_HOST with PLAYWRITER_TOKEN). */
async function fetchConnectedExtensions(): Promise<ConnectedExtension[]> {
  const remote = getRemoteConfig()
  const baseUrl = remote ? parseRelayHost(remote.host, remote.port).httpBaseUrl : `http://127.0.0.1:${RELAY_PORT}`
  const token = process.env.PLAYWRITER_TOKEN
  let response: Response
  try {
    response = await fetch(`${baseUrl}/extensions/status`, {
      signal: AbortSignal.timeout(3000),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot ask the relay at ${baseUrl} which browsers are connected: ${reason}`, { cause: error })
  }
  if (!response.ok) {
    throw new Error(`The relay at ${baseUrl} answered /extensions/status with HTTP ${response.status}.`)
  }
  const parsed = extensionsStatusSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error(
      `The relay at ${baseUrl} answered /extensions/status with a list this server (playwriter ${VERSION}) cannot read: ${parsed.error.message}`,
    )
  }
  return parsed.data.extensions
}

function emailOf(extension: ConnectedExtension): string {
  return extension.profile?.email ?? ''
}

/** What `use` takes for this profile: its email when no other connected profile has it, else its key. */
function choiceFor(extension: ConnectedExtension, extensions: ConnectedExtension[]): string {
  const email = emailOf(extension).toLowerCase()
  if (!email) {
    return extension.stableKey
  }
  const sameEmail = extensions.filter((other) => emailOf(other).toLowerCase() === email)
  return sameEmail.length === 1 ? emailOf(extension) : extension.stableKey
}

function useCall(choice: string): string {
  return `browser({ action: "use", browser: ${JSON.stringify(choice)} })`
}

const NEW_CALL = 'browser({ action: "new" })'

function describeExtension(extension: ConnectedExtension): string {
  const tabs = extension.activeTargets === 1 ? '1 attached tab' : `${extension.activeTargets} attached tabs`
  const built = `extension built with playwriter ${extension.playwriterVersion ?? '(version not reported)'}`
  const build =
    extension.build === null
      ? `${built}, before it could reload itself: ask the user to click ↻ on its card in chrome://extensions once`
      : extension.newerBuild === null
        ? `${built}, build ${extension.build}`
        : `${built}, build ${extension.build} (a newer build is in its folder; it reloads itself once it controls no tab)`
  return `- ${emailOf(extension) || '(not signed in)'} — key ${extension.stableKey} · ${extension.browser ?? 'browser not reported'} · ${build} · ${tabs}`
}

/** The list lines: every connected profile, then the `new` choice. */
function describeChoices(extensions: ConnectedExtension[]): string {
  const lines = extensions.map(describeExtension)
  if (lines.length === 0) {
    lines.push('(no Chrome is connected through the Playwriter extension)')
  }
  lines.push('- new — a fresh headless Chrome for this session: no logins, no extensions, nothing shared with the browsers above')
  return lines.join('\n')
}

/** The exact calls that choose each browser, one per line. */
function choiceCalls(extensions: ConnectedExtension[]): string {
  return [...extensions.map((extension) => useCall(choiceFor(extension, extensions))), NEW_CALL].map((call) => `  ${call}`).join('\n')
}

function describeBinding(current: Binding): string {
  switch (current.kind) {
    case 'direct':
      return `the Chrome at ${current.endpoint} (PLAYWRITER_DIRECT)`
    case 'extension':
      return `${current.email || '(not signed in)'} (key ${current.key})`
    case 'headless': {
      const options = executor?.describeNewBrowser() ?? []
      return [`a new Chrome launched for this session (${current.executablePath})`, ...options.map((line) => `  ${line}`)].join('\n')
    }
  }
}

/**
 * The connected profile `choice` names: a key from `list`, or a profile email (case-insensitive).
 * Throws a model-facing error naming the valid choices when it names none, or several.
 */
function resolveChoice(choice: string, extensions: ConnectedExtension[], source: 'use' | 'PLAYWRITER_BROWSER'): ConnectedExtension {
  const subject =
    source === 'use' ? `"${choice}"` : `PLAYWRITER_BROWSER in this MCP server's configuration ("${choice}")`
  const byKey = extensions.find((extension) => extension.stableKey === choice)
  if (byKey) {
    return byKey
  }
  const byEmail = extensions.filter((extension) => emailOf(extension) && emailOf(extension).toLowerCase() === choice.toLowerCase())
  if (byEmail.length === 1) {
    return byEmail[0]
  }
  if (byEmail.length > 1) {
    throw new ModelFacingError(
      `${subject} matches ${byEmail.length} connected Chrome profiles signed in with that email; choose one by key:\n` +
        byEmail.map((extension) => `${describeExtension(extension)}\n  ${useCall(extension.stableKey)}`).join('\n'),
    )
  }
  throw new ModelFacingError(
    `${subject} is not a connected browser. The choices are:\n${describeChoices(extensions)}\nChoose with:\n${choiceCalls(extensions)}` +
      (source === 'PLAYWRITER_BROWSER' ? "\nOr ask the user to fix PLAYWRITER_BROWSER in this MCP server's configuration." : ''),
  )
}

/** Release what this session drives now: a relay or direct binding disconnects, a headless one closes. */
async function releaseBinding(): Promise<string | null> {
  const previous = binding
  const previousExecutor = executor
  executor = null
  binding = null
  if (!previous || !previousExecutor) {
    return null
  }
  await previousExecutor.disconnect()
  switch (previous.kind) {
    case 'direct':
      return `Released the Chrome at ${previous.endpoint}: disconnected, its tabs stay open.`
    case 'extension':
      return `Released ${describeBinding(previous)}: disconnected, its tabs stay open.`
    case 'headless':
      return `Released the headless Chrome this session launched (${previous.executablePath}): it is closed.`
  }
}

/** Bind this session to a connected Chrome profile: the relay routes it to that extension by key. */
async function bindExtension(extension: ConnectedExtension): Promise<{ exec: PlaywrightExecutor; released: string | null }> {
  const released = await releaseBinding()
  const remote = getRemoteConfig()
  // The workspace and the extension key ride on cdpConfig and reach the relay via getCdpUrl
  // (executor.ts). Only this relay/remote path sets them: direct CDP and headless never call getCdpUrl.
  const { PlaywrightExecutor } = await loadExecutorModule()
  const exec = new PlaywrightExecutor({
    cdpConfig: { ...(remote || { port: RELAY_PORT }), workspace, extensionId: extension.stableKey },
    logger: mcpLogger,
    cwd: process.cwd(),
  })
  executor = exec
  binding = { kind: 'extension', key: extension.stableKey, email: emailOf(extension) }
  return { exec, released }
}

/**
 * Bind this session to a new browser launched for it with `options` (new-browser.ts). The options are
 * checked before the current browser is released: a refused option leaves the session as it was.
 * Refuses, telling the model to ask the user, when no Chrome binary exists.
 */
async function bindNewBrowser(options: NewBrowserOptions): Promise<{ exec: PlaywrightExecutor; released: string | null; plan: NewBrowserPlan }> {
  const { PlaywrightExecutor } = await loadExecutorModule()
  const exec = new PlaywrightExecutor({ cdpConfig: { headless: true }, logger: mcpLogger, cwd: process.cwd() })
  let plan: NewBrowserPlan
  try {
    plan = await exec.planNewBrowser(options)
  } catch (error) {
    if (error instanceof ModelFacingError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new ModelFacingError(
      'No Chrome binary was found to launch a new browser. Ask the user to point PLAYWRITER_BROWSER_PATH in this MCP ' +
        `server's configuration at a Chrome or Chromium binary, or to install Google Chrome; then call ${NEW_CALL} again.\n\n${reason}`,
      { cause: error },
    )
  }
  const released = await releaseBinding()
  executor = exec
  binding = { kind: 'headless', executablePath: plan.executablePath }
  return { exec, released, plan }
}

/**
 * The executor execute/reset run on. Before any `browser` call it applies the default: PLAYWRITER_DIRECT,
 * else PLAYWRITER_BROWSER (`new`, an email or a key), else the only connected profile. No profile, or
 * several, is a model-facing error saying how to choose — never a guess. Concurrent callers (the startup
 * prelaunch and a first execute) share one creation.
 */
async function getOrCreateExecutor(): Promise<PlaywrightExecutor> {
  if (executor) {
    return executor
  }
  creatingExecutor ??= createDefaultExecutor().finally(() => {
    creatingExecutor = null
  })
  return creatingExecutor
}

let creatingExecutor: Promise<PlaywrightExecutor> | null = null

async function createDefaultExecutor(): Promise<PlaywrightExecutor> {
  const configured = process.env.PLAYWRITER_BROWSER?.trim() || null
  const directConfig = await getDirectCdpConfig()
  if (directConfig) {
    if (configured) {
      throw new ModelFacingError(
        `This MCP server's configuration sets both PLAYWRITER_DIRECT and PLAYWRITER_BROWSER ("${configured}"), two different ways of choosing the browser. ` +
          'Ask the user to remove one of them.',
      )
    }
    const { PlaywrightExecutor } = await loadExecutorModule()
    const exec = new PlaywrightExecutor({ cdpConfig: directConfig, logger: mcpLogger, cwd: process.cwd() })
    executor = exec
    binding = { kind: 'direct', endpoint: directConfig.directCdpUrl }
    return exec
  }

  if (configured === 'new') {
    return (await bindNewBrowser({})).exec
  }
  // execute and reset have already started the local relay (ensureLocalRelay) before calling this.
  const extensions = await fetchConnectedExtensions()
  if (configured) {
    return (await bindExtension(resolveChoice(configured, extensions, 'PLAYWRITER_BROWSER'))).exec
  }
  if (extensions.length === 1) {
    return (await bindExtension(extensions[0])).exec
  }
  if (extensions.length === 0) {
    throw new ModelFacingError(
      "No Chrome is connected to the relay through the Playwriter extension, so there is none of the user's browsers to drive. " +
        `Call ${NEW_CALL} for a fresh headless Chrome (no logins), or ask the user to open Chrome with the Playwriter extension and click its icon on a tab.`,
    )
  }
  throw new ModelFacingError(
    `${extensions.length} Chrome profiles are connected through the Playwriter extension and this session has not chosen one:\n` +
      `${describeChoices(extensions)}\nChoose with:\n${choiceCalls(extensions)}\n` +
      "(The user can also preset the choice with PLAYWRITER_BROWSER in this MCP server's configuration.)",
  )
}

/** The reply to `use` / `new`: what is driven now, its pages, and that the session was reset. */
function boundReply({ headline, released, page, context }: { headline: string; released: string | null; page: Page; context: BrowserContext }): string {
  const pages = context.pages().length
  return [
    ...(released ? [released] : []),
    headline,
    `${pages === 1 ? '1 page' : `${pages} pages`} open; current page: ${page.url()}`,
    'The page, context and state were reset: `state` is empty and globals added by earlier calls are gone.',
  ].join('\n')
}

async function checkRemoteServer({ host, port }: { host: string; port: number }): Promise<void> {
  const { httpBaseUrl } = parseRelayHost(host, port)
  const versionUrl = `${httpBaseUrl}/version`
  try {
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}`)
    }
  } catch (error: any) {
    const isConnectionError = error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError'
    if (isConnectionError) {
      throw new Error(
        `Cannot connect to remote relay server at ${host}. ` +
          "Ask the user to start the relay on that machine (playwriter serve) or to fix PLAYWRITER_HOST in this MCP server's configuration.",
      )
    }
    throw new Error(`Failed to connect to remote relay server: ${error.message}`)
  }
}

const server = new McpServer({
  name: 'playwriter',
  title: 'The better playwright MCP: works as a browser extension. No context bloat. More capable.',
  version: VERSION,
})

const promptContent =
  fs.readFileSync(path.join(__dirname, '..', 'dist', 'prompt.md'), 'utf-8') +
  `\n\nfor debugging internal playwriter errors, check playwriter relay server logs at: ${LOG_FILE_PATH}`

server.resource(
  'debugger-api',
  'https://playwriter.dev/resources/debugger-api.md',
  { mimeType: 'text/plain' },
  async () => {
    const packageJsonPath = require.resolve('playwriter/package.json')
    const packageDir = path.dirname(packageJsonPath)
    const content = fs.readFileSync(path.join(packageDir, 'dist', 'debugger-api.md'), 'utf-8')
    return {
      contents: [{ uri: 'https://playwriter.dev/resources/debugger-api.md', text: content, mimeType: 'text/plain' }],
    }
  },
)

server.resource(
  'editor-api',
  'https://playwriter.dev/resources/editor-api.md',
  { mimeType: 'text/plain' },
  async () => {
    const packageJsonPath = require.resolve('playwriter/package.json')
    const packageDir = path.dirname(packageJsonPath)
    const content = fs.readFileSync(path.join(packageDir, 'dist', 'editor-api.md'), 'utf-8')
    return {
      contents: [{ uri: 'https://playwriter.dev/resources/editor-api.md', text: content, mimeType: 'text/plain' }],
    }
  },
)

server.resource(
  'styles-api',
  'https://playwriter.dev/resources/styles-api.md',
  { mimeType: 'text/plain' },
  async () => {
    const packageJsonPath = require.resolve('playwriter/package.json')
    const packageDir = path.dirname(packageJsonPath)
    const content = fs.readFileSync(path.join(packageDir, 'dist', 'styles-api.md'), 'utf-8')
    return {
      contents: [{ uri: 'https://playwriter.dev/resources/styles-api.md', text: content, mimeType: 'text/plain' }],
    }
  },
)

server.resource(
  'page-model-api',
  'https://playwriter.dev/resources/page-model-api.md',
  { mimeType: 'text/plain' },
  async () => {
    const packageJsonPath = require.resolve('playwriter/package.json')
    const packageDir = path.dirname(packageJsonPath)
    const content = fs.readFileSync(path.join(packageDir, 'dist', 'page-model-api.md'), 'utf-8')
    return {
      contents: [{ uri: 'https://playwriter.dev/resources/page-model-api.md', text: content, mimeType: 'text/plain' }],
    }
  },
)

server.resource(
  'trace-api',
  'https://playwriter.dev/resources/trace-api.md',
  { mimeType: 'text/plain' },
  async () => {
    const packageJsonPath = require.resolve('playwriter/package.json')
    const packageDir = path.dirname(packageJsonPath)
    const content = fs.readFileSync(path.join(packageDir, 'dist', 'trace-api.md'), 'utf-8')
    return {
      contents: [{ uri: 'https://playwriter.dev/resources/trace-api.md', text: content, mimeType: 'text/plain' }],
    }
  },
)

server.resource(
  'skill-reference',
  'https://playwriter.dev/resources/skill-reference.md',
  { mimeType: 'text/plain' },
  async () => {
    const packageJsonPath = require.resolve('playwriter/package.json')
    const packageDir = path.dirname(packageJsonPath)
    const content = fs.readFileSync(path.join(packageDir, 'dist', 'skill-reference.md'), 'utf-8')
    return {
      contents: [{ uri: 'https://playwriter.dev/resources/skill-reference.md', text: content, mimeType: 'text/plain' }],
    }
  },
)

server.tool(
  'execute',
  promptContent,
  {
    code: z
      .string()
      .describe(
        'JavaScript run against the controlled browser tab. In scope: observe, act, find, explain, readPage, docs, page, state, context, snapshot, screenshot, getLatestLogs, net, cookies, storage, webmcp, perf, audit. Usually one line; in human mode one input action per call (waits and reads are free).',
      ),
    timeout: z
      .number()
      .default(30000)
      .describe('Timeout in milliseconds for this call (default 30000). act.waitForIdle on a slow AI reply needs more: pass e.g. 120000.'),
  },
  async ({ code, timeout }) => {
    try {
      // Check relay server on every execute to auto-recover from crashes
      // (skip in direct CDP mode — no relay involved)
      if (!process.env.PLAYWRITER_DIRECT) {
        await ensureLocalRelay()
      }

      const exec = await getOrCreateExecutor()
      const result = await exec.execute(code, timeout)

      // Transform executor result to MCP format
      // Append screenshot metadata to text for MCP (image is included inline as content)
      let text = result.text
      for (const s of result.screenshots) {
        text += `\nScreenshot saved to: ${s.path} (image included below, ${s.labelCount} labels)\n`
        text += `Accessibility snapshot:\n${s.snapshot}\n`
      }
      text = (await loadExecutorModule()).capOutput(text)

      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text },
      ]

      for (const image of result.images) {
        content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      }

      if (result.isError) {
        return { content, isError: true }
      }

      return { content }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack || error.message : String(error)
      // Only the executor module throws CodeExecutionTimeoutError: when it never loaded, this is not one.
      const loaded = executorModule ? await executorModule.catch(() => null) : null
      const isTimeoutError =
        (loaded !== null && error instanceof loaded.CodeExecutionTimeoutError) ||
        (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
      // No browser chosen, or the configured one is not connected: the message says what to do.
      const isModelFacing = error instanceof ModelFacingError

      console.error('Error in execute tool:', errorStack)
      if (!isTimeoutError && !isModelFacing) {
        sendLogToRelayServer('error', 'Error in execute tool:', errorStack)
      }

      const resetHint =
        isTimeoutError || isModelFacing
          ? ''
          : '\n\n[HINT: If this is an internal Playwright error, page/browser closed, or connection issue, call the `reset` tool to reconnect. Do NOT reset for other non-connection non-internal errors.]'

      // timeout stacks are internal noise (Promise.race / setTimeout); only show the message
      const errorText = isTimeoutError || isModelFacing ? errorMessage : errorStack
      return {
        content: [{ type: 'text', text: `Error executing code: ${errorText}${resetHint}` }],
        isError: true,
      }
    }
  },
)

server.tool(
  'reset',
  dedent`
    Recreates the CDP connection and resets the browser/page/context. Use this when the MCP stops responding, you get connection errors, if there are no pages in context, assertion failures, or other issues. It reconnects the same browser; the \`browser\` tool changes which browser this session drives. Not needed after a TAB CLOSED, PAGE CRASHED or DEBUGGER CUT line: execute keeps working and that line says what to do.

    After calling this tool, the page and context variables are automatically updated in the execution environment.

    This tools also removes any custom properties you may have added to the global scope AND clearing all keys from the \`state\` object. Only \`page\`, \`context\`, \`state\` (empty), \`console\`, and utility functions will remain.

    if playwright always returns all pages as about:blank urls and evaluate does not work you should ask the user to restart Chrome. This is a known Chrome bug.
  `,
  {},
  async () => {
    try {
      // Check relay server to auto-recover from crashes
      // (skip in direct CDP mode — no relay involved)
      if (!process.env.PLAYWRITER_DIRECT) {
        await ensureLocalRelay()
      }

      const exec = await getOrCreateExecutor()
      const { page, context } = await exec.reset()
      const pagesCount = context.pages().length
      return {
        content: [
          {
            type: 'text',
            text: `Connection reset successfully. ${pagesCount} page(s) available. Current page URL: ${page.url()}`,
          },
        ],
      }
    } catch (error: unknown) {
      return {
        content: [{ type: 'text', text: `Failed to reset connection: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

/** What the `browser` tool does for one call; throws ModelFacingError for every refusal. */
async function runBrowserAction(action: 'list' | 'use' | 'new', choice: string | undefined, options: NewBrowserOptions): Promise<string> {
  if (action !== 'use' && choice !== undefined) {
    throw new ModelFacingError(`\`browser\` is only read by use; ${action} takes no browser.`)
  }
  const given = Object.entries(options).flatMap(([name, value]) => (value === undefined ? [] : [name]))
  if (action !== 'new' && given.length > 0) {
    throw new ModelFacingError(`${given.join(', ')} ${given.length === 1 ? 'is' : 'are'} only read by new; ${action} takes none. Nothing was changed.`)
  }
  const direct = process.env.PLAYWRITER_DIRECT
  if (direct) {
    const configuredDirect =
      `This MCP server is configured with PLAYWRITER_DIRECT=${direct}, so it drives only that browser: use and new are refused. ` +
      "To drive another browser, ask the user to change PLAYWRITER_DIRECT in this MCP server's configuration."
    if (action !== 'list') {
      throw new ModelFacingError(configuredDirect)
    }
    return `${configuredDirect}\nThis session drives: ${binding ? describeBinding(binding) : 'that browser, from the first execute or reset'}`
  }

  if (action === 'new') {
    const { exec, released, plan } = await bindNewBrowser(options)
    const { page, context } = await exec.reset()
    return boundReply({
      headline: [
        `Now driving a new ${plan.headed ? 'headed' : 'headless'} Chrome launched for this session: no logins, no extensions, nothing shared with the user's browsers.`,
        ...(exec.describeNewBrowser() ?? []).map((line) => `  ${line}`),
      ].join('\n'),
      released,
      page,
      context,
    })
  }

  await ensureLocalRelay()
  const extensions = await fetchConnectedExtensions()
  if (action === 'list') {
    const pending = process.env.PLAYWRITER_BROWSER?.trim()
    const current = binding
      ? describeBinding(binding)
      : pending
        ? `none chosen yet (PLAYWRITER_BROWSER="${pending}" in this server's configuration applies at the first execute or reset)`
        : 'none chosen yet'
    return `Browsers this session can drive:\n${describeChoices(extensions)}\nThis session drives: ${current}\nChoose with:\n${choiceCalls(extensions)}`
  }

  const wanted = choice?.trim()
  if (!wanted) {
    throw new ModelFacingError(`use needs \`browser\`: a profile email or a key. The choices are:\n${describeChoices(extensions)}\nChoose with:\n${choiceCalls(extensions)}`)
  }
  const extension = resolveChoice(wanted, extensions, 'use')
  const { exec, released } = await bindExtension(extension)
  const { page, context } = await exec.reset()
  return boundReply({
    headline: `Now driving ${emailOf(extension) || '(not signed in)'} (key ${extension.stableKey}): the user's Chrome, through its Playwriter extension.`,
    released,
    page,
    context,
  })
}

server.tool(
  'browser',
  dedent`
    Chooses which browser this session drives; execute and reset then run on it.

    - \`{ action: "list" }\`: every browser you can drive — each of the user's Chrome profiles connected through the Playwriter extension (email, key, attached tabs) and \`new\` — and which one this session drives now.
    - \`{ action: "use", browser: "<email or key>" }\`: drive that Chrome profile, the user's real logged-in browser.
    - \`{ action: "new" }\`: launch a fresh Chrome for this session: no logins, no extensions, nothing shared with the user's browsers. Pages see a normal Chrome of that version on this computer (no automation flag, no "HeadlessChrome").
      Options (only with new, all optional): \`viewport: { width, height }\` (default 1280×720) or \`device: "Pixel 7"\` (a phone/tablet/desktop Chrome preset; an unknown name lists them), \`userAgent\`, \`locale: "fr-FR"\`, \`timezone: "America/New_York"\`, \`colorScheme: "dark"\`, \`headed: true\` (a visible window; needs a display), \`allowedDomains: ["example.com"]\` (other hosts are blocked and the report says so), \`downloads: "/tmp/dl"\` (every download is also saved there under its own name).
      Example: \`{ action: "new", device: "Pixel 7", locale: "de-DE" }\`.

    Switching releases the previous browser (the user's tabs stay open; a Chrome this session launched is closed) and resets page, context and \`state\`.
  `,
  {
    action: z.enum(['list', 'use', 'new']).describe('list the choices, use a connected Chrome profile, or launch a new Chrome'),
    browser: z.string().optional().describe('With use: a profile email (case-insensitive) or a key, as list shows them.'),
    ...newBrowserOptionShapes,
  },
  async ({ action, browser: choice, ...options }) => {
    try {
      return { content: [{ type: 'text', text: await runBrowserAction(action, choice, options) }] }
    } catch (error) {
      const text =
        error instanceof ModelFacingError
          ? error.message
          : `browser ${action} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      if (!(error instanceof ModelFacingError)) {
        sendLogToRelayServer('error', `Error in browser ${action}:`, text)
      }
      return { content: [{ type: 'text', text }], isError: true }
    }
  },
)

export async function startMcp(options: { host?: string; token?: string } = {}) {
  if (options.host) {
    process.env.PLAYWRITER_HOST = options.host
  }
  if (options.token) {
    process.env.PLAYWRITER_TOKEN = options.token
  }

  // In direct CDP mode (PLAYWRITER_DIRECT env var), no relay server needed
  if (process.env.PLAYWRITER_DIRECT) {
    mcpLog(`Using direct CDP connection: ${process.env.PLAYWRITER_DIRECT}`)
  } else {
    mcpLog(`Workspace: ${workspace.label} (${workspace.key}, ${workspace.kind})`)
    const remote = getRemoteConfig()
    if (!remote) {
      await ensureRelayServerForMcp()
    } else {
      mcpLog(`Using remote CDP relay server: ${remote.host}`)
      await checkRemoteServer(remote)
    }
  }

  // Once the client is initialized (the server answered without loading the executor), load the
  // executor in the background, and with PLAYWRITER_BROWSER=new start the session's browser too: it
  // launches while the model reads the tool list, and the first execute takes it.
  server.server.oninitialized = () => {
    const prelaunch = process.env.PLAYWRITER_BROWSER?.trim() === 'new' && !process.env.PLAYWRITER_DIRECT
    const warm = prelaunch ? getOrCreateExecutor().then((exec) => exec.prelaunch()) : loadExecutorModule()
    warm.catch((error: unknown) => mcpLog('Preparing the browser at startup failed; the first execute reports why:', error))
  }
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // A browser still being created at stdin's end is released too (the startup prelaunch).
  const release = async (): Promise<string | null> => {
    await creatingExecutor?.catch(() => {})
    return releaseBinding()
  }
  exitOnStdinEnd({ stdin: process.stdin, release, log: mcpLog, exit: (code) => process.exit(code), graceMs: 5000 })
}
