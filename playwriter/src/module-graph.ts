import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import type { NodePath, Binding } from '@babel/traverse'
import type { Loc } from './static-analysis.js'

// @babel/traverse is CJS with a double-default under ESM interop.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse

// The AST returned by @babel/parser. Aliased so we never need to import
// @babel/types directly (it is only reachable through @babel/traverse's own
// virtual store in this pnpm layout).
export type ParsedFile = ReturnType<typeof parse>
type BabelNode = { type: string; loc?: any } & Record<string, any>

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage'])

// Aliases (`const g = f`, `export { f as g }`, re-export links) are followed, but
// a malformed or adversarial project could chain them forever. Six hops is far
// past anything real and keeps every walk terminating.
const MAX_ALIAS_HOPS = 6

const FUNCTION_NODE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'ObjectMethod',
  'ClassPrivateMethod',
])

export interface ParsedModule {
  ast: ParsedFile
  code: string
  /** The Program NodePath, kept so binding/scope lookups work per-file. */
  programPath: NodePath | null
  /** Parser errors the recovery pass survived. Empty for a clean file. */
  recoveredErrors: ParseFailure[]
}

/**
 * A file the parser could not read cleanly. Recorded rather than discarded: a
 * dead end that means "your file has a syntax error on line 41" must never be
 * reported as "export not found".
 */
export interface ParseFailure {
  file: string
  message: string
  line: number | null
  column: number | null
  /**
   * `unreadable` — the file is not on disk / could not be read at all;
   * `fatal`     — it was read but produced no AST;
   * `recovered` — an AST exists but the parser had to recover from errors.
   *
   * "Missing" and "malformed" are different diagnoses with different fixes, so
   * they never share a variant.
   */
  severity: 'unreadable' | 'fatal' | 'recovered'
}

export interface ExportEntry {
  name: string
  // The value node the export points at (declarator init, function/class node,
  // or the exported local identifier). Null only for opaque re-exports.
  node: BabelNode | null
  path: NodePath | null
  loc: Loc | null
  // Set for `export { x } from './y'` / `export * as ns from './y'` chains.
  reexport?: { source: string; imported: string }
}

/** One link followed while flattening a re-export chain. */
export interface ReexportStep {
  /** The file the link was read from. */
  file: string
  /** The name looked up in `file`. */
  name: string
  /** The specifier the link points at. */
  source: string
  via: 'named' | 'star' | 'namespace'
}

/**
 * The outcome of following `name` out of `file` through however many re-export
 * links stand in the way. Every non-`found` variant names its own blind spot —
 * the caller must be able to tell "external dependency" from "syntax error"
 * from "genuinely ambiguous" without guessing.
 */
export type ExportResolution =
  | { kind: 'found'; file: string; name: string; entry: ExportEntry; chain: ReexportStep[] }
  /** `export * as ns from './y'` / a namespace import: the value is y's whole namespace object. */
  | { kind: 'namespace'; file: string; chain: ReexportStep[] }
  | { kind: 'external'; fromFile: string; specifier: string; chain: ReexportStep[] }
  | { kind: 'parse-error'; file: string; failure: ParseFailure; chain: ReexportStep[] }
  | {
      kind: 'not-found'
      file: string
      name: string
      searchedStars: string[]
      chain: ReexportStep[]
      /** Set when the file parsed only with error recovery — the likely cause. */
      parseDiagnostic?: ParseFailure
    }
  | {
      kind: 'ambiguous'
      file: string
      name: string
      candidates: { file: string; name: string }[]
      chain: ReexportStep[]
    }
  | { kind: 'cycle'; file: string; name: string; chain: ReexportStep[] }

export type UnresolvedCalleeReason =
  /** Free/global identifier — `fetch`, `setTimeout`, an ambient declaration. */
  | 'no-binding'
  /** The callee is a parameter: which function runs depends on this function's caller. */
  | 'callback-param'
  /** Callee is a call result, conditional, `obj.a.b()` chain — not a static name. */
  | 'dynamic-value'
  /** `obj[expr]()` — the property is computed. */
  | 'computed-member'
  | 'external-module'
  | 'export-not-found'
  | 'export-ambiguous'
  | 'reexport-cycle'
  /** The defining file could not be parsed. */
  | 'parse-error'
  /** A binding was found but it does not name a callable definition we can point at. */
  | 'not-a-function-decl'

/**
 * What a call site's callee actually refers to. `declKey` is the call graph's
 * identity: two same-named functions in different files never share one, and an
 * aliased/re-exported function always does.
 */
export type CalleeVia = 'local' | 'local-alias' | 'import' | 'namespace-member' | 'object-member'

export type CalleeResolution =
  | {
      kind: 'resolved'
      /** File containing the definition. */
      file: string
      /** Best human-facing name for the definition. */
      name: string
      declKey: string
      declLoc: Loc | null
      via: CalleeVia
      /** The definition is an `async` function — its return value is a promise. */
      isAsync: boolean
      /** The definition is a generator — its "return value" arrives via `yield`. */
      isGenerator: boolean
    }
  | { kind: 'unresolved'; reason: UnresolvedCalleeReason; detail: string }

/** An in-flight hit while walking a binding/export down to a function node. */
interface FnTarget {
  node: BabelNode
  file: string
  name: string
  via: CalleeVia
}

export interface CallSite {
  file: string
  /** The callee's *syntactic* name (or a short rendering for member calls). */
  name: string
  callPath: NodePath
  args: NodePath[]
  loc: Loc | null
  /** Resolved callee identity. Computed lazily; always present on indexed sites. */
  callee: CalleeResolution
}

export type ResolvedTarget =
  | { file: string }
  | { blackbox: true; reason: 'bare-specifier' | 'unresolved-path'; specifier: string }

export interface ModuleGraphSummary {
  root: string
  fileCount: number
  indexedFileCount: number
  exportCount: number
  callSiteCount: number
  resolvedCallSiteCount: number
  unresolvedCallSiteCount: number
  unresolvedByReason: Record<string, number>
  parseFailures: ParseFailure[]
}

export interface ModuleGraph {
  root: string
  files: string[]
  exportsByFile: Map<string, Map<string, ExportEntry>>
  /**
   * `export * from './y'` links per file. A file may carry several, so the `'*'`
   * marker inside `exportsByFile` cannot hold them all — this is authoritative.
   */
  starExportsByFile: Map<string, { source: string; loc: Loc | null }[]>
  /**
   * Call sites keyed by the callee's bare syntactic name. Same-named functions
   * from different files SHARE a bucket here — this index is only a convenience
   * for "who writes `format(`?". For interprocedural reasoning use
   * `callersOfFunction` / `callSitesByTarget`, which key on resolved identity.
   */
  callSites: Map<string, CallSite[]>
  /** Call sites keyed by resolved callee identity (`declKey`). */
  readonly callSitesByTarget: Map<string, CallSite[]>
  /** Call sites whose callee could not be resolved — kept out of every named bucket. */
  readonly unresolvedCallSites: CallSite[]
  /** Files that failed to parse, keyed by absolute path. */
  parseFailures: Map<string, ParseFailure>
  getFile(absPath: string): ParsedModule | null
  resolve(fromFile: string, specifier: string): ResolvedTarget
  fileOf(pathOrNode: NodePath | BabelNode): string | undefined
  /** Follow `name` out of `file` through every re-export link to its definition. */
  resolveExport(file: string, name: string): ExportResolution
  /** Stable identity for a function definition: file + declaration position. */
  declKeyOf(fnNodeOrPath: NodePath | BabelNode | null | undefined, file: string | undefined): string | null
  /** Every call site that provably targets this function definition. */
  callersOfFunction(fnNodeOrPath: NodePath | BabelNode | null | undefined, file: string | undefined): CallSite[]
  /**
   * Resolve the callee of an arbitrary CallExpression path to a definition
   * identity. Same machinery the call index uses — exposed so a caller can ask
   * "what does THIS call actually invoke?" (e.g. is the callee `async`?).
   */
  resolveCalleeOfCall(callPath: NodePath, file?: string): CalleeResolution
  /** Program-scope binding for `name` inside `file` (parses/indexes on demand). */
  moduleBinding(file: string, name: string): Binding | null
  /** Parse + index a file that was not in the initial list. Returns null on failure. */
  ensureIndexed(file: string): ParsedModule | null
  /** Bounded, serialisable digest — safe to hand to an agent. */
  summary(): ModuleGraphSummary
}

function locOf(node: BabelNode | null | undefined, file?: string): Loc | null {
  if (!node || !node.loc) return null
  return {
    file,
    line: node.loc.start.line,
    column: node.loc.start.column,
    endLine: node.loc.end?.line,
    endColumn: node.loc.end?.column,
  }
}

function parseCode(code: string, filename: string): ParsedFile {
  return parse(code, {
    sourceType: 'module',
    errorRecovery: true,
    sourceFilename: filename,
    plugins: ['jsx', 'typescript', 'decorators-legacy'],
  })
}

function failureFromError(file: string, err: unknown, severity: ParseFailure['severity']): ParseFailure {
  const e = err as { message?: string; loc?: { line?: number; column?: number } }
  return {
    file,
    message: String(e?.message ?? err),
    line: e?.loc?.line ?? null,
    column: e?.loc?.column ?? null,
    severity,
  }
}

function walkDir(root: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (IGNORED_DIRS.has(entry.name)) continue
    }
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      walkDir(full, out)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name)
      if (SOURCE_EXTENSIONS.includes(ext) && !entry.name.endsWith('.d.ts')) {
        out.push(full)
      }
    }
  }
}

// Lenient JSON reader for tsconfig/jsconfig (strips // and /* */ comments and
// trailing commas). Returns null when the file is absent or unparseable.
function readJsonc(file: string): any | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1')
    try {
      return JSON.parse(stripped)
    } catch {
      return null
    }
  }
}

interface PathsConfig {
  baseUrl: string
  paths: Record<string, string[]>
}

function loadPathsConfig(root: string): PathsConfig | null {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const cfg = readJsonc(path.join(root, name))
    const co = cfg?.compilerOptions
    if (!co) continue
    const baseUrl = path.resolve(root, co.baseUrl ?? '.')
    const paths = (co.paths ?? {}) as Record<string, string[]>
    return { baseUrl, paths }
  }
  return null
}

// Try a bare path plus extension / index resolution against the filesystem.
// Also attempts to replace the given extension with each source extension
// (e.g. `.js` -> `.ts`) to support ESM-style imports that reference compiled output.
function resolveFileWithExt(base: string): string | null {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = base + ext
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  // Try replacing the existing extension with each source extension
  // (e.g. .js -> .ts) to support ESM-style imports that reference compiled output.
  const parsed = path.parse(base)
  if (parsed.ext && parsed.ext !== '') {
    for (const ext of SOURCE_EXTENSIONS) {
      if (ext === parsed.ext) continue
      const candidate = path.join(parsed.dir, parsed.name + ext)
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    const pkg = readJsonc(path.join(base, 'package.json'))
    const main = pkg?.exports?.['.'] ?? pkg?.exports ?? pkg?.module ?? pkg?.main
    if (typeof main === 'string') {
      const resolved = resolveFileWithExt(path.resolve(base, main))
      if (resolved) return resolved
    }
    for (const ext of SOURCE_EXTENSIONS) {
      const candidate = path.join(base, 'index' + ext)
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
  }
  return null
}

function matchTsPaths(specifier: string, cfg: PathsConfig): string | null {
  for (const [pattern, targets] of Object.entries(cfg.paths)) {
    if (pattern.includes('*')) {
      const [prefix, suffix = ''] = pattern.split('*')
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        const middle = specifier.slice(prefix.length, specifier.length - suffix.length)
        for (const target of targets) {
          const candidatePath = target.replace('*', middle)
          const resolved = resolveFileWithExt(path.resolve(cfg.baseUrl, candidatePath))
          if (resolved) return resolved
        }
      }
    } else if (pattern === specifier) {
      for (const target of targets) {
        const resolved = resolveFileWithExt(path.resolve(cfg.baseUrl, target))
        if (resolved) return resolved
      }
    }
  }
  return null
}

function collectExports(
  ast: ParsedFile,
  file: string,
  exportMap: Map<string, ExportEntry>,
  starExports: { source: string; loc: Loc | null }[],
): void {
  traverse(ast, {
    ExportNamedDeclaration(p: any) {
      const node = p.node
      const source: string | undefined = node.source?.value
      if (node.declaration) {
        const decl = node.declaration
        if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            for (const name of bindingNames(d.id)) {
              exportMap.set(name, {
                name,
                node: d.init ?? d.id,
                path: p.get('declaration'),
                loc: locOf(d.init ?? d.id, file),
              })
            }
          }
        } else if (decl.id) {
          exportMap.set(decl.id.name, {
            name: decl.id.name,
            node: decl,
            path: p.get('declaration'),
            loc: locOf(decl, file),
          })
        }
      }
      const specPaths: any[] = node.specifiers?.length ? (p.get('specifiers') as any[]) : []
      for (const spec of node.specifiers ?? []) {
        const specPath = specPaths.find((sp) => sp.node === spec) ?? null
        if (spec.type === 'ExportSpecifier') {
          const exported = spec.exported.name ?? spec.exported.value
          const local = spec.local.name
          if (source) {
            exportMap.set(exported, {
              name: exported,
              node: null,
              path: null,
              loc: locOf(spec, file),
              reexport: { source, imported: local },
            })
          } else {
            // `path` is the specifier itself, NOT `p.get('specifiers')` — that
            // returns an array and every `.isX()` call on it explodes.
            exportMap.set(exported, {
              name: exported,
              node: spec.local,
              path: specPath,
              loc: locOf(spec.local, file),
            })
          }
        } else if (spec.type === 'ExportNamespaceSpecifier' && source) {
          // `export * as ns from './y'` — the export IS y's namespace object.
          const exported = spec.exported?.name ?? spec.exported?.value
          if (exported) {
            exportMap.set(exported, {
              name: exported,
              node: null,
              path: null,
              loc: locOf(spec, file),
              reexport: { source, imported: '*' },
            })
          }
        } else if (spec.type === 'ExportDefaultSpecifier' && source) {
          // `export v from './y'` (proposal syntax) — a default re-export.
          const exported = spec.exported?.name
          if (exported) {
            exportMap.set(exported, {
              name: exported,
              node: null,
              path: null,
              loc: locOf(spec, file),
              reexport: { source, imported: 'default' },
            })
          }
        }
      }
    },
    ExportDefaultDeclaration(p: any) {
      const node = p.node
      exportMap.set('default', {
        name: 'default',
        node: node.declaration,
        path: p.get('declaration'),
        loc: locOf(node.declaration, file),
      })
    },
    ExportAllDeclaration(p: any) {
      const source: string | undefined = p.node.source?.value
      if (!source) return
      starExports.push({ source, loc: locOf(p.node, file) })
      // Back-compat marker only: a file can carry many `export *` declarations
      // and one map key cannot hold them all, so `starExportsByFile` is the
      // authoritative list and this entry just answers "does it star-export?".
      if (!exportMap.has('*')) {
        exportMap.set('*', {
          name: '*',
          node: null,
          path: null,
          loc: locOf(p.node, file),
          reexport: { source, imported: '*' },
        })
      }
    },
  })
}

function bindingNames(id: BabelNode): string[] {
  if (!id) return []
  if (id.type === 'Identifier') return [id.name]
  const names: string[] = []
  if (id.type === 'ObjectPattern') {
    for (const prop of id.properties) {
      if (prop.type === 'ObjectProperty') names.push(...bindingNames(prop.value))
      else if (prop.type === 'RestElement') names.push(...bindingNames(prop.argument))
    }
  } else if (id.type === 'ArrayPattern') {
    for (const el of id.elements) if (el) names.push(...bindingNames(el))
  } else if (id.type === 'AssignmentPattern') {
    names.push(...bindingNames(id.left))
  } else if (id.type === 'RestElement') {
    names.push(...bindingNames(id.argument))
  }
  return names
}

/** Short, bounded rendering of a callee expression for diagnostics. */
function calleeLabel(node: BabelNode | null | undefined): string {
  if (!node) return '<none>'
  switch (node.type) {
    case 'Identifier':
      return node.name
    case 'MemberExpression': {
      const obj = calleeLabel(node.object)
      const prop = node.computed
        ? '[…]'
        : node.property?.name ?? node.property?.value ?? '?'
      return `${obj}.${prop}`
    }
    case 'ThisExpression':
      return 'this'
    case 'CallExpression':
      return `${calleeLabel(node.callee)}(…)`
    default:
      return `<${node.type}>`
  }
}

function isFunctionNode(node: BabelNode | null | undefined): boolean {
  return !!node && FUNCTION_NODE_TYPES.has(node.type)
}

function collectCallSites(
  ast: ParsedFile,
  file: string,
  out: CallSite[],
): void {
  traverse(ast, {
    CallExpression(p: any) {
      const callee = p.node.callee
      out.push({
        file,
        name: calleeLabel(callee),
        callPath: p,
        // Lazy: every CallExpression in the project is indexed, and materialising
        // argument paths for all of them up front costs far more than it buys.
        get args() {
          return p.get('arguments') as NodePath[]
        },
        loc: locOf(p.node, file),
        // Filled in by the resolution pass — the target file may not be parsed yet.
        callee: { kind: 'unresolved', reason: 'dynamic-value', detail: 'not yet resolved' },
      })
    },
  })
}

/**
 * Parse every source file under `root` once, then index exports, call sites and
 * a filesystem-aware module resolver. Purely offline: bare specifiers (real
 * node_modules deps) are blackboxed and never parsed.
 *
 * Call sites are keyed on RESOLVED callee identity (`callSitesByTarget`), so two
 * files each defining `format()` never share a bucket and an interprocedural
 * walk over a one-caller function is not mistaken for an ambiguous one. Calls
 * whose target genuinely cannot be named (dynamic values, computed members,
 * callback parameters) go to `unresolvedCallSites` instead of polluting a name.
 *
 * Re-export chains are flattened on demand by `resolveExport`, and files that
 * fail to parse are recorded in `parseFailures` rather than vanishing.
 */
export function buildModuleGraph({ root, files }: { root: string; files?: string[] }): ModuleGraph {
  const absRoot = path.resolve(root)
  const fileList = files ? files.map((f) => path.resolve(f)) : []
  if (!files) walkDir(absRoot, fileList)

  const cache = new Map<string, ParsedModule>()
  const astToFile = new WeakMap<object, string>()
  const exportsByFile = new Map<string, Map<string, ExportEntry>>()
  const starExportsByFile = new Map<string, { source: string; loc: Loc | null }[]>()
  const parseFailures = new Map<string, ParseFailure>()
  const rawCallSites: CallSite[] = []
  const callSites = new Map<string, CallSite[]>()
  const pathsConfig = loadPathsConfig(absRoot)

  function loadFile(absPath: string): ParsedModule | null {
    const cached = cache.get(absPath)
    if (cached) return cached
    const known = parseFailures.get(absPath)?.severity
    if (known === 'fatal' || known === 'unreadable') return null
    let code: string
    try {
      code = fs.readFileSync(absPath, 'utf8')
    } catch (e) {
      parseFailures.set(absPath, failureFromError(absPath, e, 'unreadable'))
      return null
    }
    let ast: ParsedFile
    try {
      ast = parseCode(code, absPath)
    } catch (e) {
      // Keeping the index alive after one bad file is right; forgetting WHY is
      // not. Record the position so a downstream dead end can name the cause
      // instead of surfacing as a mystery "export not found".
      parseFailures.set(absPath, failureFromError(absPath, e, 'fatal'))
      return null
    }
    const recoveredErrors = ((ast as any).errors ?? []).map((e: unknown) =>
      failureFromError(absPath, e, 'recovered'),
    ) as ParseFailure[]
    if (recoveredErrors.length > 0 && !parseFailures.has(absPath)) {
      parseFailures.set(absPath, recoveredErrors[0])
    }
    let programPath: NodePath | null = null
    traverse(ast, {
      Program(p: NodePath) {
        programPath = p
        p.stop()
      },
    })
    const mod: ParsedModule = { ast, code, programPath, recoveredErrors }
    cache.set(absPath, mod)
    astToFile.set(ast as unknown as object, absPath)
    astToFile.set(ast.program as unknown as object, absPath)
    return mod
  }

  // --- indexing -----------------------------------------------------------

  let resolvedIndexDirty = true

  function indexFile(file: string): ParsedModule | null {
    const mod = loadFile(file)
    if (!mod) return null
    if (exportsByFile.has(file)) return mod
    const exportMap = new Map<string, ExportEntry>()
    const stars: { source: string; loc: Loc | null }[] = []
    collectExports(mod.ast, file, exportMap, stars)
    exportsByFile.set(file, exportMap)
    starExportsByFile.set(file, stars)
    const sites: CallSite[] = []
    collectCallSites(mod.ast, file, sites)
    for (const site of sites) {
      rawCallSites.push(site)
      const list = callSites.get(site.name) ?? []
      list.push(site)
      callSites.set(site.name, list)
    }
    resolvedIndexDirty = true
    return mod
  }

  for (const file of fileList) indexFile(file)

  function ensureIndexed(file: string): ParsedModule | null {
    return indexFile(file)
  }

  // --- specifier resolution ----------------------------------------------

  function resolve(fromFile: string, specifier: string): ResolvedTarget {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const base = specifier.startsWith('/')
        ? specifier
        : path.resolve(path.dirname(fromFile), specifier)
      const resolved = resolveFileWithExt(base)
      // A relative specifier that hits nothing on disk is a broken path, not a
      // node_modules dependency — say which so the caller can tell them apart.
      return resolved ? { file: resolved } : { blackbox: true, reason: 'unresolved-path', specifier }
    }
    if (pathsConfig) {
      const resolved = matchTsPaths(specifier, pathsConfig)
      if (resolved) return { file: resolved }
    }
    // Bare specifier -> real node_modules dependency. Do not parse.
    return { blackbox: true, reason: 'bare-specifier', specifier }
  }

  // --- export resolution (re-export chain flattening) ---------------------

  function resolveExport(file: string, name: string): ExportResolution {
    return resolveExportInner(file, name, [], new Set())
  }

  function resolveExportInner(
    file: string,
    name: string,
    chain: ReexportStep[],
    visiting: Set<string>,
  ): ExportResolution {
    const key = `${file}#${name}`
    if (visiting.has(key) || chain.length > MAX_ALIAS_HOPS) {
      return { kind: 'cycle', file, name, chain }
    }
    visiting.add(key)

    const mod = ensureIndexed(file)
    if (!mod) {
      const failure = parseFailures.get(file) ?? {
        file,
        message: 'file could not be read',
        line: null,
        column: null,
        severity: 'unreadable' as const,
      }
      return { kind: 'parse-error', file, failure, chain }
    }

    if (name === '*') return { kind: 'namespace', file, chain }

    const exportMap = exportsByFile.get(file)
    const entry = exportMap?.get(name)
    if (entry) {
      if (!entry.reexport) return { kind: 'found', file, name, entry, chain }
      const { source, imported } = entry.reexport
      const target = resolve(file, source)
      const step: ReexportStep = {
        file,
        name,
        source,
        via: imported === '*' ? 'namespace' : 'named',
      }
      if ('blackbox' in target) {
        return { kind: 'external', fromFile: file, specifier: source, chain: [...chain, step] }
      }
      if (imported === '*') {
        const targetMod = ensureIndexed(target.file)
        if (!targetMod) {
          const failure = parseFailures.get(target.file)!
          return { kind: 'parse-error', file: target.file, failure, chain: [...chain, step] }
        }
        return { kind: 'namespace', file: target.file, chain: [...chain, step] }
      }
      return resolveExportInner(target.file, imported, [...chain, step], visiting)
    }

    // No direct export: consult `export * from` links. Per the module spec a
    // star export never forwards `default`, and two stars supplying the same
    // name is an ambiguity the spec makes a hard error — report it rather than
    // silently picking whichever file was walked first.
    const stars = [...new Set((starExportsByFile.get(file) ?? []).map((s) => s.source))]
    const searchedStars: string[] = []
    const hits: { res: ExportResolution; ident: string }[] = []
    let firstDiagnostic: ExportResolution | null = null
    if (name !== 'default') {
      for (const source of stars) {
        searchedStars.push(source)
        const target = resolve(file, source)
        const step: ReexportStep = { file, name, source, via: 'star' }
        if ('blackbox' in target) {
          // A star into a blackboxed dependency could be supplying the name; we
          // cannot know. Remember it in case nothing local answers.
          firstDiagnostic ??= {
            kind: 'external',
            fromFile: file,
            specifier: source,
            chain: [...chain, step],
          }
          continue
        }
        // Each star is an independent branch: a sibling branch reaching the same
        // file must not be mistaken for a cycle, so the visit set is forked.
        const res = resolveExportInner(target.file, name, [...chain, step], new Set(visiting))
        if (res.kind === 'found') hits.push({ res, ident: `${res.file}#${res.name}` })
        else if (res.kind === 'namespace') hits.push({ res, ident: `${res.file}#*` })
        else if (res.kind !== 'not-found') firstDiagnostic ??= res
      }
    }
    const distinct = [...new Map(hits.map((h) => [h.ident, h])).values()]
    if (distinct.length === 1) return distinct[0].res
    if (distinct.length > 1) {
      return {
        kind: 'ambiguous',
        file,
        name,
        candidates: distinct.map((h) => {
          const r = h.res as Extract<ExportResolution, { kind: 'found' | 'namespace' }>
          return { file: r.file, name: r.kind === 'found' ? r.name : '*' }
        }),
        chain,
      }
    }
    if (firstDiagnostic) return firstDiagnostic

    // Nothing named it. If the parser had to recover inside this file that is the
    // likeliest cause, and the agent must not have to guess — carry it along.
    const diagnostic = parseFailures.get(file)
    return {
      kind: 'not-found',
      file,
      name,
      searchedStars,
      chain,
      parseDiagnostic: diagnostic,
    }
  }

  // --- function identity --------------------------------------------------

  function nodeOf(x: NodePath | BabelNode | null | undefined): BabelNode | null {
    if (!x) return null
    const maybe = x as any
    return (maybe.node ?? maybe) as BabelNode
  }

  function declKeyOf(
    fnNodeOrPath: NodePath | BabelNode | null | undefined,
    file: string | undefined,
  ): string | null {
    const node = nodeOf(fnNodeOrPath)
    if (!node || !file || !node.loc) return null
    // Identity is the definition's position in its own file. Same-named
    // functions in different files differ; an aliased or re-exported function
    // reached by any route lands on the same key.
    return `${file}@${node.loc.start.line}:${node.loc.start.column}`
  }

  function resolvedCallee(target: FnTarget, name: string, via: CalleeVia): CalleeResolution {
    return {
      kind: 'resolved',
      file: target.file,
      name,
      declKey: declKeyOf(target.node, target.file)!,
      declLoc: locOf(target.node, target.file),
      via,
      isAsync: !!target.node.async,
      isGenerator: !!target.node.generator,
    }
  }

  function moduleBinding(file: string, name: string): Binding | null {
    const mod = ensureIndexed(file)
    const program = mod?.programPath
    if (!program) return null
    return program.scope.getBinding(name) ?? null
  }

  /** Walk a binding down to the function node it names, following local aliases. */
  function functionNodeOfBinding(
    binding: Binding | null,
    file: string,
    hops: number,
  ): FnTarget | CalleeResolution {
    if (!binding) return { kind: 'unresolved', reason: 'no-binding', detail: 'no binding in scope' }
    if (hops > MAX_ALIAS_HOPS) {
      return { kind: 'unresolved', reason: 'dynamic-value', detail: 'alias chain too long' }
    }
    if (binding.kind === 'param') {
      return {
        kind: 'unresolved',
        reason: 'callback-param',
        detail: `callee is parameter "${binding.identifier?.name ?? '?'}"`,
      }
    }
    if (binding.kind === 'module') {
      return resolveImportedCallee(binding.path, file, hops)
    }
    const declPath = binding.path
    const decl = nodeOf(declPath)
    if (!decl) return { kind: 'unresolved', reason: 'no-binding', detail: 'binding has no declaration' }
    if (isFunctionNode(decl)) {
      return { node: decl, file, name: decl.id?.name ?? binding.identifier?.name ?? '?', via: 'local' }
    }
    if (decl.type === 'VariableDeclarator') {
      const init = decl.init
      if (isFunctionNode(init)) {
        return { node: init, file, name: decl.id?.name ?? '?', via: 'local' }
      }
      if (init?.type === 'Identifier') {
        // `const g = f` — follow the alias to whatever `f` names.
        const next = declPath!.scope.getBinding(init.name) ?? null
        const aliased = functionNodeOfBinding(next, file, hops + 1)
        if ('node' in aliased) return { ...aliased, via: 'local-alias' }
        return aliased
      }
      return {
        kind: 'unresolved',
        reason: 'not-a-function-decl',
        detail: `"${decl.id?.name ?? '?'}" initialises from ${init?.type ?? 'nothing'}`,
      }
    }
    if (decl.type === 'ClassDeclaration' || decl.type === 'ClassExpression') {
      return { kind: 'unresolved', reason: 'not-a-function-decl', detail: 'callee is a class' }
    }
    return {
      kind: 'unresolved',
      reason: 'not-a-function-decl',
      detail: `binding declared by ${decl.type}`,
    }
  }

  function resolveImportedCallee(
    specPath: NodePath | null,
    fromFile: string,
    hops: number,
  ): CalleeResolution {
    const spec = nodeOf(specPath)
    const importDecl = nodeOf(specPath?.parentPath as any)
    const source: string | undefined = importDecl?.source?.value
    if (!spec || !source) {
      return { kind: 'unresolved', reason: 'dynamic-value', detail: 'import without a source' }
    }
    let imported: string
    if (spec.type === 'ImportDefaultSpecifier') imported = 'default'
    else if (spec.type === 'ImportNamespaceSpecifier') {
      return {
        kind: 'unresolved',
        reason: 'dynamic-value',
        detail: 'namespace object called directly',
      }
    } else imported = spec.imported?.name ?? spec.imported?.value ?? spec.local?.name
    const target = resolve(fromFile, source)
    if ('blackbox' in target) {
      return { kind: 'unresolved', reason: 'external-module', detail: `${source} (${target.reason})` }
    }
    return calleeFromExport(resolveExportInner(target.file, imported, [], new Set()), hops, 'import')
  }

  function calleeFromExport(
    res: ExportResolution,
    hops: number,
    via: 'import' | 'namespace-member',
  ): CalleeResolution {
    switch (res.kind) {
      case 'found': {
        const found = functionNodeOfExportEntry(res.file, res.entry, hops + 1)
        if ('kind' in found) return found
        return resolvedCallee(found, res.name, via)
      }
      case 'namespace':
        return { kind: 'unresolved', reason: 'dynamic-value', detail: `namespace object of ${res.file}` }
      case 'external':
        return { kind: 'unresolved', reason: 'external-module', detail: res.specifier }
      case 'parse-error':
        return {
          kind: 'unresolved',
          reason: 'parse-error',
          detail: `${res.file}:${res.failure.line ?? '?'}:${res.failure.column ?? '?'} ${res.failure.message}`,
        }
      case 'not-found':
        return { kind: 'unresolved', reason: 'export-not-found', detail: `"${res.name}" in ${res.file}` }
      case 'ambiguous':
        return {
          kind: 'unresolved',
          reason: 'export-ambiguous',
          detail: `"${res.name}" supplied by ${res.candidates.map((c) => c.file).join(' and ')}`,
        }
      case 'cycle':
        return { kind: 'unresolved', reason: 'reexport-cycle', detail: `${res.file}#${res.name}` }
    }
  }

  function functionNodeOfExportEntry(
    file: string,
    entry: ExportEntry,
    hops: number,
  ): FnTarget | CalleeResolution {
    if (hops > MAX_ALIAS_HOPS) {
      return { kind: 'unresolved', reason: 'dynamic-value', detail: 'export alias chain too long' }
    }
    const node = entry.node
    if (!node) {
      return { kind: 'unresolved', reason: 'not-a-function-decl', detail: `export "${entry.name}" has no value node` }
    }
    if (isFunctionNode(node)) return { node, file, name: entry.name, via: 'import' }
    if (node.type === 'Identifier') {
      // `export { local }` / `export default local` — resolve inside the file.
      const res = functionNodeOfBinding(moduleBinding(file, node.name), file, hops + 1)
      if ('node' in res) return { node: res.node, file: res.file, name: entry.name, via: res.via }
      return res
    }
    return {
      kind: 'unresolved',
      reason: 'not-a-function-decl',
      detail: `export "${entry.name}" is ${node.type}`,
    }
  }

  /** Resolve `obj.prop()` — namespace imports and local object literals. */
  function resolveMemberCallee(callPath: NodePath, file: string): CalleeResolution {
    const callee = (callPath.node as any).callee
    if (callee.computed) {
      return { kind: 'unresolved', reason: 'computed-member', detail: calleeLabel(callee) }
    }
    const prop: string | undefined = callee.property?.name
    const obj = callee.object
    if (!prop || obj?.type !== 'Identifier') {
      return { kind: 'unresolved', reason: 'dynamic-value', detail: calleeLabel(callee) }
    }
    const binding = callPath.scope.getBinding(obj.name) ?? null
    if (!binding) {
      return { kind: 'unresolved', reason: 'no-binding', detail: calleeLabel(callee) }
    }
    // `import * as ns from './m'; ns.fn()`
    if (binding.kind === 'module') {
      const spec = nodeOf(binding.path)
      const importDecl = nodeOf(binding.path?.parentPath as any)
      const source: string | undefined = importDecl?.source?.value
      if (spec?.type === 'ImportNamespaceSpecifier' && source) {
        const target = resolve(file, source)
        if ('blackbox' in target) {
          return { kind: 'unresolved', reason: 'external-module', detail: `${source} (${target.reason})` }
        }
        return calleeFromExport(
          resolveExportInner(target.file, prop, [], new Set()),
          0,
          'namespace-member',
        )
      }
      // `import defaultExport from './m'; defaultExport.fn()` — a property of an
      // imported value; we would have to model the object to say more.
      return { kind: 'unresolved', reason: 'dynamic-value', detail: calleeLabel(callee) }
    }
    // `const api = { fn() {} }; api.fn()`
    const decl = nodeOf(binding.path)
    if (decl?.type === 'VariableDeclarator' && decl.init?.type === 'ObjectExpression') {
      for (const p of decl.init.properties ?? []) {
        const keyName = p.key?.name ?? p.key?.value
        if (keyName !== prop) continue
        const label = `${obj.name}.${prop}`
        if (p.type === 'ObjectMethod') {
          return resolvedCallee({ node: p, file, name: label, via: 'object-member' }, label, 'object-member')
        }
        if (p.type === 'ObjectProperty' && isFunctionNode(p.value)) {
          return resolvedCallee({ node: p.value, file, name: label, via: 'object-member' }, label, 'object-member')
        }
        if (p.type === 'ObjectProperty' && p.value?.type === 'Identifier') {
          const res = functionNodeOfBinding(
            binding.path!.scope.getBinding(p.value.name) ?? null,
            file,
            1,
          )
          if ('node' in res) return resolvedCallee(res, label, 'object-member')
          return res
        }
      }
      return {
        kind: 'unresolved',
        reason: 'not-a-function-decl',
        detail: `${obj.name} has no static "${prop}" method`,
      }
    }
    return { kind: 'unresolved', reason: 'dynamic-value', detail: calleeLabel(callee) }
  }

  function resolveCallee(site: CallSite): CalleeResolution {
    const callee = (site.callPath.node as any).callee
    if (!callee) return { kind: 'unresolved', reason: 'dynamic-value', detail: '<no callee>' }
    if (callee.type === 'Identifier') {
      const binding = site.callPath.scope.getBinding(callee.name) ?? null
      const res = functionNodeOfBinding(binding, site.file, 0)
      if ('node' in res) return resolvedCallee(res, callee.name, res.via)
      return res
    }
    if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
      return resolveMemberCallee(site.callPath, site.file)
    }
    return { kind: 'unresolved', reason: 'dynamic-value', detail: calleeLabel(callee) }
  }

  // --- resolved call index (built lazily, to a fixpoint) ------------------

  const byTarget = new Map<string, CallSite[]>()
  const unresolved: CallSite[] = []
  let rebuilding = false

  function rebuildResolvedIndex(): void {
    if (rebuilding) return
    rebuilding = true
    try {
      // Resolving a callee can pull an unseen file into the index, which in turn
      // adds call sites. Iterate to a fixpoint (bounded) so the index is never
      // built from a half-populated graph.
      for (let pass = 0; pass < MAX_ALIAS_HOPS && resolvedIndexDirty; pass++) {
        resolvedIndexDirty = false
        byTarget.clear()
        unresolved.length = 0
        for (const site of rawCallSites.slice()) {
          const res = resolveCallee(site)
          site.callee = res
          if (res.kind === 'resolved') {
            const list = byTarget.get(res.declKey) ?? []
            list.push(site)
            byTarget.set(res.declKey, list)
          } else {
            unresolved.push(site)
          }
        }
      }
      resolvedIndexDirty = false
    } finally {
      rebuilding = false
    }
  }

  function ensureResolvedIndex(): void {
    if (resolvedIndexDirty) rebuildResolvedIndex()
  }

  function callersOfFunction(
    fnNodeOrPath: NodePath | BabelNode | null | undefined,
    file: string | undefined,
  ): CallSite[] {
    const key = declKeyOf(fnNodeOrPath, file)
    if (!key) return []
    ensureResolvedIndex()
    return byTarget.get(key) ?? []
  }

  function resolveCalleeOfCall(callPath: NodePath, file?: string): CalleeResolution {
    const owner = file ?? fileOf(callPath)
    if (!owner) {
      return { kind: 'unresolved', reason: 'dynamic-value', detail: 'call path is not in an indexed file' }
    }
    return resolveCallee({
      file: owner,
      name: calleeLabel((callPath.node as any).callee),
      callPath,
      args: [],
      loc: locOf(callPath.node as BabelNode, owner),
      callee: { kind: 'unresolved', reason: 'dynamic-value', detail: 'pending' },
    })
  }

  function fileOf(pathOrNode: NodePath | BabelNode): string | undefined {
    let node: any = pathOrNode
    if ((pathOrNode as any).node !== undefined || (pathOrNode as any).parentPath !== undefined) {
      let p: any = pathOrNode
      while (p.parentPath) p = p.parentPath
      node = p.node
    }
    const direct = astToFile.get(node as object)
    if (direct) return direct
    if (node?.program) return astToFile.get(node.program as object)
    return undefined
  }

  function summary(): ModuleGraphSummary {
    ensureResolvedIndex()
    let exportCount = 0
    for (const m of exportsByFile.values()) exportCount += m.size
    const unresolvedByReason: Record<string, number> = {}
    for (const site of unresolved) {
      if (site.callee.kind === 'unresolved') {
        unresolvedByReason[site.callee.reason] = (unresolvedByReason[site.callee.reason] ?? 0) + 1
      }
    }
    return {
      root: absRoot,
      fileCount: fileList.length,
      indexedFileCount: exportsByFile.size,
      exportCount,
      callSiteCount: rawCallSites.length,
      resolvedCallSiteCount: rawCallSites.length - unresolved.length,
      unresolvedCallSiteCount: unresolved.length,
      unresolvedByReason,
      // Bounded: a summary an agent reads must not become a wall of failures.
      // The full set stays on `graph.parseFailures`.
      parseFailures: [...parseFailures.values()].slice(0, 50),
    }
  }

  return {
    root: absRoot,
    files: fileList,
    exportsByFile,
    starExportsByFile,
    callSites,
    get callSitesByTarget() {
      ensureResolvedIndex()
      return byTarget
    },
    get unresolvedCallSites() {
      ensureResolvedIndex()
      return unresolved
    },
    parseFailures,
    getFile: loadFile,
    resolve,
    fileOf,
    resolveExport,
    declKeyOf,
    callersOfFunction,
    resolveCalleeOfCall,
    moduleBinding,
    ensureIndexed,
    summary,
  }
}
