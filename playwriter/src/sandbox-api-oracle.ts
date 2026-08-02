/**
 * The sandbox API oracle: what the SHIPPED DOCS promise, and what a wrapper in
 * `executor.ts` actually reads — both derived, neither hand-listed.
 *
 * This exists because the thing it replaces was a snapshot. `executor-sandbox.test.ts`
 * used to carry a literal `EXPECTED_FUNCTIONS` array, which is only ever as correct as
 * the last person who remembered to edit it: an audit found it silently missing
 * `recording.hold`, the whole `humanMouse` namespace, `chrome`, `browser`, and every
 * wrapper OPTION except two. A list that goes stale the moment someone documents a
 * helper is not an oracle, it is a second copy of the bug.
 *
 * So the expected surface is PARSED OUT OF THE DOCS THEMSELVES:
 *
 *   - `extractDocumentedApi` reads `src/skill.md` (from which `dist/prompt.md` is
 *     generated verbatim, minus the CLI section) plus the `*-examples.ts` files that
 *     are compiled into the MCP resources. It parses every fenced ```js/```ts block
 *     and every example file with `@babel/parser` and walks the AST for calls —
 *     `foo({ … })` is a documented global, `ns.member({ … })` is a documented
 *     namespace member, and every object-literal argument's keys are that call's
 *     documented OPTIONS. Document a new helper with an example and it is expected
 *     automatically; nothing to remember.
 *
 *   - `analyseWrapperOptions` parses `src/executor.ts` (and, following the sandbox
 *     value through imports and factory calls, whatever module actually defines the
 *     function) and reports which option names the implementation OBSERVES:
 *     destructured from its parameter, read as `options.x`, or — when the parameter
 *     is forwarded whole or spread — everything, because such a wrapper genuinely
 *     cannot drop anything.
 *
 * The two together catch the failure the name-level check cannot see: a global that
 * exists, is callable, and quietly discards an option the docs promise.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. "Observes the option" is not "honours the
 * option": a wrapper that reads `options.scope` and then applies it in the wrong
 * language still passes here. Those need a behavioural test, and
 * `executor-sandbox.test.ts` has them beside this.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'

type Node = Record<string, any>

// ---------------------------------------------------------------------------
// Documented surface
// ---------------------------------------------------------------------------

export interface DocumentedApi {
  /** Bare-identifier calls: `snapshot({ … })` -> `snapshot` -> its documented options. */
  globals: Map<string, Set<string>>
  /** `pm.query({ … })` -> `pm` -> `query` -> its documented options. */
  namespaces: Map<string, Map<string, Set<string>>>
  /** Every identifier-shaped token anywhere in the prose. Used for the lenient
   *  reverse direction: a name merely NAMED in the docs is not undocumented. */
  mentions: Set<string>
  /** Parser accounting. A parser that quietly matched nothing must be a test failure. */
  stats: { sources: number; snippets: number; parsed: number; parseFailures: string[] }
}

/**
 * Calls whose arguments describe the PAGE realm, not this process. Names inside them
 * (`document`, `localStorage`, `PerformanceObserver`) are not sandbox API and must not
 * be collected as documented promises.
 */
const PAGE_REALM_CALLS = new Set([
  'evaluate',
  'evaluateHandle',
  '$eval',
  '$$eval',
  'waitForFunction',
  'addInitScript',
  'evaluateAll',
])

/**
 * `{ page?, count?, search? }` appears in the docs as a signature sketch. It is not
 * valid JS, and it is the single most option-dense form in the whole document, so it
 * is worth one targeted rewrite rather than being dropped on the floor.
 */
function normaliseSnippet(src: string): string {
  return src.replace(/([A-Za-z_$][\w$]*)\?(\s*[,}\]])/g, '$1$2')
}

function fencedCodeBlocks(markdown: string): string[] {
  const out: string[] = []
  for (const m of markdown.matchAll(/^[ \t]*```(\w*)[ \t]*\n([\s\S]*?)^[ \t]*```/gm)) {
    if (m[1] === 'js' || m[1] === 'ts' || m[1] === 'javascript' || m[1] === 'typescript') out.push(m[2])
  }
  return out
}

function parseSnippet(src: string): Node | null {
  try {
    return parse(normaliseSnippet(src), {
      sourceType: 'module',
      errorRecovery: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      plugins: ['typescript'],
    }) as unknown as Node
  } catch {
    return null
  }
}

/** Names a snippet binds itself. `const t = await traceValue(…)` makes `t.render()` a
 *  local method call, not a documented namespace. */
function boundNames(program: Node): Set<string> {
  const bound = new Set<string>()
  const collectPattern = (p: Node | null | undefined): void => {
    if (!p) return
    switch (p.type) {
      case 'Identifier':
        bound.add(p.name)
        return
      case 'ObjectPattern':
        for (const prop of p.properties) collectPattern(prop.value ?? prop.argument)
        return
      case 'ArrayPattern':
        for (const el of p.elements) collectPattern(el)
        return
      case 'AssignmentPattern':
        collectPattern(p.left)
        return
      case 'RestElement':
        collectPattern(p.argument)
        return
      default:
        return
    }
  }
  const scan = (n: any): void => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const c of n) scan(c)
      return
    }
    if (typeof n.type !== 'string') return
    if (n.type === 'VariableDeclarator') collectPattern(n.id)
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      if (n.id) bound.add(n.id.name)
      for (const p of n.params) collectPattern(p)
    }
    if (n.type === 'ClassDeclaration' && n.id) bound.add(n.id.name)
    if (n.type === 'CatchClause') collectPattern(n.param)
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
      scan(n[key])
    }
  }
  scan(program)
  return bound
}

function optionKeysOf(call: Node): string[] {
  const keys: string[] = []
  for (const arg of call.arguments ?? []) {
    if (arg?.type !== 'ObjectExpression') continue
    for (const prop of arg.properties) {
      if (prop.type === 'SpreadElement') continue
      const name = prop.key?.name ?? (typeof prop.key?.value === 'string' ? prop.key.value : null)
      if (name) keys.push(name)
    }
  }
  return keys
}

function collectCalls(program: Node, api: DocumentedApi): void {
  const bound = boundNames(program)

  const walk = (n: any, inPageRealm: boolean): void => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const c of n) walk(c, inPageRealm)
      return
    }
    if (typeof n.type !== 'string') return

    if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
      const callee = n.callee
      const isMember = callee?.type === 'MemberExpression' || callee?.type === 'OptionalMemberExpression'
      const entersPageRealm = isMember && !callee.computed && PAGE_REALM_CALLS.has(callee.property?.name)

      if (!inPageRealm) {
        if (callee?.type === 'Identifier' && !bound.has(callee.name)) {
          let opts = api.globals.get(callee.name)
          if (!opts) api.globals.set(callee.name, (opts = new Set()))
          for (const k of optionKeysOf(n)) opts.add(k)
        } else if (isMember && !callee.computed && callee.object?.type === 'Identifier' && callee.property?.name && !bound.has(callee.object.name)) {
          let ns = api.namespaces.get(callee.object.name)
          if (!ns) api.namespaces.set(callee.object.name, (ns = new Map()))
          let opts = ns.get(callee.property.name)
          if (!opts) ns.set(callee.property.name, (opts = new Set()))
          for (const k of optionKeysOf(n)) opts.add(k)
        }
      }

      for (const arg of n.arguments ?? []) walk(arg, inPageRealm || entersPageRealm)
      walk(callee, inPageRealm)
      return
    }

    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
      walk(n[key], inPageRealm)
    }
  }
  walk(program, false)
}

/**
 * Parse the shipped docs into the API surface they promise.
 *
 * `markdownFiles` contribute their fenced js/ts blocks; `sourceFiles` (the
 * `*-examples.ts` compiled into the MCP resources) contribute their whole text.
 */
export function extractDocumentedApi(options: { root: string; markdownFiles: string[]; sourceFiles: string[] }): DocumentedApi {
  const api: DocumentedApi = {
    globals: new Map(),
    namespaces: new Map(),
    mentions: new Set(),
    stats: { sources: 0, snippets: 0, parsed: 0, parseFailures: [] },
  }

  const snippets: Array<{ from: string; code: string }> = []
  for (const rel of options.markdownFiles) {
    const text = fs.readFileSync(path.join(options.root, rel), 'utf8')
    api.stats.sources++
    for (const token of text.matchAll(/[A-Za-z_$][\w$]*/g)) api.mentions.add(token[0])
    for (const block of fencedCodeBlocks(text)) snippets.push({ from: rel, code: block })
  }
  for (const rel of options.sourceFiles) {
    const text = fs.readFileSync(path.join(options.root, rel), 'utf8')
    api.stats.sources++
    for (const token of text.matchAll(/[A-Za-z_$][\w$]*/g)) api.mentions.add(token[0])
    snippets.push({ from: rel, code: text })
  }

  api.stats.snippets = snippets.length
  for (const snippet of snippets) {
    const ast = parseSnippet(snippet.code)
    if (!ast) {
      api.stats.parseFailures.push(`${snippet.from}: ${snippet.code.slice(0, 70).replace(/\n/g, ' ⏎ ')}`)
      continue
    }
    api.stats.parsed++
    collectCalls(ast.program, api)
  }
  return api
}

// ---------------------------------------------------------------------------
// Which options a wrapper actually reads
// ---------------------------------------------------------------------------

export interface WrapperOptions {
  /** Where the implementation was found, for the failure message. */
  definedIn: string
  /** Option names the implementation destructures or reads off its parameter. */
  observed: Set<string>
  /**
   * The parameter is forwarded whole (`f(opts)`) or spread (`{ ...opts }`), so the
   * implementation cannot drop an option even in principle. Nothing to check.
   */
  transparent: boolean
  /** Option names the parameter's own inline TS type declares, when it has one. */
  declared: Set<string> | null
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod'])

function isFunctionNode(n: Node | null | undefined): boolean {
  return !!n && FUNCTION_TYPES.has(n.type)
}

function typeLiteralKeys(annotation: Node | null | undefined): Set<string> | null {
  const ann = annotation?.type === 'TSTypeAnnotation' ? annotation.typeAnnotation : annotation
  if (!ann) return null
  if (ann.type === 'TSTypeLiteral') {
    const out = new Set<string>()
    for (const member of ann.members ?? []) {
      const name = member.key?.name ?? (typeof member.key?.value === 'string' ? member.key.value : null)
      if (name) out.add(name)
    }
    return out
  }
  // `(options?: A & { b?: X })` — only the literal half is inspectable here; the named
  // half is another module's business and is checked where it is declared.
  if (ann.type === 'TSIntersectionType') {
    const parts = ann.types.map((t: Node) => typeLiteralKeys(t)).filter(Boolean) as Array<Set<string>>
    if (parts.length === 0) return null
    return new Set(parts.flatMap((p) => [...p]))
  }
  if (ann.type === 'TSUnionType') {
    const parts = ann.types.map((t: Node) => typeLiteralKeys(t)).filter(Boolean) as Array<Set<string>>
    if (parts.length === 0) return null
    return new Set(parts.flatMap((p) => [...p]))
  }
  return null
}

/**
 * Which option names a function observes on its parameters.
 *
 * Three ways an implementation can name an option, all of them counted:
 *   - `({ a, b }) => …`                        destructuring parameter
 *   - `(o) => { const { a, b } = o; … }`       destructuring in the body
 *   - `(o) => f(o.a, o.b)`                     member reads
 * and one way it can name none because it needs none: forwarding `o` whole, which is
 * reported as `transparent` rather than as a wrapper that reads nothing.
 */
export function observedOptionsOf(fn: Node, definedIn: string): WrapperOptions {
  const observed = new Set<string>()
  let transparent = false
  let declared: Set<string> | null = null

  const paramNames: string[] = []
  for (const param of fn.params ?? []) {
    const target = param.type === 'AssignmentPattern' ? param.left : param
    const keys = typeLiteralKeys(target.typeAnnotation)
    if (keys) declared = new Set([...(declared ?? []), ...keys])
    if (target.type === 'ObjectPattern') {
      for (const prop of target.properties) {
        if (prop.type === 'RestElement') {
          transparent = true
          continue
        }
        const name = prop.key?.name ?? (typeof prop.key?.value === 'string' ? prop.key.value : null)
        if (name) observed.add(name)
      }
    } else if (target.type === 'Identifier') {
      paramNames.push(target.name)
    } else if (target.type === 'RestElement') {
      transparent = true
    }
  }

  if (paramNames.length === 0) {
    return { definedIn, observed, transparent, declared }
  }

  const isParam = (n: Node | null | undefined): boolean => !!n && n.type === 'Identifier' && paramNames.includes(n.name)

  /**
   * A bare mention of the parameter that CANNOT leak it, so it must not be mistaken for
   * a forward. Without this, one `if (!options) throw …` guard at the top of a wrapper
   * marked it transparent and quietly exempted every option it drops from the whole
   * check — the exact class of silent hole this file exists to close.
   */
  const isInspectionOnly = (parent: Node | null): boolean => {
    if (!parent) return false
    if (parent.type === 'UnaryExpression') return parent.operator === '!' || parent.operator === 'typeof'
    if (parent.type === 'BinaryExpression') {
      return ['==', '===', '!=', '!=='].includes(parent.operator)
    }
    return false
  }

  const walk = (n: any, parent: Node | null = null): void => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const c of n) walk(c, parent)
      return
    }
    if (typeof n.type !== 'string') return

    // `const { a, b } = options` / `const { a } = options ?? {}` — names exactly a, b.
    if (n.type === 'VariableDeclarator' && n.id?.type === 'ObjectPattern') {
      const init = n.init
      const fromParam =
        isParam(init) ||
        ((init?.type === 'LogicalExpression' || init?.type === 'BinaryExpression') && isParam(init.left))
      if (fromParam) {
        for (const prop of n.id.properties) {
          if (prop.type === 'RestElement') {
            transparent = true
            continue
          }
          const name = prop.key?.name ?? (typeof prop.key?.value === 'string' ? prop.key.value : null)
          if (name) observed.add(name)
        }
        // Do not descend into the init: the bare reference there is the destructuring,
        // not a forward.
        walk(
          n.id.properties.map((p: Node) => p.value),
          n.id,
        )
        return
      }
    }

    // `options.x` / `options?.x` — a named read. Do not descend into the object, or
    // the bare identifier would read as a forward.
    if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed && isParam(n.object)) {
      if (n.property?.name) observed.add(n.property.name)
      return
    }

    // `{ ...options }` / `f(options)` — nothing can be dropped.
    if (n.type === 'SpreadElement' && isParam(n.argument)) {
      transparent = true
      return
    }
    if (isParam(n)) {
      if (!isInspectionOnly(parent)) transparent = true
      return
    }

    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
      walk(n[key], n)
    }
  }
  walk(fn.body, null)

  return { definedIn, observed, transparent, declared }
}

// ---------------------------------------------------------------------------
// Following a sandbox name to the function that implements it
// ---------------------------------------------------------------------------

interface ModuleIndex {
  file: string
  program: Node
  /**
   * name -> every node bound to it anywhere in the file, in source order.
   *
   * A LIST rather than one node because a module-wide scan sees shadowed bindings:
   * `executor.ts` has a local `const refToLocator = new Map()` inside `snapshot` AND
   * the sandbox helper `const refToLocator = (options) => …` further down. Keeping
   * only the first hid the helper behind a Map and made the wrapper unresolvable.
   */
  bindings: Map<string, Node[]>
  /** imported name -> resolved absolute file path. */
  imports: Map<string, string>
}

const moduleCache = new Map<string, ModuleIndex>()

function indexModule(file: string): ModuleIndex {
  const cached = moduleCache.get(file)
  if (cached) return cached

  const ast = parse(fs.readFileSync(file, 'utf8'), {
    sourceType: 'module',
    plugins: ['typescript'],
  }) as unknown as Node

  const index: ModuleIndex = { file, program: ast.program, bindings: new Map(), imports: new Map() }

  const record = (name: string | undefined, node: Node): void => {
    if (!name) return
    const existing = index.bindings.get(name)
    if (existing) existing.push(node)
    else index.bindings.set(name, [node])
  }

  const scan = (n: any): void => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const c of n) scan(c)
      return
    }
    if (typeof n.type !== 'string') return
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init) record(n.id.name, n.init)
    if (n.type === 'FunctionDeclaration' && n.id) record(n.id.name, n)
    if (n.type === 'ImportDeclaration') {
      const spec: string = n.source.value
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts'))
        for (const s of n.specifiers) {
          if (s.type === 'ImportSpecifier') index.imports.set(s.local.name, resolved)
          if (s.type === 'ImportDefaultSpecifier') index.imports.set(s.local.name, resolved)
        }
      }
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
      scan(n[key])
    }
  }
  scan(index.program)

  moduleCache.set(file, index)
  return index
}

/** The object literal a function returns directly (not one returned by a nested function). */
function returnedObjectLiteral(fn: Node): Node | null {
  let found: Node | null = null
  const walk = (n: any): void => {
    if (found || !n || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const c of n) walk(c)
      return
    }
    if (typeof n.type !== 'string') return
    if (isFunctionNode(n) && n !== fn) return // a nested function's return is not ours
    if (n.type === 'ReturnStatement' && n.argument?.type === 'ObjectExpression') {
      found = n.argument
      return
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
      walk(n[key])
    }
  }
  // An expression-bodied arrow returns its body.
  if (fn.type === 'ArrowFunctionExpression' && fn.body?.type === 'ObjectExpression') return fn.body
  walk(fn.body)
  return found
}

function objectProperty(obj: Node, name: string): Node | null {
  for (const prop of obj.properties ?? []) {
    if (prop.type === 'SpreadElement') continue
    const key = prop.key?.name ?? (typeof prop.key?.value === 'string' ? prop.key.value : null)
    if (key !== name) continue
    return prop.type === 'ObjectMethod' ? prop : prop.value
  }
  return null
}

export interface ResolvedImplementation {
  fn: Node
  definedIn: string
}

/**
 * Follow a value expression to the function that ultimately implements it: through
 * local aliases, through imports, through a namespace object literal, and through a
 * factory call (`createHumanMouseApi({ … })` -> the object literal it returns).
 *
 * Returns `null` rather than guessing. The caller reports an unresolvable name as a
 * failure, so a wrapper that moved somewhere this cannot follow is never silently
 * skipped.
 */
function resolveValue(node: Node | null, file: string, member: string | null, depth = 0): ResolvedImplementation | null {
  if (!node || depth > 8) return null

  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') {
    return resolveValue(node.expression, file, member, depth + 1)
  }

  if (isFunctionNode(node)) {
    if (!member) return { fn: node, definedIn: file }
    // A namespace built by a factory: descend into the object it returns.
    const returned = returnedObjectLiteral(node)
    if (!returned) return null
    return resolveValue(objectProperty(returned, member), file, null, depth + 1)
  }

  if (node.type === 'ObjectExpression') {
    if (!member) return null
    return resolveValue(objectProperty(node, member), file, null, depth + 1)
  }

  if (node.type === 'Identifier') {
    const index = indexModule(file)
    // Every candidate is tried, not just the first: a shadowed local of the same name
    // must not be able to hide the real binding (see ModuleIndex.bindings).
    for (const candidate of index.bindings.get(node.name) ?? []) {
      const hit = resolveValue(candidate, file, member, depth + 1)
      if (hit) return hit
    }
    const imported = index.imports.get(node.name)
    if (imported && fs.existsSync(imported)) {
      const other = indexModule(imported)
      for (const candidate of other.bindings.get(node.name) ?? []) {
        const hit = resolveValue(candidate, imported, member, depth + 1)
        if (hit) return hit
      }
    }
    return null
  }

  if (node.type === 'MemberExpression' && !node.computed && node.property?.name) {
    // `recordingApi.start` — resolve the object, then take the member. A member was
    // already being looked for means a two-level path this cannot express; returning
    // null makes the caller report it, rather than resolving something plausible.
    if (member) return null
    return resolveValue(node.object, file, node.property.name, depth + 1)
  }

  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    // `createHumanMouseApi({ … })` — the value is whatever the callee returns.
    const factory = resolveValue(node.callee, file, null, depth + 1)
    if (!factory) return null
    const returned = returnedObjectLiteral(factory.fn)
    if (!returned) return null
    if (!member) return null
    return resolveValue(objectProperty(returned, member), factory.definedIn, null, depth + 1)
  }

  return null
}

/**
 * Index the `vmContextObj` literal that `buildSandboxContext` returns: sandbox name ->
 * the expression it is bound to. This is the entry point every lookup starts from, and
 * it is read out of `executor.ts` rather than restated here.
 */
export function sandboxSurfaceExpressions(executorFile: string): Map<string, Node> {
  const index = indexModule(executorFile)
  const literal = (index.bindings.get('vmContextObj') ?? []).find((n) => n.type === 'ObjectExpression')
  if (!literal) {
    throw new Error(
      `sandbox-api-oracle: could not find the \`vmContextObj\` object literal in ${executorFile}. ` +
        'The oracle reads the sandbox surface out of that literal; if it was renamed or restructured, ' +
        'update this resolver rather than deleting the check.',
    )
  }
  const out = new Map<string, Node>()
  const merge = (obj: Node): void => {
    for (const prop of obj.properties) {
      if (prop.type === 'SpreadElement') {
        // `...usefulGlobals` — the spread names are as much a part of the surface as
        // the literal ones, and `fetch`/`Buffer`/`crypto` reach the sandbox only here.
        const spread = resolveObjectLiteral(prop.argument, executorFile)
        if (spread) merge(spread)
        continue
      }
      const name = prop.key?.name ?? (typeof prop.key?.value === 'string' ? prop.key.value : null)
      if (name) out.set(name, prop.type === 'ObjectMethod' ? prop : prop.value)
    }
  }
  merge(literal)
  return out
}

/** Follow an identifier to the object literal it is bound to, for spread merging. */
function resolveObjectLiteral(node: Node, file: string, depth = 0): Node | null {
  if (!node || depth > 6) return null
  if (node.type === 'ObjectExpression') return node
  if (node.type === 'TSAsExpression') return resolveObjectLiteral(node.expression, file, depth + 1)
  if (node.type === 'Identifier') {
    for (const candidate of indexModule(file).bindings.get(node.name) ?? []) {
      const hit = resolveObjectLiteral(candidate, file, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/** Resolve one sandbox name (optionally one namespace member) to its implementation. */
export function analyseWrapperOptions(options: {
  executorFile: string
  surface: Map<string, Node>
  global: string
  member?: string
}): WrapperOptions | null {
  const expr = options.surface.get(options.global)
  if (!expr) return null
  const impl = resolveValue(expr, options.executorFile, options.member ?? null)
  if (!impl) return null
  return observedOptionsOf(impl.fn, path.basename(impl.definedIn))
}
