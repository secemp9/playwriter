/**
 * The MCP server's end of life: an MCP stdio client ends a session by closing the server's stdin
 * and waiting for it to exit (MCP spec, Transports › stdio › shutdown; SIGTERM only if it does
 * not). Nothing can reach the server after that, so it releases what it drives — a headless
 * Chrome it launched is closed, a relay or direct connection is dropped — and exits.
 *
 * Without this the process outlived EOF (measured: still alive 30 s after its stdin closed, with
 * its headless Chrome) and only went on SIGTERM.
 */

import type { Readable } from 'node:stream'

export interface ExitOnStdinEndOptions {
  stdin: Readable
  /** Release the browser binding (close a launched Chrome, disconnect otherwise). */
  release: () => Promise<unknown>
  log: (message: string) => void
  exit: (code: number) => void
  /**
   * How long the release may take before the process exits anyway. Exiting still ends a Chrome
   * that Playwright launched: its exit handler kills the processes it spawned.
   */
  graceMs: number
}

/** Exit once stdin ends or closes, after releasing the browser (bounded by `graceMs`). */
export function exitOnStdinEnd({ stdin, release, log, exit, graceMs }: ExitOnStdinEndOptions): void {
  let ending = false
  const end = (how: string): void => {
    if (ending) return
    ending = true
    log(`stdin ${how}: the MCP client is gone; releasing the browser and exiting`)
    const timer = setTimeout(() => {
      log(`releasing the browser took over ${graceMs}ms; exiting anyway`)
      exit(0)
    }, graceMs)
    release()
      .catch((error: unknown) => log(`releasing the browser failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        clearTimeout(timer)
        exit(0)
      })
  }
  stdin.once('end', () => end('ended'))
  stdin.once('close', () => end('closed'))
}
