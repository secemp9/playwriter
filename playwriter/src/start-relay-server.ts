import { startPlayWriterCDPRelayServer } from './cdp-relay.js'
import { createFileLogger } from './create-logger.js'
import { RELAY_PORT, waitForRelayVersion } from './relay-client.js'
import { LOG_CDP_FILE_PATH } from './utils.js'

process.title = 'playwriter-ws-server'

const logger = createFileLogger()

/**
 * Logs a last line, writes the log, then exits. The logger writes on a 500 ms timer and process.exit
 * runs no pending timer, so a line logged right before an exit never reached the file: the log of a
 * daemon that exited on a taken port, or crashed, was empty.
 */
async function exitAfterLog(code: number, ...line: unknown[]): Promise<never> {
  try {
    void logger.log(...line)
    await logger.flush()
  } finally {
    process.exit(code)
  }
}

process.on('uncaughtException', (err) => {
  void exitAfterLog(1, 'Uncaught Exception:', err)
})

process.on('unhandledRejection', (reason) => {
  void exitAfterLog(1, 'Unhandled Rejection:', reason)
})

export async function startServer({
  port = 19988,
  host = '127.0.0.1',
  token,
}: { port?: number; host?: string; token?: string } = {}) {
  let server
  try {
    server = await startPlayWriterCDPRelayServer({ port, host, token, logger })
  } catch (err: unknown) {
    // When two relay processes race to start (issue #75), the loser gets
    // EADDRINUSE. Check if the winner is a valid relay and exit cleanly
    // instead of crashing with a scary error in the logs.
    const errWithCode = err as NodeJS.ErrnoException
    if (errWithCode?.code === 'EADDRINUSE') {
      // The winner may have bound the port but not be ready to answer /version
      // yet, so poll for up to 2 seconds before giving up.
      const version = await waitForRelayVersion({ port })
      if (version) {
        return exitAfterLog(0, `Another relay (v${version}) already bound to port ${port}, exiting gracefully`)
      }
      return exitAfterLog(1, `Port ${port} is in use by a non-relay process`)
    }
    throw err
  }

  console.log('CDP Relay Server running. Press Ctrl+C to stop.')
  console.log('Logs are being written to:', logger.logFilePath)
  console.log('CDP logs are being written to:', LOG_CDP_FILE_PATH)

  // close() is awaited before exit(): it closes the shared headless browser, and
  // process.exit(0) fired in the same tick would orphan that Chrome process.
  const shutdown = async (signal: NodeJS.Signals) => {
    console.log('\nShutting down...')
    try {
      await server.close()
    } catch (error) {
      return exitAfterLog(1, `Shutting down on ${signal} failed:`, error)
    }
    await exitAfterLog(0, `Shut down on ${signal}`)
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  return server
}
// The port its clients look for (relay-client's RELAY_PORT, from PLAYWRITER_PORT).
startServer({ port: RELAY_PORT }).catch((error: unknown) => exitAfterLog(1, 'The relay did not start:', error))
