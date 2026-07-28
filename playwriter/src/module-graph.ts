import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import type { NodePath } from '@babel/traverse'
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

export interface ParsedModule {
  ast: ParsedFile
  code: string
}

export interface ExportEntry {
  name: string
  // The value node the export points at (declarator init, function/class node,
  // or the exported local identifier). Null only for opaque re-exports.
  node: BabelNode | null
  path: NodePath | null
  loc: Loc | null
  // Set for `export { x } from './y'` / `export * from './y'` chains.
  reexport?: { source: string; imported: string }
}

export interface CallSite {
  file: string
  name: string
  callPath: NodePath
  args: NodePath[]
  loc: Loc | null
}

export type ResolvedTarget = { file: string } | { blackbox: true }

export interface ModuleGraph {
  root: string
  files: string[]
  exportsByFile: Map<string, Map<string, ExportEntry>>
  callSites: Map<string, CallSite[]>
  getFile(absPath: string): ParsedModule | null
  resolve(fromFile: string, specifier: string): ResolvedTarget
  fileOf(pathOrNode: NodePath | BabelNode): string | undefined
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
      for (const spec of node.specifiers ?? []) {
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
            exportMap.set(exported, {
              name: exported,
              node: spec.local,
              path: p.get('specifiers'),
              loc: locOf(spec.local, file),
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
      if (source) {
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

function collectCallSites(
  ast: ParsedFile,
  file: string,
  callSites: Map<string, CallSite[]>,
): void {
  traverse(ast, {
    CallExpression(p: any) {
      const callee = p.node.callee
      if (callee?.type === 'Identifier') {
        const name = callee.name
        const list = callSites.get(name) ?? []
        list.push({
          file,
          name,
          callPath: p,
          args: p.get('arguments'),
          loc: locOf(p.node, file),
        })
        callSites.set(name, list)
      }
    },
  })
}

/**
 * Parse every source file under `root` once, then index exports, call sites and
 * a filesystem-aware module resolver. Purely offline: bare specifiers (real
 * node_modules deps) are blackboxed and never parsed.
 *
 * Documented limits:
 * - Call sites are keyed by callee identifier name only (no cross-scope
 *   disambiguation), so shadowed/duplicate function names collapse together.
 * - Re-export chains (`export { x } from` / `export *`) are recorded as
 *   `reexport` markers but not transitively flattened.
 */
export function buildModuleGraph({ root, files }: { root: string; files?: string[] }): ModuleGraph {
  const absRoot = path.resolve(root)
  const fileList = files ? files.map((f) => path.resolve(f)) : []
  if (!files) walkDir(absRoot, fileList)

  const cache = new Map<string, ParsedModule>()
  const astToFile = new WeakMap<object, string>()
  const exportsByFile = new Map<string, Map<string, ExportEntry>>()
  const callSites = new Map<string, CallSite[]>()
  const pathsConfig = loadPathsConfig(absRoot)

  function loadFile(absPath: string): ParsedModule | null {
    const cached = cache.get(absPath)
    if (cached) return cached
    let code: string
    try {
      code = fs.readFileSync(absPath, 'utf8')
    } catch {
      return null
    }
    let ast: ParsedFile
    try {
      ast = parseCode(code, absPath)
    } catch {
      // Syntax errors are logged and the file is silently skipped rather than
      // crashing the entire graph build.
      return null
    }
    const mod: ParsedModule = { ast, code }
    cache.set(absPath, mod)
    astToFile.set(ast as unknown as object, absPath)
    astToFile.set(ast.program as unknown as object, absPath)
    return mod
  }

  for (const file of fileList) {
    const mod = loadFile(file)
    if (!mod) continue
    const exportMap = new Map<string, ExportEntry>()
    collectExports(mod.ast, file, exportMap)
    exportsByFile.set(file, exportMap)
    collectCallSites(mod.ast, file, callSites)
  }

  function resolve(fromFile: string, specifier: string): ResolvedTarget {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const base = specifier.startsWith('/')
        ? specifier
        : path.resolve(path.dirname(fromFile), specifier)
      const resolved = resolveFileWithExt(base)
      return resolved ? { file: resolved } : { blackbox: true }
    }
    if (pathsConfig) {
      const resolved = matchTsPaths(specifier, pathsConfig)
      if (resolved) return { file: resolved }
    }
    // Bare specifier -> real node_modules dependency. Do not parse.
    return { blackbox: true }
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

  return {
    root: absRoot,
    files: fileList,
    exportsByFile,
    callSites,
    getFile: loadFile,
    resolve,
    fileOf,
  }
}
