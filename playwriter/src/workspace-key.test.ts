/**
 * Tests for workspace identity derivation — the root of worktree-aware tab isolation.
 *
 * These run against a real throwaway git repository with real linked worktrees, built in
 * the OS temp directory, because the behaviour under test IS git's behaviour: that
 * `--git-common-dir` already points at the main repo's .git from inside a worktree, and
 * that rev-parse climbs from a subdirectory to its toplevel. Faking git would only
 * assert that our own fake matches our own assumptions.
 *
 * The fixture is built under the REALPATH of os.tmpdir() so that every path handed to
 * deriveWorkspace is already canonical. deriveWorkspace canonicalises what it returns,
 * so this is what lets `root` be compared byte for byte against the path we created.
 *
 * Keys derived from paths are machine-specific (they hash an absolute path under a
 * randomly named temp directory), so they are asserted on their RELATIONSHIPS —
 * identical, distinct, stable — and on their shape, never on a literal digest. The one
 * literal digest below is for an explicit name, which is not a path and therefore hashes
 * identically everywhere.
 */
import cp from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { deriveWorkspace } from './workspace-key.js'

/**
 * sha256('foo') truncated to 12 hex chars, under the 'explicit' namespace. Verifiable
 * independently of this codebase: `printf foo | sha256sum` -> 2c26b46b68ff...
 * Pinned as a literal so that a change to the hash function, the digest length or the
 * prefix fails loudly instead of silently rekeying every workspace on upgrade.
 */
const EXPLICIT_FOO_KEY = 'x:2c26b46b68ff'

let fixtureRoot: string
let mainRepo: string
let mainRepoSubdir: string
let worktreeA: string
let worktreeASubdir: string
let worktreeB: string
let plainDir: string
/** A PATH entry containing no `git` at all, for the "git is not installed" case. */
let emptyBin: string
/** A PATH entry holding a `git` that misbehaves on demand. */
let fakeGitBin: string

function git(cwd: string, ...args: string[]): void {
  cp.execFileSync(
    'git',
    ['-c', 'user.email=workspace-key@test.invalid', '-c', 'user.name=Workspace Key Test', ...args],
    { cwd, stdio: 'ignore' },
  )
}

/**
 * Install a `git` that is found through PATH but behaves as instructed.
 *
 * The shebang is this process's own node binary, an absolute path, because these tests
 * replace PATH wholesale: a `#!/bin/sh` script could not resolve any external command it
 * tried to run, and would exit 127 — a determinate status, which deriveWorkspace would
 * correctly read as "not a repository" and never reach the case under test.
 */
function installFakeGit(body: string): void {
  const file = path.join(fakeGitBin, 'git')
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`)
  fs.chmodSync(file, 0o755)
  process.env.PATH = fakeGitBin
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'playwriter-workspace-key-'))

  mainRepo = path.join(fixtureRoot, 'monorepo')
  fs.mkdirSync(mainRepo)
  git(mainRepo, 'init', '-b', 'main')
  // `git worktree add` refuses to run on a repository with no commits.
  git(mainRepo, 'commit', '--allow-empty', '-m', 'root commit')

  mainRepoSubdir = path.join(mainRepo, 'nested', 'deep')
  fs.mkdirSync(mainRepoSubdir, { recursive: true })

  worktreeA = path.join(fixtureRoot, 'wt-a')
  git(mainRepo, 'worktree', 'add', '-b', 'feature-a', worktreeA)
  worktreeASubdir = path.join(worktreeA, 'sub', 'dir')
  fs.mkdirSync(worktreeASubdir, { recursive: true })

  worktreeB = path.join(fixtureRoot, 'wt-b')
  git(mainRepo, 'worktree', 'add', '-b', 'feature-b', worktreeB)

  plainDir = path.join(fixtureRoot, 'plain')
  fs.mkdirSync(plainDir)
  emptyBin = path.join(fixtureRoot, 'empty-bin')
  fs.mkdirSync(emptyBin)
  fakeGitBin = path.join(fixtureRoot, 'fake-git-bin')
  fs.mkdirSync(fakeGitBin)
})

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

let savedEnv: Record<string, string | undefined>
let savedCwd: string

beforeEach(() => {
  savedEnv = {
    PLAYWRITER_WORKSPACE: process.env.PLAYWRITER_WORKSPACE,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    PATH: process.env.PATH,
  }
  savedCwd = process.cwd()
  // The ambient environment is an input to deriveWorkspace. An inherited
  // PLAYWRITER_WORKSPACE would short-circuit every git case below into 'explicit', and an
  // inherited CLAUDE_PROJECT_DIR would decide the no-argument cases, so both are cleared
  // and each test sets what it means to exercise.
  delete process.env.PLAYWRITER_WORKSPACE
  delete process.env.CLAUDE_PROJECT_DIR
})

afterEach(() => {
  process.chdir(savedCwd)
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
})

describe('deriveWorkspace — git identity', () => {
  it('identifies the main working tree of a repository', () => {
    const workspace = deriveWorkspace(mainRepo)

    expect(workspace.kind).toBe('main')
    expect(workspace.label).toBe(path.basename(mainRepo))
    expect(workspace.label).toBe('monorepo')
    expect(workspace.root).toBe(mainRepo)
    expect(workspace.repo).toBe('monorepo')
    expect(workspace.key).toMatch(/^wt:[0-9a-f]{12}$/)
  })

  it('identifies a linked worktree and keys it apart from the main working tree', () => {
    const worktree = deriveWorkspace(worktreeA)

    expect(worktree.kind).toBe('worktree')
    expect(worktree.label).toBe('wt-a')
    expect(worktree.root).toBe(worktreeA)
    // --git-common-dir points at <main>/.git even from inside a linked worktree, so repo
    // names the enclosing repository rather than the worktree.
    expect(worktree.repo).toBe('monorepo')
    expect(worktree.key).toMatch(/^wt:[0-9a-f]{12}$/)
    expect(worktree.key).not.toBe(deriveWorkspace(mainRepo).key)
  })

  it('keys two linked worktrees of one repository apart', () => {
    const a = deriveWorkspace(worktreeA)
    const b = deriveWorkspace(worktreeB)

    expect(a.kind).toBe('worktree')
    expect(b.kind).toBe('worktree')
    // Same repository, different identity: this is the whole point of the feature.
    expect(a.repo).toBe('monorepo')
    expect(b.repo).toBe('monorepo')
    expect(a.key).not.toBe(b.key)
  })

  it('resolves a subdirectory of a worktree to that worktree', () => {
    const fromSubdir = deriveWorkspace(worktreeASubdir)

    // An agent working several directories deep must land in its worktree's group.
    expect(fromSubdir).toEqual(deriveWorkspace(worktreeA))
    expect(fromSubdir.root).toBe(worktreeA)
    expect(fromSubdir.key).not.toBe(deriveWorkspace(mainRepo).key)
    expect(fromSubdir.key).not.toBe(deriveWorkspace(worktreeB).key)
  })

  it('resolves a subdirectory of the main working tree to the main working tree', () => {
    const fromSubdir = deriveWorkspace(mainRepoSubdir)

    expect(fromSubdir).toEqual(deriveWorkspace(mainRepo))
    expect(fromSubdir.root).toBe(mainRepo)
  })
})

describe('deriveWorkspace — directories with no git identity', () => {
  it('keys a directory outside any repository by its own path', () => {
    const workspace = deriveWorkspace(plainDir)

    expect(workspace.kind).toBe('cwd')
    expect(workspace.key).toMatch(/^cwd:[0-9a-f]{12}$/)
    expect(workspace.label).toBe('plain')
    expect(workspace.root).toBe(plainDir)
    expect(workspace.repo).toBeNull()
  })

  it('gives a directory outside any repository the same identity on every call', () => {
    // Stability is the requirement: the key is recomputed by every participant on every
    // reconnect, and a key that drifts scatters a workspace's tabs.
    expect(deriveWorkspace(plainDir)).toEqual(deriveWorkspace(plainDir))
  })
})

describe('deriveWorkspace — PLAYWRITER_WORKSPACE', () => {
  it('overrides git identity', () => {
    process.env.PLAYWRITER_WORKSPACE = 'foo'
    const explicit = deriveWorkspace(mainRepo)

    expect(explicit.kind).toBe('explicit')
    expect(explicit.key).toBe(EXPLICIT_FOO_KEY)
    expect(explicit.label).toBe('foo')
    expect(explicit.root).toBe(mainRepo)
    expect(explicit.repo).toBeNull()

    // Teeth: the very same directory really does have a git identity to override, so the
    // assertions above cannot be satisfied by git simply having failed.
    delete process.env.PLAYWRITER_WORKSPACE
    const fromGit = deriveWorkspace(mainRepo)
    expect(fromGit.kind).toBe('main')
    expect(explicit.key).not.toBe(fromGit.key)
  })

  it('makes the name the identity, so two directories under one name share a key', () => {
    process.env.PLAYWRITER_WORKSPACE = 'shared-name'

    // Deliberate: an explicit name is a claim about identity that outranks location.
    expect(deriveWorkspace(worktreeA).key).toBe(deriveWorkspace(worktreeB).key)
    // ...while the two worktrees are otherwise distinct workspaces.
    delete process.env.PLAYWRITER_WORKSPACE
    expect(deriveWorkspace(worktreeA).key).not.toBe(deriveWorkspace(worktreeB).key)
  })

  it('truncates the label to 24 characters while keying on the full name', () => {
    const shared = 'w'.repeat(24)
    process.env.PLAYWRITER_WORKSPACE = `${shared}AAA`
    const first = deriveWorkspace(plainDir)
    process.env.PLAYWRITER_WORKSPACE = `${shared}BBB`
    const second = deriveWorkspace(plainDir)

    expect(first.label).toBe(shared)
    expect(second.label).toBe(shared)
    // The label is cosmetic; the key must still separate two names that only differ past
    // the truncation point.
    expect(first.key).not.toBe(second.key)
  })

  it('treats an empty PLAYWRITER_WORKSPACE as unset', () => {
    process.env.PLAYWRITER_WORKSPACE = ''
    const withEmpty = deriveWorkspace(mainRepo)
    delete process.env.PLAYWRITER_WORKSPACE

    // Verified by mutation: an implementation that kept '' out of readEnv and then tested
    // it against null/undefined rather than for truthiness keys this repository as
    // x:<hash of ''> instead of by its git identity, and this test fails.
    expect(withEmpty.kind).toBe('main')
    expect(withEmpty).toEqual(deriveWorkspace(mainRepo))
  })
})

describe('deriveWorkspace — cwd source precedence', () => {
  it('prefers CLAUDE_PROJECT_DIR over process.cwd()', () => {
    process.chdir(plainDir)
    process.env.CLAUDE_PROJECT_DIR = worktreeA

    const workspace = deriveWorkspace()

    expect(workspace).toEqual(deriveWorkspace(worktreeA))
    expect(workspace.kind).toBe('worktree')
    // Teeth: process.cwd() would have produced a visibly different identity.
    expect(workspace.key).not.toBe(deriveWorkspace(plainDir).key)
  })

  it('uses process.cwd() when CLAUDE_PROJECT_DIR is unset', () => {
    process.chdir(plainDir)

    expect(deriveWorkspace()).toEqual(deriveWorkspace(plainDir))
  })

  it('treats an empty CLAUDE_PROJECT_DIR as unset', () => {
    process.chdir(mainRepo)
    process.env.CLAUDE_PROJECT_DIR = ''

    expect(deriveWorkspace()).toEqual(deriveWorkspace(mainRepo))
  })

  /*
   * Honesty note on the test above, established by mutation: it pins the observable
   * contract (an empty CLAUDE_PROJECT_DIR derives the same workspace as an unset one) but
   * it CANNOT detect the loss of readEnv's empty-string guard, and no test can. Letting ''
   * through reaches the right answer by accident twice over: `git -C ''` is a documented
   * no-op, so git still resolves from process.cwd(), and realpath('') throws ENOENT, so the
   * catch returns path.resolve('') — which is also process.cwd(). The guard is therefore
   * defence-in-depth rather than load-bearing HERE. It is still the right thing to keep:
   * relying on those two coincidences would be far more fragile than checking the input.
   * The same guard IS load-bearing for PLAYWRITER_WORKSPACE, which is covered above.
   */

  it('prefers an explicit cwd argument over CLAUDE_PROJECT_DIR', () => {
    // The CLI route derives from the request body's cwd inside the shared daemon, whose
    // own env belongs to whichever session happened to spawn it. This precedence is what
    // stops that env leaking into another session's key.
    const worktreeAKey = deriveWorkspace(worktreeA).key
    process.chdir(worktreeA)
    process.env.CLAUDE_PROJECT_DIR = worktreeA

    const workspace = deriveWorkspace(worktreeB)

    expect(workspace.kind).toBe('worktree')
    expect(workspace.root).toBe(worktreeB)
    expect(workspace.key).not.toBe(worktreeAKey)
  })
})

describe('deriveWorkspace — determinism', () => {
  it('returns an identical workspace for repeated calls in one directory', () => {
    for (const directory of [mainRepo, worktreeA, worktreeB, worktreeASubdir, plainDir]) {
      expect(deriveWorkspace(directory)).toEqual(deriveWorkspace(directory))
    }
  })
})

describe('deriveWorkspace — key namespacing', () => {
  it('separates the schemes by prefix, so one path cannot collide with itself', () => {
    const fromGit = deriveWorkspace(mainRepo)
    process.env.PATH = emptyBin
    const withoutGit = deriveWorkspace(mainRepo)

    expect(fromGit.kind).toBe('main')
    expect(withoutGit.kind).toBe('cwd')
    // Both hash the SAME resolved path, so only the prefix tells them apart. Any consumer
    // that stripped or normalised the prefix before comparing would silently merge two
    // distinct workspaces — which is exactly the bug this feature exists to kill.
    expect(withoutGit.key.slice('cwd:'.length)).toBe(fromGit.key.slice('wt:'.length))
    expect(withoutGit.key).not.toBe(fromGit.key)
  })
})

describe('deriveWorkspace — git failure modes', () => {
  it('keys by directory when git is not installed', () => {
    process.env.PATH = emptyBin

    const workspace = deriveWorkspace(mainRepo)

    // Determinate: a machine with no git answers this way on every call, so the key is
    // stable and may be handed out.
    expect(workspace.kind).toBe('cwd')
    expect(workspace.root).toBe(mainRepo)
    expect(workspace.repo).toBeNull()
  })

  it('throws when git times out instead of guessing an identity', () => {
    installFakeGit('setTimeout(() => {}, 60000)')

    // Indeterminate: we did not learn that there is no repository, we failed to find out.
    // Keying 'cwd' here would hand out a key that disagrees with the one this same
    // directory yields on a healthy call, silently splitting one workspace in two.
    expect(() => {
      return deriveWorkspace(mainRepo)
    }).toThrow(/Cannot derive the playwriter workspace/)
  })

  it('throws when git succeeds but does not return three paths', () => {
    installFakeGit('console.log("/a\\n/b")')

    expect(() => {
      return deriveWorkspace(mainRepo)
    }).toThrow(/returned 2 paths instead of 3/)
  })
})
