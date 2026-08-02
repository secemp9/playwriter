/**
 * Security-boundary tests for the `execute()` sandbox.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately is NOT.
 *
 * A `vm` context is not an isolate. Every global the sandbox is handed — `page`,
 * `Buffer`, `fetch`, even a plain `state` object — is a HOST-realm value, and any
 * host-realm function's `.constructor` is the host `Function`. So
 * `Buffer.constructor('return process')()` returns the real `process`, from which
 * everything follows. That route is demonstrated (not merely asserted) at the bottom of
 * this file, and it cannot be closed while live Playwright objects cross the boundary.
 *
 * What CAN be held, and is what these tests defend, is the weaker property the shipped
 * documentation actually promises: **ordinary property access on the documented sandbox
 * surface does not reach host capability.** `require` has an allowlist; `fs` is write-
 * jailed; the relay process cannot be killed. Those are guardrails against an agent
 * doing something destructive by accident or by following a prompt-injected instruction
 * literally — not a defence against someone specifically attacking the runtime.
 *
 * The bug that produced this file: `import: (specifier) => import(specifier)` sat one
 * line below the allowlisted `require`, with no allowlist, while `dist/prompt.md` said
 * "ESM `import` is not available in the sandbox". `globalThis.import('node:child_process')`
 * ran a shell. The audit that followed found the same shape in four more places.
 *
 * Tests here assert PROPERTIES, not strings: every Node builtin is swept against every
 * module-loading route, and the sandbox global surface and the ScopedFS method surface
 * are pinned as closed sets, so a hole opened NEXT to a fixed one fails a test instead
 * of slipping through.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { builtinModules } from 'node:module'
import { afterAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { ScopedFS } from './scoped-fs.js'

/* ------------------------------------------------------------------ harness */

const tempDirs: string[] = []
function makeCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-escape-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

/** Stub page/context: `buildSandboxContext` needs no live browser, which is the point. */
function buildSandbox(cwd = makeCwd()) {
  const executor = new PlaywrightExecutor({
    cdpConfig: { headless: true },
    logger: { log: () => {}, error: () => {} },
    cwd,
  })
  const page: any = {
    on: () => page,
    off: () => page,
    once: () => page,
    isClosed: () => false,
    url: () => 'https://example.test/',
    locator: (selector: string) => ({ selector: () => selector, page: () => page }),
    frames: () => [],
    context: () => context,
    evaluate: async () => undefined,
  }
  const context: any = { on: () => context, pages: () => [page], setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {} }
  const { vmContextObj } = executor.buildSandboxContext({ page, context, consoleLogs: [] })
  const vmContext = vm.createContext(vmContextObj)
  /** Run a statement body as the sandbox really runs it: inside an async IIFE. */
  const run = (body: string) => vm.runInContext(`(async () => { ${body} })()`, vmContext, { timeout: 5000 })
  return { executor, vmContextObj, vmContext, run, cwd, page, context }
}

/** A path that is outside every allowed directory, on every platform this runs on. */
const OUTSIDE = path.join(path.parse(process.cwd()).root, 'etc', 'sandbox-escape-probe')
const OUTSIDE_READABLE = process.platform === 'win32' ? OUTSIDE : '/etc/hostname'

/* ------------------------------------------------- 1. the reported escape */

describe('the `import` global is gone, and cannot be reached by any spelling', () => {
  const { vmContextObj, run } = buildSandbox()

  it('is not present on the sandbox globals at all', () => {
    // Not just falsy — absent. A `get` that returns undefined would still be a name
    // someone could later fill in without touching this file.
    expect(Object.prototype.hasOwnProperty.call(vmContextObj, 'import')).toBe(false)
    expect(vmContextObj.import).toBeUndefined()
  })

  it('globalThis.import("node:child_process") no longer yields a shell', async () => {
    await expect(run(`return await globalThis.import('node:child_process')`)).rejects.toThrow(
      /globalThis\.import is not a function/,
    )
  })

  it('globalThis.import("node:fs") no longer yields an unjailed fs', async () => {
    await expect(run(`return await globalThis.import('node:fs')`)).rejects.toThrow(
      /globalThis\.import is not a function/,
    )
  })

  it('bare `import(...)` syntax never consulted the globals and still does not run', async () => {
    // This is WHY removing the global cost no capability: the syntactic form is a
    // different mechanism entirely, and it has always failed in a vm context. The
    // global was therefore only ever reachable as `globalThis.import(...)`.
    await expect(run(`return await import('node:child_process')`)).rejects.toThrow(
      /dynamic import callback was not specified/,
    )
  })

  it('`import` cannot be named as a bare identifier either', async () => {
    // Reserved word: there is no expression form other than the two above, so a global
    // literally named `import` can only ever be called via `globalThis`.
    expect(() => vm.runInContext('typeof import', vm.createContext({}))).toThrow(
      /Cannot use import statement outside a module/,
    )
  })
})

/* ------------------------------------- 2. property: no route bypasses the allowlist */

/**
 * Every module-loading entry point the sandbox exposes. Before this file there were
 * three, and only the first consulted ALLOWED_MODULES.
 *
 * When a new global that can load a module is added, add it here — the closed-set test
 * below will not let it be added silently.
 */
const MODULE_LOADING_ROUTES: Array<{ name: string; load: (ctx: any, id: string) => unknown }> = [
  { name: 'require(id)', load: (ctx, id) => ctx.require(id) },
  { name: 'require.resolve(id)', load: (ctx, id) => ctx.require.resolve(id) },
  { name: 'process.getBuiltinModule(id)', load: (ctx, id) => ctx.process.getBuiltinModule(id) },
]

/** Modules on the allowlist, in both bare and `node:` spellings. */
const ALLOWED_IDS = new Set([
  'path', 'url', 'querystring', 'punycode', 'crypto', 'buffer', 'string_decoder', 'util',
  'assert', 'events', 'timers', 'stream', 'zlib', 'http', 'https', 'http2', 'os', 'fs',
].flatMap((m) => [m, `node:${m}`]))

/**
 * Every builtin this Node ships, in both spellings — not a hand-written list of scary
 * names. A test that only knew about `child_process` would say nothing about
 * `node:sqlite`, `node:worker_threads`, `node:inspector` or whatever ships next.
 */
const ALL_BUILTIN_IDS = [...new Set(builtinModules.flatMap((m) => (m.startsWith('node:') ? [m] : [m, `node:${m}`])))].sort()

describe.each(MODULE_LOADING_ROUTES)('$name enforces ALLOWED_MODULES for EVERY Node builtin', ({ load }) => {
  const { vmContextObj } = buildSandbox()

  it('refuses every builtin that is not on the allowlist, and admits every one that is', () => {
    const wronglyAllowed: string[] = []
    const wronglyRefused: string[] = []
    for (const id of ALL_BUILTIN_IDS) {
      let refused = false
      try {
        load(vmContextObj, id)
      } catch (e: any) {
        refused = e?.name === 'ModuleNotAllowedError'
        if (!refused) throw e
      }
      if (ALLOWED_IDS.has(id) && refused) wronglyRefused.push(id)
      if (!ALLOWED_IDS.has(id) && !refused) wronglyAllowed.push(id)
    }
    expect(wronglyAllowed, 'these builtins escaped the allowlist through this route').toEqual([])
    expect(wronglyRefused, 'these allowlisted builtins were refused through this route').toEqual([])
  })

  it('refuses a filesystem path, so it cannot be used as an out-of-jail existence oracle', () => {
    // `require.resolve('/etc/passwd')` used to return that path and throw for paths that
    // do not exist — a whole-disk stat oracle that never touched ScopedFS.
    expect(() => load(vmContextObj, '/etc/passwd')).toThrow(/not allowed in the sandbox/)
    expect(() => load(vmContextObj, OUTSIDE)).toThrow(/not allowed in the sandbox/)
  })
})

describe('every route to `fs` hands out the SAME jailed object', () => {
  const { vmContextObj, cwd } = buildSandbox()

  it('require, node:require and process.getBuiltinModule all return one ScopedFS', () => {
    const viaRequire = vmContextObj.require('fs')
    expect(viaRequire).toBeInstanceOf(ScopedFS)
    expect(vmContextObj.require('node:fs')).toBe(viaRequire)
    expect(vmContextObj.process.getBuiltinModule('fs')).toBe(viaRequire)
    expect(vmContextObj.process.getBuiltinModule('node:fs')).toBe(viaRequire)
    // ...and it is emphatically not the real module.
    expect(viaRequire).not.toBe(fs)
    expect(viaRequire.openSync).toBeUndefined()
  })

  it('the object every route returns is actually jailed', () => {
    const jailed = vmContextObj.require('fs')
    expect(() => jailed.readFileSync(OUTSIDE_READABLE, 'utf8')).toThrow(/EPERM/)
    // Inside the jail the refusal is gone: an absent file fails with ENOENT, which is
    // what proves the EPERM above came from the policy and not from the path not existing.
    expect(() => jailed.readFileSync(path.join(cwd, 'absent'), 'utf8')).toThrow(/ENOENT/)
  })
})

/* ------------------------------- 3. property: the sandbox surface is a closed set */

/**
 * The complete sandbox global surface.
 *
 * This is the test that makes the rest durable. Fixing `globalThis.import` is worth
 * little if the next capability lands next to it unreviewed — so a new global fails
 * here, and whoever adds it has to decide, in writing, whether it belongs in
 * MODULE_LOADING_ROUTES or the filesystem tests below.
 */
const SANDBOX_GLOBALS = [
  'AbortController', 'AbortSignal', 'Buffer', 'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams',
  'accessibilitySnapshot', 'backwardSlice', 'browser', 'cancelRecording', 'chrome', 'clearAllLogs',
  'clearInterval', 'clearTimeout', 'console', 'context', 'createDebugger', 'createDemoVideo',
  'createEditor', 'crypto', 'debugStyle', 'evaluateBinding', 'fetch', 'fiberDiff', 'fiberSnapshot',
  'findMissingDeps', 'formatStylesAsText', 'getCDPSession', 'getCleanHTML', 'getLatestLogs',
  'getLocatorStringForElement', 'getPageMarkdown', 'getReactComponentInfo', 'getReactSource',
  'getScriptSourceByUrl', 'getStylesForLocator', 'ghostCursor', 'humanMouse', 'inspectBinding',
  'inspectPinnedElement', 'isPureFunctionSource', 'isRecording', 'moduleGraph', 'net', 'page', 'pm',
  'process', 'queryPage', 'readLogpoints', 'recording', 'refToLocator', 'replayPure', 'replayPureAsync',
  'require', 'resetPlaywright', 'resizeImage', 'resizeImageForAgent', 'screenshotWithAccessibilityLabels',
  'setInterval', 'setLogpoint', 'setTimeout', 'snapshot', 'startRecording', 'state', 'stopRecording',
  'storeIdentity', 'structuredClone', 'traceValue', 'waitForPageLoad', 'whyOccluded',
].sort()

describe('the sandbox global surface is a closed, reviewed set', () => {
  const { vmContextObj } = buildSandbox()

  it('exposes exactly the names in SANDBOX_GLOBALS', () => {
    expect(Object.keys(vmContextObj).sort()).toEqual(SANDBOX_GLOBALS)
  })

  it('exposes no name that even looks like a module loader', () => {
    // Belt and braces for the specific shape of the reported bug: a loader smuggled in
    // under a plausible name would still have to pass the closed-set test above, but
    // this states the intent so the reason survives a merge conflict.
    const loaderish = /^(import|dynamicImport|importModule|loadModule|_require|nativeRequire|createRequire)$/
    expect(Object.keys(vmContextObj).filter((k) => loaderish.test(k))).toEqual([])
  })

  it('does not hand out a dangerous host module under any name, one level deep', () => {
    // Identity comparison against the REAL modules: catches `foo: require('child_process')`
    // regardless of what it is called or how it is nested inside a namespace object.
    const forbidden = new Map<unknown, string>()
    for (const id of ['child_process', 'module', 'vm', 'worker_threads', 'net', 'dgram', 'cluster', 'inspector', 'repl', 'v8', 'fs']) {
      try {
        forbidden.set(process.getBuiltinModule(id as any), id)
      } catch {
        // builtin not present in this runtime; nothing to compare against
      }
    }
    const found: string[] = []
    const check = (value: unknown, label: string) => {
      const hit = forbidden.get(value)
      if (hit) found.push(`${label} === node:${hit}`)
    }
    for (const [name, value] of Object.entries(vmContextObj)) {
      check(value, name)
      if (value && (typeof value === 'object' || typeof value === 'function') && name !== 'process') {
        for (const key of Object.keys(value as object)) {
          let child: unknown
          try {
            child = (value as any)[key]
          } catch {
            continue
          }
          check(child, `${name}.${key}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})

/* --------------------------------------------- 4. the `require` object's properties */

describe('require carries no capability on its own properties', () => {
  const { vmContextObj, run } = buildSandbox()

  it('require.cache is empty and frozen — it used to be Module._cache', async () => {
    // Every value in the real cache is a live `Module` whose `.require` is the
    // UNRESTRICTED host require: `require.cache[anyKey].require('child_process')` was a
    // complete bypass, and 923 entries were reachable in a plain test run.
    expect(Object.keys(vmContextObj.require.cache)).toEqual([])
    expect(Object.isFrozen(vmContextObj.require.cache)).toBe(true)
    expect(
      await run(`
        const c = require.cache
        return Object.values(c).filter((m) => m && typeof m.require === 'function').length
      `),
    ).toBe(0)
  })

  it('require.extensions is empty and frozen — writing it rewrote host module loading', () => {
    expect(Object.keys(vmContextObj.require.extensions)).toEqual([])
    expect(Object.isFrozen(vmContextObj.require.extensions)).toBe(true)
  })

  it('require.main is undefined — main.require is another unrestricted require', () => {
    expect(vmContextObj.require.main).toBeUndefined()
  })

  it('require.resolve.paths discloses no host module search path', () => {
    // A relative specifier, not a core one: the host's `paths()` answers `null` for core
    // modules either way, so asking about `fs` would pass against the unfixed code too.
    // For './x' the host's returns the executor's real directory list.
    expect(vmContextObj.require.resolve.paths('./x')).toBeNull()
  })

  it('require.resolve still works for allowlisted modules', () => {
    expect(typeof vmContextObj.require.resolve('node:path')).toBe('string')
  })
})

/* ------------------------------------------------------------ 5. the process proxy */

/** Members that must refuse when CALLED, with why each one matters. */
const DENIED_PROCESS_CALLS: Array<[string, string]> = [
  ['exit', 'ends the relay process'],
  ['abort', 'ends the relay process, with a core dump'],
  ['reallyExit', 'ends the relay process, past exit hooks'],
  ['kill', 'kill(process.pid) is exit() by another name'],
  ['_kill', 'the undocumented sibling of kill'],
  ['chdir', 'moves every other session sharing this process'],
  ['_debugProcess', 'starts an inspector on any pid on the box'],
  ['_debugEnd', 'stops one'],
  ['umask', 'changes the file mode mask of the host process'],
  ['setuid', 'changes host process privileges'],
  ['setgid', 'changes host process privileges'],
  ['seteuid', 'changes host process privileges'],
  ['setegid', 'changes host process privileges'],
  ['setgroups', 'changes host process privileges'],
  ['initgroups', 'changes host process privileges'],
  ['binding', "process.binding('spawn_sync').spawn IS a shell"],
  ['_linkedBinding', 'the same, for linked bindings'],
  ['dlopen', 'loads any .node file on disk into this process'],
  ['loadEnvFile', 'parses ANY file on disk into process.env, past the fs jail'],
]

describe('the process proxy is a deny list, not two overrides', () => {
  const { vmContextObj, run, cwd } = buildSandbox()

  it('is not the host process object', () => {
    expect(vmContextObj.process).not.toBe(process)
  })

  it.each(DENIED_PROCESS_CALLS)('process.%s() throws (%s)', (member) => {
    expect(typeof vmContextObj.process[member]).toBe('function')
    expect(() => vmContextObj.process[member](0)).toThrow(/not allowed in the sandbox/)
  })

  it('process.getBuiltinModule cannot load a shell, and jails fs', () => {
    expect(() => vmContextObj.process.getBuiltinModule('child_process')).toThrow(/not allowed in the sandbox/)
    expect(() => vmContextObj.process.getBuiltinModule('fs').readFileSync(OUTSIDE_READABLE, 'utf8')).toThrow(/EPERM/)
    // ...while still being a working Node API for what the allowlist permits.
    expect(typeof vmContextObj.process.getBuiltinModule('os').platform).toBe('function')
  })

  it('process.mainModule and process.report are unreachable', () => {
    // mainModule.require is an unrestricted require; report.writeReport(path) dumps the
    // full environment and argv to any path on disk, in both directions past the jail.
    expect(vmContextObj.process.mainModule).toBeUndefined()
    expect(vmContextObj.process.report).toBeUndefined()
  })

  it('the process object is read-only — `delete process.exit` removed the HOST one', async () => {
    await expect(run(`delete process.exit`)).rejects.toThrow(/read-only/)
    await expect(run(`process.exitCode = 1`)).rejects.toThrow(/read-only/)
    await expect(run(`Object.defineProperty(process, 'x', { value: 1 })`)).rejects.toThrow(/read-only/)
    // The host is intact.
    expect(typeof process.exit).toBe('function')
    expect(process.exitCode).toBeUndefined()
  })

  it('process.cwd() reports the session cwd, not the relay server cwd', () => {
    expect(vmContextObj.process.cwd()).toBe(cwd)
  })

  it('process.env is DELIBERATELY the live host object, and is documented as such', async () => {
    // Not a hole that was missed — a decision. env is data, scripts read it, and the
    // constructor route below reaches the real env anyway. skill.md says so; if that
    // sentence ever goes, this test fails and the reader is not misled.
    expect(await run(`process.env.__SANDBOX_ESCAPE_TEST__ = 'x'; return process.env.__SANDBOX_ESCAPE_TEST__`)).toBe('x')
    expect(process.env.__SANDBOX_ESCAPE_TEST__).toBe('x')
    delete process.env.__SANDBOX_ESCAPE_TEST__
    const skill = fs.readFileSync(path.join(import.meta.dirname, 'skill.md'), 'utf8')
    expect(skill).toMatch(/process\.env` is the relay process's real environment/)
  })
})

/* --------------------------------------------------------------- 6. the fs jail */

/**
 * Every path-taking method ScopedFS exposes. Pinned as a closed set for the same reason
 * as the globals: a new method added without a `resolvePath` call is a jail hole, and it
 * would otherwise be invisible.
 */
const SCOPED_FS_METHODS = [
  'access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
  'copyFile', 'copyFileSync', 'createReadStream', 'createWriteStream', 'exists', 'existsSync',
  'lstat', 'lstatSync', 'mkdir', 'mkdirSync', 'readFile', 'readFileSync', 'readdir', 'readdirSync',
  'readlinkSync', 'realpathSync', 'rename', 'renameSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'stat', 'statSync', 'symlinkSync', 'unlink', 'unlinkSync', 'unwatchFile', 'utimesSync', 'watch',
  'watchFile', 'writeFile', 'writeFileSync',
].sort()

describe('the ScopedFS write jail', () => {
  const { vmContextObj, cwd } = buildSandbox()
  const jailed = () => vmContextObj.require('node:fs')

  it('exposes exactly the reviewed method set', () => {
    const actual = Object.keys(jailed())
      .filter((k) => typeof (jailed() as any)[k] === 'function')
      .sort()
    expect(actual).toEqual(SCOPED_FS_METHODS)
  })

  it('exposes no raw-descriptor or bulk primitive that could sidestep resolvePath', () => {
    // open/openSync would hand out a file descriptor, which every check here is blind to.
    // cp/link/glob/opendir/mkdtemp/truncate all take paths and none of them is wrapped.
    for (const name of ['open', 'openSync', 'read', 'readSync', 'write', 'writeSync', 'close', 'closeSync',
      'cp', 'cpSync', 'link', 'linkSync', 'glob', 'globSync', 'opendir', 'opendirSync',
      'mkdtemp', 'mkdtempSync', 'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync', 'fchmod', 'fstat']) {
      expect((jailed() as any)[name], `ScopedFS.${name} is exposed and is not jailed`).toBeUndefined()
    }
  })

  it('refuses an absolute path outside the allowed directories', () => {
    expect(() => jailed().readFileSync(OUTSIDE_READABLE, 'utf8')).toThrow(/EPERM/)
    expect(() => jailed().writeFileSync(OUTSIDE, 'x')).toThrow(/EPERM/)
  })

  it('refuses to climb out with ..', () => {
    expect(() => jailed().readFileSync('../../../../../../etc/hostname', 'utf8')).toThrow(/EPERM/)
    expect(() => jailed().writeFileSync(path.join(cwd, '..', '..', 'escaped'), 'x')).toThrow(/EPERM/)
  })

  it('refuses through the promises API and the stream constructors', async () => {
    await expect(jailed().promises.readFile(OUTSIDE_READABLE, 'utf8')).rejects.toThrow(/EPERM/)
    await expect(jailed().promises.writeFile(OUTSIDE, 'x')).rejects.toThrow(/EPERM/)
    expect(() => jailed().createReadStream(OUTSIDE_READABLE)).toThrow(/EPERM/)
    expect(() => jailed().createWriteStream(OUTSIDE)).toThrow(/EPERM/)
  })

  it('refuses to CREATE a symlink whose target escapes, absolute or relative', () => {
    expect(() => jailed().symlinkSync('/etc', path.join(cwd, 'abs-link'))).toThrow(/EPERM/)
    expect(() => jailed().symlinkSync('../../../etc', path.join(cwd, 'rel-link'))).toThrow(/EPERM/)
    expect(fs.existsSync(path.join(cwd, 'abs-link'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, 'rel-link'))).toBe(false)
  })

  it('cannot be tricked by a self-referential symlink plus ..', () => {
    // `..` is collapsed lexically BEFORE the check, so routing through a symlink that
    // points inside the jail buys nothing.
    jailed().symlinkSync('.', path.join(cwd, 'self'))
    expect(() => jailed().readFileSync(path.join(cwd, 'self', '..', '..', '..', 'etc', 'hostname'), 'utf8')).toThrow()
  })

  it('a number is not a usable file descriptor here', () => {
    // readFileSync is typed PathOrFileDescriptor but stringifies its argument, so a raw
    // fd degrades to a relative filename inside the jail rather than reading fd 0.
    expect(() => jailed().readFileSync(0, 'utf8')).toThrow(/ENOENT/)
  })

  /**
   * KNOWN AND ACCEPTED: a symlink that ALREADY EXISTS inside an allowed directory is
   * followed out of it. `resolvePath` is lexical, so a link planted by anything other
   * than this sandbox (the user's own repo, another process writing to the shared
   * `/tmp`) is a read path out.
   *
   * Not changed, for two reasons stated rather than assumed:
   *   - it cannot raise the boundary: the constructor route below reaches the real `fs`
   *     in one expression, so realpath'ing here would buy nothing against an attacker;
   *   - realpath-before-check would break pnpm workspace layouts, where `node_modules/x`
   *     is legitimately a symlink to a sibling package OUTSIDE the session cwd — this
   *     very repository is one.
   * The test exists so the behaviour is a decision on record, not a surprise.
   */
  it('DOES follow a pre-existing symlink out of the jail (known, documented)', () => {
    const link = path.join(cwd, 'planted')
    fs.symlinkSync(OUTSIDE_READABLE, link)
    expect(() => jailed().readFileSync(link, 'utf8')).not.toThrow()
    const skill = fs.readFileSync(path.join(import.meta.dirname, 'skill.md'), 'utf8')
    expect(skill).toMatch(/symlink/i)
  })
})

/* ---------------------------------------------- 7. other live objects in the context */

describe('the other host-backed globals expose no extra loader or filesystem route', () => {
  const { vmContextObj } = buildSandbox()

  it('the Ghost Browser `chrome` proxy only forwards to CDP', () => {
    // Every unknown property is a function that sends a `ghost-browser` CDP command;
    // the proxy target is a frozen constants table, and no host object is reachable
    // through it beyond the usual realm-crossing route covered below.
    expect(Object.keys(vmContextObj.chrome).sort()).toEqual(['ghostProxies', 'ghostPublicAPI', 'projects'])
    expect(Object.keys(vmContextObj.chrome.ghostPublicAPI)).toEqual([
      'NEW_TEMPORARY_IDENTITY', 'DEFAULT_IDENTITY', 'MAX_TEMPORARY_IDENTITIES',
    ])
    expect(typeof vmContextObj.chrome.ghostPublicAPI.somethingNobodyDefined).toBe('function')
  })

  it('moduleGraph hands out a bounded handle, never the live Babel graph', () => {
    const handle = vmContextObj.moduleGraph({ root: process.cwd() })
    expect(Object.keys(handle).sort()).toEqual(['fileCount', 'root', 'summary'])
    expect(() => JSON.stringify(handle.summary())).not.toThrow()
  })

  it('the live PageModel builder is still not a global', () => {
    expect(vmContextObj.buildPageModel).toBeUndefined()
  })
})

/* ------------------------------------- 8. the limit of the boundary, demonstrated */

describe('WHAT THIS SANDBOX IS NOT: the realm-crossing constructor route', () => {
  const { run } = buildSandbox()

  /**
   * These two tests assert that the escape WORKS. That is deliberate.
   *
   * `vm.createContext` shares every value it is given with the host realm, so any
   * host-realm function's `.constructor` is the host `Function`, and
   * `Function('return process')()` is the real process. This is true of `Buffer`,
   * `setTimeout`, `fetch`, `page`, the sandbox's own helper functions, a plain `state`
   * object, and a host `Error` caught from a refused `require` — dozens of independent
   * routes, none of which can be closed while live Playwright objects cross the
   * boundary.
   *
   * They are pinned here so that nobody reads the tests above and concludes the sandbox
   * contains an adversary. If someone ever DOES close this — a real isolate, a fully
   * proxied surface — these tests fail, and the person closing it must update
   * `src/skill.md`, which currently tells the truth about it.
   */
  it('reaches the host realm through a host-realm value (unclosable by design)', async () => {
    const reached = await run(`
      const routes = {
        Buffer: Buffer.constructor,
        setTimeout: setTimeout.constructor,
        fetch: fetch.constructor,
        state: state.constructor.constructor,
        page: page.on.constructor,
        scopedFs: require('node:fs').readFileSync.constructor,
        thrownHostError: (() => { try { require('node:child_process') } catch (e) { return e.constructor.constructor } })(),
      }
      const out = {}
      for (const [name, F] of Object.entries(routes)) {
        try {
          const g = await F('return globalThis')()
          out[name] = !!(g && g.process && typeof g.process.pid === 'number')
        } catch { out[name] = false }
      }
      return out
    `)
    // Every one of them. This is the honest state of the boundary.
    expect(Object.values(reached).every(Boolean), JSON.stringify(reached)).toBe(true)
  })

  it('and therefore still reaches a shell, without touching any global fixed above', async () => {
    const user = await run(`
      const hostProcess = Buffer.constructor('return process')()
      return hostProcess.getBuiltinModule('child_process').execSync('echo escaped').toString().trim()
    `)
    expect(user).toBe('escaped')
  })

  it('skill.md tells agents this, rather than implying a security boundary', () => {
    const skill = fs.readFileSync(path.join(import.meta.dirname, 'skill.md'), 'utf8')
    expect(skill).toMatch(/not a security boundary/i)
  })
})
