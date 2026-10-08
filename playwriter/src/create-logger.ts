import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import stripAnsi from 'strip-ansi'
import { LOG_FILE_PATH } from './utils.js'

export type Logger = {
  log(...args: unknown[]): Promise<void>
  error(...args: unknown[]): Promise<void>
  /** Flush buffered log lines to disk (call before process.exit) */
  flush(): Promise<void>
  logFilePath: string
}

export function createFileLogger({ logFilePath }: { logFilePath?: string } = {}): Logger {
  const resolvedLogFilePath = logFilePath || LOG_FILE_PATH
  const logDir = path.dirname(resolvedLogFilePath)
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  fs.writeFileSync(resolvedLogFilePath, '')

  let queue: Promise<void> = Promise.resolve()

  // Batch buffer: accumulate log lines and flush periodically to reduce disk I/O
  // under high CDP event throughput. See: https://github.com/remorses/playwriter/issues/96
  // Batching (d), no state signal to flush on: lines arrive one at a time, and the interval turns them
  // into one append per 500 ms; flush() writes what is buffered at once (before an exit).
  const FLUSH_INTERVAL_MS = 500
  let buffer: string[] = []
  let flushTimer: ReturnType<typeof setInterval> | undefined

  /**
   * Appends the buffered lines. A write that fails (disk full, the file's folder removed) loses
   * those lines; it says so on stderr — the log file is what failed — and leaves the queue usable,
   * so the next lines are written and no caller, timer or exit path is handed a rejection.
   */
  const flushBuffer = async (): Promise<void> => {
    if (buffer.length === 0) {
      return
    }
    const lines = buffer
    buffer = []
    try {
      await fs.promises.appendFile(resolvedLogFilePath, lines.join('\n') + '\n')
    } catch (error) {
      process.stderr.write(`[playwriter] ${lines.length} log line(s) could not be written to ${resolvedLogFilePath}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  const log = (...args: unknown[]): Promise<void> => {
    const message = args
      .map((arg) =>
        typeof arg === 'string' ? arg : util.inspect(arg, { depth: null, colors: false, maxStringLength: 1000 }),
      )
      .join(' ')
    buffer.push(stripAnsi(message))
    if (!flushTimer) {
      flushTimer = setInterval(() => {
        queue = queue.then(flushBuffer)
      }, FLUSH_INTERVAL_MS)
      flushTimer.unref()
    }
    return queue
  }

  const flush = async (): Promise<void> => {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = undefined
    }
    queue = queue.then(flushBuffer)
    await queue
  }

  return {
    log,
    error: log,
    flush,
    logFilePath: resolvedLogFilePath,
  }
}
