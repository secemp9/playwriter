/**
 * Cross-platform process termination for a TCP port.
 *
 * This mirrors the approach used by the `kill-port-process` npm package:
 * https://github.com/hilleer/kill-port-process
 *
 * Notes:
 * - Windows: discover listeners via PowerShell/netstat and kill via taskkill.
 * - Unix: discover listeners via lsof (preferred) or fuser (fallback) and kill via
 *   process.kill(). This intentionally avoids shell pipelines (grep/awk/xargs). On Linux the
 *   kernel's socket tables answer first: a port nothing listens on costs no process scan.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type KillPortSignal = 'SIGTERM' | 'SIGKILL'

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

function parsePids(output: string): number[] {
  const matches = output.match(/\d+/g) || []
  const pids = matches
    .map((text) => {
      return Number(text)
    })
    .filter((pid) => {
      return Number.isInteger(pid) && pid > 0
    })

  return [...new Set(pids)]
}

function parseUnixLsofPids(stdout: string): number[] {
  const pids = stdout
    .split(/\r?\n/g)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      // lsof output starts with a header row; lines we care about contain LISTEN.
      return Boolean(line) && !line.startsWith('COMMAND') && line.includes('LISTEN')
    })
    .map((line) => {
      const columns = line.split(/\s+/g)
      // `awk '{print $2}'` in kill-port-process extracts PID from 2nd column.
      return Number(columns[1] || '')
    })
    .filter((pid) => {
      return Number.isInteger(pid) && pid > 0
    })

  return [...new Set(pids)]
}

function parseWindowsNetstatPids(output: string, port: number): number[] {
  const rows = output
    .split(/\r?\n/g)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('TCP')
    })

  const pids = rows
    .map((row) => {
      const columns = row.split(/\s+/g)
      const localAddress = columns[1] || ''
      const state = columns[3] || ''
      const pid = columns[4] || ''
      const endsWithPort = localAddress.endsWith(`:${port}`)
      if (!endsWithPort || state !== 'LISTENING') {
        return NaN
      }
      return Number(pid)
    })
    .filter((pid) => {
      return Number.isInteger(pid) && pid > 0
    })

  return [...new Set(pids)]
}

async function getPidsForPortWindows(port: number): Promise<number[]> {
  const powerShellScript = [
    "$ErrorActionPreference='SilentlyContinue'",
    `@(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique) -join [Environment]::NewLine`,
  ].join('; ')

  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', powerShellScript])
    const pids = parsePids(stdout)
    if (pids.length > 0) {
      return pids
    }
  } catch {}

  try {
    const { stdout } = await execFileAsync('cmd', ['/d', '/s', '/c', 'netstat -ano -p tcp'])
    return parseWindowsNetstatPids(stdout, port)
  } catch {
    return []
  }
}

/**
 * lsof exits 1 and prints nothing when no process matches: an answer ("nothing listens"), not a
 * failure. Its fallbacks scan every process again, and give no other answer.
 */
function isLsofNoMatch(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 1) {
    return false
  }
  const stdout = 'stdout' in error ? error.stdout : undefined
  const stderr = 'stderr' in error ? error.stderr : undefined
  return stdout === '' && stderr === ''
}

/**
 * Linux: whether any TCP socket listens on the port, read from the kernel's socket tables. Unlike
 * lsof and fuser it scans no process, so a machine running many processes does not slow it down.
 * `null`: neither table can be read.
 */
async function linuxHasListener(port: number): Promise<boolean | null> {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0')
  const tables = await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => {
      return fs.promises.readFile(file, 'utf8').catch(() => null)
    }),
  )
  if (tables.every((table) => table === null)) {
    return null
  }
  // Each row: `sl local_address rem_address st …`, the address as `HEXIP:HEXPORT`, state 0A = LISTEN.
  return tables.some((table) => {
    return (table ?? '')
      .split('\n')
      .slice(1)
      .some((row) => {
        const [, local = '', , state] = row.trim().split(/\s+/)
        return state === '0A' && local.endsWith(`:${portHex}`)
      })
  })
}

async function getPidsForPortUnix(port: number): Promise<number[]> {
  if (os.platform() === 'linux' && (await linuxHasListener(port)) === false) {
    return []
  }

  try {
    // Prefer lsof's built-in filtering and pid-only output. `-w`: no warnings (e.g. a file system it
    // cannot stat), so an empty stderr tells "no match" apart from unsupported flags.
    const { stdout } = await execFileAsync('lsof', ['-w', '-n', '-P', '-i', `TCP:${port}`, '-sTCP:LISTEN', '-t'])
    const pids = parsePids(stdout)
    return pids
  } catch (error) {
    if (isLsofNoMatch(error)) {
      return []
    }
  }

  try {
    // Compatibility fallback: some environments may have lsof but not support
    // the exact flags above. Parse the tabular output.
    const { stdout } = await execFileAsync('lsof', ['-i', `tcp:${port}`])
    const pids = parseUnixLsofPids(stdout)
    if (pids.length > 0) {
      return pids
    }
  } catch {}

  // Fallback for Linux environments that may not have `lsof`.
  try {
    const { stdout } = await execFileAsync('fuser', [`${port}/tcp`])
    return parsePids(stdout).filter((pid) => {
      return pid !== port
    })
  } catch {
    return []
  }
}

/**
 * Return PIDs (if any) that are currently LISTENing on the given TCP port.
 *
 * This is intentionally separate from killPortProcess(): callers sometimes need
 * to detect/diagnose EADDRINUSE before attempting to start a server.
 */
export async function getListeningPidsForPort({ port }: { port: number }): Promise<number[]> {
  if (!isValidPort(port)) {
    throw new Error(`Invalid port: ${port}`)
  }

  return os.platform() === 'win32' ? await getPidsForPortWindows(port) : await getPidsForPortUnix(port)
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value
  }
  return new Error(String(value))
}

async function terminatePidWindows(pid: number): Promise<void> {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'])
  } catch {}
}

/**
 * Kill any listening process bound to the provided TCP port.
 */
export async function killPortProcess({
  port,
  signal = 'SIGKILL',
}: {
  port: number
  signal?: KillPortSignal
}): Promise<void> {
  if (!isValidPort(port)) {
    throw new Error(`Invalid port: ${port}`)
  }

  if (os.platform() === 'win32') {
    const pids = await getListeningPidsForPort({ port })
    const currentPid = process.pid
    const targetPids = pids.filter((pid) => {
      return pid !== currentPid
    })
    await Promise.all(
      targetPids.map(async (pid) => {
        await terminatePidWindows(pid)
      }),
    )
    return
  }

  const pids = await getListeningPidsForPort({ port })
  const currentPid = process.pid
  const targetPids = pids.filter((pid) => {
    return pid !== currentPid
  })

  if (targetPids.length === 0) {
    return
  }

  await Promise.all(
    targetPids.map(async (pid) => {
      try {
        process.kill(pid, signal)
      } catch (error) {
        const err = toError(error)
        // If the process already exited between discovery and kill, ignore.
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          return
        }
        throw new Error(`Failed to kill pid ${pid} on port ${port}`, { cause: err })
      }
    }),
  )
}
