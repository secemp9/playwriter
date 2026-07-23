/**
 * Workspace identity — the root of worktree-aware tab isolation.
 *
 * Many Claude/CLI sessions share ONE browser through ONE extension via the relay.
 * Without an identity, every client sees every tab. The workspace key is that
 * identity: two sessions in the same git worktree share tabs deliberately, two
 * sessions in different worktrees never see each other's.
 *
 * The key is a PURE FUNCTION of a directory path. Nothing is stored, negotiated or
 * assigned, so daemon restarts, browser restarts and extension reloads are
 * non-events — every participant recomputes the same key from the same path.
 *
 * It keys on the PATH, never on the branch: a worktree directory and its checked
 * out branch routinely disagree (observed in the wild), and a branch can be
 * switched under a live session while the tabs must stay put.
 *
 * Derive ONLY in the MCP/CLI client process, NEVER in the relay daemon. The daemon
 * is spawned by whichever session happened to start it and keeps that session's cwd
 * and env while serving all the others (verified: daemon pid 15745, ppid 15591,
 * held session A's CLAUDE_PROJECT_DIR while serving B, C and D). For the CLI route
 * the caller must pass the cwd from the request body rather than let this module
 * read the daemon's own.
 *
 * There is no fallback anywhere in here. A key that cannot be derived is an error,
 * because a silent default is precisely how one workspace ends up driving another's
 * tabs.
 *
 * Git behaviour relied on below, verified on git 2.34.1 (which supports
 * --path-format=absolute) from a real worktree:
 *
 *   $ cd ~/general_wisdom/monorepo.gwt/ci-stage0-speedup
 *   $ git rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-dir
 *   /home/secemp9/general_wisdom/monorepo.gwt/ci-stage0-speedup   <- the WORKTREE, not the main repo
 *   /home/secemp9/general_wisdom/monorepo/.git                    <- already the MAIN repo's .git
 *   /home/secemp9/general_wisdom/monorepo/.git/worktrees/ci-stage0-speedup
 *
 * Two consequences, both load-bearing:
 * - --git-common-dir needs no ".git/worktrees/<name>" suffix stripping. It never
 *   carries that suffix; --git-dir is the one that does. Do not add a stripper.
 * - the main working tree is exactly `gitDir === commonDir` (both print `<main>/.git`).
 *
 * Subdirectories climb to the same toplevel, so any depth inside a worktree yields
 * that worktree's key.
 */
import cp from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type WorkspaceKind = 'worktree' | 'main' | 'cwd' | 'explicit'

export type Workspace = {
  /** Prefixed hash. Non-empty, stable, and the ONLY thing isolation is decided by. */
  key: string
  /** Human-facing name, used for tab group titles. Never an identity. */
  label: string
  /** Directory the identity was derived from: the git toplevel, else the resolved cwd. */
  root: string
  /** Enclosing repository name, informational only. null when there is no git repo. */
  repo: string | null
  kind: WorkspaceKind
}

type GitPaths = {
  toplevel: string
  commonDir: string
  gitDir: string
}

/**
 * 48 bits over ~37 concurrent worktrees is a collision probability around 2e-12, and
 * the per-kind prefixes namespace the three schemes so an explicit name can never
 * collide with a path hash.
 */
function sha12(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/**
 * An env var set to an empty string is not set. `??` alone would let
 * `CLAUDE_PROJECT_DIR=` through as a real cwd of ''.
 */
function readEnv(name: string): string | null {
  const value = process.env[name]
  if (!value) {
    return null
  }
  return value
}

/**
 * Canonicalise so that symlinked and aliased routes to one directory agree on one key.
 * path.resolve keeps the result deterministic (and therefore the key stable) for a
 * path with no on-disk realpath, e.g. a worktree deleted under a live session.
 */
function realpath(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * True only when we positively KNOW there is no git identity, as opposed to having
 * failed to find out. Verified execFileSync error shapes on node v22:
 *   not a git repository -> { status: 128,  code: undefined }
 *   git not installed    -> { status: null, code: 'ENOENT' }
 *   timed out            -> { status: null, code: 'ETIMEDOUT', signal: 'SIGTERM' }
 *
 * Both accepted cases are determinate and stable: a directory that is not a repo, and
 * a machine with no git, answer the same way on every call, so 'cwd' keying stays put.
 */
function isDeterminateGitAbsence(error: unknown): boolean {
  const { status, code } = error as { status?: number | null; code?: string }
  return typeof status === 'number' || code === 'ENOENT'
}

function readGitPaths(cwd: string): GitPaths | null {
  const output: string | null = (() => {
    try {
      return cp.execFileSync(
        'git',
        ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
      )
    } catch (error) {
      if (isDeterminateGitAbsence(error)) {
        return null
      }
      // We could not DETERMINE the answer. Guessing would hand out a key that
      // disagrees with the one this same directory yields on a healthy call, silently
      // splitting a workspace in two.
      throw new Error(`Cannot derive the playwriter workspace: 'git rev-parse' failed in ${cwd}`, { cause: error })
    }
  })()
  if (output === null) {
    return null
  }
  const lines = output
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.length > 0
    })
  // git succeeded, so it owes us exactly the three paths we asked for, in order.
  // Anything else (a path containing a newline, a future git changing its output) must
  // not be guessed at — a misparse here silently mis-keys every tab.
  if (lines.length !== 3) {
    throw new Error(
      `Cannot derive the playwriter workspace: 'git rev-parse' returned ${lines.length} paths instead of 3 in ${cwd}`,
    )
  }
  return { toplevel: lines[0], commonDir: lines[1], gitDir: lines[2] }
}

/**
 * Resolve the workspace owning `cwd`, defaulting to this process's own directory.
 *
 * CLAUDE_PROJECT_DIR is the session's project root and beats process.cwd(); both are
 * present in the live MCP process, which is spawned one-per-session with the session's
 * cwd. The default is evaluated per call, so an explicit `cwd` argument (the CLI route,
 * which must key off the request body) always wins over the environment.
 */
export function deriveWorkspace(cwd: string = readEnv('CLAUDE_PROJECT_DIR') ?? process.cwd()): Workspace {
  // PLAYWRITER_WORKSPACE is the explicit override and beats git. It names a workspace
  // directly; there is deliberately no 'shared'/'no-isolation' value, because a
  // workspace that sees everything is the bug this module exists to prevent.
  const explicit = readEnv('PLAYWRITER_WORKSPACE')
  if (explicit) {
    return {
      kind: 'explicit',
      key: `x:${sha12(explicit)}`,
      label: explicit.slice(0, 24),
      root: realpath(cwd),
      repo: null,
    }
  }

  const gitPaths = readGitPaths(cwd)
  if (!gitPaths) {
    // Not a fallback: a directory outside any repo gets its own fully specified
    // identity, still isolated per directory.
    const root = realpath(cwd)
    return {
      kind: 'cwd',
      key: `cwd:${sha12(root)}`,
      label: path.basename(root),
      root,
      repo: null,
    }
  }

  const root = realpath(gitPaths.toplevel)
  return {
    kind: gitPaths.gitDir === gitPaths.commonDir ? 'main' : 'worktree',
    key: `wt:${sha12(root)}`,
    label: path.basename(root),
    root,
    repo: path.basename(path.dirname(realpath(gitPaths.commonDir))),
  }
}
