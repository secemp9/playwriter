import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Stream } from 'node:stream'
import path from 'node:path'
import url from 'node:url'
import type { PolicyMode } from './probe-types.js'

const __filename = url.fileURLToPath(import.meta.url)

export interface CreateTransportOptions {
  clientName?: string
  port?: number
  /**
   * The code policy of the spawned MCP server (`PLAYWRITER_POLICY`). Unset: the server's default
   * (`human`), or whatever PLAYWRITER_POLICY the test process itself runs with.
   */
  policy?: PolicyMode
  /** More environment for the spawned MCP server (e.g. PLAYWRITER_BROWSER, PLAYWRITER_BROWSER_PATH), applied last. */
  env?: Record<string, string>
}

export async function createTransport({
  args = [],
  port,
  policy,
  env: extraEnv = {},
}: { args?: string[]; port?: number; policy?: PolicyMode; env?: Record<string, string> } = {}): Promise<{
  transport: StdioClientTransport
  stderr: Stream | null
}> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DEBUG: 'playwriter:mcp:test',
    DEBUG_COLORS: '0',
    DEBUG_HIDE_DATE: '1',
  }
  if (port) {
    env.PLAYWRITER_PORT = String(port)
  }
  if (policy) {
    env.PLAYWRITER_POLICY = policy
  }
  Object.assign(env, extraEnv)
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['vite-node', path.join(path.dirname(__filename), 'cli.ts'), ...args],
    cwd: path.join(path.dirname(__filename), '..'),
    stderr: 'pipe',
    env,
  })

  return {
    transport,
    stderr: transport.stderr!,
  }
}

export async function createMCPClient(options?: CreateTransportOptions): Promise<{
  client: Client
  stderr: string
  cleanup: () => Promise<void>
  /** The MCP server's process id (the spawned `pnpm vite-node … cli.ts`); what it launches descends from it. */
  pid: number
}> {
  const client = new Client({
    name: options?.clientName ?? 'test',
    version: '1.0.0',
  })

  const { transport, stderr } = await createTransport({ port: options?.port, policy: options?.policy, env: options?.env })

  let stderrBuffer = ''
  stderr?.on('data', (data) => {
    process.stderr.write(data)

    stderrBuffer += data.toString()
  })

  await client.connect(transport)
  await client.ping()
  const pid = transport.pid
  if (pid === null) {
    throw new Error('The MCP server process has no pid after connecting: it is not running.')
  }

  const cleanup = async () => {
    try {
      await client.close()
    } catch (e) {
      console.error('Error during MCP client cleanup:', e)
      // Ignore errors during cleanup
    }
  }

  return {
    client,
    stderr: stderrBuffer,
    cleanup,
    pid,
  }
}
