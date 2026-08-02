// Verifies CLI help stays runnable without loading browser-start-only dependencies.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const playwriterDir = path.resolve(currentDir, '..')
const viteNodeBinary = path.join(
  playwriterDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite-node.cmd' : 'vite-node',
)

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(viteNodeBinary, ['src/cli.ts', ...args], {
    cwd: playwriterDir,
    env: process.env,
  })
}

describe('playwriter cli help', () => {
  test('renders root help without crashing', async () => {
    const { stdout, stderr } = await runCli(['--help'])

    expect(stdout).toContain('playwriter')
    expect(stdout).toContain('serve')
    expect(stderr).toBe('')
  }, 30000)

  test('renders serve help without crashing', async () => {
    const { stdout, stderr } = await runCli(['serve', '--help'])

    expect(stdout).toContain('Start the relay server on this machine')
    expect(stdout).toContain('--replace')
    expect(stderr).toBe('')
  }, 30000)

  // An unknown TOP-LEVEL command is split across both streams by goke (goke.ts:2062 —
  // `this.console.error('Unknown command: ...')` then `this.outputHelp()`, then exit 1):
  // the rejection goes to stderr, the usage hint — the whole root help — goes to stdout.
  //
  // This test used to also assert stderr contained the literal 'playwriter --help'. That
  // string is printed by nothing: not by cli.ts, which has no unknown-command handling of
  // its own, and not by goke on any path (its nearest text is `Run "playwriter <command>
  // --help" ...`, on stdout, and only for the prefix path). It was introduced in d02fa5d
  // together with the goke bump that added these messages, so it has never passed. The
  // sibling test below reads `error.stdout` for the prefix path, which is the same
  // help-goes-to-stdout contract checked correctly — so the expectation, not the CLI, was
  // the thing out of step. Both streams are now pinned, so a future goke bump that drops
  // either half fails here instead of silently degrading the error.
  test('unknown command exits with code 1', async () => {
    try {
      await runCli(['run'])
      expect.unreachable('should have thrown')
    } catch (error: any) {
      expect(error.code).toBe(1)
      // stderr carries the rejection and only the rejection, so a caller who discards
      // stdout still learns the command was refused.
      expect(error.stderr).toContain('Unknown command: run')
      expect(error.stderr).not.toContain('Usage:')
      // stdout carries the remedy: the usage line and the flag that reprints it...
      expect(error.stdout).toContain('$ playwriter <command> [options]')
      expect(error.stdout).toContain('-h, --help')
      // ...followed by the real command list, so the hint is not an empty banner.
      expect(error.stdout).toContain('session new')
      expect(error.stdout).toContain('serve')
    }
  }, 30000)

  test('unknown subcommand exits with code 1', async () => {
    try {
      await runCli(['session', 'nonexistent'])
      expect.unreachable('should have thrown')
    } catch (error: any) {
      expect(error.code).toBe(1)
      expect(error.stdout).toContain('Unknown command: session nonexistent')
      expect(error.stdout).toContain('session new')
    }
  }, 30000)
})
